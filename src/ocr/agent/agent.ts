// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/agent.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27;
// named main-loop stop classification updated from OCR v1.9.9 commit
// 4b6874bd23106b5c68bea6d230bb60303b9f0961; cancellation checkpoint
// preservation follows OCR v1.9.4 commit 31db10f.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { Provider } from "../diff/git.js";
import type { InputResolution } from "../diff/git.js";
import type { Diff } from "../model/diff.js";
import type { LlmComment } from "../model/review.js";
import { isAllowedExt, isExcludedPath } from "../rules/allowed_ext.js";
import { estimateDiffCost, estimateDiffFileTokens, humanTokens } from "./estimate.js";
import { effectivePath, whyExcluded, diffStatus, extFromPath } from "./preview.js";
import type { Preview, PreviewEntry, ExcludeReason } from "../model/preview.js";
import { ExcludeNone, ExcludeDeleted } from "../model/preview.js";
import { reviewModeString, stripEmptyPlanBlock } from "./util.js";
import { countTokens, PromptTokenLimit } from "../llmloop/compression.js";
import { Runner, sessionTaskKey } from "../llmloop/loop.js";
import { buildFilterCommentsJSON, parseFilterResponse, parseFilterToolCalls, REVIEW_FILTER_TOOLS } from "./filter.js";
import { formatToolDefs } from "./format.js";
import type { AgentWarning, AnyLlmClient, ToolDef } from "../llmloop/types.js";
import type { Template, ChatMessage, LlmConversation } from "../template/template.js";
import type { FileFilter } from "../rules/system_rules.js";
import { CommentWorkerPool } from "../llmloop/pool.js";
import {
  FailureBudget,
  FailureTimeout,
  FailureCancelled,
  FailureConfiguration,
  FailureProvider,
  FailurePanic,
  FailureUnknown,
  RunFailureCancelled,
  type CoverageItem,
  type RunManifest,
  ManifestBuilder,
  NewManifestBuilder,
  ItemID,
  OPERATION_REVIEW,
} from "../session/manifest.js";
import { SessionHistory } from "../session/history.js";
import type { FailureClass } from "../session/manifest.js";
import { MainLoopStop, mainLoopStopReason } from "../llmloop/types.js";

// ---------------------------------------------------------------------------
// RuntimeConfig — mirrors Go RuntimeConfig
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  readonly protocol: string;
  readonly endpointHost: string;
  readonly language: string;
  readonly timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Resolver interface — minimal surface for system rules
// ---------------------------------------------------------------------------

export interface SystemRuleResolver {
  resolve(path: string): string;
  canonicalConfig?(): string[];
}

// ---------------------------------------------------------------------------
// Tool registry minimal surface — mirrors tool.Registry subset needed by agent
// ---------------------------------------------------------------------------

export interface ToolRegistryLike {
  get(name: string): { name: string; execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> | string } | undefined;
  Get?(name: string): unknown;
  freeze?(): void;
}

// ---------------------------------------------------------------------------
// Comment collector minimal surface
// ---------------------------------------------------------------------------

export interface CommentCollectorLike {
  add(comment: LlmComment): void;
  comments(): LlmComment[];
  commentsForPath?(path: string): LlmComment[];
  removeByPathAndIndices?(path: string, indices: Map<number, unknown> | Set<number> | Record<number, unknown>): void;
}

// ---------------------------------------------------------------------------
// Args — mirrors Go Args
// ---------------------------------------------------------------------------

export interface Args {
  readonly repoDir: string;
  readonly sessionId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly commit?: string;
  readonly reviewMode?: string;
  readonly template: Template;
  readonly systemRule?: SystemRuleResolver | null;
  readonly fileFilter?: FileFilter | null;
  readonly llmClient: AnyLlmClient;
  readonly tools?: ToolRegistryLike | null;
  readonly planToolDefs?: readonly ToolDef[];
  readonly mainToolDefs: readonly ToolDef[];
  readonly maxConcurrency?: number;
  readonly concurrentTaskTimeoutMinutes?: number;
  readonly commentCollector?: CommentCollectorLike | null;
  readonly background?: string;
  readonly model: string;
  readonly provider?: string;
  readonly gitRunner?: unknown;
  readonly sealedInput?: InputResolution | null;
  readonly maxTokensBudget?: number;
  readonly skipFilter?: boolean;
  readonly runtimeConfig?: RuntimeConfig | null;
  readonly resume?: import("../session/resume.js").ResumeState | null;
  // Go-compat aliases — tests may use capitalized keys
  readonly LLMClient?: AnyLlmClient;
  readonly Model?: string;
  readonly Template?: Template;
  readonly SystemRule?: SystemRuleResolver | null;
  readonly FileFilter?: FileFilter | null;
  readonly Tools?: ToolRegistryLike | null;
  readonly CommentCollector?: CommentCollectorLike | null;
  readonly Session?: unknown;
  readonly MaxConcurrency?: number;
  readonly ConcurrentTaskTimeout?: number;
  readonly SkipFilter?: boolean;
  readonly Background?: string;
}

// ---------------------------------------------------------------------------
// Helpers — hashFields, reviewItemFingerprint, manifest helpers
// ---------------------------------------------------------------------------

export function hashFields(...fields: string[]): string {
  const h = createHash("sha256");
  const lenBuf = Buffer.allocUnsafe(8);
  for (const f of fields) {
    const bytes = Buffer.from(f, "utf-8");
    lenBuf.writeBigUInt64BE(BigInt(bytes.length), 0);
    h.update(lenBuf);
    h.update(bytes);
  }
  return h.digest("hex");
}

/**
 * reviewItemFingerprint replicates Go reviewItemFingerprint:
 * SHA256(mode + "\x00" + oldPath + "\x00" + newPath + "\x00" + diffText)
 * where diffText is TrimRight(\r\n).
 */
export function reviewItemFingerprint(mode: string, d: Diff): string {
  const diffText = d.diff.replace(/[\r\n]+$/g, "");
  const payload = `${mode}\u0000${d.oldPath}\u0000${d.newPath}\u0000${diffText}`;
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

export function manifestPaths(d: Diff): { oldPath: string; newPath: string } {
  let oldPath = d.oldPath;
  let newPath = d.newPath;
  if (oldPath === "/dev/null") oldPath = "";
  if (newPath === "/dev/null") newPath = "";
  return { oldPath, newPath };
}

export function manifestItemID(mode: string, d: Diff): string {
  const { oldPath, newPath } = manifestPaths(d);
  return ItemID(OPERATION_REVIEW, mode, oldPath, newPath);
}

// ---------------------------------------------------------------------------
// Diff normalization — Go fields are PascalCase, Pi fields are camelCase.
// Accept both so translated tests can use either.
// ---------------------------------------------------------------------------
export function normalizeDiff(d: unknown): Diff {
  if (d === null || d === undefined || typeof d !== "object") return { oldPath: "", newPath: "", diff: "", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 };
  const r = d as Record<string, unknown>;
  const getStr = (lower: string, upper: string): string => {
    const v1 = r[lower]; const v2 = r[upper];
    if (typeof v1 === "string") return v1; if (typeof v2 === "string") return v2; return "";
  };
  const getBool = (lower: string, upper: string): boolean => {
    const v1 = r[lower]; const v2 = r[upper];
    if (typeof v1 === "boolean") return v1; if (typeof v2 === "boolean") return v2; return false;
  };
  const getNum = (lower: string, upper: string): number => {
    const v1 = r[lower]; const v2 = r[upper];
    if (typeof v1 === "number") return v1; if (typeof v2 === "number") return v2; return 0;
  };
  return {
    oldPath: getStr("oldPath", "OldPath"),
    newPath: getStr("newPath", "NewPath"),
    diff: getStr("diff", "Diff"),
    newFileContent: getStr("newFileContent", "NewFileContent"),
    isBinary: getBool("isBinary", "IsBinary"),
    isDeleted: getBool("isDeleted", "IsDeleted"),
    isNew: getBool("isNew", "IsNew"),
    isRenamed: getBool("isRenamed", "IsRenamed"),
    insertions: getNum("insertions", "Insertions"),
    deletions: getNum("deletions", "Deletions"),
  };
}

function normalizeTemplateObject(tpl: unknown): Template {
  if (tpl === null || tpl === undefined || typeof tpl !== "object") return tpl as Template;
  const r = tpl as Record<string, unknown>;
  const pick = (lower: string, upper: string): unknown => r[lower] ?? r[upper];
  const conv = (v: unknown): LlmConversation | undefined => {
    if (v === null || v === undefined) return undefined;
    if (typeof v !== "object") return undefined;
    const cr = v as Record<string, unknown>;
    const msgs = (cr["messages"] ?? cr["Messages"]) as unknown;
    if (!Array.isArray(msgs)) return { messages: [] };
    const out: ChatMessage[] = (msgs as unknown[]).map((m) => {
      const mm = m as Record<string, unknown>;
      const role = (mm["role"] ?? mm["Role"] ?? "") as string;
      const content = (mm["content"] ?? mm["Content"] ?? "") as string;
      return { role, content };
    });
    return { messages: out };
  };
  const maxTokens = (pick("MaxTokens", "maxTokens") ?? pick("maxTokens", "MaxTokens") ?? (r["MaxTokens"] as number)) as number | undefined;
  const maxTool = (pick("MaxToolRequestTimes", "maxToolRequestTimes") as number | undefined);
  const maxCompletion = (pick("MaxCompletionTokens", "maxCompletionTokens") as number | undefined);
  const planThreshold = (pick("PlanModeLineThreshold", "planModeLineThreshold") as number | undefined);
  return {
    MaxTokens: typeof maxTokens === "number" ? maxTokens : 0,
    MaxToolRequestTimes: typeof maxTool === "number" ? maxTool : 0,
    PlanModeLineThreshold: typeof planThreshold === "number" ? planThreshold : 0,
    MainTask: conv(pick("MainTask", "mainTask")) ?? { messages: [] },
    PlanTask: conv(pick("PlanTask", "planTask")),
    MemoryCompressionTask: conv(pick("MemoryCompressionTask", "memoryCompressionTask")) ?? { messages: [] },
    ReLocationTask: conv(pick("ReLocationTask", "reLocationTask")),
    ReviewFilterTask: conv(pick("ReviewFilterTask", "reviewFilterTask")),
    MaxCompletionTokens: maxCompletion,
  } as unknown as Template;
}

export function NewCommentWorkerPool(workerCount: number): CommentWorkerPool {
  return new CommentWorkerPool(workerCount);
}
export const newCommentWorkerPool = NewCommentWorkerPool;

// ---------------------------------------------------------------------------
// classifyItemError — mirrors Go classifyItemError
// ---------------------------------------------------------------------------
function isWrappedError(err: unknown, target: Error): boolean {
  let cur: unknown = err;
  const visited = new Set<unknown>();
  while (cur !== null && cur !== undefined && !visited.has(cur)) {
    visited.add(cur);
    if (cur === target) return true;
    if (cur instanceof Error) {
      if (cur.message === target.message) return true;
      // Check cause chain (ES2022)
      const cause = (cur as unknown as { cause?: unknown }).cause;
      if (cause !== undefined) { cur = cause; continue; }
      // Also check wrapper via string include for deadline/canceled leak tests
      // but exact sentinel check already handled.
      return false;
    }
    return false;
  }
  return false;
}

function errorContains(err: unknown, substr: string): boolean {
  let cur: unknown = err;
  const visited = new Set<unknown>();
  while (cur !== null && cur !== undefined && !visited.has(cur)) {
    visited.add(cur);
    if (cur instanceof Error) {
      if (cur.message.includes(substr)) return true;
      if (cur.name.includes(substr)) return true;
      const cause = (cur as unknown as { cause?: unknown }).cause;
      if (cause !== undefined) { cur = cause; continue; }
    } else if (typeof cur === "string" && (cur as string).includes(substr)) return true;
    break;
  }
  return false;
}

export function classifyItemError(err: unknown): [FailureClass, string] {
  // Check deadline first (Go errors.Is respects wrapping)
  if (isWrappedError(err, errDeadlineExceeded) || errorContains(err, "deadline exceeded") || errorContains(err, "DeadlineExceeded")) {
    return [FailureTimeout, "file review exceeded its time limit"];
  }
  if (isWrappedError(err, errCanceled) || errorContains(err, "canceled") || errorContains(err, "cancelled") || (err instanceof Error && err.name === "AbortError" && errorContains(err, "canceled"))) {
    // Also check generic AbortError without message — treat as cancelled
    // But must distinguish deadline vs cancelled: deadline check already above.
    // If error is AbortError and not deadline, treat as cancelled.
    return [FailureCancelled, "file review was cancelled"];
  }
  // Check if err is AbortError (DOMException) even without message
  if (err instanceof Error && err.name === "AbortError") {
    // Default AbortError -> cancelled unless deadline phrase present
    if (errorContains(err, "deadline")) return [FailureTimeout, "file review exceeded its time limit"];
    return [FailureCancelled, "file review was cancelled"];
  }
  // Check DOMException via global
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") {
    return [FailureCancelled, "file review was cancelled"];
  }
  if (isWrappedError(err, errMainTaskEmpty) || errorContains(err, "main_task.messages is empty")) {
    return [FailureConfiguration, "review template main_task is empty"];
  }
  if (errorContains(err, "panic") || errorContains(err, "Panic")) {
    return [FailurePanic, "file review panicked"];
  }
  return [FailureProvider, "provider or subtask request failed"];
}

export const ClassifyItemError = classifyItemError;

/** OCR v1.9.9 maps only the configured round ceiling to budget. */
export function classifyMainLoopStop(stop: MainLoopStop): [FailureClass, string] {
  if (stop === MainLoopStop.StopMaxRounds) {
    return [FailureBudget, mainLoopStopReason(stop)];
  }
  return [FailureUnknown, mainLoopStopReason(stop)];
}

// ---------------------------------------------------------------------------
// Internal semaphore helper for concurrency
// ---------------------------------------------------------------------------

class Semaphore {
  private count = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.count < this.max) {
      this.count++;
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const waiter = (): void => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        this.count++;
        resolve(true);
      };
      this.waiters.push(waiter);
      if (signal !== undefined) {
        const onAbort = (): void => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve(false);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  release(): void {
    this.count--;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}

// ---------------------------------------------------------------------------
// Agent — orchestrates diff acquisition, filtering, and per-file loops
// ---------------------------------------------------------------------------

export const errMainTaskEmpty = new Error("main_task.messages is empty in template");
export const ErrMainTaskEmpty = errMainTaskEmpty;
// Sentinel errors mirroring Go context errors for classifyItemError
// Use same messages so errors.Is-style checks via message work.
export const errDeadlineExceeded = new Error("context deadline exceeded");
export const errCanceled = new Error("context canceled");
export const ErrDeadlineExceeded = errDeadlineExceeded;
export const ErrCanceled = errCanceled;

export class Agent {
  public diffs: Diff[] = [];
  private totalInsertions = 0;
  private totalDeletions = 0;
  public currentDate: string;
  private budgetExceeded = false;
  private runner: Runner;
  private inputResolution: InputResolution = { resolvedBase: "", resolvedHead: "", exactRange: "" };
  private repoRemoteIdentity = "";
  private warnings: Array<{ type: string; file: string; message: string }> = [];
  private subtaskOutcomes: Map<string, { completed: boolean; stop?: string; error?: string }> = new Map();
  private sessionHistory: import("../session/history.js").SessionHistory | null = null;
  private manifestBuilder: ManifestBuilder;
  private runManifest: RunManifest | null = null;
  private manifestStartTime: number;
  public session: SessionHistory; // compat: Go tests access a.session.Finalize()
  private resumeInfo: import("../session/history.js").ResumeInfo | null = null;
  private resumeState: import("../session/resume.js").ResumeState | null = null;

  // Public for test harness to observe pool draining behavior if needed
  public readonly commentWorkerPool: CommentWorkerPool;

  constructor(private readonly args: Args) {
    this.currentDate = new Date().toISOString().slice(0, 16).replace("T", " ");
    // Resolve Go-compat aliases
    const rawArgs = args as unknown as Record<string, unknown>;
    const rawTpl = (args.template ?? rawArgs["Template"] ?? { MaxTokens: 0, MaxToolRequestTimes: 0, MainTask: { messages: [] }, MemoryCompressionTask: { messages: [] } }) as unknown;
    const normTpl = normalizeTemplateObject(rawTpl);
    const resolvedArgs: Args = {
      repoDir: args.repoDir ?? (rawArgs["RepoDir"] as string | undefined) ?? "",
      sessionId: args.sessionId ?? (rawArgs["SessionId"] as string | undefined),
      from: args.from ?? (rawArgs["From"] as string | undefined),
      to: args.to ?? (rawArgs["To"] as string | undefined),
      commit: args.commit ?? (rawArgs["Commit"] as string | undefined),
      reviewMode: args.reviewMode ?? (rawArgs["ReviewMode"] as string | undefined),
      template: normTpl,
      systemRule: (args.systemRule ?? rawArgs["SystemRule"] ?? null) as SystemRuleResolver | null,
      fileFilter: (args.fileFilter ?? rawArgs["FileFilter"] ?? null) as FileFilter | null,
      llmClient: (args.llmClient ?? rawArgs["LLMClient"] ?? rawArgs["llmClient"]) as AnyLlmClient,
      tools: (args.tools ?? rawArgs["Tools"] ?? null) as ToolRegistryLike | null,
      planToolDefs: (args.planToolDefs ?? rawArgs["PlanToolDefs"] as readonly ToolDef[] | undefined),
      mainToolDefs: (args.mainToolDefs ?? rawArgs["MainToolDefs"] as readonly ToolDef[] | undefined) ?? [],
      maxConcurrency: args.maxConcurrency ?? (rawArgs["MaxConcurrency"] as number | undefined) ?? (rawArgs["Concurrency"] as number | undefined),
      concurrentTaskTimeoutMinutes: args.concurrentTaskTimeoutMinutes ?? (rawArgs["ConcurrentTaskTimeout"] as number | undefined),
      commentCollector: (args.commentCollector ?? rawArgs["CommentCollector"] ?? null) as CommentCollectorLike | null,
      background: args.background ?? (rawArgs["Background"] as string | undefined),
      model: args.model ?? (rawArgs["Model"] as string | undefined) ?? "",
      provider: args.provider ?? (rawArgs["Provider"] as string | undefined),
      gitRunner: args.gitRunner ?? rawArgs["GitRunner"],
      sealedInput: args.sealedInput ?? (rawArgs["SealedInput"] as InputResolution | null | undefined) ?? null,
      maxTokensBudget: args.maxTokensBudget ?? (rawArgs["MaxTokensBudget"] as number | undefined),
      skipFilter: args.skipFilter ?? (rawArgs["SkipFilter"] as boolean | undefined) ?? false,
      runtimeConfig: args.runtimeConfig ?? (rawArgs["RuntimeConfig"] as RuntimeConfig | null | undefined) ?? null,
      resume: args.resume ?? null,
    };
    // Overlay resolved aliases back onto this.args for later reads
    (this as unknown as { args: Args }).args = resolvedArgs;
    const sessCandidate = rawArgs["Session"] as unknown;
    if (sessCandidate !== null && sessCandidate !== undefined && typeof sessCandidate === "object") {
      this.sessionHistory = sessCandidate as import("../session/history.js").SessionHistory;
    }
    // Manifest builder — mirrors Go initManifest()
    const runId =
      (resolvedArgs.sessionId as string | undefined) ??
      (rawArgs["SessionId"] as string | undefined) ??
      (typeof crypto !== "undefined" && typeof (crypto as unknown as { randomUUID?: () => string }).randomUUID === "function"
        ? (crypto as unknown as { randomUUID: () => string }).randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36));
    this.manifestBuilder = NewManifestBuilder(runId, "review");
    const manifestMode = this.reviewModeForManifest();
    this.manifestBuilder.SetInput({ mode: manifestMode });
    this.manifestStartTime = Date.now();
    this.initManifest();
    // Create a lightweight SessionHistory for compat with a.session.Finalize() / a.session.Manifest()
    if (this.sessionHistory === null) {
      this.sessionHistory = new SessionHistory(resolvedArgs.repoDir ?? "/tmp", "", resolvedArgs.model ?? "", { reviewMode: manifestMode }, runId);
      (this.sessionHistory as unknown as { manifest: ManifestBuilder }).manifest = this.manifestBuilder;
    } else {
      // Attach our builder if session doesn't already have one
      const existing = (this.sessionHistory as unknown as { manifest?: ManifestBuilder | null }).manifest;
      if (!existing) (this.sessionHistory as unknown as { manifest: ManifestBuilder }).manifest = this.manifestBuilder;
      else this.manifestBuilder = existing;
    }
    this.session = this.sessionHistory;
    this.resumeState = (resolvedArgs.resume ?? null) as import("../session/resume.js").ResumeState | null;
    // Build runner with LlmTransport seam — mirrors Go llmloop.NewRunner.
    const commentCollector = (resolvedArgs.commentCollector ?? createInMemoryCollector()) as unknown as CommentCollectorLike;
    const mainToolDefs = resolvedArgs.mainToolDefs ?? [];
    const toolRegistry = (resolvedArgs.tools ?? null) as unknown as ToolRegistryLike | null;
    // CommentWorkerPool: 8 workers, per-file isolation via AwaitKey (mirrors Go NewCommentWorkerPool(8))
    this.commentWorkerPool = new CommentWorkerPool(8);

    // DiffLookup: resolve path -> Diff for relocation (mirrors Go Deps.DiffLookup)
    const diffLookup = (path: string): Diff | null => {
      for (const ddRaw of this.diffs) {
        const dd = normalizeDiff(ddRaw);
        if (dd.newPath === path || dd.oldPath === path) return dd;
      }
      return null;
    };

    // Forward ReLocationTask and MemoryCompressionTask faithfully; Runner will handle both Shapes
    const templateForRunner: Record<string, unknown> = {
      MaxTokens: args.template.MaxTokens,
      MaxToolRequestTimes: args.template.MaxToolRequestTimes,
      MaxCompletionTokens: args.template.MaxCompletionTokens,
      MemoryCompressionTask: args.template.MemoryCompressionTask !== undefined
        ? { Messages: args.template.MemoryCompressionTask.messages.map((m) => ({ role: m.role, content: m.content })) as unknown as readonly { role: string; content: string }[] }
        : undefined,
      ReLocationTask: (args.template as unknown as Record<string, unknown>)["ReLocationTask"] ?? (args.template as unknown as { ReLocationTask?: unknown }).ReLocationTask ?? null,
    };
    // If ReLocationTask exists but is in template's shape (messages), keep as is; Runner handles both
    if (args.template.ReLocationTask !== undefined && args.template.ReLocationTask !== null) {
      // Ensure the runner sees it as Messages or messages; we preserve original
      (templateForRunner as unknown as Record<string, unknown>)["ReLocationTask"] = args.template.ReLocationTask as unknown;
    }

    this.runner = new Runner({
      model: resolvedArgs.model,
      sessionId: resolvedArgs.sessionId,
      template: templateForRunner as unknown as import("../llmloop/types.js").Template,
      llmClient: resolvedArgs.llmClient,
      mainToolDefs: mainToolDefs as unknown as readonly ToolDef[],
      commentCollector: commentCollector as unknown as never,
      toolRegistry: toolRegistry as unknown as never,
      diffLookup: diffLookup as unknown as never,
      // The cross-file resolver must see only this review's selected diffs.
      allDiffs: () => this.diffs.map((diff) => normalizeDiff(diff)),
      commentWorkerPool: this.commentWorkerPool as unknown as never,
      session: this.sessionHistory as unknown as never,
      newRequestMeta: this.newRequestMeta.bind(this) as unknown as never,
    } as unknown as import("../llmloop/types.js").RunnerDeps);
  }

  // -- public getters mirroring Go

  sessionId(): string {
    if (this.sessionHistory !== null) {
      const hasPersistence = (this.sessionHistory as unknown as { HasPersistence?: () => boolean }).HasPersistence;
      if (typeof hasPersistence === "function" && !hasPersistence.call(this.sessionHistory)) return "";
      return this.sessionHistory.sessionId ?? "";
    }
    return this.args.sessionId ?? "";
  }

  Session(): import("../session/history.js").SessionHistory | null {
    return this.sessionHistory;
  }

  ResumeInfo(): import("../session/history.js").ResumeInfo | null {
    return this.resumeInfo ? { ...this.resumeInfo } : null;
  }
  FilesReviewed(): number {
    let n = 0;
    for (const dRaw of this.diffs) if (!normalizeDiff(dRaw).isDeleted) n++;
    return n;
  }
  Diffs(): Diff[] {
    return this.diffs.map((d) => normalizeDiff(d));
  }
  ProjectSummary(): string {
    return "";
  }
  Warnings(): Array<{ type: string; file: string; message: string }> {
    return this.warningsList();
  }
  ToolCalls(): Record<string, number> {
    return this.toolCalls();
  }
  TotalTokensUsed(): number { return this.totalTokensUsed(); }
  TotalInputTokens(): number { return this.totalInputTokens(); }
  TotalOutputTokens(): number { return this.totalOutputTokens(); }
  TotalCacheReadTokens(): number { return this.totalCacheReadTokens(); }
  TotalCacheWriteTokens(): number { return this.totalCacheWriteTokens(); }
  BudgetExceeded(): boolean { return this.budgetExceededFlag(); }

  // Go calls a.recordWarning (lowercase) — expose both casings
  recordWarning(warningType: string, file: string, message: string): void {
    this.warnings.push({ type: warningType, file, message });
    try { (this.runner as unknown as { RecordWarning?: (t: string, f: string, m: string) => void }).RecordWarning?.(warningType, file, message); } catch {}
  }
  RecordWarning(warningType: string, file: string, message: string): void { this.recordWarning(warningType, file, message); }

  // -- manifest helpers — mirrors Go registerCoverage / markCompleted / finalizeManifest
  async preview(signal?: AbortSignal): Promise<Preview> {
    await this.loadDiffs(signal ?? new AbortController().signal);
    const result: Preview = {
      entries: [],
      totalInsertions: this.totalInsertions,
      totalDeletions: this.totalDeletions,
      totalFiles: this.diffs.length,
      reviewableCount: 0,
      excludedCount: 0,
    };
    for (const dRaw of this.diffs) {
      const d = normalizeDiff(dRaw);
      const path = effectivePath(d);
      let reason = whyExcluded(d, this.args.fileFilter ?? null);
      if (reason === ExcludeNone && d.isDeleted) reason = ExcludeDeleted;
      const entry: PreviewEntry = {
        path,
        status: diffStatus(d),
        insertions: d.insertions,
        deletions: d.deletions,
        willReview: reason === ExcludeNone,
      };
      if (reason !== ExcludeNone) (entry as unknown as { excludeReason?: ExcludeReason }).excludeReason = reason;
      if (entry.willReview) result.reviewableCount++;
      else result.excludedCount++;
      (result.entries as PreviewEntry[]).push(entry);
    }
    // Ensure non-nil entries per Go: already non-nil array
    return result;
  }

  private applyResume(diffs: Diff[]): Diff[] {
    const resume = this.args.resume ?? this.resumeState;
    if (resume === null || resume === undefined) return diffs;
    const mode = this.reviewModeForManifest();
    const toDispatch: Diff[] = [];
    let reused = 0;
    const collector = this.args.commentCollector ?? null;
    for (const dRaw of diffs) {
      const d = normalizeDiff(dRaw);
      if (d.isDeleted) { toDispatch.push(d); continue; }
      const fingerprint = reviewItemFingerprint(mode, d);
      const item = resume.ReusableItem(fingerprint);
      if (item === null || item === undefined) { toDispatch.push(d); continue; }
      const comments = (item as unknown as { comments?: unknown }).comments as unknown[] | undefined;
      if (collector !== null && Array.isArray(comments)) {
        for (const cm of comments) {
          try { collector.add(cm as never); } catch {}
        }
      }
      try {
        const sess = this.sessionHistory;
        if (sess !== null && typeof (sess as unknown as { RecordReviewItemReused?: unknown }).RecordReviewItemReused === "function") {
          const resumedFrom = resume.sessionId;
          (sess as unknown as { RecordReviewItemReused: (p: string, o: string, n: string, f: string, s: string, c: unknown[]) => void }).RecordReviewItemReused(effectivePath(d), d.oldPath, d.newPath, fingerprint, resumedFrom, comments as never[]);
        }
      } catch {}
      this.markReused(d);
      reused++;
    }
    const rerun = toDispatch.filter((d) => !d.isDeleted).length;
    const prevModel = resume.model ?? "";
    const curModel = this.args.model ?? "";
    const resumedFrom = resume.sessionId ?? "";
    this.resumeInfo = { resumedFrom, reusedFiles: reused, rerunFiles: rerun, previousModel: prevModel, currentModel: curModel };
    return toDispatch;
  }

  private reviewModeForManifest(): string {
    const from = this.args.from ?? "";
    const to = this.args.to ?? "";
    const commit = this.args.commit ?? "";
    if (commit !== "") return "commit";
    if (from !== "" && to !== "") return "range";
    return "workspace";
  }

  private manifestMode(): string {
    return this.reviewModeForManifest();
  }

  private sourceArtifactSHA256(): string {
    type Pair = { id: string; fingerprint: string };
    const pairs: Pair[] = [];
    const seen = new Set<string>();
    const mode = this.reviewModeForManifest();
    for (const dRaw of this.diffs) {
      const d = normalizeDiff(dRaw);
      if (d.isDeleted) continue;
      const id = manifestItemID(mode, d);
      if (seen.has(id)) continue;
      seen.add(id);
      pairs.push({ id, fingerprint: reviewItemFingerprint(mode, d) });
    }
    pairs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const fields: string[] = [];
    for (const p of pairs) fields.push(p.id, p.fingerprint);
    return hashFields(...fields);
  }

  private ruleConfigSHA256(): string {
    const fields: string[] = [];
    const anyArgs = this.args as unknown as Record<string, unknown>;
    const sysRule = anyArgs["systemRule"] as unknown;
    if (sysRule !== null && sysRule !== undefined && typeof sysRule === "object") {
      const rec = sysRule as Record<string, unknown>;
      const cc = rec["canonicalConfig"] as unknown;
      if (typeof cc === "function") {
        try {
          const result = (cc as () => string[]).call(sysRule) as string[];
          if (Array.isArray(result)) fields.push(...result);
        } catch {}
      }
    }
    const fileFilter = anyArgs["fileFilter"] as unknown;
    if (fileFilter !== null && fileFilter !== undefined && typeof fileFilter === "object") {
      const rec = fileFilter as Record<string, unknown>;
      const inc = rec["include"] as unknown;
      const exc = rec["exclude"] as unknown;
      if (Array.isArray(inc)) for (const v of inc) if (typeof v === "string") fields.push("include", v);
      if (Array.isArray(exc)) for (const v of exc) if (typeof v === "string") fields.push("exclude", v);
    }
    return hashFields(...fields);
  }

  private runtimeConfigSHA256(): string {
    const rc = (this.args.runtimeConfig ?? {}) as unknown as Record<string, unknown>;
    const protocol = (rc["protocol"] ?? "") as string;
    const endpointHost = (rc["endpointHost"] ?? "") as string;
    const language = (rc["language"] ?? "") as string;
    const timeoutRaw = (rc["timeoutMs"] ?? "") as unknown;
    let timeoutStr = "";
    if (typeof timeoutRaw === "number") {
      // Go's Timeout.String() for time.Duration: convert ms to Go duration string approx
      // For simplicity use ms string; test only cares that mutations change digest, not exact string.
      timeoutStr = String(timeoutRaw);
      // If value looks like nanoseconds? Not needed.
      // Try to approximate Go's string for seconds: if divisible by 1000, use s
      if (timeoutRaw % 1000 === 0 && timeoutRaw !== 0) {
        const sec = timeoutRaw / 1000;
        if (sec % 60 === 0) timeoutStr = `${sec / 60}m0s`;
        else timeoutStr = `${sec}s`;
      } else if (timeoutRaw !== 0) {
        timeoutStr = `${timeoutRaw}ms`;
      }
    } else if (typeof timeoutRaw === "string") {
      timeoutStr = timeoutRaw;
    } else if (timeoutRaw !== null && typeof timeoutRaw === "object" && typeof (timeoutRaw as { toString?: () => string }).toString === "function") {
      try { timeoutStr = String(timeoutRaw); } catch { timeoutStr = ""; }
    }
    const model = this.args.model ?? "";
    const maxConcurrency = this.args.maxConcurrency ?? 0;
    const maxTokensBudget = this.args.maxTokensBudget ?? 0;
    return hashFields(
      "protocol", protocol,
      "model", model,
      "host", endpointHost,
      "language", language,
      "timeout", timeoutStr,
      "concurrency", String(maxConcurrency),
      "max_tokens_budget", String(maxTokensBudget),
    );
  }

  private runIdentity(): { mode: string; sourceArtifactSHA256: string; ruleConfigSHA256: string; repositorySHA256: string } {
    const mode = this.manifestMode();
    const source = this.sourceArtifactSHA256();
    const rule = this.ruleConfigSHA256();
    let repo = "";
    const raw = (this as unknown as { repoRemoteIdentity?: string }).repoRemoteIdentity ?? "";
    if (raw !== "") {
      repo = createHash("sha256").update(raw, "utf-8").digest("hex");
    }
    return { mode, sourceArtifactSHA256: source, ruleConfigSHA256: rule, repositorySHA256: repo };
  }

  private manifestInput(): import("../session/manifest.js").ManifestInput {
    const mode = this.manifestMode();
    const from = this.args.from ?? "";
    const to = this.args.to ?? "";
    const commit = this.args.commit ?? "";
    const input: import("../session/manifest.js").ManifestInput = { mode };
    if (mode === "range") {
      input.requestedFrom = from;
      input.requestedHead = to;
    } else if (mode === "commit") {
      input.requestedHead = commit;
    }
    return input;
  }

  private applyInputIdentity(): void {
    const b = this.manifestBuilder;
    if (!b) return;
    const input = this.manifestInput();
    const anyThis = this as unknown as { inputResolution?: InputResolution };
    const res = anyThis.inputResolution ?? { resolvedBase: "", resolvedHead: "", exactRange: "" };
    input.resolvedBase = res.resolvedBase;
    input.resolvedHead = res.resolvedHead;
    input.exactRange = res.exactRange;
    (input as unknown as Record<string, unknown>)["sourceArtifactSHA256"] = this.sourceArtifactSHA256();
    (input as unknown as Record<string, unknown>)["sourceArtifactSha256"] = this.sourceArtifactSHA256();
    b.SetInput(input as unknown as import("../session/manifest.js").ManifestInput);
    const raw = (this as unknown as { repoRemoteIdentity?: string }).repoRemoteIdentity ?? "";
    if (raw !== "") {
      const hash = createHash("sha256").update(raw, "utf-8").digest("hex");
      b.SetRepository({ identitySha256: hash } as unknown as import("../session/manifest.js").ManifestRepository);
    }
  }

  private initManifest(): void {
    const b = this.manifestBuilder;
    if (!b) return;
    const resume = this.args.resume;
    const parent = resume ? resume.sessionId : "";
    if (parent !== "") b.SetParentRunID(parent);
    const input = this.manifestInput();
    b.SetInput(input);
    const provider = this.args.provider ?? "";
    const model = this.args.model ?? "";
    const maxConcurrency = this.args.maxConcurrency ?? 0;
    b.SetExecution({
      provider,
      model,
      configuredConcurrency: maxConcurrency,
      ruleConfigSha256: this.ruleConfigSHA256(),
      runtimeConfigSha256: this.runtimeConfigSHA256(),
      // Also set SHA variants for test compatibility
      ...( { ruleConfigSHA256: this.ruleConfigSHA256(), runtimeConfigSHA256: this.runtimeConfigSHA256() } as unknown as Record<string, unknown>),
    } as unknown as import("../session/manifest.js").ManifestExecution);
  }

  private newRequestMeta(filePath: string, taskType: string, requestNo: number): import("../llmloop/types.js").RequestMeta {
    const provider = this.args.provider ?? "";
    const model = this.args.model ?? "";
    return { provider, model, filePath, taskType, requestNo };
  }

  private coverageItem(d: Diff): CoverageItem {
    const { oldPath, newPath } = manifestPaths(d);
    const itemId = manifestItemID(this.reviewModeForManifest(), d);
    const it: CoverageItem = { itemId, path: effectivePath(d), fingerprint: reviewItemFingerprint(this.reviewModeForManifest(), d) };
    if (oldPath !== "" && oldPath !== newPath) it.oldPath = oldPath;
    return it;
  }

  private registerCoverage(diffs: Diff[]): Error | null {
    if (!this.manifestBuilder) return null;
    for (const d of diffs) {
      if (d.isDeleted) continue;
      const err = this.manifestBuilder.RegisterSelected(this.coverageItem(d));
      if (err) return err;
    }
    return this.manifestBuilder.SealSelected();
  }

  private markCompleted(d: Diff): void {
    const b = this.manifestBuilder;
    if (!b) return;
    const err = b.MarkCompleted(manifestItemID(this.reviewModeForManifest(), d));
    if (err) this.recordWarning("manifest_error", d.newPath, err.message);
    if (err === null) {
      const comments = this.args.commentCollector?.commentsForPath?.(effectivePath(d)) ?? [];
      this.sessionHistory?.RecordReviewItemDone(
        effectivePath(d),
        d.oldPath,
        d.newPath,
        reviewItemFingerprint(this.reviewModeForManifest(), d),
        comments,
      );
    }
  }

  private markReused(d: Diff): void {
    const b = this.manifestBuilder;
    if (!b) return;
    const err = b.MarkReused(manifestItemID(this.reviewModeForManifest(), d));
    if (err) this.recordWarning("manifest_error", d.newPath, err.message);
  }

  private markFailed(d: Diff, cls: FailureClass, reason: string): void {
    const b = this.manifestBuilder;
    if (!b) return;
    const err = b.MarkFailed(manifestItemID(this.reviewModeForManifest(), d), cls, reason);
    if (err) this.recordWarning("manifest_error", d.newPath, err.message);
    if (err === null) {
      this.sessionHistory?.RecordReviewItemFailed(
        effectivePath(d),
        d.oldPath,
        d.newPath,
        reviewItemFingerprint(this.reviewModeForManifest(), d),
        reason,
      );
    }
  }

  /** Record the parent abort before finalization sweeps undispatched work. */
  private recordCancellation(signal: AbortSignal): Error {
    const cause = signal.reason;
    const error = cause instanceof Error
      ? cause
      : new Error(cause === undefined ? "review was cancelled" : String(cause));
    const manifestError = this.manifestBuilder.SetRunFailure(RunFailureCancelled, "review was cancelled");
    if (manifestError !== null) this.recordWarning("manifest_error", "", manifestError.message);
    return error;
  }

  finalizeManifest(): Error | null {
    const b = this.manifestBuilder;
    if (!b) return null;
    this.applyInputIdentity();
    const elapsed = Date.now() - (this.manifestStartTime ?? Date.now());
    const { manifest, error } = b.Finalize(elapsed);
    if (error) {
      this.recordWarning("manifest_error", "", error.message);
      return error;
    }
    this.runManifest = manifest;
    if (this.sessionHistory) (this.sessionHistory as unknown as { finalManifest: RunManifest | null }).finalManifest = manifest;
    return null;
  }

  RunManifest(): RunManifest | null {
    return this.runManifest ? { ...this.runManifest, coverage: { selected: [...this.runManifest.coverage.selected], completed: [...this.runManifest.coverage.completed], reused: [...this.runManifest.coverage.reused], failed: [...this.runManifest.coverage.failed], waived: [...this.runManifest.coverage.waived] } } : null;
  }


  budgetExceededFlag(): boolean {
    return this.budgetExceeded;
  }

  warningsList(): Array<{ type: string; file: string; message: string }> {
    return [...this.warnings];
  }

  getDiffs(): Diff[] {
    return [...this.diffs];
  }

  totalTokensUsed(): number {
    return this.runner.TotalTokensUsed();
  }

  totalInputTokens(): number {
    return this.runner.TotalInputTokens();
  }

  totalOutputTokens(): number {
    return this.runner.TotalOutputTokens();
  }

  totalCacheReadTokens(): number {
    return this.runner.TotalCacheReadTokens();
  }

  totalCacheWriteTokens(): number {
    return this.runner.TotalCacheWriteTokens();
  }

  toolCalls(): Record<string, number> {
    return this.runner.toolCallsObject();
  }

  completedPaths(): readonly string[] {
    return this.diffs.filter((d) => !d.isDeleted).map((d) => d.newPath);
  }

  subtaskOutcomesMap(): ReadonlyMap<string, { completed: boolean; stop?: string; error?: string }> {
    return this.subtaskOutcomes;
  }

  // -- lifecycle

  async run(signal?: AbortSignal): Promise<LlmComment[]> {
    const sig: AbortSignal = signal ?? new AbortController().signal;

    // Step 1: load diffs (with sealed input handling)
    try {
      await this.loadDiffs(sig);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        this.manifestBuilder.SetRunFailure("input" as never, e.message);
        this.finalizeManifest();
        this.sessionHistory?.Finalize();
      } catch {}
      throw new Error(`load diffs: ${e.message}`);
    }

    const totalChanged = this.diffs.length;
    const reviewCount = this.countReviewable(this.diffs);
    // Emit progress to stderr so stdout stays machine-readable.
    console.error(`[pi-review] ${totalChanged} file(s) changed, reviewing ${reviewCount} in ${this.args.repoDir}`);

    // Build diff map for file_read_diff tool if present (best-effort, no error if absent)
    this.injectDiffMap();

    this.diffs = this.filterDiffs(this.diffs);

    if (this.diffs.length === 0) {
      console.error("[pi-review] No supported files changed. Skipping review.");
      return [];
    }

    this.currentDate = new Date().toISOString().replace("T", " ").slice(0, 16);

    if ((this.args.maxTokensBudget ?? 0) > 0) {
      const est = estimateDiffCost(this.diffs);
      console.error(`[pi-review] estimated cost: ${est.totalTokens} tokens`);
      console.error(`[pi-review] token budget: ${humanTokens(this.args.maxTokensBudget!)} (dispatch stops once exceeded)`);
      if (est.totalTokens > (this.args.maxTokensBudget ?? 0)) {
        console.error(`[pi-review] WARNING: estimate (${humanTokens(est.totalTokens)}) exceeds token budget (${humanTokens(this.args.maxTokensBudget!)})`);
      }
    }

    // Step 2: dispatch per-file subtasks concurrently.
    try {
      const comments = await this.dispatchSubtasks(sig);
      await this.runner.WaitBackground().catch(() => undefined);
      return comments;
    } catch (err) {
      if (sig.aborted) this.recordCancellation(sig);
      this.finalizeManifest();
      this.sessionHistory?.Finalize();
      throw err;
    }
  }

  // -- internal helpers

  private async loadDiffs(signal?: AbortSignal): Promise<void> {
    const { repoDir, from, to, commit, sealedInput } = this.args;
    let f = from ?? "";
    let t = to ?? "";
    let c = commit ?? "";
    if (sealedInput !== null && sealedInput !== undefined && sealedInput.resolvedHead !== "") {
      if (c !== "") {
        c = sealedInput.resolvedHead;
      } else if (sealedInput.resolvedBase !== "") {
        f = sealedInput.resolvedBase;
        t = sealedInput.resolvedHead;
      }
    }

    let provider: Provider;
    if (c !== "") provider = Provider.forCommit(repoDir, c, null);
    else if (f !== "" && t !== "") provider = Provider.forRange(repoDir, f, t, null);
    else provider = Provider.forWorkspace(repoDir, null);

    const parsed = await provider.getDiff(signal);
    this.diffs = parsed;
    this.inputResolution = await provider.resolveInput(signal);
    try {
      this.repoRemoteIdentity = await provider.remoteIdentity(signal);
    } catch {
      this.repoRemoteIdentity = "";
    }
    let ins = 0;
    let del = 0;
    for (const d of parsed) {
      ins += d.insertions;
      del += d.deletions;
    }
    this.totalInsertions = ins;
    this.totalDeletions = del;
  }

  private injectDiffMap(): void {
    const tools = this.args.tools;
    if (tools === null || tools === undefined) return;
    const toolsRecord: Record<string, unknown> = tools as unknown as Record<string, unknown>;
    const maybeGet = toolsRecord["get"] as ((name: string) => unknown) | undefined;
    const maybeGetAlt = toolsRecord["Get"] as ((name: string) => unknown) | undefined;
    const getter = maybeGet ?? maybeGetAlt;
    if (typeof getter !== "function") return;
    try {
      const prov = getter.call(tools, "file_read_diff") as unknown as { setDiffMap?: (m: unknown) => void; SetDiffMap?: (m: unknown) => void } | undefined;
      const setter = prov !== undefined && prov !== null ? ((prov.setDiffMap ?? (prov as unknown as { SetDiffMap?: (m: unknown) => void }).SetDiffMap) as ((m: unknown) => void) | undefined) : undefined;
      if (setter !== undefined) {
        const m = new Map<string, string>();
        for (const dRaw of this.diffs) {
          const d = normalizeDiff(dRaw);
          if (d.newPath !== "/dev/null") m.set(d.newPath, d.diff);
        }
        // Provide both Get (Go) and get (JS) so Either API works
        const dm = {
          Get: (p: string): [string, boolean] => {
            const v = m.get(p);
            if (v !== undefined) return [v, true];
            return ["", false];
          },
          get: (p: string): [string, boolean] => {
            const v = m.get(p);
            if (v !== undefined) return [v, true];
            return ["", false];
          },
        };
        setter.call(prov, dm as unknown);
      } else if (prov !== undefined && prov !== null && typeof (prov as unknown as { setDiffMap?: unknown }).setDiffMap === "function") {
        // fallback already handled
      }
    } catch {
      // best-effort only
    }
    if (typeof tools.freeze === "function") {
      try {
        tools.freeze();
      } catch {
        // ignore
      }
    }
  }

  private reviewMode(): string {
    if (this.args.reviewMode !== undefined && this.args.reviewMode !== "") return this.args.reviewMode;
    return reviewModeString(this.args.from ?? "", this.args.to ?? "", this.args.commit ?? "");
  }

  private countReviewable(diffs: readonly unknown[]): number {
    let n = 0;
    for (const dRaw of diffs) {
      const d = normalizeDiff(dRaw);
      if (whyExcluded(d, this.args.fileFilter ?? null) !== ExcludeNone) continue;
      if (d.isDeleted) continue;
      n++;
    }
    return n;
  }

  private filterDiffs(diffs: unknown[]): Diff[] {
    const kept: Diff[] = [];
    let skipped = 0;
    for (const dRaw of diffs) {
      const d = normalizeDiff(dRaw);
      const path = effectivePath(d);
      if (whyExcluded(d, this.args.fileFilter ?? null) !== ExcludeNone) {
        if (d.isBinary) console.error(`[pi-review] Skipping ${path} — binary file`);
        else console.error(`[pi-review] Skipping ${path} — filtered by path/extension rules`);
        skipped++;
        continue;
      }
      kept.push(d);
    }
    if (skipped > 0) console.error(`[pi-review] Filtered ${skipped} file(s) by include/exclude rules`);
    return kept;
  }

  private filterLargeDiffs(diffs: unknown[]): Diff[] {
    const limit = PromptTokenLimit(this.args.template.MaxTokens);
    if (limit <= 0) return diffs.map((d) => normalizeDiff(d));
    const kept: Diff[] = [];
    let skipped = 0;
    for (const dRaw of diffs) {
      const d = normalizeDiff(dRaw);
      const tokens = countTokens(d.diff);
      if (tokens > limit) {
        console.error(`[pi-review] Skipping ${d.newPath} (~${tokens} tokens exceeds 80% of max_tokens(${this.args.template.MaxTokens}))`);
        skipped++;
        continue;
      }
      kept.push(d);
    }
    if (skipped > 0) console.error(`[pi-review] Pre-filtered ${skipped} file(s) exceeding 80% of max_tokens`);
    return kept;
  }

  private resolveSystemRule(path: string): string {
    if (this.args.systemRule === null || this.args.systemRule === undefined) return "";
    try {
      return this.args.systemRule.resolve(path);
    } catch {
      return "";
    }
  }

  private findDiff(path: string): Diff | null {
    for (const dRaw of this.diffs) {
      const d = normalizeDiff(dRaw);
      if (d.newPath === path || d.oldPath === path) return d;
    }
    return null;
  }

  private buildChangeFilesExcept(excludePath: string): string {
    // Mirror Go Agent.buildChangeFilesExcept: write a newline after every
    // non-excluded entry except the final element of a.diffs (by original index).
    let out = "";
    for (let i = 0; i < this.diffs.length; i++) {
      const dRaw = this.diffs[i]!;
      const d = normalizeDiff(dRaw);
      if (d.isBinary) continue;
      if (d.newPath === excludePath || d.oldPath === excludePath) continue;
      let status = "MODIFIED";
      if (d.isNew) status = "ADDED";
      else if (d.isDeleted) status = "DELETED";
      else if (d.oldPath !== d.newPath) status = "RENAMED";
      out += `${status}   ${d.newPath}`;
      if (i < this.diffs.length - 1) {
        out += "\n";
      }
    }
    return out;
  }

  async dispatchSubtasks(signal: AbortSignal): Promise<LlmComment[]> {
    // Pre-filter large diffs
    this.diffs = this.filterLargeDiffs(this.diffs);
    if (this.diffs.length === 0) {
      console.error("[pi-review] All changed files exceeded the token size limit. Skipping review.");
      return [];
    }

    // Register coverage before dispatch — mirrors Go registerCoverage
    const covErr = this.registerCoverage(this.diffs);
    if (covErr) {
      this.recordWarning("manifest_error", "", covErr.message);
      this.manifestBuilder.SetRunFailure("internal" as never, "coverage registration failed");
    }

    if (signal.aborted) {
      throw this.recordCancellation(signal);
    }

    const toDispatch = this.applyResume(this.diffs);

    let concurrency = this.args.maxConcurrency ?? 8;
    if (concurrency <= 0) concurrency = 8;
    const timeoutMs =
      this.args.concurrentTaskTimeoutMinutes !== undefined && this.args.concurrentTaskTimeoutMinutes > 0
        ? this.args.concurrentTaskTimeoutMinutes * 60 * 1000
        : 0;

    const sem = new Semaphore(concurrency);
    const tasks: Promise<void>[] = [];
    let dispatched = 0;
    let failed = 0;
    const collector = this.args.commentCollector ?? null;

    // Budget pre-check helper
    const maxBudget = this.args.maxTokensBudget ?? 0;

    for (const dRaw of toDispatch) {
      const d = normalizeDiff(dRaw);
      if (d.isDeleted) continue;
      if (signal.aborted) break;

      if (maxBudget > 0) {
        const used = this.runner.TotalTokensUsed();
        const nextEst = estimateDiffFileTokens(d);
        const projected = used + nextEst;
        if (projected > maxBudget) {
          console.error(
            `[pi-review] token budget reached (used ${humanTokens(used)} + next-file est ${humanTokens(nextEst)} = projected ${humanTokens(projected)} > budget ${humanTokens(maxBudget)}) — skipping ${d.newPath} and remaining files`,
          );
          this.warnings.push({
            type: "token_budget_reached",
            file: d.newPath,
            message: `stopped dispatch: used ${used} tokens + next-file estimate ${nextEst} = projected ${projected} exceeds budget ${maxBudget}`,
          });
          try { this.runner.RecordWarning("token_budget_reached", d.newPath, `stopped dispatch: used ${used} tokens + next-file estimate ${nextEst} = projected ${projected} exceeds budget ${maxBudget}`); } catch {}
          this.budgetExceeded = true;
          // Controlled coverage truncation — pending cause, not run_failure (mirrors Go)
          try { this.manifestBuilder.SetPendingFailureCause(FailureBudget, "aggregate token budget reached before dispatch completed"); } catch {}
          break;
        }
      }

      const acquired = await sem.acquire(signal);
      if (!acquired) break;
      if (signal.aborted) {
        sem.release();
        break;
      }
      dispatched++;

      const task = (async (diff: Diff): Promise<void> => {
        let timeoutCtrl: AbortController | null = null;
        let taskSignal: AbortSignal = signal;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        if (timeoutMs > 0) {
          timeoutCtrl = new AbortController();
          const onParentAbort = (): void => timeoutCtrl?.abort(signal.reason);
          signal.addEventListener("abort", onParentAbort, { once: true });
          timeoutId = setTimeout(() => timeoutCtrl?.abort(new Error("file task timeout")), timeoutMs);
          // Merge: taskSignal aborts if either parent or timeout aborts
          const merged = new AbortController();
          const forwardParent = (): void => merged.abort(signal.reason);
          const forwardTimeout = (): void => merged.abort(timeoutCtrl?.signal.reason);
          signal.addEventListener("abort", forwardParent);
          timeoutCtrl.signal.addEventListener("abort", forwardTimeout);
          if (signal.aborted) merged.abort(signal.reason);
          if (timeoutCtrl.signal.aborted) merged.abort(timeoutCtrl.signal.reason);
          taskSignal = merged.signal;
          // cleanup after
          const cleanup = (): void => {
            if (timeoutId !== null) clearTimeout(timeoutId);
            signal.removeEventListener("abort", onParentAbort);
            signal.removeEventListener("abort", forwardParent);
            timeoutCtrl?.signal.removeEventListener("abort", forwardTimeout);
          };
          try {
            const result = await this.executeSubtask(taskSignal, diff);
            const stopStr = result.stop !== undefined ? (typeof result.stop === "string" ? result.stop : (result.stop as { class: string }).class) : undefined;
            this.subtaskOutcomes.set(diff.newPath, { completed: result.completed, stop: stopStr, error: result.error?.message });
            if (result.completed) this.markCompleted(diff);
            else if (result.error !== null && result.error !== undefined) this.markFailed(diff, classifyItemError(result.error)[0], classifyItemError(result.error)[1]);
            else if (result.stop !== undefined) {
              const st = result.stop as unknown as { class: FailureClass; reason: string; checkpoint: string; reportAsError?: boolean };
              const cls = st.class ?? FailureBudget;
              const reason = st.reason ?? "budget";
              this.markFailed(diff, cls, reason);
            }
            cleanup();
            if (!result.completed && result.error !== null && result.error !== undefined) {
              failed++;
              this.warnings.push({ type: "subtask_error", file: diff.newPath, message: result.error.message });
              console.error(`[pi-review] Subtask error for ${diff.newPath}: ${result.error.message}`);
            } else if (!result.completed && result.stop !== undefined) {
              const st = result.stop as unknown as { class: FailureClass; reason: string; checkpoint: string; reportAsError?: boolean };
              if (st.reportAsError) {
                failed++;
                const cp = st.checkpoint ?? st.reason;
                this.warnings.push({ type: "subtask_error", file: diff.newPath, message: cp });
                console.error(`[pi-review] Subtask error for ${diff.newPath}: ${cp}`);
              } else if (st.class === FailureBudget) {
                // token threshold — already warned inside executeSubtask, treat as not failed but still marked
                // keep as warning already recorded
              }
            }
          } catch (err) {
            cleanup();
            failed++;
            const msg = err instanceof Error ? err.message : String(err);
            this.subtaskOutcomes.set(diff.newPath, { completed: false, error: msg });
            this.warnings.push({ type: "subtask_error", file: diff.newPath, message: msg });
            const [cls, reason] = classifyItemError(err);
            this.markFailed(diff, cls, reason);
            console.error(`[pi-review] Subtask panic for ${diff.newPath}: ${msg}`);
          } finally {
            sem.release();
          }
          return;
        }

        try {
          const result = await this.executeSubtask(taskSignal, diff);
          const stopStr2 = result.stop !== undefined ? (typeof result.stop === "string" ? result.stop : (result.stop as { class: string }).class) : undefined;
          this.subtaskOutcomes.set(diff.newPath, { completed: result.completed, stop: stopStr2, error: result.error?.message });
          if (result.completed) this.markCompleted(diff);
          else if (result.error !== null && result.error !== undefined) this.markFailed(diff, classifyItemError(result.error)[0], classifyItemError(result.error)[1]);
          else if (result.stop !== undefined) {
            const st = result.stop as unknown as { class: FailureClass; reason: string; checkpoint: string; reportAsError?: boolean };
            this.markFailed(diff, st.class ?? FailureBudget, st.reason ?? "budget");
          }
          if (!result.completed && result.error !== null && result.error !== undefined) {
            failed++;
            this.warnings.push({ type: "subtask_error", file: diff.newPath, message: result.error.message });
            console.error(`[pi-review] Subtask error for ${diff.newPath}: ${result.error.message}`);
          } else if (!result.completed && result.stop !== undefined) {
            const st = result.stop as unknown as { class: FailureClass; reason: string; checkpoint: string; reportAsError?: boolean };
            if (st.reportAsError) {
              failed++;
              const cp = st.checkpoint ?? st.reason;
              this.warnings.push({ type: "subtask_error", file: diff.newPath, message: cp });
              console.error(`[pi-review] Subtask error for ${diff.newPath}: ${cp}`);
            }
          }
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          this.subtaskOutcomes.set(diff.newPath, { completed: false, error: msg });
          this.warnings.push({ type: "subtask_error", file: diff.newPath, message: msg });
          const [cls, reason] = classifyItemError(err);
          this.markFailed(diff, cls, reason);
          console.error(`[pi-review] Subtask panic for ${diff.newPath}: ${msg}`);
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
          sem.release();
        }
      })(d);

      tasks.push(task);
    }

    await Promise.all(tasks);

    if (signal.aborted) throw this.recordCancellation(signal);

    if (dispatched === 0) {
      return collector !== null ? collector.comments() : [];
    }
    if (failed > 0 && failed === dispatched) {
      const reused = this.resumeInfo?.reusedFiles ?? 0;
      if (reused === 0) {
        throw new Error(`all ${dispatched} file review(s) failed — check your LLM configuration and API key`);
      }
    }

    if (collector !== null) return collector.comments();
    return [];
  }

  private async executeSubtask(
    signal: AbortSignal,
    dRaw: Diff | unknown,
  ): Promise<{ completed: boolean; stop?: { class: FailureClass; reason: string; checkpoint: string; reportAsError?: boolean }; error: Error | null }> {
    const d = normalizeDiff(dRaw);
    if (signal.aborted) {
      const reason = (signal as AbortSignal & { reason?: unknown }).reason;
      const err = reason instanceof Error ? reason : (reason !== undefined ? new Error(String(reason)) : new Error("context canceled"));
      // Ensure the error is recognizable as cancelled via errors.Is
      if (err.name !== "AbortError" && !err.message.includes("canceled") && !err.message.includes("cancelled")) {
        err.name = "AbortError";
      }
      return { completed: false, error: err };
    }

    const newPath = d.newPath;
    const changeFilesExcludingCurrent = this.buildChangeFilesExcept(newPath);
    const rule = this.resolveSystemRule(newPath.toLowerCase());
    const threshold = this.args.template.PlanModeLineThreshold ?? 0;
    const changeLines = d.insertions + d.deletions;

    // Phase 1: Plan (skip when below threshold)
    let planResult = "";
    const planTask = this.args.template.PlanTask;
    const hasPlan = planTask !== undefined && planTask.messages.length > 0;
    const shouldSkipPlan = hasPlan && threshold > 0 && changeLines < threshold;
    if (shouldSkipPlan) {
      console.error(`[pi-review] Skipping plan phase for ${newPath} (${changeLines} lines < threshold ${threshold})`);
    } else if (hasPlan) {
      try {
        planResult = await this.executePlanPhase(signal, newPath, d.diff, changeFilesExcludingCurrent, rule);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[pi-review] Plan phase failed for ${newPath}: ${msg} (continuing without plan)`);
        planResult = "";
      }
    }

    // Phase 2: Main task loop — build messages from template
    const mainTask = this.args.template.MainTask;
    if (mainTask.messages.length === 0) {
      return { completed: false, error: errMainTaskEmpty };
    }

    const messages: ChatMessage[] = mainTask.messages.map((m) => {
      let content: string = m.content;
      content = content.replaceAll("{{current_system_date_time}}", this.currentDate);
      content = content.replaceAll("{{current_file_path}}", newPath);
      content = content.replaceAll("{{system_rule}}", rule);
      content = content.replaceAll("{{change_files}}", changeFilesExcludingCurrent);
      content = content.replaceAll("{{diff}}", d.diff);
      content = content.replaceAll("{{requirement_background}}", this.args.background ?? "");
      if (planResult === "") {
        content = stripEmptyPlanBlock(content);
      }
      content = content.replaceAll("{{plan_guidance}}", planResult);
      return { role: m.role, content };
    });

    // Token threshold pre-check (80% of max_tokens)
    const maxAllowed = this.args.template.MaxTokens;
    const tokenLimit = PromptTokenLimit(maxAllowed);
    // Count tokens via the compression helper (byte/4 fallback)
    let tokenCount = 0;
    for (const msg of messages) tokenCount += countTokens(msg.content);
    if (tokenCount > tokenLimit) {
      const msg = `prompt tokens (${tokenCount}) exceed 80% of max_tokens(${maxAllowed})`;
      console.error(`[pi-review] WARNING: ${msg} for ${newPath}`);
      this.warnings.push({ type: "token_threshold_exceeded", file: newPath, message: msg });
      try { this.runner.RecordWarning("token_threshold_exceeded", newPath, msg); } catch {}
      return { completed: false, stop: { class: FailureBudget, reason: "prompt exceeded the configured token budget", checkpoint: msg }, error: null };
    }

    // Delegate to llmloop Runner
    // Runner expects Message[] shape from compression.ts; ChatMessage is compatible (role/content).
    const runnerMessages = messages as unknown as import("../llmloop/compression.js").Message[];
    let completed = false;
    let stop: { class: FailureClass; reason: string; checkpoint: string; reportAsError?: boolean } | undefined;
    try {
      const res = await this.runner.RunPerFile(signal, runnerMessages, newPath);
      completed = res.completed;
      if (res.error !== undefined) {
        return { completed: false, error: res.error };
      }
      if (!completed) {
        const [classification, reason] = classifyMainLoopStop(res.stop as MainLoopStop);
        stop = { class: classification, reason, checkpoint: "main_task did not complete before stopping", reportAsError: true };
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return { completed: false, error: e };
    }

    if (completed) {
      try {
        if (this.commentWorkerPool) {
          await this.commentWorkerPool.AwaitKey(newPath);
        }
      } catch {}
      await this.executeReviewFilter(signal, d, newPath);
    }

    if (!completed && stop === undefined) {
      stop = { class: FailureUnknown, reason: "main task stopped before completing", checkpoint: "main_task did not complete before stopping", reportAsError: true };
    }

    if (!completed) {
      return { completed: false, stop, error: null };
    }
    return { completed: true, error: null };
  }

  private async executePlanPhase(
    signal: AbortSignal,
    newPath: string,
    rawDiff: string,
    changeFiles: string,
    rule: string,
  ): Promise<string> {
    const pt = this.args.template.PlanTask;
    if (pt === undefined || pt === null) return "";
    const msgs: ChatMessage[] = pt.messages.map((m) => {
      let content = m.content;
      content = content.replaceAll("{{current_system_date_time}}", this.currentDate);
      content = content.replaceAll("{{current_file_path}}", newPath);
      content = content.replaceAll("{{system_rule}}", rule);
      content = content.replaceAll("{{change_files}}", changeFiles);
      content = content.replaceAll("{{diff}}", rawDiff);
      content = content.replaceAll("{{requirement_background}}", this.args.background ?? "");
      content = content.replaceAll("{{plan_tools}}", formatToolDefs(this.args.planToolDefs ?? []));
      return { role: m.role, content };
    });

    const sess = this.sessionHistory;
    let rec: import("../session/history.js").TaskRecord | undefined;
    let start = 0;
    if (sess) {
      const fs = sess.GetOrCreateFileSession(newPath);
      rec = fs.AppendTaskRecord("plan_task" as unknown as import("../session/history.js").TaskType, [...msgs] as unknown as import("../session/history.js").Message[]);
      start = Date.now();
    }
    const meta = rec ? this.newRequestMeta(newPath, "plan_task", rec.requestNo) : undefined;
    const baseSessionId = sess?.sessionId ?? this.args.sessionId ?? "";
    const sessionId = sess ? sessionTaskKey(baseSessionId, "plan_task", newPath) : baseSessionId;

    // Use llmClient directly for plan — single request, no tool loop.
    // We adapt to both shapes: llmClient.complete(signal, req) or CompletionsWithCtx.
    const client = this.args.llmClient as unknown as Record<string, unknown>;
    const req: Record<string, unknown> = {
      model: this.args.model,
      messages: msgs as unknown as import("../llmloop/compression.js").Message[],
      maxTokens: this.args.template.MaxCompletionTokens ?? this.args.template.MaxTokens,
      sessionId,
      ...(meta ? { requestMeta: meta } : {}),
    };

    let resp: unknown;
    const completionsFn = client["CompletionsWithCtx"] as ((sig: unknown, r: unknown) => Promise<unknown>) | undefined;
    const completeFn = client["complete"] as ((sig: unknown, r: unknown) => Promise<unknown>) | undefined;
    const callWithMeta = async (sig: unknown, r: Record<string, unknown>): Promise<unknown> => {
      // For Go-style clients that read RequestMeta from context, we need to pass it via a context-like object.
      // Our Fake clients in tests read via llm.RequestMetaFromContext, but Pi's transport reads from req.requestMeta.
      // To support both, we try to pass signal with attached meta if client expects context.
      // For now, just call with signal and req containing requestMeta.
      if (typeof completionsFn === "function") {
        return completionsFn.call(client, sig, r);
      }
      if (typeof completeFn === "function") {
        return completeFn.call(client, sig, r);
      }
      throw new Error("llmClient must provide complete(signal, req) or CompletionsWithCtx(signal, req)");
    };
    try {
      resp = await callWithMeta(signal, req);
    } catch (e) {
      if (rec) rec.SetError(e instanceof Error ? e : new Error(String(e)), Date.now() - start);
      throw e;
    }
    // Extract content from either Pi or Go shape
    const extract = (r: unknown): string => {
      if (r === null || r === undefined) return "";
      const obj = r as Record<string, unknown>;
      if (typeof obj["content"] === "string") return obj["content"] as string;
      if (typeof obj["Content"] === "string") return obj["Content"] as string;
      const choices = obj["Choices"] as unknown;
      if (Array.isArray(choices) && choices.length > 0) {
        const first = choices[0] as Record<string, unknown>;
        const msg = first["Message"] as Record<string, unknown> | undefined;
        if (msg !== undefined) {
          const c = msg["Content"];
          if (typeof c === "string") return c;
          if (c !== null && typeof c === "object" && typeof (c as Record<string, unknown>)["valueOf"] === "function") return String(c);
        }
      }
      // Fallback: if resp is string
      if (typeof r === "string") return r;
      return "";
    };
    const content = extract(resp);
    // Record usage if present (best-effort) — handle both usages
    const usageRaw = (resp as Record<string, unknown>)["usage"] ?? (resp as Record<string, unknown>)["Usage"];
    const usageForRec = usageRaw !== undefined && usageRaw !== null && typeof usageRaw === "object" ? (usageRaw as Record<string, unknown>) : null;
    if (usageRaw !== undefined && usageRaw !== null && typeof usageRaw === "object") {
      this.runner.RecordUsage(usageRaw as unknown as never);
    }
    if (rec) {
      const toolCallsForRec: Array<{ id: string; function: { name: string; arguments: string } }> = [];
      // Plan has no tool calls, but record content
      rec.SetResponse({ content: content ?? "", toolCalls: toolCallsForRec, model: this.args.model, usage: usageForRec ? { promptTokens: (usageForRec["PromptTokens"] as number ?? 0), completionTokens: (usageForRec["CompletionTokens"] as number ?? 0), cacheReadTokens: (usageForRec["CacheReadTokens"] as number ?? 0), cacheWriteTokens: (usageForRec["CacheWriteTokens"] as number ?? 0) } : undefined }, Date.now() - start);
    }
    console.error(`[pi-review] Plan completed for ${newPath}`);
    return content ?? "";
  }

  /**
   * executeReviewFilter runs REVIEW_FILTER_TASK to remove comments that are
   * provably incorrect based solely on diff. Errors are logged and silently ignored,
   * matching Go's behavior (filter failure keeps comments).
   * Mirrors Go Agent.executeReviewFilter.
   */
  private async executeReviewFilter(signal: AbortSignal, d: Diff, newPath: string): Promise<void> {
    const ft = this.args.template.ReviewFilterTask;
    if (!ft || ft.messages.length === 0) return;
    if (this.args.skipFilter) {
      console.error(`[pi-review] Review filter skipped for ${newPath} (--no-filter)`);
      return;
    }
    const collector = this.args.commentCollector;
    if (!collector || typeof collector.commentsForPath !== "function") return;
    const comments = collector.commentsForPath(newPath) ?? [];
    if (comments.length === 0) return;

    const commentsJSON = buildFilterCommentsJSON(comments);
    const messages: ChatMessage[] = ft.messages.map((m) => {
      let content: string = m.content;
      content = content.replaceAll("{{path}}", newPath);
      content = content.replaceAll("{{diff}}", d.diff);
      content = content.replaceAll("{{comments}}", commentsJSON);
      return { role: m.role, content };
    });

    const sessF = this.sessionHistory;
    let recF: import("../session/history.js").TaskRecord | undefined;
    let startF = 0;
    if (sessF) {
      const fsF = sessF.GetOrCreateFileSession(newPath);
      recF = fsF.AppendTaskRecord("review_filter_task" as unknown as import("../session/history.js").TaskType, [...messages] as unknown as import("../session/history.js").Message[]);
      startF = Date.now();
    }
    const metaF = recF ? this.newRequestMeta(newPath, "review_filter_task", recF.requestNo) : undefined;
    const baseSidF = sessF?.sessionId ?? this.args.sessionId ?? "";
    const sessionIdF = sessF ? sessionTaskKey(baseSidF, "review_filter_task", newPath) : baseSidF;

    const client = this.args.llmClient as unknown as Record<string, unknown>;
    const req: Record<string, unknown> = {
      model: this.args.model,
      messages: messages as unknown as import("../llmloop/compression.js").Message[],
      tools: REVIEW_FILTER_TOOLS,
      toolChoice: "required",
      maxTokens: this.args.template.MaxCompletionTokens ?? this.args.template.MaxTokens,
      sessionId: sessionIdF,
      ...(metaF ? { requestMeta: metaF } : {}),
    };

    let resp: unknown = null;
    const completionsFn2 = client["CompletionsWithCtx"] as ((sig: unknown, r: unknown) => Promise<unknown>) | undefined;
    const completeFn2 = client["complete"] as ((sig: unknown, r: unknown) => Promise<unknown>) | undefined;
    try {
      if (typeof completionsFn2 === "function") {
        resp = await completionsFn2.call(client, signal, req);
      } else if (typeof completeFn2 === "function") {
        resp = await completeFn2.call(client, signal, req);
      } else {
        throw new Error("llmClient must provide complete(signal, req) or CompletionsWithCtx(signal, req)");
      }
    } catch (err) {
      if (recF) recF.SetError(err instanceof Error ? err : new Error(String(err)), Date.now() - startF);
      console.error(`[pi-review] Review filter failed for ${newPath}: ${String((err as Error).message)}`);
      return;
    }
    if (!resp) {
      if (recF) recF.SetError(new Error("empty response"), Date.now() - startF);
      return;
    }
    const usage2 = (resp as Record<string, unknown>)["usage"] ?? (resp as Record<string, unknown>)["Usage"];
    if (usage2 !== null && usage2 !== undefined && typeof usage2 === "object") {
      try { this.runner.RecordUsage(usage2 as unknown as never); } catch {}
    }
    if (recF) {
      const rawForRec = (resp as Record<string, unknown>)["content"] as string | undefined ?? (resp as Record<string, unknown>)["Content"] as string | undefined ?? "";
      const usageForRec = usage2 as unknown as { PromptTokens?: number; CompletionTokens?: number; promptTokens?: number; completionTokens?: number } | undefined;
      const promptT = (usageForRec as unknown as { PromptTokens?: number; promptTokens?: number })?.PromptTokens ?? (usageForRec as unknown as { promptTokens?: number })?.promptTokens ?? 0;
      const completionT = (usageForRec as unknown as { CompletionTokens?: number; completionTokens?: number })?.CompletionTokens ?? (usageForRec as unknown as { completionTokens?: number })?.completionTokens ?? 0;
      recF.SetResponse({ content: typeof rawForRec === "string" ? rawForRec : "", toolCalls: extractFilterToolCalls(resp), model: this.args.model, usage: { promptTokens: promptT, completionTokens: completionT } }, Date.now() - startF);
    }
    const extract2 = (r: unknown): string => {
      const obj = r as Record<string, unknown>;
      if (typeof obj["content"] === "string") return obj["content"] as string;
      if (typeof obj["Content"] === "string") return obj["Content"] as string;
      const choices = obj["Choices"] as unknown;
      if (Array.isArray(choices) && choices.length > 0) {
        const first = choices[0] as Record<string, unknown>;
        const msg = first["Message"] as Record<string, unknown> | undefined;
        if (msg !== undefined) {
          const c = msg["Content"];
          if (typeof c === "string") return c;
        }
      }
      return "";
    };
    const rawContent = extract2(resp);
    const toolIndices = parseFilterToolCalls(extractFilterToolCalls(resp), comments.length);
    const indices = toolIndices ?? parseFilterResponse(rawContent, comments.length);
    if (!indices || indices.size === 0) return;
    try {
      if (typeof collector.removeByPathAndIndices === "function") {
        collector.removeByPathAndIndices(newPath, indices);
      } else {
        const anyC = collector as unknown as { RemoveByPathAndIndices?: (path: string, indices: Map<number, unknown>) => void };
        if (typeof anyC.RemoveByPathAndIndices === "function") anyC.RemoveByPathAndIndices(newPath, indices);
      }
      console.error(`[pi-review] Review filter removed ${indices.size} comment(s) for ${newPath}`);
    } catch (err) {
      console.error(`[pi-review] Review filter removal failed for ${newPath}: ${String((err as Error).message)}`);
    }
  }

}

function extractFilterToolCalls(response: unknown): import("../llmloop/compression.js").ToolCall[] {
  if (response === null || typeof response !== "object") return [];
  const root = response as Record<string, unknown>;
  const candidate = root["toolCalls"] ?? root["ToolCalls"]
    ?? (Array.isArray(root["Choices"]) ? ((root["Choices"][0] as Record<string, unknown> | undefined)?.["Message"] as Record<string, unknown> | undefined)?.["ToolCalls"] : undefined);
  if (!Array.isArray(candidate)) return [];
  const calls: import("../llmloop/compression.js").ToolCall[] = [];
  for (const value of candidate) {
    if (value === null || typeof value !== "object") continue;
    const call = value as Record<string, unknown>;
    const functionValue = call["function"] ?? call["Function"];
    if (functionValue === null || typeof functionValue !== "object") continue;
    const fn = functionValue as Record<string, unknown>;
    const name = fn["name"] ?? fn["Name"];
    const argumentsText = fn["arguments"] ?? fn["Arguments"];
    if (typeof name !== "string" || typeof argumentsText !== "string") continue;
    calls.push({ id: typeof call["id"] === "string" ? call["id"] : typeof call["ID"] === "string" ? call["ID"] : "", type: typeof call["type"] === "string" ? call["type"] : "function", function: { name, arguments: argumentsText } });
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Minimal in-memory collector used when none is supplied
// ---------------------------------------------------------------------------

function createInMemoryCollector(): CommentCollectorLike {
  const store: LlmComment[] = [];
  return {
    add(c: LlmComment): void {
      store.push(c);
    },
    comments(): LlmComment[] {
      return [...store];
    },
    commentsForPath(path: string): LlmComment[] {
      return store.filter((c) => c.path === path);
    },
  };
}

export function newAgent(args: Args): Agent {
  return new Agent(args);
}

export const New = newAgent;

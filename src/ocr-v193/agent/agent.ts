// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/agent.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
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
import { effectivePath, whyExcluded } from "./preview.js";
import { reviewModeString, stripEmptyPlanBlock } from "./util.js";
import { countTokens, PromptTokenLimit, StripMarkdownFences } from "../llmloop/compression.js";
import { Runner } from "../llmloop/loop.js";
import type { AnyLlmClient, ToolDef } from "../llmloop/types.js";
import type { Template, ChatMessage } from "../template/template.js";
import type { FileFilter } from "../rules/system_rules.js";
import { CommentWorkerPool } from "../llmloop/pool.js";

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
  // Mirrors session.ItemID(session.OperationReview, mode, oldPath, newPath)
  // Simplified: operation "review" is fixed for this agent.
  return `review:${mode}:${oldPath}:${newPath}`;
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

const errMainTaskEmpty = new Error("main_task.messages is empty in template");

export class Agent {
  private diffs: Diff[] = [];
  private totalInsertions = 0;
  private totalDeletions = 0;
  private currentDate: string;
  private budgetExceeded = false;
  private runner: Runner;
  private inputResolution: InputResolution = { resolvedBase: "", resolvedHead: "", exactRange: "" };
  private repoRemoteIdentity = "";
  private warnings: Array<{ type: string; file: string; message: string }> = [];

  // Public for test harness to observe pool draining behavior if needed
  public readonly commentWorkerPool: CommentWorkerPool;

  constructor(private readonly args: Args) {
    this.currentDate = new Date().toISOString().slice(0, 16).replace("T", " ");
    // Build runner with LlmTransport seam — mirrors Go llmloop.NewRunner.
    const commentCollector = (args.commentCollector ?? createInMemoryCollector()) as unknown as CommentCollectorLike;
    const mainToolDefs = args.mainToolDefs ?? [];
    const toolRegistry = (args.tools ?? null) as unknown as ToolRegistryLike | null;
    // CommentWorkerPool: 8 workers, per-file isolation via AwaitKey (mirrors Go NewCommentWorkerPool(8))
    this.commentWorkerPool = new CommentWorkerPool(8);

    // DiffLookup: resolve path -> Diff for relocation (mirrors Go Deps.DiffLookup)
    const diffLookup = (path: string): Diff | null => {
      for (const dd of this.diffs) {
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
      model: args.model,
      template: templateForRunner as unknown as import("../llmloop/types.js").Template,
      llmClient: args.llmClient,
      mainToolDefs: mainToolDefs as unknown as readonly ToolDef[],
      commentCollector: commentCollector as unknown as never,
      toolRegistry: toolRegistry as unknown as never,
      diffLookup: diffLookup as unknown as never,
      commentWorkerPool: this.commentWorkerPool as unknown as never,
    });
  }

  // -- public getters mirroring Go

  sessionId(): string {
    // Stub: no persistent session in this port yet.
    return "";
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

  // -- lifecycle

  async run(signal?: AbortSignal): Promise<LlmComment[]> {
    const sig: AbortSignal = signal ?? new AbortController().signal;

    // Step 1: load diffs (with sealed input handling)
    try {
      await this.loadDiffs(sig);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      throw new Error(`load diffs: ${e.message}`);
    }

    const totalChanged = this.diffs.length;
    const reviewCount = this.countReviewable(this.diffs);
    // Emit progress to stderr so stdout stays machine-readable.
    console.error(`[ocr] ${totalChanged} file(s) changed, reviewing ${reviewCount} in ${this.args.repoDir}`);

    // Build diff map for file_read_diff tool if present (best-effort, no error if absent)
    this.injectDiffMap();

    this.diffs = this.filterDiffs(this.diffs);

    if (this.diffs.length === 0) {
      console.error("[ocr] No supported files changed. Skipping review.");
      return [];
    }

    this.currentDate = new Date().toISOString().replace("T", " ").slice(0, 16);

    if ((this.args.maxTokensBudget ?? 0) > 0) {
      const est = estimateDiffCost(this.diffs);
      console.error(`[ocr] estimated cost: ${est.totalTokens} tokens`);
      console.error(`[ocr] token budget: ${humanTokens(this.args.maxTokensBudget!)} (dispatch stops once exceeded)`);
      if (est.totalTokens > (this.args.maxTokensBudget ?? 0)) {
        console.error(`[ocr] WARNING: estimate (${humanTokens(est.totalTokens)}) exceeds token budget (${humanTokens(this.args.maxTokensBudget!)})`);
      }
    }

    // Step 2: dispatch per-file subtasks concurrently
    const comments = await this.dispatchSubtasks(sig);
    await this.runner.WaitBackground().catch(() => undefined);
    return comments;
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
      const prov = getter.call(tools, "file_read_diff") as { setDiffMap?: (m: unknown) => void } | undefined;
      if (prov !== undefined && prov !== null && typeof prov.setDiffMap === "function") {
        const m = new Map<string, string>();
        for (const d of this.diffs) {
          if (d.newPath !== "/dev/null") m.set(d.newPath, d.diff);
        }
        // The real DiffMap class wraps a Map; for the stub we pass a simple object with get().
        const dm = {
          get: (p: string): string | undefined => m.get(p),
        };
        prov.setDiffMap(dm);
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

  private countReviewable(diffs: readonly Diff[]): number {
    let n = 0;
    for (const d of diffs) {
      if (!this.shouldReview(d)) continue;
      if (d.isDeleted) continue;
      n++;
    }
    return n;
  }

  private shouldReview(d: Diff): boolean {
    return whyExcluded(d, this.args.fileFilter ?? null) === "";
  }

  private filterDiffs(diffs: Diff[]): Diff[] {
    const kept: Diff[] = [];
    let skipped = 0;
    for (const d of diffs) {
      const path = effectivePath(d);
      if (!this.shouldReview(d)) {
        if (d.isBinary) console.error(`[ocr] Skipping ${path} — binary file`);
        else console.error(`[ocr] Skipping ${path} — filtered by path/extension rules`);
        skipped++;
        continue;
      }
      kept.push(d);
    }
    if (skipped > 0) console.error(`[ocr] Filtered ${skipped} file(s) by include/exclude rules`);
    return kept;
  }

  private filterLargeDiffs(diffs: Diff[]): Diff[] {
    const limit = PromptTokenLimit(this.args.template.MaxTokens);
    if (limit <= 0) return diffs;
    const kept: Diff[] = [];
    let skipped = 0;
    for (const d of diffs) {
      const tokens = countTokens(d.diff);
      if (tokens > limit) {
        console.error(`[ocr] Skipping ${d.newPath} (~${tokens} tokens exceeds 80% of max_tokens(${this.args.template.MaxTokens}))`);
        skipped++;
        continue;
      }
      kept.push(d);
    }
    if (skipped > 0) console.error(`[ocr] Pre-filtered ${skipped} file(s) exceeding 80% of max_tokens`);
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

  private buildChangeFilesExcept(excludePath: string): string {
    const lines: string[] = [];
    for (const d of this.diffs) {
      if (d.isBinary) continue;
      if (d.newPath === excludePath || d.oldPath === excludePath) continue;
      let status = "MODIFIED";
      if (d.isNew) status = "ADDED";
      else if (d.isDeleted) status = "DELETED";
      else if (d.oldPath !== d.newPath) status = "RENAMED";
      lines.push(`${status}   ${d.newPath}`);
    }
    return lines.join("\n");
  }

  private async dispatchSubtasks(signal: AbortSignal): Promise<LlmComment[]> {
    // Pre-filter large diffs
    this.diffs = this.filterLargeDiffs(this.diffs);
    if (this.diffs.length === 0) {
      console.error("[ocr] All changed files exceeded the token size limit. Skipping review.");
      return [];
    }

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

    for (const d of this.diffs) {
      if (d.isDeleted) continue;
      if (signal.aborted) break;

      if (maxBudget > 0) {
        const used = this.runner.TotalTokensUsed();
        const nextEst = estimateDiffFileTokens(d);
        const projected = used + nextEst;
        if (projected > maxBudget) {
          console.error(
            `[ocr] token budget reached (used ${humanTokens(used)} + next-file est ${humanTokens(nextEst)} = projected ${humanTokens(projected)} > budget ${humanTokens(maxBudget)}) — skipping ${d.newPath} and remaining files`,
          );
          this.warnings.push({
            type: "token_budget_reached",
            file: d.newPath,
            message: `stopped dispatch: used ${used} tokens + next-file estimate ${nextEst} = projected ${projected} exceeds budget ${maxBudget}`,
          });
          this.budgetExceeded = true;
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
            cleanup();
            if (!result.completed && result.error !== null) {
              failed++;
              this.warnings.push({ type: "subtask_error", file: diff.newPath, message: result.error.message });
              console.error(`[ocr] Subtask error for ${diff.newPath}: ${result.error.message}`);
            } else if (!result.completed && result.stop !== undefined) {
              // Non-error stop — still record as budget/unknown but not necessarily error
              if (result.stop === "budget_exceeded") {
                this.warnings.push({ type: "subtask_stop", file: diff.newPath, message: "stopped: budget exceeded" });
              }
            }
          } catch (err) {
            cleanup();
            failed++;
            const msg = err instanceof Error ? err.message : String(err);
            this.warnings.push({ type: "subtask_error", file: diff.newPath, message: msg });
            console.error(`[ocr] Subtask panic for ${diff.newPath}: ${msg}`);
          } finally {
            sem.release();
          }
          return;
        }

        try {
          const result = await this.executeSubtask(taskSignal, diff);
          if (!result.completed && result.error !== null) {
            failed++;
            this.warnings.push({ type: "subtask_error", file: diff.newPath, message: result.error.message });
            console.error(`[ocr] Subtask error for ${diff.newPath}: ${result.error.message}`);
          }
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          this.warnings.push({ type: "subtask_error", file: diff.newPath, message: msg });
          console.error(`[ocr] Subtask panic for ${diff.newPath}: ${msg}`);
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
          sem.release();
        }
      })(d);

      tasks.push(task);
    }

    await Promise.all(tasks);

    if (signal.aborted) {
      const reason = (signal as AbortSignal & { reason?: unknown }).reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? "aborted");
      throw new Error(msg);
    }

    if (dispatched === 0) {
      return collector !== null ? collector.comments() : [];
    }
    if (failed > 0 && failed === dispatched) {
      throw new Error(`all ${dispatched} file review(s) failed — check your LLM configuration and API key`);
    }

    if (collector !== null) return collector.comments();
    return [];
  }

  private async executeSubtask(
    signal: AbortSignal,
    d: Diff,
  ): Promise<{ completed: boolean; stop?: string; error: Error | null }> {
    if (signal.aborted) {
      const reason = (signal as AbortSignal & { reason?: unknown }).reason;
      return { completed: false, error: reason instanceof Error ? reason : new Error(String(reason ?? "aborted")) };
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
      console.error(`[ocr] Skipping plan phase for ${newPath} (${changeLines} lines < threshold ${threshold})`);
    } else if (hasPlan) {
      try {
        planResult = await this.executePlanPhase(signal, newPath, d.diff, changeFilesExcludingCurrent, rule);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ocr] Plan phase failed for ${newPath}: ${msg} (continuing without plan)`);
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
      console.error(`[ocr] WARNING: ${msg} for ${newPath}`);
      this.warnings.push({ type: "token_threshold_exceeded", file: newPath, message: msg });
      return { completed: false, stop: "budget_exceeded", error: null };
    }

    // Delegate to llmloop Runner
    // Runner expects Message[] shape from compression.ts; ChatMessage is compatible (role/content).
    const runnerMessages = messages as unknown as import("../llmloop/compression.js").Message[];
    let completed = false;
    let stop: string | undefined;
    try {
      const res = await this.runner.RunPerFile(signal, runnerMessages, newPath);
      completed = res.completed;
      // Map MainLoopStop to string for caller
      if (!completed) {
        if (res.stop === 1) stop = "budget_exceeded";
        else if (res.stop === 2) stop = "empty_rounds";
        else if (res.stop === 3) stop = "compression";
        else stop = "max_rounds";
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return { completed: false, error: e };
    }

    if (completed) {
      // Drain per-file async comment workers before filtering, mirroring Go's AwaitKey(newPath)
      // This must be keyed to newPath to avoid racing with other files' Submit calls.
      try {
        if (this.commentWorkerPool) {
          await this.commentWorkerPool.AwaitKey(newPath);
        }
      } catch {
        // best-effort
      }
      await this.executeReviewFilter(signal, d, newPath);
    }

    if (!completed && stop === undefined) {
      // Treat as budget unknown catch-all per Go classifyMainLoopStop
      stop = "unknown";
    }

    if (!completed) {
      return { completed: false, stop: stop ?? "unknown", error: null };
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

    // Use llmClient directly for plan — single request, no tool loop.
    // We adapt to both shapes: llmClient.complete(signal, req) or CompletionsWithCtx.
    const client = this.args.llmClient as unknown as Record<string, unknown>;
    const req = {
      model: this.args.model,
      messages: msgs as unknown as import("../llmloop/compression.js").Message[],
      maxTokens: this.args.template.MaxCompletionTokens ?? this.args.template.MaxTokens,
    };

    let resp: { content: string };
    const completionsFn = client["CompletionsWithCtx"] as ((sig: AbortSignal, r: unknown) => Promise<{ content: string }>) | undefined;
    const completeFn = client["complete"] as ((sig: AbortSignal, r: unknown) => Promise<{ content: string }>) | undefined;
    if (typeof completionsFn === "function") {
      resp = await completionsFn.call(client, signal, req);
    } else if (typeof completeFn === "function") {
      resp = await completeFn.call(client, signal, req);
    } else {
      throw new Error("llmClient must provide complete(signal, req) or CompletionsWithCtx(signal, req)");
    }

    // Record usage if present (best-effort)
    const usage = (resp as unknown as { usage?: { PromptTokens?: number; CompletionTokens?: number } }).usage;
    if (usage !== undefined) {
      this.runner.RecordUsage(usage as unknown as never);
    }

    console.error(`[ocr] Plan completed for ${newPath}`);
    return resp.content ?? "";
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
      console.error(`[ocr] Review filter skipped for ${newPath} (--no-filter)`);
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

    const client = this.args.llmClient as unknown as Record<string, unknown>;
    const req = {
      model: this.args.model,
      messages: messages as unknown as import("../llmloop/compression.js").Message[],
      maxTokens: this.args.template.MaxCompletionTokens ?? this.args.template.MaxTokens,
    };

    let resp: { content: string; usage?: unknown } | null = null;
    const completionsFn = client["CompletionsWithCtx"] as ((sig: AbortSignal, r: unknown) => Promise<{ content: string; usage?: unknown }>) | undefined;
    const completeFn = client["complete"] as ((sig: AbortSignal, r: unknown) => Promise<{ content: string; usage?: unknown }>) | undefined;
    try {
      if (typeof completionsFn === "function") {
        resp = await completionsFn.call(client, signal, req);
      } else if (typeof completeFn === "function") {
        resp = await completeFn.call(client, signal, req);
      } else {
        throw new Error("llmClient must provide complete(signal, req) or CompletionsWithCtx(signal, req)");
      }
    } catch (err) {
      console.error(`[ocr] Review filter failed for ${newPath}: ${String((err as Error).message)}`);
      return;
    }
    if (!resp) return;
    const usage = (resp as unknown as { usage?: { PromptTokens?: number; CompletionTokens?: number; CacheReadTokens?: number; CacheWriteTokens?: number } }).usage;
    if (usage) {
      try {
        this.runner.RecordUsage(usage as unknown as never);
      } catch {}
    }
    const rawContent = (resp as unknown as { content?: string }).content ?? (resp as unknown as { Content?: string }).Content ?? "";
    const indices = parseFilterResponse(rawContent, comments.length);
    if (!indices || indices.size === 0) return;
    try {
      if (typeof collector.removeByPathAndIndices === "function") {
        collector.removeByPathAndIndices(newPath, indices);
      } else {
        const anyC = collector as unknown as { RemoveByPathAndIndices?: (path: string, indices: Map<number, unknown>) => void };
        if (typeof anyC.RemoveByPathAndIndices === "function") anyC.RemoveByPathAndIndices(newPath, indices);
      }
      console.error(`[ocr] Review filter removed ${indices.size} comment(s) for ${newPath}`);
    } catch (err) {
      console.error(`[ocr] Review filter removal failed for ${newPath}: ${String((err as Error).message)}`);
    }
  }

}

// ---------------------------------------------------------------------------
// Review filter — mirrors Go executeReviewFilter + buildFilterCommentsJSON + parseFilterResponse
// ---------------------------------------------------------------------------

function buildFilterCommentsJSON(comments: LlmComment[]): string {
  type FilterComment = { id: string; content: string; existing_code?: string };
  const items: FilterComment[] = comments.map((cm, i) => ({
    id: `c-${i}`,
    content: cm.content,
    ...(cm.existingCode ? { existing_code: cm.existingCode } : {}),
  }));
  return JSON.stringify(items);
}

function parseFilterResponse(raw: string, total: number): Map<number, unknown> | null {
  const cleaned = StripMarkdownFences(raw);
  let ids: unknown;
  try {
    ids = JSON.parse(cleaned);
  } catch (err) {
    const preview = cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
    console.error(`[ocr] Review filter: failed to parse LLM response: ${String((err as Error).message)}, raw: ${preview}`);
    return null;
  }
  if (!Array.isArray(ids)) {
    const preview = cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
    console.error(`[ocr] Review filter: failed to parse LLM response: expected array, raw: ${preview}`);
    return null;
  }
  const indices = new Map<number, unknown>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const m = /^c-(\d+)$/.exec(id);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue;
    indices.set(idx, {});
  }
  return indices;
}

  
// ---------------------------------------------------------------------------
// formatToolDefs — mirrors Go formatToolDefs (simplified)
// ---------------------------------------------------------------------------

function formatToolDefs(toolDefs: readonly ToolDef[]): string {
  if (toolDefs.length === 0) return "";
  let sb = "### Available Tools (reference only — do not call)\n";
  for (const td of toolDefs) {
    const fn = td.function as unknown as Record<string, unknown>;
    const name = typeof fn["name"] === "string" ? (fn["name"] as string) : "unknown";
    const desc = typeof fn["description"] === "string" ? (fn["description"] as string) : "";
    sb += `- **${name}**: ${desc}\n`;
    const params = fn["parameters"] as unknown;
    if (params !== null && params !== undefined && typeof params === "object") {
      const rec = params as Record<string, unknown>;
      const props = rec["properties"] as Record<string, unknown> | undefined;
      if (props !== undefined) {
        const required = new Set<string>(
          Array.isArray(rec["required"]) ? (rec["required"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
        );
        sb += "  Parameters:\n";
        const keys = Object.keys(props).sort();
        for (const k of keys) {
          const meta = props[k] as Record<string, unknown> | undefined;
          const desc2 = meta !== undefined && typeof meta["description"] === "string" ? (meta["description"] as string) : "";
          const suffix = required.has(k) ? " (required)" : "";
          sb += `  - ${k}: ${desc2}${suffix}\n`;
        }
      }
    }
  }
  return sb;
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

// Also export a factory matching Go New() signature helper
export function newAgent(args: Args): Agent {
  return new Agent(args);
}

export const New = newAgent;

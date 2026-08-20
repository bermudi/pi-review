// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/scan/agent.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Scan orchestrator — mirrors Go `scan.Agent` / `scan.Args`.
 *
 * Full scan implementation is intentionally stub-friendly in this port:
 * the public contract (Args, Agent surface, fingerprinting, resume
 * bookkeeping, budget checks, preview) is faithfully typed so CLI and
 * checkpoint consumers can rely on it, while the heavy per-file LLM loop
 * is stubbed behind `dispatchSubtasks` until the llmloop transport is
 * wired through the Pi adapter.
 *
 * No import from legacy `src/*` review policy.
 */

import * as crypto from "node:crypto";
import type { ScanItem } from "../model/scan.js";
import type { LlmComment } from "../model/review.js";
import type { Diff } from "../model/diff.js";
import { scanItemAsDiff } from "../model/scan.js";
import type { Preview } from "../model/preview.js";
import { ExcludeNone, ExcludeUserRule, ExcludeExtension, ExcludeDefaultPath, ExcludeBinary } from "../model/preview.js";
import type { ScanTemplate, LlmConversation, ChatMessage } from "../template/template.js";
import { Provider, NewProvider } from "./provider.js";
import { groupBatches, parseBatchStrategy, type BatchStrategy } from "./batch.js";
import { estimateCost, estimateFileTokens, humanTokens, estimateToString } from "./estimate.js";
import { previewScan } from "./preview.js";
import type { SessionHistory } from "../session/history.js";
import type { ResumeState, ResumeItem } from "../session/resume.js";
import { Runner } from "../llmloop/loop.js";
import type { AnyLlmClient, ToolDef, ToolRegistryLike, AgentWarning } from "../llmloop/types.js";
import { CommentCollector } from "../tool/collector.js";
import { CommentWorkerPool } from "../llmloop/pool.js";
import { CountMessagesTokens, PromptTokenLimit, StripMarkdownFences, countTokens } from "../llmloop/compression.js";
import { isAllowedExt, isExcludedPath } from "../rules/allowed_ext.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANGE_FILES_SCAN_LITERAL = "(not applicable in full-scan mode)";
export const changeFilesScanLiteral = CHANGE_FILES_SCAN_LITERAL;

// ---------------------------------------------------------------------------
// Args — mirrors Go scan.Args
// ---------------------------------------------------------------------------

export interface ScanArgs {
  readonly repoDir: string;
  readonly paths?: readonly string[];
  readonly template: ScanTemplate;
  readonly model?: string;
  readonly background?: string;
  readonly maxConcurrency?: number;
  readonly concurrentTaskTimeoutMinutes?: number;
  readonly maxFileSizeBytes?: number;
  readonly skipPlan?: boolean;
  readonly skipDedup?: boolean;
  readonly skipSummary?: boolean;
  readonly maxTokensBudget?: number;
  readonly session?: SessionHistory | null;
  readonly resume?: ResumeState | null;
  /** LLM transport (Pi or scripted). */
  readonly llmClient?: AnyLlmClient | null;
  /** Tool registry for file_read, code_search, file_find, file_read_diff. */
  readonly tools?: ToolRegistryLike | null;
  /** Tool definitions advertised to the model during main task. */
  readonly mainToolDefs?: readonly ToolDef[];
  /** Incremental comment collector; created if omitted. */
  readonly commentCollector?: CommentCollector | null;
  /** Async worker pool for comment relocation/filtering; created if omitted. */
  readonly commentWorkerPool?: CommentWorkerPool | null;
  // Resolver over system rules — kept as a minimal function surface
  // so scan does not import the full rules engine directly in stubs.
  readonly systemRule?: ((path: string) => string) | null;
  readonly fileFilter?: {
    isUserExcluded(path: string): boolean;
    isUserIncluded(path: string): boolean;
    hasInclude(): boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// toLoopTemplate — maps scan template onto the subset llmloop.Runner needs
// ---------------------------------------------------------------------------

function toLoopTemplate(st: ScanTemplate): Record<string, unknown> {
  const out: Record<string, unknown> = {
    MaxTokens: st.MaxTokens,
    MaxCompletionTokens: st.MaxCompletionTokens && st.MaxCompletionTokens > 0 ? st.MaxCompletionTokens : st.MaxTokens,
    MaxToolRequestTimes: st.MaxToolRequestTimes,
    MemoryCompressionTask: st.MemoryCompressionTask !== undefined
      ? { Messages: st.MemoryCompressionTask.messages.map((m) => ({ role: m.role, content: m.content })) as unknown as readonly { role: string; content: string }[] }
      : undefined,
    ReLocationTask: (st as unknown as Record<string, unknown>)["ReLocationTask"] ?? null,
  };
  if (st.ReLocationTask !== undefined && st.ReLocationTask !== null) {
    out["ReLocationTask"] = st.ReLocationTask as unknown;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agent — mirrors Go scan.Agent
// ---------------------------------------------------------------------------

export class Agent {
  readonly args: ScanArgs;
  items: ScanItem[] = [];
  currentDate: string = "";
  projectSummary: string = "";
  scanFingerprints: Map<string, string> = new Map();
  resumeInfo: { resumedFrom: string; reusedFiles: number; rerunFiles: number; previousModel?: string; currentModel?: string } | null = null;

  private runner: Runner;
  private subtaskFailed = 0;
  private commentCollector: CommentCollector;
  private commentWorkerPool: CommentWorkerPool;

  constructor(args: ScanArgs) {
    this.args = args;
    this.commentCollector = args.commentCollector ?? new CommentCollector();
    this.commentWorkerPool = args.commentWorkerPool ?? new CommentWorkerPool(args.maxConcurrency ?? 8);
    this.runner = new Runner({
      model: args.model ?? "",
      sessionId: args.session?.sessionId,
      template: toLoopTemplate(args.template) as unknown as import("../llmloop/types.js").Template,
      llmClient: args.llmClient ?? { complete: async () => ({ content: "", toolCalls: [] }) },
      mainToolDefs: args.mainToolDefs ?? [],
      commentCollector: this.commentCollector as unknown as import("../llmloop/types.js").CommentCollectorLike,
      commentWorkerPool: this.commentWorkerPool,
      toolRegistry: args.tools ?? undefined,
      diffLookup: (p: string) => this.lookupDiff(p),
    } as unknown as import("../llmloop/types.js").RunnerDeps);
  }

  // -- Simple accessors -------------------------------------------------------

  ProjectSummary(): string {
    return this.projectSummary;
  }

  SessionID(): string {
    if (!this || !(this as unknown as { args?: unknown }).args) return "";
    return (this as unknown as { args: ScanArgs }).args.session?.sessionId ?? "";
  }

  FilesReviewed(): number {
    return this.items.length;
  }

  Diffs(): Diff[] {
    return this.items.map((it) => scanItemAsDiff(it)!);
  }

  TotalTokensUsed(): number { return this.runner.TotalTokensUsed(); }
  TotalInputTokens(): number { return this.runner.TotalInputTokens(); }
  TotalOutputTokens(): number { return this.runner.TotalOutputTokens(); }
  TotalCacheReadTokens(): number { return this.runner.TotalCacheReadTokens(); }
  TotalCacheWriteTokens(): number { return this.runner.TotalCacheWriteTokens(); }
  Warnings(): AgentWarning[] { return this.runner.Warnings(); }
  ToolCalls(): Record<string, number> { return this.runner.toolCallsObject(); }
  BudgetExceeded(): boolean { return false; }
  ResumeInfo(): { resumedFrom: string; reusedFiles: number; rerunFiles: number; previousModel?: string; currentModel?: string } | null {
    if (!this || this.resumeInfo === null) return this.resumeInfo;
    return { ...this.resumeInfo };
  }
  RunManifest(): null { return null; }

  // -- Phase toggles ----------------------------------------------------------

  planEnabled(): boolean {
    const t = this.args.template;
    return (this.args.skipPlan !== true) && Boolean(t.PlanTask && t.PlanTask.messages.length > 0);
  }

  dedupEnabled(): boolean {
    const t = this.args.template;
    return (this.args.skipDedup !== true) && Boolean(t.DedupTask && t.DedupTask.messages.length > 0);
  }

  summaryEnabled(): boolean {
    const t = this.args.template;
    return (this.args.skipSummary !== true) && Boolean(t.ProjectSummaryTask && t.ProjectSummaryTask.messages.length > 0);
  }

  // -- Fingerprinting --------------------------------------------------------

  scanItemFingerprint(it: ScanItem): string {
    const cached = this.scanFingerprints.get(it.path);
    if (cached !== undefined && cached !== "") return cached;
    return scanItemFingerprint(it);
  }

  // -- Preview ---------------------------------------------------------------

  async preview(signal?: AbortSignal): Promise<Preview> {
    return previewScan(
      {
        repoDir: this.args.repoDir,
        paths: this.args.paths,
        maxFileSizeBytes: this.args.maxFileSizeBytes,
        isExcluded: (it) => this.whyExcluded(it),
      },
      signal,
    );
  }

  // -- Filter ---------------------------------------------------------------

  filterScanItems(items: readonly ScanItem[]): ScanItem[] {
    const kept: ScanItem[] = [];
    for (const it of items) {
      if (this.whyExcluded(it) === ExcludeNone) kept.push(it);
    }
    return kept;
  }

  filterLargeScans(items: readonly ScanItem[]): ScanItem[] {
    const limit = PromptTokenLimit(this.args.template.MaxTokens);
    if (limit <= 0) return [...items];
    const kept: ScanItem[] = [];
    for (const it of items) {
      const tokens = countTokens(it.content ?? "");
      if (tokens > limit) {
        console.error(`[pi-review] Skipping ${it.path} (~${tokens} tokens exceeds 80% of max_tokens(${this.args.template.MaxTokens}))`);
        continue;
      }
      kept.push(it);
    }
    if (items.length !== kept.length) {
      console.error(`[pi-review] Pre-filtered ${items.length - kept.length} file(s) exceeding 80% of max_tokens`);
    }
    return kept;
  }

  whyExcluded(it: ScanItem): string {
    if (it.isBinary === true) return ExcludeBinary;
    const p = it.path;
    if (this.args.fileFilter?.isUserExcluded(p) === true) return ExcludeUserRule;
    if (this.args.fileFilter?.hasInclude() === true && this.args.fileFilter.isUserIncluded(p) === true) return ExcludeNone;
    const ext = extFromPath(p);
    if (ext !== "" && !isAllowedExt(ext, { verifyHashes: false })) return ExcludeExtension;
    if (isExcludedPath(p, { verifyHashes: false })) return ExcludeDefaultPath;
    return ExcludeNone;
  }

  // -- Run ------------------------------------------------------------------

  async run(signal?: AbortSignal): Promise<LlmComment[]> {
    if (!this.args.template.MainTask || this.args.template.MainTask.messages.length === 0) {
      throw new Error("scan template MAIN_TASK is missing or empty");
    }

    const provider = NewProvider(
      this.args.repoDir,
      this.args.paths ?? [],
      undefined,
      this.args.maxFileSizeBytes,
    );
    const discovered = await provider.enumerate(signal);
    const beforeFilter = this.filterScanItems(discovered);
    this.items = this.filterLargeScans(beforeFilter);

    const totalDiscovered = this.items.length;
    const reviewable = this.items.length;
    console.error(`[pi-review] full-scan: ${totalDiscovered} file(s) discovered, reviewing ${reviewable} in ${this.args.repoDir}`);

    if (reviewable === 0) {
      console.error("[pi-review] No reviewable files. Skipping scan.");
      if (this.args.session) {
        await this.args.session.Finalize();
      }
      return [];
    }

    const est = estimateCost(this.items, this.planEnabled(), this.dedupEnabled(), this.summaryEnabled());
    console.error(`[pi-review] estimated cost: ${estimateToString(est)}`);
    if (this.args.maxTokensBudget && this.args.maxTokensBudget > 0) {
      console.error(`[pi-review] token budget: ${humanTokens(this.args.maxTokensBudget)} (dispatch stops once exceeded)`);
      if (est.totalTokens > this.args.maxTokensBudget) {
        console.error(`[pi-review] WARNING: estimate (${humanTokens(est.totalTokens)}) exceeds budget (${humanTokens(this.args.maxTokensBudget)}); scan will stop partway`);
      }
    }

    this.currentDate = new Date().toISOString().slice(0, 16).replace("T", " ");
    this.initScanFingerprints(this.items);
    this.initResumeInfo(this.items);

    const comments = await this.dispatchSubtasks(signal ?? new AbortController().signal);

    await this.maybeRunProjectSummary(comments);

    if (this.args.session) {
      await this.args.session.Finalize();
    }

    return comments;
  }

  /** Alias matching Go `Run`. */
  Run(signal?: AbortSignal): Promise<LlmComment[]> {
    return this.run(signal);
  }

  // -- Internal helpers ------------------------------------------------------

  private lookupDiff(p: string): Diff | null {
    return this.items.find((it) => it.path === p) ? scanItemAsDiff(this.items.find((it) => it.path === p)!) : null;
  }

  private initScanFingerprints(items: readonly ScanItem[] | null | undefined): void {
    if (!items || items.length === 0) return;
    for (const it of items) this.scanFingerprints.set(it.path, scanItemFingerprint(it));
  }

  private initResumeInfo(items: readonly ScanItem[]): void {
    const resume = this.args.resume;
    if (resume === null || resume === undefined) return;
    let reused = 0;
    let rerun = 0;
    for (const it of items) {
      const fp = this.scanItemFingerprint(it);
      if (resume.items?.has(fp) === true) reused++; else rerun++;
    }
    this.resumeInfo = {
      resumedFrom: resume.sessionId,
      reusedFiles: reused,
      rerunFiles: rerun,
      previousModel: resume.model,
      currentModel: this.args.model ?? "",
    };
  }

  private async dispatchSubtasks(signal: AbortSignal): Promise<LlmComment[]> {
    if (this.items.length === 0) return [];

    this.subtaskFailed = 0;
    this.initScanFingerprints(this.items);
    this.initResumeInfo(this.items);

    const strategy = this.resolveBatchStrategy();
    const batches = groupBatches(this.items, strategy, this.args.template.BatchSize ?? 0);
    const batchList = batches ?? [this.items];
    console.error(`[pi-review] scan dispatch: ${batchList.length} batch(es) by ${strategy} strategy`);

    for (let bi = 0; bi < batchList.length; bi++) {
      if (signal.aborted) return this.commentCollector.comments();
      const batch = batchList[bi]!;
      const batchStart = this.commentCollector.snapshot();

      const [n, budgetHit] = await this.dispatchBatch(signal, bi, batch);
      void n;

      if (this.commentWorkerPool) {
        await this.commentWorkerPool.Await();
      }

      await this.maybeRunDedup(bi, batchStart);

      if (budgetHit) break;
    }

    const failed = this.subtaskFailed;
    const dispatched = this.items.length;
    if (failed > 0 && failed === dispatched) {
      throw new Error(`all ${dispatched} file scan(s) failed — check your LLM configuration and API key`);
    }
    return this.commentCollector.comments();
  }

  private async dispatchBatch(signal: AbortSignal, batchIdx: number, batch: ScanItem[]): Promise<[number, boolean]> {
    const concurrency = this.args.maxConcurrency && this.args.maxConcurrency > 0 ? this.args.maxConcurrency : 8;
    const timeoutMs = (this.args.concurrentTaskTimeoutMinutes ?? 0) > 0 ? (this.args.concurrentTaskTimeoutMinutes ?? 0) * 60 * 1000 : 0;
    const sem = new Semaphore(concurrency);
    const tasks: Promise<void>[] = [];
    let dispatched = 0;
    let budgetHit = false;
    const completed: ScanItem[] = [];

    const recordCompleted = async (): Promise<void> => {
      if (this.commentWorkerPool) await this.commentWorkerPool.Await();
      for (const it of completed) {
        const fingerprint = this.scanItemFingerprint(it);
        const comments = this.commentCollector.commentsForPath(it.path);
        this.args.session?.RecordReviewItemDone(it.path, it.path, it.path, fingerprint, comments);
      }
    };

    for (const it of batch) {
      if (signal.aborted) break;
      const fingerprint = this.scanItemFingerprint(it);
      const resumeItem = this.resumeItem(fingerprint);
      if (resumeItem !== null) {
        for (const cm of resumeItem.comments) {
          this.commentCollector.add(cm);
        }
        this.args.session?.RecordReviewItemReused(it.path, it.path, it.path, fingerprint, this.args.resume?.sessionId ?? "", resumeItem.comments);
        continue;
      }

      if (this.args.maxTokensBudget && this.args.maxTokensBudget > 0) {
        const used = this.runner.TotalTokensUsed();
        const projected = used + estimateFileTokens(it, this.planEnabled());
        if (projected > this.args.maxTokensBudget) {
          console.error(`[pi-review] token budget reached (used ${humanTokens(used)} + next-file est ≈ ${humanTokens(projected)} > budget ${humanTokens(this.args.maxTokensBudget)}) — skipping ${it.path} and remaining files`);
          this.runner.RecordWarning("token_budget_reached", it.path, `stopped in batch #${batchIdx}: used ${used} tokens + next-file estimate exceeds budget ${this.args.maxTokensBudget}`);
          budgetHit = true;
          break;
        }
      }

      const acquired = await sem.acquire(signal, timeoutMs > 0 ? timeoutMs : undefined);
      if (!acquired) break;

      dispatched++;
      const task = (async (item: ScanItem, fp: string) => {
        let taskSignal = signal;
        let timeoutCtrl: AbortController | null = null;
        if (timeoutMs > 0) {
          timeoutCtrl = new AbortController();
          const merged = new AbortController();
          const onParent = (): void => merged.abort(signal.reason);
          const onTimeout = (): void => merged.abort(new Error("file task timeout"));
          signal.addEventListener("abort", onParent, { once: true });
          timeoutCtrl.signal.addEventListener("abort", onTimeout, { once: true });
          if (signal.aborted) merged.abort(signal.reason);
          if (timeoutCtrl.signal.aborted) merged.abort(timeoutCtrl.signal.reason);
          const t = setTimeout(() => timeoutCtrl?.abort(), timeoutMs);
          taskSignal = merged.signal;
          try {
            const result = await this.executeSubtask(taskSignal, item);
            this.handleSubtaskResult(item, fp, result, completed);
          } catch (err) {
            this.handleSubtaskError(item, fp, err, completed);
          } finally {
            clearTimeout(t);
            signal.removeEventListener("abort", onParent);
            timeoutCtrl?.signal.removeEventListener("abort", onTimeout);
          }
        } else {
          try {
            const result = await this.executeSubtask(taskSignal, item);
            this.handleSubtaskResult(item, fp, result, completed);
          } catch (err) {
            this.handleSubtaskError(item, fp, err, completed);
          }
        }
        sem.release();
      })(it, fingerprint);

      tasks.push(task);
    }

    await Promise.all(tasks);
    await recordCompleted();
    return [dispatched, budgetHit];
  }

  private handleSubtaskResult(it: ScanItem, fingerprint: string, result: { completed: boolean; stop?: string; error: Error | null }, completed: ScanItem[]): void {
    if (result.completed) {
      completed.push(it);
    } else if (result.error !== null) {
      this.subtaskFailed++;
      this.args.session?.RecordReviewItemFailed(it.path, it.path, it.path, fingerprint, result.error.message);
      console.error(`[pi-review] Scan subtask error for ${it.path}: ${result.error.message}`);
      this.runner.RecordWarning("scan_subtask_error", it.path, result.error.message);
    } else if (result.stop) {
      this.subtaskFailed++;
      const checkpoint = result.stop === "token_threshold_exceeded" ? `prompt tokens exceed 80% of max_tokens(${this.args.template.MaxTokens})` : "main_task did not complete before stopping";
      this.args.session?.RecordReviewItemFailed(it.path, it.path, it.path, fingerprint, checkpoint);
      this.runner.RecordWarning("scan_subtask_error", it.path, checkpoint);
    }
  }

  private handleSubtaskError(it: ScanItem, fingerprint: string, err: unknown, _completed: ScanItem[]): void {
    this.subtaskFailed++;
    const msg = err instanceof Error ? err.message : String(err);
    this.args.session?.RecordReviewItemFailed(it.path, it.path, it.path, fingerprint, msg);
    console.error(`[pi-review] Scan subtask error for ${it.path}: ${msg}`);
    this.runner.RecordWarning("scan_subtask_error", it.path, msg);
  }

  private async executeSubtask(signal: AbortSignal, it: ScanItem): Promise<{ completed: boolean; stop?: string; error: Error | null }> {
    if (signal.aborted) return { completed: false, error: new Error(String((signal as AbortSignal & { reason?: unknown }).reason ?? "aborted")) };

    const rule = this.args.systemRule ? this.args.systemRule(it.path.toLowerCase()) : "";
    const planGuidance = await this.maybeRunPlan(signal, it, rule);
    const messages = this.renderMessages(it, rule, planGuidance);

    const tokenCount = CountMessagesTokens(messages as { role: string; content: string }[]);
    const maxAllowed = this.args.template.MaxTokens;
    const tokenLimit = PromptTokenLimit(maxAllowed);
    if (tokenCount > tokenLimit) {
      const msg = `prompt tokens (${tokenCount}) exceed 80% of max_tokens(${maxAllowed})`;
      console.error(`[pi-review] WARNING: ${msg} for ${it.path}`);
      this.runner.RecordWarning("token_threshold_exceeded", it.path, msg);
      return { completed: false, stop: "token_threshold_exceeded", error: null };
    }

    try {
      const res = await this.runner.RunPerFile(signal, messages as { role: string; content: string }[], it.path);
      if (!res.completed) {
        return { completed: false, stop: this.classifyStop(res.stop), error: null };
      }
      return { completed: true, error: null };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return { completed: false, error: e };
    }
  }

  private classifyStop(stop: number): string {
    switch (stop) {
      case 1: return "budget_exceeded";
      case 2: return "empty_rounds";
      case 3: return "compression";
      default: return "max_rounds";
    }
  }

  private async maybeRunPlan(signal: AbortSignal, it: ScanItem, rule: string): Promise<string> {
    const noPlan = "(no pre-scan plan; review the entire file as usual)";
    if (!this.planEnabled()) return noPlan;

    const pt = this.args.template.PlanTask!;
    const messages: ChatMessage[] = pt.messages.map((m) => ({
      role: m.role,
      content: m.content
        .replaceAll("{{current_system_date_time}}", this.currentDate)
        .replaceAll("{{current_file_path}}", it.path)
        .replaceAll("{{system_rule}}", rule)
        .replaceAll("{{file_content}}", it.content ?? "")
        .replaceAll("{{requirement_background}}", this.args.background ?? ""),
    }));

    const client = this.args.llmClient as unknown as Record<string, unknown>;
    const req = {
      model: this.args.model ?? "",
      messages: messages as unknown as import("../llmloop/compression.js").Message[],
      maxTokens: this.args.template.MaxCompletionTokens && this.args.template.MaxCompletionTokens > 0 ? this.args.template.MaxCompletionTokens : this.args.template.MaxTokens,
    };

    try {
      const goFn = client["CompletionsWithCtx"];
      const completeFn = client["complete"];
      let resp: { content: string; usage?: unknown };
      if (typeof goFn === "function") {
        resp = await (goFn as (s: AbortSignal, r: unknown) => Promise<{ content: string; usage?: unknown }>).call(client, signal, req);
      } else if (typeof completeFn === "function") {
        resp = await (completeFn as (s: AbortSignal, r: unknown) => Promise<{ content: string; usage?: unknown }>).call(client, signal, req);
      } else {
        throw new Error("llmClient must provide complete or CompletionsWithCtx");
      }
      if (resp.usage) this.runner.RecordUsage(resp.usage as never);
      const guidance = formatPlanGuidance(resp.content ?? "");
      return guidance === "" ? noPlan : guidance;
    } catch (err) {
      console.error(`[pi-review] scan plan failed for ${it.path}: ${err instanceof Error ? err.message : String(err)} (falling back to plan-less)`);
      return noPlan;
    }
  }

  private async maybeRunProjectSummary(comments: LlmComment[]): Promise<void> {
    if (!this.summaryEnabled()) return;
    if (comments.length === 0) return;
    const pt = this.args.template.ProjectSummaryTask!;

    const fileSet = new Set(comments.map((c) => c.path));
    const payload = buildSummaryCommentsList(comments);
    const messages: ChatMessage[] = pt.messages.map((m) => ({
      role: m.role,
      content: m.content
        .replaceAll("{{comment_count}}", String(comments.length))
        .replaceAll("{{file_count}}", String(fileSet.size))
        .replaceAll("{{all_comments}}", payload),
    }));

    const client = this.args.llmClient as unknown as Record<string, unknown>;
    const req = {
      model: this.args.model ?? "",
      messages: messages as unknown as import("../llmloop/compression.js").Message[],
      maxTokens: this.args.template.MaxCompletionTokens && this.args.template.MaxCompletionTokens > 0 ? this.args.template.MaxCompletionTokens : this.args.template.MaxTokens,
    };

    try {
      const goFn = client["CompletionsWithCtx"];
      const completeFn = client["complete"];
      let resp: { content: string; usage?: unknown };
      if (typeof goFn === "function") {
        resp = await (goFn as (s: AbortSignal, r: unknown) => Promise<{ content: string; usage?: unknown }>).call(client, undefined as unknown as AbortSignal, req);
      } else if (typeof completeFn === "function") {
        resp = await (completeFn as (s: AbortSignal, r: unknown) => Promise<{ content: string; usage?: unknown }>).call(client, undefined as unknown as AbortSignal, req);
      } else {
        throw new Error("llmClient must provide complete or CompletionsWithCtx");
      }
      if (resp.usage) this.runner.RecordUsage(resp.usage as never);
      const body = (resp.content ?? "").trim();
      if (body === "") return;
      this.projectSummary = StripMarkdownFences(body);
    } catch (err) {
      console.error(`[pi-review] scan project summary failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async maybeRunDedup(batchIdx: number, batchStart: number): Promise<void> {
    if (!this.dedupEnabled()) return;
    const dt = this.args.template.DedupTask!;
    const minN = this.args.template.DedupMinComments ?? 2;
    const batchComments = this.commentCollector.since(batchStart);
    if (!batchComments || batchComments.length < minN) return;

    const payload = buildDedupCommentsJSON(batchComments);
    const messages: ChatMessage[] = dt.messages.map((m) => ({
      role: m.role,
      content: m.content.replaceAll("{{batch_comments}}", payload),
    }));

    const client = this.args.llmClient as unknown as Record<string, unknown>;
    const req = {
      model: this.args.model ?? "",
      messages: messages as unknown as import("../llmloop/compression.js").Message[],
      maxTokens: this.args.template.MaxCompletionTokens && this.args.template.MaxCompletionTokens > 0 ? this.args.template.MaxCompletionTokens : this.args.template.MaxTokens,
    };

    try {
      const goFn = client["CompletionsWithCtx"];
      const completeFn = client["complete"];
      let resp: { content: string; usage?: unknown };
      if (typeof goFn === "function") {
        resp = await (goFn as (s: AbortSignal, r: unknown) => Promise<{ content: string; usage?: unknown }>).call(client, undefined as unknown as AbortSignal, req);
      } else if (typeof completeFn === "function") {
        resp = await (completeFn as (s: AbortSignal, r: unknown) => Promise<{ content: string; usage?: unknown }>).call(client, undefined as unknown as AbortSignal, req);
      } else {
        throw new Error("llmClient must provide complete or CompletionsWithCtx");
      }
      if (resp.usage) this.runner.RecordUsage(resp.usage as never);
      const deduped = applyDedupGroups(resp.content ?? "", batchComments);
      if (deduped && deduped.length !== batchComments.length) {
        this.commentCollector.replaceSince(batchStart, deduped);
        console.error(`[pi-review] scan dedup batch #${batchIdx}: ${batchComments.length} → ${deduped.length} comments`);
      }
    } catch (err) {
      console.error(`[pi-review] scan dedup failed for batch #${batchIdx}: ${err instanceof Error ? err.message : String(err)} (keeping originals)`);
    }
  }

  private resumeItem(fingerprint: string): ResumeItem | null {
    if (!this.args.resume) return null;
    return this.args.resume.Item(fingerprint);
  }

  // Render placeholders for a scan item.
  renderMessages(it: ScanItem, rule: string, planGuidance: string): LlmConversation["messages"] {
    const rawMsgs: readonly { role: string; content: string }[] = this.args.template.MainTask.messages;
    return rawMsgs.map((m) => ({
      role: m.role,
      content: m.content
        .replaceAll("{{plan_guidance}}", planGuidance)
        .replaceAll("{{current_system_date_time}}", this.currentDate)
        .replaceAll("{{current_file_path}}", it.path)
        .replaceAll("{{system_rule}}", rule)
        .replaceAll("{{change_files}}", CHANGE_FILES_SCAN_LITERAL)
        .replaceAll("{{file_content}}", it.content ?? "")
        .replaceAll("{{requirement_background}}", this.args.background ?? ""),
    }));
  }

  resolveBatchStrategy(): BatchStrategy {
    const raw = (this.args.template as { BatchStrategy?: string }).BatchStrategy;
    return parseBatchStrategy(raw);
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers — mirrors Go free functions
// ---------------------------------------------------------------------------

export function scanItemFingerprint(it: ScanItem): string {
  const payload = `full_scan\x00${it.path}\x00${it.content ?? ""}`;
  return crypto.createHash("sha256").update(payload, "utf-8").digest("hex");
}

export function resumedFromSession(resume: ResumeState | null | undefined): string {
  return resume?.sessionId ?? "";
}

function extFromPath(p: string): string {
  const base = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

class Semaphore {
  private available: number;
  private readonly waiters: Array<(acquired: boolean) => void> = [];

  constructor(n: number) {
    this.available = n;
  }

  async acquire(signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.available > 0) {
      this.available--;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const waiter = (acquired: boolean): void => resolve(acquired);
      this.waiters.push(waiter);

      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      if (timeoutMs && timeoutMs > 0) {
        setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            resolve(false);
          }
        }, timeoutMs);
      }
    });
  }

  release(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) next(true);
    } else {
      this.available++;
    }
  }
}

export function formatPlanGuidance(raw: string): string {
  const stripped = StripMarkdownFences(raw).trim();
  if (stripped === "") return "";

  let plan: { summary?: string; checkpoints?: Array<{ focus?: string; lines?: string; why?: string }> } = {};
  try {
    plan = JSON.parse(stripped) as typeof plan;
  } catch {
    return stripped;
  }

  const sb: string[] = [];
  if (plan.summary) sb.push(`**Summary**: ${plan.summary}\n\n`);
  if (!plan.checkpoints || plan.checkpoints.length === 0) {
    return sb.join("").trimEnd();
  }
  sb.push("**Focus areas (give these extra attention; not exhaustive):**\n");
  for (let i = 0; i < plan.checkpoints.length; i++) {
    const cp = plan.checkpoints[i]!;
    let line = `${i + 1}. \`${cp.focus ?? ""}\``;
    if (cp.lines) line += ` (lines ${cp.lines})`;
    if (cp.why) line += ` — ${cp.why}`;
    sb.push(line + "\n");
  }
  return sb.join("").trimEnd();
}

export function buildSummaryCommentsList(comments: LlmComment[]): string {
  const maxLine = 280;
  const sb: string[] = [];
  for (const c of comments) {
    const oneLine = c.content.replace(/\n/g, " ");
    const text = oneLine.length > maxLine ? oneLine.slice(0, maxLine) + "..." : oneLine;
    sb.push(`- \`${c.path}\`: ${text}\n`);
  }
  return sb.join("");
}

export function buildDedupCommentsJSON(comments: LlmComment[]): string {
  type Wire = { id: string; path: string; content: string; existing_code?: string };
  const items: Wire[] = comments.map((cm, i) => ({
    id: `c-${i}`,
    path: cm.path,
    content: cm.content,
    ...(cm.existingCode ? { existing_code: cm.existingCode } : {}),
  }));
  return JSON.stringify(items);
}

export function applyDedupGroups(raw: string, originals: LlmComment[]): LlmComment[] | null {
  const stripped = StripMarkdownFences(raw).trim();
  if (stripped === "") return null;

  type Group = { members: string[]; merged_content?: string };
  let parsed: { groups?: Group[] } = {};
  try {
    parsed = JSON.parse(stripped) as typeof parsed;
  } catch {
    return null;
  }
  const groups = parsed.groups;
  if (!Array.isArray(groups)) return null;

  const idToIdx = new Map<string, number>();
  for (let i = 0; i < originals.length; i++) idToIdx.set(`c-${i}`, i);

  const seen = new Set<string>();
  const out: LlmComment[] = [];
  for (const g of groups) {
    if (!g.members || g.members.length === 0) return null;
    const firstMember = g.members[0];
    if (firstMember === undefined) return null;
    const canonicalIdx = idToIdx.get(firstMember);
    if (canonicalIdx === undefined) return null;
    const original = originals[canonicalIdx];
    if (original === undefined) return null;
    for (const id of g.members) {
      if (!idToIdx.has(id)) return null;
      if (seen.has(id)) return null;
      seen.add(id);
    }
    const canonical = { ...original };
    if (g.members.length > 1 && g.merged_content) canonical.content = g.merged_content;
    out.push(canonical);
  }

  if (seen.size !== originals.length) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Factories — mirrors Go NewAgent
// ---------------------------------------------------------------------------

export function NewAgent(args: ScanArgs): Agent {
  return new Agent(args);
}
export const newAgent = NewAgent;

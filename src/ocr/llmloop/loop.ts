// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/llmloop/loop.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import {
  type Message,
  type ToolCall,
  CountMessagesTokens,
  PromptTokenLimit,
  CompressionState,
  newTextMessage,
  extractText,
  partitionMessages,
  buildMessageXML,
  StripMarkdownFences,
  rebuildWithSummary,
} from "./compression.js";
import { CommentWorkerPool } from "./pool.js";
import {
  MainLoopStop,
  type AgentWarning,
  type ToolDef,
  type ChatRequest,
  type ChatResponse,
  type UsageInfo,
  type RunnerDeps,
  type ToolCallResult,
  type TaskCheckpoint,
  type RequestMeta,
  lookupRegistry,
} from "./types.js";
import { createHash } from "node:crypto";
import type { LlmComment } from "../model/types.js";
import type { Diff } from "../model/diff.js";
import { relocateAcrossFiles, resolveComment } from "../diff/resolver.js";
import type { SessionHistory, TaskRecord, TaskType } from "../session/history.js";

// Re-export for external consumers
export { MainLoopStop } from "./types.js";
export { mainLoopStopReason, mainLoopStopString } from "./types.js";
export type { RunnerDeps, AgentWarning, ToolDef, ChatRequest, ChatResponse, UsageInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCompletionTokenLimit(template: RunnerDeps["template"]): number {
  if (template.MaxCompletionTokens !== undefined && template.MaxCompletionTokens > 0) {
    return template.MaxCompletionTokens;
  }
  return template.MaxTokens;
}

function getMaxToolRequestTimes(template: RunnerDeps["template"]): number {
  return template.MaxToolRequestTimes;
}

/**
 * Mirrors OCR's llm.SessionTaskKey. The readable session/task prefix keeps
 * provider logs useful while the scope hash keeps paths header-safe.
 */
export function sessionTaskKey(sessionKey: string, taskType: string, scope: string): string {
  if (taskType === "" && scope === "") return sessionKey;
  if (scope === "") return `${sessionKey}-${taskType}`;
  const scopeHash = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 16);
  return `${sessionKey}-${taskType}-${scopeHash}`;
}

/**
 * parseToolArgs unmarshals a tool call's raw JSON arguments, always
 * returning a non-nil map on success. Mirrors Go parseToolArgs guard
 * against null.
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (raw === "null") {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    // Go expects map[string]any; non-object is treated as error.
    throw new SyntaxError(`tool arguments must be an object, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

export function graceRoundToolDefs(defs: readonly ToolDef[]): ToolDef[] {
  const out: ToolDef[] = [];
  for (const d of defs) {
    const name = d.function.name;
    if (name === "code_comment" || name === "task_done") {
      out.push(d);
    }
  }
  return out;
}

// Valid categories / severities — mirrors Go code_comment.go
const validCategories = new Set([
  "bug",
  "security",
  "performance",
  "maintainability",
  "test",
  "style",
  "documentation",
  "other",
]);
const validSeverities = new Set(["critical", "high", "medium", "low"]);

function normalizeCategory(category: string): string {
  const n = category.toLowerCase();
  if (validCategories.has(n)) return n;
  return "other";
}
function normalizeSeverity(severity: string): string {
  const n = severity.toLowerCase();
  if (validSeverities.has(n)) return n;
  return "low";
}

function parseComments(args: Record<string, unknown>): { comments: LlmComment[]; errorMsg: string } {
  let rawComments: unknown[] | undefined;
  const raw = args["comments"];
  if (Array.isArray(raw) && raw.length > 0) {
    rawComments = raw;
  } else if (typeof raw === "string" && raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) rawComments = parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { comments: [], errorMsg: `Error: failed to parse 'comments' JSON string: ${msg}` };
    }
  }
  if (!rawComments || rawComments.length === 0) {
    const rawJson = JSON.stringify(args);
    return { comments: [], errorMsg: `Error: 'comments' array is required. Got args: ${rawJson}` };
  }

  const comments: LlmComment[] = [];
  for (const entry of rawComments) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const content = typeof obj["content"] === "string" ? (obj["content"] as string) : "";
    const pathFromArgs = typeof args["path"] === "string" ? (args["path"] as string) : "";
    if (pathFromArgs === "" || content === "") continue;

    const cm: LlmComment = {
      path: pathFromArgs,
      content,
      // Go's LlmComment.Thinking is a string zero value, not an absent field.
      thinking: "",
    };
    if (typeof obj["suggestion_code"] === "string") cm.suggestionCode = obj["suggestion_code"] as string;
    if (typeof obj["existing_code"] === "string") cm.existingCode = obj["existing_code"] as string;
    if (typeof obj["thinking"] === "string") cm.thinking = obj["thinking"] as string;
    if (typeof obj["category"] === "string") cm.category = normalizeCategory(obj["category"] as string);
    if (typeof obj["severity"] === "string") cm.severity = normalizeSeverity(obj["severity"] as string);

    // startLine/endLine optional numeric
    if (typeof obj["start_line"] === "number") cm.startLine = obj["start_line"] as number;
    else if (typeof obj["startLine"] === "number") cm.startLine = obj["startLine"] as number;
    if (typeof obj["end_line"] === "number") cm.endLine = obj["end_line"] as number;
    else if (typeof obj["endLine"] === "number") cm.endLine = obj["endLine"] as number;

    comments.push(cm);
  }
  return { comments, errorMsg: "" };
}

// ---------------------------------------------------------------------------
// Tool failure details — isolated adoption from OCR b3704b8 + 0524d21.
// Tracks failed registered-tool invocations with raw LLM arguments so
// failures surface in output instead of hiding as model-visible strings.
// ---------------------------------------------------------------------------

export interface ToolFailureDetail {
  toolCallNumber: number;
  toolName: string;
  filePath: string;
  error: string;
  /** Raw tool-call argument string from the model (may be ""). */
  args: string;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class Runner {
  private _totalInputTokens = 0;
  private _totalOutputTokens = 0;
  private _totalCacheReadTokens = 0;
  private _totalCacheWriteTokens = 0;
  private _warnings: AgentWarning[] = [];
  private _toolCalls: Map<string, number> = new Map();
  private _toolCallSeq = 0;
  private _toolFailures: ToolFailureDetail[] = [];
  private _bg: Set<Promise<void>> = new Set();

  constructor(private readonly deps: RunnerDeps) {}

  private getSession(): SessionHistory | undefined {
    const anyDeps = this.deps as unknown as Record<string, unknown>;
    return (this.deps.session as SessionHistory | undefined) ?? (anyDeps["Session"] as SessionHistory | undefined);
  }

  private getRequestMetaFactory(): ((filePath: string, taskType: TaskType, requestNo: number) => RequestMeta) | undefined {
    const anyDeps = this.deps as unknown as Record<string, unknown>;
    return (this.deps.newRequestMeta as unknown as (filePath: string, taskType: TaskType, requestNo: number) => RequestMeta)
      ?? (anyDeps["NewRequestMeta"] as (filePath: string, taskType: TaskType, requestNo: number) => RequestMeta);
  }

  private makeRequestMeta(filePath: string, taskType: TaskType, requestNo: number): RequestMeta | undefined {
    const factory = this.getRequestMetaFactory();
    if (!factory) return undefined;
    try {
      return factory(filePath, taskType, requestNo);
    } catch {
      return undefined;
    }
  }

  // -- background ---------------------------------------------------------

  waitBackground(): Promise<void> {
    if (this._bg.size === 0) return Promise.resolve();
    return Promise.all([...this._bg]).then(() => undefined);
  }

  // Back-compat alias matching Go WaitBackground
  WaitBackground(): Promise<void> {
    return this.waitBackground();
  }

  // -- counters -----------------------------------------------------------

  totalInputTokens(): number {
    return this._totalInputTokens;
  }
  totalOutputTokens(): number {
    return this._totalOutputTokens;
  }
  totalCacheReadTokens(): number {
    return this._totalCacheReadTokens;
  }
  totalCacheWriteTokens(): number {
    return this._totalCacheWriteTokens;
  }
  totalTokensUsed(): number {
    return this._totalInputTokens + this._totalOutputTokens;
  }

  // Go-style aliases
  TotalInputTokens(): number {
    return this.totalInputTokens();
  }
  TotalOutputTokens(): number {
    return this.totalOutputTokens();
  }
  TotalCacheReadTokens(): number {
    return this.totalCacheReadTokens();
  }
  TotalCacheWriteTokens(): number {
    return this.totalCacheWriteTokens();
  }
  TotalTokensUsed(): number {
    return this.totalTokensUsed();
  }

  warnings(): AgentWarning[] {
    return [...this._warnings];
  }
  Warnings(): AgentWarning[] {
    return this.warnings();
  }

  toolCalls(): Map<string, number> {
    return new Map(this._toolCalls);
  }
  ToolCalls(): Map<string, number> {
    return this.toolCalls();
  }
  // Go returns map[string]int64 — provide object snapshot as well
  toolCallsObject(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this._toolCalls) out[k] = v;
    return out;
  }

  recordWarning(warningType: string, file: string, message: string): void {
    this._warnings.push({ file, message, type: warningType });
  }
  RecordWarning(warningType: string, file: string, message: string): void {
    this.recordWarning(warningType, file, message);
  }

  recordUsage(u: UsageInfo | null | undefined): void {
    if (!u) return;
    this._totalInputTokens += u.PromptTokens ?? 0;
    this._totalOutputTokens += u.CompletionTokens ?? 0;
    this._totalCacheReadTokens += u.CacheReadTokens ?? 0;
    this._totalCacheWriteTokens += u.CacheWriteTokens ?? 0;
  }
  RecordUsage(u: UsageInfo | null | undefined): void {
    this.recordUsage(u);
  }

  private recordToolCall(name: string): number {
    const cur = this._toolCalls.get(name) ?? 0;
    this._toolCalls.set(name, cur + 1);
    this._toolCallSeq += 1;
    return this._toolCallSeq;
  }

  /**
   * recordToolFailure appends a failure detail and persists ok=false.
   * Mirrors Go `recordToolFailure` (mutex omitted: JS single-threaded).
   */
  private recordToolFailure(
    toolCallNumber: number,
    toolName: string,
    filePath: string,
    errMsg: string,
    rec: TaskRecord | null | undefined,
    rawArgs: string,
    durationMs: number,
  ): void {
    this._toolFailures.push({ toolCallNumber, toolName, filePath, error: errMsg, args: rawArgs });
    try {
      rec?.AddToolFailure(toolName, rawArgs, errMsg, durationMs);
    } catch {
      // Persistence must not mask the tool failure itself.
    }
  }

  /** Sorted copy of failures by call number. Mirrors Go `ToolFailures`. */
  toolFailures(): ToolFailureDetail[] {
    return [...this._toolFailures].sort((a, b) => a.toolCallNumber - b.toolCallNumber);
  }
  ToolFailures(): ToolFailureDetail[] {
    return this.toolFailures();
  }

  async collectPendingComments(): Promise<LlmComment[]> {
    if (this.deps.commentWorkerPool) {
      await this.deps.commentWorkerPool.Await();
    }
    const c = this.deps.commentCollector;
    if (!c) return [];
    // Support both `comments()` and `Comments()` naming
    const anyC = c as unknown as { comments?: () => LlmComment[]; Comments?: () => LlmComment[] };
    if (typeof anyC.comments === "function") return anyC.comments();
    if (typeof anyC.Comments === "function") return anyC.Comments();
    return [];
  }
  CollectPendingComments(): Promise<LlmComment[]> {
    return this.collectPendingComments();
  }

  // -- transport adapter --------------------------------------------------

  private async callTransport(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse> {
    const client = this.deps.llmClient as unknown as Record<string, unknown>;
    // Prefer Go-style CompletionsWithCtx if present
    const goFn = client["CompletionsWithCtx"];
    if (typeof goFn === "function") {
      const fn = goFn as (sig: AbortSignal, r: ChatRequest) => Promise<ChatResponse>;
      return fn.call(client, signal, req);
    }
    const completeFn = client["complete"];
    if (typeof completeFn === "function") {
      const fn = completeFn as (sig: AbortSignal, r: ChatRequest) => Promise<ChatResponse>;
      return fn.call(client, signal, req);
    }
    throw new Error("Runner: llmClient must provide complete(signal, req) or CompletionsWithCtx(signal, req)");
  }

  // -- main loop ----------------------------------------------------------

  async RunPerFile(
    signal: AbortSignal,
    messages: Message[],
    filePath: string,
  ): Promise<{ completed: boolean; stop: MainLoopStop; error?: Error }> {
    let toolReqCount = getMaxToolRequestTimes(this.deps.template);
    const initialToolReqCount = toolReqCount;
    const maxConsecutiveEmptyRounds = 3;
    let consecutiveEmptyRounds = 0;
    const sess = this.getSession();
    const baseSessionId = sess?.sessionId
      ?? (this.deps.sessionId !== undefined && this.deps.sessionId !== ""
        ? this.deps.sessionId
        : typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36));
    const sessionId = sessionTaskKey(baseSessionId, "main_task", filePath);

    const st = new CompressionState();
    let stop: MainLoopStop = MainLoopStop.StopMaxRounds;

    try {
      for (; toolReqCount > 0; ) {
        if (signal.aborted) {
          const reason = (signal as AbortSignal & { reason?: unknown }).reason;
          const msg = reason !== undefined ? String(reason) : "context cancelled";
          return { completed: false, stop: MainLoopStop.StopNone, error: new Error(msg) };
        }

        toolReqCount--;

        // pi-reviewer extension (deliberate divergence from OCR v1.9.9, which
        // only announces the budget through the terminal grace round): once
        // half the round budget is spent, tell the model what remains every
        // 5 rounds so it can pace itself and finish inside the budget. Skipped
        // when the previous round already ended on a user message (the
        // no-tool-calls retry nudge) to avoid back-to-back user messages.
        if (
          toolReqCount > 0 &&
          toolReqCount % 5 === 0 &&
          toolReqCount * 2 <= initialToolReqCount &&
          messages[messages.length - 1]?.role !== "user"
        ) {
          messages.push(
            newTextMessage(
              "user",
              `[pi-review] Budget notice: ${toolReqCount} of ${initialToolReqCount} tool-call rounds remaining. ` +
                `If you have enough evidence, submit findings with code_comment and finish with task_done.`,
            ),
          );
        }

        // Mirror Go: create TaskRecord before request so RequestNo exists for identity.
        let rec: TaskRecord | undefined;
        let startTime = 0;
        if (sess) {
          const fs = sess.GetOrCreateFileSession(filePath);
          rec = fs.AppendTaskRecord("main_task" as TaskType, [...messages] as unknown as import("../session/history.js").Message[]);
          startTime = Date.now();
        }
        const requestMeta = rec ? this.makeRequestMeta(filePath, "main_task" as TaskType, rec.requestNo) : undefined;
        const req: ChatRequest = {
          model: this.deps.model,
          messages: [...messages],
          tools: [...this.deps.mainToolDefs],
          maxTokens: getCompletionTokenLimit(this.deps.template),
          sessionId,
          ...(requestMeta ? { requestMeta } : {}),
        };

        let resp: ChatResponse;
        try {
          resp = await this.callTransport(signal, req);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          if (rec) rec.SetError(e, Date.now() - startTime);
          return { completed: false, stop: MainLoopStop.StopNone, error: new Error(`LLM completion error: ${e.message}`) };
        }

        if (rec) {
          rec.SetResponse(
            { content: resp.content ?? "", toolCalls: (resp.toolCalls ?? []).map((tc) => ({ id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments } })), model: resp.content ? this.deps.model : this.deps.model, usage: resp.usage ? { promptTokens: resp.usage.PromptTokens, completionTokens: resp.usage.CompletionTokens, cacheReadTokens: resp.usage.CacheReadTokens, cacheWriteTokens: resp.usage.CacheWriteTokens } : undefined },
            Date.now() - startTime,
          );
        }
        if (resp.usage) this.recordUsage(resp.usage);

        const content = resp.content ?? "";
        const calls = (resp.toolCalls ?? []) as readonly ToolCall[];

        if (calls.length === 0) {
          console.log(`[pi-review] No tool calls parsed for ${filePath}, retrying...`);
          // Mirror Go exactly: append synthetic user retry, preserve assistant content if any. Do not count toward empty rounds.
          messages.push(newTextMessage("user", "You did not successfully call any tools. Please try again or use task_done if finished."));
          if (content !== "") {
            // Go: messages = append(messages[:len(messages)-1], llm.NewTextMessage("assistant", content), messages[len(messages)-1])
            const userMsg = messages.pop() as Message;
            messages.push(newTextMessage("assistant", content));
            messages.push(userMsg);
          }
          continue;
        }

        const results: ToolCallResult[] = [];
        let taskCompleted = false;
        let hasValidResult = false;
        const thinking = resp.reasoningContent ?? "";

        for (const call of calls) {
          const cp = await this.executeToolCall(signal, filePath, call as ToolCall, thinking, rec);
          if (cp.failed) {
            return { completed: false, stop: MainLoopStop.StopNone, error: new Error(`task failed: ${cp.data}`) };
          } else if (cp.completed) {
            results.push({
              toolCallId: call.id,
              name: call.function.name,
              result: "Task completed successfully.",
            });
            taskCompleted = true;
          } else if (cp.data !== "") {
            results.push({
              toolCallId: call.id,
              name: call.function.name,
              result: cp.data,
            });
            hasValidResult = true;
          } else {
            results.push({
              toolCallId: call.id,
              name: call.function.name,
              result: "Error: Tool execution returned no result.",
            });
          }
        }

        if (taskCompleted) {
          return { completed: true, stop: MainLoopStop.StopNone };
        }

        if (!hasValidResult) {
          consecutiveEmptyRounds++;
          if (consecutiveEmptyRounds >= maxConsecutiveEmptyRounds) {
            console.log(`[pi-review] Too many empty retries for ${filePath}, stopping.`);
            stop = MainLoopStop.StopEmptyRounds;
            break;
          }
          console.log(`[pi-review] No valid tool results for ${filePath}, retrying...`);
        } else {
          consecutiveEmptyRounds = 0;
        }

        const succeed = await this.addNextMessage(signal, content, calls as ToolCall[], results, messages, filePath, st);
        if (!succeed) {
          if (signal.aborted) {
            // Compression failed because the file's signal was aborted (the
            // per-file deadline or run cancellation), not because the context
            // was incompressible. Surface the abort cause instead of masking
            // it as a compression stop.
            const reason = (signal as AbortSignal & { reason?: unknown }).reason;
            const abortErr = reason instanceof Error && reason.message !== ""
              ? new Error(reason.message, { cause: reason })
              : new Error(reason !== undefined ? String(reason) : "context cancelled");
            return { completed: false, stop: MainLoopStop.StopNone, error: abortErr };
          }
          console.log(`[pi-review] Context compression exceeded threshold for ${filePath}, stopping.`);
          stop = MainLoopStop.StopCompression;
          break;
        }
      }

      if (stop === MainLoopStop.StopMaxRounds) {
        console.log(`[pi-review] Max tool requests reached for ${filePath}.`);
        await this.runGraceRound(signal, messages, filePath, sessionId);
      }

      return { completed: false, stop };
    } finally {
      st.cancelPendingCompression();
    }
  }

  // -- grace round --------------------------------------------------------

  private async runGraceRound(
    signal: AbortSignal,
    messages: Message[],
    filePath: string,
    sessionId: string,
  ): Promise<void> {
    const graceDefs = graceRoundToolDefs(this.deps.mainToolDefs);
    if (graceDefs.length === 0) return;

    messages.push(
      newTextMessage(
        "user",
        "Your tool-call budget is exhausted. This is your FINAL round. You may ONLY:\n" +
          "- Call code_comment to submit any findings you have identified but not yet reported.\n" +
          "- Call task_done if you have nothing more to report.\n" +
          "No other tools are available. Do not attempt further analysis.",
      ),
    );

    if (signal.aborted) {
      console.log(`[pi-review] Grace round skipped for ${filePath}: context cancelled`);
      return;
    }

    const req: ChatRequest = {
      model: this.deps.model,
      messages: [...messages],
      tools: graceDefs,
      maxTokens: getCompletionTokenLimit(this.deps.template),
      sessionId,
    };

    let resp: ChatResponse;
    try {
      resp = await this.callTransport(signal, req);
    } catch (err) {
      console.log(`[pi-review] Grace round LLM error for ${filePath}: ${String(err)}`);
      return;
    }

    if (resp.usage) this.recordUsage(resp.usage);

    const calls = resp.toolCalls ?? [];
    if (calls.length === 0) return;

    // Grace round also creates a TaskRecord for session history (mirrors Go runGraceRound).
    let graceRec: TaskRecord | undefined;
    const sessGrace = this.getSession();
    if (sessGrace) {
      const fs = sessGrace.GetOrCreateFileSession(filePath);
      graceRec = fs.AppendTaskRecord("main_task" as TaskType, [...messages] as unknown as import("../session/history.js").Message[]);
      graceRec.SetResponse({ content: resp.content ?? "", toolCalls: calls.map((tc) => ({ id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments } })), model: this.deps.model, usage: resp.usage ? { promptTokens: resp.usage.PromptTokens, completionTokens: resp.usage.CompletionTokens } : undefined }, 0);
    }
    const thinking = resp.reasoningContent ?? "";
    for (const call of calls) {
      // Ignore return — grace round does not affect completed flag
      await this.executeToolCall(signal, filePath, call as ToolCall, thinking, graceRec);
    }
  }

  // -- tool dispatch ------------------------------------------------------

  async executeToolCall(
    signal: AbortSignal,
    filePath: string,
    toolCall: ToolCall,
    thinking: string,
    rec?: TaskRecord | null,
  ): Promise<TaskCheckpoint> {
    const name = toolCall.function.name;

    // task_done — built-in terminal
    if (name === "task_done") {
      let args: Record<string, unknown>;
      try {
        args = parseToolArgs(toolCall.function.arguments);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { data: `Error parsing tool arguments for ${name}: ${msg}`, completed: false, failed: false };
      }
      const rawState = args["state"];
      if (rawState === undefined) {
        return { data: "", completed: true, failed: false };
      }
      if (typeof rawState !== "string") {
        return { data: "Error: task_done state must be DONE or FAILED.", completed: false, failed: false };
      }
      switch (rawState) {
        case "DONE":
          return { data: "", completed: true, failed: false };
        case "FAILED":
          return { data: "task_done reported FAILED", completed: false, failed: true };
        default:
          return {
            data: `Error: invalid task_done state "${rawState}"; expected DONE or FAILED.`,
            completed: false,
            failed: false,
          };
      }
    }

    // code_comment — incremental collector, async via pool if available
    // Mirrors Go executeToolCall code_comment path: ParseComments -> thinking backfill -> resolveAndCollect via DiffLookup + ReLocationTask -> collector.Add (async or sync)
    if (name === "code_comment") {
      const toolCallNumber = this.recordToolCall(name);
      const callStarted = Date.now();
      const rawArgs = toolCall.function.arguments;
      let args: Record<string, unknown>;
      try {
        args = parseToolArgs(rawArgs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errMsg = `Error parsing tool arguments for ${name}: ${msg}`;
        this.recordToolFailure(toolCallNumber, name, filePath, errMsg, rec, rawArgs, Date.now() - callStarted);
        return { data: errMsg, completed: false, failed: false };
      }
      if (filePath !== "") {
        args["path"] = filePath;
      }

      const { comments, errorMsg } = parseComments(args);
      if (errorMsg !== "") {
        this.recordToolFailure(toolCallNumber, name, filePath, errorMsg, rec, rawArgs, Date.now() - callStarted);
        return { data: errorMsg, completed: false, failed: false };
      }

      if (thinking !== "") {
        for (const cm of comments) {
          if (!cm.thinking) cm.thinking = thinking;
        }
      }

      const collector = this.deps.commentCollector;
      if (!collector) {
        const errMsg = "Error: comment collector is not configured";
        this.recordToolFailure(toolCallNumber, name, filePath, errMsg, rec, rawArgs, Date.now() - callStarted);
        return { data: errMsg, completed: false, failed: false };
      }

      // Helpers for relocation — capture deps before async boundary
      const diffLookup = (this.deps.diffLookup ?? (this.deps as unknown as Record<string, unknown>)["DiffLookup"]) as
        | ((path: string) => unknown)
        | undefined;
      const allDiffs = (this.deps.allDiffs ?? (this.deps as unknown as Record<string, unknown>)["AllDiffs"]) as
        | (() => readonly unknown[])
        | undefined;
      const templateAny = this.deps.template as unknown as Record<string, unknown>;
      const reLocationTaskRaw = (templateAny["ReLocationTask"] ?? templateAny["reLocationTask"]) as
        | { Messages?: readonly Message[]; messages?: readonly { readonly role: string; readonly content: string }[] }
        | null
        | undefined;

      const normalizeDiff = (raw: unknown): Diff | null => {
        if (!raw || typeof raw !== "object") return null;
        const r = raw as Record<string, unknown>;
        const get = (keys: string[]): string => {
          for (const k of keys) {
            const v = r[k];
            if (typeof v === "string") return v;
          }
          return "";
        };
        const getBool = (keys: string[]): boolean => {
          for (const k of keys) {
            const v = r[k];
            if (typeof v === "boolean") return v;
          }
          return false;
        };
        const getNum = (keys: string[]): number => {
          for (const k of keys) {
            const v = r[k];
            if (typeof v === "number") return v;
          }
          return 0;
        };
        return {
          oldPath: get(["oldPath", "OldPath", "old_path"]),
          newPath: get(["newPath", "NewPath", "new_path"]),
          diff: get(["diff", "Diff"]),
          newFileContent: get(["newFileContent", "NewFileContent", "new_file_content"]),
          isBinary: getBool(["isBinary", "IsBinary", "is_binary"]),
          isDeleted: getBool(["isDeleted", "IsDeleted", "is_deleted"]),
          isNew: getBool(["isNew", "IsNew", "is_new"]),
          isRenamed: getBool(["isRenamed", "IsRenamed", "is_renamed"]),
          insertions: getNum(["insertions", "Insertions"]),
          deletions: getNum(["deletions", "Deletions"]),
        };
      };

      const buildReLocationMessagesLocal = (
        cm: LlmComment,
        d: Diff,
        task: { Messages?: readonly Message[]; messages?: readonly { readonly role: string; readonly content: string }[] } | null | undefined,
      ): Message[] | null => {
        if (!task) return null;
        const anyTask = task as Record<string, unknown>;
        let msgs: readonly { readonly role: string; readonly content: string }[] | null = null;
        if (Array.isArray(anyTask["Messages"])) {
          msgs = (anyTask["Messages"] as readonly Message[]).map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : extractText(m as Message),
          }));
        } else if (Array.isArray(anyTask["messages"])) {
          msgs = anyTask["messages"] as readonly { readonly role: string; readonly content: string }[];
        }
        if (!msgs || msgs.length === 0) return null;
        const out: Message[] = [];
        for (const m of msgs) {
          let content: string = m.content;
          content = content.replaceAll("{diff}", d.diff);
          content = content.replaceAll("{existing_code}", cm.existingCode ?? "");
          content = content.replaceAll("{suggestion_content}", cm.content);
          out.push(newTextMessage(m.role, content));
        }
        return out;
      };

      const extractCodeBlockLocal = (text: string): string => {
        const trimmed = text.trim();
        const start = trimmed.indexOf("```");
        if (start < 0) return "";
        let afterOpen = start + 3;
        const nl = trimmed.indexOf("\n", afterOpen);
        if (nl < 0) return "";
        afterOpen = nl + 1;
        const end = trimmed.indexOf("```", afterOpen);
        if (end < 0) return "";
        return trimmed.slice(afterOpen, end).trim();
      };

      const processOneComment = async (cm: LlmComment, sig: AbortSignal): Promise<void> => {
        let d: Diff | null = null;
        if (diffLookup) {
          try {
            const raw = diffLookup(cm.path);
            if (raw) d = normalizeDiff(raw);
          } catch {
            d = null;
          }
        }
        if (cm.existingCode && cm.existingCode !== "") {
          const alreadyResolved = (cm.startLine ?? 0) > 0 || (cm.endLine ?? 0) > 0;
          if (!alreadyResolved) {
            let ok = false;
            if (d !== null) {
              try {
                ok = resolveComment(cm as unknown as Parameters<typeof resolveComment>[0], d);
              } catch {
                ok = false;
              }
            }
            // OCR v1.9.5 searches the reviewed set before asking the model:
            // the model could overwrite the original cross-file evidence.
            if (!ok && allDiffs) {
              try {
                const reviewedDiffs = allDiffs()
                  .map((raw) => normalizeDiff(raw))
                  .filter((candidate): candidate is Diff => candidate !== null);
                const from = cm.path;
                const [to, relocated] = relocateAcrossFiles(cm, reviewedDiffs);
                ok = relocated;
                if (relocated) {
                  this.recordWarning(
                    "comment_refiled",
                    to,
                    `comment filed against ${from} describes code in ${to}; re-filed`,
                  );
                }
              } catch {
                ok = false;
              }
            }
            if (!ok && d !== null && reLocationTaskRaw) {
              const msgs = buildReLocationMessagesLocal(cm, d, reLocationTaskRaw as unknown as never);
              if (msgs && msgs.length > 0) {
                const sessRel = this.getSession();
                const baseSessionIdRel = sessRel?.sessionId ?? this.deps.sessionId;
                let rlRec: TaskRecord | undefined;
                let rlStart = Date.now();
                let requestMetaRel: RequestMeta | undefined;
                if (sessRel) {
                  const fsRel = sessRel.GetOrCreateFileSession(cm.path);
                  rlRec = fsRel.AppendTaskRecord("re_location_task" as TaskType, [...msgs] as unknown as import("../session/history.js").Message[]);
                  rlStart = Date.now();
                  requestMetaRel = this.makeRequestMeta(cm.path, "re_location_task" as TaskType, rlRec.requestNo);
                }
                const req: ChatRequest = {
                  model: this.deps.model,
                  messages: msgs,
                  maxTokens: getCompletionTokenLimit(this.deps.template),
                  ...(baseSessionIdRel !== undefined && baseSessionIdRel !== ""
                    ? { sessionId: sessionTaskKey(baseSessionIdRel, "re_location_task", cm.path) }
                    : {}),
                  ...(requestMetaRel ? { requestMeta: requestMetaRel } : {}),
                };
                try {
                  const resp = await this.callTransport(sig, req);
                  if (rlRec) {
                    rlRec.SetResponse(
                      { content: resp.content ?? "", toolCalls: (resp.toolCalls ?? []).map((tc) => ({ id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments } })), model: this.deps.model, usage: resp.usage ? { promptTokens: resp.usage.PromptTokens, completionTokens: resp.usage.CompletionTokens, cacheReadTokens: resp.usage.CacheReadTokens, cacheWriteTokens: resp.usage.CacheWriteTokens } : undefined },
                      Date.now() - rlStart,
                    );
                  }
                  if (resp.usage) this.recordUsage(resp.usage);
                  const code = extractCodeBlockLocal(resp.content ?? "");
                  if (code !== "") {
                    const original = cm.existingCode ?? "";
                    cm.existingCode = code;
                    let ok2 = false;
                    try {
                      ok2 = resolveComment(cm as unknown as Parameters<typeof resolveComment>[0], d);
                    } catch {
                      ok2 = false;
                    }
                    if (!ok2) {
                      cm.existingCode = original;
                    }
                  }
                } catch (err) {
                  if (rlRec) rlRec.SetError(err instanceof Error ? err : new Error(String(err)), Date.now() - rlStart);
                  console.error(`[pi-review] Re-location LLM call failed for ${cm.path}: ${String((err as Error).message)}`);
                }
              }
            }
          }
        }
        const anyC = collector as unknown as {
          add?: (cm: LlmComment) => void;
          Add?: (cm: LlmComment) => void;
        };
        if (typeof anyC.Add === "function") anyC.Add(cm);
        else if (typeof anyC.add === "function") anyC.add(cm);
      };

      const processAll = async (cms: LlmComment[], sig: AbortSignal): Promise<void> => {
        for (const cm of cms) {
          // eslint-disable-next-line no-await-in-loop
          await processOneComment(cm, sig);
        }
      };

      const pool: CommentWorkerPool | undefined = this.deps.commentWorkerPool;

      if (pool) {
        if (rec) rec.AddToolResult(name, toolCall.function.arguments, "(async)");
        const snapshot = comments.map((c) => ({ ...c }));
        const detachedSignal = new AbortController().signal;
        pool.SubmitFor(filePath, async () => {
          try {
            await processAll(snapshot, detachedSignal);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[pi-review] CommentWorkerPool panic: ${msg}`);
          }
          return [] as LlmComment[];
        });
        return { data: "Successfully commented.", completed: false, failed: false };
      }

      try {
        await processAll(comments, signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errMsg = `Error: ${msg}`;
        this.recordToolFailure(toolCallNumber, name, filePath, errMsg, rec, rawArgs, Date.now() - callStarted);
        return { data: errMsg, completed: false, failed: false };
      }
      if (rec) rec.AddToolResult(name, toolCall.function.arguments, "Successfully commented.");
      return { data: "Successfully commented.", completed: false, failed: false };
    }

    // Dynamic registry lookup for remaining tools
    const registry = (this.deps.toolRegistry ?? this.deps.tools) as unknown as Parameters<typeof lookupRegistry>[0];
    const provider = lookupRegistry(registry, name);
    if (!provider) {
      return {
        data: "Error: Tool not found. The tool you attempted to call does not exist or is not available. Please check the tool name and try again with a valid tool.",
        completed: false,
        failed: false,
      };
    }

    const dynCallNumber = this.recordToolCall(name);
    const dynStarted = Date.now();
    const dynRawArgs = toolCall.function.arguments;

    let dynArgs: Record<string, unknown>;
    try {
      dynArgs = parseToolArgs(dynRawArgs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = `Error parsing tool arguments for ${name}: ${msg}`;
      this.recordToolFailure(dynCallNumber, name, filePath, errMsg, rec, dynRawArgs, Date.now() - dynStarted);
      return { data: errMsg, completed: false, failed: false };
    }

    try {
      const result = await provider.execute(dynArgs, signal);
      if (rec) rec.AddToolResult(name, toolCall.function.arguments, result);
      return { data: result, completed: false, failed: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = `Error executing tool ${name}: ${msg}`;
      this.recordToolFailure(dynCallNumber, name, filePath, msg, rec, dynRawArgs, Date.now() - dynStarted);
      return { data: errMsg, completed: false, failed: false };
    }
  }

  // -- compression / message succession -----------------------------------

  /**
   * runCompression performs three-zone memory compression, summarizing the
   * compress zone while preserving frozen+active. Mirrors Go
   * Runner.runCompression: partition -> buildMessageXML -> {{context}} substitution ->
   * LLM -> StripMarkdownFences -> rebuildWithSummary + usage. Failure keeps
   * original per Go.
   */
  private async runCompression(
    signal: AbortSignal,
    msgs: Message[],
    _filePath: string,
  ): Promise<Message[]> {
    const tmpl = this.deps.template as unknown as {
      readonly MaxTokens: number;
      readonly MaxCompletionTokens?: number;
      readonly MemoryCompressionTask?:
        | { readonly Messages?: readonly Message[]; readonly messages?: readonly { readonly role: string; readonly content: string }[] }
        | undefined;
    };
    // Support both minimal llmloop Template shape (Messages) and full template.ts shape (messages)
    const rawTask = tmpl.MemoryCompressionTask as unknown as
      | { Messages?: readonly Message[]; messages?: readonly { role: string; content: string }[] }
      | undefined;
    let taskMessages: readonly Message[] | undefined;
    if (rawTask !== undefined) {
      const anyTask = rawTask as Record<string, unknown>;
      if (Array.isArray(anyTask["Messages"])) {
        taskMessages = anyTask["Messages"] as readonly Message[];
      } else if (Array.isArray(anyTask["messages"])) {
        // full template shape: ChatMessage[] -> Message[]
        taskMessages = (anyTask["messages"] as readonly { role: string; content: string }[]).map((m) =>
          newTextMessage(m.role, m.content),
        );
      }
    }
    if (!taskMessages || taskMessages.length === 0 || msgs.length <= 2) {
      return msgs.slice(0, Math.min(msgs.length, 2));
    }

    const part = partitionMessages(msgs, tmpl.MaxTokens, 0);
    if (part.compressEnd <= part.frozenEnd) {
      return msgs;
    }

    const contextXML = buildMessageXML(msgs.slice(part.frozenEnd, part.compressEnd));
    const compressionMsgs: Message[] = taskMessages.map((m) => {
      const txt = extractText(m);
      return newTextMessage(m.role, txt.replaceAll("{{context}}", contextXML));
    });

    const sessComp = this.getSession();
    const baseSessionIdComp = sessComp?.sessionId ?? this.deps.sessionId;
    let compRec: TaskRecord | undefined;
    let compStart = Date.now();
    let compMeta: RequestMeta | undefined;
    if (sessComp) {
      const fsComp = sessComp.GetOrCreateFileSession(_filePath);
      compRec = fsComp.AppendTaskRecord("memory_compression_task" as TaskType, [...compressionMsgs] as unknown as import("../session/history.js").Message[]);
      compStart = Date.now();
      compMeta = this.makeRequestMeta(_filePath, "memory_compression_task" as TaskType, compRec.requestNo);
    }
    const req: ChatRequest = {
      model: this.deps.model,
      messages: compressionMsgs,
      maxTokens: getCompletionTokenLimit(this.deps.template),
      ...(baseSessionIdComp !== undefined && baseSessionIdComp !== ""
        ? { sessionId: sessionTaskKey(baseSessionIdComp, "memory_compression_task", _filePath) }
        : {}),
      ...(compMeta ? { requestMeta: compMeta } : {}),
    };

    let resp: ChatResponse;
    try {
      resp = await this.callTransport(signal, req);
    } catch (err) {
      if (compRec) compRec.SetError(err instanceof Error ? err : new Error(String(err)), Date.now() - compStart);
      throw err;
    }
    if (compRec) {
      compRec.SetResponse(
        { content: resp.content ?? "", toolCalls: (resp.toolCalls ?? []).map((tc) => ({ id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments } })), model: this.deps.model, usage: resp.usage ? { promptTokens: resp.usage.PromptTokens, completionTokens: resp.usage.CompletionTokens, cacheReadTokens: resp.usage.CacheReadTokens, cacheWriteTokens: resp.usage.CacheWriteTokens } : undefined },
        Date.now() - compStart,
      );
    }
    if (resp.usage) this.recordUsage(resp.usage);

    const rawSummary = StripMarkdownFences(resp.content ?? "");
    if (rawSummary === "") {
      return msgs;
    }
    const rebuilt = rebuildWithSummary(msgs, part.compressEnd, rawSummary);
    if (rebuilt === null) return msgs;
    return rebuilt;
  }

  /**
   * addNextMessage extends the conversation with the assistant message and
   * tool responses, applying three-zone compression thresholds.
   * Mirrors Go Runner.addNextMessage but without session history LLM compression.
   * Returns false when still over warning threshold (caller should StopCompression).
   */
  private async addNextMessage(
    signal: AbortSignal,
    assistantContent: string,
    toolCalls: readonly ToolCall[],
    results: readonly ToolCallResult[],
    messages: Message[],
    filePath: string,
    st: CompressionState,
  ): Promise<boolean> {
    const maxAllowed = this.deps.template.MaxTokens;
    const softLimit = Math.trunc(maxAllowed * 0.6);
    const warnLimit = PromptTokenLimit(maxAllowed);

    // Try to apply any completed background compression before mutating
    st.tryApplyPendingCompression(messages);

    if (CountMessagesTokens(messages) > warnLimit) {
      st.cancelPendingCompression();
      try {
        const rebuilt = await this.runCompression(signal, [...messages], filePath);
        // Only replace if rebuilt length differs or content changed; stub keeps same
        if (rebuilt.length !== messages.length || rebuilt.some((m, i) => m !== messages[i])) {
          messages.splice(0, messages.length, ...rebuilt);
        }
      } catch (err) {
        console.log(`[pi-review] Memory compression failed: ${String(err)}`);
      }
    }

    if (toolCalls.length > 0) {
      // Use tool-call message shape: assistant with tool_calls
      const tc = toolCalls.map((t) => ({ ...t, function: { ...t.function } }));
      (messages as Message[]).push({
        role: "assistant",
        content: assistantContent,
        tool_calls: tc,
      } as unknown as Message);
    } else if (assistantContent !== "") {
      messages.push(newTextMessage("assistant", assistantContent));
    }

    for (const rs of results) {
      (messages as Message[]).push({
        role: "tool",
        content: rs.result,
        tool_call_id: rs.toolCallId,
      } as unknown as Message);
    }

    let finalCount = CountMessagesTokens(messages);
    if (finalCount > warnLimit) {
      st.cancelPendingCompression();
      try {
        const rebuilt = await this.runCompression(signal, [...messages], filePath);
        if (rebuilt.length !== messages.length || rebuilt.some((m, i) => m !== messages[i])) {
          messages.splice(0, messages.length, ...rebuilt);
        }
      } catch (err) {
        console.log(`[pi-review] Memory compression failed: ${String(err)}`);
      }
      finalCount = CountMessagesTokens(messages);
    }

    if (finalCount > softLimit && finalCount < warnLimit) {
      // Trigger async compression for next round — mirror Go triggerAsyncCompression
      this.triggerAsyncCompression(st, messages, filePath);
    }

    return finalCount < warnLimit;
  }

  private triggerAsyncCompression(st: CompressionState, messages: readonly Message[], filePath: string): void {
    const worker = st.triggerAsyncCompression(messages, filePath, async (snapshot, fp, sig) => {
      return this.runCompression(sig, [...snapshot], fp);
    });
    if (worker === null) return;
    this._bg.add(worker);
    void worker.finally(() => {
      this._bg.delete(worker);
    });
  }
}

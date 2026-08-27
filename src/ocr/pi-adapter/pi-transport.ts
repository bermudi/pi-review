// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/llm/ and internal/llmloop adapter concept at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Pi SDK adapter for the OCR v1.9.3 parity loop.
 *
 * This module bridges the provider-agnostic `LlmTransport` seam
 * (`src/ocr/llmloop/transcript.ts` / `types.ts`) to the public Pi SDK
 * surface (`@earendil-works/pi-coding-agent` 0.84.2). It is intentionally a
 * thin but functional adapter that uses only public APIs — no
 * `pi-agent-core` deep imports, no legacy `src/*` imports.
 *
 * See `docs/pi-sdk-feasibility-report.md` for the public API mapping and
 * remaining gaps (grace fence, OCR compression hook).
 *
 * Public imports only: `createAgentSession`, `SessionManager`,
 * `SettingsManager` from `@earendil-works/pi-coding-agent`.
 */

import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Message, ToolCall } from "../llmloop/compression.js";
import type { ChatRequest, ChatResponse, ToolDef, UsageInfo } from "../llmloop/types.js";
import type { LlmTransport as TranscriptLlmTransport } from "../llmloop/transcript.js";
import { stripThinkTags } from "./strip-think-tags.js";
import type { RetryCollector } from "../retry/collector.js";
import { isValidRequestMeta } from "../retry/meta.js";
import { classifyAttempt, isAbortError, ErrorClassProvider, FailurePhaseResponseStatus } from "../retry/types.js";
import { classifyBoundaryError } from "../retry/boundary.js";

// ---------------------------------------------------------------------------
// Pi session type — derived from public factory return without deep import.
// ---------------------------------------------------------------------------

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export interface ActiveToolSession {
  setActiveToolsByName(names: string[]): void;
  getActiveToolNames(): readonly string[];
}
export interface PiModelIdentity {
  readonly provider: string;
  readonly model: string;
}

function sameToolNames(actual: readonly string[], requested: readonly string[]): boolean {
  return actual.length === requested.length
    && new Set(actual).size === actual.length
    && actual.every((name) => requested.includes(name));
}

/**
 * Synchronize Pi's public active-tool allowlist and prove the session accepted
 * the exact set before prompting. Ignored unknown names and stale extras are
 * security failures, not recoverable diagnostics.
 */
export function activateToolsFailClosed(session: ActiveToolSession, requested: readonly string[]): void {
  if (new Set(requested).size !== requested.length) {
    throw new Error(`Pi tool activation rejected duplicate requested tool names: ${requested.join(", ")}`);
  }
  try {
    session.setActiveToolsByName([...requested]);
  } catch (error) {
    throw new Error(`Pi tool activation failed while setting [${requested.join(", ")}]: ${String(error)}`);
  }
  let active: readonly string[];
  try {
    active = session.getActiveToolNames();
  } catch (error) {
    throw new Error(`Pi tool activation failed while verifying [${requested.join(", ")}]: ${String(error)}`);
  }
  if (!sameToolNames(active, requested)) {
    throw new Error(
      `Pi tool activation mismatch: requested [${requested.join(", ")}], active [${active.join(", ")}]`,
    );
  }
}

export function assertUniqueToolNames(base: readonly ToolDef[], supplemental: readonly ToolDef[]): void {
  const names = [...base, ...supplemental].map((tool) => tool.function.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Pi tool registration rejected duplicate tool names: ${names.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers — argument normalization and abort detection
// ---------------------------------------------------------------------------

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["aborted"] === "boolean" &&
    typeof (value as Record<string, unknown>)["addEventListener"] === "function"
  );
}

function normalizeCompleteArgs(
  a: ChatRequest | AbortSignal,
  b: ChatRequest | AbortSignal,
): { req: ChatRequest; signal: AbortSignal } {
  if (isAbortSignal(a)) {
    return { signal: a, req: b as ChatRequest };
  }
  return { req: a as ChatRequest, signal: b as AbortSignal };
}

function toPiToolParameters(raw: unknown): unknown {
  if (raw === undefined || raw === null) {
    return Type.Object({});
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const hasType = typeof rec["type"] === "string";
    const hasProps = typeof rec["properties"] === "object" && rec["properties"] !== null;
    if (hasType || hasProps) {
      // Preserve object-root schema with required filtering (non-string dropped) and extra field passthrough
      // Mirrors Go buildToolInputSchema behavior for required/extra fields
      const out: Record<string, unknown> = {};
      if (typeof rec["type"] === "string") out["type"] = rec["type"];
      if (hasProps) out["properties"] = rec["properties"];
      if (Array.isArray(rec["required"])) {
        const filtered = (rec["required"] as unknown[]).filter((v): v is string => typeof v === "string");
        if (filtered.length > 0) out["required"] = filtered;
      }
      for (const [k, v] of Object.entries(rec)) {
        if (k === "type" || k === "properties" || k === "required") continue;
        out[k] = v;
      }
      // Ensure we still produce an object-root TypeBox schema if raw was already shape-correct
      // but we need to guarantee the returned schema is valid TypeBox. If raw had extra fields,
      // we have incorporated them above. Return as TypeBox-compatible object.
      if (Object.keys(out).length === 0) return Type.Object({});
      // If out is already a valid JSON schema object, return it directly (Pi SDK accepts plain objects)
      // Otherwise wrap. For simplicity, return the raw object when it looks like a schema, else Type.Object.
      return out;
    }
  }
  return Type.Object({});
}

function createAbortError(): Error {
  try {
    return new DOMException("Aborted", "AbortError");
  } catch {
    const err = new Error("Aborted");
    err.name = "AbortError";
    return err;
  }
}

/**
 * Build the error to throw when `signal` is aborted. Surfaces the signal's
 * abort reason — e.g. the per-file deadline ("file task timeout") or run
 * cancellation ("review was cancelled") — so logs and failure classification
 * can distinguish a deadline from a cancellation. A bare abort (no reason)
 * keeps the generic AbortError.
 */
function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) {
    if (reason.name === "AbortError") return reason;
    if (reason.message !== "") return new Error(reason.message, { cause: reason });
  }
  return createAbortError();
}

// ---------------------------------------------------------------------------
// OCR Message -> Pi AgentMessage translation helpers
// ---------------------------------------------------------------------------

function extractOcrText(msg: Message): string {
  const c = msg.content;
  if (typeof c === "string") return stripThinkTags(c);
  if (Array.isArray(c)) {
    let out = "";
    for (const block of c as readonly { readonly type: string; readonly text?: string; readonly content?: readonly unknown[] }[]) {
      if (typeof block.text === "string") {
        out += stripThinkTags(block.text);
      } else if (Array.isArray((block as unknown as { content?: unknown }).content)) {
        // Nested content blocks (recursive)
        for (const nested of (block as unknown as { content: readonly { readonly text?: string }[] }).content) {
          out += stripThinkTags(nested.text ?? "");
        }
      }
    }
    return out;
  }
  return "";
}

function extractOcrTextFromContent(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
  if (typeof content === "string") return stripThinkTags(content);
  let out = "";
  for (const b of content) out += stripThinkTags(b.text ?? "");
  return out;
}

function ocrMessagesToPiMessages(messages: readonly Message[]): unknown[] {
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    const tcs = (m as unknown as { tool_calls?: readonly ToolCall[] }).tool_calls;
    if (m.role === "assistant" && tcs !== undefined) {
      for (const tc of tcs) toolNameById.set(tc.id, tc.function.name);
    }
  }

  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // system is handled via state.systemPrompt, not as a user message
    const text = extractOcrText(m);
    if (m.role === "user") {
      out.push({
        role: "user",
        content: text,
        timestamp: Date.now(),
      });
    } else if (m.role === "assistant") {
      const content: unknown[] = [];
      if (text !== "") content.push({ type: "text", text });
      const tcs = (m as unknown as { tool_calls?: readonly ToolCall[] }).tool_calls;
      if (tcs !== undefined && tcs.length > 0) {
        for (const tc of tcs) {
          let args: Record<string, unknown> = {};
          const raw = tc.function.arguments;
          if (raw !== "" && raw !== "null") {
            try {
              const parsed: unknown = JSON.parse(raw);
              if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                args = parsed as Record<string, unknown>;
              }
            } catch {
              args = {};
            }
          }
          content.push({ type: "toolCall", id: tc.id, name: tc.function.name, arguments: args });
        }
      }
      out.push({
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "test-openai",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: tcs !== undefined && tcs.length > 0 ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
    } else if (m.role === "tool") {
      const toolCallId = (m as unknown as { tool_call_id?: string }).tool_call_id ?? "";
      const toolName = toolNameById.get(toolCallId) ?? "unknown";
      out.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError: false,
        timestamp: Date.now(),
      });
    } else {
      // Fallback for unknown roles — preserve as user so Pi does not drop context
      out.push({ role: "user", content: text, timestamp: Date.now() });
    }
  }
  return out;
}

interface PiAssistantObservation {
  readonly text: string;
  readonly reasoningText: string;
  readonly toolCalls: ToolCall[];
  readonly toolBlocks: number;
  readonly invalidToolBlocks: number;
  readonly stopReason: string;
}

function safeStopReason(value: unknown): string {
  switch (value) {
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
      return value;
    default:
      return value === undefined ? "missing" : "other";
  }
}

/**
 * Inspect only the structural assistant fields needed by the OCR adapter.
 * Diagnostics deliberately expose counts and booleans, never model text,
 * reasoning, tool names/arguments, prompts, errors, or provider payloads.
 */
function inspectPiAssistant(msg: unknown): PiAssistantObservation {
  const m = msg as { content?: unknown; reasoningContent?: unknown; reasoning?: unknown };
  const c = m.content;
  let text = "";
  let reasoningText = "";
  // Reasoning may be in separate field (compat) or as thinking blocks
  if (typeof m.reasoningContent === "string" && m.reasoningContent.length > 0) {
    reasoningText += stripThinkTags(m.reasoningContent);
  }
  if (typeof m.reasoning === "string" && m.reasoning.length > 0) {
    reasoningText += stripThinkTags(m.reasoning);
  }
  const out: ToolCall[] = [];
  let toolBlocks = 0;
  let invalidToolBlocks = 0;

  if (typeof c === "string") {
    text = stripThinkTags(c);
  } else if (Array.isArray(c)) {
    for (const block of c as readonly { type?: string; text?: string; id?: string; name?: string; arguments?: unknown; content?: unknown }[]) {
      if (block.type === "text" && typeof block.text === "string") {
        text += stripThinkTags(block.text);
        continue;
      }
      if ((block.type === "thinking" || block.type === "reasoning") && typeof block.text === "string") {
        reasoningText += stripThinkTags(block.text);
        continue;
      }
      if (block.type !== "toolCall") continue;
      toolBlocks++;
      if (typeof block.id !== "string" || typeof block.name !== "string") {
        invalidToolBlocks++;
        continue;
      }
      let argsStr: string;
      const args = block.arguments;
      if (typeof args === "string") argsStr = args;
      else if (args !== undefined) {
        try {
          argsStr = JSON.stringify(args);
        } catch {
          argsStr = "{}";
        }
      } else argsStr = "{}";
      out.push({ id: block.id, type: "function", function: { name: block.name, arguments: argsStr } });
    }
  }

  return {
    text,
    reasoningText,
    toolCalls: out,
    toolBlocks,
    invalidToolBlocks,
    stopReason: safeStopReason((msg as Record<string, unknown>)["stopReason"]),
  };
}

export function mapPiUsage(usage: unknown): UsageInfo | undefined {
  if (usage === undefined || usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u["input"] === "number" ? (u["input"] as number) : 0;
  const output = typeof u["output"] === "number" ? (u["output"] as number) : 0;
  const cacheRead = typeof u["cacheRead"] === "number" ? (u["cacheRead"] as number) : 0;
  const cacheWrite = typeof u["cacheWrite"] === "number" ? (u["cacheWrite"] as number) : 0;
  const totalTokens = typeof u["totalTokens"] === "number" ? (u["totalTokens"] as number) : input + output;
  // Only return if any token count non-zero or total present to avoid empty usages
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && totalTokens === 0) {
    // Still return mapped zero usage if Pi provided an object — caller may want to record it
    // But to keep ChatResponse usage optional, return undefined for zero to match ScriptedTransport
    // Check if usage object had at least some meaningful keys
    if (u["input"] === undefined && u["output"] === undefined) return undefined;
  }
  return {
    PromptTokens: input,
    CompletionTokens: output,
    CacheReadTokens: cacheRead,
    CacheWriteTokens: cacheWrite,
    TotalTokens: totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Create options — mirrors spike/feasibility-v2.ts setup
// ---------------------------------------------------------------------------

export interface CreatePiTransportForFileOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly tools: readonly ToolDef[];
  /**
   * Host-registered but initially inactive terminal tools. They become visible
   * only when a request explicitly selects them (review filtering).
   */
  readonly supplementalTools?: readonly ToolDef[];
  /** Public Pi model selected by ModelRuntime, never a provider string. */
  readonly model?: NonNullable<Parameters<typeof createAgentSession>[0]>["model"];
  /** Matching public runtime that owns credentials and custom models. */
  readonly modelRuntime?: ModelRuntime;
  /** Pi thinking level parsed from the public provider/model:level selector. */
  readonly thinkingLevel?: NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"];
  /** Optional session affinity id for SessionManager (maps to prompt_cache_key / x-session-affinity via Pi providers). */
  readonly sessionId?: string;
  /** Optional retry collector for per-round observability; one Pi request = one attempt. */
  readonly retryCollector?: RetryCollector;
}

// ---------------------------------------------------------------------------
// PiTransport — LlmTransport over a single AgentSession
// ---------------------------------------------------------------------------

/**
 * PiTransport implements `LlmTransport` over one Pi `AgentSession`.
 *
 * Design: ONE Pi `AgentSession` per file conversation, isolated via
 * `SessionManager.inMemory()` (feasibility row 8). The constructor takes an
 * already-created session so callers (or `createPiTransportForFile`) control
 * isolation, `agentDir`, and `model` selection. `complete()` is the per-round
 * seam: it translates `ChatRequest.messages` + `tools` into Pi primitives and
 * waits for the next assistant turn.
 */
export class PiTransport implements TranscriptLlmTransport {
  private readonly session: PiSession;
  private readonly sessionManager: ReturnType<typeof SessionManager.inMemory> | undefined;
  private readonly promptRef: { current: string | undefined } | undefined;
  private readonly retryCollector: RetryCollector | undefined;
  private completeChain: Promise<unknown> = Promise.resolve();

  constructor(session: PiSession, promptRef?: { current: string | undefined }, sessionManager?: ReturnType<typeof SessionManager.inMemory>, retryCollector?: RetryCollector) {
    this.session = session;
    this.promptRef = promptRef;
    this.sessionManager = sessionManager;
    this.retryCollector = retryCollector;
  }

  /** Domain-safe identity for manifests and resume validation. */
  modelIdentity(): PiModelIdentity | undefined {
    const model = (this.session as unknown as { model?: { provider?: unknown; id?: unknown } }).model;
    if (typeof model?.provider !== "string" || typeof model.id !== "string") return undefined;
    return { provider: model.provider, model: model.id };
  }

  /** Dispose the underlying Pi session — await to surface cleanup failure. */
  async dispose(): Promise<void> {
    const sess = this.session as unknown as { dispose?: () => Promise<void>; abort?: () => Promise<void> };
    if (typeof sess.dispose === "function") {
      await sess.dispose();
    } else if (typeof sess.abort === "function") {
      await sess.abort();
    }
  }

  /** Forward abort without swallowing rejection. */
  async abort(): Promise<void> {
    const sess = this.session as unknown as { abort?: () => Promise<void> };
    if (typeof sess.abort === "function") {
      await sess.abort();
    }
  }

  async complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  async complete(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse>;
  async complete(
    a: ChatRequest | AbortSignal,
    b: ChatRequest | AbortSignal,
  ): Promise<ChatResponse> {
    const { req, signal } = normalizeCompleteArgs(a, b);

    if (signal.aborted) throw abortErrorFromSignal(signal);

    const meta = (req as unknown as { requestMeta?: import("../retry/meta.js").RequestMeta }).requestMeta;
    const collector = this.retryCollector;
    const valid = meta !== undefined && collector !== undefined && isValidRequestMeta(meta as import("../retry/meta.js").RequestMeta);
    const startedAt = valid ? Date.now() : 0;

    const runComplete = async (): Promise<ChatResponse> => {
      try {
        const res = await this.doComplete(req, signal);
        if (valid) {
          const endedAt = Date.now();
          const expectsToolCall = req.tools !== undefined && req.tools.length > 0;
          const emptyToolCallResponse = expectsToolCall && res.toolCalls.length === 0;
          if (emptyToolCallResponse) {
            // Treat empty tool-call response as provider error so retry_report is observable.
            // This mirrors OCR's boundary handling where truncated/empty responses are classified.
            collector!.recordAttempt(meta as import("../retry/meta.js").RequestMeta, { errorClass: ErrorClassProvider as never, failurePhase: FailurePhaseResponseStatus as never, statusCode: 200 }, startedAt, endedAt);
            collector!.finalize(meta as import("../retry/meta.js").RequestMeta, new Error("no tool calls in response"), false);
          } else {
            collector!.recordAttempt(meta as import("../retry/meta.js").RequestMeta, { statusCode: 200 }, startedAt, endedAt);
            let isCancelled = false;
            if (signal.aborted) {
              const reason = (signal as unknown as { reason?: unknown }).reason;
              isCancelled = reason === undefined ? true : isAbortError(reason);
            }
            collector!.finalize(meta as import("../retry/meta.js").RequestMeta, null, isCancelled);
          }
        }
        return res;
      } catch (err) {
        if (valid) {
          const endedAt = Date.now();
          const { errorClass, failurePhase, recognized } = classifyBoundaryError(err);
          let ec: string = errorClass as unknown as string;
          let fp: string = failurePhase as unknown as string;
          if (!recognized || ec === "" ) {
            const c = classifyAttempt({ statusCode: 0, err });
            ec = c.errorClass as string;
            fp = c.failurePhase as string;
          }
          collector!.recordAttempt(meta as import("../retry/meta.js").RequestMeta, { errorClass: ec as never, failurePhase: fp as never }, startedAt, endedAt);
          // Any abort of the request signal — bare abort, run cancellation
          // ("review was cancelled"), or the per-file deadline ("file task
          // timeout") — cancels the request; it is not a provider failure.
          const cancelled = isAbortError(err) || signal.aborted;
          collector!.finalize(meta as import("../retry/meta.js").RequestMeta, err, cancelled);
        }
        throw err;
      }
    };

    const chained = this.completeChain.then(runComplete, runComplete);
    this.completeChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  private async doComplete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    const expectsToolCall = req.tools !== undefined && req.tools.length > 0;

    // Session affinity: per-request sessionId maps to Pi's prompt_cache_key / x-session-affinity
    // via SessionManager id (public NewSessionOptions.id). Update manager before driving turn.
    if (req.sessionId !== undefined && req.sessionId !== "" && this.sessionManager !== undefined) {
      try {
        const currentId = this.sessionManager.getSessionId();
        if (currentId !== req.sessionId) {
          this.sessionManager.newSession({ id: req.sessionId });
        }
      } catch {
        // ignore: session affinity is best-effort
      }
    }

    // -----------------------------------------------------------------
    // 1) Dynamic allowlist — sync req.tools via setActiveToolsByName
    //    before each turn (feasibility row 3). Must happen before prompt.
    // -----------------------------------------------------------------
    // Extract OCR system prompt for this turn — will be set as Pi systemPrompt via ResourceLoader
    const ocrSystemTexts = req.messages
      .filter((m) => m.role === "system")
      .map((m) => extractOcrText(m))
      .filter((t) => t.length > 0)
      .join("\n\n");
    if (this.promptRef !== undefined && ocrSystemTexts.length > 0) {
      this.promptRef.current = ocrSystemTexts;
    }

    const sess = this.session as unknown as Partial<ActiveToolSession>;
    if (typeof sess.setActiveToolsByName !== "function" || typeof sess.getActiveToolNames !== "function") {
      throw new Error("Pi session does not expose public active-tool verification APIs");
    }
    activateToolsFailClosed(
      sess as ActiveToolSession,
      req.tools?.map((tool) => tool.function.name) ?? [],
    );

    // -----------------------------------------------------------------
    // 2) Abort forwarding — forward AbortSignal -> session.abort()
    //    (feasibility row 9). Use once:true and cleanup. Await rejection.
    // -----------------------------------------------------------------
    const sessForAbort = this.session as unknown as { abort?: () => Promise<void> };
    const abortHandler = (): void => {
      if (typeof sessForAbort.abort === "function") {
        void sessForAbort.abort().catch(() => {
          console.warn("[pi-adapter] session abort failed stage=abort_signal");
        });
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    // If already aborted after listener attach, trigger immediately
    if (signal.aborted) abortHandler();

    try {
      // Quick abort check before driving session
      if (signal.aborted) throw abortErrorFromSignal(signal);

      // -----------------------------------------------------------------
      // 3) History sync via session.state.messages replacement when needed
      //    (for compression, feasibility row 7). Translate req.messages
      //    (excluding the last user message that will be sent via
      //    prompt/followUp) into Pi AgentMessage[] and replace
      //    session.state.messages if it diverges.
      // -----------------------------------------------------------------
      const sessAny = this.session as unknown as {
        agent?: { state?: { messages?: unknown[] } };
        isIdle?: boolean;
        isStreaming?: boolean;
        subscribe?: (l: (e: unknown) => void) => () => void;
        waitForIdle?: () => Promise<void>;
        prompt?: (text: string, opts?: unknown) => Promise<void>;
        followUp?: (text: string, imgs?: unknown) => Promise<void>;
      };

      const getStateMessages = (): unknown[] => {
        if (sessAny.agent?.state !== undefined && Array.isArray(sessAny.agent.state.messages)) return sessAny.agent.state.messages;
        return [];
      };

      const setStateMessages = (msgs: unknown[]): void => {
        if (sessAny.agent?.state === undefined || !Array.isArray(sessAny.agent.state.messages)) {
          throw new Error("Pi session does not expose public agent state history replacement");
        }
        sessAny.agent.state.messages = msgs;
        if (sessAny.agent.state.messages.length !== msgs.length
          || sessAny.agent.state.messages.some((message, index) => JSON.stringify(message) !== JSON.stringify(msgs[index]))) {
          throw new Error("Pi agent state history replacement was not applied");
        }
      };

      if (req.messages.length > 0 && typeof sessAny.subscribe === "function" && typeof sessAny.prompt === "function") {
        const last = req.messages[req.messages.length - 1];
        const lastIsUser = last !== undefined && last.role === "user";
        // For round 1 (lastIsUser): exclude the last user message from history —
        // it will be sent via prompt(). For round 2+ (last is tool/assistant):
        // include the full history — agent.continue() will run without adding a
        // new user message, matching OCR's message array exactly.
        const historySlice: readonly Message[] = lastIsUser ? req.messages.slice(0, -1) : req.messages;

      if (historySlice.length === 0) {
          const current = getStateMessages();
          if (current.length !== 0) setStateMessages([]);
        } else {
          const expected = ocrMessagesToPiMessages(historySlice);
          const current = getStateMessages();
          let needsReplace = current.length !== expected.length;
          if (!needsReplace) {
            for (let i = 0; i < current.length; i++) {
              // Shallow JSON compare is deterministic for these shapes and avoids deep Pi type dependency
              if (JSON.stringify(current[i]) !== JSON.stringify(expected[i])) {
                needsReplace = true;
                break;
              }
            }
          }
          if (needsReplace) {
            setStateMessages(expected);
          }
        }
      }

      // -----------------------------------------------------------------
      // 4) Extract last user message text (ContentBlock|string support)
      // -----------------------------------------------------------------
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      const promptText: string =
        lastUser !== undefined ? extractOcrTextFromContent(lastUser.content as string | readonly { readonly type: string; readonly text?: string }[]) : "";

      // -----------------------------------------------------------------
      // 5) Subscribe for turn_end/agent_end to capture assistant content
      //    + tool_calls, translate to ChatResponse. Wait for waitForIdle
      //    before resolving so round accounting is settled (row 1).
      //    The subscription must be installed before prompt.
      // -----------------------------------------------------------------
      // If the session does not expose the real Pi API (e.g., in unit tests
      // with a fake session), fall back to the stub empty response so the
      // transport remains usable without a live model.
      const hasPiApi =
        typeof sessAny.subscribe === "function" &&
        typeof sessAny.waitForIdle === "function" &&
        (typeof sessAny.prompt === "function" || typeof sessAny.followUp === "function");

      if (!hasPiApi) {
        // Stub fallback — preserve prior stub behavior for tests that inject
        // a minimal fake session.
        void promptText;
        if (expectsToolCall) {
          console.warn("[pi-adapter] no tool calls kind=session_error source=none stage=api_unavailable");
        }
        const placeholder: ChatResponse = { content: "", toolCalls: [], usage: undefined };
        return placeholder;
      }

      let capturedContent = "";
      let capturedToolCalls: ToolCall[] = [];
      let capturedUsage: UsageInfo | undefined = undefined;
      let assistantObservation: PiAssistantObservation | undefined;
      let assistantSource: "turn_end" | "agent_end" | "state" | "none" = "none";
      let invocationFailureStage: "prompt" | "follow_up" | "continue" | "wait_for_idle" | undefined;
      let invocationError: Error | undefined;
      let turnEnded = false;
      const stateMessageCountBeforeDrive = getStateMessages().length;

      let capturedReasoning = "";
      const captureAssistant = (
        message: unknown,
        source: "turn_end" | "agent_end" | "state",
      ): void => {
        const observation = inspectPiAssistant(message);
        assistantObservation = observation;
        assistantSource = source;
        // OCR ChatResponse.Content() fallback: empty content falls back to reasoningContent, with think-tag stripping
        let text = observation.text.trim() === "" ? observation.reasoningText : observation.text;
        // Ensure think tags stripped on fallback path as well (inspect already does)
        text = text.trim() === "" ? "" : text;
        capturedContent = text;
        capturedReasoning = observation.reasoningText;
        capturedToolCalls = observation.toolCalls;
        capturedUsage = mapPiUsage((message as Record<string, unknown>)["usage"]);
      };

      const abortSession = (): void => {
        try {
          const s = this.session as unknown as { abort?: () => void };
          if (typeof s.abort === "function") s.abort();
        } catch {
          // ignore
        }
      };

      const unsubscribe = (sessAny.subscribe as (l: (e: unknown) => void) => () => void)((event: unknown) => {
        const e = event as Record<string, unknown>;
        if (e["type"] === "turn_end") {
          if (turnEnded) {
            // SDK may emit a second turn_end after an aborted recovery turn;
            // keep the first captured assistant message.
            return;
          }
          turnEnded = true;
          const msg = e["message"];
          if (msg !== undefined) {
            captureAssistant(msg, "turn_end");
          }
          // Fenced round accounting: one complete() call = one provider request.
          // The SDK's internal tool loop is halted after the assistant message is
          // captured. Runner will execute tool calls itself and supply real tool
          // results on the next complete() call, mirroring OCR's per-round loop.
          abortSession();
        } else if (e["type"] === "agent_end") {
          const msgs = e["messages"] as unknown[] | undefined;
          if (!turnEnded && Array.isArray(msgs)) {
            const newMessages = msgs.slice(stateMessageCountBeforeDrive);
            const lastAssistant = [...newMessages].reverse().find((m) => (m as Record<string, unknown>)["role"] === "assistant");
            if (lastAssistant !== undefined) {
              captureAssistant(lastAssistant, "agent_end");
            }
          }
          // If still no usage but we captured content, try last assistant usage from messages
          if (capturedUsage === undefined && Array.isArray(msgs)) {
            const lastWithUsage = [...msgs].reverse().find((m) => (m as Record<string, unknown>)["usage"] !== undefined);
            if (lastWithUsage !== undefined) capturedUsage = mapPiUsage((lastWithUsage as Record<string, unknown>)["usage"]);
          }
        }
      });

      try {
        if (signal.aborted) throw abortErrorFromSignal(signal);

        // Drive Pi: use prompt() for round 1 (last message is user), or
        // agent.continue() for round 2+ (last message is tool result).
        // prompt() adds a new user message and runs the loop; continue()
        // runs the loop from the existing transcript without adding a user
        // message, matching OCR's message array exactly.
        const lastReqMsg = req.messages[req.messages.length - 1];
        const lastIsUser = lastReqMsg !== undefined && lastReqMsg.role === "user";
        const sessAgent = (this.session as unknown as { agent?: { continue?: () => Promise<void> } }).agent;

        if (lastIsUser || sessAgent === undefined || typeof sessAgent.continue !== "function") {
          // Round 1 or no agent.continue available: use prompt()
          const isIdle = sessAny.isIdle !== undefined ? sessAny.isIdle : true;
          if (isIdle) {
            await (sessAny.prompt as (t: string) => Promise<void>)(promptText).catch((error: unknown) => {
              if (!turnEnded) {
                invocationFailureStage = "prompt";
                invocationError = error instanceof Error ? error : new Error(String(error));
              }
            });
          } else {
            const followUp = sessAny.followUp as ((t: string) => Promise<void>) | undefined;
            if (typeof followUp === "function") {
              await followUp(promptText).catch((error: unknown) => {
                if (!turnEnded) {
                  invocationFailureStage = "follow_up";
                  invocationError = error instanceof Error ? error : new Error(String(error));
                }
              });
            } else {
              await (sessAny.prompt as (t: string) => Promise<void>)(promptText).catch((error: unknown) => {
                if (!turnEnded) {
                  invocationFailureStage = "prompt";
                  invocationError = error instanceof Error ? error : new Error(String(error));
                }
              });
            }
          }
        } else {
          // Round 2+: continue from the existing transcript (no new user message)
          await sessAgent.continue().catch((error: unknown) => {
            if (!turnEnded) {
              invocationFailureStage = "continue";
              invocationError = error instanceof Error ? error : new Error(String(error));
            }
          });
        }

        // Wait until Pi is idle so turn_end accounting is settled before the
        // next complete() call (row 1). Abort after turn_end will cause prompt/
        // continue to reject; catch so we can use the captured assistant message.
        if (typeof sessAny.waitForIdle === "function") {
          await sessAny.waitForIdle().catch((error: unknown) => {
            if (!turnEnded) {
              invocationFailureStage = "wait_for_idle";
              invocationError = error instanceof Error ? error : new Error(String(error));
            }
          });
        }

        if (signal.aborted) throw abortErrorFromSignal(signal);

        // Fallback: if no turn_end was observed (e.g., empty history path),
        // derive response from current state messages.
        if (!turnEnded) {
          const newMessages = getStateMessages().slice(stateMessageCountBeforeDrive);
          const lastAssistant = [...newMessages].reverse().find((m) => (m as Record<string, unknown>)["role"] === "assistant");
          if (lastAssistant !== undefined) {
            captureAssistant(lastAssistant, "state");
          }
        }

        if (invocationFailureStage !== undefined) {
          const message = `Pi session ${invocationFailureStage.replaceAll("_", " ")} failed before an assistant response`;
          throw new Error(
            message,
            invocationError === undefined ? undefined : { cause: invocationError },
          );
        }
        if (assistantObservation?.stopReason === "error" || assistantObservation?.stopReason === "aborted") {
          throw new Error(`Pi assistant turn ended with stop reason ${assistantObservation.stopReason}`);
        }

        if (expectsToolCall && capturedToolCalls.length === 0) {
          if (assistantObservation === undefined) {
            console.warn("[pi-adapter] no tool calls kind=missing_assistant_event source=none");
          } else {
            const kind =
              assistantObservation.invalidToolBlocks > 0
                ? "tool_call_extraction_failed"
                : assistantObservation.text.length > 0
                    ? "assistant_text_only"
                    : "assistant_empty";
            console.warn(
              `[pi-adapter] no tool calls kind=${kind} source=${assistantSource}` +
                ` stop_reason=${assistantObservation.stopReason}` +
                ` text=${assistantObservation.text.length > 0 ? "present" : "empty"}` +
                ` tool_blocks=${assistantObservation.toolBlocks}` +
                ` invalid_tool_blocks=${assistantObservation.invalidToolBlocks}`,
            );
          }
        }

        const response: ChatResponse = {
          content: capturedContent,
          reasoningContent: capturedReasoning !== "" ? capturedReasoning : undefined,
          toolCalls: capturedToolCalls,
          usage: capturedUsage,
        };
        return response;
      } finally {
        unsubscribe();
      }
    } finally {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — one isolated session per file, matching spike setup
// ---------------------------------------------------------------------------

/**
 * Create a `PiTransport` for one file conversation.
 *
 * Mirrors the spike harness (`spike/feasibility-v2.ts`):
 * - `SessionManager.inMemory()` for per-file isolation (row 8).
 * - `SettingsManager.inMemory({ compaction:{enabled:false},
 *   retry:{enabled:false}})` to disable Pi auto-compaction/retry; the
 *   OCR engine controls compression (row 7) and retry explicitly.
 * - `customTools` derived from `ToolDef[]` via `Type.Object` schemas
 *   (typebox), as in the spike's `customTools` construction.
 */
export async function createPiTransportForFile(
  options: CreatePiTransportForFileOptions,
): Promise<PiTransport> {
  const { cwd, agentDir, tools, supplementalTools = [], model, modelRuntime, thinkingLevel, sessionId, retryCollector } = options;
  assertUniqueToolNames(tools, supplementalTools);

  const sessionManager = sessionId !== undefined && sessionId !== "" ? SessionManager.inMemory(cwd, { id: sessionId }) : SessionManager.inMemory(cwd);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    enableSkillCommands: false,
    packages: [],
  } as unknown as Parameters<typeof SettingsManager.inMemory>[0]);
  // Explicitly disable discovery that could load AGENTS.md/skills/extensions via cwd
  try {
    settingsManager.setExtensionPaths([]);
    settingsManager.setSkillPaths([]);
    settingsManager.setPromptTemplatePaths([]);
    settingsManager.setThemePaths([]);
    settingsManager.setEnableSkillCommands(false);
  } catch (error: unknown) {
    console.warn("[pi-adapter] settingsManager extension reset failed", error);
  }

  const promptRef = { current: undefined as string | undefined };
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload();
  const originalGetSystemPrompt = resourceLoader.getSystemPrompt.bind(resourceLoader);
  (resourceLoader as unknown as { getSystemPrompt: () => string | undefined }).getSystemPrompt = (): string | undefined => {
    if (promptRef.current !== undefined && promptRef.current.length > 0) return promptRef.current;
    return originalGetSystemPrompt();
  };

  const customTools = [...tools, ...supplementalTools].map((def) => {
    const name = def.function.name;
    const description = def.function.description ?? `Tool ${name}`;
    const parameters = toPiToolParameters(def.function.parameters);
    return {
      name,
      label: name,
      description,
      parameters,
      execute: async (): Promise<{ content: { type: string; text: string }[]; details: unknown; terminate?: boolean }> => {
        // Host-side tool execution is owned by Runner, not by Pi's loop.
        // Return a neutral placeholder and signal terminate so that one
        // `prompt` corresponds to one OCR round (one model request) rather
        // than Pi auto-continuing to a second provider request with stub
        // results. The Runner will capture tool_calls via turn_end and
        // provide real tool results on the next `complete()` call where
        // host replaces session.state.messages with OCR's true history.
        // All tools in the batch must set terminate:true for Pi to stop
        // after the batch (see pi-agent-core types).
        return {
          content: [{ type: "text", text: `stub result for ${name}` }],
          details: {},
          terminate: true,
        };
      },
    };
  });

  const allowedNames = tools.map((t) => t.function.name);
  const registeredNames = [...tools, ...supplementalTools].map((t) => t.function.name);

  const createOpts: Record<string, unknown> = {
    cwd,
    agentDir,
    sessionManager,
    settingsManager,
    resourceLoader,
    customTools,
    tools: registeredNames,
  };
  if (model !== undefined) {
    createOpts["model"] = model;
  }
  if (modelRuntime !== undefined) {
    createOpts["modelRuntime"] = modelRuntime;
  }
  if (thinkingLevel !== undefined) {
    createOpts["thinkingLevel"] = thinkingLevel;
  }

  const { session } = await createAgentSession(createOpts as unknown as Parameters<typeof createAgentSession>[0]);
  try {
    activateToolsFailClosed(session as unknown as ActiveToolSession, allowedNames);
  } catch (error) {
    const disposable = session as unknown as { dispose?: () => Promise<void>; abort?: () => Promise<void> };
    try {
      if (typeof disposable.dispose === "function") await disposable.dispose();
      else if (typeof disposable.abort === "function") await disposable.abort();
    } catch {
      // Preserve the activation failure: a session that cannot be narrowed is never returned.
    }
    throw error;
  }
  return new PiTransport(session as PiSession, promptRef, sessionManager, retryCollector);
}

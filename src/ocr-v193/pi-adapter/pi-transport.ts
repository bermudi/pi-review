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
 * (`src/ocr-v193/llmloop/transcript.ts` / `types.ts`) to the public Pi SDK
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

import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Message, ToolCall } from "../llmloop/compression.js";
import type { ChatRequest, ChatResponse, ToolDef, UsageInfo } from "../llmloop/types.js";
import type { LlmTransport as TranscriptLlmTransport } from "../llmloop/transcript.js";

// ---------------------------------------------------------------------------
// Pi session type — derived from public factory return without deep import.
// ---------------------------------------------------------------------------

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

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
  if (typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>;
    if (typeof rec["type"] === "string" || typeof rec["properties"] === "object") {
      return raw;
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

// ---------------------------------------------------------------------------
// OCR Message -> Pi AgentMessage translation helpers
// ---------------------------------------------------------------------------

function extractOcrText(msg: Message): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    let out = "";
    for (const block of c as readonly { readonly type: string; readonly text?: string; readonly content?: readonly unknown[] }[]) {
      if (typeof block.text === "string") {
        out += block.text;
      } else if (Array.isArray((block as unknown as { content?: unknown }).content)) {
        // Nested content blocks (recursive)
        for (const nested of (block as unknown as { content: readonly { readonly text?: string }[] }).content) {
          out += nested.text ?? "";
        }
      }
    }
    return out;
  }
  return "";
}

function extractOcrTextFromContent(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
  if (typeof content === "string") return content;
  let out = "";
  for (const b of content) out += b.text ?? "";
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

function extractPiAssistantText(msg: unknown): string {
  const m = msg as { content?: unknown };
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    let out = "";
    for (const block of c as readonly { type?: string; text?: string }[]) {
      if (block.type === "text" && typeof block.text === "string") out += block.text;
    }
    return out;
  }
  return "";
}

function extractPiToolCalls(msg: unknown): ToolCall[] {
  const m = msg as { content?: unknown };
  const c = m.content;
  if (!Array.isArray(c)) return [];
  const out: ToolCall[] = [];
  for (const block of c as readonly { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
    if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
      let argsStr: string;
      const args = (block as { arguments?: unknown }).arguments;
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
  return out;
}

function mapPiUsage(usage: unknown): UsageInfo | undefined {
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
  readonly model?: unknown;
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

  constructor(session: PiSession) {
    this.session = session;
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

    if (signal.aborted) throw createAbortError();

    // -----------------------------------------------------------------
    // 1) Dynamic allowlist — sync req.tools via setActiveToolsByName
    //    before each turn (feasibility row 3). Must happen before prompt.
    // -----------------------------------------------------------------
    if (req.tools !== undefined) {
      const names = req.tools.map((t) => t.function.name);
      const sess = this.session as unknown as {
        setActiveToolsByName?: (names: string[]) => void;
        getActiveToolNames?: () => string[];
      };
      if (typeof sess.setActiveToolsByName === "function") {
        try {
          sess.setActiveToolsByName(names);
          // Verify allowlist took effect when getter available (feasibility row 3)
          if (typeof sess.getActiveToolNames === "function") {
            const active = sess.getActiveToolNames();
            if (active.length !== names.length || !names.every((n) => active.includes(n))) {
              console.warn(`[pi-adapter] allowlist mismatch: expected ${names.join(",")} got ${active.join(",")}`);
            }
          }
        } catch {
          // Non-fatal — allow request to proceed with previous allowlist
        }
      }
    }

    // Set OCR system prompt as Pi systemPrompt via public state — avoids generic Pi prompt injection.
    // Must happen after setActiveToolsByName which rebuilds the generic prompt.
    const ocrSystemTexts = req.messages
      .filter((m) => m.role === "system")
      .map((m) => extractOcrText(m))
      .filter((t) => t.length > 0)
      .join("\n\n");
    if (ocrSystemTexts.length > 0) {
      try {
        const sessForSystem = this.session as unknown as { state?: { systemPrompt?: string } };
        if (sessForSystem.state !== undefined) {
          sessForSystem.state.systemPrompt = ocrSystemTexts;
        }
      } catch {
        // ignore — fallback is generic prompt, but deep compare will then report mismatch
      }
    }

    // -----------------------------------------------------------------
    // 2) Abort forwarding — forward AbortSignal -> session.abort()
    //    (feasibility row 9). Use once:true and cleanup. Await rejection.
    // -----------------------------------------------------------------
    const sessForAbort = this.session as unknown as { abort?: () => Promise<void> };
    const abortHandler = (): void => {
      if (typeof sessForAbort.abort === "function") {
        void sessForAbort.abort().catch((e) => {
          console.warn(`[pi-adapter] abort failed: ${String(e)}`);
        });
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    // If already aborted after listener attach, trigger immediately
    if (signal.aborted) abortHandler();

    try {
      // Quick abort check before driving session
      if (signal.aborted) throw createAbortError();

      // -----------------------------------------------------------------
      // 3) History sync via session.state.messages replacement when needed
      //    (for compression, feasibility row 7). Translate req.messages
      //    (excluding the last user message that will be sent via
      //    prompt/followUp) into Pi AgentMessage[] and replace
      //    session.state.messages if it diverges.
      // -----------------------------------------------------------------
      const sessAny = this.session as unknown as {
        state?: { messages?: unknown[] };
        messages?: unknown[];
        agent?: { state?: { messages?: unknown[] } };
        isIdle?: boolean;
        isStreaming?: boolean;
        subscribe?: (l: (e: unknown) => void) => () => void;
        waitForIdle?: () => Promise<void>;
        prompt?: (text: string, opts?: unknown) => Promise<void>;
        followUp?: (text: string, imgs?: unknown) => Promise<void>;
      };

      const getStateMessages = (): unknown[] => {
        if (sessAny.state !== undefined && Array.isArray(sessAny.state.messages)) return sessAny.state.messages;
        if (Array.isArray(sessAny.messages)) return sessAny.messages as unknown[];
        return [];
      };

      const setStateMessages = (msgs: unknown[]): void => {
        // Public path: session.state.messages (feasibility row 7, public `get state(): AgentState`)
        try {
          if (sessAny.state !== undefined && "messages" in sessAny.state) {
            (sessAny.state as { messages: unknown[] }).messages = msgs;
          }
        } catch {
          // ignore
        }
        // Fallback for alternate shape exposed by some SDK builds
        try {
          if (Array.isArray(sessAny.messages)) (sessAny as unknown as { messages: unknown[] }).messages = msgs;
        } catch {}
      };

      if (req.messages.length > 0 && typeof sessAny.subscribe === "function" && typeof sessAny.prompt === "function") {
        const last = req.messages[req.messages.length - 1];
        const lastIsUser = last !== undefined && last.role === "user";
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
          if (needsReplace) setStateMessages(expected);
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
        const placeholder: ChatResponse = { content: "", toolCalls: [], usage: undefined };
        return placeholder;
      }

      let capturedContent = "";
      let capturedToolCalls: ToolCall[] = [];
      let capturedUsage: UsageInfo | undefined = undefined;
      let turnEnded = false;

      const unsubscribe = (sessAny.subscribe as (l: (e: unknown) => void) => () => void)((event: unknown) => {
        const e = event as Record<string, unknown>;
        if (e["type"] === "turn_end") {
          turnEnded = true;
          const msg = e["message"];
          if (msg !== undefined) {
            capturedContent = extractPiAssistantText(msg);
            capturedToolCalls = extractPiToolCalls(msg);
            capturedUsage = mapPiUsage((msg as Record<string, unknown>)["usage"]);
          }
        } else if (e["type"] === "agent_end") {
          const msgs = e["messages"] as unknown[] | undefined;
          if (!turnEnded && Array.isArray(msgs)) {
            const lastAssistant = [...msgs].reverse().find((m) => (m as Record<string, unknown>)["role"] === "assistant");
            if (lastAssistant !== undefined) {
              capturedContent = extractPiAssistantText(lastAssistant);
              capturedToolCalls = extractPiToolCalls(lastAssistant);
              const usage = (lastAssistant as Record<string, unknown>)["usage"];
              if (usage !== undefined) capturedUsage = mapPiUsage(usage);
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
        if (signal.aborted) throw createAbortError();

        // Drive Pi via prompt when idle, otherwise followUp.
        // `steer` is not used for idle empty-round recovery per row 6 gap.
        const isIdle = sessAny.isIdle !== undefined ? sessAny.isIdle : true;
        if (isIdle) {
          await (sessAny.prompt as (t: string) => Promise<void>)(promptText);
        } else {
          // While streaming, followUp queues after current turn; this matches
          // the feasibility note that steer is only for mid-stream.
          const followUp = sessAny.followUp as ((t: string) => Promise<void>) | undefined;
          if (typeof followUp === "function") {
            await followUp(promptText);
          } else {
            await (sessAny.prompt as (t: string) => Promise<void>)(promptText);
          }
        }

        // Wait until Pi is idle so turn_end accounting is settled before the
        // next complete() call (row 1). Forward abort will wake this via session.abort().
        if (typeof sessAny.waitForIdle === "function") {
          await sessAny.waitForIdle();
        }

        if (signal.aborted) throw createAbortError();

        // Fallback: if no turn_end was observed (e.g., empty history path),
        // derive response from current state messages.
        if (!turnEnded) {
          const msgs = getStateMessages();
          const lastAssistant = [...msgs].reverse().find((m) => (m as Record<string, unknown>)["role"] === "assistant");
          if (lastAssistant !== undefined) {
            capturedContent = extractPiAssistantText(lastAssistant);
            capturedToolCalls = extractPiToolCalls(lastAssistant);
            const usage = (lastAssistant as Record<string, unknown>)["usage"];
            if (usage !== undefined) capturedUsage = mapPiUsage(usage);
          }
        }

        const response: ChatResponse = {
          content: capturedContent,
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
  const { cwd, agentDir, tools, model } = options;

  const sessionManager = SessionManager.inMemory();
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
  } catch {
    // ignore if not available
  }

  const customTools = tools.map((def) => {
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

  const createOpts: Record<string, unknown> = {
    cwd,
    agentDir,
    sessionManager,
    settingsManager,
    customTools,
    tools: allowedNames,
  };
  if (model !== undefined) {
    createOpts["model"] = model;
  }

  const { session } = await createAgentSession(createOpts as unknown as Parameters<typeof createAgentSession>[0]);

  return new PiTransport(session as PiSession);
}

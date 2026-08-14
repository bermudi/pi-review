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
 * thin stub with correct interfaces and exhaustive TODO mapping — see
 * `docs/pi-sdk-feasibility-report.md` and the inline gap notes.
 *
 * Public imports only: `createAgentSession`, `SessionManager`,
 * `SettingsManager` from `@earendil-works/pi-coding-agent`. No
 * `pi-agent-core` deep imports, no legacy `src/*` imports.
 */

import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Message } from "../llmloop/compression.js";
import type { ChatRequest, ChatResponse, ToolDef } from "../llmloop/types.js";
import type { LlmTransport as TranscriptLlmTransport } from "../llmloop/transcript.js";

// ---------------------------------------------------------------------------
// Pi session type — derived from public factory return without deep import.
// ---------------------------------------------------------------------------

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

// ---------------------------------------------------------------------------
// Helpers
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
    // Heuristic: already a JSON Schema / TypeBox schema (has `type` or `properties`)
    if (typeof rec["type"] === "string" || typeof rec["properties"] === "object") {
      return raw;
    }
  }
  // Fallback: transport carries opaque JSON Schema, but Pi expects a
  // TypeBox TSchema. For parity we wrap as empty object; callers that
  // need faithful schemas should pass a TypeBox schema in ToolDef.parameters.
  return Type.Object({});
}

// ---------------------------------------------------------------------------
// Create options — mirrors spike/feasibility-v2.ts setup
// ---------------------------------------------------------------------------

export interface CreatePiTransportForFileOptions {
  /**
   * Working directory for the file review. Each file gets its own
   * isolated `SessionManager.inMemory()` so concurrent per-file loops do
   * not share history (see feasibility row 8 — isolation).
   */
  readonly cwd: string;
  /**
   * Pi global config directory containing `models.json` / `auth.json`.
   * For tests this is a temporary directory pointing at a local
   * OpenAI-compatible server (see spike harness).
   */
  readonly agentDir: string;
  /** Tool definitions advertised to the model for this file. */
  readonly tools: readonly ToolDef[];
  /** Optional model override. When omitted Pi discovers via agentDir. */
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
 *
 * Current status: stub with correct shape and gap documentation. The
 * orchestration notes below map each feasibility row to the public Pi API
 * that will be wired when the loop is connected.
 */
export class PiTransport implements TranscriptLlmTransport {
  private readonly session: PiSession;

  constructor(session: PiSession) {
    this.session = session;
  }

  /**
   * One OCR round = one model request.
   *
   * Supports both call orders:
   * - transcript: `complete(req, signal)`
   * - types/Runner: `complete(signal, req)` / `CompletionsWithCtx(signal, req)`
   *
   * Runner's `callTransport` prefers `CompletionsWithCtx(signal, req)` then
   * `complete(signal, req)`. Transcript tests use `complete(req, signal)`.
   * This implementation normalizes both so the same instance works in either
   * context.
   */
  async complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  async complete(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse>;
  async complete(
    a: ChatRequest | AbortSignal,
    b: ChatRequest | AbortSignal,
  ): Promise<ChatResponse> {
    const { req, signal } = normalizeCompleteArgs(a, b);

    // Fast-path: already aborted
    if (signal.aborted) {
      // Mirror ScriptedTransport / fetch behavior
      try {
        throw new DOMException("Aborted", "AbortError");
      } catch {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
    }

    // -----------------------------------------------------------------------
    // Gap / TODO wiring — each block is annotated with the feasibility row
    // that proves the public API exists and the remaining host work.
    // -----------------------------------------------------------------------

    // 1) Round accounting (row 1): one assistant response with N tool_calls
    //    is ONE round, not N. Pi proves this via `session.subscribe` with
    //    `turn_end` (or `agent_end`) count vs `tool_execution_start` count.
    //    `Scripted.requests.length` must also equal `turn_end` count.
    //    TODO: capture `turn_end` count around this call and assert it
    //    increments by exactly one when the model returns.

    // 3) Dynamic allowlist (row 3): before the NEXT request, host can
    //    restrict tools to exactly `code_comment` + `task_done` via
    //    `session.setActiveToolsByName(names)`. Verified in spike:
    //    `setActiveToolsByName(["code_comment","task_done"])` on
    //    `turn_end===1` makes next POST's `tools.length===2` with those
    //    names. `getActiveToolNames()` and `getAllTools()` reflect it.
    //    TODO wiring:
    if (req.tools !== undefined) {
      const names = req.tools.map((t) => t.function.name);
      // Narrow to structural call without importing AgentSession type
      const sess = this.session as unknown as {
        setActiveToolsByName?: (names: string[]) => void;
      };
      if (typeof sess.setActiveToolsByName === "function") {
        sess.setActiveToolsByName(names);
      }
    }

    // 9) Timeout/abort (row 9): stall + abort.
    //    Public: `session.abort(): Promise<void>`, `session.waitForIdle()`,
    //    `session.isIdle` / `isStreaming`, plus forwarding `signal` to
    //    the underlying `streamFunction` via `SimpleStreamOptions.signal`.
    //    Spike proves `abort()` within 202ms settles `waitForIdle` and
    //    `isIdle===true`. Host must implement OCR's `ToolRequestWaitTimeMs`
    //    via `AbortSignal.timeout()` + `session.abort()`, not via Pi's
    //    provider `timeoutMs`.
    //    TODO: wire `signal.addEventListener("abort", () => session.abort())`
    //    and ensure cleanup removes listener.
    const abortHandler = (): void => {
      const sess = this.session as unknown as { abort?: () => Promise<void> };
      if (typeof sess.abort === "function") {
        void sess.abort();
      }
    };
    if (signal.aborted) {
      abortHandler();
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      // 2) Multi-tool turn (row 2): every tool call in one response is
      //    dispatched in OCR order and results appear as distinct `tool`
      //    messages in the next request's `messages`. Proved via
      //    `tool_execution_start`/`tool_execution_end` counts and
      //    inspection of `requests[1].body.messages`.
      //    TODO: no extra code needed — Pi does this, but host must not
      //    reorder tool_calls.

      // 4) Restricted grace round (row 4): exactly one additional request
      //    with only terminal tools; host-counted, no Pi built-in counter.
      //    Spike: budget=1 normal round (`file_read`) then host switches to
      //    terminal-only via `setActiveToolsByName`. Pi has no `graceRounds`
      //    counter, so host must fence: count `turn_end`, call
      //    `setActiveToolsByName` once, allow one grace `prompt`, then
      //    do not issue further `prompt`/`steer`. Usage of grace is
      //    counted, and a second grace does not happen without host
      //    steering. GAP: propose `AgentSession.setMaxTurns(n)` or
      //    `setShouldStopAfterTurn(fn)` (exists in `pi-agent-core` as
      //    `AgentLoopConfig.shouldStopAfterTurn` but not re-exported).
      //    TODO for grace case: caller (Runner.runGraceRound) will pass
      //    `tools` filtered via `graceRoundToolDefs()`, which this method
      //    already applies via `setActiveToolsByName` above. Host must
      //    ensure only one grace call is made.

      // 5) Cancelled grace (row 5): abort as budget ends -> no grace.
      //    Proved via `session.abort()` before grace `prompt`.
      //    TODO: if `signal` aborts before we enter grace, do not start
      //    next request; `waitForIdle` must settle.

      // 6) Empty-round recovery (row 6): two OCR paths:
      //    (a) `len(calls)==0` -> host must inject
      //        "You did not successfully call any tools..." via a new
      //        `prompt`/`followUp` (NOT `steer`; `steer` is "while
      //        streaming" per `agent-session.d.ts:376`, and after an
      //        empty response Pi is idle with `stopReason:"stop"`).
      //    (b) `hasValidResult==false` (tool calls with empty results) ->
      //        Pi automatically makes next request (tool results still
      //        sent), host counts `consecutiveEmptyRounds` and stops after
      //        3 with `StopEmptyRounds`. Spike row 6 shows `steer` while
      //        idle only triggers 1 extra request; `prompt`/`followUp`/
      //        `sendUserMessage` are the idle primitives. GAP: document
      //        `turn_end` = round contract and clarify `steer` vs
      //        `followUp` for idle empty recovery, or add
      //        `session.injectRetry(message)`.
      //    TODO: empty detection must be after capturing response; if
      //    empty, caller (Runner) appends retry user message and retries
      //    via `complete()` again (which will use `followUp` internally).

      // 7) OCR-controlled compression (row 7): host-controlled replacement
      //    via `session.agent.state.messages` (public through
      //    `session.state` getter `agent-session.d.ts:294` -> `AgentState`).
      //    `session.compact(customInstructions?)` exists but uses Pi's
      //    `SUMMARIZATION_SYSTEM_PROMPT` and `reserveTokens`/
      //    `keepRecentTokens` logic, not OCR's `MemoryCompressionTask`
      //    prompt + `<message>` XML `{{context}}` + `frozenEnd`/
      //    `compressEnd`/`activeZone` + failure keeps original. With tiny
      //    history `compact()` returns `Error: Nothing to compact`. Host
      //    must: compute `shouldCompact`/`prepareCompaction` via OCR
      //    thresholds, build `contextXML` via `buildMessageXML`, run a
      //    separate compression `AgentSession` with OCR prompt, then
      //    replace `agent.state.messages` with `frozen + summary +
      //    activeZone`. Next `POST`'s `messages` equals rebuilt. Proven in
      //    `feasibility-v3` via `session.agent.state.messages = rebuilt`
      //    and `steer` containing summary. GAP: Pi's `compact()` alone is
      //    not OCR-equivalent. Proposed addition: public
      //    `session.setTransformContext(fn)` or
      //    `session.compact({ prepare, generate })` overload; also
      //    re-export `shouldCompact`/`prepareCompaction`/
      //    `serializeConversation` from `coding-agent` (currently only
      //    via `pi-ai` deep import).
      //    TODO: this transport does not yet implement that replacement
      //    hook. Runner's `CompressionState` will drive it; when a
      //    `ChatResponse` indicates compression threshold, host will call
      //    the compression session and then mutate
      //    `session.agent.state.messages` before next `complete()`.

      // 8) Compression isolation (row 8): two concurrent sessions with
      //    separate `SessionManager.inMemory()` have distinct `sessionId`s
      //    and `messages`; `compact()` on A leaves B unchanged. Each
      //    holds its own `_compactionAbortController`. This `PiTransport`
      //    achieves isolation by requiring one `AgentSession` per file
      //    (see `createPiTransportForFile`).
      //    TODO: no code — construction guarantees it.

      // ---------------------------------------------------------------------
      // Actual Pi turn plumbing (stub).
      // ---------------------------------------------------------------------
      //
      // Pi's `AgentSession` does not expose a simple `complete(req)`:
      // it manages conversation internally via `prompt`/`followUp`/`steer`,
      // `subscribe` (`turn_end`/`tool_execution_start`/`agent_end`), and
      // `waitForIdle`. To implement `complete(req)` correctly we must:
      //
      // 1. Ensure `req.tools` already synced via `setActiveToolsByName`
      //    above (done).
      // 2. Translate `req.messages` (type `Message[]` from
      //    `src/ocr-v193/llmloop/compression.ts` — role/content/tool_calls)
      //    into Pi's `AgentMessage[]` or into a user prompt string for
      //    `session.prompt` / `session.followUp` / `session.sendUserMessage`.
      //    The simplest path for parity is to hold the full history in
      //    `session.state.messages` / `session.agent.state.messages` and
      //    replace it when `req.messages` diverges (see compression gap).
      //    For the initial stub we drive Pi via `session.prompt` with the
      //    last user message text extracted from `req.messages`.
      // 3. Subscribe for the next `turn_end` / `agent_end`, capture the
      //    assistant `content` + `tool_calls`, and translate back to
      //    `ChatResponse` (`content`, `toolCalls`, `usage`).
      // 4. `waitForIdle()` before resolving, so round accounting via
      //    `turn_end` is settled before the next `complete()` call.
      // 5. Forward `signal` -> `session.abort()` as above.
      //
      // Because this stub is intentionally not yet fully functional (see task
      // description), we return an empty response after wiring the allowlist
      // and abort handler, and we document the exact next steps. A
      // follow-up commit will replace the placeholder with subscribe +
      // prompt logic and a transcript-level test harness using a local
      // OpenAI-compatible server (as in `spike/feasibility-v2.ts`).

      // Extract last user message for placeholder prompt driving.
      const lastUser = [...req.messages].reverse().find((m: Message) => m.role === "user");
      const _promptText =
        lastUser !== undefined
          ? typeof lastUser.content === "string"
            ? lastUser.content
            // ContentBlocks -> extract text
            : (lastUser.content as readonly { readonly type: string; readonly text?: string }[])
                .map((b) => b.text ?? "")
                .join("")
          : "";

      // Placeholder: do not actually drive the session yet.
      // This keeps the stub deterministic and avoids needing a live model.
      // Uncomment and complete the wiring below when connecting the loop:
      //
      // const sess2 = this.session as unknown as {
      //   prompt: (text: string) => Promise<void>;
      //   followUp: (text: string) => Promise<void>;
      //   waitForIdle: () => Promise<void>;
      //   subscribe: (l: (e: unknown) => void) => () => void;
      //   isIdle: boolean;
      //   isStreaming: boolean;
      //   messages: readonly unknown[];
      //   state: { messages: unknown[] };
      //   agent: { state: { messages: unknown[] } };
      // };
      // let captured: ChatResponse | undefined;
      // let turnEnded = false;
      // const unsub = sess2.subscribe((event: unknown) => {
      //   const e = event as Record<string, unknown>;
      //   if (e["type"] === "turn_end" || e["type"] === "agent_end") {
      //     // capture e["message"] or e["messages"] -> translate to ChatResponse
      //     turnEnded = true;
      //   }
      // });
      // try {
      //   if (sess2.isIdle) {
      //     await sess2.prompt(_promptText);
      //   } else {
      //     await sess2.followUp(_promptText);
      //   }
      //   await sess2.waitForIdle();
      //   // translate last assistant message into ChatResponse
      // } finally {
      //   unsub();
      // }

      void _promptText;

      // Return empty placeholder — callers (Runner) treat empty toolCalls
      // as "no usable tool calls" and inject the OCR retry message
      // (see loop.ts consecutiveEmptyRounds). This keeps the stub safe
      // to import without hanging on a real model.
      const placeholder: ChatResponse = {
        content: "",
        toolCalls: [],
        usage: undefined,
      };
      return placeholder;
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
 *
 * The returned transport holds the created `AgentSession`; callers should
 * call `transport.dispose()` (via `session.dispose()`) when the file
 * review finishes to free resources.
 */
export async function createPiTransportForFile(
  options: CreatePiTransportForFileOptions,
): Promise<PiTransport> {
  const { cwd, agentDir, tools, model } = options;

  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  } as unknown as Parameters<typeof SettingsManager.inMemory>[0]);

  const customTools = tools.map((def) => {
    const name = def.function.name;
    const description = def.function.description ?? `Tool ${name}`;
    const parameters = toPiToolParameters(def.function.parameters);
    return {
      name,
      label: name,
      description,
      parameters,
      // Host-side tool execution is owned by Runner, not by Pi's loop.
      // This stub `execute` satisfies Pi's `ToolDefinition` contract
      // without performing real work; the parity engine will capture
      // `tool_calls` via `turn_end` before Pi's `execute` matters.
      // If Pi does dispatch, we return a neutral placeholder result.
      execute: async (): Promise<{ content: { type: string; text: string }[]; details: unknown }> => {
        return {
          content: [{ type: "text", text: `stub result for ${name}` }],
          details: {},
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

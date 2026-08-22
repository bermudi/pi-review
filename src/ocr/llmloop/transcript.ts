// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from seam concept (reference plan Phase 2 "Unit-level transcript runner") at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later
// See LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Provider-agnostic transcript seam for the OCR v1.9.3 parity engine.
 *
 * The engine depends only on `LlmTransport` — a narrow `complete()` seam —
 * so tests can drive the loop with `ScriptedTransport` without importing the
 * Pi SDK or the legacy review policy. This mirrors the Go `llm.LLMClient`
 * interface but is intentionally narrower: one method, AbortSignal-based
 * cancellation, and plain TypeScript types.
 *
 * The Pi adapter (src/ocr/pi-adapter) will implement the same interface
 * using Pi's public session APIs (setActiveToolsByName, turn_end,
 * AbortSignal, session.state.messages replacement). The engine never imports
 * Pi directly.
 */

import type { ChatRequest, ChatResponse } from "./types.js";
import type { ToolCall } from "./compression.js";

// ---------------------------------------------------------------------------
// Transport interface — provider-agnostic
// ---------------------------------------------------------------------------

/**
 * LlmTransport is the provider-agnostic seam for one model turn.
 * Mirrors `llm.LLMClient.CompletionsWithCtx` but uses AbortSignal for
 * cancellation instead of Go's context.Context, and returns a pre-parsed
 * ChatResponse instead of raw provider envelopes.
 */
export interface LlmTransport {
  complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// Scripted responses — for tests
// ---------------------------------------------------------------------------

/**
 * ScriptedResponse is one scripted model turn for ScriptedTransport.
 * `toolCalls` uses the same wire shape as ChatResponse but with raw string
 * arguments (JSON-encoded), mirroring how the provider returns them.
 * If `error` is set, `complete()` rejects with that message.
 */
export type ScriptedResponse = {
  readonly content?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  }[];
  readonly reasoningContent?: string;
  readonly usage?: ChatResponse["usage"];
  readonly error?: string;
};

// ---------------------------------------------------------------------------
// ScriptedTransport — deterministic test double
// ---------------------------------------------------------------------------

function createAbortError(): Error {
  // Prefer DOMException with AbortError name for compatibility with fetch/
  // Pi abort handling. Fallback to plain Error with name set if DOMException
  // is unavailable (e.g. older Node).
  try {
    return new DOMException("Aborted", "AbortError");
  } catch {
    const err = new Error("Aborted");
    err.name = "AbortError";
    return err;
  }
}

/**
 * ScriptedTransport is a deterministic LlmTransport for tests.
 *
 * - Constructor takes an ordered list of ScriptedResponses.
 * - Each `complete()` call returns the next response sequentially; once the
 *   list is exhausted the last entry is repeated (so loops that exceed the
 *   script still observe consistent behavior).
 * - If a ScriptedResponse has `error` set, `complete()` rejects with
 *   `Error(error)`.
 * - The transport records every ChatRequest in `.requests` for assertions.
 * - If the provided AbortSignal is already aborted (or aborts before the
 *   microtask completes), `complete()` rejects with an AbortError
 *   (DOMException name "AbortError"), mirroring provider cancellation.
 *
 * No Pi imports, no legacy imports.
 */
export class ScriptedTransport implements LlmTransport {
  /** Recorded requests in call order — for assertions. */
  public readonly requests: ChatRequest[] = [];

  private cursor = 0;

  constructor(private readonly scripted: readonly ScriptedResponse[]) {}

  async complete(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    if (signal.aborted) {
      throw createAbortError();
    }

    // Record the request before producing the response, so even error turns
    // are observable. Abort before recording is treated as "no request made".
    this.requests.push(req);

    // Determine which scripted entry to return. When the script is empty,
    // return an empty assistant turn (no tool calls).
    let src: ScriptedResponse | undefined;
    if (this.scripted.length === 0) {
      src = undefined;
    } else if (this.cursor < this.scripted.length) {
      src = this.scripted[this.cursor];
      // Advance cursor but clamp at last element for subsequent calls.
      if (this.cursor < this.scripted.length - 1) {
        this.cursor += 1;
      }
    } else {
      src = this.scripted[this.scripted.length - 1];
    }

    // Allow an already-aborted signal (or one that aborts during the async
    // hop) to win over the scripted result, matching real transport behavior
    // where cancellation aborts the in-flight request.
    // Use a microtask hop so `signal.addEventListener("abort")` races
    // correctly even if abort fires synchronously after `complete()` is called.
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError());
        return;
      }
      const onAbort = (): void => {
        reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Queue a microtask so an abort scheduled immediately after the call
      // still races before we resolve. Remove listener on settle.
      queueMicrotask(() => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(createAbortError());
        } else {
          resolve();
        }
      });
    });

    if (src !== undefined && src.error !== undefined && src.error !== "") {
      throw new Error(src.error);
    }

    const toolCalls: ToolCall[] = (src?.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));

    const response: ChatResponse = {
      content: src?.content ?? "",
      toolCalls,
      reasoningContent: src?.reasoningContent,
      usage: src?.usage,
    };

    return response;
  }
}

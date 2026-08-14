// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from spike/feasibility-v2.ts (Bun.serve OpenAI-compatible fake server) at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27 conceptual origin.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Deterministic scripted OpenAI-compatible fake server.
 *
 * - Bun.serve on port 0 (no fixed port, no network beyond localhost)
 * - Records every POST body for round counting / tool-def assertions
 * - Supports both non-stream JSON and stream:true SSE (as Pi's provider does)
 * - Optional delayMs to test timeout/abort
 */
import type { ScriptedTurn } from "./types.js";

export interface CapturedRequest {
  readonly body: any;
  readonly headers: Record<string, string>;
}

export interface ScriptedServerOpts {
  readonly delayMs?: number;
  readonly rawResponses?: readonly any[];
}

function openAIToolCall(id: string, name: string, args: string): any {
  return { id, type: "function", function: { name, arguments: args } };
}

function toOpenAIResponse(turn: ScriptedTurn, idx: number): any {
  if (turn.error !== undefined && turn.error !== "") throw new Error(turn.error);
  const toolCalls = (turn.toolCalls ?? []).map((tc) => openAIToolCall(tc.id, tc.name, tc.arguments));
  return {
    id: `chatcmpl-harness-${idx}`,
    object: "chat.completion",
    created: Math.floor(Date.UTC(2026, 0, 1, 0, 0, idx) / 1000),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: turn.content ?? null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : (turn.finishReason ?? "stop"),
      },
    ],
    usage: turn.usage
      ? {
          prompt_tokens: turn.usage.promptTokens,
          completion_tokens: turn.usage.completionTokens,
          total_tokens: turn.usage.totalTokens,
        }
      : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

export function startFakeServer(opts: {
  turns: readonly ScriptedTurn[];
  delayMs?: number;
}): {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly port: number;
  readonly url: string;
  readonly requests: CapturedRequest[];
  readonly stop: () => void;
} {
  const requests: CapturedRequest[] = [];
  let idx = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      let body: any;
      try {
        body = await req.json();
      } catch {
        body = {};
      }
      requests.push({ body, headers: Object.fromEntries(req.headers.entries()) });
      if (opts.delayMs !== undefined && opts.delayMs > 0) await Bun.sleep(opts.delayMs);
      const turn = opts.turns[idx] ?? opts.turns[opts.turns.length - 1];
      if (!turn) return new Response(JSON.stringify({ error: "no scripted turn" }), { status: 500, headers: { "content-type": "application/json" } });
      // Advance cursor but clamp at last
      if (idx < opts.turns.length - 1) idx += 1;
      else if (idx < opts.turns.length) idx += 1; // past end stays clamped
      // Stream branch: Pi often sends stream:true
      const wantsStream = body.stream === true;
      if (turn.error) {
        if (wantsStream) {
          // For stream case, still return 500 for simplicity
          return new Response(turn.error, { status: 500 });
        }
        return new Response(turn.error, { status: 500 });
      }
      const full = toOpenAIResponse(turn, idx);
      if (wantsStream) {
        const id = full.id;
        const created = full.created;
        const model = full.model ?? body.model ?? "test-model";
        const choice = full.choices[0];
        const msg = choice.message;
        const finish = choice.finish_reason;
        const delta: any = {};
        if (msg.content) delta.content = msg.content;
        if (msg.tool_calls) {
          delta.tool_calls = msg.tool_calls.map((tc: any, i: number) => ({
            index: i,
            id: tc.id,
            type: tc.type ?? "function",
            function: tc.function,
          }));
        }
        const usage = full.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        const sse = [
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`,
          `data: [DONE]\n\n`,
        ].join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify(full), { headers: { "content-type": "application/json" } });
    },
  });
  const port = (server as any).port as number;
  const url = `http://localhost:${port}/v1`;
  return { server, port, url, requests, stop: () => server.stop() };
}

/** Helper for PiRunner transport: convert ScriptedTurn -> ScriptedResponse shape (transcript.ts). */
export function turnsToScriptedResponses(turns: readonly ScriptedTurn[]): readonly {
  readonly content?: string;
  readonly toolCalls?: readonly { id: string; name: string; arguments: string }[];
  readonly usage?: any;
  readonly error?: string;
}[] {
  return turns.map((t) => ({
    content: t.content ?? undefined,
    toolCalls: t.toolCalls?.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
    usage: t.usage
      ? {
          PromptTokens: t.usage.promptTokens,
          CompletionTokens: t.usage.completionTokens,
          CacheReadTokens: t.usage.cacheReadTokens ?? 0,
          CacheWriteTokens: t.usage.cacheWriteTokens ?? 0,
        }
      : undefined,
    error: t.error,
  }));
}

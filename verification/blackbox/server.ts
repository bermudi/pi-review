// SPDX-License-Identifier: Apache-2.0
// Gate 0 local provider server — records raw HTTP at the process boundary.
// Only Node/Bun stdlib + local types. No src/** imports.

import type { CapturedHttp } from "./types.js";

/**
 * Why we need a local server:
 * The harness must watch what each engine actually sends to its provider.
 * We can't trust objects the engine builds in memory — we have to see
 * bytes go over loopback. This server sits on 127.0.0.1, records every
 * request and the exact response bytes it returned, and never talks to
 * the internet.
 */

export interface FakeProviderServer {
  readonly url: string;
  readonly port: number;
  readonly captures: CapturedHttp[];
  readonly stop: () => void;
  readonly getSanitizedCaptures: () => CapturedHttp[];
}

// Secrets that must never appear in artifacts.
const SECRET_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-openai-api-key"]);

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (SECRET_HEADERS.has(lower) || lower.includes("key") || lower.includes("secret") || lower === "authorization") {
      out[k] = "<REDACTED>";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeBody(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      return sanitizeBody(parsed);
    } catch {
      return body.replace(/sk-[a-zA-Z0-9_-]{10,}/g, "<REDACTED>");
    }
  }
  if (Array.isArray(body)) {
    const arr = body as unknown[];
    return arr.map((e) => sanitizeBody(e));
  }
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      const isUsage =
        lower === "prompt_tokens" ||
        lower === "completion_tokens" ||
        lower === "total_tokens" ||
        lower === "prompttokens" ||
        lower === "completiontokens" ||
        lower === "totaltokens" ||
        lower === "usage" ||
        lower.includes("cache_read") ||
        lower.includes("cache_write");
      if (isUsage) {
        out[k] = sanitizeBody(v);
        continue;
      }
      const isSecretKey =
        lower === "authorization" ||
        lower === "api_key" ||
        lower === "apikey" ||
        lower === "x-api-key" ||
        lower === "apiKey" ||
        lower === "secret" ||
        lower === "password" ||
        lower === "key" ||
        lower === "token" ||
        lower.endsWith("_key") ||
        lower.endsWith("_secret");
      if (isSecretKey) {
        out[k] = "<REDACTED>";
      } else {
        out[k] = sanitizeBody(v);
      }
    }
    return out;
  }
  return body;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getStringField(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function getNumberField(obj: unknown, key: string): number | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * Create a server that returns a frozen sequence of responses.
 * Each call to `url` gets the next response in the list (clamped at last).
 * The two servers for OCR and Pi get deep-frozen copies of the same sequence,
 * so giving them the same input but mutating one server's copy is a real
 * boundary mutation — not just editing an in-memory object.
 *
 * Request arrival and response delivery are separate: on arrival we push a
 * capture with `delivered:false` and `response:null`. Only after delay (and
 * after confirming the client did not abort) do we set `response` and
 * `delivered:true` and return bytes. This ensures a stalled aborted request
 * has a captured request but no captured response/usage.
 */
export function createCaptureServer(opts: {
  responses: readonly unknown[];
  delayMs?: number;
}): FakeProviderServer {
  const frozenResponses = deepClone(opts.responses);
  const captures: CapturedHttp[] = [];
  let idx = 0;

  type MutableCapture = {
    request: { method: string; url: string; headers: Record<string, string>; body: unknown };
    response: { status: number; headers: Record<string, string>; body: unknown } | null;
    delivered: boolean;
    sanitized: boolean;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      let body: unknown = {};
      const rawBodyText = await req.text();
      try {
        body = rawBodyText ? JSON.parse(rawBodyText) : {};
      } catch {
        body = rawBodyText;
      }

      const headers = Object.fromEntries(req.headers.entries());

      // Record arrival immediately, before any delay or response selection.
      const mutable: MutableCapture = {
        request: {
          method: req.method,
          url: req.url,
          headers: deepClone(headers),
          body: deepClone(body),
        },
        response: null,
        delivered: false,
        sanitized: false,
      };
      captures.push(mutable as unknown as CapturedHttp);

      if (opts.delayMs && opts.delayMs > 0) {
        await Bun.sleep(opts.delayMs);
      }

      // If client aborted before we could deliver, leave as undelivered.
      // req.signal aborted means the fetch was cancelled.
      const sig = (req as unknown as { signal?: AbortSignal }).signal;
      if (sig && sig.aborted) {
        // Do not set response, do not advance idx, return abort-like response that will be ignored.
        return new Response(null, { status: 499 });
      }

      // Now select the next scripted response — only after delivery is confirmed.
      const responseBodyUnknown: unknown = frozenResponses[Math.min(idx, frozenResponses.length - 1)];
      if (idx < frozenResponses.length) idx++;

      const responseBodyRecord = isRecord(responseBodyUnknown) ? (responseBodyUnknown as Record<string, unknown>) : {};

      mutable.response = {
        status: 200,
        headers: { "content-type": "application/json" },
        body: deepClone(responseBodyUnknown),
      };
      mutable.delivered = true;

      // Handle streaming: Pi SDK sends stream:true and expects SSE
      const wantsStream = isRecord(body) && body["stream"] === true;
      if (wantsStream) {
        const id = getStringField(responseBodyRecord, "id") ?? `chatcmpl-${idx}`;
        const created = getNumberField(responseBodyRecord, "created") ?? Math.floor(Date.now() / 1000);
        const modelFromBody = isRecord(body) ? getStringField(body, "model") : undefined;
        const model = getStringField(responseBodyRecord, "model") ?? modelFromBody ?? "test-model";
        const choicesUnknown = responseBodyRecord["choices"];
        const firstChoice = Array.isArray(choicesUnknown) && choicesUnknown.length > 0 ? choicesUnknown[0] : undefined;
        const firstRecord = isRecord(firstChoice) ? firstChoice : {};
        const msgUnknown = firstRecord["message"];
        const msgRecord = isRecord(msgUnknown) ? msgUnknown : {};
        const finishFromChoice = getStringField(firstRecord, "finish_reason");
        const toolCalls = msgRecord["tool_calls"];
        const finish = finishFromChoice ?? (Array.isArray(toolCalls) ? "tool_calls" : "stop");
        const delta: Record<string, unknown> = {};
        const content = msgRecord["content"];
        if (typeof content === "string" && content !== "") delta["content"] = content;
        if (Array.isArray(toolCalls)) {
          const mapped: unknown[] = [];
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            if (!isRecord(tc)) continue;
            const fn = isRecord(tc["function"]) ? (tc["function"] as Record<string, unknown>) : {};
            mapped.push({
              index: i,
              id: getStringField(tc, "id") ?? `call_${i}`,
              type: getStringField(tc, "type") ?? "function",
              function: fn,
            });
          }
          delta["tool_calls"] = mapped;
        }
        const usageUnknown = responseBodyRecord["usage"];
        const usage = isRecord(usageUnknown)
          ? usageUnknown
          : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        const sse = [
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`,
          `data: [DONE]\n\n`,
        ].join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }

      return new Response(JSON.stringify(responseBodyUnknown), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const port = (server as unknown as { port: number }).port;
  const url = `http://127.0.0.1:${port}/v1`;

  return {
    url,
    port,
    captures,
    stop: () => server.stop(),
    getSanitizedCaptures: () =>
      captures.map((c) => ({
        request: {
          method: c.request.method,
          url: c.request.url.replace(/127\.0\.0\.1:\d+/, "127.0.0.1:<PORT>"),
          headers: sanitizeHeaders(c.request.headers),
          body: sanitizeBody(c.request.body),
        },
        response: c.response
          ? {
              status: c.response.status,
              headers: sanitizeHeaders(c.response.headers),
              body: sanitizeBody(c.response.body),
            }
          : null,
        delivered: c.delivered,
        sanitized: true,
      })),
  };
}

/**
 * Validate that captures look sane — used by subprocess runner before writing artifacts.
 * This ensures "missing Pi provider trace" is caught as a real failure, not silently ignored.
 */
export function assertHasProviderTrace(captures: readonly CapturedHttp[], engine: string): void {
  if (captures.length === 0) {
    throw new Error(`missing ${engine} provider trace: no HTTP captures recorded (server was never contacted)`);
  }
}

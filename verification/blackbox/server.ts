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
    if (SECRET_HEADERS.has(lower) || lower.includes("key") || lower.includes("token") || lower.includes("secret")) {
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
    // Redact anything that looks like a key in a JSON string
    try {
      const parsed = JSON.parse(body) as unknown;
      return sanitizeBody(parsed);
    } catch {
      return body.replace(/sk-[a-zA-Z0-9_-]{10,}/g, "<REDACTED>");
    }
  }
  if (Array.isArray(body)) return body.map(sanitizeBody);
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      if (lower.includes("key") || lower.includes("token") || lower.includes("secret") || lower.includes("authorization")) {
        out[k] = "<REDACTED>";
      } else {
        out[k] = sanitizeBody(v) as unknown;
      }
    }
    return out;
  }
  return body;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Create a server that returns a frozen sequence of responses.
 * Each call to `url` gets the next response in the list (clamped at last).
 * The two servers for OCR and Pi get deep-frozen copies of the same sequence,
 * so giving them the same input but mutating one server's copy is a real
 * boundary mutation — not just editing an in-memory object.
 */
export function createCaptureServer(opts: {
  responses: readonly unknown[];
  delayMs?: number;
}): FakeProviderServer {
  const frozenResponses = deepClone(opts.responses);
  const captures: CapturedHttp[] = [];
  let idx = 0;

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

      if (opts.delayMs && opts.delayMs > 0) {
        await Bun.sleep(opts.delayMs);
      }

      const responseBody = frozenResponses[Math.min(idx, frozenResponses.length - 1)];
      if (idx < frozenResponses.length) idx++;

      // Record raw capture first, then sanitize for artifact.
      const rawCapture: CapturedHttp = {
        request: {
          method: req.method,
          url: req.url,
          headers: deepClone(headers),
          body: deepClone(body),
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: deepClone(responseBody),
        },
        sanitized: false,
      };
      captures.push(rawCapture);

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const port = (server as unknown as { port: number }).port;
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;

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
        response: {
          status: c.response.status,
          headers: sanitizeHeaders(c.response.headers),
          body: sanitizeBody(c.response.body),
        },
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

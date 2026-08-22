// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/sessionkey.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { createHash, randomUUID } from "node:crypto";

export const SessionKeyTemplateVar = "{ocr_session_key}";

/**
 * SessionTaskKey derives the prompt-cache affinity key for one task conversation.
 * Mirrors Go SessionTaskKey: sha256 of scope first 8 bytes hex, prefix sessionKey-taskType-
 */
export function sessionTaskKey(sessionKey: string, taskType: string, scope: string): string {
  if (taskType === "" && scope === "") return sessionKey;
  if (scope === "") return `${sessionKey}-${taskType}`;
  const sum = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 16);
  return `${sessionKey}-${taskType}-${sum}`;
}

/**
 * NewSessionKey returns a fresh UUIDv4 session key with fallback.
 * Mirrors Go NewSessionKey.
 */
export function newSessionKey(): string {
  try {
    return randomUUID();
  } catch {
    return `fallback-${Date.now() * 1_000_000}`;
  }
}

/**
 * expandSessionKeyInHeaders returns a copy with placeholder replaced.
 * Mirrors Go expandSessionKeyInHeaders (non-mutating, nil->nil).
 */
export function expandSessionKeyInHeaders(
  headers: Record<string, string> | null | undefined,
  key: string,
): Record<string, string> | null | undefined {
  if (headers === null || headers === undefined) return headers as null | undefined;
  const keys = Object.keys(headers);
  if (keys.length === 0) return headers;
  const out: Record<string, string> = {};
  for (const k of keys) {
    out[k] = headers[k]!.split(SessionKeyTemplateVar).join(key);
  }
  return out;
}

/**
 * expandSessionKeyInBody returns a copy with placeholder replaced recursively.
 * Mirrors Go expandSessionKeyInBody.
 */
export function expandSessionKeyInBody(
  body: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null | undefined {
  if (body === null || body === undefined) return body as null | undefined;
  if (Object.keys(body).length === 0) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = expandSessionKeyValue(v, key);
  }
  return out;
}

function expandSessionKeyValue(v: unknown, key: string): unknown {
  if (typeof v === "string") {
    return v.split(SessionKeyTemplateVar).join(key);
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, nested] of Object.entries(rec)) {
      out[k] = expandSessionKeyValue(nested, key);
    }
    return out;
  }
  if (Array.isArray(v)) {
    return v.map((nested) => expandSessionKeyValue(nested, key));
  }
  return v;
}

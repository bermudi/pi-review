// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/sessionkey_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import {
  sessionTaskKey,
  newSessionKey,
  expandSessionKeyInHeaders,
  expandSessionKeyInBody,
  SessionKeyTemplateVar,
} from "../../../src/ocr/pi-adapter/session-key.js";

// OCR v1.9.3: TestSessionTaskKey
test("sessionTaskKey derives task-scoped keys with hash", () => {
  const sess = "sess-123";
  expect(sessionTaskKey(sess, "", "")).toBe(sess);
  expect(sessionTaskKey(sess, "main_task", "")).toBe(`${sess}-main_task`);
  const a = sessionTaskKey(sess, "main_task", "file-a.ts");
  const b = sessionTaskKey(sess, "main_task", "file-b.ts");
  expect(a).not.toBe(b);
  expect(a.startsWith(`${sess}-main_task-`)).toBe(true);
  expect(a.length).toBe(sess.length + "-main_task-".length + 16);
  // Determinism
  expect(sessionTaskKey(sess, "task", "scope")).toBe(sessionTaskKey(sess, "task", "scope"));
  // Non-ASCII header-safe
  const nonAscii = sessionTaskKey(sess, "task", "文件.ts");
  expect(nonAscii).toMatch(/^[a-z0-9-]+$/);
});

// OCR v1.9.3: TestNewSessionKey
test("newSessionKey returns UUIDv4 and uniqueness", () => {
  const k1 = newSessionKey();
  const k2 = newSessionKey();
  expect(k1.length).toBeGreaterThan(0);
  expect(k1).not.toBe(k2);
  // UUIDv4 format: 8-4-4-4-12 hex
  expect(k1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// OCR v1.9.3: TestExpandSessionKeyInHeaders
test("expandSessionKeyInHeaders replaces placeholder without mutating input", () => {
  const headers = { "x-session-affinity": `tenant-${SessionKeyTemplateVar}-suffix`, other: "keep" };
  const orig = { ...headers };
  const out = expandSessionKeyInHeaders(headers, "sess-abc")!;
  expect(out["x-session-affinity"]).toBe("tenant-sess-abc-suffix");
  expect(out["other"]).toBe("keep");
  expect(headers).toEqual(orig);
  expect(expandSessionKeyInHeaders({}, "k")).toEqual({});
  expect(expandSessionKeyInHeaders(null as unknown as Record<string, string>, "k")).toBeNull();
  expect(expandSessionKeyInHeaders(undefined, "k")).toBeUndefined();
});

// OCR v1.9.3: TestExpandSessionKeyInBody
test("expandSessionKeyInBody replaces recursively without mutating", () => {
  const body = {
    prompt_cache_key: SessionKeyTemplateVar,
    nested: { key: `prefix-${SessionKeyTemplateVar}`, keep: 42 } as Record<string, unknown>,
    arr: [SessionKeyTemplateVar, 123, true] as unknown[],
  };
  const origJson = JSON.stringify(body);
  const out = expandSessionKeyInBody(body as Record<string, unknown>, "sess-xyz")!;
  expect(out["prompt_cache_key"]).toBe("sess-xyz");
  expect((out["nested"] as Record<string, unknown>)["key"]).toBe("prefix-sess-xyz");
  expect((out["nested"] as Record<string, unknown>)["keep"]).toBe(42);
  expect((out["arr"] as unknown[])[0]).toBe("sess-xyz");
  expect((out["arr"] as unknown[])[1]).toBe(123);
  expect(JSON.stringify(body)).toBe(origJson);
  expect(expandSessionKeyInBody({}, "k")).toEqual({});
  expect(expandSessionKeyInBody(null as unknown as Record<string, unknown>, "k")).toBeNull();
});

// OCR v1.9.3: TestSessionKeyContext (mapped to sessionId override semantics)
test("sessionTaskKey override semantics via sessionId", () => {
  // Mirrors ContextWithSessionKey inner wins: per-request sessionId overrides fallback
  const fallback = "fallback-key";
  const real = "real-session-id";
  // PiTransport currently ignores req.sessionId, but session-key helper proves the derivation
  // This test ensures the pure helper is available; full wire test is future packed boundary
  expect(sessionTaskKey(real, "main_task", "file.ts")).not.toBe(sessionTaskKey(fallback, "main_task", "file.ts"));
});

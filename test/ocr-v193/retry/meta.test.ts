// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/retry_meta_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import {
  isValidRequestMeta,
  logicalRequestID,
  describeRequestMeta,
  withRequestMeta,
  requestMetaFromContext,
  type RequestMeta,
} from "../../../src/ocr-v193/retry/meta.js";

function testMeta(): RequestMeta {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    filePath: "payment.go",
    taskType: "main_task",
    requestNo: 1,
  };
}

// OCR v1.9.3: TestRequestMetaValid
test("RequestMeta valid cases", () => {
  type Mutable = { provider: string; model: string; filePath: string; taskType: string; requestNo: number };
  const cases: Array<{ name: string; mut: (m: Mutable) => void; want: boolean }> = [
    { name: "complete", mut: () => {}, want: true },
    { name: "empty provider is valid", mut: (m) => { m.provider = ""; }, want: true },
    { name: "missing model", mut: (m) => { m.model = ""; }, want: false },
    { name: "missing file path", mut: (m) => { m.filePath = ""; }, want: false },
    { name: "missing task type", mut: (m) => { m.taskType = ""; }, want: false },
    { name: "zero request no", mut: (m) => { m.requestNo = 0; }, want: false },
    { name: "negative request no", mut: (m) => { m.requestNo = -1; }, want: false },
    { name: "NUL in provider", mut: (m) => { m.provider = "anth\x00ropic"; }, want: false },
    { name: "NUL in model", mut: (m) => { m.model = "cla\x00ude"; }, want: false },
    { name: "NUL in file path", mut: (m) => { m.filePath = "pay\x00.go"; }, want: false },
    { name: "NUL in task type", mut: (m) => { m.taskType = "main\x00"; }, want: false },
  ];
  for (const tc of cases) {
    const m: Mutable = { ...testMeta() };
    tc.mut(m);
    expect(isValidRequestMeta(m as RequestMeta)).toBe(tc.want);
  }
});

// OCR v1.9.3: TestLogicalRequestIDIsDeterministic
test("logicalRequestID is deterministic and 64 hex chars", () => {
  const m = testMeta();
  const a = logicalRequestID(m, "run-1");
  const b = logicalRequestID(m, "run-1");
  expect(a).toBe(b);
  expect(a.length).toBe(64);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
});

// OCR v1.9.3: TestLogicalRequestIDSeparatesFields
test("logicalRequestID separates fields", () => {
  const base = testMeta();
  const shifted: RequestMeta = { ...base, provider: "anthropi", model: "cclaude-sonnet-4-6" };
  const swapped: RequestMeta = { ...base, filePath: base.taskType, taskType: base.filePath };
  const want = logicalRequestID(base, "run-1");
  expect(logicalRequestID(shifted, "run-1")).not.toBe(want);
  expect(logicalRequestID(swapped, "run-1")).not.toBe(want);
});

// OCR v1.9.3: TestLogicalRequestIDVariesWithRunIDAndRequestNo
test("logicalRequestID varies with runId and requestNo", () => {
  const m = testMeta();
  const base = logicalRequestID(m, "run-1");
  expect(logicalRequestID(m, "run-2")).not.toBe(base);
  expect(logicalRequestID({ ...m, requestNo: 2 }, "run-1")).not.toBe(base);
  const a: RequestMeta = { ...m, taskType: "main_task1", requestNo: 2 };
  const b: RequestMeta = { ...m, taskType: "main_task", requestNo: 12 };
  expect(logicalRequestID(a, "run-1")).not.toBe(logicalRequestID(b, "run-1"));
});

// OCR v1.9.3: TestLogicalRequestIDCanonicalEncoding
test("logicalRequestID canonical encoding", () => {
  const want = "14e212a5316c922ea2e0758da1a243255ac33f6360fd0d4e70af90ad1441516c";
  expect(logicalRequestID(testMeta(), "run-1")).toBe(want);
});

// OCR v1.9.3: TestRequestMetaDescribe
test("describeRequestMeta contains file/task/request_no", () => {
  const got = describeRequestMeta(testMeta());
  expect(got).toContain("file=payment.go");
  expect(got).toContain("task=main_task");
  expect(got).toContain("request_no=1");
});

// OCR v1.9.3: TestWithRequestMeta
test("withRequestMeta round trip", () => {
  const m = testMeta();
  const ctx = withRequestMeta({}, m);
  const { meta, ok } = requestMetaFromContext(ctx);
  expect(ok).toBe(true);
  expect(meta).toEqual(m);
});

test("withRequestMeta invalid meta is not attached", () => {
  const m: RequestMeta = { ...testMeta(), model: "" };
  const ctx = withRequestMeta({}, m);
  const { ok } = requestMetaFromContext(ctx);
  expect(ok).toBe(false);
});

test("bare context carries nothing", () => {
  const { ok } = requestMetaFromContext({});
  expect(ok).toBe(false);
});

test("nil context", () => {
  expect(withRequestMeta(null, testMeta())).toBeNull();
  expect(withRequestMeta(undefined, testMeta())).toBeUndefined();
  expect(requestMetaFromContext(null).ok).toBe(false);
  expect(requestMetaFromContext(undefined).ok).toBe(false);
});

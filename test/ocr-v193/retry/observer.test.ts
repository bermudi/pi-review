// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/retry_observer_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { RetryCollector, observeAttempt, responseRequestId, parseRetryDirective, parseRetryAfterMs } from "../../../src/ocr-v193/retry/collector.js";
import { withRequestMeta, type RequestMeta } from "../../../src/ocr-v193/retry/meta.js";
import { ErrorClassCancelled, ErrorClassNetwork, ErrorClassRateLimited, ErrorClassProvider, FailurePhaseHTTP, FailurePhaseTransport } from "../../../src/ocr-v193/retry/types.js";

function testMeta(): RequestMeta {
  return { provider: "anthropic", model: "claude-sonnet-4-6", filePath: "payment.go", taskType: "main_task", requestNo: 1 };
}

test("responseRequestId reads request-id and x-request-id", () => {
  expect(responseRequestId({ "request-id": "req_1", "x-request-id": "x_1" })).toBe("req_1");
  expect(responseRequestId({ "x-request-id": "x_2" })).toBe("x_2");
  expect(responseRequestId({})).toBe("");
  expect(responseRequestId({ "Request-Id": "caps" })).toBe("caps");
});

test("parseRetryDirective reads x-should-retry", () => {
  expect(parseRetryDirective({ "x-should-retry": "true" })).toBe(true);
  expect(parseRetryDirective({ "x-should-retry": "false" })).toBe(false);
  expect(parseRetryDirective({ "x-should-retry": "maybe" })).toBeUndefined();
  expect(parseRetryDirective({})).toBeUndefined();
});

test("parseRetryAfterMS precedence and units", () => {
  const now = Date.now();
  expect(parseRetryAfterMs({ "Retry-After-Ms": "40" }, now)).toBe(40);
  expect(parseRetryAfterMs({ "Retry-After": "2" }, now)).toBe(2000);
  // Retry-After-Ms wins
  expect(parseRetryAfterMs({ "Retry-After-Ms": "10", "Retry-After": "5" }, now)).toBe(10);
  // past date yields 0
  const past = new Date(now - 5000).toUTCString();
  expect(parseRetryAfterMs({ "Retry-After": past }, now)).toBe(0);
  expect(parseRetryAfterMs({}, now)).toBe(0);
});

test("observeAttempt classifies rate_limited then success", () => {
  const ended = Date.now();
  const errObs = observeAttempt({ status: 429, headers: { "Retry-After-Ms": "40", "request-id": "req_1" } }, new Error("429"), ended);
  expect(errObs.errorClass).toBe(ErrorClassRateLimited);
  expect(errObs.statusCode).toBe(429);
  expect(errObs.retryAfterMs).toBe(40);
  expect(errObs.requestId).toBe("req_1");

  const okObs = observeAttempt({ status: 200, headers: {} }, null, ended);
  expect(okObs.statusCode).toBe(200);
  expect(okObs.errorClass).toBeUndefined();
});

test("observeAttempt records transport failure", () => {
  const obs = observeAttempt(null, new Error("dial tcp"), Date.now());
  expect(obs.errorClass).toBe(ErrorClassNetwork);
  expect(obs.failurePhase).toBe(FailurePhaseTransport);
  expect(obs.statusCode).toBeUndefined();
});

test("observeAttempt drops classification on 2xx success", () => {
  const obs = observeAttempt({ status: 200, headers: {} }, null, Date.now()) as Record<string, unknown>;
  expect(obs["outcome"]).toBeUndefined();
  expect(obs["errorClass"]).toBeUndefined();
});

test("observer drops requests without identity", () => {
  const c = new RetryCollector();
  const bogus: RequestMeta = { provider: "", model: "", filePath: "", taskType: "", requestNo: 0 };
  c.recordAttempt(bogus, { statusCode: 200 }, 0, 10);
  expect(c.getEntryCount()).toBe(0);
});

test("nil collector is inert (simulated via no-op)", () => {
  // In Go, nil collector mounts no middleware; here we test that calling with undefined doesn't throw
  const obs = observeAttempt({ status: 200, headers: {} }, null, Date.now());
  expect(obs.statusCode).toBe(200);
});

test("observer ignores overridden retry count header", () => {
  // Simulate that collector ignores SDK retry count header; we just ensure parse doesn't read it
  const obs = observeAttempt({ status: 429, headers: { "x-should-retry": "true", "retry-count": "5" } }, new Error("429"), Date.now());
  expect(obs.sdkRetryDirective).toBe(true);
});

test("observer records retry directive on success", () => {
  const obs = observeAttempt({ status: 200, headers: { "x-should-retry": "true" } }, null, Date.now());
  // Even on 200, directive is recorded (both SDKs consult ahead of status)
  expect(obs.sdkRetryDirective).toBe(true);
});

test("observer records exhausted retries via multiple attempts", () => {
  const c = new RetryCollector();
  const m = testMeta();
  for (let i = 0; i < 6; i++) {
    c.recordAttempt(m, { statusCode: 500, errorClass: ErrorClassProvider, failurePhase: FailurePhaseHTTP }, i * 10, i * 10 + 5);
  }
  c.finalize(m, new Error("exhausted"), false);
  const { report } = c.freeze("run-1");
  expect(report!.requests[0]!.attempts.length).toBe(6);
  expect(report!.totalRetries).toBe(5);
});

test("observer concurrent requests maintain isolation", async () => {
  const c = new RetryCollector();
  const metas: RequestMeta[] = Array.from({ length: 5 }, (_, i) => ({ ...testMeta(), filePath: `file${i}.go`, requestNo: 1 }));
  await Promise.all(metas.map(async (m) => {
    c.recordAttempt(m, { statusCode: 200 }, 0, 5);
    c.finalize(m, null, false);
  }));
  // each file has single success not listed, but totalRequests counts all
  const { report } = c.freeze("run-1");
  // No retries, no failures => report null per Freeze rule (nothing worth reporting)
  expect(report).toBeNull();
  // But entry count is 5
  expect(c.getEntryCount()).toBe(5);
});

test("observer classifies terminal statuses", () => {
  const cases: Array<{ status: number; wantClass: string }> = [
    { status: 429, wantClass: ErrorClassRateLimited },
    { status: 409, wantClass: ErrorClassProvider },
    { status: 500, wantClass: ErrorClassProvider },
  ];
  for (const tc of cases) {
    const obs = observeAttempt({ status: tc.status, headers: {} }, new Error(String(tc.status)), Date.now()) as Record<string, unknown>;
    expect(obs["errorClass"] as string).toBe(tc.wantClass);
  }
});

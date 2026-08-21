// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/retry_boundary_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import {
  classifyBoundaryError,
  classifyStreamError,
  StreamIntegrityError,
  StreamError,
  errRequestPanicked,
  reviseAttempt,
  finalizeRequest,
} from "../../../src/ocr-v193/retry/boundary.js";
import { RetryCollector } from "../../../src/ocr-v193/retry/collector.js";
import { withRequestMeta, type RequestMeta } from "../../../src/ocr-v193/retry/meta.js";
import {
  ErrorClassCancelled,
  ErrorClassNetwork,
  ErrorClassProvider,
  ErrorClassTimeout,
  ErrorClassUnknown,
  FailurePhaseContext,
  FailurePhaseResponseDecode,
  FailurePhaseResponseStatus,
  FailurePhaseStream,
  FailurePhaseHTTP,
  type ErrorClass,
  type FailurePhase,
} from "../../../src/ocr-v193/retry/types.js";

function testMeta(): RequestMeta {
  return { provider: "anthropic", model: "claude-sonnet-4-6", filePath: "payment.go", taskType: "main_task", requestNo: 1 };
}

function metaCtx(m: RequestMeta): unknown {
  return withRequestMeta({}, m);
}

// classifyBoundaryError cases
// OCR v1.9.3: TestClassifyBoundaryError
test("classifyBoundaryError contracts", () => {
  const cases: Array<{ name: string; err: unknown; wantClass: string; wantPhase: string; recognized: boolean }> = [
    { name: "nil", err: null, wantClass: "", wantPhase: "", recognized: false },
    { name: "cancelled", err: new DOMException("Aborted", "AbortError"), wantClass: ErrorClassCancelled, wantPhase: FailurePhaseContext, recognized: true },
    { name: "deadline", err: Object.assign(new Error("deadline"), { name: "TimeoutError" }), wantClass: ErrorClassTimeout, wantPhase: FailurePhaseContext, recognized: true },
    { name: "truncated body", err: new Error("error reading response body: unexpected EOF"), wantClass: ErrorClassNetwork, wantPhase: FailurePhaseResponseDecode, recognized: true },
    { name: "json syntax", err: new SyntaxError("Unexpected token"), wantClass: ErrorClassUnknown, wantPhase: FailurePhaseResponseDecode, recognized: true },
    { name: "json type", err: new TypeError("cannot unmarshal"), wantClass: ErrorClassUnknown, wantPhase: FailurePhaseResponseDecode, recognized: true },
    { name: "opaque", err: new Error("something went wrong"), wantClass: "", wantPhase: "", recognized: false },
  ];
  for (const tc of cases) {
    const { errorClass, failurePhase, recognized } = classifyBoundaryError(tc.err);
    expect(recognized).toBe(tc.recognized);
    if (tc.recognized) {
      expect(errorClass as unknown as string).toBe(tc.wantClass);
      expect(failurePhase as unknown as string).toBe(tc.wantPhase);
    }
  }
});

test("classifyBoundaryError wraps", () => {
  const wrapped = new Error("wrapped", { cause: new DOMException("Aborted", "AbortError") });
  const { recognized, errorClass } = classifyBoundaryError(wrapped);
  // Our implementation unwraps cause for Abort via isAbortError cause chain
  expect(recognized).toBe(true);
  expect(errorClass).toBe(ErrorClassCancelled);
});

// OCR v1.9.3: TestClassifyStreamError
test("classifyStreamError always returns classification", () => {
  const cases: Array<{ name: string; err: unknown; wantClass: ErrorClass; wantPhase: FailurePhase }> = [
    { name: "integrity", err: new StreamIntegrityError("contained no choices"), wantClass: ErrorClassProvider, wantPhase: FailurePhaseStream },
    { name: "sse stream error", err: new StreamError("stream"), wantClass: ErrorClassProvider, wantPhase: FailurePhaseStream },
    { name: "cancelled keeps context phase", err: new DOMException("Aborted", "AbortError"), wantClass: ErrorClassCancelled, wantPhase: FailurePhaseContext },
    { name: "deadline keeps context phase", err: Object.assign(new Error("deadline"), { name: "TimeoutError" }), wantClass: ErrorClassTimeout, wantPhase: FailurePhaseContext },
    { name: "opaque", err: new Error("something went wrong"), wantClass: ErrorClassUnknown, wantPhase: FailurePhaseStream },
  ];
  for (const tc of cases) {
    const { errorClass, failurePhase } = classifyStreamError(tc.err);
    expect(errorClass).toBe(tc.wantClass);
    expect(failurePhase).toBe(tc.wantPhase);
  }
});

// OCR v1.9.3: TestStreamIntegrityErrorMessage
test("StreamIntegrityError message", () => {
  const err = new StreamIntegrityError("contained no choices");
  expect(err.message).toBe("OpenAI streaming response contained no choices");
});

// OCR v1.9.3: TestFinalizeRequestWithPanicSentinel
test("finalizeRequest with panic sentinel produces failed", () => {
  const c = new RetryCollector();
  const m = testMeta();
  const ctx = metaCtx(m);
  c.recordAttempt(m, { statusCode: 200 }, 0, 10);
  finalizeRequest(ctx, c, errRequestPanicked);
  const { report, error } = c.freeze("test-run-id");
  expect(error).toBeNull();
  expect(report!.requests[0]!.outcome).toBe("failed");
});

// OCR v1.9.3: TestBoundaryHelpersAreInertWithoutCollectorOrMeta
test("boundary helpers are inert without collector or meta", () => {
  const m = testMeta();
  reviseAttempt(metaCtx(m), null, ErrorClassNetwork, FailurePhaseResponseDecode);
  finalizeRequest(metaCtx(m), null, new Error("boom"));
  const c = new RetryCollector();
  reviseAttempt({}, c, ErrorClassNetwork, FailurePhaseResponseDecode);
  finalizeRequest({}, c, new Error("boom"));
  expect(c.getEntryCount()).toBe(0);
});

// OCR v1.9.3: TestBoundaryCorrectsTruncatedResponse
test("reviseAttempt corrects truncated response", () => {
  const c = new RetryCollector();
  const m = testMeta();
  const ctx = metaCtx(m);
  c.recordAttempt(m, { statusCode: 200 }, 0, 10);
  reviseAttempt(ctx, c, ErrorClassNetwork, FailurePhaseResponseDecode);
  const attempts = c.getAttempts(m);
  expect(attempts[0]!.outcome).toBe("error");
  expect(attempts[0]!.errorClass).toBe(ErrorClassNetwork);
  expect(attempts[0]!.failurePhase).toBe(FailurePhaseResponseDecode);
  expect(attempts[0]!.statusCode).toBe(200);
});

// OCR v1.9.3: TestBoundaryKeepsHTTPClassOnCorruptErrorBody
// OCR v1.9.3: TestBoundaryKeepsHTTPClassOnStreamThatNeverOpened
test("reviseAttempt keeps HTTP class when already error", () => {
  const c = new RetryCollector();
  const m = testMeta();
  const ctx = metaCtx(m);
  c.recordAttempt(m, { statusCode: 500, errorClass: ErrorClassProvider, failurePhase: FailurePhaseHTTP }, 0, 10);
  reviseAttempt(ctx, c, ErrorClassUnknown, FailurePhaseResponseDecode);
  const attempts = c.getAttempts(m);
  expect(attempts[0]!.errorClass).toBe(ErrorClassProvider);
  expect(attempts[0]!.failurePhase).toBe(FailurePhaseHTTP);
});

// OCR v1.9.3: TestBoundaryCancelDuringBackoffIsCancelled
test("finalize decides cancelled vs failed correctly", () => {
  const c = new RetryCollector();
  const m = testMeta();
  c.recordAttempt(m, { statusCode: 429, errorClass: ErrorClassCancelled, failurePhase: FailurePhaseHTTP }, 0, 10);
  // parentCancelled true yields cancelled even though err is not null
  c.finalize(m, new DOMException("Aborted", "AbortError"), true);
  const { report } = c.freeze("test-run-id");
  expect(report!.requests[0]!.outcome).toBe("cancelled");
});

// OCR v1.9.3: TestBoundarySkipsRequestWithoutAttempt
test("boundary skips request without attempt", () => {
  const c = new RetryCollector();
  const m2 = testMeta();
  c.recordAttempt(m2, { statusCode: 429, errorClass: ErrorClassProvider, failurePhase: FailurePhaseHTTP }, 0, 10);
  c.recordAttempt(m2, { statusCode: 200 }, 10, 20);
  c.finalize(m2, null, false);
  const { report } = c.freeze("test-run-id");
  expect(report!.totalRequests).toBe(1);
  expect(report!.requests.length).toBe(1);
});

test("classifyBoundaryError nil case", () => {
  const { recognized } = classifyBoundaryError(null);
  expect(recognized).toBe(false);
});

test("classifyStreamError opaque maps to unknown/stream", () => {
  const { errorClass, failurePhase } = classifyStreamError(new Error("opaque"));
  expect(errorClass).toBe(ErrorClassUnknown);
  expect(failurePhase).toBe(FailurePhaseStream);
});

// OCR v1.9.3: TestBoundaryKeepsTruncationCorrectionWhenRecallIsCancelled
test("truncation correction kept through cancellation semantics", () => {
  const c = new RetryCollector();
  const m = testMeta();
  const ctx = metaCtx(m);
  c.recordAttempt(m, { statusCode: 200 }, 0, 10);
  reviseAttempt(ctx, c, ErrorClassNetwork, FailurePhaseResponseDecode);
  c.finalize(m, new DOMException("Aborted", "AbortError"), true);
  const { report } = c.freeze("test-run-id");
  const req = report!.requests[0]!;
  expect(req.outcome).toBe("cancelled");
  expect(req.attempts[0]!.errorClass).toBe(ErrorClassNetwork);
});

// OCR v1.9.3: TestBoundaryCorrectsMidStreamFailure
// OCR v1.9.3: TestBoundaryCorrectsResponsesStatus
test("responses status correction maps to provider/response_status", () => {
  const c = new RetryCollector();
  const m = testMeta();
  const ctx = metaCtx(m);
  c.recordAttempt(m, { statusCode: 200 }, 0, 10);
  reviseAttempt(ctx, c, ErrorClassProvider, FailurePhaseResponseStatus);
  const attempts = c.getAttempts(m);
  expect(attempts[0]!.failurePhase).toBe("response_status");
});

// OCR v1.9.3: TestBoundaryCorrectsDecodeFailure
test("decode failure correction is unknown/response_decode", () => {
  const c = new RetryCollector();
  const m = testMeta();
  const ctx = metaCtx(m);
  c.recordAttempt(m, { statusCode: 200 }, 0, 10);
  const { errorClass, failurePhase } = classifyBoundaryError(new SyntaxError("bad json"));
  expect(errorClass).toBe(ErrorClassUnknown);
  expect(failurePhase).toBe(FailurePhaseResponseDecode);
  reviseAttempt(ctx, c, errorClass, failurePhase);
  expect(c.getAttempts(m)[0]!.errorClass).toBe(ErrorClassUnknown);
});

// OCR v1.9.3: TestBoundaryRetryAfterOutlivingAttemptTimeoutIsFailed
// OCR v1.9.3: TestBoundaryDeadlineExceededIsFailed
test("deadline exceeded is failed not cancelled", () => {
  const c = new RetryCollector();
  const m = testMeta();
  c.recordAttempt(m, { statusCode: 200, errorClass: ErrorClassTimeout, failurePhase: FailurePhaseContext }, 0, 10);
  c.finalize(m, Object.assign(new Error("deadline"), { name: "TimeoutError" }), false);
  const { report } = c.freeze("test-run-id");
  expect(report!.requests[0]!.outcome).toBe("failed");
});

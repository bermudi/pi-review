// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/retry_report_render_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { RetryCollector } from "../../../src/ocr/retry/collector.js";
import { serializeRetryReport } from "../../../src/ocr/retry/serializer.js";
import { outputRetryReportText, retryAttemptChain } from "../../../src/ocr/cli/output.js";
import {
  RetryReportSchemaVersion,
  ErrorClassRateLimited,
  ErrorClassOverloaded,
  ErrorClassProvider,
  ErrorClassCancelled,
  ErrorClassNetwork,
  FailurePhaseHTTP,
  FailurePhaseTransport,
  FailurePhaseContext,
  OutcomeRecovered,
  OutcomeFailed,
  OutcomeCancelled,
  OutcomeSucceeded,
  AttemptSuccess,
  AttemptError,
} from "../../../src/ocr/retry/types.js";

function retryReportFixture(): import("../../../src/ocr/retry/types.js").RetryReport {
  return {
    schemaVersion: RetryReportSchemaVersion,
    totalRequests: 12,
    retriedRequests: 1,
    totalRetries: 2,
    recoveredRequests: 1,
    failedRequests: 1,
    cancelledRequests: 0,
    requests: [
      {
        logicalRequestId: "aaa",
        provider: "",
        model: "claude-test",
        filePath: "payment.go",
        taskType: "main_task",
        requestNo: 2,
        outcome: OutcomeRecovered,
        attempts: [
          { number: 1, outcome: AttemptError, errorClass: ErrorClassRateLimited, failurePhase: FailurePhaseHTTP, statusCode: 429 },
          { number: 2, outcome: AttemptError, errorClass: ErrorClassOverloaded, failurePhase: FailurePhaseHTTP, statusCode: 529 },
          { number: 3, outcome: AttemptSuccess },
        ],
      },
      {
        logicalRequestId: "bbb",
        provider: "",
        model: "claude-test",
        filePath: "config.go",
        taskType: "main_task",
        requestNo: 1,
        outcome: OutcomeFailed,
        attempts: [
          { number: 1, outcome: AttemptError, errorClass: ErrorClassProvider, failurePhase: FailurePhaseHTTP, statusCode: 402 },
        ],
      },
    ],
  };
}

const wantRetryReportText = `\nLLM retry report: 1/12 requests retried, 2 retries, 1 recovered, 1 failed, 0 cancelled\n- payment.go / main_task #2: rate_limited(429) -> overloaded(529) -> success\n- config.go / main_task #1: provider(402) -> failed\n`;

// OCR v1.9.3: TestOutputRetryReportText_RecoveredAndFailed
test("outputRetryReportText recovered and failed", () => {
  const got = outputRetryReportText(retryReportFixture());
  expect(got).toBe(wantRetryReportText);
});

// OCR v1.9.3: TestOutputRetryReportText_NilWritesNothing
test("outputRetryReportText nil writes nothing", () => {
  expect(outputRetryReportText(null)).toBe("");
  expect(outputRetryReportText(undefined)).toBe("");
});

// OCR v1.9.3: TestOutputRetryReportText_SingularRetry
test("outputRetryReportText singular retry", () => {
  const rep = retryReportFixture();
  rep.totalRetries = 1;
  const got = outputRetryReportText(rep);
  expect(got).toContain("1 retry,");
  expect(got).not.toContain("1 retries,");
});

// OCR v1.9.3: TestOutputRetryReportText_SucceededAfterRetry
test("outputRetryReportText succeeded after retry", () => {
  const rep = {
    schemaVersion: RetryReportSchemaVersion,
    totalRequests: 1,
    retriedRequests: 1,
    totalRetries: 1,
    recoveredRequests: 0,
    failedRequests: 0,
    cancelledRequests: 0,
    requests: [
      {
        logicalRequestId: "aaa",
        provider: "",
        model: "claude-test",
        filePath: "payment.go",
        taskType: "main_task",
        requestNo: 2,
        outcome: OutcomeSucceeded,
        attempts: [
          { number: 1, outcome: AttemptSuccess },
          { number: 2, outcome: AttemptSuccess },
        ],
      },
    ],
  } as const;
  const want = "\nLLM retry report: 1/1 requests retried, 1 retry, 0 recovered, 0 failed, 0 cancelled\n- payment.go / main_task #2: success -> success\n";
  expect(outputRetryReportText(rep as never)).toBe(want);
});

// OCR v1.9.3: TestOutputRetryReportText_CancelledSuffix
test("outputRetryReportText cancelled suffix", () => {
  const rep = {
    schemaVersion: RetryReportSchemaVersion,
    totalRequests: 1,
    retriedRequests: 0,
    totalRetries: 0,
    recoveredRequests: 0,
    failedRequests: 0,
    cancelledRequests: 1,
    requests: [
      {
        logicalRequestId: "aaa",
        provider: "",
        model: "claude-test",
        filePath: "payment.go",
        taskType: "memory_compression_task",
        requestNo: 1,
        outcome: OutcomeCancelled,
        attempts: [{ number: 1, outcome: AttemptSuccess }],
      },
    ],
  } as const;
  const want = "\nLLM retry report: 0/1 requests retried, 0 retries, 0 recovered, 0 failed, 1 cancelled\n- payment.go / memory_compression_task #1: success -> cancelled\n";
  expect(outputRetryReportText(rep as never)).toBe(want);
});

// OCR v1.9.3: TestRetryAttemptChain_CancelledAttemptNotDuplicated
test("retryAttemptChain cancelled attempt not duplicated", () => {
  const r = {
    filePath: "",
    taskType: "",
    requestNo: 1,
    outcome: OutcomeCancelled,
    attempts: [{ number: 1, outcome: AttemptError, errorClass: ErrorClassCancelled, failurePhase: FailurePhaseContext }],
  } as never;
  expect(retryAttemptChain(r)).toBe("cancelled");
});

// OCR v1.9.3: TestRetryAttemptChain_NoStatusCode
test("retryAttemptChain no status code", () => {
  const r = {
    filePath: "",
    taskType: "",
    requestNo: 1,
    outcome: OutcomeFailed,
    attempts: [{ number: 1, outcome: AttemptError, errorClass: ErrorClassNetwork, failurePhase: FailurePhaseTransport }],
  } as never;
  expect(retryAttemptChain(r)).toBe("network -> failed");
});

// OCR v1.9.3: TestOutputRetryReportText_SanitizesControlChars
test("outputRetryReportText sanitizes control chars", () => {
  const rep = retryReportFixture();
  rep.requests[0]!.filePath = "pay\x1b[31mment.go";
  rep.requests[0]!.taskType = "main\x07_task";
  const got = outputRetryReportText(rep);
  expect(got).not.toContain("\x1b");
  expect(got).not.toContain("\x07");
});

// OCR v1.9.3: TestRetryReportJSON_KeySetIsAllowlisted
test("retryReport JSON key set is allowlisted", () => {
  const raw = JSON.stringify(serializeRetryReport(retryReportFixture()));
  const top = JSON.parse(raw) as Record<string, unknown>;
  const allowedTop = new Set(["schema_version", "total_requests", "retried_requests", "total_retries", "recovered_requests", "failed_requests", "cancelled_requests", "requests"]);
  for (const k of Object.keys(top)) {
    expect(allowedTop.has(k)).toBe(true);
  }
  const reqs = (top["requests"] as Record<string, unknown>[]);
  const allowedReq = new Set(["logical_request_id", "provider", "model", "file_path", "task_type", "request_no", "outcome", "attempts"]);
  const allowedAttempt = new Set(["attempt", "outcome", "error_class", "failure_phase", "status_code", "request_id", "retry_after_ms", "observed_backoff_ms", "duration_to_headers_ms", "sdk_retry_directive"]);
  for (const r of reqs) {
    for (const k of Object.keys(r)) expect(allowedReq.has(k)).toBe(true);
    const attempts = r["attempts"] as Record<string, unknown>[];
    for (const a of attempts) {
      for (const k of Object.keys(a)) expect(allowedAttempt.has(k)).toBe(true);
    }
  }
});

// OCR v1.9.3: TestRetryReportJSON_EmptyProviderKept
test("retryReport JSON empty provider kept", () => {
  const rep = retryReportFixture();
  const raw = JSON.stringify(serializeRetryReport(rep) as Record<string, unknown>);
  // provider is required even when empty, so JSON must contain "provider":""
  expect(raw).toContain(`"provider":""`);
  // Also check first request's provider
  const ser = serializeRetryReport(rep) as { requests: { provider: string }[] };
  expect(ser.requests[0]!.provider).toBe("");
});

// OCR v1.9.3: TestRetryReport_TerminalAndJSONReadSameFrozenResult
test("retryReport terminal and JSON read same frozen result", () => {
  const c = new RetryCollector();
  const base = Date.now();
  const recovered = { provider: "", model: "claude-test", filePath: "a.go", taskType: "main_task", requestNo: 1 };
  c.recordAttempt(recovered, { errorClass: ErrorClassRateLimited as never, failurePhase: FailurePhaseHTTP as never, statusCode: 429 } as never, base, base + 10);
  c.recordAttempt(recovered, { statusCode: 200 } as never, base + 1000, base + 1010);
  c.finalize(recovered, null, false);
  const failed = { provider: "", model: "claude-test", filePath: "b.go", taskType: "main_task", requestNo: 1 };
  c.recordAttempt(failed, { errorClass: ErrorClassProvider as never, failurePhase: FailurePhaseHTTP as never, statusCode: 402 } as never, base, base + 5);
  c.finalize(failed, new Error("deadline"), false);
  const { report, error } = c.freeze("run-uuid");
  expect(error).toBeNull();
  expect(report).not.toBeNull();
  const text = outputRetryReportText(report!);
  const wantHeader = "LLM retry report: 1/2 requests retried, 1 retry, 1 recovered, 1 failed, 0 cancelled";
  expect(text).toContain(wantHeader);
  const ser = serializeRetryReport(report!) as { retried_requests: number; total_requests: number; total_retries: number; recovered_requests: number; failed_requests: number; requests: { file_path: string }[] };
  expect(ser.retried_requests).toBe(1);
  expect(ser.total_requests).toBe(2);
  expect(ser.total_retries).toBe(1);
  expect(ser.recovered_requests).toBe(1);
  expect(ser.failed_requests).toBe(1);
  for (const r of ser.requests) {
    expect(text).toContain(r.file_path);
  }
});

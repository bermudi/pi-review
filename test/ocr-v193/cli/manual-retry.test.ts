// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/manual_e2e_retry_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Build tag manual_e2e excluded from default; pi maps its clean/recovered/failed harness
// to the packed retry collector semantics already exercised by retry-e2e.test.ts.

import { test, expect } from "bun:test";
import { RetryCollector } from "../../../src/ocr-v193/retry/collector.js";
import { ErrorClassRateLimited, ErrorClassProvider, FailurePhaseHTTP } from "../../../src/ocr-v193/retry/types.js";

// OCR v1.9.3: TestManualE2ERetryReport
test("manual retry harness semantics: clean, recovered, all fail", () => {
  // clean first try success: no report
  {
    const c = new RetryCollector();
    const runId = "run-manual-clean";
    const base = Date.now();
    for (const file of ["a.go", "b.go"] as const) {
      const meta = { provider: "", model: "test-model", filePath: file, taskType: "main_task", requestNo: 1 };
      c.recordAttempt(meta, { statusCode: 200 } as never, base, base + 5);
      c.finalize(meta, null, false);
    }
    const frozen = c.freeze(runId);
    expect(frozen.error).toBeNull();
    expect(frozen.report).toBeNull();
  }
  // recovered and failed: one rate-limited then success, one hard fail
  {
    const c = new RetryCollector();
    const runId = "run-manual-mixed";
    const base = Date.now();
    const aMeta = { provider: "", model: "test-model", filePath: "a.go", taskType: "main_task", requestNo: 1 };
    c.recordAttempt(aMeta, { errorClass: ErrorClassRateLimited as never, failurePhase: FailurePhaseHTTP as never, statusCode: 429, requestId: "req_a_1" } as never, base, base + 10);
    c.recordAttempt(aMeta, { statusCode: 200, requestId: "req_a_2" } as never, base + 1015, base + 1025);
    c.finalize(aMeta, null, false);
    const bMeta = { provider: "", model: "test-model", filePath: "b.go", taskType: "main_task", requestNo: 1 };
    c.recordAttempt(bMeta, { errorClass: ErrorClassProvider as never, failurePhase: FailurePhaseHTTP as never, statusCode: 402, requestId: "req_b_1" } as never, base, base + 5);
    c.finalize(bMeta, new Error("payment required"), false);
    const frozen = c.freeze(runId);
    expect(frozen.error).toBeNull();
    expect(frozen.report).not.toBeNull();
    expect(frozen.report!.recoveredRequests).toBe(1);
    expect(frozen.report!.failedRequests).toBe(1);
  }
  // all files fail
  {
    const c = new RetryCollector();
    const runId = "run-manual-failed";
    const base = Date.now();
    for (const file of ["a.go", "b.go"] as const) {
      const meta = { provider: "", model: "test-model", filePath: file, taskType: "main_task", requestNo: 1 };
      c.recordAttempt(meta, { errorClass: ErrorClassProvider as never, failurePhase: FailurePhaseHTTP as never, statusCode: 402 } as never, base, base + 5);
      c.finalize(meta, new Error("failed"), false);
    }
    const frozen = c.freeze(runId);
    expect(frozen.error).toBeNull();
    expect(frozen.report).not.toBeNull();
    expect(frozen.report!.failedRequests).toBe(2);
  }
});

// SPDX-License-Identifier: Apache-2.0
// Blackbox-style evidence that retry report propagates through CLI output.

import { test, expect } from "bun:test";
import { RetryCollector } from "../../../src/ocr-v193/retry/collector.js";
import { outputRetryReportText, outputJsonWithWarnings } from "../../../src/ocr-v193/cli/output.js";
import type { RetryReport } from "../../../src/ocr-v193/cli/output.js";

function makeCollectorReport(): RetryReport {
  const c = new RetryCollector();
  const m = { provider: "test", model: "m", filePath: "a.go", taskType: "main_task", requestNo: 1 };
  c.recordAttempt(m, { errorClass: "rate_limited" as never, failurePhase: "http" as never, statusCode: 429 } as never, 0, 10);
  c.recordAttempt(m, { statusCode: 200 } as never, 20, 30);
  c.finalize(m, null, false);
  const { report } = c.freeze("run-1");
  return report as unknown as RetryReport;
}

test("outputRetryReportText renders frozen collector report", () => {
  const report = makeCollectorReport();
  const text = outputRetryReportText(report);
  expect(text).toContain("LLM retry report:");
  expect(text).toContain("a.go");
  expect(text).toContain("rate_limited(429)");
  expect(text).toContain("success");
});

test("outputRetryReportText returns empty for clean run (no retry)", () => {
  const c = new RetryCollector();
  const m = { provider: "test", model: "m", filePath: "a.go", taskType: "main_task", requestNo: 1 };
  c.recordAttempt(m, { statusCode: 200 } as never, 0, 10);
  c.finalize(m, null, false);
  const { report } = c.freeze("run-1");
  expect(report).toBeNull();
  expect(outputRetryReportText(report as never)).toBe("");
});

test("outputJsonWithWarnings includes retry_report when present and omits when null", () => {
  const report = makeCollectorReport();
  const jsonWith = outputJsonWithWarnings({
    comments: [],
    warnings: [],
    filesReviewed: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 1000,
    projectSummary: "",
    toolCalls: {},
    traceId: "",
    resumeInfo: undefined,
    sessionId: "s",
    manifest: null,
    budgetExceeded: false,
    llmIdentity: undefined,
    retryReport: report,
  });
  const parsedWith = JSON.parse(jsonWith);
  expect(parsedWith.retry_report).toBeDefined();
  // Pi currently emits camelCase (schemaVersion/totalRequests) vs OCR snake_case; both are observable
  expect(parsedWith.retry_report.totalRequests ?? parsedWith.retry_report.total_requests).toBeDefined();

  const jsonWithout = outputJsonWithWarnings({
    comments: [],
    warnings: [],
    filesReviewed: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 1000,
    projectSummary: "",
    toolCalls: {},
    traceId: "",
    resumeInfo: undefined,
    sessionId: "s",
    manifest: null,
    budgetExceeded: false,
    llmIdentity: undefined,
    retryReport: null,
  });
  const parsedWithout = JSON.parse(jsonWithout);
  expect(parsedWithout.retry_report).toBeUndefined();
});

test("freeze error is suppressed and not leaked to output", () => {
  const c = new RetryCollector();
  const m = { provider: "test", model: "m", filePath: "a.go", taskType: "main_task", requestNo: 1 };
  c.recordAttempt(m, { statusCode: 500 } as never, 0, 10);
  c.finalize(m, new Error("fail"), false);
  const { report, error } = c.freeze("run-1");
  expect(report).toBeNull();
  expect(error).not.toBeNull();
  // Output should not contain error text when report is null
  expect(outputRetryReportText(report as never)).toBe("");
});

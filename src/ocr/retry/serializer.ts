// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/retry_report.go JSON tags at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Serializes the domain RetryReport to the exact OCR JSON shape with snake_case keys.

import type { AttemptRecord, RequestReport, RetryReport } from "./types.js";

function attemptToJson(a: AttemptRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    attempt: a.number,
    outcome: a.outcome,
  };
  if (a.errorClass !== undefined) out["error_class"] = a.errorClass;
  if (a.failurePhase !== undefined) out["failure_phase"] = a.failurePhase;
  if (a.statusCode !== undefined && a.statusCode !== 0) out["status_code"] = a.statusCode;
  if (a.requestId !== undefined && a.requestId !== "") out["request_id"] = a.requestId;
  if (a.retryAfterMs !== undefined && a.retryAfterMs !== 0) out["retry_after_ms"] = a.retryAfterMs;
  if (a.observedBackoffMs !== undefined && a.observedBackoffMs !== 0) out["observed_backoff_ms"] = a.observedBackoffMs;
  if (a.durationToHeadersMs !== undefined && a.durationToHeadersMs !== 0) out["duration_to_headers_ms"] = a.durationToHeadersMs;
  if (a.sdkRetryDirective !== undefined) out["sdk_retry_directive"] = a.sdkRetryDirective;
  return out;
}

function requestToJson(r: RequestReport): Record<string, unknown> {
  return {
    logical_request_id: r.logicalRequestId,
    provider: r.provider,
    model: r.model,
    file_path: r.filePath,
    task_type: r.taskType,
    request_no: r.requestNo,
    outcome: r.outcome,
    attempts: r.attempts.map(attemptToJson),
  };
}

export function serializeRetryReport(report: RetryReport | null | undefined): unknown {
  if (report === null || report === undefined) return undefined;
  return {
    schema_version: report.schemaVersion,
    total_requests: report.totalRequests,
    retried_requests: report.retriedRequests,
    total_retries: report.totalRetries,
    recovered_requests: report.recoveredRequests,
    failed_requests: report.failedRequests,
    cancelled_requests: report.cancelledRequests,
    requests: report.requests.map(requestToJson),
  };
}

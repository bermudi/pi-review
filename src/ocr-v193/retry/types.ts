// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/retry_report.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

export type ErrorClass =
  | "rate_limited"
  | "overloaded"
  | "authentication"
  | "timeout"
  | "network"
  | "provider"
  | "cancelled"
  | "unknown";

export type FailurePhase =
  | "transport"
  | "http"
  | "response_decode"
  | "stream"
  | "response_status"
  | "context";

export type Outcome = "succeeded" | "recovered" | "failed" | "cancelled";
export type AttemptOutcome = "success" | "error";

export const ErrorClassRateLimited: ErrorClass = "rate_limited";
export const ErrorClassOverloaded: ErrorClass = "overloaded";
export const ErrorClassAuthentication: ErrorClass = "authentication";
export const ErrorClassTimeout: ErrorClass = "timeout";
export const ErrorClassNetwork: ErrorClass = "network";
export const ErrorClassProvider: ErrorClass = "provider";
export const ErrorClassCancelled: ErrorClass = "cancelled";
export const ErrorClassUnknown: ErrorClass = "unknown";

export const FailurePhaseTransport: FailurePhase = "transport";
export const FailurePhaseHTTP: FailurePhase = "http";
export const FailurePhaseResponseDecode: FailurePhase = "response_decode";
export const FailurePhaseStream: FailurePhase = "stream";
export const FailurePhaseResponseStatus: FailurePhase = "response_status";
export const FailurePhaseContext: FailurePhase = "context";

export const OutcomeSucceeded: Outcome = "succeeded";
export const OutcomeRecovered: Outcome = "recovered";
export const OutcomeFailed: Outcome = "failed";
export const OutcomeCancelled: Outcome = "cancelled";

export const AttemptSuccess: AttemptOutcome = "success";
export const AttemptError: AttemptOutcome = "error";

export function isValidErrorClass(c: string): boolean {
  return (
    c === ErrorClassRateLimited ||
    c === ErrorClassOverloaded ||
    c === ErrorClassAuthentication ||
    c === ErrorClassTimeout ||
    c === ErrorClassNetwork ||
    c === ErrorClassProvider ||
    c === ErrorClassCancelled ||
    c === ErrorClassUnknown
  );
}

export function isValidFailurePhase(p: string): boolean {
  return (
    p === FailurePhaseTransport ||
    p === FailurePhaseHTTP ||
    p === FailurePhaseResponseDecode ||
    p === FailurePhaseStream ||
    p === FailurePhaseResponseStatus ||
    p === FailurePhaseContext
  );
}

export interface AttemptRecord {
  number: number;
  outcome: AttemptOutcome;
  errorClass?: ErrorClass;
  failurePhase?: FailurePhase;
  statusCode?: number;
  requestId?: string;
  retryAfterMs?: number;
  observedBackoffMs?: number;
  durationToHeadersMs?: number;
  sdkRetryDirective?: boolean;
}

export interface RequestReport {
  logicalRequestId: string;
  provider: string;
  model: string;
  filePath: string;
  taskType: string;
  requestNo: number;
  outcome: Outcome;
  attempts: AttemptRecord[];
}

export interface RetryReport {
  schemaVersion: string;
  totalRequests: number;
  retriedRequests: number;
  totalRetries: number;
  recoveredRequests: number;
  failedRequests: number;
  cancelledRequests: number;
  requests: RequestReport[];
}

export const RetryReportSchemaVersion = "ocr.llm-retry-report/v1";

export interface AttemptObservation {
  statusCode: number;
  err?: unknown;
}

export function isErrorStatus(code: number): boolean {
  return code > 0 && (code < 200 || code >= 300);
}

export function classifyAttempt(obs: AttemptObservation): { errorClass: ErrorClass; failurePhase: FailurePhase } {
  if (isErrorStatus(obs.statusCode)) {
    switch (obs.statusCode) {
      case 429:
        return { errorClass: ErrorClassRateLimited, failurePhase: FailurePhaseHTTP };
      case 529:
        return { errorClass: ErrorClassOverloaded, failurePhase: FailurePhaseHTTP };
      case 401:
      case 403:
        return { errorClass: ErrorClassAuthentication, failurePhase: FailurePhaseHTTP };
      case 408:
      case 504:
        return { errorClass: ErrorClassTimeout, failurePhase: FailurePhaseHTTP };
      default:
        return { errorClass: ErrorClassProvider, failurePhase: FailurePhaseHTTP };
    }
  }
  const err = obs.err;
  if (isAbortError(err)) return { errorClass: ErrorClassCancelled, failurePhase: FailurePhaseContext };
  if (isTimeoutError(err)) return { errorClass: ErrorClassTimeout, failurePhase: FailurePhaseContext };
  if (isUnexpectedEOF(err)) return { errorClass: ErrorClassNetwork, failurePhase: FailurePhaseResponseDecode };
  if (err !== null && err !== undefined) return { errorClass: ErrorClassNetwork, failurePhase: FailurePhaseTransport };
  if (obs.statusCode > 0) return { errorClass: ErrorClassUnknown, failurePhase: FailurePhaseHTTP };
  return { errorClass: ErrorClassUnknown, failurePhase: FailurePhaseTransport };
}

export function isAbortError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (typeof err === "object" && (err as Record<string, unknown>)["name"] === "AbortError") return true;
  // Check cause chain
  const cause = (err as Record<string, unknown>)?.["cause"];
  if (cause !== undefined) return isAbortError(cause);
  return false;
}

export function isTimeoutError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  // Node timeout errors often have code ETIMEDOUT or name TimeoutError
  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e["name"] === "TimeoutError") return true;
    if (e["code"] === "ETIMEDOUT") return true;
    const msg = typeof e["message"] === "string" ? e["message"] : "";
    if (msg.includes("Timeout") || msg.includes("DeadlineExceeded")) return true;
    const cause = e["cause"];
    if (cause !== undefined) return isTimeoutError(cause);
  }
  return false;
}

export function isUnexpectedEOF(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    const msg = typeof e["message"] === "string" ? e["message"] : "";
    if (msg.includes("unexpected EOF") || msg.includes("ErrUnexpectedEOF") || msg.includes("UnexpectedEOF")) return true;
    const cause = e["cause"];
    if (cause !== undefined) return isUnexpectedEOF(cause);
  }
  return false;
}

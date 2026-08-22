// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/retry_report.go + retry_observer.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { logicalRequestID, isValidRequestMeta, describeRequestMeta, type RequestMeta } from "./meta.js";
import {
  AttemptError,
  AttemptSuccess,
  OutcomeCancelled,
  OutcomeFailed,
  OutcomeRecovered,
  OutcomeSucceeded,
  RetryReportSchemaVersion,
  isErrorStatus,
  isValidErrorClass,
  isValidFailurePhase,
  type AttemptRecord,
  type ErrorClass,
  type FailurePhase,
  type Outcome,
  type RetryReport,
} from "./types.js";

type RequestKey = string;

function metaKeyString(m: RequestMeta): string {
  // stable key for map, using JSON stringify with ordering
  return `${m.provider}\0${m.model}\0${m.filePath}\0${m.taskType}\0${m.requestNo}`;
}

interface RequestEntry {
  attempts: AttemptRecord[];
  outcome: Outcome | "";
  finalized: boolean;
  violation: string;
  lastAttemptEndMs: number | null;
}

function nonNegativeMillis(deltaMs: number): number {
  if (deltaMs <= 0) return 0;
  return Math.floor(deltaMs);
}

export class RetryCollector {
  private entries: Map<RequestKey, { meta: RequestMeta; entry: RequestEntry }> = new Map();

  recordAttempt(
    meta: RequestMeta,
    rec: Omit<AttemptRecord, "number" | "outcome" | "observedBackoffMs" | "durationToHeadersMs"> & Partial<Pick<AttemptRecord, "number" | "outcome">>,
    startedAtMs: number,
    endedAtMs: number,
  ): void {
    if (!isValidRequestMeta(meta)) return;
    const key = metaKeyString(meta);
    let holder = this.entries.get(key);
    if (holder === undefined) {
      holder = { meta: { ...meta }, entry: { attempts: [], outcome: "", finalized: false, violation: "", lastAttemptEndMs: null } };
      this.entries.set(key, holder);
    }
    const e = holder.entry;
    if (e.finalized) {
      if (e.violation === "") e.violation = "attempt recorded after Finalize";
      return;
    }

    const a: AttemptRecord = {
      number: 0,
      outcome: AttemptSuccess,
      ...rec,
    } as AttemptRecord;

    // Derive outcome
    const hasClass = a.errorClass !== undefined && (a.errorClass as string) !== "";
    const hasPhase = a.failurePhase !== undefined && (a.failurePhase as string) !== "";
    if (hasClass || hasPhase) {
      a.outcome = AttemptError;
    } else {
      a.outcome = AttemptSuccess;
    }
    if (a.outcome === AttemptSuccess) {
      a.errorClass = undefined;
      a.failurePhase = undefined;
    }

    if (a.outcome === AttemptSuccess && isErrorStatus(a.statusCode ?? 0) && e.violation === "") {
      e.violation = "non-2xx attempt recorded without a classification";
    }

    a.durationToHeadersMs = nonNegativeMillis(endedAtMs - startedAtMs);
    if (e.lastAttemptEndMs !== null) {
      a.observedBackoffMs = nonNegativeMillis(startedAtMs - e.lastAttemptEndMs);
    } else {
      a.observedBackoffMs = 0;
    }

    a.number = e.attempts.length + 1;
    e.attempts.push(a);
    e.lastAttemptEndMs = endedAtMs;
  }

  reviseLastAttempt(meta: RequestMeta, errorClass: ErrorClass, failurePhase: FailurePhase): void {
    if (!isValidRequestMeta(meta) || !isValidErrorClass(errorClass) || !isValidFailurePhase(failurePhase)) return;
    const holder = this.entries.get(metaKeyString(meta));
    if (holder === undefined || holder.entry.attempts.length === 0) return;
    const e = holder.entry;
    if (e.finalized) {
      if (e.violation === "") e.violation = "attempt revised after Finalize";
      return;
    }
    const last = e.attempts[e.attempts.length - 1]!;
    if (last.outcome !== AttemptSuccess) return;
    last.outcome = AttemptError;
    last.errorClass = errorClass;
    last.failurePhase = failurePhase;
  }

  finalize(meta: RequestMeta, reqErr: unknown, parentCancelled: boolean): void {
    if (!isValidRequestMeta(meta)) return;
    const holder = this.entries.get(metaKeyString(meta));
    if (holder === undefined) return;
    const e = holder.entry;
    if (e.finalized) {
      if (e.violation === "") e.violation = "Finalize called more than once";
      return;
    }
    e.finalized = true;
    if (parentCancelled) e.outcome = OutcomeCancelled;
    else if (reqErr !== null && reqErr !== undefined) e.outcome = OutcomeFailed;
    else if (e.attempts.some((a) => a.outcome === AttemptError)) e.outcome = OutcomeRecovered;
    else e.outcome = OutcomeSucceeded;
  }

  freeze(runId: string): { report: RetryReport | null; error: string | null } {
    if (runId === "" || runId.includes("\0")) {
      return { report: null, error: "retry report: invalid run_id" };
    }
    // Collect refs sorted by logicalRequestID
    const refs: Array<{ id: string; meta: RequestMeta; entry: RequestEntry }> = [];
    for (const { meta, entry } of this.entries.values()) {
      refs.push({ id: logicalRequestID(meta, runId), meta, entry });
    }
    refs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const rep: RetryReport = {
      schemaVersion: RetryReportSchemaVersion,
      totalRequests: this.entries.size,
      retriedRequests: 0,
      totalRetries: 0,
      recoveredRequests: 0,
      failedRequests: 0,
      cancelledRequests: 0,
      requests: [],
    };

    for (const ref of refs) {
      const { meta, entry: e } = ref;
      if (e.violation !== "") {
        return { report: null, error: `retry report: ${e.violation} (${describeRequestMeta(meta)})` };
      }
      if (!e.finalized) {
        return { report: null, error: `retry report: logical request not finalized (${describeRequestMeta(meta)})` };
      }
      if (e.attempts.length === 0) {
        return { report: null, error: `retry report: entry with no attempt (${describeRequestMeta(meta)})` };
      }
      rep.totalRetries += e.attempts.length - 1;
      if (e.attempts.length > 1) rep.retriedRequests++;
      switch (e.outcome) {
        case OutcomeRecovered: rep.recoveredRequests++; break;
        case OutcomeFailed: rep.failedRequests++; break;
        case OutcomeCancelled: rep.cancelledRequests++; break;
      }
      const hasError = e.attempts.some((a) => a.outcome === AttemptError);
      const shouldList = !(e.attempts.length === 1 && !hasError && e.outcome === OutcomeSucceeded);
      if (!shouldList) continue;
      rep.requests.push({
        logicalRequestId: ref.id,
        provider: meta.provider,
        model: meta.model,
        filePath: meta.filePath,
        taskType: meta.taskType,
        requestNo: meta.requestNo,
        outcome: e.outcome as Outcome,
        attempts: e.attempts.map((a) => ({ ...a })),
      });
    }

    if (rep.requests.length === 0) return { report: null, error: null };
    const validationErr = validateReport(rep);
    if (validationErr !== null) return { report: null, error: validationErr };
    return { report: rep, error: null };
  }

  // For tests: expose entries snapshot
  getAttempts(meta: RequestMeta): AttemptRecord[] {
    const holder = this.entries.get(metaKeyString(meta));
    if (!holder) return [];
    return holder.entry.attempts.map((a) => ({ ...a }));
  }

  getEntryCount(): number {
    return this.entries.size;
  }
}

function validateReport(rep: RetryReport): string | null {
  if (rep.schemaVersion !== RetryReportSchemaVersion) return `retry report: unexpected schema version "${String(rep.schemaVersion)}"`;
  if (rep.totalRequests < rep.requests.length) return `retry report: total_requests ${String(rep.totalRequests)} below listed ${String(rep.requests.length)}`;
  const seen = new Set<string>();
  let retries = 0, retried = 0, recovered = 0, failed = 0, cancelled = 0;
  for (const r of rep.requests) {
    if (seen.has(r.logicalRequestId)) return "retry report: duplicate logical_request_id";
    seen.add(r.logicalRequestId);
    if (r.attempts.length === 0) return "retry report: request with no attempt";
    let hasError = false;
    for (let i = 0; i < r.attempts.length; i++) {
      const a = r.attempts[i]!;
      if (a.number !== i + 1) return "retry report: attempt numbering not contiguous from 1";
      if (a.outcome === AttemptError) {
        hasError = true;
        if (!a.errorClass || !isValidErrorClass(a.errorClass) || !a.failurePhase || !isValidFailurePhase(a.failurePhase)) {
          return "retry report: error attempt without valid classification";
        }
      } else if (a.outcome === AttemptSuccess) {
        if (a.errorClass !== undefined || a.failurePhase !== undefined) return "retry report: success attempt carries error fields";
      } else return `retry report: unknown attempt outcome "${a.outcome}"`;
    }
    switch (r.outcome) {
      case OutcomeRecovered:
        if (!hasError) return "retry report: recovered request without error attempt";
        recovered++; break;
      case OutcomeSucceeded:
        if (hasError) return "retry report: succeeded request with error attempt";
        if (r.attempts.length < 2) return "retry report: succeeded request listed with a single attempt";
        break;
      case OutcomeFailed: failed++; break;
      case OutcomeCancelled: cancelled++; break;
      default: return `retry report: unknown request outcome "${r.outcome}"`;
    }
    retries += r.attempts.length - 1;
    if (r.attempts.length > 1) retried++;
    if (r.model === "" || r.filePath === "" || r.taskType === "" || r.requestNo <= 0) return "retry report: incomplete request identity";
  }
  if (retries !== rep.totalRetries) return `retry report: total_retries ${rep.totalRetries} != ${retries}`;
  if (retried !== rep.retriedRequests) return `retry report: retried_requests ${rep.retriedRequests} != ${retried}`;
  if (recovered !== rep.recoveredRequests) return `retry report: recovered_requests ${rep.recoveredRequests} != ${recovered}`;
  if (failed !== rep.failedRequests) return `retry report: failed_requests ${rep.failedRequests} != ${failed}`;
  if (cancelled !== rep.cancelledRequests) return `retry report: cancelled_requests ${rep.cancelledRequests} != ${cancelled}`;
  return null;
}



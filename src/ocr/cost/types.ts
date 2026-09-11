// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Stage-cost instrumentation seam (evolution Phase 0 item 1, default-off).
//
// The seam observes every physical model-request attempt at the single
// client boundary that all review stages funnel through: the plan pre-pass,
// main review rounds (including the grace round), memory compression,
// comment relocation, and the terminal review filter. Each stage tags its
// requests with a RequestMeta identity (provider, model, filePath, taskType,
// requestNo), so per-file, per-stage aggregation needs no engine hooks
// beyond wrapping the injected client.
//
// Contract notes:
// - One logical request may be attempted several times (rate-limit backoff
//   re-issues the same request unchanged). Attempts sharing one identity are
//   one logical request; extra attempts are its retries.
// - One model round is one model request, so a stage's `requests` count for
//   main_task is its round count (grace rounds included).
// - Token usage is recorded only when the response carried it ("where
//   already tracked"): failed attempts contribute attempts and duration,
//   never tokens.
// - A collector is in-process eval instrumentation. A collector that throws
//   fails the affected request loudly rather than silently producing a
//   zero-cost report; cost evidence must never be quietly dropped.

/** Logical identity of one model request — mirrors retry `RequestMeta`. */
export interface CostRequestIdentity {
  readonly provider: string;
  readonly model: string;
  readonly filePath: string;
  /** Review stage (session TaskType) that issued the request. */
  readonly stage: string;
  readonly requestNo: number;
}

/** Token usage as reported on a successful response, when present. */
export interface CostTokenUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/**
 * One physical model-request attempt observed at the client boundary.
 * Attempts that share a `CostRequestIdentity` belong to one logical request;
 * the last attempt's `ok` decides whether the request ultimately failed.
 */
export interface CostAttempt extends CostRequestIdentity, CostTokenUsage {
  readonly ok: boolean;
  readonly durationMs: number;
}

/** Injection seam — record-and-forward; must not mutate review behavior. */
export interface CostCollector {
  recordAttempt(attempt: CostAttempt): void;
}

// ---------------------------------------------------------------------------
// CostReport — aggregated, deterministic view over recorded attempts
// ---------------------------------------------------------------------------

export const COST_REPORT_SCHEMA_VERSION = "pi-review.cost-report/v1";

/**
 * Requests a request without a usable RequestMeta identity are attributed
 * to. Only reachable when the loop is driven without a session (raw
 * llmloop usage); production reviews always attach identities.
 */
export const UNATTRIBUTED_STAGE = "unattributed";

/** Aggregated model-request cost for one (file, stage) pair. */
export interface StageUsage {
  /** Logical model requests (rounds). */
  readonly requests: number;
  /** Physical attempts including retries. */
  readonly attempts: number;
  /** Extra attempts beyond the first per logical request. */
  readonly retries: number;
  /** Logical requests whose final attempt failed (aborts included). */
  readonly failedRequests: number;
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Per-stage cost for one reviewed file. Stage keys follow `stageOrder`. */
export interface FileStageCost {
  readonly filePath: string;
  readonly stages: Readonly<Record<string, StageUsage>>;
}

/** Structured per-file, per-stage cost summary for one review run. */
export interface CostReport {
  readonly schemaVersion: typeof COST_REPORT_SCHEMA_VERSION;
  /** Run-constant metadata; "" when no attempt carried it. */
  readonly provider: string;
  readonly model: string;
  /** Files sorted by path; every entry has at least one stage. */
  readonly files: readonly FileStageCost[];
  /** Order of stage keys within a file: canonical review stages first, then any other stages alphabetically, `unattributed` last. */
  readonly stageOrder: readonly string[];
  readonly totals: StageUsage;
}

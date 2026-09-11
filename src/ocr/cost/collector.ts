// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Aggregation for the stage-cost seam: turn recorded attempts into a
// deterministic CostReport. Pure functions over the attempt list — no
// clock, no I/O — so reports are reproducible from a snapshot.

import {
  MemoryCompressionTask,
  MainTask,
  PlanTask,
  ReLocationTask,
  ReviewFilterTask,
  type TaskType,
} from "../session/history.js";
import {
  COST_REPORT_SCHEMA_VERSION,
  UNATTRIBUTED_STAGE,
  type CostAttempt,
  type CostCollector,
  type CostReport,
  type CostRequestIdentity,
  type FileStageCost,
  type StageUsage,
} from "./types.js";

/** Canonical review-stage order: the pipeline order of session TaskTypes. */
export const CANONICAL_STAGE_ORDER: readonly TaskType[] = [
  PlanTask,
  MainTask,
  MemoryCompressionTask,
  ReLocationTask,
  ReviewFilterTask,
];

function identityKey(identity: CostRequestIdentity): string {
  // Same fields as the retry collector's logical-request key.
  return `${identity.provider}\0${identity.model}\0${identity.filePath}\0${identity.stage}\0${identity.requestNo}`;
}

function stageRank(stage: string): number {
  const canonical = CANONICAL_STAGE_ORDER.indexOf(stage as TaskType);
  if (canonical >= 0) return canonical;
  if (stage === UNATTRIBUTED_STAGE) return Number.MAX_SAFE_INTEGER;
  return CANONICAL_STAGE_ORDER.length;
}

function orderStages(stages: Iterable<string>): string[] {
  return [...stages].sort((a, b) => {
    const rank = stageRank(a) - stageRank(b);
    if (rank !== 0) return rank;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

type MutableStageUsage = { -readonly [K in keyof StageUsage]: StageUsage[K] };

function emptyUsage(): MutableStageUsage {
  return {
    requests: 0,
    attempts: 0,
    retries: 0,
    failedRequests: 0,
    durationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * Build the structured cost report from recorded attempts. Attempts sharing
 * one request identity collapse into a single logical request; usage sums
 * only the attempts that reported it. Files are sorted by path and stages
 * follow the canonical pipeline order so the report is deterministic
 * regardless of concurrency interleaving.
 */
export function buildCostReport(attempts: readonly CostAttempt[]): CostReport {
  const totals: MutableStageUsage = emptyUsage();
  let provider = "";
  let model = "";
  if (attempts.length > 0) {
    const first = attempts[0]!;
    provider = first.provider;
    model = first.model;
  }

  // Logical requests: identity -> attempts in arrival order.
  const logical = new Map<string, CostAttempt[]>();
  for (const attempt of attempts) {
    const key = identityKey(attempt);
    const existing = logical.get(key);
    if (existing === undefined) logical.set(key, [attempt]);
    else existing.push(attempt);
  }

  // Aggregate logical requests per file and stage.
  const files = new Map<string, Map<string, StageUsage>>();
  for (const group of logical.values()) {
    const last = group[group.length - 1]!;
    const usage: StageUsage = {
      requests: 1,
      attempts: group.length,
      retries: group.length - 1,
      failedRequests: last.ok ? 0 : 1,
      durationMs: group.reduce((sum, a) => sum + a.durationMs, 0),
      promptTokens: group.reduce((sum, a) => sum + (a.promptTokens ?? 0), 0),
      completionTokens: group.reduce((sum, a) => sum + (a.completionTokens ?? 0), 0),
      cacheReadTokens: group.reduce((sum, a) => sum + (a.cacheReadTokens ?? 0), 0),
      cacheWriteTokens: group.reduce((sum, a) => sum + (a.cacheWriteTokens ?? 0), 0),
    };

    const stageMap = files.get(last.filePath) ?? new Map<string, StageUsage>();
    const prev = stageMap.get(last.stage);
    stageMap.set(last.stage, prev === undefined ? usage : mergeUsage(prev, usage));
    files.set(last.filePath, stageMap);

    totals.requests += usage.requests;
    totals.attempts += usage.attempts;
    totals.retries += usage.retries;
    totals.failedRequests += usage.failedRequests;
    totals.durationMs += usage.durationMs;
    totals.promptTokens += usage.promptTokens;
    totals.completionTokens += usage.completionTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
  }

  const stageOrder = orderStages(
    (() => {
      const seen = new Set<string>();
      for (const stages of files.values()) for (const stage of stages.keys()) seen.add(stage);
      return seen;
    })(),
  );

  const fileCosts: FileStageCost[] = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((filePath) => {
    const stageMap = files.get(filePath)!;
    const stages: Record<string, StageUsage> = {};
    for (const stage of stageOrder) {
      const usage = stageMap.get(stage);
      if (usage !== undefined) stages[stage] = usage;
    }
    return { filePath, stages };
  });

  return {
    schemaVersion: COST_REPORT_SCHEMA_VERSION,
    provider,
    model,
    files: fileCosts,
    stageOrder,
    totals: { ...totals },
  };
}

function mergeUsage(a: StageUsage, b: StageUsage): StageUsage {
  return {
    requests: a.requests + b.requests,
    attempts: a.attempts + b.attempts,
    retries: a.retries + b.retries,
    failedRequests: a.failedRequests + b.failedRequests,
    durationMs: a.durationMs + b.durationMs,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * In-memory `CostCollector` for eval runs and tests. Attempts are copied on
 * recording so later caller mutation cannot corrupt a taken snapshot.
 */
export class InMemoryCostCollector implements CostCollector {
  private readonly attempts: CostAttempt[] = [];

  recordAttempt(attempt: CostAttempt): void {
    this.attempts.push({ ...attempt });
  }

  /** Arrival-order snapshot of every recorded attempt. */
  attemptsSnapshot(): CostAttempt[] {
    return this.attempts.map((a) => ({ ...a }));
  }

  /** Aggregated report over all attempts recorded so far. */
  report(): CostReport {
    return buildCostReport(this.attempts);
  }
}

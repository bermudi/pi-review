// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/estimate.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { countTokens } from "../llmloop/compression.js";
import type { Diff } from "../model/diff.js";

// ---------------------------------------------------------------------------
// Constants — mirrors Go internal/agent/estimate.go and internal/scan/estimate.go
// Keep in sync with scan estimate if that file changes.
// ---------------------------------------------------------------------------

export const promptOverheadTokens = 2000 as const;
export const avgMainRoundsPerFile = 7 as const;
export const avgOutputTokensPerRound = 700 as const;

// ---------------------------------------------------------------------------
// Estimate — mirrors Go Estimate struct
// ---------------------------------------------------------------------------

export interface Estimate {
  readonly files: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export function createEstimate(partial: Partial<Estimate> = {}): Estimate {
  return {
    files: partial.files ?? 0,
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    totalTokens: partial.totalTokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Single-file projection — mirrors Go estimateDiffFileTokens
// ---------------------------------------------------------------------------

/**
 * estimateDiffFileTokens projects the input+output token cost of reviewing a
 * single diff (PLAN + MAIN_TASK rounds). Mirrors Go estimateDiffFileTokens
 * but counts tokens of the diff text (d.diff) rather than whole-file content.
 * Returns 0 for deleted files or empty diff (skipped before dispatch).
 */
export function estimateDiffFileTokens(d: Diff): number {
  if (d.isDeleted || d.diff === "") return 0;
  const diffTokens = countTokens(d.diff);
  let total = diffTokens + promptOverheadTokens;
  total += 400; // PLAN output
  total += (diffTokens + promptOverheadTokens) * avgMainRoundsPerFile;
  total += avgOutputTokensPerRound * avgMainRoundsPerFile;
  return total;
}

// ---------------------------------------------------------------------------
// Aggregate projection — mirrors Go estimateDiffCost
// ---------------------------------------------------------------------------

export function estimateDiffCost(diffs: readonly Diff[]): Estimate {
  let files = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const d of diffs) {
    if (d.isDeleted || d.diff === "") continue;
    files++;
    const diffTokens = countTokens(d.diff);
    inputTokens += diffTokens + promptOverheadTokens;
    outputTokens += 400;
    inputTokens += (diffTokens + promptOverheadTokens) * avgMainRoundsPerFile;
    outputTokens += avgOutputTokensPerRound * avgMainRoundsPerFile;
  }
  return {
    files,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Human-readable formatting — mirrors Go humanTokens / Estimate.String()
// ---------------------------------------------------------------------------

export function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

export function estimateToString(e: Estimate): string {
  return `~${e.files} file(s), est. ${humanTokens(e.inputTokens)} input + ${humanTokens(e.outputTokens)} output \u2248 ${humanTokens(e.totalTokens)} total tokens (rough; agent tool-use inflates this \u2014 actual reported after run)`;
}

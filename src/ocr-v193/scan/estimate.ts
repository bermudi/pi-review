// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/scan/estimate.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Scan cost estimation heuristics — mirrors Go `scan.Estimate` / `estimateCost`.
 *
 * Heuristics are intentionally rough: they warn before a large scan, not
 * provide billing accuracy. Real usage is reported after the run.
 */

import type { ScanItem } from "../model/scan.js";

// ---------------------------------------------------------------------------
// Constants — mirrors Go const block
// ---------------------------------------------------------------------------

export const PROMPT_OVERHEAD_TOKENS = 2000;
export const AVG_MAIN_ROUNDS_PER_FILE = 7;
export const AVG_OUTPUT_TOKENS_PER_ROUND = 700;

export const promptOverheadTokens = PROMPT_OVERHEAD_TOKENS;
export const avgMainRoundsPerFile = AVG_MAIN_ROUNDS_PER_FILE;
export const avgOutputTokensPerRound = AVG_OUTPUT_TOKENS_PER_ROUND;

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export interface Estimate {
  readonly files: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

function countTokensApprox(text: string): number {
  if (text.length === 0) return 0;
  // Rough approximation matching Go tiktoken fallback for estimates:
  // ~1 token per 4 chars is close enough for an order-of-magnitude warning.
  // Callers that need precise prompt limits use llmloop.CountTokens;
  // this path deliberately avoids importing that transport seam.
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Per-file projection — mirrors Go estimateFileTokens
// ---------------------------------------------------------------------------

export function estimateFileTokens(it: ScanItem, planEnabled: boolean): number {
  if (it.isBinary === true || it.content === "") return 0;
  const fileTokens = countTokensApprox(it.content);
  let total = 0;
  if (planEnabled) {
    total += fileTokens + PROMPT_OVERHEAD_TOKENS; // PLAN input
    total += 400; // PLAN output
  }
  total += (fileTokens + PROMPT_OVERHEAD_TOKENS) * AVG_MAIN_ROUNDS_PER_FILE;
  total += AVG_OUTPUT_TOKENS_PER_ROUND * AVG_MAIN_ROUNDS_PER_FILE;
  return total;
}

// ---------------------------------------------------------------------------
// Aggregate — mirrors Go estimateCost
// ---------------------------------------------------------------------------

export function estimateCost(
  items: readonly ScanItem[] | null | undefined,
  planEnabled: boolean,
  dedupEnabled: boolean,
  summaryEnabled: boolean,
): Estimate {
  let files = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let allCommentsApprox = 0;

  for (const it of (items ?? [])) {
    if (it.isBinary === true || it.content === "") continue;
    files++;
    const fileTokens = countTokensApprox(it.content);
    if (planEnabled) {
      inputTokens += fileTokens + PROMPT_OVERHEAD_TOKENS;
      outputTokens += 400;
    }
    inputTokens += (fileTokens + PROMPT_OVERHEAD_TOKENS) * AVG_MAIN_ROUNDS_PER_FILE;
    outputTokens += AVG_OUTPUT_TOKENS_PER_ROUND * AVG_MAIN_ROUNDS_PER_FILE;
    allCommentsApprox += 3;
  }

  if (dedupEnabled && allCommentsApprox > 0) {
    inputTokens += allCommentsApprox * 120 + PROMPT_OVERHEAD_TOKENS;
    outputTokens += allCommentsApprox * 20;
  }
  if (summaryEnabled && allCommentsApprox > 0) {
    inputTokens += allCommentsApprox * 120 + PROMPT_OVERHEAD_TOKENS;
    outputTokens += 2000;
  }

  return {
    files,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function estimateToString(e: Estimate): string {
  return `~${String(e.files)} file(s), est. ${humanTokens(e.inputTokens)} input + ${humanTokens(e.outputTokens)} output ≈ ${humanTokens(e.totalTokens)} total tokens (rough; actual reported after run)`;
}

// Go-style alias
export const EstimateString = estimateToString;
export const HumanTokens = humanTokens;
export const EstimateFileTokens = estimateFileTokens;
export const EstimateCost = estimateCost;

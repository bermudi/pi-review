// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/scan/batch.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Batch grouping for scan dispatch — mirrors Go `scan.BatchStrategy` / `groupBatches`.
 *
 * No dependency on legacy `src/*` policy; only on the parity `model/ScanItem`
 * contract in `../model/scan.js`. Deterministic ordering (sorted keys) is
 * preserved exactly as in Go.
 */

import type { ScanItem } from "../model/scan.js";

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export type BatchStrategy = "none" | "by-language" | "by-directory";

export const BatchNone: BatchStrategy = "none";
export const BatchByLanguage: BatchStrategy = "by-language";
export const BatchByDirectory: BatchStrategy = "by-directory";

/**
 * Normalises an arbitrary string to a BatchStrategy, defaulting to BatchNone.
 * Mirrors Go `parseBatchStrategy`.
 */
export function parseBatchStrategy(s: string | undefined | null): BatchStrategy {
  const norm = String(s ?? "")
    .trim()
    .toLowerCase();
  switch (norm as BatchStrategy) {
    case BatchByLanguage:
      return BatchByLanguage;
    case BatchByDirectory:
      return BatchByDirectory;
    default:
      return BatchNone;
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Partitions items according to strategy, then slices each natural group
 * into BatchSize-sized chunks (when size > 0). Returns null when items is
 * empty, matching Go's nil. Within a batch the input order is preserved;
 * batches are sorted by group key for determinism.
 *
 * Mirrors Go `groupBatches`.
 */
export function groupBatches(
  items: readonly ScanItem[],
  strategy: BatchStrategy,
  size: number,
): ScanItem[][] | null {
  if (items.length === 0) return null;

  const keyFn = batchKeyFunc(strategy);
  const buckets = new Map<string, ScanItem[]>();
  for (const it of items) {
    const key = keyFn(it);
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }

  const keys = [...buckets.keys()].sort();
  const out: ScanItem[][] = [];
  for (const k of keys) {
    const group = buckets.get(k)!;
    if (size <= 0 || group.length <= size) {
      out.push(group);
      continue;
    }
    for (let start = 0; start < group.length; start += size) {
      const end = Math.min(start + size, group.length);
      out.push(group.slice(start, end));
    }
  }
  return out;
}

function batchKeyFunc(strategy: BatchStrategy): (it: ScanItem) => string {
  switch (strategy) {
    case BatchByLanguage:
      return languageKey;
    case BatchByDirectory:
      return firstLevelDirKey;
    default:
      return (it: ScanItem): string => it.path;
  }
}

function languageKey(it: ScanItem): string {
  const base = it.path.includes("/") ? it.path.slice(it.path.lastIndexOf("/") + 1) : it.path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "<no-ext>";
  return base.slice(dot).toLowerCase();
}

function firstLevelDirKey(it: ScanItem): string {
  const idx = it.path.indexOf("/");
  if (idx < 0) return "<root>";
  return it.path.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Aliases matching Go names for diff-test ergonomics
// ---------------------------------------------------------------------------

export const ParseBatchStrategy = parseBatchStrategy;
export const GroupBatches = groupBatches;

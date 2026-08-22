// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/scan/preview.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Preview for scan — mirrors Go `scan.Preview` / `Agent.preview`.
 *
 * Enumerates files and applies the standard reviewability filter without
 * dispatching any LLM calls. Returns a mode-agnostic `Preview` ready for
 * CLI rendering.
 *
 * No LLM calls; therefore no session or runner is opened during preview
 * (so preview cannot leave an unfinalized JSONL file).
 */

import type { ScanItem } from "../model/scan.js";
import type { Preview, PreviewEntry } from "../model/preview.js";
import { ExcludeNone, ExcludeBinary } from "../model/preview.js";
import type { Provider } from "./provider.js";
import { Provider as ProviderClass } from "./provider.js";

// ---------------------------------------------------------------------------
// Types — preview uses the same model as diff preview but with Status="scan"
// ---------------------------------------------------------------------------

export type { PreviewEntry } from "../model/preview.js";
import type { Preview as PreviewModel } from "../model/preview.js";

export interface PreviewArgs {
  readonly repoDir: string;
  readonly paths?: readonly string[];
  readonly maxFileSizeBytes?: number;
  readonly provider?: Provider;
  readonly isExcluded?: (item: ScanItem) => string; // returns ExcludeReason or ""
}

// ---------------------------------------------------------------------------
// Core logic — mirrors Go `Agent.preview` / `Preview`
// ---------------------------------------------------------------------------

export async function previewScan(args: PreviewArgs, signal?: AbortSignal): Promise<PreviewModel> {
  const provider = args.provider ?? new ProviderClass(args.repoDir, args.paths ?? [], args.maxFileSizeBytes);
  const items = await provider.enumerate(signal);

  const entries: PreviewEntry[] = [];
  let reviewableCount = 0;
  let totalInsertions = 0;

  for (const it of items) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const reason = whyExcluded(it, args.isExcluded);
    const willReview = reason === ExcludeNone;
    const entry: PreviewEntry = {
      path: it.path,
      status: "scan",
      insertions: it.lineCount ?? 0,
      deletions: 0,
      willReview,
    };
    if (!willReview) entry.excludeReason = reason as PreviewEntry["excludeReason"];
    if (willReview) {
      reviewableCount++;
      totalInsertions += entry.insertions;
    }
    entries.push(entry);
  }

  return {
    entries,
    totalInsertions,
    totalDeletions: 0,
    totalFiles: items.length,
    reviewableCount,
    excludedCount: items.length - reviewableCount,
  };
}

/** Alias matching Go exported name — function value (not the Preview type). */
// Renamed to avoid collision with the Preview type when `verbatimModuleSyntax` is on.
export const PreviewFn = previewScan;
export const preview = previewScan;

function whyExcluded(it: ScanItem, isExcluded?: (item: ScanItem) => string): string {
  if (it.isBinary === true) return ExcludeBinary;
  if (isExcluded) {
    const r = isExcluded(it);
    if (r !== "" && r !== ExcludeNone) return r;
  }
  return ExcludeNone;
}

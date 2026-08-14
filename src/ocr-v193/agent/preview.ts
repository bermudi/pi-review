// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/preview.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { isAllowedExt, isExcludedPath } from "../rules/allowed_ext.js";
import type { FileFilter } from "../rules/system_rules.js";
import type { Diff } from "../model/diff.js";
import type { Preview, PreviewEntry, ExcludeReason } from "../model/preview.js";
import { ExcludeBinary, ExcludeUserRule, ExcludeExtension, ExcludeDefaultPath, ExcludeDeleted, ExcludeNone } from "../model/preview.js";
import { Provider } from "../diff/git.js";

// Re-export ExcludeReason and constants so callers can keep writing agent.ExcludeBinary.
export { ExcludeNone, ExcludeUserRule, ExcludeExtension, ExcludeDefaultPath, ExcludeDeleted, ExcludeBinary };
export type { ExcludeReason, Preview as DiffPreview, PreviewEntry as DiffPreviewEntry };

// ---------------------------------------------------------------------------
// effectivePath / diffStatus — mirrors Go helpers in preview.go
// ---------------------------------------------------------------------------

export function effectivePath(d: Diff): string {
  if (d.newPath === "/dev/null") return d.oldPath;
  return d.newPath;
}

export function diffStatus(d: Diff): string {
  if (d.isBinary) return "binary";
  if (d.isNew) return "added";
  if (d.isDeleted) return "deleted";
  if (d.isRenamed) return "renamed";
  if (d.oldPath !== d.newPath && d.oldPath !== "" && d.oldPath !== "/dev/null") return "renamed";
  return "modified";
}

// ---------------------------------------------------------------------------
// extFromPath — mirrors Go extFromPath
// ---------------------------------------------------------------------------

function extFromPath(p: string): string {
  let basename = p;
  const slash = p.lastIndexOf("/");
  if (slash >= 0) basename = p.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "";
  return basename.slice(dot).toLowerCase();
}

// ---------------------------------------------------------------------------
// whyExcluded — mirrors Go Agent.whyExcluded
// ---------------------------------------------------------------------------

export function whyExcluded(
  d: Diff,
  fileFilter: FileFilter | null | undefined,
): ExcludeReason {
  if (d.isBinary) return ExcludeBinary;
  const path = effectivePath(d);

  // FileFilter shape is { include: string[], exclude: string[], isUserExcluded(path), isUserIncluded(path), hasInclude() }
  // The TS implementation in system_rules.ts exposes hasInclude / isUserExcluded / isUserIncluded helpers or methods.
  // We support both the object-with-methods and the helper-function style.
  const f: unknown = fileFilter as unknown;
  if (f !== null && f !== undefined && typeof f === "object") {
    const rec = f as Record<string, unknown>;
    // Method style
    const isUserExcludedFn = rec["isUserExcluded"] as ((p: string) => boolean) | undefined;
    const hasIncludeFn = rec["hasInclude"] as (() => boolean) | undefined;
    const isUserIncludedFn = rec["isUserIncluded"] as ((p: string) => boolean) | undefined;
    // Alternate naming (IsUserExcluded)
    const isUserExcludedAlt = rec["IsUserExcluded"] as ((p: string) => boolean) | undefined;
    const hasIncludeAlt = rec["HasInclude"] as (() => boolean) | undefined;
    const isUserIncludedAlt = rec["IsUserIncluded"] as ((p: string) => boolean) | undefined;

    const checkExcluded =
      (typeof isUserExcludedFn === "function" && isUserExcludedFn(path)) ||
      (typeof isUserExcludedAlt === "function" && isUserExcludedAlt(path));
    if (checkExcluded) return ExcludeUserRule;

    const hasInc =
      (typeof hasIncludeFn === "function" && hasIncludeFn()) ||
      (typeof hasIncludeAlt === "function" && hasIncludeAlt());
    // Also support plain array inspection
    let hasIncludeViaArrays = false;
    if (!hasInc) {
      const incArr = rec["include"] as unknown;
      if (Array.isArray(incArr) && incArr.length > 0) hasIncludeViaArrays = true;
      const incAlt = rec["Include"] as unknown;
      if (Array.isArray(incAlt) && incAlt.length > 0) hasIncludeViaArrays = true;
    }
    const effectiveHasInclude = hasInc || hasIncludeViaArrays;

    if (effectiveHasInclude) {
      const included =
        (typeof isUserIncludedFn === "function" && isUserIncludedFn(path)) ||
        (typeof isUserIncludedAlt === "function" && isUserIncludedAlt(path));
      if (included) return ExcludeNone;
    }
  }

  const ext = extFromPath(path);
  if (ext !== "" && !isAllowedExt(ext)) return ExcludeExtension;
  if (isExcludedPath(path)) return ExcludeDefaultPath;
  return ExcludeNone;
}

// ---------------------------------------------------------------------------
// preview — standalone preview without LLM or session
// ---------------------------------------------------------------------------

export interface PreviewDeps {
  readonly repoDir: string;
  readonly from?: string;
  readonly to?: string;
  readonly commit?: string;
  readonly fileFilter?: FileFilter | null;
  readonly gitRunner?: unknown;
}

/**
 * Build a Preview from live git diffs without dispatching LLM calls.
 * Mirrors Go Agent.preview / Preview(ctx, args).
 */
export async function previewDiffs(
  deps: PreviewDeps,
  signal?: AbortSignal,
): Promise<Preview> {
  const { repoDir, from, to, commit, fileFilter } = deps;

  let provider: Provider;
  if (commit !== undefined && commit !== "") {
    provider = Provider.forCommit(repoDir, commit, null);
  } else if (from !== undefined && from !== "" && to !== undefined && to !== "") {
    provider = Provider.forRange(repoDir, from, to, null);
  } else {
    provider = Provider.forWorkspace(repoDir, null);
  }

  const diffs = await provider.getDiff(signal);
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const d of diffs) {
    totalInsertions += d.insertions;
    totalDeletions += d.deletions;
  }

  const entries: PreviewEntry[] = [];
  let reviewableCount = 0;
  let excludedCount = 0;

  for (const d of diffs) {
    const path = effectivePath(d);
    const entry: PreviewEntry = {
      path,
      status: diffStatus(d),
      insertions: d.insertions,
      deletions: d.deletions,
      willReview: false,
    };
    let reason = whyExcluded(d, fileFilter ?? null);
    if (reason === ExcludeNone && d.isDeleted) reason = ExcludeDeleted;
    entry.willReview = reason === ExcludeNone;
    if (reason !== ExcludeNone) entry.excludeReason = reason;
    if (entry.willReview) reviewableCount++;
    else excludedCount++;
    entries.push(entry);
  }

  return {
    entries,
    totalInsertions,
    totalDeletions,
    totalFiles: diffs.length,
    reviewableCount,
    excludedCount,
  };
}

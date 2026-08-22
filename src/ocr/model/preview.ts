// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/model/preview.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * ExcludeReason describes why a file was excluded from review.
 * Mirrors Go's `model.ExcludeReason` string type.
 */
export type ExcludeReason =
  | ""
  | "user_exclude"
  | "unsupported_ext"
  | "default_path"
  | "deleted"
  | "binary";

export const ExcludeNone: ExcludeReason = "";
export const ExcludeUserRule: ExcludeReason = "user_exclude";
export const ExcludeExtension: ExcludeReason = "unsupported_ext";
export const ExcludeDefaultPath: ExcludeReason = "default_path";
export const ExcludeDeleted: ExcludeReason = "deleted";
export const ExcludeBinary: ExcludeReason = "binary";

/** All non-empty ExcludeReason values, useful for validation. */
export const ALL_EXCLUDE_REASONS: readonly ExcludeReason[] = [
  ExcludeUserRule,
  ExcludeExtension,
  ExcludeDefaultPath,
  ExcludeDeleted,
  ExcludeBinary,
] as const;

/** Type guard for ExcludeReason. */
export function isExcludeReason(value: unknown): value is ExcludeReason {
  return (
    value === ExcludeNone ||
    value === ExcludeUserRule ||
    value === ExcludeExtension ||
    value === ExcludeDefaultPath ||
    value === ExcludeDeleted ||
    value === ExcludeBinary
  );
}

/**
 * PreviewEntry is one file's preview record (mode-agnostic).
 * Mirrors Go's `model.PreviewEntry`.
 */
export interface PreviewEntry {
  /** Repository-relative path; mirrors `Path` json:"path". */
  path: string;
  /** Git status like "modified", "added"; mirrors `Status` json:"status". */
  status: string;
  /** Insertions; mirrors `Insertions` json:"insertions". */
  insertions: number;
  /** Deletions; mirrors `Deletions` json:"deletions". */
  deletions: number;
  /** Whether the file will be reviewed; mirrors `WillReview` json:"will_review". */
  willReview: boolean;
  /**
   * Reason for exclusion; mirrors `ExcludeReason` json:"exclude_reason,omitempty".
   * Empty string / undefined means not excluded.
   */
  excludeReason?: ExcludeReason;
}

/** Raw JSON shape for PreviewEntry, matching Go's `json` tags. */
export interface PreviewEntryJson {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  will_review: boolean;
  exclude_reason?: ExcludeReason;
}

/**
 * Preview is the full preview result, mode-agnostic.
 * Mirrors Go's `model.Preview`.
 */
export interface Preview {
  /** File entries; Go JSON key is `files` (not `entries`). */
  entries: PreviewEntry[];
  /** Sum of insertions; mirrors `TotalInsertions` json:"total_insertions". */
  totalInsertions: number;
  /** Sum of deletions; mirrors `TotalDeletions` json:"total_deletions". */
  totalDeletions: number;
  /** Total file count; mirrors `TotalFiles` json:"total_files". */
  totalFiles: number;
  /** Count of reviewable files; mirrors `ReviewableCount` json:"reviewable_count". */
  reviewableCount: number;
  /** Count of excluded files; mirrors `ExcludedCount` json:"excluded_count". */
  excludedCount: number;
}

/** Raw JSON shape for Preview, matching Go's `json` tags. */
export interface PreviewJson {
  files: PreviewEntryJson[];
  total_insertions: number;
  total_deletions: number;
  total_files: number;
  reviewable_count: number;
  excluded_count: number;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function createPreviewEntry(partial: Partial<PreviewEntry> = {}): PreviewEntry {
  const e: PreviewEntry = {
    path: partial.path ?? "",
    status: partial.status ?? "",
    insertions: partial.insertions ?? 0,
    deletions: partial.deletions ?? 0,
    willReview: partial.willReview ?? false,
  };
  if (partial.excludeReason !== undefined && partial.excludeReason !== ExcludeNone) {
    e.excludeReason = partial.excludeReason;
  }
  return e;
}

export function createPreview(partial: Partial<Preview> = {}): Preview {
  return {
    entries: partial.entries ?? [],
    totalInsertions: partial.totalInsertions ?? 0,
    totalDeletions: partial.totalDeletions ?? 0,
    totalFiles: partial.totalFiles ?? 0,
    reviewableCount: partial.reviewableCount ?? 0,
    excludedCount: partial.excludedCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// JSON mapping — keep field names compatible with Go
// ---------------------------------------------------------------------------

export function previewEntryToJson(e: PreviewEntry): PreviewEntryJson {
  const j: PreviewEntryJson = {
    path: e.path,
    status: e.status,
    insertions: e.insertions,
    deletions: e.deletions,
    will_review: e.willReview,
  };
  if (e.excludeReason !== undefined && e.excludeReason !== ExcludeNone) {
    j.exclude_reason = e.excludeReason;
  }
  return j;
}

export function previewEntryFromJson(j: PreviewEntryJson): PreviewEntry {
  const e: PreviewEntry = {
    path: j.path ?? "",
    status: j.status ?? "",
    insertions: typeof j.insertions === "number" ? j.insertions : 0,
    deletions: typeof j.deletions === "number" ? j.deletions : 0,
    willReview: Boolean(j.will_review),
  };
  if (j.exclude_reason !== undefined && j.exclude_reason !== ExcludeNone) {
    if (isExcludeReason(j.exclude_reason)) {
      e.excludeReason = j.exclude_reason;
    }
  }
  return e;
}

export function previewToJson(p: Preview): PreviewJson {
  return {
    files: p.entries.map(previewEntryToJson),
    total_insertions: p.totalInsertions,
    total_deletions: p.totalDeletions,
    total_files: p.totalFiles,
    reviewable_count: p.reviewableCount,
    excluded_count: p.excludedCount,
  };
}

export function previewFromJson(j: PreviewJson): Preview {
  return {
    entries: Array.isArray(j.files) ? j.files.map(previewEntryFromJson) : [],
    totalInsertions: typeof j.total_insertions === "number" ? j.total_insertions : 0,
    totalDeletions: typeof j.total_deletions === "number" ? j.total_deletions : 0,
    totalFiles: typeof j.total_files === "number" ? j.total_files : 0,
    reviewableCount: typeof j.reviewable_count === "number" ? j.reviewable_count : 0,
    excludedCount: typeof j.excluded_count === "number" ? j.excluded_count : 0,
  };
}

export function parsePreviewEntryFromUnknown(value: unknown): PreviewEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createPreviewEntry();
  }
  const obj = value as Record<string, unknown>;
  const e: PreviewEntry = {
    path: typeof obj["path"] === "string" ? (obj["path"] as string) : "",
    status: typeof obj["status"] === "string" ? (obj["status"] as string) : "",
    insertions: typeof obj["insertions"] === "number" ? (obj["insertions"] as number) : 0,
    deletions: typeof obj["deletions"] === "number" ? (obj["deletions"] as number) : 0,
    willReview: Boolean(obj["will_review"]),
  };
  const er = obj["exclude_reason"];
  if (typeof er === "string" && isExcludeReason(er) && er !== ExcludeNone) {
    e.excludeReason = er;
  }
  return e;
}

export function parsePreviewFromUnknown(value: unknown): Preview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createPreview();
  }
  const obj = value as Record<string, unknown>;
  const files = obj["files"];
  return {
    entries: Array.isArray(files)
      ? (files as unknown[]).map(parsePreviewEntryFromUnknown)
      : [],
    totalInsertions:
      typeof obj["total_insertions"] === "number" ? (obj["total_insertions"] as number) : 0,
    totalDeletions:
      typeof obj["total_deletions"] === "number" ? (obj["total_deletions"] as number) : 0,
    totalFiles: typeof obj["total_files"] === "number" ? (obj["total_files"] as number) : 0,
    reviewableCount:
      typeof obj["reviewable_count"] === "number" ? (obj["reviewable_count"] as number) : 0,
    excludedCount:
      typeof obj["excluded_count"] === "number" ? (obj["excluded_count"] as number) : 0,
  };
}

export function stringifyPreview(p: Preview): string {
  return JSON.stringify(previewToJson(p));
}

export function parsePreviewJson(json: string): Preview {
  const raw: unknown = JSON.parse(json) as unknown;
  return parsePreviewFromUnknown(raw);
}

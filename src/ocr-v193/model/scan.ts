// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/model/scan.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { Diff } from "./diff.js";

/**
 * ScanItem represents a single file enumerated by full-scan mode.
 * Unlike `Diff` (which carries a unified diff text), ScanItem carries
 * the entire file content because scan reviews whole files with no diff
 * context. Mirrors Go's `model.ScanItem`.
 */
export interface ScanItem {
  /** Repository-relative path; mirrors `Path` json:"path". */
  path: string;
  /** Entire file content; mirrors `Content` json:"content". */
  content: string;
  /** Whether the file is binary; mirrors `IsBinary` json:"is_binary,omitempty". */
  isBinary?: boolean;
  /** Line count; mirrors `LineCount` json:"line_count,omitempty". */
  lineCount?: number;
}

/** Raw JSON shape for ScanItem matching Go tags. */
export interface ScanItemJson {
  path: string;
  content: string;
  is_binary?: boolean;
  line_count?: number;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function createScanItem(partial: Partial<ScanItem> & { path: string; content: string }): ScanItem {
  const item: ScanItem = {
    path: partial.path,
    content: partial.content,
  };
  if (partial.isBinary !== undefined) item.isBinary = partial.isBinary;
  if (partial.lineCount !== undefined) item.lineCount = partial.lineCount;
  return item;
}

// ---------------------------------------------------------------------------
// JSON mapping — keep snake_case keys compatible with Go
// ---------------------------------------------------------------------------

export function scanItemToJson(s: ScanItem): ScanItemJson {
  const j: ScanItemJson = {
    path: s.path,
    content: s.content,
  };
  if (s.isBinary !== undefined && s.isBinary) j.is_binary = true;
  if (s.lineCount !== undefined && s.lineCount !== 0) j.line_count = s.lineCount;
  return j;
}

export function scanItemFromJson(j: ScanItemJson): ScanItem {
  const s: ScanItem = {
    path: j.path ?? "",
    content: j.content ?? "",
  };
  if (typeof j.is_binary === "boolean") s.isBinary = j.is_binary;
  if (typeof j.line_count === "number") s.lineCount = j.line_count;
  return s;
}

export function parseScanItemFromUnknown(value: unknown): ScanItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj["path"] !== "string" || typeof obj["content"] !== "string") return null;
  const s: ScanItem = {
    path: obj["path"] as string,
    content: obj["content"] as string,
  };
  if (typeof obj["is_binary"] === "boolean") s.isBinary = obj["is_binary"] as boolean;
  if (typeof obj["line_count"] === "number") s.lineCount = obj["line_count"] as number;
  // also accept camelCase for resilience
  if (s.isBinary === undefined && typeof obj["isBinary"] === "boolean") {
    s.isBinary = obj["isBinary"] as boolean;
  }
  if (s.lineCount === undefined && typeof obj["lineCount"] === "number") {
    s.lineCount = obj["lineCount"] as number;
  }
  return s;
}

export function stringifyScanItem(s: ScanItem): string {
  return JSON.stringify(scanItemToJson(s));
}

export function parseScanItemJson(json: string): ScanItem | null {
  const raw: unknown = JSON.parse(json) as unknown;
  return parseScanItemFromUnknown(raw);
}

// ---------------------------------------------------------------------------
// AsDiff — mirrors Go's `(s *ScanItem) AsDiff() *Diff`
// ---------------------------------------------------------------------------

/**
 * Returns a Diff suitable for handing to code that expects the diff-based
 * shape (line-number resolver, file_read_diff tool). The `diff` field stays
 * empty since scan mode has no unified diff; `newFileContent` carries the
 * whole file so resolver fallbacks can still find the source lines.
 *
 * Mirrors Go:
 * ```go
 * func (s *ScanItem) AsDiff() *Diff {
 *   if s == nil { return nil }
 *   return &Diff{ OldPath: s.Path, NewPath: s.Path, NewFileContent: s.Content, IsBinary: s.IsBinary, Insertions: int64(s.LineCount) }
 * }
 * ```
 * Returns `null` for `null`/`undefined` input to mirror Go's nil receiver.
 */
export function scanItemAsDiff(s: ScanItem | null | undefined): Diff | null {
  if (s === null || s === undefined) return null;
  return {
    oldPath: s.path,
    newPath: s.path,
    diff: "",
    newFileContent: s.content,
    isBinary: Boolean(s.isBinary),
    isDeleted: false,
    isNew: false,
    isRenamed: false,
    insertions: typeof s.lineCount === "number" ? s.lineCount : 0,
    deletions: 0,
  };
}

/** Alias matching Go method name casing for callers that prefer `AsDiff`. */
export const AsDiff = scanItemAsDiff;

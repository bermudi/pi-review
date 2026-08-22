// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/model/review.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Minimal LlmComment contract mirroring Go's model.LlmComment.
 * Keep fields compatible with the v1.9.3 JSON shape; avoid legacy
 * pi-reviewer extensions.
 */
export interface LlmComment {
  /** Repository-relative path, e.g. "a.go". Mirrors Go's `Path` json:"path". */
  path: string;
  /** Human-readable review content. Mirrors Go's `Content`. */
  content: string;
  /** Suggested replacement code, if any. */
  suggestionCode?: string;
  /** Existing code referenced by the comment. */
  existingCode?: string;
  /** 1-based start line, 0 means unspecified. */
  startLine?: number;
  /** 1-based end line, 0 means unspecified. */
  endLine?: number;
  /** Model thinking text, optional. */
  thinking?: string;
  /** Category: bug, security, performance, maintainability, test, style, documentation, other. */
  category?: string;
  /** Severity: critical, high, medium, low. */
  severity?: string;
}

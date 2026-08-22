// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/tool/code_comment.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { LlmComment } from "../model/types.js";
import { CodeComment, CommentSucceed } from "./types.js";
import type { CommentCollector } from "./collector.js";

export { CommentSucceed };

// ---------------------------------------------------------------------------
// Valid categories / severities — mirrors Go `validCodeCommentCategories` etc.
// ---------------------------------------------------------------------------

export const CODE_COMMENT_CATEGORY_BUG = "bug";
export const CODE_COMMENT_CATEGORY_SECURITY = "security";
export const CODE_COMMENT_CATEGORY_PERFORMANCE = "performance";
export const CODE_COMMENT_CATEGORY_MAINTAINABILITY = "maintainability";
export const CODE_COMMENT_CATEGORY_TEST = "test";
export const CODE_COMMENT_CATEGORY_STYLE = "style";
export const CODE_COMMENT_CATEGORY_DOCUMENTATION = "documentation";
export const CODE_COMMENT_CATEGORY_OTHER = "other";

export const CODE_COMMENT_SEVERITY_CRITICAL = "critical";
export const CODE_COMMENT_SEVERITY_HIGH = "high";
export const CODE_COMMENT_SEVERITY_MEDIUM = "medium";
export const CODE_COMMENT_SEVERITY_LOW = "low";

const validCodeCommentCategories = new Set<string>([
  CODE_COMMENT_CATEGORY_BUG,
  CODE_COMMENT_CATEGORY_SECURITY,
  CODE_COMMENT_CATEGORY_PERFORMANCE,
  CODE_COMMENT_CATEGORY_MAINTAINABILITY,
  CODE_COMMENT_CATEGORY_TEST,
  CODE_COMMENT_CATEGORY_STYLE,
  CODE_COMMENT_CATEGORY_DOCUMENTATION,
  CODE_COMMENT_CATEGORY_OTHER,
]);

const validCodeCommentSeverities = new Set<string>([
  CODE_COMMENT_SEVERITY_CRITICAL,
  CODE_COMMENT_SEVERITY_HIGH,
  CODE_COMMENT_SEVERITY_MEDIUM,
  CODE_COMMENT_SEVERITY_LOW,
]);

/**
 * normalizeCodeCommentCategory lowercases and validates category, falling back to "other".
 * Mirrors Go `normalizeCodeCommentCategory`.
 */
export function normalizeCodeCommentCategory(category: string): string {
  const n = category.toLowerCase();
  if (validCodeCommentCategories.has(n)) return n;
  return CODE_COMMENT_CATEGORY_OTHER;
}

/** Alias for compatibility with loop.ts naming. */
export const normalizeCategory = normalizeCodeCommentCategory;

/**
 * normalizeCodeCommentSeverity lowercases and validates severity, falling back to "low".
 * Mirrors Go `normalizeCodeCommentSeverity`.
 */
export function normalizeCodeCommentSeverity(severity: string): string {
  const n = severity.toLowerCase();
  if (validCodeCommentSeverities.has(n)) return n;
  return CODE_COMMENT_SEVERITY_LOW;
}

/** Alias for compatibility with loop.ts naming. */
export const normalizeSeverity = normalizeCodeCommentSeverity;

// ---------------------------------------------------------------------------
// ParseComments — mirrors Go `ParseComments(args map[string]any) ([]LlmComment, string)`
// ---------------------------------------------------------------------------

export interface ParseCommentsResult {
  comments: LlmComment[];
  errorMsg: string;
}

/**
 * ParseComments extracts LlmComment entries from tool call arguments without writing to the Collector.
 * Returns parsed comments and an error message (empty on success) — mirrors Go signature.
 *
 * Behavior:
 * - `comments` may be an array or a JSON string encoding an array.
 * - Empty / missing `comments` → error: "'comments' array is required. Got args: {...}".
 * - JSON parse failure → error: "failed to parse 'comments' JSON string: ...".
 * - Each entry must be an object; non-objects are skipped.
 * - `path` is taken from `args["path"]` (injected by loop host), not per-comment.
 * - Entries with empty `path` or `content` are skipped.
 * - `category` / `severity` are normalized via the helpers above.
 */
export function ParseComments(args: Record<string, unknown>): ParseCommentsResult {
  let rawComments: unknown[] | undefined;

  const raw = args["comments"];
  if (Array.isArray(raw) && raw.length > 0) {
    rawComments = raw;
  } else if (typeof raw === "string" && raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        rawComments = parsed as unknown[];
      } else {
        // Go unmarshals into []any; non-array JSON would error on type assert check,
        // but we treat it as empty to match Go's len==0 path.
        rawComments = undefined;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { comments: [], errorMsg: `Error: failed to parse 'comments' JSON string: ${msg}` };
    }
  }

  if (!rawComments || rawComments.length === 0) {
    const rawJson = JSON.stringify(args);
    return { comments: [], errorMsg: `Error: 'comments' array is required. Got args: ${rawJson}` };
  }

  const pathFromArgs = typeof args["path"] === "string" ? (args["path"] as string) : "";

  const comments: LlmComment[] = [];
  for (const entry of rawComments) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;

    const content = typeof obj["content"] === "string" ? (obj["content"] as string) : "";
    if (pathFromArgs === "" || content === "") continue;

    const cm: LlmComment = {
      path: pathFromArgs,
      content,
    };

    if (typeof obj["suggestion_code"] === "string") cm.suggestionCode = obj["suggestion_code"] as string;
    if (typeof obj["existing_code"] === "string") cm.existingCode = obj["existing_code"] as string;
    if (typeof obj["thinking"] === "string") cm.thinking = obj["thinking"] as string;
    if (typeof obj["category"] === "string") cm.category = normalizeCodeCommentCategory(obj["category"] as string);
    if (typeof obj["severity"] === "string") cm.severity = normalizeCodeCommentSeverity(obj["severity"] as string);

    // Optional line numbers — preserved from loop.ts extension (not in Go's original LlmComment but carried)
    if (typeof obj["start_line"] === "number") cm.startLine = obj["start_line"] as number;
    else if (typeof obj["startLine"] === "number") cm.startLine = obj["startLine"] as number;
    if (typeof obj["end_line"] === "number") cm.endLine = obj["end_line"] as number;
    else if (typeof obj["endLine"] === "number") cm.endLine = obj["endLine"] as number;

    comments.push(cm);
  }

  // Note: Go appends even if some entries were skipped; we return whatever was collected.
  // If all entries were skipped, Go would return empty slice with no error — caller would then
  // add zero comments and still return success. We preserve that.
  return { comments, errorMsg: "" };
}

/** Lowercase alias for JS callers. */
export const parseComments = ParseComments;

// ---------------------------------------------------------------------------
// CodeCommentProvider — mirrors Go `type CodeCommentProvider struct { Collector }`
// ---------------------------------------------------------------------------

export class CodeCommentProvider {
  constructor(public readonly Collector: CommentCollector | null = null) {}

  Tool(): import("./types.js").Tool {
    return CodeComment;
  }

  /**
   * Execute submits review comments to the per-Agent CommentCollector.
   * Mirrors Go `Execute(_ context.Context, args map[string]any) (string, error)`.
   * Returns CommentSucceed on success or an error string on failure (never throws for expected cases).
   */
  async Execute(args: Record<string, unknown>): Promise<string>;
  async Execute(_ctx: unknown, args: Record<string, unknown>): Promise<string>;
  async Execute(a: unknown, b?: Record<string, unknown>): Promise<string> {
    const args = (b ?? a) as Record<string, unknown>;
    if (this.Collector === null || this.Collector === undefined) {
      return "Error: comment collector is not configured";
    }
    const { comments, errorMsg } = ParseComments(args);
    if (errorMsg !== "") return errorMsg;
    for (const cm of comments) {
      this.Collector.Add(cm);
    }
    return CommentSucceed;
  }

  /** Sync alias for callers that don't need Promise. */
  ExecuteSync(args: Record<string, unknown>): string {
    if (this.Collector === null || this.Collector === undefined) {
      return "Error: comment collector is not configured";
    }
    const { comments, errorMsg } = ParseComments(args);
    if (errorMsg !== "") return errorMsg;
    for (const cm of comments) {
      this.Collector.Add(cm);
    }
    return CommentSucceed;
  }
}

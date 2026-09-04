// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/tool/* at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Canonical tool module for OCR v1.9.3 parity.
 * Re-exports the per-file pieces so `src/ocr/llmloop/loop.ts` and other
 * parity consumers import from here instead of duplicating logic.
 *
 * No import from legacy `src/tools.ts`.
 */

// Tool enum / constants — from definitions.go
export {
  Tool,
  Unknown,
  TaskDone,
  CodeComment,
  FileRead,
  FileFind,
  FileReadDiff,
  CodeSearch,
  OfName,
  IsReserved,
  Dynamic,
  ErrToolNotFound,
  NotAvailableMsg,
  ToolNotFoundMsg,
  CommentSucceed,
} from "./types.js";

// Comment collector — from comment_collector.go
export {
  CommentCollector,
  NewCommentCollector,
  newCommentCollector,
} from "./collector.js";

// Code comment — from code_comment.go
// Repair unit surgically adopted from OCR 41917e2 (isolated adoption).
export {
  CodeCommentProvider,
  ParseComments,
  ParseCommentsWithPath,
  parseComments,
  parseCommentsWithPath,
  normalizeCodeCommentCategory,
  normalizeCodeCommentSeverity,
  normalizeCategory,
  normalizeSeverity,
  CODE_COMMENT_CATEGORY_BUG,
  CODE_COMMENT_CATEGORY_SECURITY,
  CODE_COMMENT_CATEGORY_PERFORMANCE,
  CODE_COMMENT_CATEGORY_MAINTAINABILITY,
  CODE_COMMENT_CATEGORY_TEST,
  CODE_COMMENT_CATEGORY_STYLE,
  CODE_COMMENT_CATEGORY_DOCUMENTATION,
  CODE_COMMENT_CATEGORY_OTHER,
  CODE_COMMENT_SEVERITY_CRITICAL,
  CODE_COMMENT_SEVERITY_HIGH,
  CODE_COMMENT_SEVERITY_MEDIUM,
  CODE_COMMENT_SEVERITY_LOW,
} from "./code-comment.js";
export type { CommentRepair } from "./comment-args-repair.js";
export { parseRepairedComments, repairSerializedComments } from "./comment-args-repair.js";

// Provider / Registry / Checkpoint / Stub — from definitions.go + response_message.go + stub.go
export {
  Registry,
  NewRegistry,
  newRegistry,
  StubProvider,
  NewStub,
  newStub,
  BuiltinToolProvider,
  NewBuiltin,
  newBuiltin,
  Complete,
  Fail,
  Of,
  complete,
  fail,
  of,
} from "./definitions.js";
export type { Provider, ToolProvider, ToolCallResult, TaskCheckpoint } from "./definitions.js";

// File reader + all file/search providers — from filereader.go + file_read.go + file_read_diff.go + code_search.go + file_find.go
export {
  ReviewMode,
  ModeWorkspace,
  ModeRange,
  ModeCommit,
  ParseReviewMode,
  parseReviewMode,
  RefValue,
  FileReader,
  scanLines,
  FileReadProvider,
  NewFileRead,
  newFileRead,
  DiffMap,
  NewDiffMap,
  newDiffMap,
  FileReadDiffProvider,
  NewFileReadDiff,
  newFileReadDiff,
  CodeSearchProvider,
  NewCodeSearch,
  newCodeSearch,
  FileFindProvider,
  NewFileFind,
  newFileFind,
  fileReadMaxLines,
  gitGrepMaxCount,
  fileFindMaxCount,
} from "./filereader.js";
export type { FileReaderOpts, GitRunner } from "./filereader.js";

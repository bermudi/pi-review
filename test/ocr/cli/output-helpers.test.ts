// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/output_helpers_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import {
  hasSubtaskErrors,
  isSubtaskErrorType,
  wrapByRunes,
  wrapSingleRuneLine,
  runeWrapCut,
  visibleRunesLen,
  splitToLines,
  buildDiffLines,
  outputText,
  outputTextWithWarnings,
  outputJsonNoFiles,
  outputJsonWithWarnings,
  renderComment,
  printDiffLine,
  statusBadge,
  previewStatusBadge,
  outputPreviewText,
} from "../../../src/ocr/cli/output.js";
import type { LlmComment } from "../../../src/ocr/model/review.js";

// OCR v1.9.3: TestHasSubtaskErrors
test("hasSubtaskErrors detects subtask types", () => {
  expect(hasSubtaskErrors([])).toBe(false);
  expect(hasSubtaskErrors(null as unknown as [])).toBe(false);
  expect(hasSubtaskErrors([{ type: "other", file: "a", message: "msg" }])).toBe(false);
  expect(hasSubtaskErrors([{ type: "subtask_error", file: "a", message: "fail" }])).toBe(true);
  expect(hasSubtaskErrors([{ type: "scan_subtask_error", file: "a", message: "fail" }])).toBe(true);
  expect(hasSubtaskErrors([{ type: "warn", file: "a", message: "" }, { type: "subtask_error", file: "b", message: "" }])).toBe(true);
  expect(isSubtaskErrorType("subtask_error")).toBe(true);
  expect(isSubtaskErrorType("scan_subtask_error")).toBe(true);
  expect(isSubtaskErrorType("warning")).toBe(false);
});

// OCR v1.9.3: TestWrapByRunes
test("wrapByRunes line counting", () => {
  expect(wrapByRunes("", 80)).toEqual([]);
  expect(wrapByRunes("hello", 80)).toHaveLength(1);
  expect(wrapByRunes("a".repeat(10), 10)).toHaveLength(1);
  expect(wrapByRunes("word ".repeat(25), 20)).toHaveLength(7);
  expect(wrapByRunes("line1\nline2\nline3", 80)).toHaveLength(3);
  expect(wrapByRunes("short\n" + "x".repeat(50), 20)).toHaveLength(4);
});

// OCR v1.9.3: TestWrapSingleRuneLine
test("wrapSingleRuneLine wraps at space and fallback", () => {
  expect(wrapSingleRuneLine("hello", 100)).toHaveLength(1);
  expect(wrapSingleRuneLine("hello world foo bar baz", 12).length).toBeGreaterThanOrEqual(2);
  expect(wrapSingleRuneLine("x".repeat(30), 10).length).toBeGreaterThanOrEqual(3);
});

// OCR v1.9.3: TestRuneWrapCut
test("runeWrapCut boundaries", () => {
  const short = [..."short"];
  expect(runeWrapCut(short, 100)).toBe(short.length);
  const runes = [..."hello world test"];
  const cut = runeWrapCut(runes, 11);
  const ch = runes[cut];
  expect(ch === " " || cut === 11).toBe(true);
});

// OCR v1.9.3: TestVisibleRunesLen
test("visibleRunesLen counts printable", () => {
  expect(visibleRunesLen([... "hello"])).toBe(5);
  expect(visibleRunesLen([])).toBe(0);
  expect(visibleRunesLen([... "\x01\x02\x03"])).toBe(0);
  expect(visibleRunesLen([... "a\x01b"])).toBe(2);
  expect(visibleRunesLen([... "\x7f"])).toBe(0);
});

// OCR v1.9.3: TestSplitToLines
test("splitToLines handling", () => {
  expect(splitToLines("a\nb\nc")).toHaveLength(3);
  expect(splitToLines("a\nb\nc\n")).toHaveLength(3);
  expect(splitToLines("single")).toHaveLength(1);
  expect(splitToLines("crlf\r\nline")).toHaveLength(2);
  expect(splitToLines("")).toHaveLength(0);
});

// OCR v1.9.3: TestBuildDiffLines
test("buildDiffLines computes diff", () => {
  expect(buildDiffLines({ path: "a.go", content: "", existingCode: "old", suggestionCode: "" })).toEqual([]);
  expect(buildDiffLines({ path: "a.go", content: "", existingCode: "", suggestionCode: "new" })).toEqual([]);
  const got = buildDiffLines({ path: "a.go", content: "", existingCode: "line1\nline2\n", suggestionCode: "line1\nmodified\n" });
  expect(got.length).toBeGreaterThan(0);
});

// OCR v1.9.3: TestOutputJSON
test("outputJsonWithWarnings success status", () => {
  const comments: LlmComment[] = [{ path: "a.go", content: "fix bug", startLine: 1, endLine: 5 }];
  const json = outputJsonWithWarnings({
    comments,
    warnings: [],
    filesReviewed: 1,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 1000,
    projectSummary: "",
    toolCalls: {},
    traceId: "",
    resumeInfo: null,
    sessionId: "",
    manifest: null,
    budgetExceeded: false,
    llmIdentity: undefined,
    retryReport: null,
  });
  const out = JSON.parse(json);
  expect(out.status).toBe("success");
  expect(out.comments).toHaveLength(1);
});

// OCR v1.9.3: TestOutputJSON_NoComments
test("outputJsonWithWarnings no comments message", () => {
  const json = outputJsonWithWarnings({
    comments: [],
    warnings: [],
    filesReviewed: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 1000,
    projectSummary: "",
    toolCalls: {},
    traceId: "",
    resumeInfo: null,
    sessionId: "",
    manifest: null,
    budgetExceeded: false,
    llmIdentity: undefined,
    retryReport: null,
  });
  const out = JSON.parse(json);
  expect(out.message).not.toBe("");
});

// OCR v1.9.3: TestOutputJSONNoFiles
test("outputJsonNoFiles skipped", () => {
  const json = outputJsonNoFiles("test-trace-id-456", { provider: "anthropic", model: "claude-opus-4-6" });
  const out = JSON.parse(json);
  expect(out.status).toBe("skipped");
  expect(out.trace_id).toBe("test-trace-id-456");
  expect(out.llm.provider).toBe("anthropic");
  expect(out.llm.model).toBe("claude-opus-4-6");
});

// OCR v1.9.3: TestOutputJSONWithWarnings
test("outputJsonWithWarnings with warnings and trace", () => {
  const comments: LlmComment[] = [{ path: "b.go", content: "test" }];
  const warnings = [{ type: "subtask_error", file: "c.go", message: "failed" }];
  const json = outputJsonWithWarnings({
    comments,
    warnings,
    filesReviewed: 5,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    durationMs: 3000,
    projectSummary: "summary",
    toolCalls: { file_read: 3 },
    traceId: "trace-xyz-789",
    resumeInfo: null,
    sessionId: "",
    manifest: null,
    budgetExceeded: false,
    llmIdentity: undefined,
    retryReport: null,
  });
  const out = JSON.parse(json);
  expect(out.status).toBe("completed_with_errors");
  expect(out.summary.files_reviewed).toBe(5);
  expect(out.tool_calls.total).toBe(3);
  expect(out.trace_id).toBe("trace-xyz-789");
});

// OCR v1.9.3: TestOutputJSONWithWarnings_NoCommentsNoErrors
test("outputJsonWithWarnings no comments warning status", () => {
  const json = outputJsonWithWarnings({
    comments: [],
    warnings: [{ type: "warning", file: "x", message: "something" }],
    filesReviewed: 2,
    inputTokens: 50,
    outputTokens: 20,
    totalTokens: 70,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 1000,
    projectSummary: "",
    toolCalls: {},
    traceId: "",
    resumeInfo: null,
    sessionId: "",
    manifest: null,
    budgetExceeded: false,
    llmIdentity: undefined,
    retryReport: null,
  });
  const out = JSON.parse(json);
  expect(out.status).toBe("completed_with_warnings");
  expect(out.message).not.toBe("");
});

// OCR v1.9.3: TestOutputJSONWithWarnings_NoCommentsSubtaskError
test("outputJsonWithWarnings no comments subtask error", () => {
  const json = outputJsonWithWarnings({
    comments: [],
    warnings: [{ type: "subtask_error", file: "x.go", message: "fail" }],
    filesReviewed: 1,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 1000,
    projectSummary: "",
    toolCalls: {},
    traceId: "abc123trace",
    resumeInfo: null,
    sessionId: "",
    manifest: null,
    budgetExceeded: false,
    llmIdentity: undefined,
    retryReport: null,
  });
  const out = JSON.parse(json);
  expect(out.status).toBe("completed_with_errors");
  expect(out.message).toContain("errors");
  expect(out.trace_id).toBe("abc123trace");
});

// OCR v1.9.3: TestStatusBadge
test("statusBadge mapping", () => {
  expect(statusBadge("added")).toContain("[A]");
  expect(statusBadge("modified")).toContain("[M]");
  expect(statusBadge("deleted")).toContain("[D]");
  expect(statusBadge("renamed")).toContain("[R]");
  expect(statusBadge("binary")).toContain("[B]");
  expect(statusBadge("scan")).toContain("[S]");
  expect(statusBadge("unknown")).toContain("[?]");
  expect(previewStatusBadge("added")).toContain("[A]");
});

// OCR v1.9.3: TestOutputText_NoComments
test("outputText no comments", () => {
  expect(outputText([])).toContain("Looks good to me");
  expect(outputText([] as readonly LlmComment[])).toContain("Looks good to me");
});

// OCR v1.9.3: TestOutputText_WithComments
test("outputText with comments", () => {
  const comments: LlmComment[] = [{ path: "main.go", startLine: 10, endLine: 15, content: "potential nil dereference" }];
  const got = outputText(comments);
  expect(got).toContain("main.go");
  expect(got).toContain("potential nil dereference");
});

// OCR v1.9.3: TestOutputTextWithWarnings_NoCommentsNoErrors
test("outputTextWithWarnings no comments no errors", () => {
  const warnings = [{ type: "warning", file: "x.go", message: "slow" }];
  const { stdout } = outputTextWithWarnings([], warnings, null);
  expect(stdout).toContain("Looks good to me");
});

// OCR v1.9.3: TestOutputTextWithWarnings_NoCommentsWithSubtaskError
test("outputTextWithWarnings subtask error message", () => {
  const warnings = [{ type: "subtask_error", file: "y.go", message: "failed" }];
  const { stdout } = outputTextWithWarnings([], warnings, null);
  expect(stdout).toContain("could not be reviewed");
});

// OCR v1.9.3: TestOutputTextWithWarnings_WithComments
test("outputTextWithWarnings with comments", () => {
  const comments: LlmComment[] = [{ path: "a.go", startLine: 1, endLine: 3, content: "fix this" }];
  const warnings = [{ type: "info", file: "b.go", message: "note" }];
  const { stdout } = outputTextWithWarnings(comments, warnings, null);
  expect(stdout).toContain("a.go");
  expect(stdout).toContain("fix this");
});

// OCR v1.9.3: TestRenderComment_EmptyContentNoDiff
test("renderComment empty returns empty", () => {
  expect(renderComment({ path: "skip.go", startLine: 1, endLine: 1, content: "", existingCode: "", suggestionCode: "" })).toBe("");
});

// OCR v1.9.3: TestRenderComment_ContentOnly
test("renderComment content only", () => {
  const got = renderComment({ path: "file.go", startLine: 5, endLine: 10, content: "consider renaming" });
  expect(got).toContain("file.go:5-10");
  expect(got).toContain("consider renaming");
});

// OCR v1.9.3: TestRenderComment_WithDiff
test("renderComment with diff", () => {
  const got = renderComment({
    path: "diff.go",
    startLine: 1,
    endLine: 2,
    content: "rename var",
    existingCode: "old := 1\n",
    suggestionCode: "new := 1\n",
  });
  expect(got).toContain("diff.go:1-2");
  expect(got).toContain("rename var");
});

// OCR v1.9.3: TestPrintDiffLine
test("printDiffLine formats", () => {
  for (const tc of [
    { prefix: "+", content: "new line" },
    { prefix: "-", content: "old line" },
    { prefix: " ", content: "context line" },
  ] as const) {
    const got = printDiffLine(tc.prefix, tc.content, "\u001b[92m", "\u001b[48;2;0;60;0m");
    expect(got).toContain(tc.prefix);
    expect(got).toContain(tc.content);
  }
});

// OCR v1.9.3: TestOutputPreviewText_NoFiles
test("outputPreviewText no files", () => {
  const p = { entries: [], totalInsertions: 0, totalDeletions: 0, totalFiles: 0, reviewableCount: 0, excludedCount: 0 };
  expect(outputPreviewText(p as unknown as Parameters<typeof outputPreviewText>[0])).toContain("No files changed");
});

// OCR v1.9.3: TestOutputPreviewText_WithReviewableFiles
test("outputPreviewText reviewable files", () => {
  const p = {
    entries: [
      { path: "main.go", status: "modified", insertions: 10, deletions: 3, willReview: true },
      { path: "util.go", status: "added", insertions: 20, deletions: 0, willReview: true },
    ],
    totalInsertions: 30,
    totalDeletions: 3,
    totalFiles: 2,
    reviewableCount: 2,
    excludedCount: 0,
  };
  const got = outputPreviewText(p as unknown as Parameters<typeof outputPreviewText>[0]);
  expect(got).toContain("2 file(s) changed");
  expect(got).toContain("Will review (2)");
  expect(got).toContain("main.go");
  expect(got).toContain("util.go");
});

// OCR v1.9.3: TestOutputPreviewText_WithExcludedFiles
test("outputPreviewText excluded files", () => {
  const p = {
    entries: [
      { path: "src.go", status: "modified", insertions: 5, deletions: 1, willReview: true },
      { path: "vendor/lib.go", status: "added", insertions: 100, deletions: 0, willReview: false, excludeReason: "default_path" },
    ],
    totalInsertions: 105,
    totalDeletions: 1,
    totalFiles: 2,
    reviewableCount: 1,
    excludedCount: 1,
  };
  const got = outputPreviewText(p as unknown as Parameters<typeof outputPreviewText>[0]);
  expect(got).toContain("Will review (1)");
  expect(got).toContain("Excluded from review (1)");
  expect(got).toContain("vendor/lib.go");
  expect(got).toContain("default_path");
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/model/model_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { expect, test } from "bun:test";

import {
  createDiff,
  parseDiffJson,
  stringifyDiff,
} from "../../../src/ocr-v193/model/diff.js";
import {
  ExcludeBinary,
  ExcludeDefaultPath,
  ExcludeDeleted,
  ExcludeExtension,
  ExcludeNone,
  ExcludeUserRule,
  createPreviewEntry,
  parsePreviewEntryFromUnknown,
  previewEntryToJson,
} from "../../../src/ocr-v193/model/preview.js";
import {
  createCodeReviewResult,
  createLlmComment,
  parseCodeReviewResultJson,
  parseLlmCommentJson,
  stringifyCodeReviewResult,
  stringifyLlmComment,
} from "../../../src/ocr-v193/model/review.js";
import {
  createScanItem,
  scanItemAsDiff,
} from "../../../src/ocr-v193/model/scan.js";

// OCR v1.9.3: TestDiff_JSONRoundTrip
test("Diff JSON round trip", () => {
  const diff = createDiff({
    oldPath: "a.go",
    newPath: "b.go",
    diff: "@@ -1 +1 @@\n-old\n+new",
    isBinary: false,
    isDeleted: false,
    isNew: true,
    isRenamed: true,
    insertions: 5,
    deletions: 3,
  });

  const data = stringifyDiff(diff);
  const got = parseDiffJson(data);

  expect(got).toEqual(diff);
});

// OCR v1.9.3: TestPreviewEntry_JSONRoundTrip
test("PreviewEntry JSON round trip", () => {
  const entry = createPreviewEntry({
    path: "main.go",
    status: "modified",
    insertions: 10,
    deletions: 2,
    willReview: true,
    excludeReason: ExcludeNone,
  });

  const data = JSON.stringify(previewEntryToJson(entry));
  const got = parsePreviewEntryFromUnknown(JSON.parse(data) as unknown);

  expect(got).toEqual(entry);
});

// OCR v1.9.3: TestPreviewEntry_ExcludeReasonOmitEmpty
test("PreviewEntry omits an empty exclude reason from JSON", () => {
  const entry = createPreviewEntry({
    path: "a.go",
    excludeReason: ExcludeNone,
  });

  let data = JSON.stringify(previewEntryToJson(entry));
  let value = JSON.parse(data) as Record<string, unknown>;
  expect(value).not.toHaveProperty("exclude_reason");

  entry.excludeReason = ExcludeUserRule;
  data = JSON.stringify(previewEntryToJson(entry));
  value = JSON.parse(data) as Record<string, unknown>;
  expect(value["exclude_reason"]).toBe("user_exclude");
});

// OCR v1.9.3: TestExcludeReasonConstants
test("ExcludeReason constants match OCR values", () => {
  const constants = new Map([
    [ExcludeNone, ""],
    [ExcludeUserRule, "user_exclude"],
    [ExcludeExtension, "unsupported_ext"],
    [ExcludeDefaultPath, "default_path"],
    [ExcludeDeleted, "deleted"],
    [ExcludeBinary, "binary"],
  ]);

  for (const [constant, value] of constants) {
    expect(String(constant)).toBe(value);
  }
});

// OCR v1.9.3: TestScanItem_AsDiff
test("ScanItem converts to Diff", () => {
  const item = createScanItem({
    path: "file.go",
    content: "package main\n",
    isBinary: false,
    lineCount: 1,
  });

  const diff = scanItemAsDiff(item);
  expect(diff).not.toBeNull();
  expect(diff?.oldPath).toBe("file.go");
  expect(diff?.newPath).toBe("file.go");
  expect(diff?.newFileContent).toBe("package main\n");
  expect(diff?.isBinary).toBe(false);
  expect(diff?.insertions).toBe(1);
});

// OCR v1.9.3: TestScanItem_AsDiff_Nil
test("nil ScanItem converts to nil Diff", () => {
  const diff = scanItemAsDiff(null);
  expect(diff).toBeNull();
});

// OCR v1.9.3: TestScanItem_AsDiff_Binary
test("binary ScanItem produces a binary Diff", () => {
  const item = createScanItem({
    path: "image.png",
    content: "",
    isBinary: true,
  });

  const diff = scanItemAsDiff(item);
  expect(diff?.isBinary).toBe(true);
});

// OCR v1.9.3: TestLlmComment_JSON
test("LlmComment JSON round trip", () => {
  const comment = createLlmComment({
    path: "main.go",
    content: "fix this",
    suggestionCode: "new code",
    existingCode: "old code",
    startLine: 10,
    endLine: 15,
    thinking: "reasoning",
  });

  const data = stringifyLlmComment(comment);
  const got = parseLlmCommentJson(data);

  expect(got).toEqual(comment);
});

// OCR v1.9.3: TestCodeReviewResult_JSON
test("CodeReviewResult JSON round trip", () => {
  const result = createCodeReviewResult({
    relevantFile: "api.go",
    suggestionContent: "suggestion",
    existingCode: "old",
    suggestionCode: "new",
  });

  const data = stringifyCodeReviewResult(result);
  const got = parseCodeReviewResultJson(data);

  expect(got).toEqual(result);
});

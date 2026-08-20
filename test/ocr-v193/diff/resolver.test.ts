// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/resolver_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import {
  resolveLineNumbers,
  resolveComment,
  normalizeLine,
  splitAndNormalize,
  extractSideLines,
  matchConsecutive,
} from "../../../src/ocr-v193/diff/resolver.js";
import { HunkAdded, HunkContext, HunkDeleted } from "../../../src/ocr-v193/diff/hunk.js";
import type { Hunk } from "../../../src/ocr-v193/diff/hunk.js";
import type { Diff } from "../../../src/ocr-v193/model/diff.js";
import type { LlmComment } from "../../../src/ocr-v193/model/review.js";
import { createDiff } from "../../../src/ocr-v193/model/diff.js";
import { createLlmComment } from "../../../src/ocr-v193/model/review.js";

const testDiff = `diff --git a/pkg/example/handler.go b/pkg/example/handler.go
--- a/pkg/example/handler.go
+++ b/pkg/example/handler.go
@@ -10,7 +10,7 @@ func HandleRequest(w http.ResponseWriter, r *http.Request) {
     ctx := r.Context()
-    log.Print("handling request")
+    log.Printf("handling request: %s", r.URL.Path)
     err := process(ctx)`;

function makeDiff(partial: Partial<Diff> = {}): Diff {
  return createDiff(partial);
}

function makeComment(partial: Partial<LlmComment> & { path: string; content: string }): LlmComment {
  return createLlmComment(partial);
}

// OCR v1.9.3: TestResolveLineNumbers_SingleLineHunkMatch
test("TestResolveLineNumbers_SingleLineHunkMatch", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "pkg/example/handler.go", diff: testDiff })];
  const comments: LlmComment[] = [
    makeComment({ path: "pkg/example/handler.go", content: "x", existingCode: `    log.Print("handling request")` }),
  ];
  const result = resolveLineNumbers(comments, diffs);
  if (result.length !== 1) throw new Error(`expected 1 comment, got ${result.length}`);
  const cm = result[0]!;
  if (cm.startLine === 0 || cm.endLine === 0) {
    throw new Error(`expected non-zero line numbers, got StartLine=${cm.startLine} EndLine=${cm.endLine}`);
  }
  expect(cm.startLine!).toBe(11);
  expect(cm.endLine!).toBe(11);
});

// OCR v1.9.3: TestResolveLineNumbers_WhitespaceTolerant
test("TestResolveLineNumbers_WhitespaceTolerant", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "pkg/example/handler.go", diff: testDiff })];
  const comments: LlmComment[] = [makeComment({ path: "pkg/example/handler.go", content: "x", existingCode: `log.Print("handling request")` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(11);
  expect(cm.endLine!).toBe(11);
});

// OCR v1.9.3: TestResolveLineNumbers_MultiLineHunkMatch
test("TestResolveLineNumbers_MultiLineHunkMatch", () => {
  const rawMulti = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,4 +5,4 @@ import "fmt"
 func foo() {
-    x := 1
-    y := 2
+    x := 10
+    y := 20
 }`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: rawMulti })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `    x := 1\n    y := 2` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  if (cm.startLine === 0 || cm.endLine === 0) throw new Error(`multiline hunk match: expected non-zero lines, got StartLine=${cm.startLine} EndLine=${cm.endLine}`);
  expect(cm.startLine!).toBe(6);
  expect(cm.endLine!).toBe(7);
});

// OCR v1.9.3: TestResolveLineNumbers_FallbackToFileContent
test("TestResolveLineNumbers_FallbackToFileContent", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -1,3 +1,4 @@
 package main
+import "fmt"
 func foo() {}`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw, newFileContent: `package main\nimport "fmt"\nfunc foo() {}` })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `package main\nimport "fmt"` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(1);
  expect(cm.endLine!).toBe(2);
});

// OCR v1.9.3: TestResolveLineNumbers_FallbackToFileContent_BlankLines
test("TestResolveLineNumbers_FallbackToFileContent_BlankLines", () => {
  const diffs: Diff[] = [
    makeDiff({
      newPath: "main.go",
      newFileContent: "package main\n\nfunc foo() {\n\n\treturn 1\n}",
      diff: "@@ -1,2 +1,2 @@\n-old\n+new",
    }),
  ];
  const comments: LlmComment[] = [makeComment({ path: "main.go", content: "x", existingCode: "func foo() {\n\treturn 1\n}" })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(3);
  expect(cm.endLine!).toBe(6);
});

// OCR v1.9.3: TestResolveLineNumbers_FallbackToFileContent_MultipleBlankLines
test("TestResolveLineNumbers_FallbackToFileContent_MultipleBlankLines", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "main.go", newFileContent: "a\n\n\nb\n\nc\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
  const comments: LlmComment[] = [makeComment({ path: "main.go", content: "x", existingCode: "a\nb\nc" })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(1);
  expect(cm.endLine!).toBe(6);
});

// OCR v1.9.3: TestResolveLineNumbers_FallbackToFileContent_LeadingBlanks
test("TestResolveLineNumbers_FallbackToFileContent_LeadingBlanks", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "main.go", newFileContent: "\n\nfoo\nbar\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
  const comments: LlmComment[] = [makeComment({ path: "main.go", content: "x", existingCode: "foo\nbar" })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(3);
  expect(cm.endLine!).toBe(4);
});

// OCR v1.9.3: TestResolveLineNumbers_FallbackToFileContent_CRLF
test("TestResolveLineNumbers_FallbackToFileContent_CRLF", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "main.go", newFileContent: "alpha\r\nbeta\r\ngamma\r\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
  const comments: LlmComment[] = [makeComment({ path: "main.go", content: "x", existingCode: "beta\ngamma" })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(2);
  expect(cm.endLine!).toBe(3);
});

// OCR v1.9.3: TestResolveLineNumbers_FallbackToFileContent_FirstMatchWins
test("TestResolveLineNumbers_FallbackToFileContent_FirstMatchWins", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "main.go", newFileContent: "x\ny\nx\ny\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
  const comments: LlmComment[] = [makeComment({ path: "main.go", content: "x", existingCode: "x\ny" })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(1);
  expect(cm.endLine!).toBe(2);
});

// OCR v1.9.3: TestResolveLineNumbers_FallbackToFileContent_AllBlankExistingCode
test("TestResolveLineNumbers_FallbackToFileContent_AllBlankExistingCode", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "main.go", newFileContent: "a\nb\nc\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
  const comments: LlmComment[] = [makeComment({ path: "main.go", content: "x", existingCode: "\n\n\n" })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine ?? 0).toBe(0);
  expect(cm.endLine ?? 0).toBe(0);
});

// OCR v1.9.3: TestResolveLineNumbers_NoMatchKeepsZero
test("TestResolveLineNumbers_NoMatchKeepsZero", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: testDiff })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `totally unrelated code` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine ?? 0).toBe(0);
  expect(cm.endLine ?? 0).toBe(0);
});

// OCR v1.9.3: TestResolveLineNumbers_NoExistingCode
test("TestResolveLineNumbers_NoExistingCode", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: testDiff })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "some comment without existing_code" })];
  const result = resolveLineNumbers(comments, diffs);
  expect(result[0]!.startLine ?? 0).toBe(0);
});

// OCR v1.9.3: TestResolveLineNumbers_PathNotFound
test("TestResolveLineNumbers_PathNotFound", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "other.go", diff: testDiff })];
  const comments: LlmComment[] = [makeComment({ path: "missing.go", content: "x", existingCode: `some code` })];
  const result = resolveLineNumbers(comments, diffs);
  expect(result[0]!.startLine ?? 0).toBe(0);
});

// OCR v1.9.3: TestResolveLineNumbers_EmptyInputs
test("TestResolveLineNumbers_EmptyInputs", () => {
  const r1 = resolveLineNumbers([], [makeDiff()]);
  expect(r1.length).toBe(0);
  const r2 = resolveLineNumbers([makeComment({ path: "a.go", content: "x" })], []);
  expect(r2.length).toBe(1);
  expect(r2[0]!.startLine ?? 0).toBe(0);
});

// OCR v1.9.3: TestNormalizeLine
test("TestNormalizeLine", () => {
  const cases: Array<[string, string]> = [
    ["  hello  ", "hello"],
    ["+added line", "added line"],
    ["-deleted line", "deleted line"],
    ["\tindented\t", "indented"],
    ["", ""],
  ];
  for (const [input, want] of cases) {
    expect(normalizeLine(input)).toBe(want);
  }
});

// OCR v1.9.3: TestSplitAndNormalize_SkipsEmptyLines
test("TestSplitAndNormalize_SkipsEmptyLines", () => {
  const lines = splitAndNormalize(`line1\n\nline2`);
  expect(lines.length).toBe(2);
  expect(lines[0]).toBe("line1");
  expect(lines[1]).toBe("line2");
});

// OCR v1.9.3: TestExtractSideLines_NewSide
test("TestExtractSideLines_NewSide", () => {
  const hunk: Hunk = {
    oldStart: 10,
    oldCount: 3,
    newStart: 10,
    newCount: 4,
    lines: [
      { type: HunkContext, content: "    ctx := r.Context()" },
      { type: HunkDeleted, content: `    log.Print("old")` },
      { type: HunkAdded, content: `    log.Printf("new: %s", r.URL)` },
      { type: HunkContext, content: "    err := process(ctx)" },
    ],
  };
  const got = extractSideLines(hunk, true);
  const want = [
    { lineNum: 10, content: `ctx := r.Context()` },
    { lineNum: 11, content: `log.Printf("new: %s", r.URL)` },
    { lineNum: 12, content: `err := process(ctx)` },
  ];
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(got[i]!.lineNum).toBe(want[i]!.lineNum);
    expect(got[i]!.content).toBe(want[i]!.content);
  }
});

// OCR v1.9.3: TestExtractSideLines_OldSide
test("TestExtractSideLines_OldSide", () => {
  const hunk: Hunk = {
    oldStart: 10,
    oldCount: 3,
    newStart: 10,
    newCount: 4,
    lines: [
      { type: HunkContext, content: "    ctx := r.Context()" },
      { type: HunkDeleted, content: `    log.Print("old")` },
      { type: HunkAdded, content: `    log.Printf("new: %s", r.URL)` },
      { type: HunkContext, content: "    err := process(ctx)" },
    ],
  };
  const got = extractSideLines(hunk, false);
  const want = [
    { lineNum: 10, content: `ctx := r.Context()` },
    { lineNum: 11, content: `log.Print("old")` },
    { lineNum: 12, content: `err := process(ctx)` },
  ];
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(got[i]!.lineNum).toBe(want[i]!.lineNum);
    expect(got[i]!.content).toBe(want[i]!.content);
  }
});

// OCR v1.9.3: TestExtractSideLines_DivergentStartLines
test("TestExtractSideLines_DivergentStartLines", () => {
  const hunk: Hunk = {
    oldStart: 5,
    oldCount: 2,
    newStart: 8,
    newCount: 3,
    lines: [
      { type: HunkContext, content: "A" },
      { type: HunkAdded, content: "B" },
      { type: HunkContext, content: "C" },
    ],
  };
  const newSide = extractSideLines(hunk, true);
  expect(newSide.length).toBe(3);
  const wantNew = [8, 9, 10];
  for (let i = 0; i < wantNew.length; i++) expect(newSide[i]!.lineNum).toBe(wantNew[i]!);
  const oldSide = extractSideLines(hunk, false);
  expect(oldSide.length).toBe(2);
  const wantOld = [5, 6];
  for (let i = 0; i < wantOld.length; i++) expect(oldSide[i]!.lineNum).toBe(wantOld[i]!);
});

// OCR v1.9.3: TestExtractSideLines_OnlyAdded
test("TestExtractSideLines_OnlyAdded", () => {
  const hunk: Hunk = {
    oldStart: 1,
    oldCount: 0,
    newStart: 1,
    newCount: 2,
    lines: [
      { type: HunkAdded, content: "line1" },
      { type: HunkAdded, content: "line2" },
    ],
  };
  const newSide = extractSideLines(hunk, true);
  expect(newSide.length).toBe(2);
  const oldSide = extractSideLines(hunk, false);
  expect(oldSide.length).toBe(0);
});

// OCR v1.9.3: TestExtractSideLines_OnlyDeleted
test("TestExtractSideLines_OnlyDeleted", () => {
  const hunk: Hunk = {
    oldStart: 3,
    oldCount: 2,
    newStart: 3,
    newCount: 0,
    lines: [
      { type: HunkDeleted, content: "old1" },
      { type: HunkDeleted, content: "old2" },
    ],
  };
  const oldSide = extractSideLines(hunk, false);
  expect(oldSide.length).toBe(2);
  expect(oldSide[0]!.lineNum).toBe(3);
  expect(oldSide[1]!.lineNum).toBe(4);
  const newSide = extractSideLines(hunk, true);
  expect(newSide.length).toBe(0);
});

// OCR v1.9.3: TestMatchConsecutive_SingleLine
test("TestMatchConsecutive_SingleLine", () => {
  const lines = [
    { lineNum: 5, content: "hello" },
    { lineNum: 6, content: "world" },
    { lineNum: 7, content: "foo" },
  ];
  const r = matchConsecutive(lines, ["world"]);
  expect(r.found).toBe(true);
  expect(r.startLine).toBe(6);
  expect(r.endLine).toBe(6);
});

// OCR v1.9.3: TestMatchConsecutive_MultiLine
test("TestMatchConsecutive_MultiLine", () => {
  const lines = [
    { lineNum: 1, content: "a" },
    { lineNum: 2, content: "b" },
    { lineNum: 3, content: "c" },
    { lineNum: 4, content: "d" },
  ];
  const r = matchConsecutive(lines, ["b", "c"]);
  expect(r.found).toBe(true);
  expect(r.startLine).toBe(2);
  expect(r.endLine).toBe(3);
});

// OCR v1.9.3: TestMatchConsecutive_NoMatch
test("TestMatchConsecutive_NoMatch", () => {
  const lines = [
    { lineNum: 1, content: "a" },
    { lineNum: 2, content: "b" },
  ];
  const r = matchConsecutive(lines, ["x"]);
  expect(r.found).toBe(false);
});

// OCR v1.9.3: TestMatchConsecutive_FirstMatchWins
test("TestMatchConsecutive_FirstMatchWins", () => {
  const lines = [
    { lineNum: 10, content: "x" },
    { lineNum: 11, content: "y" },
    { lineNum: 20, content: "x" },
    { lineNum: 21, content: "y" },
  ];
  const r = matchConsecutive(lines, ["x", "y"]);
  expect(r.found).toBe(true);
  expect(r.startLine).toBe(10);
  expect(r.endLine).toBe(11);
});

// OCR v1.9.3: TestMatchConsecutive_TargetLongerThanLines
test("TestMatchConsecutive_TargetLongerThanLines", () => {
  const lines = [{ lineNum: 1, content: "a" }];
  const r = matchConsecutive(lines, ["a", "b"]);
  expect(r.found).toBe(false);
});

// OCR v1.9.3: TestMatchConsecutive_EmptySideLines
test("TestMatchConsecutive_EmptySideLines", () => {
  const r = matchConsecutive([], ["a"]);
  expect(r.found).toBe(false);
});

// OCR v1.9.3: TestMatchConsecutive_MatchAtEnd
test("TestMatchConsecutive_MatchAtEnd", () => {
  const lines = [
    { lineNum: 1, content: "a" },
    { lineNum: 2, content: "b" },
    { lineNum: 3, content: "c" },
  ];
  const r = matchConsecutive(lines, ["b", "c"]);
  expect(r.found).toBe(true);
  expect(r.startLine).toBe(2);
  expect(r.endLine).toBe(3);
});

// OCR v1.9.3: TestMatchConsecutive_MatchAtStart
test("TestMatchConsecutive_MatchAtStart", () => {
  const lines = [
    { lineNum: 1, content: "a" },
    { lineNum: 2, content: "b" },
    { lineNum: 3, content: "c" },
  ];
  const r = matchConsecutive(lines, ["a", "b"]);
  expect(r.found).toBe(true);
  expect(r.startLine).toBe(1);
  expect(r.endLine).toBe(2);
});

// OCR v1.9.3: TestMatchConsecutive_ExactFull
test("TestMatchConsecutive_ExactFull", () => {
  const lines = [
    { lineNum: 1, content: "a" },
    { lineNum: 2, content: "b" },
  ];
  const r = matchConsecutive(lines, ["a", "b"]);
  expect(r.found).toBe(true);
  expect(r.startLine).toBe(1);
  expect(r.endLine).toBe(2);
});

// OCR v1.9.3: TestResolveFromHunk_AddedLines
test("TestResolveFromHunk_AddedLines", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -3,3 +3,5 @@
 func main() {
+    x := 1
+    y := 2
     fmt.Println("hello")
 }`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `    x := 1\n    y := 2` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(4);
  expect(cm.endLine!).toBe(5);
});

// OCR v1.9.3: TestResolveFromHunk_OldSideAcrossAddedLines
test("TestResolveFromHunk_OldSideAcrossAddedLines", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,3 +5,4 @@
     x := 1
+    z := 99
     y := 2
 }`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `    x := 1\n    y := 2` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(5);
  expect(cm.endLine!).toBe(6);
});

// OCR v1.9.3: TestResolveFromHunk_ContextLinesOnly
test("TestResolveFromHunk_ContextLinesOnly", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -3,3 +3,4 @@
 func main() {
     fmt.Println("hello")
+    fmt.Println("world")
 }`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `    fmt.Println("hello")` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine !== 0).toBe(true);
  expect(cm.startLine!).toBe(4);
});

// OCR v1.9.3: TestResolveFromHunk_SingleAddedLine
test("TestResolveFromHunk_SingleAddedLine", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -1,2 +1,3 @@
 package main
+import "fmt"
 func main() {}`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `import "fmt"` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(2);
  expect(cm.endLine!).toBe(2);
});

// OCR v1.9.3: TestResolveFromHunk_NewSidePriority
test("TestResolveFromHunk_NewSidePriority", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,3 +8,4 @@
 func main() {
     fmt.Println("hello")
+    fmt.Println("world")
 }`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `    fmt.Println("hello")` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(9);
});

// OCR v1.9.3: TestResolveFromHunk_MultiHunkMatchInSecond
test("TestResolveFromHunk_MultiHunkMatchInSecond", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -2,3 +2,3 @@
 func foo() {
-    old1()
+    new1()
 }
@@ -20,3 +20,4 @@
 func bar() {
+    added_in_bar()
     existing()
 }`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: "    added_in_bar()" })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(21);
  expect(cm.endLine!).toBe(21);
});

// OCR v1.9.3: TestResolveFromHunk_AddedWithContext
test("TestResolveFromHunk_AddedWithContext", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -10,3 +10,5 @@
 func process() {
+    validate()
+    transform()
     save()
 }`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `    validate()\n    transform()\n    save()` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(11);
  expect(cm.endLine!).toBe(13);
});

// OCR v1.9.3: TestResolveFromHunk_NewSideAcrossDeletedLines
test("TestResolveFromHunk_NewSideAcrossDeletedLines", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,4 +5,3 @@
     a := 1
-    unused := 0
     b := 2
 }`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `    a := 1\n    b := 2` })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(5);
  expect(cm.endLine!).toBe(6);
});

// OCR v1.9.3: TestResolveLineNumbers_AlreadyResolved
test("TestResolveLineNumbers_AlreadyResolved", () => {
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: testDiff })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: `log.Print("handling request")`, startLine: 99, endLine: 99 })];
  const result = resolveLineNumbers(comments, diffs);
  expect(result[0]!.startLine).toBe(99);
  expect(result[0]!.endLine).toBe(99);
});

// OCR v1.9.3: TestResolveLineNumbers_MultipleCommentsOnSameFile
test("TestResolveLineNumbers_MultipleCommentsOnSameFile", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -1,4 +1,6 @@
 package main
+import "fmt"
+import "os"
 func main() {
-    old()
+    new()
 }`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [
    makeComment({ path: "test.go", content: "x", existingCode: `import "fmt"` }),
    makeComment({ path: "test.go", content: "x", existingCode: `import "os"` }),
    makeComment({ path: "test.go", content: "x", existingCode: "    old()" }),
  ];
  const result = resolveLineNumbers(comments, diffs);
  expect(result[0]!.startLine).toBe(2);
  expect(result[0]!.endLine).toBe(2);
  expect(result[1]!.startLine).toBe(3);
  expect(result[1]!.endLine).toBe(3);
  expect(result[2]!.startLine).toBe(3);
  expect(result[2]!.endLine).toBe(3);
});

// OCR v1.9.3: TestResolveLineNumbers_OldPathMapping
test("TestResolveLineNumbers_OldPathMapping", () => {
  const raw = `diff --git a/old_name.go b/new_name.go
--- a/old_name.go
+++ b/new_name.go
@@ -1,3 +1,3 @@
 package main
-func oldFunc() {}
+func newFunc() {}`;
  const diffs: Diff[] = [makeDiff({ oldPath: "old_name.go", newPath: "new_name.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "old_name.go", content: "x", existingCode: "func oldFunc() {}" })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(2);
  expect(cm.endLine!).toBe(2);
});

// OCR v1.9.3: TestResolveLineNumbers_MixedStrategies
test("TestResolveLineNumbers_MixedStrategies", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -5,3 +5,4 @@
 func foo() {
+    newLine()
     bar()
 }`;
  const diffs: Diff[] = [
    makeDiff({
      newPath: "test.go",
      diff: raw,
      newFileContent: "package main\nimport \"fmt\"\n\nfunc helper() {}\nfunc foo() {\n    newLine()\n    bar()\n}",
    }),
  ];
  const comments: LlmComment[] = [
    makeComment({ path: "test.go", content: "x", existingCode: "    newLine()" }),
    makeComment({ path: "test.go", content: "x", existingCode: "func helper() {}" }),
    makeComment({ path: "test.go", content: "x", existingCode: "this_does_not_exist_anywhere()" }),
  ];
  const result = resolveLineNumbers(comments, diffs);
  expect(result[0]!.startLine).toBe(6);
  expect(result[0]!.endLine).toBe(6);
  expect(result[1]!.startLine).toBe(4);
  expect(result[1]!.endLine).toBe(4);
  expect(result[2]!.startLine ?? 0).toBe(0);
  expect(result[2]!.endLine ?? 0).toBe(0);
});

// OCR v1.9.3: TestResolveLineNumbers_DiffMarkerInExistingCode
test("TestResolveLineNumbers_DiffMarkerInExistingCode", () => {
  const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -1,2 +1,3 @@
 x := 1
+y := 2
 z := 3`;
  const diffs: Diff[] = [makeDiff({ newPath: "test.go", diff: raw })];
  const comments: LlmComment[] = [makeComment({ path: "test.go", content: "x", existingCode: "+y := 2" })];
  const result = resolveLineNumbers(comments, diffs);
  const cm = result[0]!;
  expect(cm.startLine!).toBe(2);
  expect(cm.endLine!).toBe(2);
});

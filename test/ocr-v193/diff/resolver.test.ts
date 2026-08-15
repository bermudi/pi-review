// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/resolver_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Phase 5 — comment processing: track comments to changed code

import { describe, test, expect } from "bun:test";
import { resolveLineNumbers, resolveComment, normalizeLine, splitAndNormalize } from "../../../src/ocr-v193/diff/resolver.js";
import type { Diff } from "../../../src/ocr-v193/model/diff.js";
import type { LlmComment } from "../../../src/ocr-v193/model/types.js";

const testDiff = `diff --git a/pkg/example/handler.go b/pkg/example/handler.go
--- a/pkg/example/handler.go
+++ b/pkg/example/handler.go
@@ -10,7 +10,7 @@ func HandleRequest(w http.ResponseWriter, r *http.Request) {
     ctx := r.Context()
-    log.Print("handling request")
+    log.Printf("handling request: %s", r.URL.Path)
     err := process(ctx)`;

function diff(params: Partial<Diff> = {}): Diff {
  return {
    oldPath: params.oldPath ?? "pkg/example/handler.go",
    newPath: params.newPath ?? "pkg/example/handler.go",
    diff: params.diff ?? testDiff,
    newFileContent: params.newFileContent ?? "",
    isBinary: params.isBinary ?? false,
    isDeleted: params.isDeleted ?? false,
    isNew: params.isNew ?? false,
    isRenamed: params.isRenamed ?? false,
    insertions: params.insertions ?? 0,
    deletions: params.deletions ?? 0,
  };
}

function cm(partial: Partial<LlmComment> & { path: string; content: string }): LlmComment {
  return {
    path: partial.path,
    content: partial.content,
    existingCode: partial.existingCode,
    suggestionCode: partial.suggestionCode,
    startLine: partial.startLine,
    endLine: partial.endLine,
    thinking: partial.thinking,
    category: partial.category,
    severity: partial.severity,
  };
}

describe("ocr-v193 resolver (ported)", () => {
  test("single line hunk match → old line 11", () => {
    const diffs = [diff()];
    const comments = [cm({ path: "pkg/example/handler.go", content: "x", existingCode: `    log.Print("handling request")` })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine).toBe(11);
    expect(result[0]!.endLine).toBe(11);
  });

  test("whitespace-tolerant match", () => {
    const diffs = [diff()];
    const comments = [cm({ path: "pkg/example/handler.go", content: "x", existingCode: `log.Print("handling request")` })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine).toBe(11);
  });

  test("multiline hunk match 6..7", () => {
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
    const diffs = [diff({ newPath: "test.go", oldPath: "test.go", diff: rawMulti })];
    const comments = [cm({ path: "test.go", content: "x", existingCode: `    x := 1\n    y := 2` })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine).toBe(6);
    expect(result[0]!.endLine).toBe(7);
  });

  test("fallback to file content", () => {
    const raw = `diff --git a/test.go b/test.go
--- a/test.go
+++ b/test.go
@@ -1,3 +1,4 @@
 package main
+import "fmt"
 func foo() {}`;
    const diffs = [diff({ newPath: "test.go", diff: raw, newFileContent: `package main\nimport "fmt"\nfunc foo() {}` })];
    const comments = [cm({ path: "test.go", content: "x", existingCode: `package main\nimport "fmt"` })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine).toBe(1);
    expect(result[0]!.endLine).toBe(2);
  });

  test("fallback with blank lines — consecutive non-blank", () => {
    const diffs = [diff({ newPath: "main.go", newFileContent: "package main\n\nfunc foo() {\n\n\treturn 1\n}", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
    const comments = [cm({ path: "main.go", content: "x", existingCode: "func foo() {\n\treturn 1\n}" })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine).toBe(3);
    expect(result[0]!.endLine).toBe(6);
  });

  test("fallback first match wins for duplicate snippets", () => {
    const diffs = [diff({ newPath: "main.go", newFileContent: "x\ny\nx\ny\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
    const comments = [cm({ path: "main.go", content: "x", existingCode: "x\ny" })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine).toBe(1);
    expect(result[0]!.endLine).toBe(2);
  });

  test("no match keeps 0", () => {
    const diffs = [diff({ newPath: "test.go" })];
    const comments = [cm({ path: "test.go", content: "x", existingCode: `totally unrelated code` })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine ?? 0).toBe(0);
    expect(result[0]!.endLine ?? 0).toBe(0);
  });

  test("empty existingCode keeps 0", () => {
    const diffs = [diff({ newPath: "test.go" })];
    const comments = [cm({ path: "test.go", content: "some comment without existing_code" })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine).toBeFalsy();
  });

  test("already resolved preserves lines", () => {
    const diffs = [diff({ newPath: "test.go" })];
    const comments = [cm({ path: "test.go", content: "x", existingCode: `log.Print("handling request")`, startLine: 99, endLine: 99 })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine).toBe(99);
    expect(result[0]!.endLine).toBe(99);
  });

  test("resolveComment single returns true on match", () => {
    const d = diff({ newPath: "main.go", diff: `@@ -10,6 +10,8 @@\n import "fmt"\n\n func main() {\n+    x := 1\n+    y := 2\n     fmt.Println("hello")\n }` });
    const c = cm({ path: "main.go", content: "unused", existingCode: "x := 1\ny := 2" });
    const ok = resolveComment(c, d);
    expect(ok).toBe(true);
    expect(c.startLine).toBeGreaterThan(0);
  });

  test("resolveComment empty existingCode false", () => {
    const d = diff();
    const c = cm({ path: "main.go", content: "test" });
    expect(resolveComment(c, d)).toBe(false);
  });

  test("diff marker in existing_code stripped", () => {
    const diffs = [diff({ newPath: "test.go", diff: `diff --git a/test.go b/test.go\n@@ -1,2 +1,2 @@\n-old\n+new\n+ y := 2` })];
    // The existing_code may contain leading '+' diff marker; normalize should strip
    const comments = [cm({ path: "test.go", content: "x", existingCode: "+y := 2" })];
    const result = resolveLineNumbers(comments, diffs);
    // Should match new-side added line y := 2 at line 2
    expect(result[0]!.startLine).toBe(2);
  });

  test("multiline suggestion handling — existing_code preserved", () => {
    const comments = [cm({ path: "test.go", content: "fix", existingCode: "a\nb\nc", suggestionCode: "x\ny\nz" })];
    const diffs = [diff({ newPath: "test.go", newFileContent: "a\nb\nc\n", diff: "@@ -1,1 +1,1 @@\n-old\n+new" })];
    const result = resolveLineNumbers(comments, diffs);
    // existing_code resolution should not be affected by suggestionCode presence
    expect(result[0]!.suggestionCode).toBe("x\ny\nz");
    expect(result[0]!.startLine).toBe(1);
  });

  test("deterministic first match for moved code", () => {
    // Two identical snippets in file, comment should anchor to first
    const content = "helper\nline\nhelper\nline\n";
    const diffs = [diff({ newPath: "a.go", newFileContent: content, diff: "@@ -1,1 +1,1 @@\n-old\n+new" })];
    const comments = [cm({ path: "a.go", content: "x", existingCode: "helper\nline" })];
    const result = resolveLineNumbers(comments, diffs);
    expect(result[0]!.startLine).toBe(1);
  });
  // --- Additional ported tests ---
  test("FallbackToFileContent_MultipleBlankLines", () => {
    const diffs = [diff({ newPath: "main.go", newFileContent: "a\n\n\nb\n\nc\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
    const comments = [cm({ path: "main.go", content: "x", existingCode: "a\nb\nc" })];
    const r = resolveLineNumbers(comments, diffs);
    expect(r[0]!.startLine).toBe(1); expect(r[0]!.endLine).toBe(6);
  });
  test("FallbackToFileContent_LeadingBlanks", () => {
    const diffs = [diff({ newPath: "main.go", newFileContent: "\n\nfoo\nbar\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
    const comments = [cm({ path: "main.go", content: "x", existingCode: "foo\nbar" })];
    const r = resolveLineNumbers(comments, diffs);
    expect(r[0]!.startLine).toBe(3); expect(r[0]!.endLine).toBe(4);
  });
  test("FallbackToFileContent_CRLF", () => {
    const diffs = [diff({ newPath: "main.go", newFileContent: "alpha\r\nbeta\r\ngamma\r\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
    const comments = [cm({ path: "main.go", content: "x", existingCode: "beta\ngamma" })];
    const r = resolveLineNumbers(comments, diffs);
    expect(r[0]!.startLine).toBe(2); expect(r[0]!.endLine).toBe(3);
  });
  test("FallbackToFileContent_AllBlankExistingCode", () => {
    const diffs = [diff({ newPath: "main.go", newFileContent: "a\nb\nc\n", diff: "@@ -1,2 +1,2 @@\n-old\n+new" })];
    const comments = [cm({ path: "main.go", content: "x", existingCode: "\n\n\n" })];
    const r = resolveLineNumbers(comments, diffs);
    expect(r[0]!.startLine ?? 0).toBe(0); expect(r[0]!.endLine ?? 0).toBe(0);
  });
  test("PathNotFound", () => {
    const diffs = [diff({ newPath: "other.go" })];
    const comments = [cm({ path: "missing.go", content: "x", existingCode: "some code" })];
    const r = resolveLineNumbers(comments, diffs);
    expect(r[0]!.startLine ?? 0).toBe(0);
  });
  test("EmptyInputs", () => {
    expect(resolveLineNumbers([], [])).toHaveLength(0);
    const r2 = resolveLineNumbers([cm({ path: "a.go", content: "x" })], []);
    expect(r2).toHaveLength(1); expect(r2[0]!.startLine ?? 0).toBe(0);
  });
  test("NormalizeLine", () => {
    expect(normalizeLine("  hello  ")).toBe("hello");
    expect(normalizeLine("+added line")).toBe("added line");
    expect(normalizeLine("-deleted line")).toBe("deleted line");
    expect(normalizeLine("\tindented\t")).toBe("indented");
    expect(normalizeLine("")).toBe("");
  });
  test("SplitAndNormalize_SkipsEmptyLines", () => {
    const lines = splitAndNormalize("line1\n\nline2");
    expect(lines).toEqual(["line1","line2"]);
  });
  test("ExtractSideLines_NewSide", async () => {
    const { extractSideLines } = await import("../../../src/ocr-v193/diff/resolver.js");
    const { HunkContext, HunkAdded, HunkDeleted } = await import("../../../src/ocr-v193/diff/hunk.js");
    const hunk: any = { oldStart: 10, oldCount: 3, newStart: 10, newCount: 4, lines: [{type:HunkContext,content:"    ctx := r.Context()"},{type:HunkDeleted,content:'    log.Print("old")'},{type:HunkAdded,content:'    log.Printf("new: %s", r.URL)'},{type:HunkContext,content:"    err := process(ctx)"}] };
    const got = extractSideLines(hunk, true);
    expect(got).toEqual([{lineNum:10,content:"ctx := r.Context()"},{lineNum:11,content:'log.Printf("new: %s", r.URL)'},{lineNum:12,content:"err := process(ctx)"}]);
  });
  test("ExtractSideLines_OldSide", async () => {
    const { extractSideLines } = await import("../../../src/ocr-v193/diff/resolver.js");
    const { HunkContext, HunkAdded, HunkDeleted } = await import("../../../src/ocr-v193/diff/hunk.js");
    const hunk: any = { oldStart: 10, oldCount: 3, newStart: 10, newCount: 4, lines: [{type:HunkContext,content:"    ctx := r.Context()"},{type:HunkDeleted,content:'    log.Print("old")'},{type:HunkAdded,content:'    log.Printf("new: %s", r.URL)'},{type:HunkContext,content:"    err := process(ctx)"}] };
    const got = extractSideLines(hunk, false);
    expect(got).toEqual([{lineNum:10,content:"ctx := r.Context()"},{lineNum:11,content:'log.Print("old")'},{lineNum:12,content:"err := process(ctx)"}]);
  });
  test("ExtractSideLines_DivergentStartLines", async () => {
    const { extractSideLines } = await import("../../../src/ocr-v193/diff/resolver.js");
    const { HunkContext, HunkAdded } = await import("../../../src/ocr-v193/diff/hunk.js");
    const hunk: any = { oldStart: 5, oldCount: 2, newStart: 8, newCount: 3, lines: [{type:HunkContext,content:"A"},{type:HunkAdded,content:"B"},{type:HunkContext,content:"C"}] };
    const ns = extractSideLines(hunk, true); expect(ns.map(x=>x.lineNum)).toEqual([8,9,10]);
    const os = extractSideLines(hunk, false); expect(os.map(x=>x.lineNum)).toEqual([5,6]);
  });
  test("ExtractSideLines_OnlyAdded", async () => {
    const { extractSideLines } = await import("../../../src/ocr-v193/diff/resolver.js");
    const { HunkAdded } = await import("../../../src/ocr-v193/diff/hunk.js");
    const hunk: any = { oldStart: 1, oldCount: 0, newStart: 1, newCount: 2, lines: [{type:HunkAdded,content:"line1"},{type:HunkAdded,content:"line2"}] };
    expect(extractSideLines(hunk,true)).toHaveLength(2); expect(extractSideLines(hunk,false)).toHaveLength(0);
  });
  test("ExtractSideLines_OnlyDeleted", async () => {
    const { extractSideLines } = await import("../../../src/ocr-v193/diff/resolver.js");
    const { HunkDeleted } = await import("../../../src/ocr-v193/diff/hunk.js");
    const hunk: any = { oldStart: 3, oldCount: 2, newStart: 3, newCount: 0, lines: [{type:HunkDeleted,content:"old1"},{type:HunkDeleted,content:"old2"}] };
    const os = extractSideLines(hunk,false); expect(os[0]!.lineNum).toBe(3); expect(os[1]!.lineNum).toBe(4);
    expect(extractSideLines(hunk,true)).toHaveLength(0);
  });
  test("MatchConsecutive_SingleLine", async () => {
    const { matchConsecutive } = await import("../../../src/ocr-v193/diff/resolver.js");
    const r = matchConsecutive([{lineNum:5,content:"hello"},{lineNum:6,content:"world"},{lineNum:7,content:"foo"}],["world"]);
    expect(r).toEqual({startLine:6,endLine:6,found:true});
  });
  test("MatchConsecutive_MultiLine", async () => {
    const { matchConsecutive } = await import("../../../src/ocr-v193/diff/resolver.js");
    const r = matchConsecutive([{lineNum:1,content:"a"},{lineNum:2,content:"b"},{lineNum:3,content:"c"},{lineNum:4,content:"d"}],["b","c"]);
    expect(r).toEqual({startLine:2,endLine:3,found:true});
  });
  test("MatchConsecutive_NoMatch", async () => {
    const { matchConsecutive } = await import("../../../src/ocr-v193/diff/resolver.js");
    expect(matchConsecutive([{lineNum:1,content:"a"},{lineNum:2,content:"b"}],["x"]).found).toBe(false);
  });
  test("MatchConsecutive_FirstMatchWins", async () => {
    const { matchConsecutive } = await import("../../../src/ocr-v193/diff/resolver.js");
    const r = matchConsecutive([{lineNum:10,content:"x"},{lineNum:11,content:"y"},{lineNum:20,content:"x"},{lineNum:21,content:"y"}],["x","y"]);
    expect(r.startLine).toBe(10); expect(r.endLine).toBe(11);
  });
  test("MatchConsecutive_TargetLongerThanLines", async () => {
    const { matchConsecutive } = await import("../../../src/ocr-v193/diff/resolver.js");
    expect(matchConsecutive([{lineNum:1,content:"a"}],["a","b"]).found).toBe(false);
  });
  test("MatchConsecutive_EmptySideLines", async () => {
    const { matchConsecutive } = await import("../../../src/ocr-v193/diff/resolver.js");
    expect(matchConsecutive([],["a"]).found).toBe(false);
  });
  test("MatchConsecutive_MatchAtEnd", async () => {
    const { matchConsecutive } = await import("../../../src/ocr-v193/diff/resolver.js");
    const r = matchConsecutive([{lineNum:1,content:"a"},{lineNum:2,content:"b"},{lineNum:3,content:"c"}],["b","c"]);
    expect(r.startLine).toBe(2); expect(r.found).toBe(true);
  });
  test("MatchConsecutive_MatchAtStart", async () => {
    const { matchConsecutive } = await import("../../../src/ocr-v193/diff/resolver.js");
    const r = matchConsecutive([{lineNum:1,content:"a"},{lineNum:2,content:"b"},{lineNum:3,content:"c"}],["a","b"]);
    expect(r.startLine).toBe(1);
  });
  test("MatchConsecutive_ExactFull", async () => {
    const { matchConsecutive } = await import("../../../src/ocr-v193/diff/resolver.js");
    const r = matchConsecutive([{lineNum:5,content:"x"},{lineNum:6,content:"y"}],["x","y"]);
    expect(r).toEqual({startLine:5,endLine:6,found:true});
  });
  test("ResolveFromHunk_AddedLines", () => {
    const d = diff({ newPath: "a.go", diff: "@@ -10,3 +10,4 @@\n ctx := r.Context()\n-log.Print(\"old\")\n+log.Printf(\"new\")\n err := process(ctx)" });
    const c = cm({ path: "a.go", content: "x", existingCode: 'log.Printf("new")' });
    expect(resolveComment(c,d)).toBe(true); expect(c.startLine).toBe(11);
  });
  test("ResolveFromHunk_NewSidePriority", () => {
    const d = diff({ newPath: "a.go", oldPath: "a.go", diff: "@@ -5,2 +5,2 @@\n-oldVal\n+newVal" });
    const c = cm({ path: "a.go", content: "x", existingCode: "newVal" });
    const ok = resolveComment(c,d);
    expect(ok).toBe(true); expect(c.startLine).toBe(5);
  });
  test("ResolveFromHunk_MultiHunkMatchInSecond", () => {
    const d = diff({ newPath: "a.go", diff: "@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n@@ -10,3 +10,4 @@\n x\n+y\n z\n w" });
    const c = cm({ path: "a.go", content: "x", existingCode: "y" });
    expect(resolveComment(c,d)).toBe(true); expect(c.startLine).toBe(11);
  });
  test("MultipleCommentsOnSameFile", () => {
    const raw = "@@ -1,5 +1,5 @@\n line1\n-line2\n+line2_new\n line3\n-line4\n+line4_new\n line5";
    const diffs = [diff({ newPath: "a.go", diff: raw })];
    const comments = [cm({ path: "a.go", content: "c1", existingCode: "line2_new" }), cm({ path: "a.go", content: "c2", existingCode: "line4_new" })];
    const r = resolveLineNumbers(comments, diffs);
    expect(r[0]!.startLine).toBe(2); expect(r[1]!.startLine).toBe(4);
  });
  test("OldPathMapping", () => {
    const diffs = [diff({ newPath: "new.go", oldPath: "old.go", diff: "@@ -1,2 +1,2 @@\n-old\n+new\n+target" })];
    const comments = [cm({ path: "old.go", content: "x", existingCode: "target" })];
    const r = resolveLineNumbers(comments, diffs);
    expect(r[0]!.startLine).toBe(2);
  });
  test("MixedStrategies", () => {
    // one via hunk, one via fallback
    const diffs = [diff({ newPath: "a.go", newFileContent: "alpha\nbeta\ngamma\n", diff: "@@ -1,2 +1,3 @@\n alpha\n+beta\n gamma" })];
    const comments = [cm({ path: "a.go", content: "c1", existingCode: "beta" }), cm({ path: "a.go", content: "c2", existingCode: "alpha\ngamma" })];
    const r = resolveLineNumbers(comments, diffs);
    // beta resolves via hunk
    expect(r[0]!.startLine).toBeGreaterThan(0);
  });

});

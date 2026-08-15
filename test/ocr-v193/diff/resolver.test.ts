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
});

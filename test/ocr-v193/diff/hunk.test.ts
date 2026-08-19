// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/hunk_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { expect, test } from "bun:test";
import {
  HunkAdded,
  HunkContext,
  HunkDeleted,
  parseHunks,
  type HunkLineType,
} from "../../../src/ocr-v193/diff/hunk.js";

// OCR v1.9.3: TestParseHunks_SingleHunk
test("TestParseHunks_SingleHunk", () => {
  const raw = `diff --git a/pkg/example/handler.go b/pkg/example/handler.go
--- a/pkg/example/handler.go
+++ b/pkg/example/handler.go
@@ -10,7 +10,7 @@ func HandleRequest(w http.ResponseWriter, r *http.Request) {
     ctx := r.Context()
-    log.Print("handling request")
+    log.Printf("handling request: %s", r.URL.Path)
     err := process(ctx)`;

  const hunks = parseHunks(raw);

  expect(hunks).toHaveLength(1);
  const hunk = hunks[0]!;
  expect(hunk.oldStart).toBe(10);
  expect(hunk.oldCount).toBe(7);
  expect(hunk.newStart).toBe(10);
  expect(hunk.newCount).toBe(7);
  expect(hunk.lines).toHaveLength(4);

  const expected: readonly HunkLineType[] = [HunkContext, HunkDeleted, HunkAdded, HunkContext];
  for (const [index, lineType] of expected.entries()) {
    expect(hunk.lines[index]!.type, `line[${index}]`).toBe(lineType);
  }
});

// OCR v1.9.3: TestParseHunks_MultipleHunks
test("TestParseHunks_MultipleHunks", () => {
  const raw = `diff --git a/pkg/example/handler.go b/pkg/example/handler.go
--- a/pkg/example/handler.go
+++ b/pkg/example/handler.go
@@ -10,3 +10,3 @@ func foo() {
     a := 1
-    b := 2
+    b := 3
     c := 4
@@ -25,6 +25,8 @@ func bar() {
     if err != nil {
         return err
     }
+    log.Print("ok")
+    log.Print("done")
     return nil`;

  const hunks = parseHunks(raw);
  expect(hunks).toHaveLength(2);

  const first = hunks[0]!;
  expect(first.oldStart).toBe(10);
  expect(first.newStart).toBe(10);

  const second = hunks[1]!;
  expect(second.oldStart).toBe(25);
  expect(second.newStart).toBe(25);
  expect(second.oldCount).toBe(6);
  expect(second.newCount).toBe(8);
});

// OCR v1.9.3: TestParseHunks_NoNewlineMarker
test("TestParseHunks_NoNewlineMarker", () => {
  const raw = `@@ -1,2 +1,2 @@
-    old line
\\ No newline at end of file
+    new line`;

  const hunks = parseHunks(raw);
  expect(hunks).toHaveLength(1);
  expect(hunks[0]!.lines).toHaveLength(2);
});

// OCR v1.9.3: TestParseHunks_EmptyInput
test("TestParseHunks_EmptyInput", () => {
  expect(parseHunks("")).toHaveLength(0);
});

// OCR v1.9.3: TestParseHunks_NewFileAllAdditions
test("TestParseHunks_NewFileAllAdditions", () => {
  const raw = `diff --git a/pkg/new.go b/pkg/new.go
new file mode 100644
--- /dev/null
+++ b/pkg/new.go
@@ -0,0 +1,3 @@
+package pkg
+
+func New() {}`;

  const hunks = parseHunks(raw);
  expect(hunks).toHaveLength(1);
  for (const line of hunks[0]!.lines) {
    expect(line.type).toBe(HunkAdded);
  }
});

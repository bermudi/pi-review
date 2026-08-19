// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/parser_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseDiffText } from "../../../src/ocr-v193/diff/parser.js";

async function parse(diffText: string, files: Record<string, string> = {}) {
  const repoDir = await mkdtemp(join(tmpdir(), "pi-reviewer-parser-"));
  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => {
      const filePath = join(repoDir, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }));
    return await parseDiffText(diffText, repoDir, "", null);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

// OCR v1.9.3: TestParseDiffText_StripsIndexHeadersFromPromptDiff
test("TestParseDiffText_StripsIndexHeadersFromPromptDiff", async () => {
  const diffs = await parse(`diff --git a/first.go b/first.go
index 1234567..89abcde 100644
--- a/first.go
+++ b/first.go
@@ -1,1 +1,2 @@
 first
+index added-content
diff --git a/second.go b/second.go
new file mode 100644
index 0000000..7654321
--- /dev/null
+++ b/second.go
@@ -0,0 +1 @@
+package second
`, {
    "first.go": "first\nindex added-content\n",
    "second.go": "package second\n",
  });

  expect(diffs).toHaveLength(2);
  for (const diff of diffs) {
    expect(diff.diff).not.toContain("\nindex ");
  }
  expect(diffs[0]!.diff).toContain("diff --git a/first.go b/first.go");
  expect(diffs[0]!.diff).toContain("+index added-content");
  expect(diffs[1]!.isNew).toBe(true);
});

// OCR v1.9.3: TestParseDiffText_Rename
test("TestParseDiffText_Rename", async () => {
  const diffs = await parse(`diff --git a/pkg/old name.go b/pkg/new name.go
similarity index 95%
rename from pkg/old name.go
rename to pkg/new name.go
index 1234567..89abcde 100644
--- a/pkg/old name.go
+++ b/pkg/new name.go
@@ -1,3 +1,3 @@
 line1
-line2
+line2 changed
 line3
`, { "pkg/new name.go": "line1\nline2 changed\nline3\n" });

  expect(diffs).toHaveLength(1);
  const diff = diffs[0]!;
  expect(diff.isRenamed).toBe(true);
  expect(diff.oldPath).toBe("pkg/old name.go");
  expect(diff.newPath).toBe("pkg/new name.go");
  expect(diff.isNew).toBe(false);
  expect(diff.isDeleted).toBe(false);
});

// OCR v1.9.3: TestParseDiffText_PureRename
test("TestParseDiffText_PureRename", async () => {
  const diffs = await parse(`diff --git a/old.go b/new.go
similarity index 100%
rename from old.go
rename to new.go
`, { "new.go": "package main\n" });

  expect(diffs).toHaveLength(1);
  const diff = diffs[0]!;
  expect(diff.isRenamed).toBe(true);
  expect(diff.oldPath).toBe("old.go");
  expect(diff.newPath).toBe("new.go");
});

// OCR v1.9.3: TestParseDiffText_DeletedFile
test("TestParseDiffText_DeletedFile", async () => {
  const diffs = await parse(`diff --git a/gone.go b/gone.go
deleted file mode 100644
index 1234567..0000000
--- a/gone.go
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2
`);

  expect(diffs).toHaveLength(1);
  const diff = diffs[0]!;
  expect(diff.isDeleted).toBe(true);
  expect(diff.newPath).toBe("/dev/null");
  expect(diff.oldPath).toBe("gone.go");
});

// OCR v1.9.3: TestParseDiffText_NewFile
test("TestParseDiffText_NewFile", async () => {
  const diffs = await parse(`diff --git a/fresh.go b/fresh.go
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/fresh.go
@@ -0,0 +1,2 @@
+line1
+line2
`, { "fresh.go": "line1\nline2\n" });

  expect(diffs).toHaveLength(1);
  const diff = diffs[0]!;
  expect(diff.isNew).toBe(true);
  expect(diff.isDeleted).toBe(false);
  expect(diff.insertions).toBe(2);
});

// OCR v1.9.3: TestParseDiffText_BinaryMarkerAnchored
test("TestParseDiffText_BinaryMarkerAnchored", async () => {
  const diffs = await parse(`diff --git a/docs.md b/docs.md
index 1234567..89abcde 100644
--- a/docs.md
+++ b/docs.md
@@ -1,2 +1,3 @@
 line1
+Note: Binary files are handled specially by git.
 line2
diff --git a/blob.bin b/blob.bin
index 1234567..89abcde 100644
Binary files a/blob.bin and b/blob.bin differ
`, {
    "docs.md": "line1\nNote: Binary files are handled specially by git.\nline2\n",
    "blob.bin": "",
  });

  expect(diffs).toHaveLength(2);
  expect(diffs[0]!.isBinary).toBe(false);
  expect(diffs[0]!.insertions).toBe(1);
  expect(diffs[1]!.isBinary).toBe(true);
});

// OCR v1.9.3: TestParseDiffText_CountsContentLinesWithPlusMinusPrefix
test("TestParseDiffText_CountsContentLinesWithPlusMinusPrefix", async () => {
  const diffs = await parse(`diff --git a/counter.go b/counter.go
index 1234567..89abcde 100644
--- a/counter.go
+++ b/counter.go
@@ -1,3 +1,3 @@
 func inc() {
---oldFlag
+++newFlag
 }
`, { "counter.go": "func inc() {\n++newFlag\n}\n" });

  expect(diffs).toHaveLength(1);
  expect(diffs[0]!.insertions).toBe(1);
  expect(diffs[0]!.deletions).toBe(1);
});

// OCR v1.9.3: TestParseDiffText_DevNullStringInsideHunk
test("TestParseDiffText_DevNullStringInsideHunk", async () => {
  const diffs = await parse(`diff --git a/paths.txt b/paths.txt
index 1234567..89abcde 100644
--- a/paths.txt
+++ b/paths.txt
@@ -1,1 +1,2 @@
 first
+++ /dev/null
`, { "paths.txt": "first\n++ /dev/null\n" });

  expect(diffs).toHaveLength(1);
  expect(diffs[0]!.isDeleted).toBe(false);
  expect(diffs[0]!.insertions).toBe(1);
});

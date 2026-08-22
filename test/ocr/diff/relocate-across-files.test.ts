// SPDX-License-Identifier: Apache-2.0
// Ported from OCR v1.9.5 internal/diff/relocate_across_files_test.go at
// 9a371c9b3610fb4e9892bd50b72941e26201c2c1.

import { expect, test } from "bun:test";
import { relocateAcrossFiles } from "../../../src/ocr/diff/resolver.js";
import { createDiff } from "../../../src/ocr/model/diff.js";
import { createLlmComment } from "../../../src/ocr/model/review.js";

const headerDiff = `diff --git a/src/span.h b/src/span.h
--- a/src/span.h
+++ b/src/span.h
@@ -10,3 +10,4 @@
 void span_set_text(span_t * span, const char * text);
+void span_set_text_fmt(span_t * span, const char * fmt, ...);
`;

const sourceDiff = `diff --git a/src/span.c b/src/span.c
--- a/src/span.c
+++ b/src/span.c
@@ -40,4 +40,7 @@
 void span_set_text_fmt(span_t * span, const char * fmt, ...)
 {
+	char * text = span_vfmt(fmt, args);
+	if(text == NULL) return;
+	va_end(args);
 }
`;

function diffsFixture() {
  return [
    createDiff({ newPath: "src/span.h", oldPath: "src/span.h", diff: headerDiff }),
    createDiff({ newPath: "src/span.c", oldPath: "src/span.c", diff: sourceDiff }),
  ];
}

// OCR v1.9.9: TestRelocateAcrossFiles_RefilesToImplementation
test("re-files a unique cross-file match with its resolved line range", () => {
  const cm = createLlmComment({
    path: "src/span.h",
    content: "va_end is skipped on the early return",
    existingCode: "\tif(text == NULL) return;\n\tva_end(args);",
  });

  const [path, ok] = relocateAcrossFiles(cm, diffsFixture());
  expect(ok).toBe(true);
  expect(path).toBe("src/span.c");
  expect(cm.path).toBe("src/span.c");
  expect(cm.startLine ?? 0).toBeGreaterThan(0);
  expect(cm.endLine ?? 0).toBeGreaterThanOrEqual(cm.startLine ?? 0);
});

// OCR v1.9.9: TestRelocateAcrossFiles_DeclinesWhenAmbiguous
test("declines ambiguous cross-file matches without mutating the comment", () => {
  const duplicate = createDiff({
    newPath: "src/other.c",
    oldPath: "src/other.c",
    diff: sourceDiff.replace("src/span.c", "src/other.c"),
  });
  const cm = createLlmComment({
    path: "src/span.h",
    content: "",
    existingCode: "\tif(text == NULL) return;\n\tva_end(args);",
  });

  expect(relocateAcrossFiles(cm, [...diffsFixture(), duplicate])).toEqual(["", false]);
  expect(cm.path).toBe("src/span.h");
  expect(cm.startLine ?? 0).toBe(0);
  expect(cm.endLine ?? 0).toBe(0);
});

// OCR v1.9.9: TestRelocateAcrossFiles_DeclinesWhenAbsent
test("declines when the quoted code is absent", () => {
  const cm = createLlmComment({
    path: "src/span.h",
    content: "",
    existingCode: "int nothing_here = 0;",
  });

  expect(relocateAcrossFiles(cm, diffsFixture())).toEqual(["", false]);
  expect(cm.path).toBe("src/span.h");
});

// OCR v1.9.9: TestRelocateAcrossFiles_SkipsOwnFileAndEmptyInputs
test("skips own-file hits and empty inputs", () => {
  const ownFile = createLlmComment({
    path: "src/span.c",
    content: "",
    existingCode: "\tva_end(args);",
  });
  expect(relocateAcrossFiles(ownFile, diffsFixture())).toEqual(["", false]);

  expect(relocateAcrossFiles(undefined, diffsFixture())).toEqual(["", false]);
  expect(relocateAcrossFiles(createLlmComment({ path: "src/span.h", content: "" }), diffsFixture())).toEqual(["", false]);
  expect(relocateAcrossFiles(createLlmComment({ path: "", content: "", existingCode: "x" }), [])).toEqual(["", false]);
});

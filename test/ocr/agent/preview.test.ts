// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/preview_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import { effectivePath, diffStatus, whyExcluded } from "../../../src/ocr/agent/preview.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import { createDiff } from "../../../src/ocr/model/diff.js";
import { ExcludeNone, ExcludeUserRule, ExcludeExtension, ExcludeDefaultPath, ExcludeBinary } from "../../../src/ocr/model/preview.js";
import type { ExcludeReason } from "../../../src/ocr/model/preview.js";

describe("ocr agent preview whyExcluded (ported)", () => {
  // OCR v1.9.3: TestWhyExcluded_BinaryFile
  test("TestWhyExcluded_BinaryFile", () => {
    const cases: Array<{ name: string; diff: Diff; expected: ExcludeReason }> = [
      { name: "binary file returns ExcludeBinary", diff: createDiff({ newPath: "image.png", isBinary: true }), expected: ExcludeBinary },
      { name: "non-binary go file returns ExcludeNone", diff: createDiff({ newPath: "main.go" }), expected: ExcludeNone },
      { name: "binary file with valid extension still excluded", diff: createDiff({ newPath: "document.pdf", isBinary: true }), expected: ExcludeBinary },
    ];
    for (const tc of cases) {
      const got = whyExcluded(tc.diff, null);
      expect(got).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestWhyExcluded_UserExcludePattern
  test("TestWhyExcluded_UserExcludePattern", () => {
    const filter = { exclude: ["vendor/**", "*.gen.go"] } as unknown as import("../../../src/ocr/rules/system_rules.js").FileFilter;
    const cases: Array<{ name: string; diff: Diff; expected: ExcludeReason }> = [
      { name: "file matching exclude pattern", diff: createDiff({ newPath: "vendor/foo/bar.go" }), expected: ExcludeUserRule },
      { name: "generated file excluded", diff: createDiff({ newPath: "api.gen.go" }), expected: ExcludeUserRule },
      { name: "regular file not excluded", diff: createDiff({ newPath: "main.go" }), expected: ExcludeNone },
    ];
    for (const tc of cases) {
      const got = whyExcluded(tc.diff, filter);
      expect(got).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestWhyExcluded_ExtensionFilter
  test("TestWhyExcluded_ExtensionFilter", () => {
    const cases: Array<{ name: string; diff: Diff; expected: ExcludeReason }> = [
      { name: "unsupported extension txt", diff: createDiff({ newPath: "README.txt" }), expected: ExcludeExtension },
      { name: "unsupported extension md", diff: createDiff({ newPath: "docs/guide.md" }), expected: ExcludeExtension },
      { name: "supported extension go", diff: createDiff({ newPath: "main.go" }), expected: ExcludeNone },
      { name: "supported extension java", diff: createDiff({ newPath: "src/Main.java" }), expected: ExcludeNone },
      { name: "supported extension ts", diff: createDiff({ newPath: "app.ts" }), expected: ExcludeNone },
      { name: "file without extension", diff: createDiff({ newPath: "Makefile" }), expected: ExcludeNone },
    ];
    for (const tc of cases) {
      const got = whyExcluded(tc.diff, null);
      expect(got).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestWhyExcluded_DefaultPathFilter
  test("TestWhyExcluded_DefaultPathFilter", () => {
    const cases: Array<{ name: string; diff: Diff; expected: ExcludeReason }> = [
      { name: "test file excluded by default path", diff: createDiff({ newPath: "foo_test.go" }), expected: ExcludeDefaultPath },
      { name: "java test file excluded", diff: createDiff({ newPath: "src/test/java/com/example/FooTest.java" }), expected: ExcludeDefaultPath },
      { name: "regular source file not excluded", diff: createDiff({ newPath: "src/main/java/com/example/Foo.java" }), expected: ExcludeNone },
      { name: "go source file not excluded", diff: createDiff({ newPath: "handler.go" }), expected: ExcludeNone },
    ];
    for (const tc of cases) {
      const got = whyExcluded(tc.diff, null);
      expect(got).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestWhyExcluded_UserIncludePattern
  test("TestWhyExcluded_UserIncludePattern", () => {
    const filter = { include: ["src/**/*.go", "pkg/**/*.go", "**/*.supportedext"], exclude: [] } as unknown as import("../../../src/ocr/rules/system_rules.js").FileFilter;
    const cases: Array<{ name: string; diff: Diff; expected: ExcludeReason }> = [
      { name: "file matching first include pattern is reviewed", diff: createDiff({ newPath: "src/foo/bar.go" }), expected: ExcludeNone },
      { name: "file matching second include pattern is reviewed", diff: createDiff({ newPath: "pkg/util/helper.go" }), expected: ExcludeNone },
      { name: "include pattern bypasses default-path exclusion for test files", diff: createDiff({ newPath: "src/foo/bar_test.go" }), expected: ExcludeNone },
      { name: "non-included file with valid extension still reviewed (additive semantics)", diff: createDiff({ newPath: "vendor/baz.go" }), expected: ExcludeNone },
      { name: "non-included file in non-excluded directory still reviewed", diff: createDiff({ newPath: "internal/handler.go" }), expected: ExcludeNone },
      { name: "include check overrides extension exclusion", diff: createDiff({ newPath: "internal/test.supportedext" }), expected: ExcludeNone },
      { name: "unsupported extension even if path looks like include dir", diff: createDiff({ newPath: "src/notes.txt" }), expected: ExcludeExtension },
      { name: "non-included test file excluded by default path", diff: createDiff({ newPath: "internal/handler_test.go" }), expected: ExcludeDefaultPath },
    ];
    for (const tc of cases) {
      const got = whyExcluded(tc.diff, filter as unknown as never);
      expect(got).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestWhyExcluded_IncludeBypassesDefaultPath
  test("TestWhyExcluded_IncludeBypassesDefaultPath", () => {
    const filter = { include: ["**/*_test.go"] } as unknown as import("../../../src/ocr/rules/system_rules.js").FileFilter;
    const cases: Array<{ name: string; diff: Diff; expected: ExcludeReason }> = [
      { name: "test file explicitly included overrides default-path exclusion", diff: createDiff({ newPath: "foo_test.go" }), expected: ExcludeNone },
      { name: "non-test file still reviewed via default checks", diff: createDiff({ newPath: "main.go" }), expected: ExcludeNone },
    ];
    for (const tc of cases) {
      const got = whyExcluded(tc.diff, filter as unknown as never);
      expect(got).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestWhyExcluded_IncludeAndExcludeInteraction
  test("TestWhyExcluded_IncludeAndExcludeInteraction", () => {
    const filter = { include: ["src/**/*.go"], exclude: ["src/generated/**"] } as unknown as import("../../../src/ocr/rules/system_rules.js").FileFilter;
    const cases: Array<{ name: string; diff: Diff; expected: ExcludeReason }> = [
      { name: "included file is reviewed", diff: createDiff({ newPath: "src/handler.go" }), expected: ExcludeNone },
      { name: "file matching both include and exclude is excluded (exclude wins)", diff: createDiff({ newPath: "src/generated/api.go" }), expected: ExcludeUserRule },
      { name: "file outside include with valid ext still reviewed (additive)", diff: createDiff({ newPath: "lib/utils.go" }), expected: ExcludeNone },
    ];
    for (const tc of cases) {
      const got = whyExcluded(tc.diff, filter as unknown as never);
      expect(got).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestWhyExcluded_PriorityOrder
  test("TestWhyExcluded_PriorityOrder", () => {
    const filter = { exclude: ["vendor/**"] } as unknown as import("../../../src/ocr/rules/system_rules.js").FileFilter;
    const diff = createDiff({ newPath: "vendor/image.png", isBinary: true });
    const got = whyExcluded(diff, filter as unknown as never);
    expect(got).toBe(ExcludeBinary);
  });

  // OCR v1.9.3: TestShouldReview
  test("TestShouldReview", () => {
    const cases: Array<{ name: string; diff: Diff; expected: boolean }> = [
      { name: "binary file should not be reviewed", diff: createDiff({ newPath: "image.png", isBinary: true }), expected: false },
      { name: "regular go file should be reviewed", diff: createDiff({ newPath: "main.go" }), expected: true },
      { name: "test file should not be reviewed", diff: createDiff({ newPath: "main_test.go" }), expected: false },
      { name: "unsupported extension should not be reviewed", diff: createDiff({ newPath: "README.md" }), expected: false },
    ];
    for (const tc of cases) {
      const got = whyExcluded(tc.diff, null) === ExcludeNone;
      expect(got).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestEffectivePath
  test("TestEffectivePath", () => {
    const cases: Array<{ name: string; diff: Diff; expected: string }> = [
      { name: "normal new path", diff: createDiff({ oldPath: "old.go", newPath: "new.go" }), expected: "new.go" },
      { name: "new path is dev/null (deleted file)", diff: createDiff({ oldPath: "deleted.go", newPath: "/dev/null" }), expected: "deleted.go" },
      { name: "renamed file uses new path", diff: createDiff({ oldPath: "old_name.go", newPath: "new_name.go" }), expected: "new_name.go" },
    ];
    for (const tc of cases) {
      const got = effectivePath(tc.diff);
      expect(got).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestDiffStatus
  test("TestDiffStatus", () => {
    const cases: Array<{ name: string; diff: Diff; expected: string }> = [
      { name: "binary file", diff: createDiff({ isBinary: true }), expected: "binary" },
      { name: "new file", diff: createDiff({ isNew: true }), expected: "added" },
      { name: "deleted file", diff: createDiff({ isDeleted: true }), expected: "deleted" },
      { name: "renamed file", diff: createDiff({ oldPath: "old.go", newPath: "new.go" }), expected: "renamed" },
      { name: "modified file", diff: createDiff({ oldPath: "main.go", newPath: "main.go" }), expected: "modified" },
    ];
    for (const tc of cases) {
      const got = diffStatus(tc.diff);
      expect(got).toBe(tc.expected);
    }
  });
});

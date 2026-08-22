// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/scan/batch_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// localPath test/ocr/scan/batch.test.ts -> internal/scan/batch_test.go

import { describe, test, expect } from "bun:test";
import type { ScanItem } from "../../../src/ocr/model/scan.js";
import {
  groupBatches,
  parseBatchStrategy,
  BatchNone,
  BatchByLanguage,
  BatchByDirectory,
} from "../../../src/ocr/scan/batch.js";

function itemList(paths: string[]): ScanItem[] {
  return paths.map((p) => ({ path: p, content: "", isBinary: false, lineCount: 0 }));
}

function batchPaths(b: ScanItem[][] | null): string[][] | null {
  if (b === null) return null;
  return b.map((batch) => batch.map((it) => it.path));
}

describe("ocr scan batch (ported from internal/scan/batch_test.go)", () => {
  // OCR v1.9.3: TestParseBatchStrategy
  test("TestParseBatchStrategy", () => {
    const cases: Record<string, typeof BatchNone> = {
      "": BatchNone,
      "   ": BatchNone,
      "by-language": BatchByLanguage,
      "BY-LANGUAGE": BatchByLanguage,
      "by-directory": BatchByDirectory,
      "none": BatchNone,
      "by-author": BatchNone, // unknown → safe default
      "  by-language ": BatchByLanguage,
    } as unknown as Record<string, typeof BatchNone>;
    for (const [input, want] of Object.entries(cases)) {
      const got = parseBatchStrategy(input);
      expect(got).toBe(want);
    }
  });

  // OCR v1.9.3: TestGroupBatches_ByLanguage
  test("TestGroupBatches_ByLanguage", () => {
    const items = itemList([
      "cmd/main.go",
      "internal/scan/agent.go",
      "docs/README.md",
      "scripts/build.sh",
      "internal/scan/preview.go",
      "docs/intro.md",
    ]);
    const got = batchPaths(groupBatches(items, BatchByLanguage, 0));
    const want: string[][] = [
      ["cmd/main.go", "internal/scan/agent.go", "internal/scan/preview.go"], // .go
      ["docs/README.md", "docs/intro.md"], // .md
      ["scripts/build.sh"], // .sh
    ];
    expect(got).toEqual(want);
  });

  // OCR v1.9.3: TestGroupBatches_ByDirectory
  test("TestGroupBatches_ByDirectory", () => {
    const items = itemList([
      "README.md", // <root>
      "cmd/main.go", // cmd
      "internal/a/x.go", // internal
      "internal/b/y.go", // internal
      "cmd/scan.go", // cmd
      "LICENSE", // <root>
    ]);
    const got = batchPaths(groupBatches(items, BatchByDirectory, 0));
    const want: string[][] = [
      ["README.md", "LICENSE"], // <root>
      ["cmd/main.go", "cmd/scan.go"], // cmd
      ["internal/a/x.go", "internal/b/y.go"], // internal
    ];
    expect(got).toEqual(want);
  });

  // OCR v1.9.3: TestGroupBatches_None
  test("TestGroupBatches_None", () => {
    const items = itemList(["a.go", "b.go", "c.py"]);
    const got = batchPaths(groupBatches(items, BatchNone, 0));
    const want: string[][] = [["a.go"], ["b.go"], ["c.py"]];
    expect(got).toEqual(want);
  });

  // OCR v1.9.3: TestGroupBatches_BatchSizeCap
  test("TestGroupBatches_BatchSizeCap", () => {
    const items = itemList(["a.go", "b.go", "c.go", "d.go", "e.go"]);
    const got = batchPaths(groupBatches(items, BatchByLanguage, 2));
    const want: string[][] = [
      ["a.go", "b.go"],
      ["c.go", "d.go"],
      ["e.go"],
    ];
    expect(got).toEqual(want);
  });

  // OCR v1.9.3: TestGroupBatches_Empty
  test("TestGroupBatches_Empty", () => {
    const got = groupBatches([], BatchByLanguage, 0);
    expect(got).toBeNull();
  });

  // OCR v1.9.3: TestLanguageKey_ExtensionlessAndDotfiles
  test("TestLanguageKey_ExtensionlessAndDotfiles", () => {
    // Directly test language grouping via groupBatches with BatchByLanguage:
    // extensionless and dotfiles should all land in <no-ext> together.
    const items = itemList([
      "Makefile",
      "src/Dockerfile",
      ".gitignore",
      ".github/CODEOWNERS",
      "cmd/main.go",
      "docs/README.MD",
      "a/b/c.Test.go",
    ]);
    const batches = groupBatches(items, BatchByLanguage, 0);
    expect(batches).not.toBeNull();
    // Find the <no-ext> batch (first after sorting: <no-ext> < .go < .md)
    const paths = batchPaths(batches);
    // <no-ext> batch should contain the 4 no-ext items in input order
    const noExtBatch = paths?.find((b) => b.includes("Makefile"));
    expect(noExtBatch).toEqual(["Makefile", "src/Dockerfile", ".gitignore", ".github/CODEOWNERS"]);
    // .go batch should contain go files case-insensitively
    const goBatch = paths?.find((b) => b.includes("cmd/main.go"));
    expect(goBatch).toEqual(["cmd/main.go", "a/b/c.Test.go"]);
    // .md batch case-insensitive
    const mdBatch = paths?.find((b) => b.includes("docs/README.MD"));
    expect(mdBatch).toEqual(["docs/README.MD"]);
  });
});

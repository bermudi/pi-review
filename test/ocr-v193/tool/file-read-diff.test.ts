// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/file_read_diff_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { NewDiffMap, NewFileReadDiff } from "../../../src/ocr-v193/tool/filereader.js";

// OCR v1.9.3: TestNewDiffMap_DefensiveCopy
test("TestNewDiffMap_DefensiveCopy", () => {
  const orig: Record<string, string> = { "a.go": "diff a" };
  const dm = NewDiffMap(orig);
  orig["a.go"] = "mutated";
  const [v] = dm.Get("a.go");
  expect(v).toBe("diff a");
});

// OCR v1.9.3: TestDiffMap_Get
test("TestDiffMap_Get", () => {
  const dm = NewDiffMap({ "x.go": "content" });
  const [v, ok] = dm.Get("x.go");
  expect(ok).toBe(true);
  expect(v).toBe("content");
  const [, ok2] = dm.Get("missing.go");
  expect(ok2).toBe(false);
});

// OCR v1.9.3: TestFileReadDiffProvider_Execute
test("TestFileReadDiffProvider_Execute", async () => {
  const dm = NewDiffMap({
    "a.go": "@@ -1 +1 @@\n-old\n+new",
    "b.go": "@@ -5 +5 @@\n-foo\n+bar",
  });
  const p = NewFileReadDiff(dm);
  const cases: Array<{ name: string; args: Record<string, unknown>; wantSub?: string; wantErr?: string }> = [
    { name: "single existing path", args: { path_array: ["a.go"] }, wantSub: "==== FILE: a.go ====" },
    { name: "multiple paths", args: { path_array: ["a.go", "b.go"] }, wantSub: "==== FILE: b.go ====" },
    { name: "missing path", args: { path_array: ["missing.go"] }, wantErr: "Error: diff not found" },
    { name: "empty path_array", args: { path_array: [] }, wantErr: "Error: no files found" },
    { name: "nil path_array", args: {}, wantErr: "Error: no files found" },
  ];
  for (const tc of cases) {
    const got = await p.Execute(undefined, tc.args);
    if (tc.wantErr) {
      expect(got).toContain(tc.wantErr);
    } else {
      expect(got).toContain(tc.wantSub!);
    }
  }
});

// OCR v1.9.3: TestFileReadDiffProvider_SetDiffMap
test("TestFileReadDiffProvider_SetDiffMap", async () => {
  const p = NewFileReadDiff(NewDiffMap({ "old.go": "v1" }));
  p.SetDiffMap(NewDiffMap({ "new.go": "v2" }));
  const got = await p.Execute(undefined, { path_array: ["new.go"] });
  expect(got).toContain("new.go");
});

// OCR v1.9.3: TestFileReadDiffProvider_Tool
test("TestFileReadDiffProvider_Tool", () => {
  const p = NewFileReadDiff(NewDiffMap(null as unknown as Record<string, string>));
  expect(p.Tool()).toBeDefined();
});

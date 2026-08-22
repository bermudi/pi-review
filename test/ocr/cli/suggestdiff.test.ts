// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/suggestdiff/diff_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import {
  computeLineDiff,
  ComputeLineDiff,
  DiffAdded,
  DiffContext,
  DiffDeleted,
  type DiffLine,
} from "../../../src/ocr/cli/output.js";

// OCR v1.9.3: TestComputeLineDiff
test("TestComputeLineDiff table-driven diff cases", () => {
  // Mirrors Go's table: name, old, new, wantLen, wantAdds, wantDels
  // Also verifies exact DiffLine sequence including ordering and context content.
  type Case = {
    name: string;
    old: string[] | null;
    new: string[] | null;
    wantLen: number;
    wantAdds: number;
    wantDels: number;
    want: DiffLine[];
  };

  const cases: Case[] = [
    {
      name: "both empty",
      old: null,
      new: null,
      wantLen: 0,
      wantAdds: 0,
      wantDels: 0,
      want: [],
    },
    {
      name: "identical single line",
      old: ["hello"],
      new: ["hello"],
      wantLen: 1,
      wantAdds: 0,
      wantDels: 0,
      want: [{ type: DiffContext, content: "hello" }],
    },
    {
      name: "add lines to empty",
      old: [],
      new: ["a", "b"],
      wantLen: 2,
      wantAdds: 2,
      wantDels: 0,
      want: [
        { type: DiffAdded, content: "a" },
        { type: DiffAdded, content: "b" },
      ],
    },
    {
      name: "delete all lines",
      old: ["a", "b"],
      new: [],
      wantLen: 2,
      wantAdds: 0,
      wantDels: 2,
      want: [
        { type: DiffDeleted, content: "a" },
        { type: DiffDeleted, content: "b" },
      ],
    },
    {
      name: "replace single line",
      old: ["old"],
      new: ["new"],
      wantLen: 2,
      wantAdds: 1,
      wantDels: 1,
      // Ordering is deleted then added (LCS tie-break prefers added when >=)
      want: [
        { type: DiffDeleted, content: "old" },
        { type: DiffAdded, content: "new" },
      ],
    },
    {
      name: "insert in middle",
      old: ["a", "c"],
      new: ["a", "b", "c"],
      wantLen: 3,
      wantAdds: 1,
      wantDels: 0,
      want: [
        { type: DiffContext, content: "a" },
        { type: DiffAdded, content: "b" },
        { type: DiffContext, content: "c" },
      ],
    },
    {
      name: "delete from middle",
      old: ["a", "b", "c"],
      new: ["a", "c"],
      wantLen: 3,
      wantAdds: 0,
      wantDels: 1,
      want: [
        { type: DiffContext, content: "a" },
        { type: DiffDeleted, content: "b" },
        { type: DiffContext, content: "c" },
      ],
    },
    {
      name: "case insensitive match with whitespace",
      old: ["  Hello  "],
      new: ["hello"],
      wantLen: 1,
      wantAdds: 0,
      wantDels: 0,
      // Content preserves old line verbatim when matched case-insensitively with trimming.
      want: [{ type: DiffContext, content: "  Hello  " }],
    },
    {
      name: "multi-line edit",
      old: ["func main() {", '  fmt.Println("old")', "}"],
      new: ["func main() {", '  fmt.Println("new")', "  return", "}"],
      wantLen: 5,
      wantAdds: 2,
      wantDels: 1,
      want: [
        { type: DiffContext, content: "func main() {" },
        { type: DiffDeleted, content: '  fmt.Println("old")' },
        { type: DiffAdded, content: '  fmt.Println("new")' },
        { type: DiffAdded, content: "  return" },
        { type: DiffContext, content: "}" },
      ],
    },
  ];

  for (const tc of cases) {
    const oldLines: string[] = tc.old ?? [];
    const newLines: string[] = tc.new ?? [];
    const got = computeLineDiff(oldLines, newLines);
    // Also verify alias export mirrors same function.
    const gotAlias = ComputeLineDiff(oldLines, newLines);
    expect(gotAlias).toEqual(got);

    if (got.length !== tc.wantLen) {
      throw new Error(`${tc.name}: len = ${got.length}, want ${tc.wantLen}; diff = ${JSON.stringify(got)}`);
    }
    let adds = 0;
    let dels = 0;
    for (const l of got) {
      if (l.type === DiffAdded) adds++;
      else if (l.type === DiffDeleted) dels++;
    }
    if (adds !== tc.wantAdds) {
      throw new Error(`${tc.name}: adds = ${adds}, want ${tc.wantAdds}`);
    }
    if (dels !== tc.wantDels) {
      throw new Error(`${tc.name}: dels = ${dels}, want ${tc.wantDels}`);
    }
    // Exact output comparison including prefixes (type), newlines are split beforehand,
    // empty inputs, replacement ordering, and context content.
    expect(got).toEqual(tc.want);
  }
});

// OCR v1.9.3: TestComputeLineDiff_ContextContent
test("TestComputeLineDiff_ContextContent preserves first and last context", () => {
  const old = ["a", "b", "c"];
  const newer = ["a", "x", "c"];
  const got = computeLineDiff(old, newer);

  // Verify the contract from Go: first and last lines remain context 'a' and 'c'.
  expect(got.length).toBeGreaterThanOrEqual(2);
  expect(got[0]!.type).toBe(DiffContext);
  expect(got[0]!.content).toBe("a");
  const last = got[got.length - 1]!;
  expect(last.type).toBe(DiffContext);
  expect(last.content).toBe("c");

  // Full exact output for this replacement: context a, deleted b, added x, context c.
  expect(got).toEqual([
    { type: DiffContext, content: "a" },
    { type: DiffDeleted, content: "b" },
    { type: DiffAdded, content: "x" },
    { type: DiffContext, content: "c" },
  ]);
});

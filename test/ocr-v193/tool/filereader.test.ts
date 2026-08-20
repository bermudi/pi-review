// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/filereader_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { ParseReviewMode, ReviewMode, RefValue, scanLines } from "../../../src/ocr-v193/tool/filereader.js";

// OCR v1.9.3: TestParseReviewMode
test("TestParseReviewMode", () => {
  const cases: Array<{ from: string; to: string; commit: string; want: number }> = [
    { from: "", to: "", commit: "", want: ReviewMode.ModeWorkspace },
    { from: "HEAD~1", to: "HEAD", commit: "", want: ReviewMode.ModeRange },
    { from: "", to: "", commit: "abc123", want: ReviewMode.ModeCommit },
    { from: "a", to: "b", commit: "c", want: ReviewMode.ModeCommit },
    { from: "HEAD~1", to: "", commit: "", want: ReviewMode.ModeWorkspace },
    { from: "", to: "HEAD", commit: "", want: ReviewMode.ModeWorkspace },
  ];
  for (const c of cases) {
    const got = ParseReviewMode(c.from, c.to, c.commit);
    expect(got).toBe(c.want);
  }
});

// OCR v1.9.3: TestReviewMode_RefValue
test("TestReviewMode_RefValue", () => {
  const cases = [
    { mode: ReviewMode.ModeWorkspace, toRef: "HEAD", commit: "abc", wantRef: "", wantOk: false },
    { mode: ReviewMode.ModeRange, toRef: "HEAD", commit: "", wantRef: "HEAD", wantOk: true },
    { mode: ReviewMode.ModeCommit, toRef: "HEAD", commit: "abc123", wantRef: "abc123", wantOk: true },
  ];
  for (const c of cases) {
    const [ref, ok] = RefValue(c.mode, c.toRef, c.commit);
    expect(ref).toBe(c.wantRef);
    expect(ok).toBe(c.wantOk);
  }
});

// OCR v1.9.3: TestScanLines
test("TestScanLines", () => {
  const cases: Array<{ name: string; input: string; startLine: number; maxLines: number; wantLines: string[] | null; wantTotal: number }> = [
    { name: "full file", input: "line1\nline2\nline3\n", startLine: 1, maxLines: 100, wantLines: ["line1", "line2", "line3", ""], wantTotal: 4 },
    { name: "no trailing newline", input: "line1\nline2", startLine: 1, maxLines: 100, wantLines: ["line1", "line2"], wantTotal: 2 },
    { name: "start from line 2", input: "a\nb\nc\n", startLine: 2, maxLines: 100, wantLines: ["b", "c", ""], wantTotal: 4 },
    { name: "limit lines", input: "a\nb\nc\nd\n", startLine: 1, maxLines: 2, wantLines: ["a", "b"], wantTotal: 5 },
    { name: "start beyond end", input: "a\nb\n", startLine: 10, maxLines: 100, wantLines: null, wantTotal: 3 },
    { name: "empty input", input: "", startLine: 1, maxLines: 100, wantLines: null, wantTotal: 0 },
    { name: "crlf line endings", input: "line1\r\nline2\r\n", startLine: 1, maxLines: 100, wantLines: ["line1", "line2", ""], wantTotal: 3 },
  ];
  for (const tc of cases) {
    const { lines, total } = scanLines(tc.input, tc.startLine, tc.maxLines);
    expect(total).toBe(tc.wantTotal);
    if (tc.wantLines === null) {
      expect(lines.length).toBe(0);
    } else {
      expect(lines).toEqual(tc.wantLines);
    }
  }
});

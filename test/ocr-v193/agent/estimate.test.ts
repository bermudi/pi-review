// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/estimate_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import {
  promptOverheadTokens,
  avgMainRoundsPerFile,
  avgOutputTokensPerRound,
  estimateDiffCost,
  estimateDiffFileTokens,
  humanTokens,
  estimateToString,
} from "../../../src/ocr-v193/agent/estimate.js";
import type { Diff } from "../../../src/ocr-v193/model/diff.js";
import { createDiff } from "../../../src/ocr-v193/model/diff.js";

describe("ocr-v193 agent estimate (ported from internal/agent/estimate_test.go)", () => {
  // OCR v1.9.3: TestHumanTokens
  test("TestHumanTokens", () => {
    const cases = new Map<number, string>([
      [0, "0"],
      [420, "420"],
      [999, "999"],
      [1000, "1K"],
      [1500, "2K"],
      [850000, "850K"],
      [1000000, "1.0M"],
      [2400000, "2.4M"],
    ]);
    for (const [input, want] of cases) {
      const got = humanTokens(input);
      expect(got).toBe(want);
    }
  });

  // OCR v1.9.3: TestEstimateDiffFileTokens_ZeroForSkipped
  test("TestEstimateDiffFileTokens_ZeroForSkipped", () => {
    expect(estimateDiffFileTokens(createDiff({ isDeleted: true, diff: "+x" }))).toBe(0);
    expect(estimateDiffFileTokens(createDiff({ newPath: "a.go", diff: "" }))).toBe(0);
    const got = estimateDiffFileTokens(createDiff({ newPath: "a.go", diff: "+package main\nfunc f() {}\n" }));
    expect(got).toBeGreaterThan(0);
    const minExpected = promptOverheadTokens * (1 + avgMainRoundsPerFile) + 400 + avgOutputTokensPerRound * avgMainRoundsPerFile;
    expect(got).toBeGreaterThanOrEqual(minExpected);
  });

  // OCR v1.9.3: TestEstimateDiffCost
  test("TestEstimateDiffCost", () => {
    const diffs: Diff[] = [
      createDiff({ newPath: "a.go", diff: "+a\n" }),
      createDiff({ newPath: "b.go", diff: "+b\n" }),
      createDiff({ newPath: "c.go", isDeleted: true, diff: "+c\n" }),
      createDiff({ newPath: "d.go", diff: "" }),
    ];
    const est = estimateDiffCost(diffs);
    expect(est.files).toBe(2);
    const perFile = estimateDiffFileTokens(diffs[0]!);
    expect(est.totalTokens).toBe(perFile * 2);
    expect(est.inputTokens).toBeGreaterThan(0);
    expect(est.outputTokens).toBeGreaterThan(0);
    expect(est.totalTokens).toBe(est.inputTokens + est.outputTokens);
    const s = estimateToString(est);
    expect(s.length).toBeGreaterThan(0);
    expect(s.includes("token")).toBe(true);
  });

  // OCR v1.9.3: TestEstimateDiffCost_ScalesWithContent
  test("TestEstimateDiffCost_ScalesWithContent", () => {
    const small = estimateDiffFileTokens(createDiff({ newPath: "a.go", diff: "+x\n" }));
    const large = estimateDiffFileTokens(createDiff({ newPath: "a.go", diff: "line of code\n".repeat(200) }));
    expect(large).toBeGreaterThan(small);
  });
});

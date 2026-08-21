// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/session_display_more_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import {
  displayMode,
  describeRange,
  describeStart,
  describeFiles,
  completeEnum,
} from "../../../src/ocr-v193/cli/session.js";
import type { Summary } from "../../../src/ocr-v193/session/resume.js";

// OCR v1.9.3: TestDisplayMode
test("displayMode empty and non-empty branches", () => {
  expect(displayMode("")).toBe("-");
  expect(displayMode("range")).toBe("range");
});

// OCR v1.9.3: TestDescribeRange
test("describeRange covers each review-mode branch", () => {
  const cases: Array<{ name: string; summary: Summary; want: string }> = [
    {
      name: "range with endpoints",
      summary: { reviewMode: "range", diffFrom: "a", diffTo: "b" } as unknown as Summary,
      want: "a..b",
    },
    {
      name: "range without endpoints",
      summary: { reviewMode: "range" } as unknown as Summary,
      want: "-",
    },
    {
      name: "commit",
      summary: { reviewMode: "commit", diffCommit: "abc123" } as unknown as Summary,
      want: "abc123",
    },
    {
      name: "commit without value",
      summary: { reviewMode: "commit" } as unknown as Summary,
      want: "-",
    },
    {
      name: "other mode",
      summary: {} as Summary,
      want: "-",
    },
  ];
  for (const tc of cases) {
    const got = describeRange(tc.summary as unknown as Record<string, unknown> & Summary);
    expect(got, tc.name).toBe(tc.want);
  }
});

// OCR v1.9.3: TestDescribeStart
test("describeStart zero and formatted branches", () => {
  expect(describeStart({} as Summary as unknown as Record<string, unknown> & Summary)).toBe("-");
  const s = { startTime: new Date(2024, 0, 1, 12, 0, 0) } as unknown as Summary;
  const got = describeStart(s as unknown as Record<string, unknown> & Summary);
  expect(got).not.toBe("-");
});

// OCR v1.9.3: TestDescribeFilesNoManifest
test("describeFiles no manifest", () => {
  const s1 = { completedFiles: 3 } as unknown as Summary;
  expect(describeFiles(s1 as unknown as Record<string, unknown> & Summary)).toBe("3");
  const s2 = { completedFiles: 3, reusedFiles: 2 } as unknown as Summary;
  expect(describeFiles(s2 as unknown as Record<string, unknown> & Summary)).toBe("5 (reused 2)");
});

// OCR v1.9.3: TestCompleteEnum
test("completeEnum closure returns values with directive", () => {
  const fn = completeEnum("a", "b", "c");
  const [values, directive] = fn(null, null, "");
  expect(values).toEqual(["a", "b", "c"]);
  expect(directive).not.toBe(0);
});

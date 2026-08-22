// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/flag_suggest_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import { levenshtein, suggestFlag, flagErrorWithSuggestion } from "../../../src/ocr-v193/cli/flag-suggest.js";

// OCR v1.9.3: TestLevenshtein
test("levenshtein distances match OCR table", () => {
  const cases: Array<{ a: string; b: string; want: number }> = [
    { a: "", b: "", want: 0 },
    { a: "", b: "abc", want: 3 },
    { a: "abc", b: "", want: 3 },
    { a: "abc", b: "abc", want: 0 },
    { a: "format", b: "forma", want: 1 },
    { a: "model", b: "modle", want: 2 },
    { a: "kitten", b: "sitting", want: 3 },
  ];
  for (const c of cases) {
    const got = levenshtein(c.a, c.b);
    expect(got, `levenshtein(${JSON.stringify(c.a)},${JSON.stringify(c.b)})`).toBe(c.want);
  }
});

// OCR v1.9.3: TestSuggestFlag
test("suggestFlag finds close matches on local and inherited", () => {
  const available = ["repo", "format", "model", "from", "to", "concurrency"];
  // close match on local flag
  const m1 = suggestFlag(["format", "model"], "forma");
  expect(m1).toContain("--format");
  // close match on inherited (repo)
  const m2 = suggestFlag(available, "rep");
  expect(m2).toContain("--repo");
  // no close match
  expect(suggestFlag(available, "zzzzzzzz")).toBe("");
  // empty after trimming dashes
  expect(suggestFlag(available, "--")).toBe("");
});

// OCR v1.9.3: TestFlagErrorWithSuggestion
test("flagErrorWithSuggestion appends Did you mean or leaves original", () => {
  const available = ["format"];
  const mk = (msg: string) => new Error(msg);
  // unknown flag yields suggestion
  {
    const out = flagErrorWithSuggestion(available, mk("unknown flag: --forma"));
    expect(out.message).toContain("Did you mean");
  }
  // unknown flag with no close match returns original message unchanged
  {
    const inn = mk("unknown flag: --zzzzzzzz");
    const out = flagErrorWithSuggestion(available, inn);
    expect(out.message).toBe(inn.message);
  }
  // non-flag error returned unchanged (object identity not required but message unchanged)
  {
    const inn = mk("some other error");
    const out = flagErrorWithSuggestion(available, inn);
    expect(out.message).toBe(inn.message);
  }
  // dashes-only unknown returned unchanged
  {
    const inn = mk("unknown flag: ---");
    const out = flagErrorWithSuggestion(available, inn);
    expect(out.message).toBe(inn.message);
  }
});

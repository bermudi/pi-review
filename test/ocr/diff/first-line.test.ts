// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/first_line_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { expect, test } from "bun:test";
import { firstLine } from "../../../src/ocr/diff/git.js";

// OCR v1.9.3: TestFirstLine
test("TestFirstLine", () => {
  const cases = [
    { name: "single line with trailing newline", input: "abc123\n", want: "abc123" },
    { name: "trims surrounding whitespace", input: "  deadbeef  \n", want: "deadbeef" },
    { name: "skips leading blank lines", input: "\n\n  sha\n", want: "sha" },
    { name: "empty input", input: "", want: "" },
    { name: "only whitespace and newlines", input: "\n   \n\t\n", want: "" },
  ] as const;

  for (const { name, input, want } of cases) {
    expect(firstLine(input), name).toBe(want);
  }
});

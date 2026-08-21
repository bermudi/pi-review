// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/output_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { buildBadge, severityColor, renderComment, sanitizeTerminal } from "../../../src/ocr-v193/cli/output.js";
import type { LlmComment } from "../../../src/ocr-v193/model/review.js";

// OCR v1.9.3: TestBuildBadge
test("buildBadge categorization", () => {
  expect(buildBadge({ path: "a.go", content: "", category: "security", severity: "high" })).toBe("[security · high]");
  expect(buildBadge({ path: "a.go", content: "", category: "bug" })).toBe("[bug]");
  expect(buildBadge({ path: "a.go", content: "", severity: "low" })).toBe("[low]");
  expect(buildBadge({ path: "a.go", content: "" })).toBe("");
  // strips control chars (ESC)
  expect(buildBadge({ path: "a.go", content: "", category: "bug\x1b[0m", severity: "high" })).toBe("[bug[0m · high]");
});

// OCR v1.9.3: TestSeverityColor
test("severityColor distinct mapping", () => {
  const seen = new Map<string, string>();
  for (const sev of ["critical", "high", "medium", "low"] as const) {
    const c = severityColor(sev);
    expect(c).not.toBe("");
    const prev = seen.get(c);
    expect(prev, `color collision for ${sev} with ${prev}`).toBeUndefined();
    seen.set(c, sev);
  }
  expect(severityColor("bogus")).toBe("\u001b[2m");
  expect(severityColor("")).toBe("\u001b[2m");
  expect(severityColor(undefined)).toBe("\u001b[2m");
});

// OCR v1.9.3: TestRenderComment_BadgeInline
test("renderComment badge inline colorization", () => {
  const out = renderComment({
    path: "internal/mcp/client.go",
    startLine: 27,
    endLine: 27,
    content: "Potential environment variable leak.",
    category: "security",
    severity: "high",
  });
  expect(out).toContain("[security · high]");
  expect(out).toContain("\u001b[91m[security · high]\u001b[0m");
  expect(out).toContain("Potential environment variable leak.");
});

// OCR v1.9.3: TestSanitizeTerminal
test("sanitizeTerminal strips controls and preserves unicode", () => {
  expect(sanitizeTerminal("hello world")).toBe("hello world");
  expect(sanitizeTerminal("col1\tcol2")).toBe("col1\tcol2");
  expect(sanitizeTerminal("line1\nline2")).toBe("line1\nline2");
  expect(sanitizeTerminal("before\x1b[2Jafter")).toBe("before[2Jafter");
  expect(sanitizeTerminal("\x1b]52;c;dGVzdA==\x07")).toBe("]52;c;dGVzdA==");
  expect(sanitizeTerminal("beep\x07done")).toBe("beepdone");
  expect(sanitizeTerminal("a\x00b")).toBe("ab");
  expect(sanitizeTerminal("a\x7fb")).toBe("ab");
  expect(sanitizeTerminal("fake\rreal")).toBe("fakereal");
  expect(sanitizeTerminal("")).toBe("");
  expect(sanitizeTerminal("\x1b\x07\x00\x7f")).toBe("");
  expect(sanitizeTerminal("代码审查 レビュー 🔍")).toBe("代码审查 レビュー 🔍");
  expect(sanitizeTerminal("path\x1b[0m/file.go")).toBe("path[0m/file.go");
  expect(sanitizeTerminal("before\u009bafter")).toBe("beforeafter");
  expect(sanitizeTerminal("before\u009dafter")).toBe("beforeafter");
});

// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/output_color_test.go at OCR v1.9.9
// 4b6874bd23106b5c68bea6d230bb60303b9f0961.

import { expect, test } from "bun:test";
import { outputPreviewText, printDiffLine, renderComment, statusBadge } from "../../../src/ocr/cli/output.js";
import type { Preview } from "../../../src/ocr/model/preview.js";

const preview: Preview = {
  totalFiles: 2, totalInsertions: 10, totalDeletions: 3, reviewableCount: 1, excludedCount: 1,
  entries: [
    { path: "cmd/main.go", status: "modified", insertions: 10, deletions: 3, willReview: true },
    { path: "go.sum", status: "modified", insertions: 0, deletions: 0, willReview: false, excludeReason: "excluded_pattern" as never },
  ],
};
const comment = { path: "internal/mcp/client.go", startLine: 27, endLine: 28, content: "Potential environment variable leak.", category: "security", severity: "high", existingCode: "old := 1\n", suggestionCode: "new := 1\n" };

// OCR v1.9.9: TestRenderComment_NoColorIsPlain
test("TestRenderComment_NoColorIsPlain", () => {
  const out = renderComment(comment, false);
  expect(out).not.toContain("\u001b");
  for (const text of ["internal/mcp/client.go:27-28", "[security · high]", "+ new := 1", "- old := 1"]) expect(out).toContain(text);
});
// OCR v1.9.9: TestRenderComment_ColorEmitsEscapes
test("TestRenderComment_ColorEmitsEscapes", () => expect(renderComment(comment, true)).toContain("\u001b[2m─── internal/mcp/client.go:27-28 ───\u001b[0m"));
// OCR v1.9.9: TestPrintDiffLine_NoColor
test("TestPrintDiffLine_NoColor", () => {
  expect(printDiffLine("+", "added line", "\u001b[92m", "\u001b[48;2;0;60;0m", false)).toBe("+ added line\n");
  expect(printDiffLine("-", "removed line", "\u001b[91m", "\u001b[48;2;70;0;0m", false)).toBe("- removed line\n");
});
// OCR v1.9.9: TestStatusBadge_NoColor
test("TestStatusBadge_NoColor", () => expect(statusBadge("added", false)).toBe("[A]"));
// OCR v1.9.9: TestStatusBadge_Color
test("TestStatusBadge_Color", () => {
  expect(statusBadge("added", true)).toBe("\u001b[32m[A]\u001b[0m");
  expect(statusBadge("unknown", true)).toBe("[?]");
});
// OCR v1.9.9: TestOutputPreviewText_NoColorIsPlain
test("TestOutputPreviewText_NoColorIsPlain", () => {
  const out = outputPreviewText(preview, false);
  expect(out).not.toContain("\u001b");
  expect(out).toContain("Preview: 2 file(s) changed  |  +10  -3");
});
// OCR v1.9.9: TestOutputPreviewText_ColumnsAlign
test("TestOutputPreviewText_ColumnsAlign", () => {
  const p: Preview = { ...preview, reviewableCount: 2, excludedCount: 0, entries: [
    { path: "a.go", status: "added", insertions: 1, deletions: 2, willReview: true },
    { path: "b.go", status: "modified", insertions: 1000, deletions: 2000, willReview: true },
  ] };
  const columns = outputPreviewText(p, false).split("\n").filter((line) => line.includes(".go")).map((line) => line.indexOf("+"));
  expect(columns).toHaveLength(2);
  expect(columns[0]).toBe(columns[1]);
});
// OCR v1.9.9: TestOutputPreviewText_ColorEmitsEscapes
test("TestOutputPreviewText_ColorEmitsEscapes", () => {
  const out = outputPreviewText(preview, true);
  expect(out).toContain("\u001b[32m+10\u001b[0m");
  expect(out).toContain("\u001b[1mWill review (1):\u001b[0m");
});

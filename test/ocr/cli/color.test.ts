// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/color_test.go at OCR v1.9.9
// 4b6874bd23106b5c68bea6d230bb60303b9f0961.

import { expect, test } from "bun:test";
import { colorize, resolveColor, validateColorMode } from "../../../src/ocr/cli/color.js";
import { parseReviewFlags, runCli } from "../../../src/ocr/cli/index.js";
import type { Preview } from "../../../src/ocr/model/preview.js";

const preview: Preview = {
  entries: [{ path: "main.go", status: "modified", insertions: 1, deletions: 0, willReview: true }],
  totalInsertions: 1,
  totalDeletions: 0,
  totalFiles: 1,
  reviewableCount: 1,
  excludedCount: 0,
};

function capture(): { stdout: string; stderr: string; io: { stdout: (text: string) => void; stderr: (text: string) => void; stdoutIsTTY: () => boolean } } {
  let stdout = "";
  let stderr = "";
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, stdoutIsTTY: () => true },
  };
}

// OCR v1.9.9: TestValidateColorMode
test("TestValidateColorMode", () => {
  for (const mode of ["auto", "always", "never"]) expect(validateColorMode(mode)).toBe(true);
  for (const mode of ["yes", "no", "", "Auto", "1"]) expect(validateColorMode(mode)).toBe(false);
});

// OCR v1.9.9: TestResolveColor
test("TestResolveColor", () => {
  expect(resolveColor("auto", undefined, false)).toBe(false);
  expect(resolveColor("never", "xterm-256color", true)).toBe(false);
  expect(resolveColor("always", "dumb", false)).toBe(true);
  expect(resolveColor("auto", "dumb", true)).toBe(false);
  expect(resolveColor("auto", "DUMB", true)).toBe(false);
  expect(resolveColor("auto", "xterm-256color", false)).toBe(false);
  expect(resolveColor("auto", "xterm-256color", true)).toBe(true);
});

// OCR v1.9.9: TestColorize
test("TestColorize", () => {
  expect(colorize(true, "\u001b[31m", "boom")).toBe("\u001b[31mboom\u001b[0m");
  expect(colorize(false, "\u001b[31m", "boom")).toBe("boom");
});

// OCR v1.9.9: TestAddColorFlags
test("TestAddColorFlags", () => {
  expect(parseReviewFlags(["--color", "always"]).color).toBe("always");
  expect(() => parseReviewFlags(["--color", "sometimes"])).toThrow('invalid --color value "sometimes"');
});

// OCR v1.9.9: TestColorFlagsThroughRootCmd
test("TestColorFlagsThroughRootCmd", async () => {
  for (const args of [
    ["--color=never", "version"],
    ["--color", "always", "version"],
    ["version", "--color=never"],
    ["version", "--color", "always"],
    ["version", "--color=always"],
  ]) {
    let stdout = "";
    const code = await runCli(args, { io: { stdout: (text) => { stdout += text; }, stderr: () => {}, stdoutIsTTY: () => false } });
    expect(code).toBe(0);
    expect(stdout).toContain("pi-review");
    expect(stdout).not.toContain("\u001b");
  }
  let stderr = "";
  expect(await runCli(["version", "--color=sometimes"], { io: { stdout: () => {}, stderr: (text) => { stderr += text; } } })).toBe(1);
  expect(stderr).toContain('invalid --color value "sometimes"');
});

test("persistent color errors are shared by every command", async () => {
  for (const args of [
    ["review", "--color=sometimes"],
    ["scan", "--color", "sometimes"],
    ["review", "--color"],
    ["scan", "--color=always", "--color=never"],
  ]) {
    const output = capture();
    expect(await runCli(args, { io: output.io })).toBe(1);
    expect(output.stderr).toContain("auto, always, never");
  }
});

test("real review and scan preview rendering receives persistent color", async () => {
  for (const command of ["review", "scan"] as const) {
    const output = capture();
    const code = await runCli([command, "--repo", process.cwd(), "--preview", "--color=always"], {
      io: output.io,
      reviewPreviewFactory: async () => preview,
      scanPreviewFactory: async () => preview,
    });
    expect(code).toBe(0);
    expect(output.stdout).toContain("\u001b[32m+1\u001b[0m");
  }
});

test("machine output never carries ANSI", async () => {
  for (const format of ["json", "sarif"] as const) {
    const output = capture();
    const code = await runCli(["review", "--repo", process.cwd(), "--format", format, "--color=always"], {
      io: output.io,
      reviewRunnerFactory: async () => ({
        run: async () => [{ path: "main.go", startLine: 1, endLine: 1, content: "finding", category: "bug", severity: "high" }],
        manifest: null,
        warnings: [],
        filesReviewed: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCalls: {},
        sessionId: "",
        budgetExceeded: false,
        projectSummary: "",
        resumeInfo: undefined,
        diffs: [],
      }),
    });
    expect(code).toBe(0);
    expect(output.stdout).not.toContain("\u001b");
  }
});

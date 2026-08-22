// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/color_test.go at OCR v1.9.9
// 4b6874bd23106b5c68bea6d230bb60303b9f0961.

import { expect, test } from "bun:test";
import { colorize, resolveColor, validateColorMode } from "../../../src/ocr/cli/color.js";
import { parseReviewFlags, runCli } from "../../../src/ocr/cli/index.js";

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
    ["version", "--color=never"],
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

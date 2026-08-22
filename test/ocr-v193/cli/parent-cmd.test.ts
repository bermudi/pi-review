// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/parent_cmd_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import { runCli, HELP_TEXT } from "../../../src/ocr-v193/cli/index.js";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (s: string) => { stdout += s; },
      stderr: (s: string) => { stderr += s; },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

// OCR v1.9.3: TestParentCommands_UnknownSubcommand
test("unknown subcommand returns non-zero with unknown command", async () => {
  const cases: string[][] = [
    ["bogus"],
    ["unknown", "sub"],
    ["reviewBogus"],
  ];
  for (const args of cases) {
    const cap = capture();
    const code = await runCli(args as unknown as string[], { io: cap.io });
    expect(code).toBe(1);
    expect(cap.stderr).toContain("unknown command");
  }
});

// OCR v1.9.3: TestParentCommands_KnownSubcommandStillWorks
test("known subcommand --help still works", async () => {
  const cases: string[][] = [
    ["review", "--help"],
    ["scan", "--help"],
  ];
  for (const args of cases) {
    const cap = capture();
    const code = await runCli(args as unknown as string[], { io: cap.io });
    expect(code).toBe(0);
    expect(cap.stdout).toContain("pi-review");
  }
});

// OCR v1.9.3: TestParentCommands_NoArgsPrintsHelp
test("no args prints help and exits 0", async () => {
  const cap = capture();
  const code = await runCli([], { io: cap.io });
  expect(code).toBe(0);
  expect(cap.stdout.length).toBeGreaterThan(0);
  expect(cap.stdout).toContain("Usage:");
  expect(cap.stdout).toBe(HELP_TEXT);
});

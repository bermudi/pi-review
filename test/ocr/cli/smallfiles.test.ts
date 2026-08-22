// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/smallfiles_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import { formatVersion, HELP_TEXT } from "../../../src/ocr/cli/index.js";

// OCR v1.9.3: TestPrintVersion_Dev
test("versionString dev contains base name and arch", () => {
  const got = formatVersion({
    version: "dev",
    ocrVersion: "v1.9.3",
    commit: "",
    date: "",
    platform: process.platform,
    arch: process.arch,
  });
  expect(got).toContain("pi-review dev");
  expect(got).toContain(`${process.platform}/${process.arch}`);
  expect(got).toContain("OCR compatibility: v1.9.3");
});

// OCR v1.9.3: TestPrintVersion_WithCommitAndDate
test("versionString with commit and date contains all parts", () => {
  const got = formatVersion({
    version: "1.2.3",
    ocrVersion: "v1.9.9",
    commit: "abc1234",
    date: "2026-01-01",
    platform: "linux",
    arch: "amd64",
  });
  expect(got).toContain("1.2.3");
  expect(got).toContain("OCR compatibility: v1.9.9");
  expect(got).toContain("abc1234");
  expect(got).toContain("2026-01-01");
  expect(got).toContain("linux/amd64");
});

// OCR v1.9.3: TestRootCmd_Help
test("help text contains usage banner", async () => {
  expect(HELP_TEXT).toContain("pi-review");
  // also via runCli boundary
  const { runCli } = await import("../../../src/ocr/cli/index.js");
  let out = "";
  const code = await runCli(["--help"], { io: { stdout: (s: string) => { out += s; } } });
  expect(code).toBe(0);
  expect(out).toContain("Usage:");
});

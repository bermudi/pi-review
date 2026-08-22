// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/smallfiles_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import { versionString, HELP_TEXT, __setVersionForTest, VERSION, GIT_COMMIT, BUILD_DATE } from "../../../src/ocr-v193/cli/index.js";

// OCR v1.9.3: TestPrintVersion_Dev
test("versionString dev contains base name and arch", () => {
  const origVersion = VERSION;
  const origCommit = GIT_COMMIT;
  const origDate = BUILD_DATE;
  try {
    __setVersionForTest("dev", "", "");
    const got = versionString();
    expect(got).toContain("pi-review dev");
    expect(got).toContain(`${process.platform}/${process.arch}`);
  } finally {
    __setVersionForTest(origVersion, origCommit, origDate);
  }
});

// OCR v1.9.3: TestPrintVersion_WithCommitAndDate
test("versionString with commit and date contains all parts", () => {
  const origVersion = VERSION;
  const origCommit = GIT_COMMIT;
  const origDate = BUILD_DATE;
  try {
    __setVersionForTest("1.2.3", "abc1234", "2026-01-01");
    const got = versionString();
    expect(got).toContain("1.2.3");
    expect(got).toContain("abc1234");
    expect(got).toContain("2026-01-01");
  } finally {
    __setVersionForTest(origVersion, origCommit, origDate);
  }
});

// OCR v1.9.3: TestRootCmd_Help
test("help text contains usage banner", async () => {
  expect(HELP_TEXT).toContain("pi-review");
  // also via runCli boundary
  const { runCli } = await import("../../../src/ocr-v193/cli/index.js");
  let out = "";
  const code = await runCli(["--help"], { io: { stdout: (s: string) => { out += s; } } });
  expect(code).toBe(0);
  expect(out).toContain("Usage:");
});

// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/zero_args_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import { runCli } from "../../../src/ocr-v193/cli/index.js";

// OCR v1.9.3: TestZeroArgumentCommands_RejectUnexpectedArgs
test("version rejects unexpected positional argument", async () => {
  let stderr = "";
  const code = await runCli(["version", "unexpected"], {
    io: { stderr: (s: string) => { stderr += s; } },
  });
  expect(code).toBe(1);
  expect(stderr).toContain('unknown command "unexpected" for "pi-review version"');
  // also ensure correct command still works
  let stdout = "";
  const code2 = await runCli(["version"], { io: { stdout: (s: string) => { stdout += s; } } });
  expect(code2).toBe(0);
  expect(stdout).toContain("pi-review");
});

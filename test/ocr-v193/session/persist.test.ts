// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/persist_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.
import { describe, expect, test } from "bun:test";
import { SessionHistory } from "../../../src/ocr-v193/session/history.ts";
import { encodeRepoPath } from "../../../src/ocr-v193/session/persist.ts";

describe("ocr-v193 session persist", () => {
  // OCR v1.9.3: TestEncodeRepoPath
  test("encodeRepoPath handles empty, relative and platform paths", () => {
    type Case = { name: string; input: string; expected: string };
    const cases: Case[] = [
      { name: "empty string", input: "", expected: "empty" },
      { name: "relative path", input: "relative/path/to/repo", expected: "relative-path-to-repo" },
      { name: "path with mixed separators", input: "path/to\\mixed", expected: "path-to-mixed" },
    ];

    // Platform-specific — this JS process is linux, so add unix cases (mirrors Go runtime.GOOS check)
    if (process.platform === "win32") {
      cases.push(
        { name: "windows drive path", input: "D:\\Users\\admin\\project", expected: "D_Users-admin-project" },
        { name: "windows C drive", input: "C:\\code\\myapp", expected: "C_code-myapp" },
        { name: "windows relative path", input: "relative\\path\\to\\repo", expected: "relative-path-to-repo" },
        { name: "windows drive only", input: "C:", expected: "C_" },
        { name: "windows drive with separator only", input: "D:\\", expected: "D_" },
      );
    } else {
      cases.push(
        { name: "unix absolute path", input: "/home/user/project", expected: "home-user-project" },
        { name: "unix nested path", input: "/Users/john/dev/myapp", expected: "Users-john-dev-myapp" },
        { name: "unix root only", input: "/", expected: "empty" },
      );
    }

    for (const tc of cases) {
      const got = encodeRepoPath(tc.input);
      expect(got, `${tc.name}: encodeRepoPath(${JSON.stringify(tc.input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(tc.expected)}`).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestSetErrorIncrementsCounter
  test("SetError increments LLMFailures counter", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    const fs = sh.GetOrCreateFileSession("test.go");
    const rec1 = fs.AppendTaskRecord("main_task", []);
    rec1.SetError(new Error("timeout"), 1000);
    expect(sh.LLMFailures()).toBe(1);
    const rec2 = fs.AppendTaskRecord("plan_task", []);
    rec2.SetError(new Error("rate limit"), 2000);
    expect(sh.LLMFailures()).toBe(2);
  });
});

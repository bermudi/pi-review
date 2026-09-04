// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Isolated adoption from OCR 0c44f10 + 4cecf1e: git failures surface git's own
// message (stderr tail) instead of empty results.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Provider, gitFailure, GIT_DIAG_LIMIT } from "../../../src/ocr/diff/git.js";
import { Runner } from "../../../src/ocr/diff/runner.js";

test("gitFailure includes stderr tail and preserves cause", () => {
  const orig = new Error("exit 128");
  const err = gitFailure("git diff", "fatal: not a git repository", orig);
  expect(err.message).toContain("git diff failed");
  expect(err.message).toContain("fatal: not a git repository");
  expect((err as Error & { cause?: unknown }).cause).toBe(orig);
});

test("gitFailure without stderr falls back to op + message", () => {
  const err = gitFailure("git ls-files", "   ", new Error("boom"));
  expect(err.message).toBe("git ls-files failed: boom");
});

test("gitFailure caps tail rune-safely", () => {
  const long = `x`.repeat(GIT_DIAG_LIMIT + 100);
  const err = gitFailure("git show", long, new Error("exit 128"));
  expect(err.message.startsWith("git show failed")).toBe(true);
  expect(err.message.endsWith(long.slice(-GIT_DIAG_LIMIT))).toBe(true);
  expect(err.message).toContain("...");
  // Emoji (surrogate pair) must not split.
  const emojiTail = `😀`.repeat(GIT_DIAG_LIMIT + 10);
  const err2 = gitFailure("git diff", emojiTail, new Error("exit 128"));
  expect([...err2.message].length).toBeLessThan([...emojiTail].length + 50);
});

test("untracked listing errors propagate instead of empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notrepo-"));
  try {
    // Plain directory, not a git repo: workspace diff fails fast with git's own message.
    const provider = Provider.forWorkspace(dir, new Runner(1));
    let err: unknown = null;
    try {
      await provider.getDiff();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toMatch(/workspace tracked diff failed|git ls-files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("untracked ls-files failure propagates with op name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsfiles-"));
  try {
    // Fake runner: tracked diff succeeds empty, ls-files fails.
    const fake = {
      async runSplit(_repoDir: string, args: string[]) {
        if (args.includes("ls-files")) {
          const err = new Error("git ls-files failed with exit 128") as Error & { stderr: string };
          (err as unknown as Record<string, unknown>)["stderr"] = "fatal: not a git repository";
          throw err;
        }
        return { stdout: "", stderr: "" };
      },
      async run() {
        return "";
      },
    };
    const provider = Provider.forWorkspace(dir, fake as unknown as Runner);
    let err: unknown = null;
    try {
      await provider.getDiff();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toContain("git ls-files");
    expect(String((err as Error).message)).toContain("fatal: not a git repository");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("commit diff surfaces git show stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notrepo2-"));
  try {
    const provider = Provider.forCommit(dir, "deadbeef", new Runner(1));
    let err: unknown = null;
    try {
      await provider.getDiff();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toContain("git show failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

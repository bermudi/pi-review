// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/git_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  runGitCmd,
  getCommitMessage,
  resolveRepoDir,
  requireGitRepo,
  validateReviewRefs,
  buildToolRegistry,
} from "../../../src/ocr-v193/cli/git.js";

function initTestGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-"));
  const cmds: Array<readonly string[]> = [
    ["git", "-C", dir, "init", "-q"],
    ["git", "-C", dir, "config", "user.email", "test@test.com"],
    ["git", "-C", dir, "config", "user.name", "Test"],
  ];
  for (const args of cmds) {
    const cmd = spawnSync(args[0] as string, args.slice(1), { encoding: "utf8" });
    if (cmd.status !== 0) {
      throw new Error(`git init setup failed: ${String(cmd.stderr)}`);
    }
  }
  const f = path.join(dir, "README.md");
  fs.writeFileSync(f, "hello");
  let r = spawnSync("git", ["-C", dir, "add", "--", "."], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git add failed: ${String(r.stderr)}`);
  r = spawnSync("git", ["-C", dir, "commit", "-q", "-m", "initial commit"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git commit failed: ${String(r.stderr)} \n${String(r.stdout)}`);
  return dir;
}

// OCR v1.9.3: TestRunGitCmd_Success
test("runGitCmd succeeds in git repo with non-empty output", () => {
  const dir = initTestGitRepo();
  try {
    const out = runGitCmd(dir, "rev-parse", "--git-dir");
    const text = out.toString("utf8").trim();
    expect(text.length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunGitCmd_Failure
test("runGitCmd fails in non-git directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-nongit-"));
  try {
    expect(() => runGitCmd(dir, "rev-parse", "--git-dir")).toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGetCommitMessage
test("getCommitMessage returns trimmed initial commit message", () => {
  const dir = initTestGitRepo();
  try {
    const msg = getCommitMessage(dir, "HEAD");
    expect(msg).toBe("initial commit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGetCommitMessage_InvalidCommit
test("getCommitMessage throws for invalid commit", () => {
  const dir = initTestGitRepo();
  try {
    expect(() => getCommitMessage(dir, "nonexistent-ref-xyz")).toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveRepoDir_ValidGitRepo
test("resolveRepoDir succeeds for valid git repo", () => {
  const dir = initTestGitRepo();
  try {
    const resolved = resolveRepoDir(dir);
    expect(resolved.length).toBeGreaterThan(0);
    expect(fs.existsSync(resolved)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveRepoDir_NotGitRepo
test("resolveRepoDir fails for non-git directory with not a git repository", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-nongit2-"));
  try {
    expect(() => resolveRepoDir(dir)).toThrow();
    try {
      resolveRepoDir(dir);
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("not a git repository");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveRepoDir_EmptyUsesWd
test("resolveRepoDir empty uses cwd", () => {
  const dir = initTestGitRepo();
  const orig = process.cwd();
  try {
    process.chdir(dir);
    const resolved = resolveRepoDir("");
    expect(resolved.length).toBeGreaterThan(0);
    expect(fs.existsSync(resolved)).toBe(true);
  } finally {
    process.chdir(orig);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRequireGitRepo_Valid
test("requireGitRepo succeeds for valid git repo", () => {
  const dir = initTestGitRepo();
  try {
    expect(() => requireGitRepo(dir)).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRequireGitRepo_Invalid
test("requireGitRepo fails for non-git directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-git-nongit3-"));
  try {
    expect(() => requireGitRepo(dir)).toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestValidateReviewRefs_ValidCommit
test("validateReviewRefs succeeds for valid commit HEAD", () => {
  const dir = initTestGitRepo();
  try {
    expect(() => validateReviewRefs(dir, { commit: "HEAD" } as never)).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestValidateReviewRefs_InvalidCommit
test("validateReviewRefs fails for invalid commit ref", () => {
  const dir = initTestGitRepo();
  try {
    expect(() => validateReviewRefs(dir, { commit: "nonexistent-ref-xyz" } as never)).toThrow();
    try {
      validateReviewRefs(dir, { commit: "nonexistent-ref-xyz" } as never);
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("is not a valid commit ref");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestValidateReviewRefs_EmptySkipped
test("validateReviewRefs skips empty refs", () => {
  const dir = initTestGitRepo();
  try {
    expect(() => validateReviewRefs(dir, {} as never)).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestBuildToolRegistry
test("buildToolRegistry returns non-nil registry", () => {
  const reg = buildToolRegistry(null, null);
  expect(reg).not.toBeNull();
  expect(reg).toBeDefined();
  // Registry should be usable: has Register/Get semantics via tool lookup
  // At minimum it should have providers (non-empty internal map). Check via tool lookup.
  // Use the registry's ability to list or get a known tool.
  // The Registry class stores providers; we can verify by checking that a known tool is not found before and after.
  // Simpler: check that registry is instance of Registry and has expected method.
  expect(typeof (reg as unknown as Record<string, unknown>)["Register"]).toBe("function");
});

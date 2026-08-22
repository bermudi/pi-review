// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/shared_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  resolveMaxTokens,
  applyCLIExcludes,
  newQuietHandle,
  QuietHandle,
  resolveWorkingDir,
  isMachineReadable,
} from "../../../src/ocr/cli/shared.js";

// OCR v1.9.3: TestResolveMaxTokensPrecedence
test("resolveMaxTokens precedence", () => {
  expect(resolveMaxTokens(58888, null, 0)).toBe(58888);
  expect(resolveMaxTokens(58888, {}, 0)).toBe(58888);
  expect(resolveMaxTokens(58888, { MaxTokens: 128000 }, 0)).toBe(128000);
  expect(resolveMaxTokens(58888, { MaxTokens: 128000 }, 200000)).toBe(200000);
  expect(() => resolveMaxTokens(58888, { MaxTokens: -1 }, 0)).toThrow();
  expect(() => resolveMaxTokens(58888, null, -1)).toThrow();
});

// OCR v1.9.3: TestApplyCLIExcludes_Empty
test("applyCLIExcludes empty no-op", () => {
  const cc: { FileFilter: { exclude: string[] } | null } = { FileFilter: { exclude: ["a"] } };
  applyCLIExcludes(cc, []);
  expect(cc.FileFilter!.exclude).toHaveLength(1);
});

// OCR v1.9.3: TestApplyCLIExcludes_AppendsPatterns
test("applyCLIExcludes appends", () => {
  const cc: { FileFilter: { exclude: string[] } | null } = { FileFilter: { exclude: ["a"] } };
  applyCLIExcludes(cc, ["b", "c"]);
  expect(cc.FileFilter!.exclude).toHaveLength(3);
});

// OCR v1.9.3: TestApplyCLIExcludes_NilFileFilter
test("applyCLIExcludes creates FileFilter when nil", () => {
  const cc: { FileFilter: { exclude: string[] } | null } = { FileFilter: null };
  applyCLIExcludes(cc, ["x"]);
  expect(cc.FileFilter).not.toBeNull();
  expect(cc.FileFilter!.exclude).toEqual(["x"]);
});

// OCR v1.9.3: TestNewQuietHandle_NoOp
test("newQuietHandle no-op for text/developer", () => {
  const h = newQuietHandle("text", "developer");
  expect(h.fn).toBeNull();
  h.Restore();
});

// OCR v1.9.3: TestNewQuietHandle_JSON
test("newQuietHandle json silences", () => {
  const h = newQuietHandle("json", "developer");
  expect(h.fn).not.toBeNull();
  h.Restore();
  expect(h.fn).toBeNull();
});

// OCR v1.9.3: TestNewQuietHandle_Agent
test("newQuietHandle agent silences text", () => {
  const h = newQuietHandle("text", "agent");
  expect(h.fn).not.toBeNull();
  h.Restore();
});

// OCR v1.9.3: TestQuietHandle_NilReceiver
test("QuietHandle nil receiver", () => {
  const h: QuietHandle | null = null;
  expect(() => (h as unknown as QuietHandle)?.Restore?.()).not.toThrow();
  // also test undefined handle via direct call on null object guard inside method
  const empty = new QuietHandle(null);
  empty.Restore();
});

// OCR v1.9.3: TestQuietHandle_IdempotentRestore
test("QuietHandle idempotent restore", () => {
  const h = newQuietHandle("json", "developer");
  h.Restore();
  h.Restore();
  expect(h.fn).toBeNull();
});

// OCR v1.9.3: TestResolveWorkingDir_CurrentDir
test("resolveWorkingDir current dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-shared-"));
  const orig = process.cwd();
  try {
    process.chdir(dir);
    const { absPath, isGit } = resolveWorkingDir("", false);
    expect(absPath.length).toBeGreaterThan(0);
    expect(isGit).toBe(false);
  } finally {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveWorkingDir_RequireGitFails
test("resolveWorkingDir requireGit fails on non-git", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-shared-"));
  try {
    expect(() => resolveWorkingDir(dir, true)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveWorkingDir_NonExistent
test("resolveWorkingDir non-existent", () => {
  const dir = join(tmpdir(), `ocr-no-such-${Date.now()}-x`);
  expect(() => resolveWorkingDir(dir, false)).toThrow();
});

// OCR v1.9.3: TestResolveWorkingDir_MonorepoSubdir
test("resolveWorkingDir monorepo subdir hoisting", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-mono-"));
  try {
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: root });
    spawnSync("git", ["config", "user.name", "t"], { cwd: root });
    const sub = join(root, "subproject1", "src");
    mkdirSync(sub, { recursive: true });
    // review path: hoisted to git top-level
    const got = resolveWorkingDir(sub, true);
    expect(got.isGit).toBe(true);
    // absPath should be root (canonicalized)
    const resolvedRoot = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
    expect(got.absPath).toBe(resolvedRoot);
    // scan path: keeps subdir
    const gotScan = resolveWorkingDir(sub, false);
    expect(gotScan.absPath).toBe(sub);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveWorkingDir_BareRepoFailsLoudly
test("resolveWorkingDir bare repo fails", () => {
  const bare = mkdtempSync(join(tmpdir(), "ocr-bare-"));
  try {
    spawnSync("git", ["init", "--bare", bare]);
    expect(() => resolveWorkingDir(bare, true)).toThrow();
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveWorkingDir_GitRepo
test("resolveWorkingDir git repo detection", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-git-"));
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    const { absPath } = resolveWorkingDir(dir, false);
    expect(absPath.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});



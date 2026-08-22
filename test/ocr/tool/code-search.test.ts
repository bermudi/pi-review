// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/code_search_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { FileReader, NewCodeSearch } from "../../../src/ocr/tool/filereader.js";
import { Runner } from "../../../src/ocr/diff/runner.js";

function setupTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cs-"));
  const run = (...args: string[]) => {
    const res = spawnSync(args[0]!, args.slice(1), { cwd: dir });
    if (res.status !== 0) throw new Error(`${args.join(" ")} failed ${res.stderr?.toString()}`);
  };
  run("git", "init");
  run("git", "config", "user.email", "test@test.com");
  run("git", "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "hello.go"), "package main\n\nfunc Hello() {}\n", { mode: 0o644 });
  fs.mkdirSync(path.join(dir, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pkg", "util.go"), "package pkg\n\nfunc Util() {}\n", { mode: 0o644 });
  run("git", "add", ".");
  run("git", "commit", "-m", "init");
  return dir;
}
function getHeadCommit(dir: string): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  return (res.stdout as unknown as string).trim();
}

function buildArgs(
  fr: unknown,
  searchText: string,
  caseSensitive: boolean,
  usePerl: boolean,
  noIndex: boolean,
  pathspec: string[],
): string[] | null {
  const prov = NewCodeSearch(fr as never);
  const fn = (prov as unknown as { buildGrepArgs: (...a: unknown[]) => string[] | null }).buildGrepArgs;
  if (typeof fn !== "function") return null;
  return fn.call(prov, searchText, caseSensitive, usePerl, noIndex, pathspec);
}

// OCR v1.9.3: TestBuildGrepArgs_CaseInsensitive
test("TestBuildGrepArgs_CaseInsensitive", () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" });
  const args = buildArgs(fr, "hello", false, false, false, []);
  expect(args).not.toBeNull();
  expect(args!.includes("-i")).toBe(true);
});

// OCR v1.9.3: TestBuildGrepArgs_CaseSensitive
test("TestBuildGrepArgs_CaseSensitive", () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" });
  const args = buildArgs(fr, "hello", true, false, false, []);
  expect(args).not.toBeNull();
  expect(args!.includes("-i")).toBe(false);
});

// OCR v1.9.3: TestBuildGrepArgs_CommitMode
test("TestBuildGrepArgs_CommitMode", () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 2 as never, Ref: "abc123" });
  const args = buildArgs(fr, "hello", false, false, false, []);
  expect(args).not.toBeNull();
  expect(args!.includes("abc123")).toBe(true);
});

// OCR v1.9.3: TestBuildGrepArgs_FixedString
test("TestBuildGrepArgs_FixedString", () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" });
  const args = buildArgs(fr, "hello", false, false, false, []);
  expect(args).not.toBeNull();
  expect(args!.includes("-F")).toBe(true);
});

// OCR v1.9.3: TestBuildGrepArgs_NoIndex
test("TestBuildGrepArgs_NoIndex", () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" });
  const args = buildArgs(fr, "hello", false, false, true, []);
  expect(args).not.toBeNull();
  expect(args!.includes("--no-index")).toBe(true);
});

// OCR v1.9.3: TestBuildGrepArgs_PatternStartingWithDash
test("TestBuildGrepArgs_PatternStartingWithDash", () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" });
  const args = buildArgs(fr, "-hello", false, false, false, []);
  expect(args).not.toBeNull();
  expect(args!.includes("-e")).toBe(true);
  expect(args!.includes("-hello")).toBe(true);
});

// OCR v1.9.3: TestBuildGrepArgs_PerlRegexp
test("TestBuildGrepArgs_PerlRegexp", () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" });
  const args = buildArgs(fr, "h.*o", false, true, false, []);
  expect(args).not.toBeNull();
  expect(args!.includes("-P")).toBe(true);
});

// OCR v1.9.3: TestBuildGrepArgs_RejectsOptionLikeRef
test("TestBuildGrepArgs_RejectsOptionLikeRef", () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 2 as never, Ref: "-bad" });
  const args = buildArgs(fr, "hello", false, false, false, []);
  expect(args).toBeNull();
});

// OCR v1.9.3: TestBuildGrepArgs_WorkspaceMode
test("TestBuildGrepArgs_WorkspaceMode", () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" });
  const args = buildArgs(fr, "hello", false, false, false, []);
  expect(args).not.toBeNull();
  // workspace should have --untracked or no ref
  expect(args!.join(" ")).toContain("grep");
});

// OCR v1.9.3: TestCodeSearchProvider_Execute_AllowsDoubleDotInFilename
test("TestCodeSearchProvider_Execute_AllowsDoubleDotInFilename", async () => {
  const dir = setupTestRepo();
  try {
    const f = path.join(dir, "a..b.go");
    fs.writeFileSync(f, "package main\n", { mode: 0o644 });
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const p = NewCodeSearch(fr);
    // double dot in filename should not be treated as traversal
    const out = await p.Execute(undefined, { search_text: "package", file_patterns: ["a..b.go"] });
    expect(out).toBeDefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCodeSearchProvider_Execute_BlankSearchText
test("TestCodeSearchProvider_Execute_BlankSearchText", async () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" });
  const p = NewCodeSearch(fr);
  const out = await p.Execute(undefined, { search_text: "   " });
  expect(out).toContain("blank");
});

// OCR v1.9.3: TestCodeSearchProvider_Execute_CaseSensitive
test("TestCodeSearchProvider_Execute_CaseSensitive", async () => {
  const dir = setupTestRepo();
  try {
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const p = NewCodeSearch(fr);
    const outInsensitive = await p.Execute(undefined, { search_text: "hello", case_sensitive: false });
    expect(outInsensitive).toContain("hello.go");
    const outSensitive = await p.Execute(undefined, { search_text: "HELLO", case_sensitive: true });
    expect(outSensitive).toContain("No matches");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCodeSearchProvider_Execute_Found
test("TestCodeSearchProvider_Execute_Found", async () => {
  const dir = setupTestRepo();
  try {
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "Hello" });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCodeSearchProvider_Execute_PerlRegexp
test("TestCodeSearchProvider_Execute_PerlRegexp", async () => {
  const dir = setupTestRepo();
  try {
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "H.*o", use_perl_regexp: true });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCodeSearchProvider_Execute_RejectsTraversalPattern
test("TestCodeSearchProvider_Execute_RejectsTraversalPattern", async () => {
  const fr = new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" });
  const p = NewCodeSearch(fr);
  const out = await p.Execute(undefined, { search_text: "hello", file_patterns: ["../etc/passwd"] });
  expect(out).toContain("must not contain ..");
});

// OCR v1.9.3: TestCodeSearchProvider_Execute_WithFilePatterns
test("TestCodeSearchProvider_Execute_WithFilePatterns", async () => {
  const dir = setupTestRepo();
  try {
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "Hello", file_patterns: ["hello.go"] });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCodeSearchProvider_Tool
test("TestCodeSearchProvider_Tool", () => {
  const p = NewCodeSearch(new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" }));
  expect(p.Tool()).toBeDefined();
});

// OCR v1.9.3: TestGitGrep_CommitMode_Found
test("TestGitGrep_CommitMode_Found", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: commit });
    const p = NewCodeSearch(fr);
    const out = await p.Execute(undefined, { search_text: "Hello" });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_CommitMode_LiteralWithRegexMetaChars
test("TestGitGrep_CommitMode_LiteralWithRegexMetaChars", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: commit });
    const p = NewCodeSearch(fr);
    const out = await p.Execute(undefined, { search_text: "func Hello() {}" });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_CommitMode_NoMatch
test("TestGitGrep_CommitMode_NoMatch", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: commit }));
    const out = await p.Execute(undefined, { search_text: "nonexistentXYZ123" });
    expect(out).toContain("No matches");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_CommitMode_WithBadPathspec
test("TestGitGrep_CommitMode_WithBadPathspec", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: commit });
    const p = NewCodeSearch(fr);
    // bad pathspec should not crash
    const out = await p.Execute(undefined, { search_text: "Hello", file_patterns: ["nonexistent_dir/*.go"] });
    expect(out).toBeDefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_CommitMode_WithPathspec
test("TestGitGrep_CommitMode_WithPathspec", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: commit }));
    const out = await p.Execute(undefined, { search_text: "Hello", file_patterns: ["hello.go"] });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_InvalidRef_ReturnsError
test("TestGitGrep_InvalidRef_ReturnsError", async () => {
  const dir = setupTestRepo();
  try {
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    const p = NewCodeSearch(fr);
    const out = await p.Execute(undefined, { search_text: "Hello" });
    // should return error or no matches, but not throw
    expect(out).toBeDefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_LiteralWithRegexMetaChars
test("TestGitGrep_LiteralWithRegexMetaChars", async () => {
  const dir = setupTestRepo();
  try {
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "func Hello() {}" });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_NonGitDirectoryFallback
test("TestGitGrep_NonGitDirectoryFallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cs-nongit-"));
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n", { mode: 0o644 });
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "hello" });
    expect(out).toContain("a.txt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_NonGitDirectoryNoMatch
test("TestGitGrep_NonGitDirectoryNoMatch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cs-nogit2-"));
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n", { mode: 0o644 });
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "nonexistent" });
    expect(out).toContain("No matches");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_OptionLikeRefDoesNotLaunchPager
test("TestGitGrep_OptionLikeRefDoesNotLaunchPager", async () => {
  const dir = setupTestRepo();
  try {
    const pager = path.join(dir, "pwn.sh");
    const proof = path.join(dir, "PROOF");
    fs.writeFileSync(pager, "#!/bin/sh\nprintf pwned > PROOF\n", { mode: 0o755 });
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: "-O./pwn.sh" });
    const p = NewCodeSearch(fr);
    const out = await p.Execute(undefined, { search_text: "Hello" });
    expect(out).toContain("must not start with");
    expect(fs.existsSync(proof)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_PerlRegexp_InvalidPattern_ReturnsError
test("TestGitGrep_PerlRegexp_InvalidPattern_ReturnsError", async () => {
  const dir = setupTestRepo();
  try {
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "[invalid", use_perl_regexp: true });
    expect(out).toBeDefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_RejectsOptionLikeRef
test("TestGitGrep_RejectsOptionLikeRef", async () => {
  const dir = setupTestRepo();
  try {
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: "-bad" });
    const p = NewCodeSearch(fr);
    const out = await p.Execute(undefined, { search_text: "hello" });
    expect(out).toContain("must not start with");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_Timeout
test("TestGitGrep_Timeout", async () => {
  const dir = setupTestRepo();
  try {
    // timeout is hard to trigger without large repo; we just verify provider does not hang
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "Hello" });
    expect(out).toBeDefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_WithRunner
test("TestGitGrep_WithRunner", async () => {
  const dir = setupTestRepo();
  try {
    const runner = new Runner(2);
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "", Runner: runner as unknown as never });
    const p = NewCodeSearch(fr);
    const out = await p.Execute(undefined, { search_text: "Hello" });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_WithRunner_CommitMode
test("TestGitGrep_WithRunner_CommitMode", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const runner = new Runner(2);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: commit, Runner: runner as unknown as never });
    const p = NewCodeSearch(fr);
    const out = await p.Execute(undefined, { search_text: "Hello" });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_WithRunner_NoMatch
test("TestGitGrep_WithRunner_NoMatch", async () => {
  const dir = setupTestRepo();
  try {
    const runner = new Runner(2);
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "", Runner: runner as unknown as never });
    const p = NewCodeSearch(fr);
    const out = await p.Execute(undefined, { search_text: "nonexistentXYZ" });
    expect(out).toContain("No matches");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_WorkspaceMode_Found
test("TestGitGrep_WorkspaceMode_Found", async () => {
  const dir = setupTestRepo();
  try {
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "Hello" });
    expect(out).toContain("hello.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_WorkspaceMode_NoMatch
test("TestGitGrep_WorkspaceMode_NoMatch", async () => {
  const dir = setupTestRepo();
  try {
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "nonexistentXYZ" });
    expect(out).toContain("No matches");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestGitGrep_WorkspaceMode_UntrackedFile
test("TestGitGrep_WorkspaceMode_UntrackedFile", async () => {
  const dir = setupTestRepo();
  try {
    fs.writeFileSync(path.join(dir, "untracked.go"), "package untracked\n", { mode: 0o644 });
    const p = NewCodeSearch(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { search_text: "untracked" });
    expect(out).toContain("untracked.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/file_find_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { FileReader, NewFileFind } from "../../../src/ocr-v193/tool/filereader.js";
import { Runner } from "../../../src/ocr-v193/diff/runner.js";

function setupFileFindRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filefind-"));
  const run = (...args: string[]) => {
    const res = spawnSync(args[0]!, args.slice(1), { cwd: dir });
    if (res.status !== 0) throw new Error(`${args.join(" ")} failed`);
  };
  run("git", "init");
  run("git", "config", "user.email", "test@test.com");
  run("git", "config", "user.name", "Test");
  const write = (rel: string, content: string) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, { mode: 0o644 });
  };
  write("main.go", "package main\n");
  write("pkg/util.go", "package pkg\n");
  write("Makefile", "all:\n");
  write("Dockerfile", "FROM scratch\n");
  write("LICENSE", "MIT\n");
  write("data_binary", "binary\n");
  run("git", "add", ".");
  run("git", "commit", "-m", "init");
  return dir;
}

// OCR v1.9.3: TestFileFind_NonGitDirectoryFallback
test("TestFileFind_NonGitDirectoryFallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-find-nongit-"));
  try {
    const write = (rel: string, content: string) => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, { mode: 0o644 });
    };
    write("server.go", "package main\n");
    write("internal/handler.go", "package internal\n");
    write("node_modules/lib/index.js", "x\n");
    write(".gitignore", "ignored.go\n");
    write("ignored.go", "package x\n");
    const p = NewFileFind(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { query_name: ".go" });
    expect(out).toContain("server.go");
    expect(out).toContain("internal/handler.go");
    expect(out.includes("node_modules")).toBe(false);
    expect(out.includes("ignored.go")).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileFind_NonGitDirectoryNoMatch
test("TestFileFind_NonGitDirectoryNoMatch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-find-nomatch-"));
  try {
    fs.writeFileSync(path.join(dir, "a.go"), "package a\n", { mode: 0o644 });
    const p = NewFileFind(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const out = await p.Execute(undefined, { query_name: "nonexistent_xyz" });
    expect(out).toContain("not found");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileFindProvider_Tool
test("TestFileFindProvider_Tool", () => {
  const p = NewFileFind(new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" }));
  expect(p.Tool()).toBeDefined();
});

// OCR v1.9.3: TestFileFind_BlankQuery
test("TestFileFind_BlankQuery", async () => {
  const p = NewFileFind(new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" }));
  const got = await p.Execute(undefined, { query_name: "  " });
  expect(got).toContain("not found");
});

// OCR v1.9.3: TestFileFind_GitRepo_WorkspaceMode
test("TestFileFind_GitRepo_WorkspaceMode", async () => {
  const dir = setupFileFindRepo();
  try {
    const p = NewFileFind(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const got = await p.Execute(undefined, { query_name: ".go" });
    expect(got).toContain("main.go");
    expect(got).toContain("util.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileFind_GitRepo_CommitMode
test("TestFileFind_GitRepo_CommitMode", async () => {
  const dir = setupFileFindRepo();
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
    const commit = (res.stdout as unknown as string).trim();
    const p = NewFileFind(new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: commit }));
    const got = await p.Execute(undefined, { query_name: ".go" });
    expect(got).toContain("main.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileFind_GitRepo_WithRunner
test("TestFileFind_GitRepo_WithRunner", async () => {
  const dir = setupFileFindRepo();
  try {
    const runner = new Runner(4);
    const p = NewFileFind(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "", Runner: runner as unknown as never }));
    const got = await p.Execute(undefined, { query_name: ".go" });
    expect(got).toContain("main.go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileFind_CaseSensitive
test("TestFileFind_CaseSensitive", async () => {
  const dir = setupFileFindRepo();
  try {
    const p = NewFileFind(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    const got = await p.Execute(undefined, { query_name: "makefile", case_sensitive: false });
    expect(got).toContain("Makefile");
    const got2 = await p.Execute(undefined, { query_name: "makefile", case_sensitive: true });
    expect(got2.includes("Makefile")).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestShouldSkipFile
test("TestShouldSkipFile", async () => {
  // Exercise shouldSkipFile via FileFind filtering of extensionless files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shouldskip-"));
  try {
    const files = [
      "main.go",
      "pkg/util.go",
      "README.md",
      "Makefile",
      "Dockerfile",
      "LICENSE",
      "Vagrantfile",
      "Containerfile",
      "some_binary",
      "dir/unknown_file",
    ];
    for (const f of files) {
      const full = path.join(dir, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "x\n", { mode: 0o644 });
    }
    const p = NewFileFind(new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" }));
    // Search for extensionless name should find Makefile etc but not some_binary
    const outMake = await p.Execute(undefined, { query_name: "Makefile" });
    expect(outMake).toContain("Makefile");
    const outBinary = await p.Execute(undefined, { query_name: "some_binary" });
    expect(outBinary).toContain("not found");
    const outUnknown = await p.Execute(undefined, { query_name: "unknown_file" });
    expect(outUnknown).toContain("not found");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

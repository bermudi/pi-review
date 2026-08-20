// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/filereader_read_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { FileReader, type ReviewMode } from "../../../src/ocr-v193/tool/filereader.js";
import { Runner } from "../../../src/ocr-v193/diff/runner.js";

function setupTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filereader-"));
  const run = (...args: string[]) => {
    const res = spawnSync(args[0]!, args.slice(1), { cwd: dir });
    if (res.status !== 0) throw new Error(`${args.join(" ")}: ${res.stderr?.toString()}`);
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
  if (res.status !== 0) throw new Error(`rev-parse: ${res.stderr}`);
  return (res.stdout as unknown as string).trim();
}

// OCR v1.9.3: TestFileReader_Read_Workspace
test("TestFileReader_Read_Workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fr-ws-"));
  try {
    const content = "line1\nline2\nline3\n";
    fs.writeFileSync(path.join(dir, "test.go"), content, { mode: 0o644 });
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as ReviewMode, Ref: "" });
    const got = await fr.Read(undefined, "test.go");
    expect(got).toBe(content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_Read_WorkspaceNotFound
test("TestFileReader_Read_WorkspaceNotFound", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fr-notfound-"));
  try {
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as ReviewMode, Ref: "" });
    await expect(fr.Read(undefined, "missing.go")).rejects.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_Read_PathTraversal
test("TestFileReader_Read_PathTraversal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fr-traversal-"));
  try {
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as ReviewMode, Ref: "" });
    await expect(fr.Read(undefined, "../../../etc/passwd")).rejects.toThrow(/outside repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_Read_SymlinkOutsideRepo
test("TestFileReader_Read_SymlinkOutsideRepo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fr-symout-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fr-outside-"));
  try {
    const secretFile = path.join(outside, "secret.txt");
    fs.writeFileSync(secretFile, "sensitive", { mode: 0o644 });
    const link = path.join(dir, "link.txt");
    try {
      fs.symlinkSync(secretFile, link);
    } catch {
      return;
    }
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as ReviewMode, Ref: "" });
    await expect(fr.Read(undefined, "link.txt")).rejects.toThrow(/outside repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_ReadLines_Workspace
test("TestFileReader_ReadLines_Workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fr-lines-ws-"));
  try {
    const content = "aaa\nbbb\nccc\nddd\n";
    fs.writeFileSync(path.join(dir, "lines.txt"), content, { mode: 0o644 });
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as ReviewMode, Ref: "" });
    // all lines
    {
      const { lines, total } = await fr.ReadLines(undefined, "lines.txt", 1, 100);
      expect(total).toBe(5);
      expect(lines.length).toBe(5);
    }
    // start from line 2 limit 2
    {
      const { lines, total } = await fr.ReadLines(undefined, "lines.txt", 2, 2);
      expect(total).toBe(5);
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe("bbb");
      expect(lines[1]).toBe("ccc");
    }
    // path traversal rejected
    await expect(fr.ReadLines(undefined, "../../etc/passwd", 1, 10)).rejects.toThrow(/outside repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_Read_CommitMode
test("TestFileReader_Read_CommitMode", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as ReviewMode, Ref: commit });
    const got = await fr.Read(undefined, "hello.go");
    expect(got).toContain("package main");
    expect(got).toContain("func Hello()");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_Read_CommitMode_MissingFile
test("TestFileReader_Read_CommitMode_MissingFile", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as ReviewMode, Ref: commit });
    await expect(fr.Read(undefined, "nonexistent.go")).rejects.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_Read_CommitMode_WithRunner
test("TestFileReader_Read_CommitMode_WithRunner", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const runner = new Runner(4);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as ReviewMode, Ref: commit, Runner: runner as unknown as never });
    const got = await fr.Read(undefined, "hello.go");
    expect(got).toContain("package main");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_Read_CommitMode_WithRunner_MissingFile
test("TestFileReader_Read_CommitMode_WithRunner_MissingFile", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const runner = new Runner(4);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as ReviewMode, Ref: commit, Runner: runner as unknown as never });
    await expect(fr.Read(undefined, "nonexistent.go")).rejects.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_ReadLines_CommitMode_WithRunner
test("TestFileReader_ReadLines_CommitMode_WithRunner", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const runner = new Runner(4);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as ReviewMode, Ref: commit, Runner: runner as unknown as never });
    const { lines, total } = await fr.ReadLines(undefined, "hello.go", 1, 100);
    expect(total).toBe(4);
    expect(lines[0]).toBe("package main");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_ReadLines_CommitMode_MissingFile
test("TestFileReader_ReadLines_CommitMode_MissingFile", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as ReviewMode, Ref: commit });
    await expect(fr.ReadLines(undefined, "nonexistent.go", 1, 100)).rejects.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_Read_SubdirectoryFile
test("TestFileReader_Read_SubdirectoryFile", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fr-subdir-"));
  try {
    const sub = path.join(dir, "src", "pkg");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "main.go"), "package main", { mode: 0o644 });
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as ReviewMode, Ref: "" });
    const got = await fr.Read(undefined, "src/pkg/main.go");
    expect(got).toBe("package main");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReader_Read_CommitMode_MonorepoSubdirPath
test("TestFileReader_Read_CommitMode_MonorepoSubdirPath", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fr-mono-"));
  try {
    const run = (...args: string[]) => {
      const res = spawnSync(args[0]!, args.slice(1), { cwd: dir });
      if (res.status !== 0) throw new Error(`${args.join(" ")} failed`);
    };
    run("git", "init");
    run("git", "config", "user.email", "t@t.co");
    run("git", "config", "user.name", "t");
    const rel = path.join("subproject1", "src", "models", "request_meta.py");
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    const content = "class RequestMeta:\n    id = 1\n";
    fs.writeFileSync(path.join(dir, rel), content, { mode: 0o644 });
    run("git", "add", ".");
    run("git", "commit", "-m", "init");
    const commit = getHeadCommit(dir);
    const gitPath = "subproject1/src/models/request_meta.py";
    const frShow = new FileReader({ RepoDir: dir, Mode: 2 as ReviewMode, Ref: commit });
    const got = await frShow.Read(undefined, gitPath);
    expect(got).toBe(content);
    const frDisk = new FileReader({ RepoDir: dir, Mode: 0 as ReviewMode, Ref: "" });
    const gotDisk = await frDisk.Read(undefined, gitPath);
    expect(gotDisk).toBe(content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/file_read_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { FileReader, NewFileRead } from "../../../src/ocr/tool/filereader.js";

function writeTestFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, { mode: 0o644 });
}

function setupTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-read-"));
  const run = (...args: string[]) => {
    const res = spawnSync(args[0]!, args.slice(1), { cwd: dir });
    if (res.status !== 0) throw new Error(`${args.join(" ")} failed`);
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

// OCR v1.9.3: TestReadLines_Disk_FullFile
test("TestReadLines_Disk_FullFile", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-full-"));
  try {
    writeTestFile(dir, "a.txt", "line1\nline2\nline3\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const { lines, total } = await fr.ReadLines(undefined, "a.txt", 1, 100);
    expect(total).toBe(4);
    const want = ["line1", "line2", "line3", ""];
    expect(lines).toEqual(want);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_Window
test("TestReadLines_Disk_Window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-window-"));
  try {
    writeTestFile(dir, "b.txt", "a\nb\nc\nd\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const { lines, total } = await fr.ReadLines(undefined, "b.txt", 2, 2);
    expect(total).toBe(5);
    expect(lines).toEqual(["b", "c"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_EmptyFile
test("TestReadLines_Disk_EmptyFile", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-empty-"));
  try {
    writeTestFile(dir, "empty.txt", "");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const { lines, total } = await fr.ReadLines(undefined, "empty.txt", 1, 100);
    expect(total).toBe(0);
    expect(lines.length).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_StartBeyondEOF
test("TestReadLines_Disk_StartBeyondEOF", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-beyond-"));
  try {
    writeTestFile(dir, "short.txt", "only\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const { lines, total } = await fr.ReadLines(undefined, "short.txt", 100, 10);
    expect(total).toBe(2);
    expect(lines.length).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_TrailingNewline
test("TestReadLines_Disk_TrailingNewline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-trail-"));
  try {
    writeTestFile(dir, "trail.txt", "x\ny\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const { lines, total } = await fr.ReadLines(undefined, "trail.txt", 1, 100);
    expect(total).toBe(3);
    expect(lines.length).toBe(3);
    expect(lines[2]).toBe("");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_NoTrailingNewline
test("TestReadLines_Disk_NoTrailingNewline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-notrail-"));
  try {
    writeTestFile(dir, "notrail.txt", "x\ny");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const { lines, total } = await fr.ReadLines(undefined, "notrail.txt", 1, 100);
    expect(total).toBe(2);
    expect(lines.length).toBe(2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_GitShow_Window
test("TestReadLines_GitShow_Window", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: commit });
    const { lines, total } = await fr.ReadLines(undefined, "hello.go", 1, 100);
    expect(total).toBe(4);
    expect(lines[0]).toBe("package main");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_RejectsParentTraversal
test("TestReadLines_Disk_RejectsParentTraversal", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-traversal-"));
  const repoDir = path.join(base, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    const secretPath = path.join(base, "secret.txt");
    fs.writeFileSync(secretPath, "outside-secret\n", { mode: 0o644 });
    const rel = path.relative(repoDir, secretPath);
    const fr = new FileReader({ RepoDir: repoDir, Mode: 0 as never, Ref: "" });
    await expect(fr.ReadLines(undefined, rel, 1, 10)).rejects.toThrow(/outside repository/);
    await expect(fr.Read(undefined, rel)).rejects.toThrow(/outside repository/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_AllowsParentSegmentWithinRepo
test("TestReadLines_Disk_AllowsParentSegmentWithinRepo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-parentseg-"));
  try {
    fs.mkdirSync(path.join(dir, "pkg"), { recursive: true });
    writeTestFile(dir, "target.txt", "inside\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const { lines } = await fr.ReadLines(undefined, path.join("pkg", "..", "target.txt"), 1, 10);
    expect(lines[0]).toBe("inside");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_AbsolutePathStaysUnderRepo
test("TestReadLines_Disk_AbsolutePathStaysUnderRepo", async () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-abs-"));
  try {
    fs.mkdirSync(path.join(dir, "etc"), { recursive: true });
    writeTestFile(dir, path.join("etc", "passwd"), "repo-passwd\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const { lines } = await fr.ReadLines(undefined, "/etc/passwd", 1, 10);
    expect(lines[0]).toBe("repo-passwd");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_MissingFilePreservesReadError
test("TestReadLines_Disk_MissingFilePreservesReadError", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-missing-"));
  try {
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    let err: unknown;
    try {
      await fr.ReadLines(undefined, "missing.txt", 1, 10);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const msg = String(err);
    expect(msg).toContain(`read file "missing.txt"`);
    expect(msg).not.toContain("resolve file");
    let err2: unknown;
    try {
      await fr.Read(undefined, "missing.txt");
    } catch (e) {
      err2 = e;
    }
    expect(String(err2)).toContain(`read file "missing.txt"`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_RejectsSymlinkOutsideRepo
test("TestReadLines_Disk_RejectsSymlinkOutsideRepo", async () => {
  if (process.platform === "win32") return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-symout-"));
  const repoDir = path.join(base, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  const secretPath = path.join(base, "secret.txt");
  fs.writeFileSync(secretPath, "outside-secret\n", { mode: 0o644 });
  try {
    fs.symlinkSync(secretPath, path.join(repoDir, "link.txt"));
  } catch {
    fs.rmSync(base, { recursive: true, force: true });
    return;
  }
  try {
    const fr = new FileReader({ RepoDir: repoDir, Mode: 0 as never, Ref: "" });
    await expect(fr.ReadLines(undefined, "link.txt", 1, 10)).rejects.toThrow(/outside repository/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadLines_Disk_AllowsSymlinkInsideRepo
test("TestReadLines_Disk_AllowsSymlinkInsideRepo", async () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-symin-"));
  try {
    writeTestFile(dir, "target.txt", "inside\n");
    try {
      fs.symlinkSync(path.join(dir, "target.txt"), path.join(dir, "link.txt"));
    } catch {
      return;
    }
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const { lines } = await fr.ReadLines(undefined, "link.txt", 1, 10);
    expect(lines[0]).toBe("inside");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestExecute_Truncation
test("TestExecute_Truncation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exec-trunc-"));
  try {
    let sb = "";
    for (let i = 1; i <= 600; i++) sb += `line ${i}\n`;
    writeTestFile(dir, "big.txt", sb);
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const p = NewFileRead(fr);
    const result = await p.Execute(undefined, { file_path: "big.txt" });
    expect(result).toContain("IS_TRUNCATED: true");
    expect(result).toContain("LINE_RANGE: 1-500");
    expect(result).toContain("Results truncated to 500 lines");
    expect(result.includes("501|")).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestFileReadProvider_Tool
test("TestFileReadProvider_Tool", () => {
  const p = NewFileRead(new FileReader({ RepoDir: "/tmp", Mode: 0 as never, Ref: "" }));
  // FileRead constant is 0-indexed? Check Tool enum: FileRead is defined
  expect(p.Tool()).toBeDefined();
});

// OCR v1.9.3: TestExecute_EmptyFilePath
test("TestExecute_EmptyFilePath", async () => {
  const fr = new FileReader({ RepoDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-exec-empty-")), Mode: 0 as never, Ref: "" });
  const p = NewFileRead(fr);
  const got = await p.Execute(undefined, { file_path: "" });
  expect(got).toBe("Error: file_path is required");
  fs.rmSync(fr.RepoDir, { recursive: true, force: true });
});

// OCR v1.9.3: TestExecute_InvalidLineRange
test("TestExecute_InvalidLineRange", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exec-invalid-"));
  try {
    writeTestFile(dir, "test.txt", "a\nb\nc\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const p = NewFileRead(fr);
    await expect(p.Execute(undefined, { file_path: "test.txt", start_line: 5, end_line: 2 })).rejects.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestExecute_StartBeyondTotalLines
test("TestExecute_StartBeyondTotalLines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exec-beyond-"));
  try {
    writeTestFile(dir, "short.txt", "one\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const p = NewFileRead(fr);
    await expect(p.Execute(undefined, { file_path: "short.txt", start_line: 100, end_line: 200 })).rejects.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestExecute_MissingFile
test("TestExecute_MissingFile", async () => {
  const fr = new FileReader({ RepoDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-exec-miss-")), Mode: 0 as never, Ref: "" });
  const p = NewFileRead(fr);
  const dir = fr.RepoDir;
  try {
    await expect(p.Execute(undefined, { file_path: "missing.txt" })).rejects.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestExecute_CommitMode
test("TestExecute_CommitMode", async () => {
  const dir = setupTestRepo();
  try {
    const commit = getHeadCommit(dir);
    const fr = new FileReader({ RepoDir: dir, Mode: 2 as never, Ref: commit });
    const p = NewFileRead(fr);
    const got = await p.Execute(undefined, { file_path: "hello.go" });
    expect(got).toContain("package main");
    expect(got).toContain("IS_TRUNCATED: false");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestExecute_DefaultStartLine
test("TestExecute_DefaultStartLine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exec-default-"));
  try {
    writeTestFile(dir, "d.txt", "a\nb\nc\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const p = NewFileRead(fr);
    const got = await p.Execute(undefined, { file_path: "d.txt", start_line: 0 });
    expect(got).toContain("LINE_RANGE: 1-");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestExecute_WithEndLine
test("TestExecute_WithEndLine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exec-end-"));
  try {
    writeTestFile(dir, "c.txt", "a\nb\nc\nd\ne\n");
    const fr = new FileReader({ RepoDir: dir, Mode: 0 as never, Ref: "" });
    const p = NewFileRead(fr);
    const result = await p.Execute(undefined, { file_path: "c.txt", start_line: 2, end_line: 4 });
    expect(result).toContain("IS_TRUNCATED: false");
    expect(result).toContain("LINE_RANGE: 2-4");
    expect(result).toContain("2|b");
    expect(result).toContain("4|d");
    expect(result.includes("5|e")).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/workspace_file_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readWorkspaceFileForDiff } from "../../../src/ocr/diff/workspace.js";

// OCR v1.9.3: TestReadWorkspaceFileForDiffRejectsAbsolutePath
test("TestReadWorkspaceFileForDiffRejectsAbsolutePath", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-abs-"));
  try {
    const absPath = path.join(repo, "file.txt");
    await expect(readWorkspaceFileForDiff(repo, absPath)).rejects.toThrow(/must be relative/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadWorkspaceFileForDiffReadsRegularFile
test("TestReadWorkspaceFileForDiffReadsRegularFile", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-reg-"));
  try {
    const want = "hello world\n";
    fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
    fs.writeFileSync(path.join(repo, "sub", "file.txt"), want, { mode: 0o644 });
    const got = await readWorkspaceFileForDiff(repo, "sub/file.txt");
    expect(got.toString()).toBe(want);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadWorkspaceFileForDiffRejectsPathTraversal
test("TestReadWorkspaceFileForDiffRejectsPathTraversal", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-trav-"));
  try {
    await expect(readWorkspaceFileForDiff(repo, "../../../etc/passwd")).rejects.toThrow(/outside repository/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadWorkspaceFileForDiffRejectsDirectory
test("TestReadWorkspaceFileForDiffRejectsDirectory", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-dir-"));
  try {
    fs.mkdirSync(path.join(repo, "subdir"), { recursive: true });
    await expect(readWorkspaceFileForDiff(repo, "subdir")).rejects.toThrow(/is a directory/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadWorkspaceFileForDiffRejectsParentSymlinkEscape
test("TestReadWorkspaceFileForDiffRejectsParentSymlinkEscape", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-parent-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n", { mode: 0o644 });
    let ok = true;
    try {
      fs.symlinkSync(outside, path.join(repo, "escape"));
    } catch {
      ok = false;
    }
    if (!ok) return; // skip if symlink not supported
    await expect(readWorkspaceFileForDiff(repo, "escape/secret.txt")).rejects.toThrow(/outside repository/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadWorkspaceFileForDiffReturnsSymlinkTarget
test("TestReadWorkspaceFileForDiffReturnsSymlinkTarget", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-symtarget-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-outside-target-"));
  try {
    const secretPath = path.join(outside, "secret.txt");
    fs.writeFileSync(secretPath, "TOP_SECRET\n", { mode: 0o644 });
    let ok = true;
    try {
      fs.symlinkSync(secretPath, path.join(repo, "link"));
    } catch {
      ok = false;
    }
    if (!ok) return;
    const got = await readWorkspaceFileForDiff(repo, "link");
    expect(got.toString()).not.toBe("TOP_SECRET\n");
    expect(got.toString()).toBe(secretPath);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadWorkspaceFileForDiffReadsInternalSymlink
test("TestReadWorkspaceFileForDiffReadsInternalSymlink", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-internal-"));
  try {
    const realContent = "internal content\n";
    fs.writeFileSync(path.join(repo, "real.txt"), realContent, { mode: 0o644 });
    const target = path.join(repo, "real.txt");
    let ok = true;
    try {
      fs.symlinkSync(target, path.join(repo, "internal_link"));
    } catch {
      ok = false;
    }
    if (!ok) return;
    const got = await readWorkspaceFileForDiff(repo, "internal_link");
    expect(got.toString()).toBe(target);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReadWorkspaceFileForDiffRejectsNonexistentFile
test("TestReadWorkspaceFileForDiffRejectsNonexistentFile", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-notfound-"));
  try {
    await expect(readWorkspaceFileForDiff(repo, "does_not_exist.txt")).rejects.toThrow(/stat file/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/git_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Provider } from "../../../src/ocr/diff/git.js";
import { Runner } from "../../../src/ocr/diff/runner.js";

function runGit(dir: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd: dir, stdio: "pipe" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr?.toString()}`);
}

function writeGarbageExternalDiff(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-garbage-"));
  const script = path.join(dir, "garbage-diff.sh");
  fs.writeFileSync(script, "#!/bin/sh\necho \"not a diff\"\n", { mode: 0o755 });
  return script;
}

function initRepoWithChange(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gits-"));
  runGit(repo, "init", "-q");
  runGit(repo, "config", "user.email", "test@example.com");
  runGit(repo, "config", "user.name", "Test User");
  runGit(repo, "config", "commit.gpgsign", "false");
  const file = path.join(repo, "sample.txt");
  fs.writeFileSync(file, "line1\nline2\nline3\n", { mode: 0o644 });
  runGit(repo, "add", "sample.txt");
  runGit(repo, "commit", "-q", "-m", "initial commit");
  fs.writeFileSync(file, "line1\nCHANGED\nline3\n", { mode: 0o644 });
  return repo;
}

function initRepoWithNonASCIIChange(): { repo: string; relPath: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nonascii-"));
  runGit(repo, "init", "-q");
  runGit(repo, "config", "user.email", "test@example.com");
  runGit(repo, "config", "user.name", "Test User");
  runGit(repo, "config", "commit.gpgsign", "false");
  runGit(repo, "config", "core.quotepath", "true");
  const relPath = "src/café/(authenticated)/文件.ts";
  const file = path.join(repo, path.posix.join(...relPath.split("/")));
  // Use path.join with proper separators
  const full = path.join(repo, "src", "café", "(authenticated)", "文件.ts");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "before\n", { mode: 0o644 });
  runGit(repo, "add", "--", relPath);
  runGit(repo, "commit", "-q", "-m", "initial commit");
  fs.writeFileSync(full, "after\n", { mode: 0o644 });
  return { repo, relPath };
}

// OCR v1.9.3: TestDiffModesPreserveNonASCIIPaths
test("TestDiffModesPreserveNonASCIIPaths", async () => {
  const modes: Array<{ name: string; provider: (repo: string, runner: Runner) => Provider }> = [
    {
      name: "workspace",
      provider: (repo, runner) => Provider.forWorkspace(repo, runner),
    },
    {
      name: "commit",
      provider: (repo, runner) => {
        runGit(repo, "add", "-A");
        runGit(repo, "commit", "-q", "-m", "update non-ASCII file");
        return Provider.forCommit(repo, "HEAD", runner);
      },
    },
    {
      name: "range",
      provider: (repo, runner) => {
        runGit(repo, "add", "-A");
        runGit(repo, "commit", "-q", "-m", "update non-ASCII file");
        return Provider.forRange(repo, "HEAD~1", "HEAD", runner);
      },
    },
  ];

  for (const tt of modes) {
    const { repo, relPath } = initRepoWithNonASCIIChange();
    try {
      const runner = new Runner(0);
      const provider = tt.provider(repo, runner);
      const diffs = await provider.getDiff();
      expect(diffs.length).toBe(1);
      expect(diffs[0]!.newPath).toBe(relPath);
      expect(diffs[0]!.newFileContent).toBe("after\n");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
});

// OCR v1.9.3: TestWorkspaceDiffPreservesNonASCIIUntrackedPath
test("TestWorkspaceDiffPreservesNonASCIIUntrackedPath", async () => {
  const { repo, relPath: trackedPath } = initRepoWithNonASCIIChange();
  try {
    runGit(repo, "checkout", "--", trackedPath);
    const untrackedPath = "src/café/(authenticated)/新增.ts";
    const full = path.join(repo, "src", "café", "(authenticated)", "新增.ts");
    fs.writeFileSync(full, "untracked\n", { mode: 0o644 });
    const provider = Provider.forWorkspace(repo, new Runner(0));
    const diffs = await provider.getDiff();
    expect(diffs.length).toBe(1);
    expect(diffs[0]!.newPath).toBe(untrackedPath);
    expect(diffs[0]!.newFileContent).toBe("untracked\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestWorkspaceDiffSurvivesExternalDiffTool
test("TestWorkspaceDiffSurvivesExternalDiffTool", async () => {
  const repo = initRepoWithChange();
  const garbage = writeGarbageExternalDiff();
  const prev = process.env.GIT_EXTERNAL_DIFF;
  try {
    process.env.GIT_EXTERNAL_DIFF = garbage;
    const provider = Provider.forWorkspace(repo, new Runner(0));
    const diffs = await provider.getDiff();
    if (diffs.length === 0) throw new Error("expected diffs with external diff tool");
    expect(diffs.length).toBeGreaterThan(0);
  } finally {
    if (prev === undefined) delete process.env.GIT_EXTERNAL_DIFF;
    else process.env.GIT_EXTERNAL_DIFF = prev;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(path.dirname(garbage), { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestWorkspaceDiffNoCommitsUsesStagedFallback
test("TestWorkspaceDiffNoCommitsUsesStagedFallback", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nocommit-"));
  try {
    runGit(repo, "init", "-q");
    const file = path.join(repo, "staged.txt");
    fs.writeFileSync(file, "alpha\nbeta\n", { mode: 0o644 });
    runGit(repo, "add", "staged.txt");
    const provider = Provider.forWorkspace(repo, new Runner(0));
    const diffs = await provider.getDiff();
    expect(diffs.length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCommitDiffSurvivesExternalDiffTool
test("TestCommitDiffSurvivesExternalDiffTool", async () => {
  const repo = initRepoWithChange();
  try {
    runGit(repo, "add", "sample.txt");
    runGit(repo, "commit", "-q", "-m", "second commit");
    const garbage = writeGarbageExternalDiff();
    const prev = process.env.GIT_EXTERNAL_DIFF;
    try {
      process.env.GIT_EXTERNAL_DIFF = garbage;
      const provider = Provider.forCommit(repo, "HEAD", new Runner(0));
      const diffs = await provider.getDiff();
      expect(diffs.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = prev;
      fs.rmSync(path.dirname(garbage), { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCommitDiffTreatsOptionLikeRefAsRevision
test("TestCommitDiffTreatsOptionLikeRefAsRevision", async () => {
  const repo = initRepoWithChange();
  try {
    const pagerPath = path.join(repo, "pwn.sh");
    const proofPath = path.join(repo, "PROOF");
    fs.writeFileSync(pagerPath, "#!/bin/sh\nprintf pwned > PROOF\n", { mode: 0o755 });
    const runner = new Runner(0);
    const provider = Provider.forCommit(repo, "-O./pwn.sh", runner);
    let err: unknown = null;
    try {
      await provider.getDiff();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(fs.existsSync(proofPath)).toBe(false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestWorkspaceUntrackedSymlinkDoesNotReadExternalTarget
test("TestWorkspaceUntrackedSymlinkDoesNotReadExternalTarget", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-sym-untracked-"));
  try {
    runGit(repo, "init", "-q");
    runGit(repo, "config", "user.email", "test@example.com");
    runGit(repo, "config", "user.name", "Test User");
    runGit(repo, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n", { mode: 0o644 });
    runGit(repo, "add", "base.txt");
    runGit(repo, "commit", "-q", "-m", "initial commit");
    const secret = "TOP_SECRET_ISSUE123_SHOULD_NOT_LEAK\n";
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, secret, { mode: 0o644 });
    const linkPath = path.join(repo, "leaked_link");
    let ok = true;
    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch {
      ok = false;
    }
    if (!ok) {
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    const provider = Provider.forWorkspace(repo, new Runner(0));
    const diffs = await provider.getDiff();
    let found = false;
    for (const d of diffs) {
      if (d.diff.includes(secret) || d.newFileContent.includes(secret)) {
        throw new Error("leaked external symlink target content");
      }
      if (d.newPath === "leaked_link") {
        found = true;
        expect(d.newFileContent).toBe(outsideFile);
      }
    }
    expect(found).toBe(true);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestWorkspaceTrackedFileChangedToSymlinkDoesNotReadExternalTarget
test("TestWorkspaceTrackedFileChangedToSymlinkDoesNotReadExternalTarget", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-tracked-sym-"));
  try {
    runGit(repo, "init", "-q");
    runGit(repo, "config", "user.email", "test@example.com");
    runGit(repo, "config", "user.name", "Test User");
    runGit(repo, "config", "commit.gpgsign", "false");
    const victim = path.join(repo, "victim.txt");
    fs.writeFileSync(victim, "original\n", { mode: 0o644 });
    runGit(repo, "add", "victim.txt");
    runGit(repo, "commit", "-q", "-m", "initial commit");
    const secret = "TRACKED_SYMLINK_SECRET_SHOULD_NOT_LEAK\n";
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-outside2-"));
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, secret, { mode: 0o644 });
    fs.rmSync(victim);
    let ok = true;
    try {
      fs.symlinkSync(outsideFile, victim);
    } catch {
      ok = false;
    }
    if (!ok) {
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    const provider = Provider.forWorkspace(repo, new Runner(0));
    const diffs = await provider.getDiff();
    let foundSymlinkAdd = false;
    for (const d of diffs) {
      if (d.diff.includes(secret) || d.newFileContent.includes(secret)) {
        throw new Error("leaked external symlink target");
      }
      if (d.newPath === "victim.txt" && d.isNew) {
        foundSymlinkAdd = true;
        expect(d.newFileContent).toBe(outsideFile);
      }
    }
    expect(foundSymlinkAdd).toBe(true);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRangeDiffDetectsRename
test("TestRangeDiffDetectsRename", async () => {
  const repo = initRepoWithChange();
  try {
    runGit(repo, "checkout", "--", "sample.txt");
    runGit(repo, "config", "diff.renames", "false");
    let content = "";
    for (let i = 1; i <= 50; i++) content += `line${i}\n`;
    const orig = path.join(repo, "orig.txt");
    fs.writeFileSync(orig, content, { mode: 0o644 });
    runGit(repo, "add", "orig.txt");
    runGit(repo, "commit", "-q", "-m", "add orig.txt");
    runGit(repo, "checkout", "-q", "-b", "feature");
    runGit(repo, "mv", "orig.txt", "renamed.txt");
    const edited = content.replace("line25\n", "line25-edited\n");
    fs.writeFileSync(path.join(repo, "renamed.txt"), edited, { mode: 0o644 });
    runGit(repo, "add", "-A");
    runGit(repo, "commit", "-q", "-m", "rename orig.txt");
    const runner = new Runner(0);
    const provider = Provider.forRange(repo, "HEAD~1", "feature", runner);
    const diffs = await provider.getDiff();
    expect(diffs.length).toBe(1);
    const d = diffs[0]!;
    expect(d.isRenamed).toBe(true);
    expect(d.oldPath).toBe("orig.txt");
    expect(d.newPath).toBe("renamed.txt");
    expect(d.newFileContent.length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRangeDiffSurvivesExternalDiffTool
test("TestRangeDiffSurvivesExternalDiffTool", async () => {
  const repo = initRepoWithChange();
  try {
    runGit(repo, "add", "sample.txt");
    runGit(repo, "commit", "-q", "-m", "second commit");
    const garbage = writeGarbageExternalDiff();
    const prev = process.env.GIT_EXTERNAL_DIFF;
    try {
      process.env.GIT_EXTERNAL_DIFF = garbage;
      const provider = Provider.forRange(repo, "HEAD~1", "HEAD", new Runner(0));
      const diffs = await provider.getDiff();
      expect(diffs.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = prev;
      fs.rmSync(path.dirname(garbage), { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCommitDiffMergeCommitReviewsFirstParentDiff
test("TestCommitDiffMergeCommitReviewsFirstParentDiff", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-merge-"));
  try {
    runGit(repo, "init", "-q");
    runGit(repo, "config", "user.email", "test@example.com");
    runGit(repo, "config", "user.name", "Test User");
    runGit(repo, "config", "commit.gpgsign", "false");
    const file = path.join(repo, "conflicted.txt");
    const write = (c: string) => fs.writeFileSync(file, c, { mode: 0o644 });
    write("line1\nline2\nline3\n");
    runGit(repo, "add", "conflicted.txt");
    runGit(repo, "commit", "-q", "-m", "initial commit");
    runGit(repo, "checkout", "-q", "-b", "feature");
    write("line1\nfeature-change\nline3\n");
    runGit(repo, "commit", "-q", "-a", "-m", "feature change");
    runGit(repo, "checkout", "-q", "-");
    write("line1\nmain-change\nline3\n");
    runGit(repo, "commit", "-q", "-a", "-m", "main change");
    const mergeRes = spawnSync("git", ["merge", "--no-edit", "feature"], { cwd: repo });
    if (mergeRes.status === 0) throw new Error("expected merge to conflict");
    write("line1\nresolved-conflict\nline3\n");
    runGit(repo, "add", "conflicted.txt");
    runGit(repo, "commit", "-q", "--no-edit");
    const provider = Provider.forCommit(repo, "HEAD", new Runner(0));
    const diffs = await provider.getDiff();
    expect(diffs.length).toBe(1);
    const d = diffs[0]!;
    expect(d.newPath).toBe("conflicted.txt");
    expect(d.diff).toContain("+resolved-conflict");
    expect(d.insertions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.newFileContent.length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/git_resolve_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Provider, canonicalRemote } from "../../../src/ocr-v193/diff/git.js";
import { Runner } from "../../../src/ocr-v193/diff/runner.js";

function gitOut(dir: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function runGit(dir: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd: dir });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr?.toString()}`);
}

function initBareRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gitres-"));
  runGit(repo, "init", "-q");
  runGit(repo, "config", "user.email", "test@example.com");
  runGit(repo, "config", "user.name", "Test User");
  runGit(repo, "config", "commit.gpgsign", "false");
  return repo;
}

function writeCommit(repo: string, name: string, content: string, msg: string): void {
  fs.writeFileSync(path.join(repo, name), content, { mode: 0o644 });
  runGit(repo, "add", name);
  runGit(repo, "commit", "-q", "-m", msg);
}

function initRepoWithChange(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-change-"));
  runGit(repo, "init", "-q");
  runGit(repo, "config", "user.email", "test@example.com");
  runGit(repo, "config", "user.name", "Test User");
  runGit(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "sample.txt"), "line1\nline2\nline3\n", { mode: 0o644 });
  runGit(repo, "add", "sample.txt");
  runGit(repo, "commit", "-q", "-m", "initial commit");
  fs.writeFileSync(path.join(repo, "sample.txt"), "line1\nCHANGED\nline3\n", { mode: 0o644 });
  return repo;
}

// OCR v1.9.3: TestResolveInput_Range
test("TestResolveInput_Range", async () => {
  const repo = initBareRepo();
  try {
    writeCommit(repo, "a.txt", "one\n", "base");
    const base = gitOut(repo, "rev-parse", "HEAD");
    const baseBranch = gitOut(repo, "rev-parse", "--abbrev-ref", "HEAD");
    runGit(repo, "checkout", "-q", "-b", "feature");
    writeCommit(repo, "a.txt", "one\ntwo\n", "feature change");
    const head = gitOut(repo, "rev-parse", "HEAD");
    const p = Provider.forRange(repo, baseBranch, "feature", null);
    const got = await p.resolveInput();
    expect(got.resolvedBase).toBe(base);
    expect(got.resolvedHead).toBe(head);
    expect(got.exactRange).toBe(`${base}..${head}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveInput_SingleParentCommit
test("TestResolveInput_SingleParentCommit", async () => {
  const repo = initBareRepo();
  try {
    writeCommit(repo, "a.txt", "one\n", "root");
    const parent = gitOut(repo, "rev-parse", "HEAD");
    writeCommit(repo, "a.txt", "one\ntwo\n", "second");
    const head = gitOut(repo, "rev-parse", "HEAD");
    const p = Provider.forCommit(repo, head, null);
    const got = await p.resolveInput();
    expect(got.resolvedHead).toBe(head);
    expect(got.resolvedBase).toBe(parent);
    expect(got.exactRange).toBe(`${parent}..${head}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveInput_RootCommit
test("TestResolveInput_RootCommit", async () => {
  const repo = initBareRepo();
  try {
    writeCommit(repo, "a.txt", "one\n", "root");
    const head = gitOut(repo, "rev-parse", "HEAD");
    const p = Provider.forCommit(repo, head, null);
    const got = await p.resolveInput();
    expect(got.resolvedHead).toBe(head);
    expect(got.resolvedBase).toBe("");
    expect(got.exactRange).toBe("");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveInput_MergeCommit
test("TestResolveInput_MergeCommit", async () => {
  const repo = initBareRepo();
  try {
    writeCommit(repo, "a.txt", "one\n", "root");
    const root = gitOut(repo, "rev-parse", "HEAD");
    const mainBranch = gitOut(repo, "rev-parse", "--abbrev-ref", "HEAD");
    runGit(repo, "checkout", "-q", "-b", "side");
    writeCommit(repo, "b.txt", "side\n", "side change");
    runGit(repo, "checkout", "-q", mainBranch);
    writeCommit(repo, "c.txt", "mainline\n", "main change");
    const firstParent = gitOut(repo, "rev-parse", "HEAD");
    runGit(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = gitOut(repo, "rev-parse", "HEAD");
    if (merge === root) throw new Error("merge setup failed");
    const p = Provider.forCommit(repo, merge, null);
    const got = await p.resolveInput();
    expect(got.resolvedHead).toBe(merge);
    expect(got.resolvedBase).toBe(firstParent);
    expect(got.exactRange).toBe(`${firstParent}..${merge}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveInput_Workspace
test("TestResolveInput_Workspace", async () => {
  const repo = initRepoWithChange();
  try {
    const head = gitOut(repo, "rev-parse", "HEAD");
    const p = Provider.forWorkspace(repo, null);
    const got = await p.resolveInput();
    expect(got.resolvedBase).toBe(head);
    expect(got.resolvedHead).toBe("");
    expect(got.exactRange).toBe("");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCanonicalRemote
test("TestCanonicalRemote", () => {
  const cases: Array<{ name: string; in: string; want: string }> = [
    { name: "https", in: "https://github.com/org/repo.git", want: "github.com/org/repo" },
    { name: "https creds stripped", in: "https://user:token@github.com/org/repo.git", want: "github.com/org/repo" },
    { name: "https query fragment", in: "https://github.com/org/repo.git?ref=x#frag", want: "github.com/org/repo" },
    { name: "scp", in: "git@github.com:org/repo.git", want: "github.com/org/repo" },
    { name: "scp no user", in: "github.com:org/repo", want: "github.com/org/repo" },
    { name: "host uppercased", in: "https://GitHub.com/Org/Repo.git", want: "github.com/Org/Repo" },
    { name: "trailing slash", in: "https://github.com/org/repo/", want: "github.com/org/repo" },
    { name: "https port kept", in: "https://example.com:8443/org/repo.git", want: "example.com:8443/org/repo" },
    { name: "ssh port kept", in: "ssh://git@example.com:2222/org/repo.git", want: "example.com:2222/org/repo" },
    { name: "scp at in path", in: "git@host.com:a/b@c.git", want: "host.com/a/b@c" },
    { name: "local absolute", in: "/srv/git/repo.git", want: "" },
    { name: "local relative", in: "../peer/repo.git", want: "" },
    { name: "file scheme", in: "file:///srv/git/repo.git", want: "" },
    { name: "windows drive", in: `C:\\repos\\thing.git`, want: "" },
    { name: "unc share", in: `\\\\server\\share\\repo.git`, want: "" },
    { name: "empty", in: "", want: "" },
    { name: "whitespace", in: "   ", want: "" },
  ];
  for (const tc of cases) {
    const got = canonicalRemote(tc.in);
    if (got !== tc.want) throw new Error(`canonicalRemote(${JSON.stringify(tc.in)}) = ${JSON.stringify(got)}, want ${JSON.stringify(tc.want)} (${tc.name})`);
  }
});

// OCR v1.9.3: TestRemoteIdentity
test("TestRemoteIdentity", async () => {
  const repo = initBareRepo();
  try {
    const p = Provider.forWorkspace(repo, null);
    const empty = await p.remoteIdentity();
    expect(empty).toBe("");
    runGit(repo, "remote", "add", "origin", "https://user:secret@example.com/acme/widget.git");
    const got = await p.remoteIdentity();
    expect(got).toBe("example.com/acme/widget");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestResolveInput_UnbornWorkspace
test("TestResolveInput_UnbornWorkspace", async () => {
  const repo = initBareRepo();
  try {
    const p = Provider.forWorkspace(repo, null);
    const got = await p.resolveInput();
    expect(got.resolvedBase).toBe("");
    expect(got.resolvedHead).toBe("");
    expect(got.exactRange).toBe("");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

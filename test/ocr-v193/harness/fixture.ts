// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/git_test.go + internal/agent fixture helpers at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import type { FixtureMode } from "./types.js";

function gitSync(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", [...args], { cwd: repoDir, encoding: "utf-8", timeout: 10000 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr ?? res.stdout}`);
  }
  return (res.stdout ?? "").toString().trim();
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const p = spawn("git", [...args], { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(" ")} failed: ${err || out}`));
      else resolve(out.trim());
    });
  });
}

export interface TempRepo {
  readonly dir: string;
  readonly mode: FixtureMode;
  readonly baseCommit?: string;
  readonly headCommit?: string;
  /** Workspace mode fixture leaves changes unstaged/untracked. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Create a deterministic temp Git repo for workspace/range/commit fixtures.
 *
 * - Uses fixed clock (GIT_AUTHOR_DATE/GIT_COMMITTER_DATE) for deterministic SHAs.
 * - Uses argv arrays, no shell.
 * - Normalises tmp path handling via caller comparer (replaces <TMP>).
 */
export async function createTempRepo(opts: {
  mode: FixtureMode;
  fixedNowMs?: number;
  files?: Record<string, string>;
  extraCommits?: Array<{ message: string; change: (dir: string) => Promise<void> }>;
}): Promise<TempRepo> {
  const fixedMs = opts.fixedNowMs ?? Date.UTC(2026, 0, 1, 0, 0, 0);
  const dateISO = new Date(fixedMs).toISOString();
  const envDate = dateISO;

  const dir = await mkdtemp(join(tmpdir(), "ocr-harness-repo-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  gitSync(dir, ["init", "-q"]);
  gitSync(dir, ["config", "user.email", "harness@pi-reviewer.test"]);
  gitSync(dir, ["config", "user.name", "harness"]);
  gitSync(dir, ["config", "commit.gpgsign", "false"]);

  const initialFiles = opts.files ?? { "main.go": "package main\nfunc Add(a int, b int) int { return a + b }\n" };
  for (const [p, content] of Object.entries(initialFiles)) {
    const full = join(dir, p);
    await mkdir(join(full, ".."), { recursive: true }).catch(() => {});
    await writeFile(full, content, "utf-8");
  }
  const env = { ...process.env, GIT_AUTHOR_DATE: envDate, GIT_COMMITTER_DATE: envDate };
  let res = spawnSync("git", ["add", "-A"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git add failed: ${res.stderr}`);
  res = spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr}`);

  let baseCommit = gitSync(dir, ["rev-parse", "HEAD"]);
  let headCommit = baseCommit;

  // Extra commits for range fixtures
  if (opts.extraCommits && opts.extraCommits.length > 0) {
    for (const c of opts.extraCommits) {
      await c.change(dir);
      const r2 = spawnSync("git", ["add", "-A"], { cwd: dir, env, encoding: "utf-8" });
      if (r2.status !== 0) throw new Error(`git add failed: ${r2.stderr}`);
      const commitRes = spawnSync("git", ["commit", "-q", "-m", c.message], { cwd: dir, env, encoding: "utf-8" });
      if (commitRes.status !== 0) {
        // allow empty commit? but we treat as failure
        throw new Error(`git commit ${c.message} failed: ${commitRes.stderr}`);
      }
    }
    headCommit = gitSync(dir, ["rev-parse", "HEAD"]);
  }

  if (opts.mode === "workspace") {
    // Leave workspace changes deterministic (unstaged + untracked)
    // Create a workspace change: modify main.go and add untracked
    // Caller may override via later mutation helpers
  }

  return { dir, mode: opts.mode, baseCommit, headCommit, cleanup };
}

/** Helper: mutate repo to create workspace diff (unstaged + untracked). */
export async function applyWorkspaceChanges(repoDir: string, changes: Record<string, string | null>): Promise<void> {
  for (const [p, content] of Object.entries(changes)) {
    const full = join(repoDir, p);
    if (content === null) {
      await rm(full, { force: true }).catch(() => {});
      // stage deletion? workspace means unstaged deletion — leave as removed file not staged?
      // Use git rm --cached? Instead we just remove file to produce diff.
      // For simplicity, remove and not stage (shows as deleted unstaged if tracked).
    } else {
      await mkdir(join(full, ".."), { recursive: true }).catch(() => {});
      await writeFile(full, content, "utf-8");
    }
  }
}

/** Helper: get repo-relative diff summary for debugging (argv array, no shell). */
export async function repoGitLog(repoDir: string): Promise<string> {
  return git(repoDir, ["log", "--oneline", "-n", "10"]);
}

export async function readRepoFile(repoDir: string, relPath: string): Promise<string> {
  return readFile(join(repoDir, relPath), "utf-8");
}

/** Deterministic clock patch for harness — replaces Date.now() with fixedMs during fn. */
export async function withFixedClock<T>(fixedMs: number, fn: () => Promise<T>): Promise<T> {
  const origNow = Date.now;
  const origDate = globalThis.Date;
  // We patch Date.now only; full Date mock would require vitest fake timers. Keep simple.
  // @ts-ignore
  Date.now = () => fixedMs;
  try {
    return await fn();
  } finally {
    // @ts-ignore
    Date.now = origNow;
    // global Date stays original
    void origDate;
  }
}

export function normalizeTmpPath(text: string, rawTmp: string): string {
  if (!rawTmp) return text;
  return text.split(rawTmp).join("<TMP>");
}

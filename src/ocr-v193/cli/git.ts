// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/git.go and cmd/opencodereview/review_cmd.go
// (resolveRepoDir, requireGitRepo, validateReviewRefs, buildToolRegistry, getCommitMessage)
// at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later; see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { CliUsageError } from "./shared.js";
import { Registry } from "../tool/definitions.js";
import { FileReader, DiffMap, FileReadProvider, FileFindProvider, FileReadDiffProvider, CodeSearchProvider } from "../tool/filereader.js";
import { CodeCommentProvider } from "../tool/code-comment.js";
import { ReviewMode } from "../tool/filereader.js";
import { resolveWorkingDir } from "./shared.js";
import type { CommentCollector } from "../tool/collector.js";

// ---------------------------------------------------------------------------
// Internal git execution helper — argv arrays, typed result, no string parsing
// ---------------------------------------------------------------------------

interface GitExecResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly combined: string;
}

function execGit(repoDir: string, args: readonly string[]): GitExecResult {
  const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "buffer", timeout: 10_000 }) as unknown as {
    status: number | null;
    stdout: Buffer | null;
    stderr: Buffer | null;
    error?: Error;
  };
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed in ${repoDir}: ${String(result.error.message)}`);
  }
  const stdoutBuf = (result.stdout as Buffer | null) ?? Buffer.alloc(0);
  const stderrBuf = (result.stderr as Buffer | null) ?? Buffer.alloc(0);
  const stdout = stdoutBuf.toString("utf8");
  const stderr = stderrBuf.toString("utf8");
  const combined = Buffer.concat([stdoutBuf, stderrBuf]).toString("utf8").trim();
  return { status: result.status, stdout, stderr, combined };
}

// ---------------------------------------------------------------------------
// runGitCmd / runGitCmdStdout — mirrors Go runGitCmd / runGitCmdStdout
// ---------------------------------------------------------------------------

export function runGitCmd(repoDir: string, ...args: string[]): Buffer {
  const r = execGit(repoDir, args);
  if ((r.status ?? 1) !== 0) {
    const detail = r.combined !== "" ? `: ${r.combined}` : "";
    throw new Error(`git ${args.join(" ")} failed in ${repoDir}${detail}`);
  }
  return Buffer.from(r.stdout, "utf8");
}

export function runGitCmdStdout(repoDir: string, ...args: string[]): Buffer {
  const r = execGit(repoDir, args);
  if ((r.status ?? 1) !== 0) {
    const detail = r.stderr.trim() !== "" ? `: ${r.stderr.trim()}` : "";
    throw new Error(`git ${args.join(" ")} failed in ${repoDir}${detail}`);
  }
  return Buffer.from(r.stdout, "utf8");
}

// ---------------------------------------------------------------------------
// getCommitMessage — single source of truth, argv array with --end-of-options
// ---------------------------------------------------------------------------

export function getCommitMessage(repoDir: string, commit: string): string {
  const r = execGit(repoDir, ["log", "-1", "--format=%B", "--end-of-options", commit]);
  if ((r.status ?? 1) !== 0) {
    const detail = r.combined !== "" ? `: ${r.combined}` : "";
    throw new Error(`git log failed${detail}`);
  }
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// resolveRepoDir / requireGitRepo — mirrors Go helpers
// ---------------------------------------------------------------------------

export function resolveRepoDir(input: string): string {
  const { absPath } = resolveWorkingDir(input, true);
  return absPath;
}

export function requireGitRepo(dir: string): void {
  let abs: string;
  try {
    abs = path.resolve(dir);
  } catch (e) {
    throw new Error(`resolve path: ${String((e as Error).message)}`);
  }
  const r = execGit(abs, ["rev-parse", "--git-dir"]);
  if ((r.status ?? 1) !== 0 || r.stdout.trim().length === 0) {
    throw new Error(`${abs} is not a git repository, code review requires a valid git repository`);
  }
}

// ---------------------------------------------------------------------------
// validateReviewRefs — rejects injection before any ref-bearing Git command
// ---------------------------------------------------------------------------

export function validateReviewRefs(repoDir: string, opts: { from?: string; to?: string; commit?: string }): void {
  const refs: Array<{ flag: string; ref: string }> = [
    { flag: "--from", ref: opts.from ?? "" },
    { flag: "--to", ref: opts.to ?? "" },
    { flag: "--commit", ref: opts.commit ?? "" },
  ];
  for (const item of refs) {
    const ref = item.ref;
    if (ref === "") continue;
    if (ref.startsWith("-")) {
      throw new CliUsageError(`${item.flag} value "${ref}" is not a valid git ref: refs must not start with '-'`);
    }
    const verifyRef = `${ref}^{commit}`;
    const r = execGit(repoDir, ["rev-parse", "--verify", "--end-of-options", verifyRef]);
    if ((r.status ?? 1) !== 0) {
      const gitOut = r.combined;
      if (gitOut !== "") {
        throw new Error(`${item.flag} value "${ref}" is not a valid commit ref: ${gitOut}`);
      }
      throw new Error(`${item.flag} value "${ref}" is not a valid commit ref`);
    }
  }
}

// ---------------------------------------------------------------------------
// buildToolRegistry — production review registry builder
// ---------------------------------------------------------------------------

export function buildToolRegistry(
  collector: CommentCollector | null,
  fileReader: FileReader | null,
): Registry {
  const reg = new Registry();
  // FileReader may be null in the upstream unit test; still register providers.
  // Use a minimal dummy when null so constructors don't throw.
  let fr: FileReader;
  if (fileReader !== null && fileReader !== undefined) {
    fr = fileReader;
  } else {
    fr = new FileReader({ RepoDir: "", Mode: ReviewMode.ModeWorkspace, Ref: "" });
  }
  const diffMap = new DiffMap(new Map<string, string>());
  reg.Register(new FileReadProvider(fr));
  reg.Register(new FileFindProvider(fr));
  reg.Register(new FileReadDiffProvider(diffMap));
  reg.Register(new CodeSearchProvider(fr));
  reg.Register(new CodeCommentProvider(collector));
  return reg;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/git.go and cmd/opencodereview/review_cmd.go
// (resolveRepoDir, requireGitRepo, validateReviewRefs, buildToolRegistry)
// at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later; see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { CliUsageError } from "./shared.js";
import { Registry } from "../tool/definitions.js";
import { FileReader, DiffMap, FileReadProvider, FileFindProvider, FileReadDiffProvider, CodeSearchProvider } from "../tool/filereader.js";
import { CodeCommentProvider } from "../tool/code-comment.js";
import { ReviewMode } from "../tool/filereader.js";
import { resolveWorkingDir } from "./shared.js";

// Re-export getCommitMessage from background for single source of truth, but also
// provide a direct implementation here to keep this module self-contained.
export { getCommitMessage } from "./background.js";
import { getCommitMessage as bgGetCommitMessage } from "./background.js";

/**
 * runGitCmd executes `git -C <repoDir> <args...>` via argv array (no shell).
 * Returns stdout (combined output buffered) on success; throws on failure
 * preserving command/path/error context.
 * Mirrors Go `runGitCmd(repoDir string, args ...string) ([]byte, error)` with
 * CombinedOutput semantics.
 */
export function runGitCmd(repoDir: string, ...args: string[]): Buffer {
  const fullArgs = ["-C", repoDir, ...args];
  const result = spawnSync("git", fullArgs, { encoding: "buffer", timeout: 10_000 }) as unknown as {
    status: number | null;
    stdout: Buffer | null;
    stderr: Buffer | null;
    error?: Error;
  };
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed in ${repoDir}: ${String(result.error.message)}`);
  }
  const stdout = (result.stdout as Buffer | null) ?? Buffer.alloc(0);
  const stderr = (result.stderr as Buffer | null) ?? Buffer.alloc(0);
  const status = result.status ?? 1;
  if (status !== 0) {
    const combined = Buffer.concat([stdout, stderr]).toString("utf8").trim();
    const detail = combined !== "" ? `: ${combined}` : "";
    throw new Error(`git ${args.join(" ")} failed in ${repoDir}${detail}`);
  }
  // Go's CombinedOutput returns stdout+stderr; for rev-parse success stderr is empty,
  // so returning stdout is equivalent. Preserve stdout for callers that check length.
  return stdout;
}

/**
 * runGitCmdStdout executes git and returns stdout only, mirroring Go `runGitCmdStdout`.
 * Stderr is ignored (so warnings don't pollute resolved paths).
 */
export function runGitCmdStdout(repoDir: string, ...args: string[]): Buffer {
  const fullArgs = ["-C", repoDir, ...args];
  const result = spawnSync("git", fullArgs, { encoding: "buffer", timeout: 10_000 }) as unknown as {
    status: number | null;
    stdout: Buffer | null;
    stderr: Buffer | null;
    error?: Error;
  };
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed in ${repoDir}: ${String(result.error.message)}`);
  }
  const status = result.status ?? 1;
  if (status !== 0) {
    const stderr = (result.stderr as Buffer | null)?.toString("utf8").trim() ?? "";
    const detail = stderr !== "" ? `: ${stderr}` : "";
    throw new Error(`git ${args.join(" ")} failed in ${repoDir}${detail}`);
  }
  return (result.stdout as Buffer | null) ?? Buffer.alloc(0);
}

/**
 * getCommitMessage re-exported wrapper that delegates to background.ts implementation
 * to keep single source. This wrapper exists so git_test can import from this module.
 */
export function getCommitMessageLocal(repoDir: string, commit: string): string {
  return bgGetCommitMessage(repoDir, commit);
}

/**
 * resolveRepoDir resolves the repo dir for `ocr review` / `ocr rules check`.
 * Delegates to resolveWorkingDir(requireGit=true) so it anchors at the git top-level
 * just like review path. Mirrors Go `resolveRepoDir(input string) (string, error)`.
 */
export function resolveRepoDir(input: string): string {
  const { absPath } = resolveWorkingDir(input, true);
  return absPath;
}

/**
 * requireGitRepo validates that the given directory is part of a git repository.
 * Mirrors Go `requireGitRepo(dir string) error`.
 * Uses argv array `git -C <dir> rev-parse --git-dir` with no shell.
 */
export function requireGitRepo(dir: string): void {
  let abs: string;
  try {
    abs = path.resolve(dir);
  } catch (e) {
    throw new Error(`resolve path: ${String((e as Error).message)}`);
  }
  // Use --end-of-options not needed for rev-parse --git-dir (no ref), but keep argv safe.
  let out: Buffer;
  try {
    out = runGitCmd(abs, "rev-parse", "--git-dir");
  } catch {
    throw new Error(`${abs} is not a git repository, code review requires a valid git repository`);
  }
  if (out.length === 0 || out.toString("utf8").trim().length === 0) {
    throw new Error(`${abs} is not a git repository, code review requires a valid git repository`);
  }
}

/**
 * validateReviewRefs rejects ref-option injection and verifies refs are valid commits.
 * Mirrors Go `validateReviewRefs(repoDir string, opts reviewOptions) error`.
 * Uses `git -C <repoDir> rev-parse --verify --end-of-options <ref>^{commit}` via argv.
 */
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
    // Verify ref is a valid commit via git.
    const verifyRef = `${ref}^{commit}`;
    try {
      runGitCmd(repoDir, "rev-parse", "--verify", "--end-of-options", verifyRef);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Extract git output after colon for fidelity: Go trims CombinedOutput and appends if non-empty.
      // Our runGitCmd error is `git rev-parse ... failed in <dir>: <combined>`.
      // Extract the trailing combined part after the last ": ".
      const colonIdx = raw.lastIndexOf(": ");
      const gitOut = colonIdx >= 0 ? raw.slice(colonIdx + 2).trim() : "";
      if (gitOut !== "") {
        throw new Error(`${item.flag} value "${ref}" is not a valid commit ref: ${gitOut}`);
      }
      throw new Error(`${item.flag} value "${ref}" is not a valid commit ref`);
    }
  }
}

/**
 * buildToolRegistry mirrors Go `buildToolRegistry(collector *tool.CommentCollector, fr *tool.FileReader) *tool.Registry`.
 * Returns a non-nil Registry with the five core providers registered even when
 * collector/fileReader are null (as in the upstream test).
 */
export function buildToolRegistry(collector?: unknown, fileReader?: unknown): Registry {
  const reg = new Registry();
  // Provide dummy FileReader when null so providers can be instantiated.
  let fr: FileReader;
  if (fileReader !== null && fileReader !== undefined && typeof (fileReader as FileReader).RepoDir === "string") {
    fr = fileReader as FileReader;
  } else {
    fr = new FileReader({ RepoDir: "", Mode: ReviewMode.ModeWorkspace, Ref: "" });
  }
  const diffMap = new DiffMap(new Map<string, string>());
  // Import types lazily to avoid circular? Already imported.
  reg.Register(new FileReadProvider(fr));
  reg.Register(new FileFindProvider(fr));
  reg.Register(new FileReadDiffProvider(diffMap));
  reg.Register(new CodeSearchProvider(fr));
  // CodeCommentProvider expects collector or null.
  const coll = (collector as unknown) ?? null;
  reg.Register(new CodeCommentProvider(coll as never));
  return reg;
}

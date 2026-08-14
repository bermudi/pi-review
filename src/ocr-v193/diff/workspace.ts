// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/workspace_file.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Safe workspace file reader — mirrors Go `readWorkspaceFileForDiff`.
 * Enforces repository-relative paths, rejects absolute/traversal inputs,
 * respects symlinks (returns link target instead of following external
 * content), and prevents directory escapes via parent dir symlink tricks.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants as fsConstants } from "node:fs";

// ---------------------------------------------------------------------------
// Path utilities — mirrors internal/pathutil/path.go
// ---------------------------------------------------------------------------

/**
 * CanonicalPath returns an absolute path with symlinks resolved.
 * Mirrors Go `pathutil.CanonicalPath`.
 */
export async function canonicalPath(p: string): Promise<string> {
  const abs = path.resolve(p);
  // fs.realpath resolves symlinks; throws if path does not exist (like Go's EvalSymlinks).
  return await fs.realpath(abs);
}

/**
 * WithinBase reports whether target is base itself or contained under base.
 * Mirrors Go `pathutil.WithinBase` using path.relative semantics.
 */
export function withinBase(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  if (rel === "") return true; // same path (Go's rel == ".")
  // Go: rel == "." || (rel != ".." && !HasPrefix(rel, ".."+sep))
  // In Node, path.relative returns "" for same, not ".", but we handled.
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  // Mixed abs/rel produces a relative like "../..." or absolute — also captured.
  // For safety, if rel is absolute (different roots on Windows), it is not within base.
  if (path.isAbsolute(rel)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a repository-relative file for diff construction.
 * Mirrors Go `readWorkspaceFileForDiff`. On success returns the raw file bytes
 * (or symlink target bytes for a symlink); on failure throws with a
 * descriptive message matching Go's error strings for test compatibility.
 */
export async function readWorkspaceFileForDiff(repoDir: string, relPath: string): Promise<Buffer> {
  let repoRoot: string;
  try {
    repoRoot = await canonicalPath(repoDir);
  } catch (e) {
    throw new Error(`resolve repository path ${JSON.stringify(repoDir)}: ${String((e as Error).message)}`);
  }

  if (path.isAbsolute(relPath)) {
    throw new Error(`file path ${JSON.stringify(relPath)} must be relative, not absolute`);
  }

  const fullPath = path.join(repoRoot, relPath);
  if (!withinBase(repoRoot, fullPath)) {
    throw new Error(`file path ${JSON.stringify(relPath)} is outside repository`);
  }

  // Resolve parent dir symlinks — prevents a symlinked parent that escapes.
  let parentReal: string;
  try {
    parentReal = await fs.realpath(path.dirname(fullPath));
  } catch (e) {
    throw new Error(`resolve parent path for ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
  }
  if (!withinBase(repoRoot, parentReal)) {
    throw new Error(`file path ${JSON.stringify(relPath)} is outside repository`);
  }

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(fullPath);
  } catch (e) {
    throw new Error(`stat file ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
  }

  if (stat.isDirectory()) {
    throw new Error(`file path ${JSON.stringify(relPath)} is a directory`);
  }

  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = await fs.readlink(fullPath);
    } catch (e) {
      throw new Error(`read symlink ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
    }
    // Mirror Go: return symlink target path bytes, not file content.
    return Buffer.from(target, "utf-8");
  }

  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(fullPath);
  } catch (e) {
    throw new Error(`resolve file ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
  }
  if (!withinBase(repoRoot, resolvedPath)) {
    throw new Error(`file path ${JSON.stringify(relPath)} is outside repository`);
  }

  try {
    // Verify readability mirroring Go's os.ReadFile permission checks.
    await fs.access(resolvedPath, fsConstants.R_OK);
    return await fs.readFile(resolvedPath);
  } catch (e) {
    throw new Error(`read file ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
  }
}

/**
 * Sync variant for callers that already hold a sync context (e.g. tests).
 * Uses `node:fs` sync APIs to preserve exact semantics.
 */
export function readWorkspaceFileForDiffSync(repoDir: string, relPath: string): Buffer {
  // Lazy import sync APIs to avoid top-level fs sync import in async bundling.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require("node:fs") as typeof import("node:fs");
  const pathSync = require("node:path") as typeof import("node:path");

  let repoRoot: string;
  try {
    repoRoot = fsSync.realpathSync(pathSync.resolve(repoDir));
  } catch (e) {
    throw new Error(`resolve repository path ${JSON.stringify(repoDir)}: ${String((e as Error).message)}`);
  }

  if (pathSync.isAbsolute(relPath)) {
    throw new Error(`file path ${JSON.stringify(relPath)} must be relative, not absolute`);
  }

  const fullPath = pathSync.join(repoRoot, relPath);
  if (!withinBase(repoRoot, fullPath)) {
    throw new Error(`file path ${JSON.stringify(relPath)} is outside repository`);
  }

  let parentReal: string;
  try {
    parentReal = fsSync.realpathSync(pathSync.dirname(fullPath));
  } catch (e) {
    throw new Error(`resolve parent path for ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
  }
  if (!withinBase(repoRoot, parentReal)) {
    throw new Error(`file path ${JSON.stringify(relPath)} is outside repository`);
  }

  let stat: import("node:fs").Stats;
  try {
    stat = fsSync.lstatSync(fullPath);
  } catch (e) {
    throw new Error(`stat file ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
  }

  if (stat.isDirectory()) {
    throw new Error(`file path ${JSON.stringify(relPath)} is a directory`);
  }

  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = fsSync.readlinkSync(fullPath);
    } catch (e) {
      throw new Error(`read symlink ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
    }
    return Buffer.from(target, "utf-8");
  }

  let resolvedPath: string;
  try {
    resolvedPath = fsSync.realpathSync(fullPath);
  } catch (e) {
    throw new Error(`resolve file ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
  }
  if (!withinBase(repoRoot, resolvedPath)) {
    throw new Error(`file path ${JSON.stringify(relPath)} is outside repository`);
  }

  try {
    return fsSync.readFileSync(resolvedPath);
  } catch (e) {
    throw new Error(`read file ${JSON.stringify(relPath)}: ${String((e as Error).message)}`);
  }
}

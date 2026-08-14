// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/gitignore.go and internal/diff/git.go
// (gitignore helpers) at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Gitignore and excluded-dir helpers — mirrors Go `gitignore.go` +
 * the gitignore-related helpers in `git.go`.
 *
 * Ordering semantics (last-match-wins) and polarity handling are preserved
 * so reviews with "allow-list" gitignores (ignore everything, re-include with
 * `!`) do not silently exclude every file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Hardcoded directory blocklist — mirrors Go `providerDirIgnoreDirs`.
// ---------------------------------------------------------------------------

export const providerDirIgnoreDirs: readonly string[] = [
  ".idea/",
  ".vscode/",
  ".svn/",
  ".git/",
  "vendor/",
  "node_modules/",
  "target/",
  ".happypack/",
  ".cachefile/",
  "_packages/",
  "rpm/",
  "pkgs/",
] as const;

// ---------------------------------------------------------------------------
// Public surface — mirrors Go `ExcludedDirs` / `LoadGitignorePatterns` /
// `IsPathExcluded` / `MatchGitignorePattern`
// ---------------------------------------------------------------------------

export function excludedDirs(): string[] {
  return [...providerDirIgnoreDirs];
}

export const ExcludedDirs = excludedDirs;

export function loadGitignorePatterns(repoDir: string): string[] | null {
  let data: string;
  try {
    data = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf-8");
  } catch {
    return null;
  }
  const patterns: string[] = [];
  for (const raw of data.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    patterns.push(line);
  }
  return patterns;
}

export const LoadGitignorePatterns = loadGitignorePatterns;

export function isPathExcluded(relPath: string, gitignorePatterns: string[] | null | undefined): boolean {
  const patterns = gitignorePatterns ?? [];

  // Hardcoded prefix checks — unconditional blocklist; ! cannot re-admit.
  for (const prefix of providerDirIgnoreDirs) {
    const dirPart = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (relPath === dirPart || relPath.startsWith(prefix)) return true;
  }

  let excluded = false;
  for (const pat of patterns) {
    let body = pat;
    let negated = false;
    if (body.startsWith("!")) {
      body = body.slice(1);
      negated = true;
    }
    if (body === "") continue;

    // Directory-only negations (`!*/`) are ignored — they re-admit descent,
    // not file inclusion.
    if (negated && body.endsWith("/")) continue;

    if (matchGitignoreBody(relPath, body)) {
      excluded = !negated;
    }
  }
  return excluded;
}

export const IsPathExcluded = isPathExcluded;

/**
 * IsPathExcludedWithRepo — convenience wrapper that mirrors Go's
 * `IsPathExcluded(repoDir, relPath, patterns)` signature used by scan.
 * The repoDir param is accepted for API symmetry but not used beyond
 * blocklist semantics (already covered).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function isPathExcludedWithRepo(_repoDir: string, relPath: string, patterns: string[] | null): boolean {
  return isPathExcluded(relPath, patterns);
}

export function matchGitignorePattern(relPath: string, pat: string): boolean {
  if (pat.startsWith("!")) return false;
  return matchGitignoreBody(relPath, pat);
}

export const MatchGitignorePattern = matchGitignorePattern;

// ---------------------------------------------------------------------------
// Internal helpers — mirrors Go `matchGitignoreBody` / `matchGitignoreDirectory`
// ---------------------------------------------------------------------------

export function matchGitignoreBody(relPath: string, body: string): boolean {
  // Directory-only patterns (trailing "/")
  if (body.endsWith("/")) {
    const pattern = body.slice(0, -1);
    return matchGitignoreDirectory(relPath, pattern);
  }

  // Leading "/" anchors to repo root
  let anchored = false;
  if (body.startsWith("/")) {
    body = body.slice(1);
    anchored = true;
  }

  // "**" requires globstar semantics — delegate to minimatch (doublestar in Go).
  if (body.includes("**")) {
    try {
      return minimatch(relPath, body, { dot: true });
    } catch {
      return false;
    }
  }

  // Patterns without "/" match basename — unless anchored (root-only).
  if (!body.includes("/")) {
    const target = anchored ? relPath : path.posix.basename(relPath);
    try {
      return minimatch(target, body, { dot: true });
    } catch {
      return false;
    }
  }

  // Patterns with "/" match full relative path
  try {
    if (minimatch(relPath, body, { dot: true })) return true;
  } catch {
    // ignore
  }
  // Suffix of path, but not for anchored patterns. Ensure component boundary.
  if (!anchored && relPath.endsWith(`/${body}`)) return true;

  return false;
}

function matchGitignoreDirectory(relPath: string, pattern: string): boolean {
  let anchored = false;
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
    anchored = true;
  }
  if (pattern === "") return false;

  const lastSlash = relPath.lastIndexOf("/");
  if (lastSlash < 0) return false;

  const components = relPath.slice(0, lastSlash).split("/");

  const matchFullPath = anchored || pattern.includes("/");

  for (let i = 0; i < components.length; i++) {
    let candidate: string;
    if (matchFullPath) candidate = components.slice(0, i + 1).join("/");
    else candidate = components[i]!;

    try {
      if (minimatch(candidate, pattern, { dot: true })) return true;
    } catch {
      // ignore bad pattern
    }
  }
  return false;
}

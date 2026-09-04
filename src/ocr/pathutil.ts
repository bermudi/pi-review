// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/pathutil/path.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Confinement hardening (same-file parent walk for case-insensitive / alias
// paths) surgically adopted from OCR 124bfc3 (isolated adoption; frozen
// v1.9.9 baseline unchanged otherwise).
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

/**
 * CanonicalPath returns an absolute path with symlinks resolved.
 * Mirrors Go `pathutil.CanonicalPath` (Abs + EvalSymlinks). Throws on
 * non-existent path, matching Go's error contract.
 */
export async function canonicalPath(p: string): Promise<string> {
  const abs = path.resolve(p);
  return await fs.realpath(abs);
}

/**
 * Sync variant, mirrors canonicalPath but uses sync APIs.
 */
export function canonicalPathSync(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathSync = require("node:path") as typeof import("node:path");
  const abs = pathSync.resolve(p);
  return fsSync.realpathSync(abs);
}

/**
 * WithinBase reports whether target is base itself or contained under base.
 * Mirrors Go `pathutil.WithinBase` with 124bfc3 hardening:
 *   rel, err := filepath.Rel(base, target)
 *   if err != nil { rel = ".." }
 *   if rel == "." || (rel != ".." && !HasPrefix(rel, ".."+sep)) { return true }
 *   return sameFileWithinBase(base, target)
 *
 * In Node, path.relative never errors on POSIX, but Go errors on mixed
 * absolute/relative inputs and volume mismatches (Windows). We replicate the
 * error branch via sameFileWithinBase (which requires both absolute).
 */
export function withinBase(base: string, target: string): boolean {
  // Replicate Go's Rel error branch: mixed abs/rel cannot be related via
  // string check; fall through to same-file check (which also returns false).
  if (path.isAbsolute(base) !== path.isAbsolute(target)) {
    return sameFileWithinBase(base, target);
  }
  const rel = path.relative(base, target);
  if (rel === "" || rel === ".") return true;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return sameFileWithinBase(base, target);
  }
  return true;
}

/**
 * sameFileWithinBase walks target up to the filesystem root and reports whether
 * any level is the same file as base (dev+ino comparison).
 * Mirrors Go `sameFileWithinBase` (os.Stat + os.SameFile walk).
 * Catches Windows case-insensitive aliasing and symlink/hardlink aliases where
 * the string prefix check fails but the inode is the same.
 */
export function sameFileWithinBase(base: string, target: string): boolean {
  if (!path.isAbsolute(base) || !path.isAbsolute(target)) return false;
  // Windows: filesystem is case-insensitive; allow case-alias via string check
  // before inode walk (Node ino may be 0 on some Windows setups).
  if (process.platform === "win32") {
    const lowerBase = base.toLowerCase();
    const lowerTarget = target.toLowerCase();
    if (lowerTarget === lowerBase || lowerTarget.startsWith(lowerBase + path.sep)) return true;
  }
  let baseStat: fsSync.Stats;
  try {
    baseStat = fsSync.statSync(base);
  } catch {
    return false;
  }
  let cur = target;
  for (;;) {
    try {
      const info = fsSync.statSync(cur);
      if (info.dev === baseStat.dev && info.ino === baseStat.ino) return true;
    } catch {
      // Missing intermediate level: keep walking up (matches Go Stat error continue).
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

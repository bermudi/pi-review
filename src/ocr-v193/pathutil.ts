// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/pathutil/path.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import * as fs from "node:fs/promises";
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
 * Mirrors Go `pathutil.WithinBase`:
 *   rel, err := filepath.Rel(base, target)
 *   if err != nil { return false }
 *   return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+sep))
 *
 * In Node, path.relative never errors on POSIX, but Go errors on mixed
 * absolute/relative inputs and volume mismatches (Windows). We replicate the
 * error branch by returning false when base/target absolute-ness differs, and
 * when relative result is absolute (different root).
 */
export function withinBase(base: string, target: string): boolean {
  // Replicate Go's Rel error branch: mixed abs/rel cannot be related.
  if (path.isAbsolute(base) !== path.isAbsolute(target)) {
    return false;
  }
  const rel = path.relative(base, target);
  if (rel === "") return true;
  // Go checks rel == "." for same-directory after cleaning; Node returns "".
  if (rel === ".") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  // On POSIX this covers ".." prefix already; also guard absolute rel (Windows volume mismatch).
  if (path.isAbsolute(rel)) return false;
  return true;
}

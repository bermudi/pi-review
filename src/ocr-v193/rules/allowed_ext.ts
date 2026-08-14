// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/allowlist/allowed_ext.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * OCR v1.9.3 allowlist engine — TypeScript port of internal/config/allowlist/allowed_ext.go.
 *
 * Responsibilities:
 * - Loads the embedded supported_file_types.json and default_exclude_patterns.json
 *   (verbatim imports of the upstream allowlist data, hash-frozen per the
 *   reference manifest).
 * - Exposes IsAllowedExt / IsExcludedPath with case-insensitive matching,
 *   matching the Go implementation which lowercases both the extension/path
 *   and the stored allowlist entries before comparison.
 * - Pattern matching for excludes uses doublestar-compatible glob semantics:
 *   `*` (single segment), `**` (recursive), and `{a,b,c}` brace expansion.
 *   The TypeScript port uses `minimatch` with `dot:true` which is the
 *   closest public package to `bmatcuk/doublestar/v4` and is already the
 *   selection-engine glob in this repository. Behaviour is verified via the
 *   upstream `allowed_ext_test.go` fixture set ported in `test/ocr-v193`.
 *
 * No import from legacy `src/selection.ts` — this is the parity path.
 *
 * The JSON files are byte-identical to upstream; their provenance is recorded
 * in the adjacent `PROVENANCE.json` and this file's frozen hash table — not
 * inside the JSON bytes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Frozen hashes — must match the pinned v1.9.3 checkout (4d796ae..., c35ddd...)
// computed via `sha256sum` on the original files. The loader verifies them
// when verifyHashes is true (default); `bun test` must fail if the JSON bytes
// diverge.
// ---------------------------------------------------------------------------

export const EXPECTED_SUPPORTED_FILE_TYPES_HASH =
  "461152c7eba4010c8d7a84cb1e8182cf31fe58c62f95561be8829998f7bd4b7e";

export const EXPECTED_DEFAULT_EXCLUDE_PATTERNS_HASH =
  "93d96d1e3683d68d9e73ef35a955445e64d53dd9c48cc008356801928ee385c5";

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

export function sha256Hex(data: string | Uint8Array | Buffer): string {
  const h = crypto.createHash("sha256");
  if (typeof data === "string") h.update(Buffer.from(data, "utf-8"));
  else h.update(data as Uint8Array);
  return h.digest("hex");
}

function sha256HexFile(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return sha256Hex(bytes);
}

function verifyFileHash(filePath: string, expected: string, label: string): void {
  const actual = sha256HexFile(filePath);
  if (actual !== expected) {
    throw new Error(
      `hash mismatch for ${label}: expected ${expected}, got ${actual} (file: ${filePath})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Directory resolution — mirrors template.ts resolveTemplateDir
// ---------------------------------------------------------------------------

function resolveRulesDir(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const candidates: string[] = [];
  const maybeDir = (import.meta as unknown as { dir?: string }).dir;
  if (maybeDir !== undefined) candidates.push(maybeDir);
  candidates.push(path.join(process.cwd(), "src/ocr-v193/rules"));
  candidates.push(path.resolve("src/ocr-v193/rules"));
  for (const c of candidates) {
    const probe = path.join(c, "supported_file_types.json");
    if (fs.existsSync(probe)) return c;
  }
  return candidates[0] ?? path.join(process.cwd(), "src/ocr-v193/rules");
}

// ---------------------------------------------------------------------------
// Core state — mirrors Go's sync.Once initMap / initExclude
// ---------------------------------------------------------------------------

let supportedSet: ReadonlySet<string> | null = null;
let supportedList: readonly string[] | null = null;
let excludePatterns: readonly string[] | null = null;

function ensureSupportedLoaded(rulesDir?: string, verifyHashes = true): void {
  if (supportedSet !== null && supportedList !== null) return;
  const dir = resolveRulesDir(rulesDir);
  const filePath = path.join(dir, "supported_file_types.json");
  if (verifyHashes) {
    verifyFileHash(filePath, EXPECTED_SUPPORTED_FILE_TYPES_HASH, "supported_file_types.json");
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`read embedded supported_file_types.json: ${String((e as Error).message)}`);
  }
  let exts: unknown;
  try {
    exts = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(`unmarshal supported_file_types.json: ${String((e as Error).message)}`);
  }
  if (!Array.isArray(exts)) {
    throw new Error("supported_file_types.json: expected array");
  }
  const lowered: string[] = [];
  const set = new Set<string>();
  for (const entry of exts) {
    if (typeof entry !== "string") continue;
    const low = entry.toLowerCase();
    lowered.push(entry);
    set.add(low);
  }
  supportedSet = set;
  supportedList = lowered;
}

function ensureExcludeLoaded(rulesDir?: string, verifyHashes = true): void {
  if (excludePatterns !== null) return;
  const dir = resolveRulesDir(rulesDir);
  const filePath = path.join(dir, "default_exclude_patterns.json");
  if (verifyHashes) {
    verifyFileHash(filePath, EXPECTED_DEFAULT_EXCLUDE_PATTERNS_HASH, "default_exclude_patterns.json");
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`read embedded default_exclude_patterns.json: ${String((e as Error).message)}`);
  }
  let arr: unknown;
  try {
    arr = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(`unmarshal default_exclude_patterns.json: ${String((e as Error).message)}`);
  }
  if (!Array.isArray(arr)) {
    throw new Error("default_exclude_patterns.json: expected array");
  }
  const lowered: string[] = [];
  for (const entry of arr) {
    if (typeof entry !== "string") continue;
    lowered.push(entry.toLowerCase());
  }
  excludePatterns = lowered;
}

// Used in tests to reset lazy state when verifying with temp dirs.
export function resetAllowlistForTesting(): void {
  supportedSet = null;
  supportedList = null;
  excludePatterns = null;
}

// ---------------------------------------------------------------------------
// Public API — mirrors allowedext.IsAllowedExt / IsExcludedPath
// ---------------------------------------------------------------------------

/**
 * Returns the verbatim list of supported extensions as declared in the
 * upstream `supported_file_types.json`. Elements preserve the JSON's original
 * casing (e.g. ".java"); callers that need case-insensitive comparison
 * should use `isAllowedExt`.
 */
export function getSupportedExtensions(
  opts: { rulesDir?: string; verifyHashes?: boolean } = {},
): readonly string[] {
  ensureSupportedLoaded(opts.rulesDir, opts.verifyHashes ?? true);
  return supportedList as unknown as readonly string[];
}

/**
 * Alias for the Go export `DefaultAllowedExt` / `Supported` concept.
 * The upstream Go code embeds `supported_file_types.json`; this export is
 * the same data in lowercased set form for convenience.
 */
export const DefaultAllowedExt: readonly string[] = (() => {
  try {
    ensureSupportedLoaded(undefined, true);
    return supportedList as unknown as readonly string[];
  } catch {
    // During bundling or when the file is not yet present (tooling), fall
    // back to an empty list; the real load will verify on first call.
    return [] as unknown as readonly string[];
  }
})();

/**
 * Returns true when the given file extension is in the supported types list.
 * The check is case-insensitive and expects the extension to include the
 * leading dot (e.g. ".go", ".GO"). Empty string returns false.
 *
 * Mirrors Go: `IsAllowedExt(ext string) bool { initOnce.Do(initMap); return supported[strings.ToLower(ext)] }`
 */
export function isAllowedExt(ext: string, opts: { rulesDir?: string; verifyHashes?: boolean } = {}): boolean {
  if (opts.rulesDir !== undefined || opts.verifyHashes === false) {
    // When custom opts are supplied, bypass the cached global and read fresh.
    // This path is used by tests that supply a temp rulesDir.
    const dir = resolveRulesDir(opts.rulesDir);
    const filePath = path.join(dir, "supported_file_types.json");
    if (opts.verifyHashes !== false) verifyFileHash(filePath, EXPECTED_SUPPORTED_FILE_TYPES_HASH, "supported_file_types.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const exts = JSON.parse(raw) as string[];
    const set = new Set(exts.map((e) => e.toLowerCase()));
    return set.has(ext.toLowerCase());
  }
  ensureSupportedLoaded(undefined, true);
  return (supportedSet as ReadonlySet<string>).has(ext.toLowerCase());
}

/** Go-compatible PascalCase alias. */
export const IsAllowedExt = isAllowedExt;

/**
 * Returns true when the given repository-relative file path matches any
 * default exclude pattern.
 *
 * Patterns support `**` (recursive), `*` (single-segment), and `{a,b,c}`
 * brace expansion. The check is case-insensitive (both pattern and path are
 * lowercased before matching), matching Go's behaviour:
 * `strings.ToLower(p)` then `doublestar.Match(pattern, lowerPath)`.
 *
 * The TypeScript port uses `minimatch` with `dot:true` to approximate
 * doublestar's semantics. Brace expansion is handled natively by minimatch
 * (the Go allowlist path does not use the manual `expandBraces` helper —
 * only the rules package does).
 */
export function isExcludedPath(
  filePath: string,
  opts: { rulesDir?: string; verifyHashes?: boolean } = {},
): boolean {
  if (opts.rulesDir !== undefined || opts.verifyHashes === false) {
    const dir = resolveRulesDir(opts.rulesDir);
    const patternPath = path.join(dir, "default_exclude_patterns.json");
    if (opts.verifyHashes !== false) verifyFileHash(patternPath, EXPECTED_DEFAULT_EXCLUDE_PATTERNS_HASH, "default_exclude_patterns.json");
    const raw = fs.readFileSync(patternPath, "utf-8");
    const patterns = JSON.parse(raw) as string[];
    const lowerPath = filePath.toLowerCase();
    for (const rawPattern of patterns) {
      const pattern = rawPattern.toLowerCase();
      if (minimatch(lowerPath, pattern, { dot: true, nocase: false })) return true;
    }
    return false;
  }
  ensureExcludeLoaded(undefined, true);
  const lowerPath = filePath.toLowerCase();
  for (const pattern of excludePatterns as readonly string[]) {
    if (minimatch(lowerPath, pattern, { dot: true, nocase: false })) return true;
  }
  return false;
}

/** Go-compatible PascalCase alias. */
export const IsExcludedPath = isExcludedPath;

/**
 * Returns the raw lowercased exclude patterns from `default_exclude_patterns.json`.
 * Useful for callers that want to display or hash the policy.
 */
export function getDefaultExcludePatterns(
  opts: { rulesDir?: string; verifyHashes?: boolean } = {},
): readonly string[] {
  if (opts.rulesDir !== undefined || opts.verifyHashes === false) {
    const dir = resolveRulesDir(opts.rulesDir);
    const raw = fs.readFileSync(path.join(dir, "default_exclude_patterns.json"), "utf-8");
    const patterns = JSON.parse(raw) as string[];
    return patterns.map((p) => p.toLowerCase());
  }
  ensureExcludeLoaded(undefined, true);
  return excludePatterns as readonly string[];
}

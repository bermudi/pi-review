// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/rules/system_rules.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * OCR v1.9.3 system rules engine — TypeScript port of internal/config/rules/system_rules.go.
 *
 * Responsibilities:
 * - Loads the embedded `system_rules.json` and resolves rule file references
 *   (`rule_docs/*.md`) exactly as Go does (trim trailing `\n`, ordered
 *   `path_rule_map`, hash-frozen verification).
 * - Implements `SystemRule.Resolve`, `CanonicalConfig`, and the composed
 *   `Resolver` / `FileFilter` / `ProjectRule` machinery with the same
 *   priority (`custom > project > global > system`), brace expansion, and
 *   case-insensitive doublestar-compatible matching as the upstream.
 * - Replicates `expandBraces` singular `{a,b,c}` expansion, `looksLikeFilePath`,
 *   `allowedRuleExts`, `resolveRuleEntries`, `tryReadRuleFile`, and
 *   `readRuleFileSafe` (extension whitelist `.md`/`.txt`/`.markdown`,
 *   512 KiB cap, symlink resolution via `realpathSync`).
 *
 * No import from legacy `src/selection.ts` — this is the parity path.
 * Glob matching uses `minimatch` with `dot:true` to approximate
 * `bmatcuk/doublestar/v4` semantics; behaviour is verified via the upstream
 * `system_rules_test.go` / `canonical_config_test.go` / `allowed_ext_test.go`
 * fixtures.
 *
 * `system_rules.json` and `rule_docs/*.md` are byte-identical to upstream;
 * their provenance is recorded in the adjacent `PROVENANCE.json` and this
 * file's frozen hash table.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Frozen hashes — pinned at v1.9.3 (4d796ae..., c35ddd...)
// ---------------------------------------------------------------------------

export const EXPECTED_SYSTEM_RULES_HASH =
  "90a4dd5ab978877011eadd2b7386666342de2e154697647284adeb37908e4072";

/**
 * SHA-256 of each verbatim rule-doc file as shipped in
 * internal/config/rules/rule_docs/*.md at v1.9.3.
 *
 * Generation:
 *   sha256sum ../open-code-review/internal/config/rules/rule_docs/*.md
 */
export const EXPECTED_RULE_DOC_HASHES: Readonly<Record<string, string>> = {
  "arkts.md": "8c146c5713b3ba32166930d8ba1c96e649fef593fd465dc73e6c7fb979bb8682",
  "astro.md": "9ecfe0ab7035f413eb8172dd437de6502d781e229fac69857c9cc0ea5d17be4e",
  "bicep.md": "ec9907d0e062f8bc71e84beafa3055d894cf8a8748082e47a52cc04108763681",
  "build_gradle.md": "f511a3c5df99e0022d33edf28d00f43d4e7e0d7f7496ff1035b4f4a7ea4705a4",
  "c.md": "bc24216e887e782d18b41448ba70ec149db60fca69ce270e69fe0285a4dd1996",
  "cargo_toml.md": "0c0fd9e692e217d850ea66691e73775bcf045b1faf06d3814a43242d8dd8a593",
  "composer_json.md": "839a18f91961cbb5eff20300028afae5b7bed185eaccfc6cef8e758b67832476",
  "cpp.md": "06df79df2454cb2003be6e52e4f6d58f9ce5ce51bc7e31e0be2e417af315e130",
  "default.md": "ababeb873e9c249a701c35afa115f8ee8e32b856d0fcebf6232a7d2bef03abd0",
  "freemarker.md": "3b1eb68367f4d955d73e13dd139e71408a01884276cb4f7e151095c2a2c5d4c7",
  "github_config.md": "64af359e7fcb8a0bdba88738e5429836d5efddc89851b042c9114985e7d22b95",
  "github_workflows.md": "801de96a1a8de9d2a4f18f60b5c29c17d58ca49de201b9f66b5c16c1e9d83866",
  "go.md": "b6958ae9894a8bbe6d09d9241956ca24673848472d0bdf0a968b2ee9ab308fa5",
  "graphql.md": "d366bf4cf234c562c2522bed7ab979fafcccd5498f2f1f004a2638d58fc4ad24",
  "haskell.md": "94032848f52f79e2fe42c77ffa189395e62b6df2f1198c85f82e1bb806b4bf2a",
  "java.md": "06668355abc6f5f4f703215870228c1e913e4360bf30ae682bb04d36b57b4837",
  "json.md": "5ec3f0fea279f3b63d417621ece604de89f40a3a5946fdd8e5e07aad8d64d410",
  "julia.md": "3a55c6e22a2d092b5dcf200ff851e67e58a1d39538801489a2ad7153a6360ebb",
  "kotlin.md": "816c6930855936bf987de87ae6847d954da015ed4af37a8bee2cb9e3128afae1",
  "mapper_dao_xml.md": "8ff3a60e38e44986f82cba70cbbe7782ed4ea294486048336a14d173cf92678e",
  "nim.md": "7b6682f398a22387d1c19e0e727b6fd23769e4aa639e0ef77ef8aba4982b7e73",
  "nix.md": "49dc36a063cc4b423836b365d176511a3d82df426e3ab1b59ef32ce39f835feb",
  "package_json.md": "64307261dc703f6d8541ba9b5ddf7ee9be49f51018d7e5df4a5e57bd420a408f",
  "php.md": "1ee3de4d9c2c122f8970e08c05eb9cee8139920cb28eaa75f83d470e771e527a",
  "po.md": "c35c4c6698e68944edd583ae94adb3710b8ae0b3d11edd315ca6d9edfa6e522b",
  "pom_xml.md": "1ef2b428df0e78a06cb2065f2aac53a6604b2c8ac578d917cc6cceaf4b08907e",
  "pot.md": "4e365876a314944ca2fdaac6c9d0d91e77b32792f4bce5f9b08575c410b6a980",
  "prisma.md": "46443470a166ad8e6c36401a82acb263482204acbe3cfe46733e436e43ec87c4",
  "properties.md": "d4c304229aec069b009cf3a762c0fcb16d8944c4f059187533a745e36e35fb82",
  "protobuf.md": "1dfcb6d6ec336f815f2c28ff5bfde8fb5563ae54386affdc26d315ce28b05cb7",
  "python.md": "9f449a1a60a1aba04e3a32de7854be0407d7acc4316f0364a124e79fcc7f8595",
  "rust.md": "e8f947933540302f0a96d2eced84a28851a10d9bbeaaeffa0677ac11adb4d5ff",
  "terraform.md": "d2a5877ef8fdfb5cb1883aabf1ad7130894b01996292ae5e096ec1f35f78b92a",
  "ts_js_tsx_jsx.md": "a365402a1884650cac3309f4c366020777452ef2f5f8d3ea474b9534004c5714",
  "yaml.md": "39cd95b21cf24f214cf1cfb080ae31e6441844496cbf49d573590200980872eb",
} as const;

// ---------------------------------------------------------------------------
// Basic hash / FS helpers
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
    throw new Error(`hash mismatch for ${label}: expected ${expected}, got ${actual} (file: ${filePath})`);
  }
}

export function verifyAllRuleDocHashes(docsDir: string): void {
  for (const [name, expected] of Object.entries(EXPECTED_RULE_DOC_HASHES)) {
    const full = path.join(docsDir, name);
    if (!fs.existsSync(full)) {
      throw new Error(`missing rule doc file ${name} at ${full}`);
    }
    verifyFileHash(full, expected, `rule doc ${name}`);
  }
}

function trimTrailingCRLF(s: string): string {
  return s.replace(/[\r\n]+$/g, "");
}

function resolveRulesDir(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const candidates: string[] = [];
  const maybeDir = (import.meta as unknown as { dir?: string }).dir;
  if (maybeDir !== undefined) candidates.push(maybeDir);
  candidates.push(path.join(process.cwd(), "src/ocr/rules"));
  candidates.push(path.resolve("src/ocr/rules"));
  for (const c of candidates) {
    const probe = path.join(c, "system_rules.json");
    if (fs.existsSync(probe)) return c;
  }
  return candidates[0] ?? path.join(process.cwd(), "src/ocr/rules");
}

// ---------------------------------------------------------------------------
// Domain types — mirror Go's structs/interfaces
// ---------------------------------------------------------------------------

export interface PathRule {
  readonly Pattern: string;
  readonly Rule: string;
}

export interface SystemRule {
  readonly DefaultRule: string;
  readonly PathRules: readonly PathRule[];
}

export interface RuleDetail {
  readonly Rule: string;
  readonly Source: string;
  readonly Pattern: string;
}

export interface Resolver {
  resolve(path: string): string;
}

export interface DetailResolver extends Resolver {
  resolveDetail(path: string): RuleDetail;
}

export interface ProjectRuleEntry {
  Path: string;
  Rule: string;
  MergeSystemRule?: boolean;
}

export interface ProjectRule {
  Rules: ProjectRuleEntry[];
  Include?: string[];
  Exclude?: string[];
}

export interface FileFilter {
  readonly Include: readonly string[];
  readonly Exclude: readonly string[];
}

// ---------------------------------------------------------------------------
// expandBraces — mirrors Go's singular-brace expansion
// ---------------------------------------------------------------------------

export function expandBraces(s: string): string[] {
  const openIdx = s.indexOf("{");
  if (openIdx < 0) return [s];
  const closeIdx = s.indexOf("}", openIdx);
  if (closeIdx < 0) return [s];
  const prefix = s.slice(0, openIdx);
  const suffix = s.slice(closeIdx + 1);
  const options = s.slice(openIdx + 1, closeIdx).split(",");
  const results: string[] = [];
  for (const opt of options) {
    results.push(prefix + opt + suffix);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Glob matching — case-insensitive via lowercasing both pattern and path
// ---------------------------------------------------------------------------

function matchesGlob(pattern: string, filePath: string): boolean {
  const lowerPattern = pattern.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  return minimatch(lowerPath, lowerPattern, { dot: true, nocase: false });
}

function matchesAnyPattern(patterns: readonly string[], filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  for (const rawPattern of patterns) {
    const expanded = expandBraces(rawPattern);
    for (const p of expanded) {
      if (matchesGlob(p, lowerPath)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// SystemRule JSON parsing — preserves declaration order of path_rule_map
// ---------------------------------------------------------------------------

interface RawSystemRuleJson {
  default_rule?: unknown;
  path_rule_map?: unknown;
}

export function parseSystemRuleJson(jsonText: string): { defaultRule: string; pathRules: PathRule[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch (e) {
    throw new Error(`unmarshal default system rules: ${String((e as Error).message)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`unmarshal default system rules: expected object`);
  }
  const obj = raw as RawSystemRuleJson;

  const defaultRuleVal = obj.default_rule;
  const defaultRule = typeof defaultRuleVal === "string" ? defaultRuleVal : "";

  const mapData = obj.path_rule_map;
  if (mapData === undefined || mapData === null) {
    return { defaultRule, pathRules: [] };
  }
  if (typeof mapData !== "object" || Array.isArray(mapData)) {
    throw new Error(`expected '{' in path_rule_map, got ${String(mapData)}`);
  }

  // Preserve key order via Object.entries (JS preserves insertion order for
  // non-integer string keys). Also validate that every value is a string
  // to mimic Go's `dec.Decode(&value)` error branch.
  const pathRules: PathRule[] = [];
  const entries = Object.entries(mapData as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (typeof v !== "string") {
      throw new Error(`read path_rule_map value for ${JSON.stringify(k)}: expected string, got ${typeof v}`);
    }
    pathRules.push({ Pattern: k, Rule: v });
  }
  return { defaultRule, pathRules };
}

// ---------------------------------------------------------------------------
// File-backed loading — mirrors Go's LoadDefault (reads rule_docs/*.md)
// ---------------------------------------------------------------------------

export interface LoadOptions {
  rulesDir?: string;
  verifyHashes?: boolean;
}

export function loadDefaultSystemRule(opts: LoadOptions = {}): SystemRule {
  const rulesDir = resolveRulesDir(opts.rulesDir);
  const verifyHashes = opts.verifyHashes ?? true;
  const docsDir = path.join(rulesDir, "rule_docs");
  const manifestPath = path.join(rulesDir, "system_rules.json");

  if (verifyHashes) {
    verifyFileHash(manifestPath, EXPECTED_SYSTEM_RULES_HASH, "system_rules.json");
    verifyAllRuleDocHashes(docsDir);
  }

  let rawJson: string;
  try {
    rawJson = fs.readFileSync(manifestPath, "utf-8");
  } catch (e) {
    throw new Error(`read embedded system_rules.json: ${String((e as Error).message)}`);
  }

  const parsed = parseSystemRuleJson(rawJson);

  let defaultRuleText: string;
  try {
    const docPath = path.join(docsDir, parsed.defaultRule);
    if (verifyHashes) {
      const expected = (EXPECTED_RULE_DOC_HASHES as Record<string, string>)[parsed.defaultRule];
      if (expected !== undefined) verifyFileHash(docPath, expected, `rule doc ${parsed.defaultRule}`);
    }
    defaultRuleText = trimTrailingCRLF(fs.readFileSync(docPath, "utf-8"));
  } catch (e) {
    throw new Error(`read default rule file ${JSON.stringify(parsed.defaultRule)}: ${String((e as Error).message)}`);
  }

  const resolvedRules: PathRule[] = [];
  for (const pr of parsed.pathRules) {
    let content: string;
    try {
      const docPath = path.join(docsDir, pr.Rule);
      if (verifyHashes) {
        const expected = (EXPECTED_RULE_DOC_HASHES as Record<string, string>)[pr.Rule];
        if (expected !== undefined) verifyFileHash(docPath, expected, `rule doc ${pr.Rule}`);
      }
      content = trimTrailingCRLF(fs.readFileSync(docPath, "utf-8"));
    } catch (e) {
      throw new Error(
        `read rule file ${JSON.stringify(pr.Rule)} for pattern ${JSON.stringify(pr.Pattern)}: ${String((e as Error).message)}`,
      );
    }
    resolvedRules.push({ Pattern: pr.Pattern, Rule: content });
  }

  return { DefaultRule: defaultRuleText, PathRules: resolvedRules };
}

/** Go-compatible alias: LoadDefault. */
export const LoadDefault = loadDefaultSystemRule;
/** Alias requested in task description. */
export const LoadSystemRules = loadDefaultSystemRule;
/** Lowercase alias for convenience. */
export const loadDefault = loadDefaultSystemRule;

// ---------------------------------------------------------------------------
// SystemRule operations — Resolve, CanonicalConfig, resolveDetail
// ---------------------------------------------------------------------------

export function resolveSystemRule(system: SystemRule, filePath: string): string {
  for (const pr of system.PathRules) {
    const expanded = expandBraces(pr.Pattern);
    for (const p of expanded) {
      if (matchesGlob(p, filePath)) return pr.Rule;
    }
  }
  return system.DefaultRule;
}

/** Go method alias: (r *SystemRule).Resolve */
export const ResolveSystemRule = resolveSystemRule;

export function canonicalConfigSystemRule(system: SystemRule): string[] {
  const fields: string[] = ["layer", "system", "default", system.DefaultRule];
  for (const pr of system.PathRules) {
    fields.push("layer", "system", "pattern", pr.Pattern, "rule", pr.Rule);
  }
  return fields;
}

export function resolveDetailSystemRule(system: SystemRule, filePath: string): RuleDetail {
  for (const pr of system.PathRules) {
    const expanded = expandBraces(pr.Pattern);
    for (const p of expanded) {
      if (matchesGlob(p, filePath)) return { Rule: pr.Rule, Source: "system", Pattern: pr.Pattern };
    }
  }
  return { Rule: system.DefaultRule, Source: "system", Pattern: "default" };
}

// ---------------------------------------------------------------------------
// FileFilter helpers — mirrors Go's FileFilter methods
// ---------------------------------------------------------------------------

export function createFileFilter(include: readonly string[], exclude: readonly string[]): FileFilter {
  return { Include: [...include], Exclude: [...exclude] };
}

export function hasInclude(filter: FileFilter | null | undefined): boolean {
  return filter !== null && filter !== undefined && filter.Include.length > 0;
}

export const HasInclude = hasInclude;

export function isUserExcluded(filter: FileFilter | null | undefined, filePath: string): boolean {
  if (filter === null || filter === undefined) return false;
  return matchesAnyPattern(filter.Exclude, filePath);
}

export const IsUserExcluded = isUserExcluded;

export function isUserIncluded(filter: FileFilter | null | undefined, filePath: string): boolean {
  if (filter === null || filter === undefined) return false;
  if (filter.Include.length === 0) return false;
  return matchesAnyPattern(filter.Include, filePath);
}

export const IsUserIncluded = isUserIncluded;

// ---------------------------------------------------------------------------
// Project rule file loading — mirrors Go's load* helpers
// ---------------------------------------------------------------------------

const ALLOWED_RULE_EXTS: ReadonlySet<string> = new Set([".md", ".txt", ".markdown"]);

export function looksLikeFilePath(s: string): boolean {
  if (s.includes("\n")) return false;
  if (s.includes(" ")) return false;
  const ext = path.extname(s).toLowerCase();
  return ALLOWED_RULE_EXTS.has(ext);
}

export function readRuleFileSafe(filePath: string): string {
  const maxSize = 512 * 1024;
  let resolved: string;
  try {
    resolved = fs.realpathSync(filePath);
  } catch (e) {
    throw e as Error;
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_RULE_EXTS.has(ext)) {
    throw new Error(`unsupported extension ${JSON.stringify(ext)}, only .md/.txt/.markdown allowed`);
  }
  let info: fs.Stats;
  try {
    info = fs.statSync(resolved);
  } catch (e) {
    throw e as Error;
  }
  if (info.size > maxSize) {
    throw new Error(`file too large (${info.size} bytes, max ${maxSize})`);
  }
  const content = fs.readFileSync(resolved, "utf-8");
  return trimTrailingCRLF(content);
}

export function tryReadRuleFile(rule: string, repoDir: string): string | null {
  if (repoDir === "") {
    if (!path.isAbsolute(rule)) {
      console.error(`[pi-review] WARNING: cannot resolve relative rule path ${JSON.stringify(rule)} without a repo dir`);
      return null;
    }
  }
  if (path.isAbsolute(rule)) {
    try {
      return readRuleFileSafe(rule);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") console.error(`[pi-review] WARNING: rule file not found: ${rule}`);
      else console.error(`[pi-review] WARNING: cannot read rule file ${rule}: ${String(err.message ?? err)}`);
      return null;
    }
  }
  const resolved = path.resolve(path.join(repoDir, rule));
  const cleanRepo = path.resolve(repoDir);
  const sep = path.sep;
  if (resolved !== cleanRepo && !resolved.startsWith(cleanRepo + sep)) {
    console.error(`[pi-review] WARNING: rule file path escapes repo dir: ${rule}`);
    return null;
  }
  try {
    return readRuleFileSafe(resolved);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") console.error(`[pi-review] WARNING: rule file not found: ${rule}`);
    else console.error(`[pi-review] WARNING: cannot read rule file ${resolved}: ${String(err.message ?? err)}`);
    return null;
  }
}

export function resolveRuleEntries(entries: ProjectRuleEntry[], repoDir: string): void {
  for (const entry of entries) {
    if (entry.Rule.trim() === "" || !looksLikeFilePath(entry.Rule)) continue;
    const content = tryReadRuleFile(entry.Rule, repoDir);
    if (content !== null) entry.Rule = content;
    else entry.Rule = "";
  }
}

function parseProjectRuleJson(data: string, repoDirForResolve: string): ProjectRule {
  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch (e) {
    throw new Error(`unmarshal project rule: ${String((e as Error).message)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("unmarshal project rule: expected object");
  }
  const obj = raw as Record<string, unknown>;
  const rulesRaw = obj["rules"];
  const includeRaw = obj["include"];
  const excludeRaw = obj["exclude"];

  const rules: ProjectRuleEntry[] = [];
  if (Array.isArray(rulesRaw)) {
    for (const r of rulesRaw) {
      if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
      const rr = r as Record<string, unknown>;
      const pathVal = typeof rr["path"] === "string" ? (rr["path"] as string) : "";
      const ruleVal = typeof rr["rule"] === "string" ? (rr["rule"] as string) : "";
      const mergeVal = rr["merge_system_rule"] === true;
      rules.push({ Path: pathVal, Rule: ruleVal, MergeSystemRule: mergeVal });
    }
  }

  const include: string[] = Array.isArray(includeRaw) ? (includeRaw as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const exclude: string[] = Array.isArray(excludeRaw) ? (excludeRaw as unknown[]).filter((x): x is string => typeof x === "string") : [];

  const pr: ProjectRule = { Rules: rules };
  if (include.length > 0) pr.Include = include;
  if (exclude.length > 0) pr.Exclude = exclude;

  resolveRuleEntries(pr.Rules, repoDirForResolve);
  return pr;
}

function loadProjectRuleFile(filePath: string): ProjectRule | null {
  let data: string;
  try {
    data = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw new Error(`read project rule ${filePath}: ${String(err.message ?? err)}`);
  }
  try {
    return parseProjectRuleJson(data, path.dirname(filePath));
  } catch (e) {
    throw new Error(`unmarshal project rule: ${String((e as Error).message)}`);
  }
}

export function loadProjectRule(repoDir: string): ProjectRule | null {
  if (repoDir === "") return null;
  const filePath = path.join(repoDir, ".opencodereview", "rule.json");
  let data: string;
  try {
    data = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw new Error(`read project rule ${filePath}: ${String(err.message ?? err)}`);
  }
  try {
    return parseProjectRuleJson(data, repoDir);
  } catch (e) {
    throw new Error(`unmarshal project rule: ${String((e as Error).message)}`);
  }
}

export function loadGlobalRule(): ProjectRule | null {
  let home: string;
  try {
    const envHome = process.env.HOME ?? process.env.USERPROFILE ?? "";
    home = envHome !== "" ? envHome : os.homedir();
  } catch {
    return null;
  }
  if (home === "") return null;
  const filePath = path.join(home, ".opencodereview", "rule.json");
  return loadProjectRuleFile(filePath);
}

export function loadRuleFile(customPath: string): ProjectRule | null {
  if (customPath === "") return null;
  let data: string;
  try {
    data = fs.readFileSync(customPath, "utf-8");
  } catch (e) {
    throw new Error(`read rule file ${customPath}: ${String((e as NodeJS.ErrnoException).message ?? e)}`);
  }
  try {
    return parseProjectRuleJson(data, path.dirname(customPath));
  } catch (e) {
    throw new Error(`unmarshal rule file ${customPath}: ${String((e as Error).message)}`);
  }
}

// ---------------------------------------------------------------------------
// FileFilter merging — mirrors Go's buildFileFilter
// ---------------------------------------------------------------------------

export function buildFileFilter(...layers: (ProjectRule | null | undefined)[]): FileFilter | null {
  for (const pr of layers) {
    if (pr === null || pr === undefined) continue;
    const incl = pr.Include ?? [];
    const excl = pr.Exclude ?? [];
    if (incl.length === 0 && excl.length === 0) continue;
    const f: FileFilter = {
      Include: incl.map((p) => p.toLowerCase()),
      Exclude: excl.map((p) => p.toLowerCase()),
    };
    return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Composed resolver — mirrors Go's composedResolver
// ---------------------------------------------------------------------------

function matchProjectRuleEntry(pr: ProjectRule | null | undefined, filePath: string): ProjectRuleEntry | null {
  if (pr === null || pr === undefined) return null;
  const lowerPath = filePath.toLowerCase();
  for (const entry of pr.Rules) {
    if (entry.Rule === "" && !entry.MergeSystemRule) continue;
    const expanded = expandBraces(entry.Path);
    for (const p of expanded) {
      const lowerPattern = p.toLowerCase();
      if (minimatch(lowerPath, lowerPattern, { dot: true, nocase: false })) return entry;
    }
  }
  return null;
}

export class ComposedResolver implements DetailResolver {
  constructor(
    private readonly custom: ProjectRule | null,
    private readonly project: ProjectRule | null,
    private readonly global: ProjectRule | null,
    private readonly system: SystemRule,
  ) {}

  resolve(filePath: string): string {
    for (const layer of [this.custom, this.project, this.global] as const) {
      const entry = matchProjectRuleEntry(layer, filePath);
      if (entry !== null) {
        if (entry.MergeSystemRule === true) return this.mergeWithSystemRule(filePath, entry.Rule);
        return entry.Rule;
      }
    }
    return resolveSystemRule(this.system, filePath);
  }

  canonicalConfig(): string[] {
    const fields: string[] = [];
    const appendLayer = (name: string, pr: ProjectRule | null): void => {
      if (pr === null) return;
      for (const e of pr.Rules) {
        const merge = e.MergeSystemRule === true ? "1" : "0";
        fields.push("layer", name, "path", e.Path, "rule", e.Rule, "merge", merge);
      }
    };
    appendLayer("custom", this.custom);
    appendLayer("project", this.project);
    appendLayer("global", this.global);
    fields.push(...canonicalConfigSystemRule(this.system));
    return fields;
  }

  resolveDetail(filePath: string): RuleDetail {
    const cd = this.matchDetail(this.custom, filePath, "custom");
    if (cd !== null) return cd;
    const pd = this.matchDetail(this.project, filePath, "project");
    if (pd !== null) return pd;
    const gd = this.matchDetail(this.global, filePath, "global");
    if (gd !== null) return gd;
    return resolveDetailSystemRule(this.system, filePath);
  }

  private matchDetail(pr: ProjectRule | null, filePath: string, source: string): RuleDetail | null {
    const entry = matchProjectRuleEntry(pr, filePath);
    if (entry === null) return null;
    let rule = entry.Rule;
    if (entry.MergeSystemRule === true) rule = this.mergeWithSystemRule(filePath, rule);
    return { Rule: rule, Source: source, Pattern: entry.Path };
  }

  private mergeWithSystemRule(filePath: string, rule: string): string {
    const systemRule = resolveSystemRule(this.system, filePath);
    if (systemRule === "") return rule;
    if (rule === "") return systemRule;
    return "## System-Specific Rules (Mandatory)\n\n" + systemRule + "\n\n---\n\n" + "## User-Specific Rules (Mandatory)\n\n" + rule;
  }
}

export function newResolver(repoDir: string, customRulePath: string): { resolver: Resolver & DetailResolver; filter: FileFilter | null } {
  const system = loadDefaultSystemRule();
  let customRule: ProjectRule | null = null;
  if (customRulePath !== "") {
    const cr = loadRuleFile(customRulePath);
    if (cr !== null) customRule = cr;
  }
  let projectRule: ProjectRule | null = null;
  if (repoDir !== "") {
    const pr = loadProjectRule(repoDir);
    if (pr !== null) projectRule = pr;
  }
  const globalRule = loadGlobalRule();
  const filter = buildFileFilter(customRule, projectRule, globalRule);
  const resolver = new ComposedResolver(customRule, projectRule, globalRule, system);
  return { resolver, filter };
}

/** Go-compatible PascalCase aliases. */
export const NewResolver = newResolver;
export const LoadDefaultResolver = newResolver;


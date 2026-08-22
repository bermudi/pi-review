// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/shared.go, shared_flags.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Shared CLI types and validation — mirrors Go shared_flags.go + shared.go
 * helpers that both review and scan depend on.
 *
 * This file stays policy-free: it does not import the legacy `src/cli.ts`
 * reviewer policy, only the narrow `CliIo` shape (duplicated, not imported).
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve as pathResolve } from "node:path";

// ---------------------------------------------------------------------------
// CliIo seam — duplicated from legacy src/cli.ts for testability, not imported
// ---------------------------------------------------------------------------

export type SignalName = "SIGINT" | "SIGTERM";
export type SignalListener = () => void;

export interface CliIo {
  readonly cwd: () => string;
  readonly env: () => Record<string, string | undefined>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly onSignal: (signal: SignalName, listener: SignalListener) => void;
  readonly offSignal: (signal: SignalName, listener: SignalListener) => void;
}

export interface CliIoOverrides {
  readonly cwd?: () => string;
  readonly env?: () => Record<string, string | undefined>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly onSignal?: (signal: SignalName, listener: SignalListener) => void;
  readonly offSignal?: (signal: SignalName, listener: SignalListener) => void;
}

export function defaultIo(): CliIo {
  return {
    cwd: () => process.cwd(),
    env: () => process.env as Record<string, string | undefined>,
    stdout: (text: string) => {
      process.stdout.write(text);
    },
    stderr: (text: string) => {
      process.stderr.write(text);
    },
    onSignal: (signal, listener) => {
      process.on(signal, listener);
    },
    offSignal: (signal, listener) => {
      process.off(signal, listener);
    },
  };
}

export function makeIo(overrides: CliIoOverrides | undefined): CliIo {
  const defaults = defaultIo();
  return {
    cwd: overrides?.cwd ?? defaults.cwd,
    env: overrides?.env ?? defaults.env,
    stdout: overrides?.stdout ?? defaults.stdout,
    stderr: overrides?.stderr ?? defaults.stderr,
    onSignal: overrides?.onSignal ?? defaults.onSignal,
    offSignal: overrides?.offSignal ?? defaults.offSignal,
  };
}

// ---------------------------------------------------------------------------
// Usage error — controlled exit with help text
// ---------------------------------------------------------------------------

export class CliUsageError extends Error {
  readonly kind = "usage" as const;
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

// ---------------------------------------------------------------------------
// Format / audience
// ---------------------------------------------------------------------------

export type OutputFormat = "text" | "json" | "sarif";
export type Audience = "human" | "agent";

export function isMachineReadable(format: string): boolean {
  return format === "json" || format === "sarif";
}

export function isValidFormat(v: string): v is OutputFormat {
  return v === "text" || v === "json" || v === "sarif";
}

export function isValidAudience(v: string): v is Audience {
  return v === "human" || v === "agent";
}

// ---------------------------------------------------------------------------
// Option bags — mirrors Go reviewOptions / scanOptions
// ---------------------------------------------------------------------------

export interface ReviewOptions {
  readonly toolConfigPath: string;
  readonly rulePath: string;
  readonly repoDir: string;
  readonly from: string;
  readonly to: string;
  readonly commit: string;
  readonly resume: string;
  readonly excludes: string;
  readonly outputFormat: OutputFormat;
  readonly audience: Audience;
  readonly background: string;
  readonly backgroundFile: string;
  /**
   * Internal factory contract: the CLI has already applied
   * resolveBackground. Direct factory callers leave this false/absent.
   */
  readonly backgroundResolved?: boolean;
  readonly provider: string;
  readonly model: string;
  readonly concurrency: number;
  readonly perFileTimeout: number;
  readonly maxTools: number;
  readonly maxGitProcs: number;
  readonly maxTokens: number;
  readonly maxTokensBudget: number;
  readonly noFilter: boolean;
  readonly preview: boolean;
}

export interface ScanOptions {
  readonly toolConfigPath: string;
  readonly rulePath: string;
  readonly repoDir: string;
  readonly paths: string;
  readonly excludes: string;
  readonly outputFormat: OutputFormat;
  readonly audience: Audience;
  readonly background: string;
  readonly concurrency: number;
  readonly perFileTimeout: number;
  readonly maxTools: number;
  readonly maxGitProcs: number;
  readonly maxTokens: number;
  readonly maxTokensBudget: number;
  readonly preview: boolean;
  readonly noPlan: boolean;
  readonly noDedup: boolean;
  readonly noSummary: boolean;
  readonly batch: string;
  readonly provider: string;
  readonly model: string;
  readonly resume: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function defaultReviewOptions(): ReviewOptions {
  return {
    toolConfigPath: "",
    rulePath: "",
    repoDir: "",
    from: "",
    to: "",
    commit: "",
    resume: "",
    excludes: "",
    outputFormat: "text",
    audience: "human",
    background: "",
    backgroundFile: "",
    provider: "",
    model: "",
    concurrency: 8,
    perFileTimeout: 10,
    maxTools: 0,
    maxGitProcs: 16,
    maxTokens: 0,
    maxTokensBudget: 0,
    noFilter: false,
    preview: false,
  };
}

export function defaultScanOptions(): ScanOptions {
  return {
    toolConfigPath: "",
    rulePath: "",
    repoDir: "",
    paths: "",
    excludes: "",
    outputFormat: "text",
    audience: "human",
    background: "",
    concurrency: 8,
    perFileTimeout: 10,
    maxTools: 0,
    maxGitProcs: 16,
    maxTokens: 0,
    maxTokensBudget: 0,
    preview: false,
    noPlan: false,
    noDedup: false,
    noSummary: false,
    batch: "",
    provider: "",
    model: "",
    resume: "",
  };
}

// ---------------------------------------------------------------------------
// Small utilities — mirrors Go splitPaths, sanitize helpers
// ---------------------------------------------------------------------------

export function splitPaths(raw: string): string[] {
  if (raw === "") return [];
  const parts = raw.split(",");
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

export function excludeToolDef(
  defs: ReadonlyArray<{ Function: { Name: string }; function?: { name: string } } & Record<string, unknown>> | ReadonlyArray<{ function: { name: string } }> | ReadonlyArray<Record<string, unknown>>,
  name: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const d of defs as ReadonlyArray<Record<string, unknown>>) {
    const fn = (d["Function"] as { Name?: string } | undefined)?.Name ?? (d["function"] as { name?: string } | undefined)?.name ?? "";
    if (fn === name) continue;
    out.push({ ...d });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation — mirrors Go validateDiffMode / validateAudience / etc.
// ---------------------------------------------------------------------------

export function validateDiffMode(from: string, to: string, commit: string): void {
  let modeCount = 0;
  if (from !== "" || to !== "") modeCount++;
  if (commit !== "") modeCount++;
  if (modeCount > 1) throw new CliUsageError("only one review mode allowed (--from/--to or --commit)");
  if (from !== "" && to === "") throw new CliUsageError("--to is required when --from is specified");
  if (to !== "" && from === "") throw new CliUsageError("--from is required when --to is specified");
}

export function validateAudience(audience: string): void {
  if (audience !== "human" && audience !== "agent") {
    throw new CliUsageError(`invalid --audience value "${audience}": must be 'human' or 'agent'`);
  }
}

export function validateReviewOptions(opts: ReviewOptions): void {
  validateDiffMode(opts.from, opts.to, opts.commit);
  if (opts.preview && opts.resume !== "") throw new CliUsageError("--preview and --resume cannot be used together");
  validateAudience(opts.audience);
  if (!isValidFormat(opts.outputFormat)) throw new CliUsageError(`invalid --format value "${opts.outputFormat}": must be 'text', 'json' or 'sarif'`);
  const minMaxTools = 10;
  if (opts.maxTools < 0) throw new CliUsageError("--max-tools must be a non-negative integer (0 means use template default)");
  if (opts.maxGitProcs < 0) throw new CliUsageError("--max-git-procs must be a non-negative integer (0 means use default 16)");
  if (opts.maxTokens < 0) throw new CliUsageError("--max-tokens must be a non-negative integer (0 means use configured or template default)");
  if (opts.maxTokensBudget < 0) throw new CliUsageError("--max-tokens-budget must be a non-negative integer (0 means unlimited)");
}

export function validateScanOptions(opts: ScanOptions): void {
  validateAudience(opts.audience);
  if (!isValidFormat(opts.outputFormat)) throw new CliUsageError(`invalid --format value "${opts.outputFormat}": must be 'text', 'json' or 'sarif'`);
  if (opts.maxTools < 0) throw new CliUsageError("--max-tools must be a non-negative integer (0 means use template default)");
  if (opts.maxGitProcs < 0) throw new CliUsageError("--max-git-procs must be a non-negative integer (0 means use default 16)");
  if (opts.maxTokens < 0) throw new CliUsageError("--max-tokens must be a non-negative integer (0 means use configured or template default)");
  if (opts.preview && opts.resume !== "") throw new CliUsageError("--preview and --resume cannot be used together");
  if (opts.maxTokensBudget < 0) throw new CliUsageError("--max-tokens-budget must be a non-negative integer (0 means unlimited)");
  if (opts.batch !== "" && opts.batch !== "none" && opts.batch !== "by-language" && opts.batch !== "by-directory") {
    throw new CliUsageError(`invalid --batch value "${opts.batch}": must be 'none', 'by-language' or 'by-directory'`);
  }
}

// ---------------------------------------------------------------------------
// Exit code — mirrors Go/exit contract: 0 complete/skipped, 2 partial, 1 failed
// ---------------------------------------------------------------------------

export type TerminalState = "complete" | "partial" | "failed" | "skipped";

export function exitCodeForTerminalState(state: TerminalState | string): number {
  switch (state) {
    case "complete":
    case "skipped":
      return 0;
    case "partial":
      return 2;
    case "failed":
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Ref validation — mirrors Go validateReviewRefs (used by review.ts)
// ---------------------------------------------------------------------------

export function validateRefNotFlagLike(flag: string, value: string): void {
  if (value.startsWith("-")) {
    throw new CliUsageError(`${flag} value "${value}" is not a valid git ref: refs must not start with '-'`);
  }
}

// ---------------------------------------------------------------------------
// Background helpers — re-exported from background.ts
// ---------------------------------------------------------------------------

export {
  BACKGROUND_SOFT_LIMIT,
  BACKGROUND_HARD_LIMIT,
  BACKGROUND_OPEN_TAG,
  BACKGROUND_CLOSE_TAG,
  MAX_BACKGROUND_FILE_BYTES,
  resolveBackgroundFilePath,
  sanitizeMarkdown,
  loadBackgroundFile,
} from "./background.js";

// ---------------------------------------------------------------------------
// Config / resolveMaxTokens — mirrors Go resolveMaxTokens
// ---------------------------------------------------------------------------

export interface AppConfig {
  readonly maxTokens?: number;
  readonly MaxTokens?: number;
}

export function resolveMaxTokens(
  templateDefault: number,
  cfg: AppConfig | null | undefined,
  cliOverride: number,
): number {
  if (cliOverride < 0) throw new CliUsageError("--max-tokens must be a non-negative integer");
  if (cliOverride > 0) return cliOverride;
  const cfgVal = cfg?.MaxTokens ?? cfg?.maxTokens ?? 0;
  if (cfgVal === 0 || cfgVal === undefined) return templateDefault;
  if (cfgVal < 0) throw new CliUsageError("invalid max_tokens in app config: must be a positive integer");
  return cfgVal;
}

// ---------------------------------------------------------------------------
// applyCLIExcludes — mirrors Go applyCLIExcludes
// ---------------------------------------------------------------------------

export interface FileFilter {
  exclude: string[];
}

export interface CommonContext {
  fileFilter?: FileFilter | null;
  FileFilter?: FileFilter | null;
}

export function applyCLIExcludes(
  cc: { FileFilter?: FileFilter | null; fileFilter?: FileFilter | null } | CommonContext,
  patterns: readonly string[],
): void {
  if (patterns.length === 0) return;
  const target = cc as Record<string, unknown>;
  let ff = (target["FileFilter"] as FileFilter | null | undefined) ?? (target["fileFilter"] as FileFilter | null | undefined) ?? null;
  if (ff === null || ff === undefined) {
    ff = { exclude: [] };
    target["FileFilter"] = ff;
    target["fileFilter"] = ff;
  }
  for (const p of patterns) ff.exclude.push(p);
}

// ---------------------------------------------------------------------------
// QuietHandle — mirrors Go quietHandle / newQuietHandle
// ---------------------------------------------------------------------------

export class QuietHandle {
  fn: (() => void) | null = null;
  constructor(fn: (() => void) | null = null) {
    this.fn = fn;
  }
  Restore(): void {
    if (this.fn === null) return;
    const f = this.fn;
    this.fn = null;
    f();
  }
}

export function newQuietHandle(outputFormat: string, audience: string): QuietHandle {
  if (isMachineReadable(outputFormat) || audience === "agent") {
    let restored = false;
    const fn = (): void => {
      restored = true;
      void restored;
    };
    return new QuietHandle(fn);
  }
  return new QuietHandle(null);
}

// ---------------------------------------------------------------------------
// sanitizeEndpointHost — mirrors Go sanitizeEndpointHost
// ---------------------------------------------------------------------------

export function sanitizeEndpointHost(rawURL: string): string {
  if (rawURL.trim() === "") return "";
  try {
    const u = new URL(rawURL);
    if (u.host === "") return "";
    return u.host.toLowerCase();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// resolveWorkingDir — mirrors Go resolveWorkingDir (sync, uses git)
// ---------------------------------------------------------------------------

export function resolveWorkingDir(
  input: string,
  requireGit: boolean,
): { absPath: string; isGit: boolean } {
  let absInput: string;
  if (input === "") {
    absInput = process.cwd();
  } else {
    absInput = pathResolve(input);
  }
  if (!existsSync(absInput)) {
    throw new CliUsageError(`stat ${absInput}: no such file or directory`);
  }
  const gitDir = spawnSync("git", ["-C", absInput, "rev-parse", "--git-dir"], { encoding: "utf8" });
  const isGit = gitDir.status === 0 && (gitDir.stdout as string).trim().length > 0;
  if (!isGit && requireGit) {
    throw new CliUsageError(`${absInput} is not a git repository`);
  }
  if (isGit && requireGit) {
    const top = spawnSync("git", ["-C", absInput, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    const t = (top.stdout as string ?? "").trim();
    if (top.status !== 0 || t === "") {
      throw new CliUsageError(`${absInput} is a git repository without a work tree (bare repo?); cannot resolve its top level for review`);
    }
    return { absPath: t, isGit };
  }
  return { absPath: absInput, isGit };
}

// ---------------------------------------------------------------------------
// addOutputFlags — mirrors Go addOutputFlags for cobra
// ---------------------------------------------------------------------------

export interface FlagDef {
  readonly name: string;
  readonly usage: string;
}

export function addOutputFlags(): FlagDef[] {
  return [
    { name: "format", usage: "output format: text, json, or sarif (default: text)" },
    { name: "audience", usage: "output audience: human or agent (default: human)" },
  ];
}

// ---------------------------------------------------------------------------
// loadLLMRuntime — mirrors Go loadLLMRuntime (minimal shim for tests)
// ---------------------------------------------------------------------------

export interface LlmRuntime {
  readonly model: string;
  readonly client: unknown;
  readonly collector: unknown;
  readonly mainToolDefs: unknown[];
  readonly runtimeConfig: { endpointHost: string };
}

export async function loadLLMRuntime(
  tpl: { applyLanguage?: (lang: string) => void } | null | undefined,
  toolConfigPath: string,
  _resolveOpts?: unknown,
): Promise<LlmRuntime> {
  if (toolConfigPath !== "" && toolConfigPath !== undefined) {
    if (!existsSync(toolConfigPath)) {
      throw new Error(`load tools: file not found ${toolConfigPath}`);
    }
    try {
      const content = readFileSync(toolConfigPath, "utf8");
      JSON.parse(content);
    } catch (e) {
      throw new Error(`load tools: ${(e as Error).message}`);
    }
  }
  const home = process.env["HOME"] ?? "";
  const cfgPath = `${home}/.opencodereview/config.json`;
  if (home !== "" && existsSync(cfgPath)) {
    try {
      const raw = readFileSync(cfgPath, "utf8");
      JSON.parse(raw);
    } catch (e) {
      throw new Error(`load app config: ${(e as Error).message}`);
    }
  }
  const url = process.env["OCR_LLM_URL"] ?? process.env["ANTHROPIC_BASE_URL"] ?? "";
  const token = process.env["OCR_LLM_TOKEN"] ?? process.env["ANTHROPIC_AUTH_TOKEN"] ?? "";
  const model = process.env["OCR_LLM_MODEL"] ?? process.env["ANTHROPIC_MODEL"] ?? "";
  if (url === "" || token === "" || model === "") {
    const cfgExists = home !== "" && existsSync(cfgPath);
    if (!cfgExists) {
      throw new Error("resolve LLM endpoint: no endpoint configured");
    }
    throw new Error("resolve LLM endpoint: incomplete config");
  }
  let host = "";
  try { host = new URL(url).host.toLowerCase(); } catch { host = ""; }
  const collector = {};
  const client = {};
  if (tpl && typeof (tpl as Record<string, unknown>)["applyLanguage"] === "function") {
    // apply language if present
  }
  return {
    model,
    client,
    collector,
    mainToolDefs: [{ function: { name: "code_comment" } }, { function: { name: "task_done" } }],
    runtimeConfig: { endpointHost: host },
  };
}

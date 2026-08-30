// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/root.go, version.go, shared.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * OCR-compatible CLI entry point — review/scan with text/json/sarif/agent,
 * preview, usage summaries, and exit-code contract.
 *
 * This is the Phase 9 parity slice. It does not import legacy `src/cli.ts`
 * policy; it duplicates the narrow `CliIo` seam and is injected via factory
 * fns so `bun test` never needs a paid model.
 */

import type { CliIo, CliIoOverrides } from "./shared.js";
import { CliUsageError, makeIo, defaultReviewOptions, defaultScanOptions } from "./shared.js";
import type { ReviewOptions, ScanOptions, FindingsOptions } from "./shared.js";
import { validateReviewOptions, validateScanOptions, validateFindingsOptions, defaultFindingsOptions } from "./shared.js";
import { runReviewContext } from "./review.js";
import { runScanContext } from "./scan.js";
import { runFindingsContext } from "./findings.js";
import type { ReviewRunner, PreviewFactory } from "./review.js";
import type { ScanRunner, ScanPreviewFactory } from "./scan.js";
import type { Preview } from "../model/preview.js";
import type { JsonLlmIdentity, RetryReport } from "./output.js";
import {
  resolveBackground,
  type CommitMessageReader,
} from "./background.js";
import { resolveRepoDir, validateReviewRefs } from "./git.js";
import { flagErrorWithSuggestion } from "./flag-suggest.js";
import { colorModeError, resolveColor, validateColorMode } from "./color.js";

// ---------------------------------------------------------------------------
// Version / help text — mirrors Go root.go + version.go
// ---------------------------------------------------------------------------

export const VERSION = "0.4.0";
export const GIT_COMMIT = "";
export const BUILD_DATE = "";
export const OCR_COMPATIBILITY_VERSION = "v1.9.9";

export interface BuildInfo {
  readonly version: string;
  readonly ocrVersion: string;
  readonly commit: string;
  readonly date: string;
  readonly platform: string;
  readonly arch: string;
}

export function formatVersion(info: BuildInfo): string {
  let s = `pi-review ${info.version}`;
  if (info.commit !== "") s += ` (${info.commit})`;
  s += ` ${info.platform}/${info.arch}\n`;
  s += `OCR compatibility: ${info.ocrVersion}\n`;
  if (info.date !== "") s += `built at: ${info.date}\n`;
  s += "https://github.com/bermudi/pi-reviewer\n";
  return s;
}

export function versionString(): string {
  return formatVersion({
    version: VERSION,
    ocrVersion: OCR_COMPATIBILITY_VERSION,
    commit: GIT_COMMIT,
    date: BUILD_DATE,
    platform: process.platform,
    arch: process.arch,
  });
}

export const HELP_TEXT = `pi-review - AI-Powered Code Review CLI

An AI-powered code review tool that reads git diffs, sends them to a
configurable LLM service, and generates review comments.

Usage:
  pi-review review [flags]
  pi-review scan [flags]
  pi-review findings [flags]
  pi-review version

Review flags:
  --repo PATH                 root directory of the git repository (default: current dir)
  --rule PATH                 path to JSON file with system review rules
  --from REF                  source ref to start diff from (e.g., 'main')
  --to REF                    target ref to end diff at (e.g., 'feature-branch')
  -c, --commit REF            single commit hash or tag to review (vs its parent)
  --resume ID                 resume from a previous review session id
  --exclude PATTERNS          comma-separated gitignore-style patterns to exclude
  -f, --format FORMAT         output format: text, json, or sarif (default: text)
  --audience AUDIENCE         output audience: human or agent (default: human)
  --concurrency N             max concurrent file reviews (default: 8)
  --timeout N                 concurrent task timeout in minutes (default: 10)
  --max-tools N               max tool call rounds per file (0 = template default; min 10)
  --max-git-procs N           max concurrent git subprocesses (default: 16)
  --max-tokens N              per-file prompt token ceiling (0 = configured or template default)
  --max-tokens-budget N       cap total token usage (0 = unlimited)
  -b, --background TEXT       optional requirement/business context for the review
  -B, --background-file PATH  path to a Markdown file used as review background
  --provider NAME             override configured LLM provider for this run
  --model NAME                override LLM model for this run
  --tools PATH                path to JSON tools config file (default: embedded)
  -p, --preview               preview which files will be reviewed without running the LLM
  --no-filter                 keep all review comments without LLM post-filtering

Scan flags:
  --repo PATH                 root directory of the git repository (default: current dir)
  --rule PATH                 path to JSON file with system review rules
  --path PATHS                comma-separated repo-relative directories or files to scan
  --exclude PATTERNS          comma-separated gitignore-style patterns to exclude
  -f, --format FORMAT         output format: text, json, or sarif (default: text)
  --audience AUDIENCE         output audience: human or agent (default: human)
  --concurrency N             max concurrent file scans (default: 8)
  --timeout N                 concurrent task timeout in minutes (default: 10)
  --max-tools N               max tool call rounds per file
  --max-git-procs N           max concurrent git subprocesses (default: 16)
  --max-tokens N              per-file prompt token ceiling (0 = configured or template default)
  --max-tokens-budget N       cap total token usage (0 = unlimited)
  -b, --background TEXT       optional requirement/business context for the scan
  -p, --preview               preview which files will be scanned without running the LLM
  --no-plan                   skip the per-file PLAN_TASK pre-pass
  --no-dedup                  skip the per-batch DEDUP_TASK
  --no-summary                skip the post-run PROJECT_SUMMARY_TASK
  --batch STRATEGY            override BATCH_STRATEGY: none | by-language | by-directory
  --provider NAME             override configured LLM provider for this run
  --model NAME                override LLM model for this run
  --resume ID                 resume from a previous scan session id
  --tools PATH                path to JSON tools config file (default: embedded)

Findings flags (replay findings from a previous local review or scan):
  --repo PATH                 repository whose sessions to read (default: current dir)
  --session ID                replay a specific session (default: most recent for the repository)
  -f, --format FORMAT         output format: text, json, or sarif (default: text)

Exit status: 0 complete, partial, or skipped; 1 failed or invalid usage.
findings exits 0 when it displays a session (even one with no findings) and
1 when there is no session to show, the session id is unknown, or usage is
invalid.
`;

// ---------------------------------------------------------------------------
// Dependency seam — mirrors legacy CliDependencies but OCR-shaped
// ---------------------------------------------------------------------------

export type Utf8FileReader = (path: string, encoding: "utf8") => Promise<string> | string;

export interface OcrCliDependencies {
  readonly io?: CliIoOverrides;
  readonly readFile?: Utf8FileReader;
  readonly getCommitMessage?: CommitMessageReader;
  readonly version?: string;
  readonly reviewRunnerFactory?: (opts: ReviewOptions, signal?: AbortSignal) => Promise<ReviewRunner>;
  readonly reviewPreviewFactory?: PreviewFactory;
  readonly scanRunnerFactory?: (opts: ScanOptions, signal?: AbortSignal) => Promise<ScanRunner>;
  readonly scanPreviewFactory?: ScanPreviewFactory;
  readonly traceId?: string;
  readonly llmIdentity?: JsonLlmIdentity;
  readonly retryReport?: RetryReport | null;
}

// ---------------------------------------------------------------------------
// Flag parsing — lightweight, strict, no any
// ---------------------------------------------------------------------------

type FlagSpec = {
  readonly name: string;
  readonly short?: string;
  readonly takesValue: boolean;
};

const REVIEW_FLAGS: readonly FlagSpec[] = [
  { name: "color", takesValue: true },
  { name: "repo", takesValue: true },
  { name: "rule", takesValue: true },
  { name: "from", takesValue: true },
  { name: "to", takesValue: true },
  { name: "commit", short: "c", takesValue: true },
  { name: "resume", takesValue: true },
  { name: "exclude", takesValue: true },
  { name: "format", short: "f", takesValue: true },
  { name: "audience", takesValue: true },
  { name: "background", short: "b", takesValue: true },
  { name: "background-file", short: "B", takesValue: true },
  { name: "provider", takesValue: true },
  { name: "model", takesValue: true },
  { name: "concurrency", takesValue: true },
  { name: "timeout", takesValue: true },
  { name: "max-tools", takesValue: true },
  { name: "max-git-procs", takesValue: true },
  { name: "max-tokens", takesValue: true },
  { name: "max-tokens-budget", takesValue: true },
  { name: "tools", takesValue: true },
  { name: "preview", short: "p", takesValue: false },
  { name: "no-filter", takesValue: false },
  { name: "help", short: "h", takesValue: false },
];

const SCAN_FLAGS: readonly FlagSpec[] = [
  { name: "color", takesValue: true },
  { name: "repo", takesValue: true },
  { name: "rule", takesValue: true },
  { name: "path", takesValue: true },
  { name: "exclude", takesValue: true },
  { name: "format", short: "f", takesValue: true },
  { name: "audience", takesValue: true },
  { name: "background", short: "b", takesValue: true },
  { name: "concurrency", takesValue: true },
  { name: "timeout", takesValue: true },
  { name: "max-tools", takesValue: true },
  { name: "max-git-procs", takesValue: true },
  { name: "max-tokens", takesValue: true },
  { name: "max-tokens-budget", takesValue: true },
  { name: "tools", takesValue: true },
  { name: "preview", short: "p", takesValue: false },
  { name: "no-plan", takesValue: false },
  { name: "no-dedup", takesValue: false },
  { name: "no-summary", takesValue: false },
  { name: "batch", takesValue: true },
  { name: "provider", takesValue: true },
  { name: "model", takesValue: true },
  { name: "resume", takesValue: true },
  { name: "help", short: "h", takesValue: false },
];

const FINDINGS_FLAGS: readonly FlagSpec[] = [
  { name: "color", takesValue: true },
  { name: "repo", takesValue: true },
  { name: "session", takesValue: true },
  { name: "format", short: "f", takesValue: true },
  { name: "help", short: "h", takesValue: false },
];

function buildFlagMaps(specs: readonly FlagSpec[]): {
  byLong: Map<string, FlagSpec>;
  byShort: Map<string, FlagSpec>;
} {
  const byLong = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const s of specs) {
    byLong.set(s.name, s);
    if (s.short) byShort.set(s.short, s);
  }
  return { byLong, byShort };
}

function parseIntStrict(raw: string, flag: string): number {
  if (!/^-?\d+$/u.test(raw)) throw new CliUsageError(`invalid --${flag} value "${raw}": must be an integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new CliUsageError(`invalid --${flag} value "${raw}": out of range`);
  return n;
}

function parseFlags(
  argv: readonly string[],
  specs: readonly FlagSpec[],
): Map<string, string | boolean> {
  const { byLong, byShort } = buildFlagMaps(specs);
  const out = new Map<string, string | boolean>();
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i] ?? "";
    if (tok === "--") {
      i++;
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const spec = byLong.get(key);
      if (!spec) {
        const available = specs.map((s) => s.name);
        throw flagErrorWithSuggestion(available, new CliUsageError(`unknown flag: --${key}`));
      }
      if (spec.takesValue) {
        let val: string;
        if (eq !== -1) val = tok.slice(eq + 1);
        else {
          const nxt = argv[i + 1];
          if (nxt === undefined || (nxt.startsWith("-") && !/^-?\d+$/u.test(nxt))) throw new CliUsageError(`--${key} requires a value`);
          val = nxt;
          i++;
        }
        if (out.has(spec.name)) throw new CliUsageError(`duplicate --${spec.name}`);
        out.set(spec.name, val);
      } else {
        if (eq !== -1) throw new CliUsageError(`--${key} does not take a value`);
        if (out.has(spec.name)) throw new CliUsageError(`duplicate --${spec.name}`);
        out.set(spec.name, true);
      }
      i++;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // short flags, may be combined for booleans, but value flags need separate token
      const chars = tok.slice(1);
      // if it's -c / -f / -b / -B with attached value like -c=abc (handled as --commit) or -f=json
      if (chars.includes("=")) {
        const eq2 = tok.indexOf("=");
        const shortKey = tok.slice(1, eq2);
        const spec = byShort.get(shortKey);
        if (!spec) {
          const available = specs.map((s) => s.name);
          throw flagErrorWithSuggestion(available, new CliUsageError(`unknown flag: -${shortKey}`));
        }
        if (!spec.takesValue) throw new CliUsageError(`-${shortKey} does not take a value`);
        const val = tok.slice(eq2 + 1);
        if (out.has(spec.name)) throw new CliUsageError(`duplicate --${spec.name}`);
        out.set(spec.name, val);
        i++;
        continue;
      }
      // Single short like -c, -p, -f, -b, -B
      if (chars.length === 1) {
        const spec = byShort.get(chars);
        if (!spec) {
          const available = specs.map((s) => s.name);
          throw flagErrorWithSuggestion(available, new CliUsageError(`unknown flag: -${chars}`));
        }
        if (spec.takesValue) {
          const nxt = argv[i + 1];
          if (nxt === undefined || (nxt.startsWith("-") && !/^-?\d/u.test(nxt))) throw new CliUsageError(`-${chars} requires a value`);
          if (out.has(spec.name)) throw new CliUsageError(`duplicate --${spec.name}`);
          out.set(spec.name, nxt);
          i += 2;
          continue;
        }
        // bool
        if (out.has(spec.name)) throw new CliUsageError(`duplicate --${spec.name}`);
        out.set(spec.name, true);
        i++;
        continue;
      }
      // combined booleans like -p (only known boolean shorts are p)
      let consumed = false;
      for (const ch of chars) {
        const spec = byShort.get(ch);
        if (!spec) {
          const available = specs.map((s) => s.name);
          throw flagErrorWithSuggestion(available, new CliUsageError(`unknown flag: -${ch}`));
        }
        if (spec.takesValue) throw new CliUsageError(`flag -${ch} requires a value and cannot be combined`);
        if (out.has(spec.name)) throw new CliUsageError(`duplicate --${spec.name}`);
        out.set(spec.name, true);
        consumed = true;
      }
      if (consumed) { i++; continue; }
    }
    throw new CliUsageError(`unexpected argument "${tok}"; flags must use --option form`);
  }
  return out;
}

function flagVal(map: Map<string, string | boolean>, key: string): string | undefined {
  const v = map.get(key);
  return typeof v === "string" ? v : undefined;
}

function flagBool(map: Map<string, string | boolean>, key: string): boolean {
  return map.get(key) === true;
}

export function parseReviewFlags(argv: readonly string[]): ReviewOptions {
  const map = parseFlags(argv, REVIEW_FLAGS);
  // Treat -h as help that should not error; mimic Go's cobra help handling for test
  if (map.get("help") === true) return buildReviewOptions(map);
  const opts = buildReviewOptions(map);
  if (!validateColorMode(opts.color)) throw new CliUsageError(colorModeError(opts.color).message);
  validateReviewOptions(opts);
  if (opts.from !== "" && opts.to === "") throw new CliUsageError("--to is required when --from is specified");
  if (opts.to !== "" && opts.from === "") throw new CliUsageError("--from is required when --to is specified");
  return opts;
}

export function parseScanFlags(argv: readonly string[]): ScanOptions {
  const map = parseFlags(argv, SCAN_FLAGS);
  if (map.get("help") === true) return buildScanOptions(map);
  const opts = buildScanOptions(map);
  if (!validateColorMode(opts.color)) throw new CliUsageError(colorModeError(opts.color).message);
  validateScanOptions(opts);
  return opts;
}

export function parseFindingsFlags(argv: readonly string[]): FindingsOptions {
  const map = parseFlags(argv, FINDINGS_FLAGS);
  if (map.get("help") === true) return buildFindingsOptions(map);
  const opts = buildFindingsOptions(map);
  if (!validateColorMode(opts.color)) throw new CliUsageError(colorModeError(opts.color).message);
  validateFindingsOptions(opts);
  return opts;
}

function buildReviewOptions(map: Map<string, string | boolean>): ReviewOptions {
  const base = defaultReviewOptions();
  const out: ReviewOptions = {
    toolConfigPath: flagVal(map, "tools") ?? base.toolConfigPath,
    rulePath: flagVal(map, "rule") ?? base.rulePath,
    repoDir: flagVal(map, "repo") ?? base.repoDir,
    from: flagVal(map, "from") ?? base.from,
    to: flagVal(map, "to") ?? base.to,
    commit: flagVal(map, "commit") ?? base.commit,
    resume: flagVal(map, "resume") ?? base.resume,
    excludes: flagVal(map, "exclude") ?? base.excludes,
    outputFormat: (flagVal(map, "format") as ReviewOptions["outputFormat"]) ?? base.outputFormat,
    color: (flagVal(map, "color") as ReviewOptions["color"]) ?? base.color,
    audience: (flagVal(map, "audience") as ReviewOptions["audience"]) ?? base.audience,
    background: flagVal(map, "background") ?? base.background,
    backgroundFile: flagVal(map, "background-file") ?? base.backgroundFile,
    provider: flagVal(map, "provider") ?? base.provider,
    model: flagVal(map, "model") ?? base.model,
    concurrency: flagVal(map, "concurrency") !== undefined ? parseIntStrict(flagVal(map, "concurrency") as string, "concurrency") : base.concurrency,
    perFileTimeout: flagVal(map, "timeout") !== undefined ? parseIntStrict(flagVal(map, "timeout") as string, "timeout") : base.perFileTimeout,
    maxTools: flagVal(map, "max-tools") !== undefined ? parseIntStrict(flagVal(map, "max-tools") as string, "max-tools") : base.maxTools,
    maxGitProcs: flagVal(map, "max-git-procs") !== undefined ? parseIntStrict(flagVal(map, "max-git-procs") as string, "max-git-procs") : base.maxGitProcs,
    maxTokens: flagVal(map, "max-tokens") !== undefined ? parseIntStrict(flagVal(map, "max-tokens") as string, "max-tokens") : base.maxTokens,
    maxTokensBudget: flagVal(map, "max-tokens-budget") !== undefined ? parseIntStrict(flagVal(map, "max-tokens-budget") as string, "max-tokens-budget") : base.maxTokensBudget,
    noFilter: flagBool(map, "no-filter"),
    preview: flagBool(map, "preview"),
  };
  // --max-tools below 10 is clamped with warning (mirrors Go: below min is raised to min)
  if (out.maxTools > 0 && out.maxTools < 10) {
    // We emit warning via caller io.stderr if available; here we just clamp silently and let caller handle emit
    (out as unknown as Record<string, unknown>)["maxTools"] = 10;
  }
  return out;
}

function buildScanOptions(map: Map<string, string | boolean>): ScanOptions {
  const base = defaultScanOptions();
  const out: ScanOptions = {
    toolConfigPath: flagVal(map, "tools") ?? base.toolConfigPath,
    rulePath: flagVal(map, "rule") ?? base.rulePath,
    repoDir: flagVal(map, "repo") ?? base.repoDir,
    paths: flagVal(map, "path") ?? base.paths,
    excludes: flagVal(map, "exclude") ?? base.excludes,
    outputFormat: (flagVal(map, "format") as ScanOptions["outputFormat"]) ?? base.outputFormat,
    color: (flagVal(map, "color") as ScanOptions["color"]) ?? base.color,
    audience: (flagVal(map, "audience") as ScanOptions["audience"]) ?? base.audience,
    background: flagVal(map, "background") ?? base.background,
    concurrency: flagVal(map, "concurrency") !== undefined ? parseIntStrict(flagVal(map, "concurrency") as string, "concurrency") : base.concurrency,
    perFileTimeout: flagVal(map, "timeout") !== undefined ? parseIntStrict(flagVal(map, "timeout") as string, "timeout") : base.perFileTimeout,
    maxTools: flagVal(map, "max-tools") !== undefined ? parseIntStrict(flagVal(map, "max-tools") as string, "max-tools") : base.maxTools,
    maxGitProcs: flagVal(map, "max-git-procs") !== undefined ? parseIntStrict(flagVal(map, "max-git-procs") as string, "max-git-procs") : base.maxGitProcs,
    maxTokens: flagVal(map, "max-tokens") !== undefined ? parseIntStrict(flagVal(map, "max-tokens") as string, "max-tokens") : base.maxTokens,
    maxTokensBudget: flagVal(map, "max-tokens-budget") !== undefined ? parseIntStrict(flagVal(map, "max-tokens-budget") as string, "max-tokens-budget") : base.maxTokensBudget,
    preview: flagBool(map, "preview"),
    noPlan: flagBool(map, "no-plan"),
    noDedup: flagBool(map, "no-dedup"),
    noSummary: flagBool(map, "no-summary"),
    batch: flagVal(map, "batch") ?? base.batch,
    provider: flagVal(map, "provider") ?? base.provider,
    model: flagVal(map, "model") ?? base.model,
    resume: flagVal(map, "resume") ?? base.resume,
  };
  if (out.maxTools > 0 && out.maxTools < 10) {
    (out as unknown as Record<string, unknown>)["maxTools"] = 10;
  }
  return out;
}

function buildFindingsOptions(map: Map<string, string | boolean>): FindingsOptions {
  const base = defaultFindingsOptions();
  return {
    repoDir: flagVal(map, "repo") ?? base.repoDir,
    sessionId: flagVal(map, "session") ?? base.sessionId,
    outputFormat: (flagVal(map, "format") as FindingsOptions["outputFormat"]) ?? base.outputFormat,
    color: (flagVal(map, "color") as FindingsOptions["color"]) ?? base.color,
  };
}

// ---------------------------------------------------------------------------
// Top-level runCli — test seam
// ---------------------------------------------------------------------------

export async function runCli(
  argv: readonly unknown[] = process.argv.slice(2),
  deps: OcrCliDependencies = {},
): Promise<number> {
  const io = makeIo(deps.io);
  let args: string[] = (() => {
    const parsed: string[] = [];
    for (const a of argv) {
      if (typeof a !== "string") throw new CliUsageError("Arguments must be strings.");
      parsed.push(a);
    }
    return parsed;
  })();

  let persistentColor: ReviewOptions["color"] | undefined;
  try {
    const normalized: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      let value: string | undefined;
      if (arg.startsWith("--color=")) {
        value = arg.slice("--color=".length);
      } else if (arg === "--color") {
        const next = args[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new CliUsageError(colorModeError("").message);
        }
        value = next;
        index += 1;
      } else {
        normalized.push(arg);
        continue;
      }
      if (persistentColor !== undefined) {
        throw new CliUsageError("--color may be specified only once; must be one of auto, always, never");
      }
      if (!validateColorMode(value)) throw new CliUsageError(colorModeError(value).message);
      persistentColor = value;
    }
    args = normalized;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unable to parse --color.";
    io.stderr(`Error: ${message}\n`);
    return 1;
  }

  // Root flags: --version / -V / --help before subcommand
  if (args.length === 0) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const first = args[0] ?? "";
  if (first === "--version" || first === "-V" || first === "version") {
    // Allow `pi-review version` or `pi-review --version` or `pi-review -V`
    if (first === "version" && args.length > 1) {
      const extra = args[1] ?? "";
      io.stderr(`Error: unknown command "${extra}" for "pi-review version"\n\n${HELP_TEXT}`);
      return 1;
    }
    io.stdout(versionString());
    return 0;
  }

  if (first === "--help" || first === "-h" || first === "help") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const cmd = first;
  const rest = args.slice(1);

  // Handle `review --help` / `scan --help`
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (cmd === "review" || cmd === "r") {
    let map: Map<string, string | boolean>;
    try {
      map = parseFlags(rest, REVIEW_FLAGS);
    } catch (err) {
      if (err instanceof CliUsageError) io.stderr(`Error: ${err.message}\n\n${HELP_TEXT}`);
      else io.stderr("Error: Unable to parse command-line arguments.\n");
      return 1;
    }
    let opts: ReviewOptions;
    try {
      opts = buildReviewOptions(map);
      if (persistentColor !== undefined) opts = { ...opts, color: persistentColor };
      if (!validateColorMode(opts.color)) throw new CliUsageError(colorModeError(opts.color).message);
      validateReviewOptions(opts);
    } catch (err) {
      if (err instanceof CliUsageError) io.stderr(`Error: ${err.message}\n\n${HELP_TEXT}`);
      else io.stderr(`Error: ${String((err as Error).message)}\n`);
      return 1;
    }

    // Clamp max-tools warning to stderr (mirrors Go)
    const rawMaxTools = flagVal(map, "max-tools");
    if (rawMaxTools !== undefined) {
      const n = Number(rawMaxTools);
      if (Number.isSafeInteger(n) && n > 0 && n < 10) {
        io.stderr(`[pi-review] --max-tools ${String(n)} is below minimum 10, using 10\n`);
      }
    }

    // Resolve repository and validate refs before any ref-bearing Git command,
    // matching Go executeReview order: loadCommonContext → validateReviewRefs → getCommitMessage.
    let resolvedRepoDir: string;
    try {
      resolvedRepoDir = opts.repoDir !== "" ? resolveRepoDir(opts.repoDir) : resolveRepoDir(io.cwd());
    } catch (e) {
      io.stderr(
        `Error: ${String((e as Error).message)}\n` +
        "Hint: run pi-review from a Git repository or pass --repo /path/to/repository.\n",
      );
      return 1;
    }
    try {
      validateReviewRefs(resolvedRepoDir, opts);
    } catch (e) {
      io.stderr(`Error: ${String((e as Error).message)}\n`);
      return 1;
    }

    try {
      const background = await resolveBackground(
        resolvedRepoDir,
        opts.background,
        opts.backgroundFile,
        opts.commit,
        {
          readFile: deps.readFile,
          getCommitMessage: deps.getCommitMessage,
          stderr: (message) => io.stderr(message),
        },
      );
      opts = { ...opts, background, backgroundFile: "", backgroundResolved: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      io.stderr(`Error: ${msg}\n`);
      return 1;
    }

    // Use the same AbortSignal that reaches the review Agent.  The Agent owns
    // cancellation classification, manifest finalization, and session
    // persistence; the CLI only translates process signals at this boundary.
    const abortController = new AbortController();
    const onInterrupt = (): void => {
      if (!abortController.signal.aborted) {
        abortController.abort(new Error("review was cancelled"));
      }
    };
    io.onSignal("SIGINT", onInterrupt);
    io.onSignal("SIGTERM", onInterrupt);
    const signal = abortController.signal;
    const colorEnabled = resolveColor(opts.color, io.env()["TERM"], io.stdoutIsTTY?.() ?? false);
    const startMs = Date.now();

    const reviewRunnerFactory = deps.reviewRunnerFactory;
    const previewFactory: PreviewFactory | undefined = deps.reviewPreviewFactory
      ?? (async (o: ReviewOptions): Promise<Preview> => {
        // Stub preview using real agent preview when available: fallback to empty
        void o;
        return {
          entries: [],
          totalInsertions: 0,
          totalDeletions: 0,
          totalFiles: 0,
          reviewableCount: 0,
          excludedCount: 0,
        };
      });

    try {
      const code = await runReviewContext({
        io,
        opts,
        version: deps.version ?? VERSION,
        traceId: deps.traceId ?? "",
        llmIdentity: deps.llmIdentity,
        retryReport: deps.retryReport ?? null,
        startMs,
        signal,
        colorEnabled,
        previewFactory,
        runnerFactory: reviewRunnerFactory ? (sig) => reviewRunnerFactory(opts, sig) : undefined,
      });
      return code;
    } catch (err) {
      if (err instanceof CliUsageError) {
        io.stderr(`Error: ${err.message}\n\n${HELP_TEXT}`);
        return 1;
      }
      io.stderr(`Error: ${String((err as Error).message)}\n`);
      return 1;
    } finally {
      io.offSignal("SIGINT", onInterrupt);
      io.offSignal("SIGTERM", onInterrupt);
    }
  }

  if (cmd === "scan" || cmd === "s") {
    let map: Map<string, string | boolean>;
    try {
      map = parseFlags(rest, SCAN_FLAGS);
    } catch (err) {
      if (err instanceof CliUsageError) io.stderr(`Error: ${err.message}\n\n${HELP_TEXT}`);
      else io.stderr("Error: Unable to parse command-line arguments.\n");
      return 1;
    }
    let opts: ScanOptions;
    try {
      opts = buildScanOptions(map);
      if (persistentColor !== undefined) opts = { ...opts, color: persistentColor };
      if (!validateColorMode(opts.color)) throw new CliUsageError(colorModeError(opts.color).message);
      validateScanOptions(opts);
    } catch (err) {
      if (err instanceof CliUsageError) io.stderr(`Error: ${err.message}\n\n${HELP_TEXT}`);
      else io.stderr(`Error: ${String((err as Error).message)}\n`);
      return 1;
    }

    const rawScanMaxTools = flagVal(map, "max-tools");
    if (rawScanMaxTools !== undefined) {
      const n = Number(rawScanMaxTools);
      if (Number.isSafeInteger(n) && n > 0 && n < 10) {
        io.stderr(`[pi-review] --max-tools ${String(n)} is below minimum 10, using 10\n`);
      }
    }

    const startMs = Date.now();
    const colorEnabled = resolveColor(opts.color, io.env()["TERM"], io.stdoutIsTTY?.() ?? false);
    const scanPreviewFactory: ScanPreviewFactory | undefined = deps.scanPreviewFactory
      ?? (async (): Promise<Preview> => ({
        entries: [],
        totalInsertions: 0,
        totalDeletions: 0,
        totalFiles: 0,
        reviewableCount: 0,
        excludedCount: 0,
      }));

    try {
      const code = await runScanContext({
        io,
        opts,
        traceId: deps.traceId ?? "",
        llmIdentity: deps.llmIdentity,
        startMs,
        colorEnabled,
        previewFactory: scanPreviewFactory,
        runnerFactory: deps.scanRunnerFactory ? (sig) => deps.scanRunnerFactory?.(opts, sig) as Promise<ScanRunner> : undefined,
      });
      return code;
    } catch (err) {
      if (err instanceof CliUsageError) {
        io.stderr(`Error: ${err.message}\n\n${HELP_TEXT}`);
        return 1;
      }
      io.stderr(`Error: ${String((err as Error).message)}\n`);
      return 1;
    }
  }

  if (cmd === "findings") {
    let map: Map<string, string | boolean>;
    try {
      map = parseFlags(rest, FINDINGS_FLAGS);
    } catch (err) {
      if (err instanceof CliUsageError) io.stderr(`Error: ${err.message}\n\n${HELP_TEXT}`);
      else io.stderr("Error: Unable to parse command-line arguments.\n");
      return 1;
    }
    let opts: FindingsOptions;
    try {
      opts = buildFindingsOptions(map);
      if (persistentColor !== undefined) opts = { ...opts, color: persistentColor };
      if (!validateColorMode(opts.color)) throw new CliUsageError(colorModeError(opts.color).message);
      validateFindingsOptions(opts);
    } catch (err) {
      if (err instanceof CliUsageError) io.stderr(`Error: ${err.message}\n\n${HELP_TEXT}`);
      else io.stderr(`Error: ${String((err as Error).message)}\n`);
      return 1;
    }

    try {
      return runFindingsContext({ io, opts, version: deps.version ?? VERSION });
    } catch (err) {
      io.stderr(`Error: ${String((err as Error).message)}\n`);
      return 1;
    }
  }

  io.stderr(`Error: unknown command "${cmd}"; expected review, scan, or findings\n\n${HELP_TEXT}`);
  return 1;
}

export const runOcrCli = runCli;

/** Production entry point. */
export async function main(argv: readonly unknown[] = process.argv.slice(2), deps: OcrCliDependencies = {}): Promise<number> {
  return runCli(argv, deps);
}

if (import.meta.main) {
  void main().then((code) => {
    process.exit(code);
  }).catch(() => {
    process.exit(1);
  });
}

// Re-exports for consumers
export type { ReviewOptions, ScanOptions, CliIo, CliIoOverrides } from "./shared.js";
export { CliUsageError } from "./shared.js";
export type { Preview } from "../model/preview.js";

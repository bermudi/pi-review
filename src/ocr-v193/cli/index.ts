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
import type { ReviewOptions, ScanOptions } from "./shared.js";
import { validateReviewOptions, validateScanOptions } from "./shared.js";
import { runReviewContext } from "./review.js";
import { runScanContext } from "./scan.js";
import type { ReviewRunner, PreviewFactory } from "./review.js";
import type { ScanRunner, ScanPreviewFactory } from "./scan.js";
import type { Preview } from "../model/preview.js";
import type { JsonLlmIdentity, RetryReport } from "./output.js";

// ---------------------------------------------------------------------------
// Version / help text — mirrors Go root.go + version.go
// ---------------------------------------------------------------------------

export const VERSION = "0.2.0";
export const GIT_COMMIT = "";
export const BUILD_DATE = "";

export function versionString(): string {
  let s = `pi-review ${VERSION}`;
  if (GIT_COMMIT !== "") s += ` (${GIT_COMMIT})`;
  s += "\nhttps://github.com/bermudi/pi-reviewer\n";
  if (BUILD_DATE !== "") s += `built at: ${BUILD_DATE}\n`;
  return s;
}

export const HELP_TEXT = `pi-review - AI-Powered Code Review CLI

An AI-powered code review tool that reads git diffs, sends them to a
configurable LLM service, and generates review comments.

Usage:
  pi-review review [flags]
  pi-review scan [flags]
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

Exit status: 0 complete, partial, or skipped; 1 failed or invalid usage.
`;

// ---------------------------------------------------------------------------
// Dependency seam — mirrors legacy CliDependencies but OCR-shaped
// ---------------------------------------------------------------------------

export type Utf8FileReader = (path: string, encoding: "utf8") => Promise<string> | string;

export interface OcrCliDependencies {
  readonly io?: CliIoOverrides;
  readonly readFile?: Utf8FileReader;
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
  { name: "help", takesValue: false },
];

const SCAN_FLAGS: readonly FlagSpec[] = [
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
  { name: "help", takesValue: false },
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
      if (!spec) throw new CliUsageError(`unknown flag --${key}`);
      if (spec.takesValue) {
        let val: string;
        if (eq !== -1) val = tok.slice(eq + 1);
        else {
          const nxt = argv[i + 1];
          if (nxt === undefined || nxt.startsWith("-")) throw new CliUsageError(`--${key} requires a value`);
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
        if (!spec) throw new CliUsageError(`unknown flag -${shortKey}`);
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
        if (!spec) throw new CliUsageError(`unknown flag -${chars}`);
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
        if (!spec) throw new CliUsageError(`unknown flag -${ch}`);
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

// ---------------------------------------------------------------------------
// Background file handling
// ---------------------------------------------------------------------------

async function loadBackgroundFile(path: string, reader: Utf8FileReader | undefined): Promise<string> {
  const r: Utf8FileReader = reader ?? ((p: string, _enc: "utf8") => Bun.file(p).text());
  const text: unknown = await r(path, "utf8");
  if (typeof text !== "string") throw new CliUsageError(`background file ${path} did not return text`);
  return text;
}

// ---------------------------------------------------------------------------
// Top-level runCli — test seam
// ---------------------------------------------------------------------------

export async function runCli(
  argv: readonly unknown[] = process.argv.slice(2),
  deps: OcrCliDependencies = {},
): Promise<number> {
  const io = makeIo(deps.io);
  const args: string[] = (() => {
    const parsed: string[] = [];
    for (const a of argv) {
      if (typeof a !== "string") throw new CliUsageError("Arguments must be strings.");
      parsed.push(a);
    }
    return parsed;
  })();

  // Root flags: --version / -V / --help before subcommand
  if (args.length === 0) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const first = args[0] ?? "";
  if (first === "--version" || first === "-V" || first === "version") {
    // Allow `pi-review version` or `pi-review --version` or `pi-review -V`
    if (first === "version" && args.length > 1) {
      io.stderr(`Error: version takes no arguments\n\n${HELP_TEXT}`);
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
        io.stderr(`[ocr] --max-tools ${String(n)} is below minimum 10, using 10\n`);
      }
    }

    // Background file merging
    if (opts.backgroundFile !== "") {
      try {
        const fileBg = await loadBackgroundFile(opts.backgroundFile, deps.readFile);
        const merged = opts.background.trim() !== "" && fileBg.trim() !== "" ? `${opts.background}\n\n${fileBg}` : (opts.background !== "" ? opts.background : fileBg);
        opts = { ...opts, background: merged };
      } catch {
        io.stderr(`Error: Unable to read --background-file "${opts.backgroundFile}" as UTF-8.\n`);
        return 1;
      }
    }

    const signal = undefined;
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
        io.stderr(`[ocr] --max-tools ${String(n)} is below minimum 10, using 10\n`);
      }
    }

    const startMs = Date.now();
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
        retryReport: deps.retryReport ?? null,
        startMs,
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

  io.stderr(`Error: unknown command "${cmd}"; expected review or scan\n\n${HELP_TEXT}`);
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

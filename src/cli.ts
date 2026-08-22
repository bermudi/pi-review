#!/usr/bin/env bun
// SPDX-License-Identifier: GPL-3.0-or-later
// Thin production adapter over the OCR v1.9.3 CLI. This file contains no
// review policy and no --engine switch; it injects the real parity runners
// and preview factories and preserves the OCR command/flag semantics directly.
// Probe: CLIPRODADAPTER

import { newResolver } from "./ocr-v193/rules/system_rules.js";
import { previewDiffs } from "./ocr-v193/agent/preview.js";
import type { Preview } from "./ocr-v193/model/preview.js";
import type { ReviewOptions, ScanOptions } from "./ocr-v193/cli/shared.js";
import { makeIo } from "./ocr-v193/cli/shared.js";
import type { CliIoOverrides } from "./ocr-v193/cli/shared.js";
import { runCli as runOcrCli, versionString, HELP_TEXT } from "./ocr-v193/cli/index.js";
import type { ReviewRunner } from "./ocr-v193/cli/review.js";
import type { ScanRunner } from "./ocr-v193/cli/scan.js";
import { createReviewRunnerFactory, createScanRunnerFactory, createScanPreviewFactory } from "./ocr-v193/cli/factory.js";

export { HELP_TEXT, versionString } from "./ocr-v193/cli/index.js";
export type { CliIoOverrides } from "./ocr-v193/cli/shared.js";

export type Utf8FileReader = (path: string, encoding: "utf8") => Promise<string> | string;

export interface CliDependencies {
  readonly io?: CliIoOverrides;
  readonly readFile?: Utf8FileReader;
  readonly reviewRunnerFactory?: (opts: ReviewOptions, signal?: AbortSignal) => Promise<ReviewRunner>;
  readonly reviewPreviewFactory?: (opts: ReviewOptions, signal?: AbortSignal) => Promise<Preview>;
  readonly scanRunnerFactory?: (opts: ScanOptions, signal?: AbortSignal) => Promise<ScanRunner>;
  readonly scanPreviewFactory?: (opts: ScanOptions, signal?: AbortSignal) => Promise<Preview>;
}

function createReviewPreviewFactory(
  ioCwd: () => string,
): (opts: ReviewOptions, signal?: AbortSignal) => Promise<Preview> {
  return async (opts: ReviewOptions, signal?: AbortSignal): Promise<Preview> => {
    const repoDir = opts.repoDir !== "" ? opts.repoDir : ioCwd();
    const ruleSet = newResolver(repoDir, opts.rulePath);
    return previewDiffs(
      {
        repoDir,
        from: opts.from,
        to: opts.to,
        commit: opts.commit,
        fileFilter: ruleSet.filter ?? null,
      },
      signal,
    );
  };
}

/**
 * Testable CLI entry point. No process.exit inside this seam; production
 * exit handling lives in `main` / the `import.meta.main` block below.
 * Stdout is reserved for result output; diagnostics go to stderr via the
 * injected CliIo.
 */
export async function runCli(
  argv: readonly unknown[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const io = makeIo(dependencies.io);

  const reviewRunnerFactory: (opts: ReviewOptions, signal?: AbortSignal) => Promise<ReviewRunner> =
    dependencies.reviewRunnerFactory ??
    ((opts: ReviewOptions, signal?: AbortSignal) => createReviewRunnerFactory(opts, io.cwd())(signal));

  const scanRunnerFactory: (opts: ScanOptions, signal?: AbortSignal) => Promise<ScanRunner> =
    dependencies.scanRunnerFactory ??
    ((opts: ScanOptions, signal?: AbortSignal) => createScanRunnerFactory(opts, io.cwd())(signal));

  const reviewPreviewFactory: (opts: ReviewOptions, signal?: AbortSignal) => Promise<Preview> =
    dependencies.reviewPreviewFactory ?? createReviewPreviewFactory(io.cwd);

  const scanPreviewFactory: (opts: ScanOptions, signal?: AbortSignal) => Promise<Preview> =
    dependencies.scanPreviewFactory ??
    ((opts: ScanOptions, signal?: AbortSignal) => createScanPreviewFactory(opts, io.cwd())(signal));

  return runOcrCli(argv as string[], {
    io: dependencies.io,
    readFile: dependencies.readFile,
    reviewRunnerFactory,
    reviewPreviewFactory,
    scanRunnerFactory,
    scanPreviewFactory,
  });
}

/** Production entry point — thin wrapper over runCli for hosts that want a named main. */
export async function main(
  argv: readonly unknown[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  return runCli(argv, dependencies);
}

if (import.meta.main) {
  void main()
    .then((code) => {
      process.exit(code);
    })
    .catch(() => {
      process.exit(1);
    });
}

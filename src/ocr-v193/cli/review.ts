// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/review_cmd.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { LlmComment } from "../model/review.js";
import type { RunManifest } from "../session/manifest.js";
import type { Preview } from "../model/preview.js";
import type { ReviewOptions, CliIo } from "./shared.js";
import { CliUsageError, isMachineReadable } from "./shared.js";
import {
  outputTextWithWarnings,
  outputJsonWithWarnings,
  outputJsonNoFiles,
  outputPreview,
  outputRetryReportText,
  traceSummaryText,
  type AgentWarning,
  type JsonLlmIdentity,
  type RetryReport,
} from "./output.js";
import { outputSarifText } from "./sarif.js";

// ---------------------------------------------------------------------------
// ResultProvider seam — minimal surface both Agent types satisfy
// ---------------------------------------------------------------------------

export interface ResultProvider {
  Diffs(): unknown[];
  FilesReviewed(): number;
  TotalInputTokens(): number;
  TotalOutputTokens(): number;
  TotalTokensUsed(): number;
  TotalCacheReadTokens(): number;
  TotalCacheWriteTokens(): number;
  Warnings(): AgentWarning[];
  ProjectSummary(): string;
  ToolCalls(): Record<string, number>;
  SessionID(): string;
  BudgetExceeded(): boolean;
  RunManifest(): RunManifest | null | undefined;
  ResumeInfo?(): unknown;
}

// ---------------------------------------------------------------------------
// Helpers for preview dispatch in cli seam
// ---------------------------------------------------------------------------

export type PreviewFactory = (opts: ReviewOptions, signal?: AbortSignal) => Promise<Preview>;

// ---------------------------------------------------------------------------
// Factory shapes used by runReviewContext so tests can inject fakes
// ---------------------------------------------------------------------------

export interface ReviewRunner {
  run(signal?: AbortSignal): Promise<LlmComment[]>;
  manifest: RunManifest | null | undefined;
  warnings: AgentWarning[];
  filesReviewed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: Record<string, number>;
  sessionId: string;
  budgetExceeded: boolean;
  projectSummary: string;
  resumeInfo: unknown;
  diffs: unknown[];
}

export interface ReviewContext {
  io: CliIo;
  opts: ReviewOptions;
  version: string;
  traceId: string;
  llmIdentity: JsonLlmIdentity | undefined;
  retryReport: RetryReport | null | undefined;
  startMs: number;
  signal?: AbortSignal;
  previewFactory?: PreviewFactory;
  runnerFactory?: (signal?: AbortSignal) => Promise<ReviewRunner>;
}

// ---------------------------------------------------------------------------
// emitRunResult — shared finalization, mirrors Go emitRunResult
// ---------------------------------------------------------------------------

export function emitRunResult(
  provider: ResultProvider,
  comments: readonly LlmComment[],
  durationMs: number,
  outputFormat: string,
  audience: string,
  traceId: string,
  llmIdentity: JsonLlmIdentity | undefined,
  retryReport: RetryReport | null | undefined,
  io: Pick<CliIo, "stdout" | "stderr">,
): void {
  const manifest = provider.RunManifest() ?? null;
  const isMachine = isMachineReadable(outputFormat);
  const showTrace = traceId !== "" && !isMachine;

  if (isMachine && !manifest && comments.length === 0 && provider.FilesReviewed() === 0) {
    if (outputFormat === "json") {
      io.stdout(outputJsonNoFiles(traceId, llmIdentity));
    } else {
      io.stdout(outputSarifText([], "dev", provider.Warnings(), manifest));
    }
    return;
  }

  // Telemetry summary emulation: progress to stderr when not machine-readable
  if (!isMachine) {
    // Mirrors telemetry.PrintTraceSummary — simple placeholder
    if (showTrace) io.stderr(`[pi-review] TraceID: ${traceId}\n`);
  }

  if (outputFormat === "json") {
    const resumeInfo = typeof provider.ResumeInfo === "function" ? (provider.ResumeInfo() as unknown) : undefined;
    const json = outputJsonWithWarnings({
      comments,
      warnings: provider.Warnings(),
      filesReviewed: provider.FilesReviewed(),
      inputTokens: provider.TotalInputTokens(),
      outputTokens: provider.TotalOutputTokens(),
      totalTokens: provider.TotalTokensUsed(),
      cacheReadTokens: provider.TotalCacheReadTokens(),
      cacheWriteTokens: provider.TotalCacheWriteTokens(),
      durationMs,
      projectSummary: provider.ProjectSummary(),
      toolCalls: provider.ToolCalls(),
      traceId,
      resumeInfo,
      sessionId: provider.SessionID(),
      manifest,
      budgetExceeded: provider.BudgetExceeded(),
      llmIdentity,
      retryReport,
    });
    io.stdout(json);
    return;
  }

  if (outputFormat === "sarif") {
    io.stdout(outputSarifText([...comments], "dev", provider.Warnings(), manifest));
    return;
  }

  // Text audience: diagnostics already handled via io.stderr above
  const { stdout, stderr } = outputTextWithWarnings([...comments] as LlmComment[], provider.Warnings(), manifest);
  const summary = traceSummaryText({
    filesReviewed: provider.FilesReviewed(),
    comments: comments.length,
    inputTokens: provider.TotalInputTokens(),
    outputTokens: provider.TotalOutputTokens(),
    totalTokens: provider.TotalTokensUsed(),
    cacheReadTokens: provider.TotalCacheReadTokens(),
    cacheWriteTokens: provider.TotalCacheWriteTokens(),
    durationMs,
    sessionId: provider.SessionID(),
  });
  io.stdout(`${summary}${stdout}`);
  if (stderr !== "") io.stderr(stderr);
  const retryText = outputRetryReportText(retryReport);
  if (retryText !== "") io.stdout(retryText);
  const projectSummary = provider.ProjectSummary();
  if (projectSummary !== "") io.stdout(`\n\n──────── Project Summary ────────\n\n${projectSummary}\n`);
  void audience;
}

// ---------------------------------------------------------------------------
// validate helper for flag-like injection
// ---------------------------------------------------------------------------

function requireValidRef(flag: string, value: string): void {
  if (value.startsWith("-")) throw new CliUsageError(`${flag} value "${value}" is not a valid git ref: refs must not start with '-'`);
}

// ---------------------------------------------------------------------------
// Public entry point for review — testable seam
// ---------------------------------------------------------------------------

function modelIdFromReviewModel(model: string): string {
  if (model === "") return "test-model";
  const slash = model.indexOf("/");
  if (slash >= 0) {
    const after = model.slice(slash + 1);
    return after.split(":")[0] ?? "test-model";
  }
  return model.split(":")[0] ?? "test-model";
}

export async function runReviewContext(ctx: ReviewContext): Promise<number> {
  const { opts, io, version, traceId, llmIdentity, retryReport } = ctx;
  const effectiveLlmIdentity = llmIdentity ?? { model: modelIdFromReviewModel(opts.model) };

  // Validate mutually exclusive mode before git
  if (opts.preview && opts.resume !== "") throw new CliUsageError("--preview and --resume cannot be used together");
  if (opts.from !== "" && opts.commit !== "") throw new CliUsageError("only one review mode allowed (--from/--to or --commit)");
  if (opts.commit !== "" && (opts.from !== "" || opts.to !== "")) throw new CliUsageError("only one review mode allowed (--from/--to or --commit)");
  if (opts.from !== "" && opts.to === "") throw new CliUsageError("--to is required when --from is specified");
  if (opts.to !== "" && opts.from === "") throw new CliUsageError("--from is required when --to is specified");

  if (opts.commit !== "") requireValidRef("--commit", opts.commit);
  if (opts.from !== "") requireValidRef("--from", opts.from);
  if (opts.to !== "") requireValidRef("--to", opts.to);

  // Background file loading is handled in index.ts; at this point opts.background
  // already contains merged content if --background-file was supplied.

  // Preview short-circuit
  if (opts.preview) {
    if (!ctx.previewFactory) throw new Error("previewFactory required for preview run");
    const preview = await ctx.previewFactory(opts, ctx.signal);
    const { stdout, error } = outputPreview(preview, opts.outputFormat);
    if (error) throw new CliUsageError(error);
    io.stdout(stdout);
    return 0;
  }

  // Real run — via runnerFactory seam
  const start = ctx.startMs;
  let runner: ReviewRunner | null = null;
  let comments: LlmComment[] = [];
  let runErr: Error | null = null;

  if (ctx.runnerFactory) {
    try {
      runner = await ctx.runnerFactory(ctx.signal);
      comments = await runner.run(ctx.signal);
    } catch (err) {
      runErr = err instanceof Error ? err : new Error(String(err));
    }
  } else {
    throw new Error("no runnerFactory supplied — wire Agent or fake in tests; production should supply a factory");
  }

  const durationMs = Date.now() - start;

  // If runner exists, emit manifest even on failure (mirrors Go: "successfully constructed manifest is publishable even when execution failed")
  const manifest = runner?.manifest ?? null;
  const emitted = manifest !== null || runErr === null;

  let emitErr: Error | null = null;
  if (emitted && runner !== null) {
    const provider: ResultProvider = {
      Diffs: () => runner!.diffs,
      FilesReviewed: () => runner!.filesReviewed,
      TotalInputTokens: () => runner!.inputTokens,
      TotalOutputTokens: () => runner!.outputTokens,
      TotalTokensUsed: () => runner!.totalTokens,
      TotalCacheReadTokens: () => runner!.cacheReadTokens,
      TotalCacheWriteTokens: () => runner!.cacheWriteTokens,
      Warnings: () => runner!.warnings,
      ProjectSummary: () => runner!.projectSummary,
      ToolCalls: () => runner!.toolCalls,
      SessionID: () => runner!.sessionId,
      BudgetExceeded: () => runner!.budgetExceeded,
      RunManifest: () => runner!.manifest,
      ResumeInfo: () => runner!.resumeInfo,
    };
    try {
      emitRunResult(provider, comments, durationMs, opts.outputFormat, opts.audience, traceId, effectiveLlmIdentity, retryReport ?? null, io);
    } catch (err) {
      emitErr = err instanceof Error ? err : new Error(String(err));
    }
    void version;
  }

  // Determine terminal state for exit code
  const terminal: string = (manifest?.terminalState as string | undefined) ?? (runErr ? "failed" : comments.length === 0 ? "skipped" : "complete");

  if (runErr || terminal === "failed") {
    // Mirror Go: failure usage goes to stderr
    const failedProvider: ResultProvider = runner
      ? {
          Diffs: () => runner!.diffs,
          FilesReviewed: () => runner!.filesReviewed,
          TotalInputTokens: () => runner!.inputTokens,
          TotalOutputTokens: () => runner!.outputTokens,
          TotalTokensUsed: () => runner!.totalTokens,
          TotalCacheReadTokens: () => runner!.cacheReadTokens,
          TotalCacheWriteTokens: () => runner!.cacheWriteTokens,
          Warnings: () => runner!.warnings,
          ProjectSummary: () => runner!.projectSummary,
          ToolCalls: () => runner!.toolCalls,
          SessionID: () => runner!.sessionId,
          BudgetExceeded: () => runner!.budgetExceeded,
          RunManifest: () => runner!.manifest,
          ResumeInfo: () => runner!.resumeInfo,
        }
      : {
          Diffs: () => [],
          FilesReviewed: () => 0,
          TotalInputTokens: () => 0,
          TotalOutputTokens: () => 0,
          TotalTokensUsed: () => 0,
          TotalCacheReadTokens: () => 0,
          TotalCacheWriteTokens: () => 0,
          Warnings: () => [],
          ProjectSummary: () => "",
          ToolCalls: () => ({}),
          SessionID: () => "",
          BudgetExceeded: () => false,
          RunManifest: () => null,
        };
    // Emit failure usage only if manifest not already published with retry report
    const failureReport = emitted ? null : retryReport ?? null;
    // Text vs JSON handling is inside shared retry helper; here we do best-effort
    if (opts.outputFormat === "json") {
      const total = Object.values(failedProvider.ToolCalls()).reduce((a, b) => a + b, 0);
      io.stderr(
        `${JSON.stringify(
          {
            status: "failed",
            llm: effectiveLlmIdentity,
            summary: {
              files_reviewed: failedProvider.FilesReviewed(),
              total_tokens: failedProvider.TotalTokensUsed(),
              input_tokens: failedProvider.TotalInputTokens(),
              output_tokens: failedProvider.TotalOutputTokens(),
              elapsed: `${String(Math.round(durationMs / 1000))}s`,
              budget_exceeded: failedProvider.BudgetExceeded() ? true : undefined,
            },
            tool_calls: { total, by_tool: failedProvider.ToolCalls() },
            session_id: failedProvider.SessionID() || undefined,
            retry_report: failureReport ?? undefined,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stderr(
        `[pi-review] usage on failure: ${String(failedProvider.FilesReviewed())} file(s), ${String(failedProvider.TotalInputTokens())} input + ${String(failedProvider.TotalOutputTokens())} output = ${String(failedProvider.TotalTokensUsed())} total tokens, ${String(Object.values(failedProvider.ToolCalls()).reduce((a, b) => a + b, 0))} tool calls, elapsed ${String(Math.round(durationMs / 1000))}s, budget_exceeded=${String(failedProvider.BudgetExceeded())}` +
          (failedProvider.SessionID() ? `, session ${failedProvider.SessionID()}` : "") +
          "\n",
      );
      if (failureReport) io.stderr(outputRetryReportText(failureReport as RetryReport));
    }
    if (failedProvider.SessionID()) io.stderr(`[pi-review] Session: ${failedProvider.SessionID()} (retry with: --resume ${failedProvider.SessionID()})\n`);

    const combined = [runErr, emitErr].filter((e): e is Error => e !== null);
    if (combined.length > 0) {
      // Throw joined error so index.ts can surface it and return exit 1
      throw new Error(combined.map((e) => e.message).join(": "));
    }
    return 1;
  }

  if (emitErr) throw emitErr;

  // Mirror Go reviewResultError: complete/partial/skipped exit 0, only failed exits non-zero.
  switch (terminal) {
    case "failed":
      return 1;
    case "complete":
    case "partial":
    case "skipped":
    default:
      return 0;
  }
}

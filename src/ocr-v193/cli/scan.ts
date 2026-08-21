// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/scan_cmd.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { LlmComment } from "../model/review.js";
import type { RunManifest } from "../session/manifest.js";
import type { Preview } from "../model/preview.js";
import type { ScanOptions, CliIo } from "./shared.js";
import { CliUsageError, isMachineReadable } from "./shared.js";
import {
  outputTextWithWarnings,
  outputJsonWithWarnings,
  outputJsonNoFiles,
  outputPreview,
  traceSummaryText,
  type AgentWarning,
  type JsonLlmIdentity,
} from "./output.js";
import { outputSarifText } from "./sarif.js";
import type { ResultProvider } from "./review.js";

// ---------------------------------------------------------------------------
// Scan runner seam
// ---------------------------------------------------------------------------

export interface ScanRunner {
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

export interface ScanPreviewFactory {
  (opts: ScanOptions, signal?: AbortSignal): Promise<Preview>;
}

export interface ScanContext {
  io: CliIo;
  opts: ScanOptions;
  traceId: string;
  llmIdentity: JsonLlmIdentity | undefined;
  startMs: number;
  signal?: AbortSignal;
  previewFactory?: ScanPreviewFactory;
  runnerFactory?: (signal?: AbortSignal) => Promise<ScanRunner>;
}

// ---------------------------------------------------------------------------
// emitScanResult — mirrors review emit but for scan provider
// ---------------------------------------------------------------------------

function emitScanResult(
  provider: ResultProvider,
  comments: readonly LlmComment[],
  durationMs: number,
  outputFormat: string,
  traceId: string,
  llmIdentity: JsonLlmIdentity | undefined,
  io: Pick<CliIo, "stdout" | "stderr">,
): void {
  const manifest = provider.RunManifest() ?? null;
  const isMachine = isMachineReadable(outputFormat);

  if (isMachine && !manifest && comments.length === 0 && provider.FilesReviewed() === 0) {
    if (outputFormat === "json") io.stdout(outputJsonNoFiles(traceId, llmIdentity));
    else io.stdout(outputSarifText([], "dev", provider.Warnings(), manifest));
    return;
  }

  if (outputFormat === "json") {
    const resumeInfo = typeof provider.ResumeInfo === "function" ? (provider.ResumeInfo() as unknown) : undefined;
    io.stdout(
      outputJsonWithWarnings({
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
        retryReport: null,
      }),
    );
    return;
  }

  if (outputFormat === "sarif") {
    io.stdout(outputSarifText([...comments], "dev", provider.Warnings(), manifest));
    return;
  }

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
    sessionId: "",
  });
  io.stdout(`${summary}${stdout}`);
  if (stderr !== "") io.stderr(stderr);
  const projectSummary = provider.ProjectSummary();
  if (projectSummary !== "") io.stdout(`\n\n──────── Project Summary ────────\n\n${projectSummary}\n`);
}

// ---------------------------------------------------------------------------
// Main scan entry
// ---------------------------------------------------------------------------

function modelIdFromScanModel(model: string): string {
  if (model === "") return "test-model";
  const slash = model.indexOf("/");
  if (slash >= 0) {
    const after = model.slice(slash + 1);
    return after.split(":")[0] ?? "test-model";
  }
  return model.split(":")[0] ?? "test-model";
}

export async function runScanContext(ctx: ScanContext): Promise<number> {
  const { opts, io, traceId, llmIdentity } = ctx;
  const effectiveLlmIdentity = llmIdentity ?? { model: modelIdFromScanModel(opts.model) };

  if (opts.preview && opts.resume !== "") throw new CliUsageError("--preview and --resume cannot be used together");

  if (opts.preview) {
    if (!ctx.previewFactory) throw new Error("previewFactory required for preview run");
    const preview = await ctx.previewFactory(opts, ctx.signal);
    const { stdout, error } = outputPreview(preview, opts.outputFormat);
    if (error) throw new CliUsageError(error);
    io.stdout(stdout);
    return 0;
  }

  const start = ctx.startMs;
  let runner: ScanRunner | null = null;
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
    throw new Error("no runnerFactory supplied for scan — wire scan.Agent or fake in tests");
  }

  const durationMs = Date.now() - start;
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
      emitScanResult(provider, comments, durationMs, opts.outputFormat, traceId, effectiveLlmIdentity, io);
    } catch (err) {
      emitErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  let terminal: string = (manifest?.terminalState as string | undefined) ?? (runErr ? "failed" : comments.length === 0 ? "skipped" : "complete");
  // Budget-truncated or otherwise incomplete scan must not be clean: partial/failed never complete/skipped (black-box contract).
  if (runner?.budgetExceeded && terminal !== "failed") terminal = "partial";

  if (runErr || terminal === "failed") {
    const fallback = runner
      ? {
          warnings: runner.warnings,
          toolCalls: runner.toolCalls,
          sessionId: runner.sessionId,
          totalTokens: runner.totalTokens,
          inputTokens: runner.inputTokens,
          outputTokens: runner.outputTokens,
          filesReviewed: runner.filesReviewed,
          budgetExceeded: runner.budgetExceeded,
        }
      : {
          warnings: [] as AgentWarning[],
          toolCalls: {} as Record<string, number>,
          sessionId: "",
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          filesReviewed: 0,
          budgetExceeded: false,
        };
    if (opts.outputFormat === "json") {
      io.stderr(
        `${JSON.stringify(
          {
            status: "failed",
            llm: effectiveLlmIdentity,
            summary: {
              files_reviewed: fallback.filesReviewed,
              total_tokens: fallback.totalTokens,
              input_tokens: fallback.inputTokens,
              output_tokens: fallback.outputTokens,
              elapsed: `${String(Math.round(durationMs / 1000))}s`,
              budget_exceeded: fallback.budgetExceeded ? true : undefined,
            },
            tool_calls: {
              total: Object.values(fallback.toolCalls).reduce((a, b) => a + b, 0),
              by_tool: fallback.toolCalls,
            },
            session_id: fallback.sessionId || undefined,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stderr(
        `[pi-review] usage on failure: ${String(fallback.filesReviewed)} file(s), ${String(fallback.inputTokens)} input + ${String(fallback.outputTokens)} output = ${String(fallback.totalTokens)} total tokens, ${String(Object.values(fallback.toolCalls).reduce((a, b) => a + b, 0))} tool calls, elapsed ${String(Math.round(durationMs / 1000))}s, budget_exceeded=${String(fallback.budgetExceeded)}\n`,
      );
    }
    if (fallback.sessionId) io.stderr(`[pi-review] Session: ${fallback.sessionId} (retry with: --resume ${fallback.sessionId})\n`);
    const combined = [runErr, emitErr].filter((e): e is Error => e !== null);
    if (combined.length > 0) throw new Error(combined.map((e) => e.message).join(": "));
    return 1;
  }

  if (emitErr) throw emitErr;

  switch (terminal) {
    case "partial":
      return 2;
    case "failed":
      return 1;
    case "complete":
    case "skipped":
    default:
      return 0;
  }
}

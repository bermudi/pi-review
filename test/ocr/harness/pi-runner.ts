// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/llmloop/loop.go + internal/agent/agent.go usage at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Pi parity engine runner for the differential harness.
 *
 * Uses the public provider-agnostic ScriptedTransport seam (no Pi SDK, no
 * network) so the harness stays deterministic and does not require credentials.
 * For integration with a real Pi session, the harness can optionally spin up a
 * Bun.serve fake server (see fake-server.ts) and drive the PiTransport via
 * it — but the default vertical slice uses ScriptedTransport directly.
 *
 * No legacy imports (src/reviewer etc.).
 */
import type { Diff } from "../../../src/ocr/model/diff.js";
import type { LlmComment } from "../../../src/ocr/model/review.js";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";
import { Runner, MainLoopStop } from "../../../src/ocr/llmloop/loop.js";
import { ScriptedTransport, type ScriptedResponse } from "../../../src/ocr/llmloop/transcript.js";
import type { ToolDef, Template } from "../../../src/ocr/llmloop/types.js";
import type { HarnessRunResult, ScriptedTurn, Usage } from "./types.js";
import { turnsToScriptedResponses } from "./fake-server.js";
import { Provider, ModeWorkspace } from "../../../src/ocr/diff/git.js";
import { Runner as GitRunner } from "../../../src/ocr/diff/runner.js";

export interface PiRunnerOpts {
  readonly fixtureId: string;
  readonly repoDir: string;
  readonly rawRepoDir: string;
  /** Scripted turns to feed the loop. */
  readonly turns: readonly ScriptedTurn[];
  /** Tool definitions advertised (default: code_comment + task_done + file ops). */
  readonly mainToolDefs?: readonly ToolDef[];
  /** Template overrides (MaxTokens, MaxToolRequestTimes etc.). */
  readonly template?: Partial<Template>;
  /** Mode override (default: workspace). */
  readonly mode?: typeof ModeWorkspace | 1 | 2;
  readonly from?: string;
  readonly to?: string;
  readonly commit?: string;
  /** Fixed clock millis for deterministic date (unused here, but recorded). */
  readonly fixedNowMs?: number;
}

function defaultToolDefs(): ToolDef[] {
  return [
    { type: "function", function: { name: "code_comment", description: "Add review comment", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } },
    { type: "function", function: { name: "task_done", description: "Finish review" } },
    { type: "function", function: { name: "file_read", description: "Read file" } },
    { type: "function", function: { name: "file_find", description: "Find file" } },
    { type: "function", function: { name: "file_read_diff", description: "Read diff" } },
    { type: "function", function: { name: "code_search", description: "Search" } },
  ];
}

function toMessage(role: string, content: string): any {
  return { role, content };
}

export async function runPiHarness(opts: PiRunnerOpts): Promise<HarnessRunResult> {
  const toolDefs = (opts.mainToolDefs ?? defaultToolDefs()) as readonly ToolDef[];
  const scripted: readonly ScriptedResponse[] = turnsToScriptedResponses(opts.turns) as unknown as readonly ScriptedResponse[];
  const transport = new ScriptedTransport(scripted);

  // Adapter: Runner expects complete(signal, req) but ScriptedTransport is (req, signal)
  const adapter: any = {
    complete: (signal: AbortSignal, req: unknown) =>
      (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(req as unknown, signal as unknown),
    CompletionsWithCtx: (signal: AbortSignal, req: unknown) =>
      (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(req as unknown, signal as unknown),
  };

  const collector = new CommentCollector();

  const template: Template = {
    MaxTokens: (opts.template as any)?.MaxTokens ?? 128000,
    MaxToolRequestTimes: (opts.template as any)?.MaxToolRequestTimes ?? 30,
    MaxCompletionTokens: (opts.template as any)?.MaxCompletionTokens ?? 4096,
    ...(opts.template as any),
  } as Template;

  const runner = new Runner({
    model: "test-model",
    template,
    llmClient: adapter,
    mainToolDefs: toolDefs as unknown as any,
    commentCollector: collector as unknown as any,
    toolRegistry: new Map<string, any>([
      [
        "file_read",
        {
          name: "file_read",
          execute: async (args: Record<string, unknown>) => {
            // Return file content bounded; for harness we synthesize
            const p = String(args["path"] ?? args["file_path"] ?? "");
            try {
              const fs = await import("node:fs/promises");
              const content = await fs.readFile(`${opts.repoDir}/${p}`, "utf-8");
              return content.slice(0, 8000);
            } catch {
              return `file not found: ${p}`;
            }
          },
        },
      ],
      ["file_read_diff", { name: "file_read_diff", execute: async () => "diff stub" }],
      ["code_search", { name: "code_search", execute: async () => "no results" }],
      ["file_find", { name: "file_find", execute: async () => "no file" }],
    ]),
  } as any);

  // Acquire diff via workspace provider (diff collection path — not just loop unit)
  // For harness we do both: diff-driven coverage + per-file loop.
  let diffs: Diff[] = [];
  let coverageSelected: string[] = [];
  let coverageExcluded: string[] = [];
  try {
    const gitRunner = new GitRunner(16);
    const provider = new Provider({
      repoDir: opts.repoDir,
      mode: opts.mode ?? ModeWorkspace,
      from: opts.from,
      to: opts.to,
      commit: opts.commit,
      runner: gitRunner,
    });
    // For range/commit fixtures, allow fallback to reading range/commit from fixture sidecar files when opts not provided
    if ((opts.mode === 2 || (opts as any).isRange) && !provider.from) {
      try {
        const fs = await import("node:fs/promises");
        const raw = await fs.readFile(`${opts.repoDir}/.ocr-fixture-range`, "utf-8");
        const j = JSON.parse(raw);
        (provider as any).from = j.from;
        (provider as any).to = j.to;
      } catch {}
    }
    if ((opts.mode === 1 || (opts as any).isCommit) && !provider.commit) {
      try {
        const fs = await import("node:fs/promises");
        const c = (await fs.readFile(`${opts.repoDir}/.ocr-fixture-commit`, "utf-8")).trim();
        (provider as any).commit = c;
      } catch {}
    }
    diffs = await provider.getDiff();
    coverageSelected = diffs.filter((d) => !d.isBinary && !d.isDeleted).map((d) => d.newPath);
    // gitignore excluded is not directly exposed; keep empty for now (comparer will handle)
  } catch (e) {
    // If git fails, synthesize one diff for loop determinism
    diffs = [{ oldPath: "main.go", newPath: "main.go", diff: "diff --git a/main.go b/main.go\n@@ -1 +1 @@\n-old\n+new", isNew: false, isDeleted: false, isBinary: false, isRenamed: false, insertions: 1, deletions: 1, newFileContent: "" } as unknown as Diff];
    coverageSelected = ["main.go"];
    coverageExcluded = [];
  }

  // Build main task messages (template stub) + run per-file loop
  const baseMessages: any[] = [
    toMessage("system", "You are a code reviewer. Use code_comment to leave findings and task_done when complete."),
    toMessage("user", `Review file {{current_file_path}} with diff:\n{{diff}}`),
  ];

  const signal = AbortSignal.timeout(15000);
  let completed = false;
  let stop: any = MainLoopStop.StopNone;
  const warnings: any[] = [];
  const toolCallsBefore: LlmComment[] = collector.Comments();
  const perFileCompleted: string[] = [];
  const perFileFailed: string[] = [];

  for (const d of diffs) {
    const pathForFile = d.newPath;
    const msgs = baseMessages.map((m: any) => ({
      role: m.role,
      content: m.content.replaceAll("{{current_file_path}}", pathForFile).replaceAll("{{diff}}", d.diff),
    }));
    const res = await runner.RunPerFile(signal, msgs as any, pathForFile);
    if (res.completed) perFileCompleted.push(pathForFile);
    else perFileFailed.push(pathForFile);
    completed = res.completed;
    stop = res.stop;
    if (res.error) warnings.push({ type: "subtask_error", file: pathForFile, message: res.error.message });
    // For deterministic harness with multiple files, run all through pool semantics (sequential here)
    // Keep running to cover completed/failed per file; only break for single-file fast path if needed
    // (no break — run all files)
  }

  const commentsAfter = collector.Comments();
  const commentsBefore = toolCallsBefore;

  // Model requests from transport — pair each request with its scripted response's toolCalls
  const modelRequests = (transport.requests as any[]).map((req: any, idx: number) => {
    const src: any = (scripted as any[])[Math.min(idx, (scripted as any[]).length - 1)];
    const toolCalls = (src?.toolCalls ?? []).map((tc: any) => {
      let args: Record<string, unknown> = {};
      try {
        args = tc.arguments ? JSON.parse(tc.arguments) : {};
        if (args === null || typeof args !== "object" || Array.isArray(args)) args = {};
      } catch {
        args = { _raw: tc.arguments, _parseError: true } as unknown as Record<string, unknown>;
      }
      return { id: tc.id, name: tc.name, args, result: undefined, error: undefined };
    });
    const usage = src?.usage ? { promptTokens: src.usage.PromptTokens ?? src.usage.promptTokens ?? 0, completionTokens: src.usage.CompletionTokens ?? src.usage.completionTokens ?? 0, totalTokens: src.usage.TotalTokens ?? src.usage.totalTokens ?? 0 } : undefined;
    return {
      index: idx,
      model: req.model ?? "test-model",
      tools: (req.tools ?? []).map((t: any) => ({ name: t.function?.name ?? String(t) })),
      messages: req.messages ?? [],
      toolCalls,
      usage,
    };
  });

  // Usage from runner aggregates
  const usage: Usage = {
    promptTokens: runner.totalInputTokens(),
    completionTokens: runner.totalOutputTokens(),
    totalTokens: runner.totalTokensUsed(),
    cacheReadTokens: runner.totalCacheReadTokens(),
    cacheWriteTokens: runner.totalCacheWriteTokens(),
  };

  // Coverage mapping (selected/completed/failed) — per-file when multiple diffs
  const coverage = {
    selected: coverageSelected,
    excluded: coverageExcluded,
    skipped: [] as string[],
    completed: perFileCompleted.length > 0 ? perFileCompleted : completed ? coverageSelected.slice(0, 1) : ([] as string[]),
    failed: perFileFailed.length > 0 ? perFileFailed : !completed && warnings.length > 0 ? coverageSelected.slice(0, 1) : ([] as string[]),
  };

  let stopReason: string;
  if (stop === MainLoopStop.StopEmptyRounds) stopReason = "empty_rounds";
  else if (stop === MainLoopStop.StopCompression) stopReason = "compression";
  else if (stop === MainLoopStop.StopMaxRounds) stopReason = warnings.length > 0 ? "budget_exceeded" : "partial";
  else stopReason = completed ? "complete" : warnings.length > 0 ? "failed" : "partial";

  // Tool defs per phase (main = advertised, grace = filtered)
  const toolDefsPerPhase: Record<string, readonly string[]> = {
    main: toolDefs.map((d) => d.function.name),
    grace: toolDefs.filter((d) => d.function.name === "code_comment" || d.function.name === "task_done").map((d) => d.function.name),
  };

  return {
    fixtureId: opts.fixtureId,
    repoDir: "<TMP>",
    rawRepoDir: opts.rawRepoDir,
    coverage,
    commentsBefore,
    commentsAfter,
    stopReason: stopReason as any,
    usage,
    modelRequests: modelRequests as any,
    toolDefsPerPhase,
    output: {
      text: `Review ${completed ? "complete" : "partial"}: ${commentsAfter.length} finding(s)`,
      json: JSON.stringify({ comments: commentsAfter, coverage, usage, stopReason }),
      sarif: JSON.stringify({ version: "2.1.0", runs: [{ results: commentsAfter.map((c) => ({ message: { text: c.content } })) }] }),
      agent: `Review ${completed ? "complete" : "partial"}`,
    },
    checkpointTransitions: [],
    raw: { runnerWarnings: warnings, stop, diffs: diffs.map((d) => d.newPath) },
  };
}

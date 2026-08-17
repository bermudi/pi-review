// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview review wiring at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Factory for the parity review CLI — production wiring with real tools, no stubs, no any.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import type { ReviewOptions, ScanOptions } from "./shared.js";
import type { ReviewRunner } from "./review.js";
import type { ScanRunner } from "./scan.js";
import { type AgentWarning } from "./output.js";
import type { Preview } from "../model/preview.js";
import type { LlmComment } from "../model/review.js";
import { loadDefaultTemplate, loadDefaultScanTemplate, applyLanguage, applyLanguageScan } from "../template/template.js";
import { newResolver, type FileFilter } from "../rules/system_rules.js";
import { minimatch } from "minimatch";
import { mainTaskToolDefs, planTaskToolDefs } from "../tool/tools-config.js";
import { CommentCollector } from "../tool/collector.js";
import { CommentWorkerPool } from "../llmloop/pool.js";
import { Agent, newAgent, reviewItemFingerprint } from "../agent/agent.js";
import { Agent as ScanAgent, NewAgent as NewScanAgent } from "../scan/scan.js";
import { reviewModeString } from "../agent/util.js";
import { createPiTransportForFile } from "../pi-adapter/pi-transport.js";
import { FileReader, FileReadProvider, DiffMap, FileReadDiffProvider, CodeSearchProvider, FileFindProvider } from "../tool/filereader.js";
import { Registry } from "../tool/definitions.js";
import { Provider, ModeWorkspace, ModeRange, ModeCommit } from "../diff/git.js";
import { Runner as GitRunner } from "../diff/runner.js";
import { ManifestBuilder, ItemID, StatePartial, StateFailed, StateSkipped, FailureBudget, FailureTimeout, FailureUnknown } from "../session/manifest.js";
import { SessionHistory, ReviewModeFullScan } from "../session/history.js";
import { newJSONLWriter, type JsonlWriter } from "../session/persist.js";
import { ResumeState, LoadResumeState } from "../session/resume.js";
import type { ResumeLineage } from "../session/resume.js";
import type { RunManifest } from "../session/manifest.js";
import type { Diff } from "../model/diff.js";

/**
 * Create a production ReviewRunner for one review invocation.
 * This is the factory injected into the parity CLI (src/ocr-v193/cli/index.ts)
 * when --engine ocr-v193 delegates from the legacy CLI.
 *
 * Uses the v1.9.3 Agent orchestrator so per-file loops, planning, filtering,
 * relocation, concurrency, and budget behaviour are all exercised.
 */
export function createReviewRunnerFactory(
  opts: ReviewOptions,
  ioCwd: string,
): (signal?: AbortSignal) => Promise<ReviewRunner> {
  return async (signal?: AbortSignal): Promise<ReviewRunner> => {
    const effectiveSignal = signal ?? new AbortController().signal;
    const repoDir = opts.repoDir !== "" ? opts.repoDir : ioCwd;

    let template = loadDefaultTemplate();
    template = applyLanguage(template, "English");
    if (opts.maxTools > 0) {
      template = { ...template, MaxToolRequestTimes: opts.maxTools };
    }
    if (opts.maxTokens > 0) {
      template = { ...template, MaxTokens: opts.maxTokens };
    }

    const mainToolDefs = mainTaskToolDefs();
    const planToolDefs = planTaskToolDefs();

    const ruleSet = newResolver(repoDir, opts.rulePath);
    const ruleResolver = ruleSet.resolver;
    const fileFilter = ruleSet.filter;

    const collector = new CommentCollector();

    const from = opts.from;
    const to = opts.to;
    const commit = opts.commit;
    const reviewMode = reviewModeString(from, to, commit);

    // Mirror Go review_cmd.go: when --commit is used without --background,
    // default background to the commit message.
    let background = opts.background;
    if (commit !== "" && background === "" && opts.backgroundFile === "") {
      try {
        const gitOut = spawnSync("git", ["-C", repoDir, "log", "-1", "--format=%B", "--end-of-options", commit], {
          encoding: "utf-8",
          timeout: 5000,
        });
        if (gitOut.status === 0) {
          const msg = gitOut.stdout.trim();
          if (msg !== "") background = msg;
        }
      } catch {
        // best-effort; leave background empty
      }
    }

    let mode: number;
    let ref = "";
    if (commit !== "") {
      mode = ModeCommit;
      ref = commit;
    } else if (from !== "" || to !== "") {
      mode = ModeRange;
      ref = to !== "" ? to : "HEAD";
    } else {
      mode = ModeWorkspace;
    }

    const fileReader = new FileReader({ RepoDir: repoDir, Mode: mode as never, Ref: ref });
    const diffMap = new DiffMap(new Map<string, string>());
    const registry = new Registry();
    registry.Register(new FileReadProvider(fileReader));
    registry.Register(new FileReadDiffProvider(diffMap));
    registry.Register(new CodeSearchProvider(fileReader));
    registry.Register(new FileFindProvider(fileReader));
    registry.Freeze();

    const cwd = repoDir;
    const agentDirEnv = process.env["PI_CODING_AGENT_DIR"];
    const agentDir = agentDirEnv !== undefined && agentDirEnv !== "" ? agentDirEnv : `${process.env["HOME"] ?? "/tmp"}/.pi/agent`;

    let modelId = "test-model";
    if (opts.model !== "") {
      const slash = opts.model.indexOf("/");
      if (slash >= 0) {
        const after = opts.model.slice(slash + 1);
        modelId = after.split(":")[0] ?? modelId;
      } else {
        modelId = opts.model.split(":")[0] ?? modelId;
      }
    }

    const gitRunner = new GitRunner(opts.maxGitProcs > 0 ? opts.maxGitProcs : 16);

    // Load diffs and input resolution ourselves so we can build a manifest before
    // running the agent, matching the original factory flow.
    let diffs: Diff[] = [];
    let inputMode = "workspace";
    let resolvedBase = "";
    let resolvedHead = "";
    let remoteIdentity = "";
    try {
      let provider: Provider;
      if (mode === ModeCommit) {
        provider = new Provider({ repoDir, mode: ModeCommit as never, commit, runner: gitRunner } as never);
        inputMode = "commit";
      } else if (mode === ModeRange) {
        provider = new Provider({ repoDir, mode: ModeRange as never, from, to: ref, runner: gitRunner } as never);
        inputMode = "range";
      } else {
        provider = new Provider({ repoDir, mode: ModeWorkspace as never, runner: gitRunner } as never);
        inputMode = "workspace";
      }
      diffs = (await provider.getDiff(effectiveSignal)) as unknown as Diff[];
      const res = (await (provider as unknown as { resolveInput: (s?: AbortSignal) => Promise<{ resolvedBase: string; resolvedHead: string }> }).resolveInput(effectiveSignal)) as { resolvedBase: string; resolvedHead: string };
      resolvedBase = res.resolvedBase ?? "";
      resolvedHead = res.resolvedHead ?? "";
      try {
        remoteIdentity = await (provider as unknown as { remoteIdentity: (s?: AbortSignal) => Promise<string> }).remoteIdentity(effectiveSignal);
      } catch {
        remoteIdentity = "";
      }
      // Inject diffMap for file_read_diff tool
      const mapInternal = new Map<string, string>();
      for (const d of diffs) {
        if (d.newPath !== "/dev/null") mapInternal.set(d.newPath, d.diff);
      }
      const newDiffMap = new DiffMap(mapInternal);
      const prov = registry.Get("file_read_diff") as unknown as { setDiffMap?: (m: DiffMap) => void; SetDiffMap?: (m: DiffMap) => void };
      if (prov !== undefined && typeof prov.setDiffMap === "function") prov.setDiffMap(newDiffMap);
      else if (prov !== undefined && typeof prov.SetDiffMap === "function") prov.SetDiffMap(newDiffMap);
    } catch (e) {
      throw new Error(`load diffs: ${String((e as Error).message)}`);
    }

    // One Pi transport per review invocation; concurrency=1 serialises per-file use.
    const transport = await createPiTransportForFile({ cwd, agentDir, tools: mainToolDefs });

    const runId = randomUUID();
    const builder = new ManifestBuilder(runId, "review");
    builder.SetInput({
      mode: inputMode,
      requestedFrom: from || undefined,
      requestedHead: to || undefined,
      resolvedBase: resolvedBase || undefined,
      resolvedHead: resolvedHead || undefined,
    });
    builder.SetExecution({
      ocrVersion: "dev",
      model: modelId,
      configuredConcurrency: opts.concurrency,
    });
    if (remoteIdentity !== "") {
      builder.SetRepository({ identitySha256: remoteIdentity });
    }

    const selectedPaths: string[] = [];
    for (const d of diffs) {
      if (d.isDeleted) continue;
      const oldPath = d.oldPath === "/dev/null" ? "" : d.oldPath;
      const newPath = d.newPath === "/dev/null" ? "" : d.newPath;
      const itemId = ItemID("review", inputMode, oldPath, newPath);
      const fingerprint = reviewItemFingerprint(inputMode, d);
      const err = builder.RegisterSelected({ itemId, path: newPath, oldPath, fingerprint });
      if (err) {
        await transport.dispose().catch(() => {});
        throw err;
      }
      selectedPaths.push(newPath);
    }
    const sealErr = builder.SealSelected();
    if (sealErr) {
      await transport.dispose().catch(() => {});
      throw sealErr;
    }

    const maxConcurrency = opts.concurrency > 0 ? opts.concurrency : 8;
    const concurrentTaskTimeoutMinutes = opts.perFileTimeout > 0 ? opts.perFileTimeout : 10;

    const agent = newAgent({
      repoDir,
      from: from || undefined,
      to: to || undefined,
      commit: commit || undefined,
      reviewMode,
      template,
      systemRule: ruleResolver,
      fileFilter: fileFilter ?? null,
      llmClient: transport as unknown as import("../llmloop/types.js").AnyLlmClient,
      tools: registry as unknown as import("../agent/agent.js").ToolRegistryLike,
      planToolDefs,
      mainToolDefs,
      commentCollector: collector as unknown as import("../agent/agent.js").CommentCollectorLike,
      maxConcurrency,
      concurrentTaskTimeoutMinutes,
      background,
      model: modelId,
      maxTokensBudget: opts.maxTokensBudget > 0 ? opts.maxTokensBudget : undefined,
      skipFilter: opts.noFilter,
      runtimeConfig: { protocol: "openai", endpointHost: "", language: "English", timeoutMs: 30000 },
    });

    const startMs = Date.now();
    let comments: LlmComment[] = [];
    let runError: Error | null = null;
    try {
      comments = await agent.run(effectiveSignal);
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    }
    const elapsedMs = Date.now() - startMs;

    // Mark manifest items from agent outcomes.
    const outcomes = agent.subtaskOutcomesMap();
    for (const d of diffs) {
      if (d.isDeleted) continue;
      const itemId = ItemID("review", inputMode, d.oldPath === "/dev/null" ? "" : d.oldPath, d.newPath === "/dev/null" ? "" : d.newPath);
      const outcome = outcomes.get(d.newPath);
      if (outcome === undefined) {
        // Never reached (e.g. filtered out or budget pre-check skipped). Mark failed.
        if (!agent.budgetExceededFlag()) {
          builder.MarkFailed(itemId, FailureUnknown, "no terminal outcome recorded");
        } else {
          builder.MarkFailed(itemId, FailureBudget, "stopped by token budget");
        }
      } else if (outcome.completed) {
        builder.MarkCompleted(itemId);
      } else if (outcome.stop === "budget_exceeded") {
        builder.MarkFailed(itemId, FailureBudget, outcome.error ?? "budget exceeded");
      } else if (outcome.stop === "empty_rounds") {
        builder.MarkFailed(itemId, FailureUnknown, "empty rounds");
      } else if (outcome.error) {
        builder.MarkFailed(itemId, FailureUnknown, outcome.error);
      } else {
        builder.MarkFailed(itemId, FailureUnknown, outcome.stop ?? "unknown");
      }
    }

    // If the agent threw before any dispatch, sweep selected -> failed.
    if (runError !== null) {
      builder.SetRunFailure("internal", runError.message);
    }

    const finalized = builder.Finalize(elapsedMs);
    if (finalized.error) {
      // Mark partial so the CLI treats it as a real failure path.
      builder.SetRunFailure("internal", finalized.error.message);
    }
    // Re-finalize after possible run failure mutation.
    const finalManifest = builder.Finalize(elapsedMs);
    const manifest = finalManifest.manifest ?? null;

    const warnings = agent.warningsList();
    if (finalized.error) {
      warnings.push({ type: "manifest_finalize_error", file: "", message: finalized.error.message });
    }

    const filesReviewed = [...outcomes.values()].filter((o) => o.completed).length;
    const toolCalls = agent.toolCalls();
    const inputTokens = agent.totalInputTokens();
    const outputTokens = agent.totalOutputTokens();
    const totalTokens = agent.totalTokensUsed();
    const cacheReadTokens = agent.totalCacheReadTokens();
    const cacheWriteTokens = agent.totalCacheWriteTokens();

    await transport.dispose().catch((e) => {
      warnings.push({ type: "transport_dispose_error", file: "", message: String((e as Error).message) });
    });

    const reviewRunner: ReviewRunner = {
      run: async (_sig?: AbortSignal): Promise<LlmComment[]> => comments,
      manifest: manifest ?? undefined,
      warnings: warnings as unknown as never,
      filesReviewed,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      toolCalls,
      sessionId: runId,
      budgetExceeded: agent.budgetExceededFlag(),
      projectSummary: "",
      resumeInfo: undefined,
      diffs: diffs as unknown as never,
    };

    return reviewRunner;
  };
}

// ---------------------------------------------------------------------------
// Scan factory — mirrors cmd/opencodereview/scan_cmd.go executeScan
// ---------------------------------------------------------------------------

export function createScanRunnerFactory(
  opts: ScanOptions,
  _ioCwd: string,
): (signal?: AbortSignal) => Promise<ScanRunner> {
  return async (signal?: AbortSignal): Promise<ScanRunner> => {
    const effectiveSignal = signal ?? new AbortController().signal;
    const repoDir = opts.repoDir !== "" ? path.resolve(opts.repoDir) : process.cwd();

    if (!fs.existsSync(repoDir)) {
      throw new Error(`repo directory not found: ${repoDir}`);
    }

    let template = loadDefaultScanTemplate();
    template = applyLanguageScan(template, "English");
    if (opts.maxTools > 0 && opts.maxTools > (template.MaxToolRequestTimes ?? 0)) {
      template = { ...template, MaxToolRequestTimes: opts.maxTools };
    }
    if (opts.maxTokens > 0) {
      template = { ...template, MaxTokens: opts.maxTokens };
    }
    if (opts.batch !== "") {
      (template as unknown as Record<string, unknown>)["BatchStrategy"] = opts.batch;
    }

    const ruleSet = newResolver(repoDir, opts.rulePath);
    const ruleResolver = ruleSet.resolver;
    const fileFilter = ruleSet.filter;
    const scanFileFilter = makeScanFileFilter(fileFilter);

    const scanPaths = splitPaths(opts.paths);
    const excludes = splitPaths(opts.excludes);

    let resume: ResumeState | null = null;
    if (opts.resume !== "") {
      resume = LoadResumeState(repoDir, opts.resume);
      const err = resume.ValidateScanOptions(scanPaths);
      if (err) throw err;
      if (resume.CompletedCount() === 0) {
        throw new Error(`resume session ${opts.resume} has no completed scan items`);
      }
    }

    const gitBranch = detectGitBranch(repoDir);
    const runId = randomUUID();
    const session = new SessionHistory(repoDir, gitBranch, modelIdFromModel(opts.model), {
      reviewMode: ReviewModeFullScan,
      scanPaths,
      resumedFrom: resume?.SessionID ?? "",
    }, runId);
    const writer = newJSONLWriter(runId, repoDir, gitBranch, modelIdFromModel(opts.model), {
      reviewMode: ReviewModeFullScan,
      scanPaths,
      resumedFrom: resume?.SessionID ?? "",
    });
    session._attachPersist(jsonlWriterToPersistHandle(writer));

    const collector = new CommentCollector();
    const workerPool = new CommentWorkerPool(opts.concurrency > 0 ? opts.concurrency : 8);

    const fileReader = new FileReader({ RepoDir: repoDir, Mode: ModeWorkspace as never, Ref: "" });
    const registry = new Registry();
    registry.Register(new FileReadProvider(fileReader));
    registry.Register(new FileReadDiffProvider(new DiffMap(new Map<string, string>())));
    registry.Register(new CodeSearchProvider(fileReader));
    registry.Register(new FileFindProvider(fileReader));
    registry.Freeze();

    const cwd = repoDir;
    const agentDirEnv = process.env["PI_CODING_AGENT_DIR"];
    const agentDir = agentDirEnv !== undefined && agentDirEnv !== "" ? agentDirEnv : `${process.env["HOME"] ?? "/tmp"}/.pi/agent`;
    const allMainToolDefs = mainTaskToolDefs();
    const mainToolDefs = allMainToolDefs.filter((t) => t.function.name !== "file_read_diff");

    const transport = await createPiTransportForFile({ cwd, agentDir, tools: mainToolDefs });

    const maxTokensBudget = opts.maxTokensBudget > 0 ? opts.maxTokensBudget : (template.MaxTokensBudget ?? 0);

    const agent = NewScanAgent({
      repoDir,
      paths: scanPaths,
      template,
      systemRule: ruleResolver.resolve.bind(ruleResolver),
      fileFilter: scanFileFilter,
      llmClient: transport as unknown as import("../llmloop/types.js").AnyLlmClient,
      tools: registry as unknown as import("../llmloop/types.js").ToolRegistryLike,
      mainToolDefs,
      commentCollector: collector,
      commentWorkerPool: workerPool,
      maxConcurrency: opts.concurrency > 0 ? opts.concurrency : 8,
      concurrentTaskTimeoutMinutes: opts.perFileTimeout > 0 ? opts.perFileTimeout : 10,
      model: modelIdFromModel(opts.model),
      background: opts.background,
      maxFileSizeBytes: template.MaxFileSizeBytes,
      maxTokensBudget,
      skipPlan: opts.noPlan,
      skipDedup: opts.noDedup,
      skipSummary: opts.noSummary,
      resume,
      session,
    });

    const startMs = Date.now();
    let comments: LlmComment[] = [];
    let runError: Error | null = null;
    try {
      comments = await agent.run(effectiveSignal);
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    }
    const durationMs = Date.now() - startMs;

    await session.Finalize();

    await transport.dispose().catch((e) => {
      const warn = { type: "transport_dispose_error", file: "", message: String((e as Error).message) };
      void warn;
    });

    const inputTokens = agent.TotalInputTokens();
    const outputTokens = agent.TotalOutputTokens();
    const totalTokens = agent.TotalTokensUsed();
    const cacheReadTokens = agent.TotalCacheReadTokens();
    const cacheWriteTokens = agent.TotalCacheWriteTokens();
    const toolCalls = agent.ToolCalls();
    const warnings = agent.Warnings();

    const scanRunner: ScanRunner = {
      run: async (_sig?: AbortSignal): Promise<LlmComment[]> => comments,
      manifest: null,
      warnings: warnings as unknown as never,
      filesReviewed: agent.items.length,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      toolCalls,
      sessionId: session.SessionID,
      budgetExceeded: false,
      projectSummary: agent.ProjectSummary(),
      resumeInfo: agent.ResumeInfo,
      diffs: [],
    };

    if (runError) {
      throw new Error(runError.message);
    }

    return scanRunner;
  };
}

export function createScanPreviewFactory(
  opts: ScanOptions,
  _ioCwd: string,
): (signal?: AbortSignal) => Promise<Preview> {
  return async (signal?: AbortSignal): Promise<Preview> => {
    const repoDir = opts.repoDir !== "" ? path.resolve(opts.repoDir) : process.cwd();

    let template = loadDefaultScanTemplate();
    if (opts.maxTokens > 0) {
      template = { ...template, MaxTokens: opts.maxTokens };
    }

    const ruleSet = newResolver(repoDir, opts.rulePath);
    const scanFileFilter = makeScanFileFilter(ruleSet.filter);
    const scanPaths = splitPaths(opts.paths);

    const agent = NewScanAgent({
      repoDir,
      paths: scanPaths,
      template,
      fileFilter: scanFileFilter,
      maxFileSizeBytes: template.MaxFileSizeBytes,
      skipPlan: true,
      skipDedup: true,
      skipSummary: true,
    });

    return agent.preview(signal ?? new AbortController().signal);
  };
}

// ---------------------------------------------------------------------------
// Scan helpers
// ---------------------------------------------------------------------------

function splitPaths(raw: string): string[] {
  if (raw === "") return [];
  const parts = raw.split(",");
  const out: string[] = [];
  for (const p of parts) {
    const v = p.trim();
    if (v !== "") out.push(v);
  }
  return out;
}

function modelIdFromModel(model: string): string {
  if (model === "") return "test-model";
  const slash = model.indexOf("/");
  if (slash >= 0) {
    const after = model.slice(slash + 1);
    return after.split(":")[0] ?? "test-model";
  }
  return model.split(":")[0] ?? "test-model";
}

function detectGitBranch(repoDir: string): string {
  try {
    const out = spawnSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (out.status === 0) return out.stdout.trim();
  } catch {}
  return "";
}

function makeScanFileFilter(fileFilter: FileFilter | null): {
  isUserExcluded(path: string): boolean;
  isUserIncluded(path: string): boolean;
  hasInclude(): boolean;
} | null {
  if (fileFilter === null || fileFilter === undefined) return null;
  const include = [...(fileFilter.Include ?? [])];
  const exclude = [...(fileFilter.Exclude ?? [])];
  function matchesAny(patterns: readonly string[], p: string): boolean {
    const lowerPath = p.toLowerCase();
    for (const raw of patterns) {
      if (raw === "") continue;
      const pat = raw.toLowerCase();
      if (minimatch(lowerPath, pat, { dot: true, partial: true, nocase: false })) return true;
    }
    return false;
  }
  return {
    isUserExcluded: (p: string) => matchesAny(exclude, p),
    isUserIncluded: (p: string) => matchesAny(include, p),
    hasInclude: () => include.length > 0,
  };
}

function jsonlWriterToPersistHandle(writer: JsonlWriter): import("../session/history.js").PersistHandle {
  return {
    writeReviewItemDone: (...args) => { writer.WriteReviewItemDone(...args); },
    writeReviewItemReused: (...args) => { writer.WriteReviewItemReused(...args); },
    writeReviewItemFailed: (...args) => { writer.WriteReviewItemFailed(...args); },
    writeResumeLineage: (l: ResumeLineage) => { writer.WriteResumeLineage(l); },
    writeSessionEnd: (durationMs, filesReviewed, llmFailures, manifest) => writer.WriteSessionEnd(durationMs, filesReviewed, llmFailures, manifest),
  };
}

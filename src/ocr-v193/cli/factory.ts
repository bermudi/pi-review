// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview review wiring at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Factory for the parity review CLI — production wiring with real tools, no stubs, no any.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import type { ReviewOptions } from "./shared.js";
import type { ReviewRunner } from "./review.js";
import type { LlmComment } from "../model/review.js";
import { loadDefaultTemplate, applyLanguage } from "../template/template.js";
import { newResolver } from "../rules/system_rules.js";
import { mainTaskToolDefs, planTaskToolDefs } from "../tool/tools-config.js";
import { CommentCollector } from "../tool/collector.js";
import { Agent, newAgent, reviewItemFingerprint } from "../agent/agent.js";
import { reviewModeString } from "../agent/util.js";
import { createPiTransportForFile } from "../pi-adapter/pi-transport.js";
import { FileReader, FileReadProvider, DiffMap, FileReadDiffProvider, CodeSearchProvider, FileFindProvider } from "../tool/filereader.js";
import { Registry } from "../tool/definitions.js";
import { Provider, ModeWorkspace, ModeRange, ModeCommit } from "../diff/git.js";
import { Runner as GitRunner } from "../diff/runner.js";
import { ManifestBuilder, ItemID, StatePartial, StateFailed, StateSkipped, FailureBudget, FailureTimeout, FailureUnknown } from "../session/manifest.js";
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

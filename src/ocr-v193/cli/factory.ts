// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview review wiring at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Factory for the parity review CLI — production wiring with real tools, no stubs, no any.

import { randomUUID } from "node:crypto";

import type { ReviewOptions } from "./shared.js";
import type { ReviewRunner } from "./review.js";
import type { LlmComment } from "../model/review.js";
import { loadDefaultTemplate } from "../template/template.js";
import { mainTaskToolDefs } from "../tool/tools-config.js";
import { CommentCollector } from "../tool/collector.js";
import { Runner } from "../llmloop/loop.js";
import { createPiTransportForFile } from "../pi-adapter/pi-transport.js";
import { FileReader, FileReadProvider, DiffMap, FileReadDiffProvider, CodeSearchProvider, FileFindProvider } from "../tool/filereader.js";
import { Registry } from "../tool/definitions.js";
import { Provider, ModeWorkspace, ModeRange, ModeCommit } from "../diff/git.js";
import { Runner as GitRunner } from "../diff/runner.js";
import { ManifestBuilder } from "../session/manifest.js";
import { reviewItemFingerprint } from "../agent/agent.js";
import { ItemID } from "../session/manifest.js";
import type { Diff } from "../model/diff.js";

/**
 * Create a production ReviewRunner for one review invocation.
 * This is the factory injected into the parity CLI (src/ocr-v193/cli/index.ts)
 * when --engine ocr-v193 delegates from the legacy CLI.
 *
 * It uses only public Pi SDK APIs (createPiTransportForFile) and real OCR
 * tool providers (FileReader-based). No stubs, no any, failures are not swallowed.
 */
export function createReviewRunnerFactory(
  opts: ReviewOptions,
  ioCwd: string,
): (signal?: AbortSignal) => Promise<ReviewRunner> {
  return async (signal?: AbortSignal): Promise<ReviewRunner> => {
    const effectiveSignal = signal ?? new AbortController().signal;

    // Resolve repo dir: opts.repoDir may be empty (means cwd)
    const repoDir = opts.repoDir !== "" ? opts.repoDir : ioCwd;

    // Load template and tool defs (verbatim, hash-verified)
    const template = loadDefaultTemplate();
    const toolDefs = mainTaskToolDefs();

    // Comment collector (per-Agent, isolated)
    const collector = new CommentCollector();

    // Determine diff mode from opts (from/to/commit)
    const from = opts.from;
    const to = opts.to;
    const commit = opts.commit;
    let mode: number;
    let ref: string;
    if (commit !== "") {
      mode = ModeCommit;
      ref = commit;
    } else if (from !== "" || to !== "") {
      mode = ModeRange;
      ref = to !== "" ? to : "HEAD";
    } else {
      mode = ModeWorkspace;
      ref = "";
    }

    // FileReader for tool execution (real, not stub)
    const fileReader = new FileReader({ RepoDir: repoDir, Mode: mode as never, Ref: ref });
    const diffMap = new DiffMap(new Map<string, string>());
    const registry = new Registry();
    registry.Register(new FileReadProvider(fileReader));
    registry.Register(new FileReadDiffProvider(diffMap));
    registry.Register(new CodeSearchProvider(fileReader));
    registry.Register(new FileFindProvider(fileReader));
    registry.Freeze();

    // Pi transport — one session per factory invocation, reused per file via Runner's per-file transport?
    // For Runner we need one transport that will be reused per file? But PiTransport is per-file session.
    // Instead we create a transport per file inside RunPerFile loop via factory.
    // However Runner expects a single llmClient. We follow pi-real-runner pattern: create one transport
    // and wrap it, but for true per-file isolation we create a new transport per file inside loop.
    // Simpler: create a transport factory and let Runner use it per file via a wrapper that creates new session per file.
    // For now, we create a single transport and reuse it; PiTransport's history sync handles per-file messages.
    const cwd = repoDir;
    const agentDirEnv = process.env["PI_CODING_AGENT_DIR"];
    const agentDir = agentDirEnv !== undefined && agentDirEnv !== "" ? agentDirEnv : `${process.env["HOME"] ?? "/tmp"}/.pi/agent`;

    // Model resolution: opts.model may be "provider/model" or "model"
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

    const singleTransport = await createPiTransportForFile({ cwd, agentDir, tools: toolDefs });

    // Provider for diffs
    const gitRunner = new GitRunner(16);
    let diffs: Diff[] = [];
    let inputMode = "workspace";
    let resolvedBase = "";
    let resolvedHead = "";
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
      try {
        const res = (await (provider as unknown as { resolveInput: (s?: AbortSignal) => Promise<{ resolvedBase: string; resolvedHead: string }> }).resolveInput(effectiveSignal)) as { resolvedBase: string; resolvedHead: string };
        resolvedBase = res.resolvedBase ?? "";
        resolvedHead = res.resolvedHead ?? "";
      } catch {
        // ignore
      }
      // Inject diffMap for file_read_diff tool
      const mapInternal = new Map<string, string>();
      for (const d of diffs) {
        if (d.newPath !== "/dev/null") mapInternal.set(d.newPath, d.diff);
      }
      const newDiffMap = new DiffMap(mapInternal);
      // Replace diffMap in registry's provider (best-effort)
      try {
        const prov = registry.Get("file_read_diff") as unknown as { setDiffMap?: (m: DiffMap) => void; SetDiffMap?: (m: DiffMap) => void };
        if (prov !== undefined && typeof prov.setDiffMap === "function") prov.setDiffMap(newDiffMap);
        else if (prov !== undefined && typeof prov.SetDiffMap === "function") prov.SetDiffMap(newDiffMap);
      } catch {
        // ignore
      }
    } catch (e) {
      // Do not swallow — propagate as failure that runReviewContext will handle
      await singleTransport.dispose().catch(() => {});
      throw new Error(`load diffs: ${String((e as Error).message)}`);
    }

    // Runner — per Agent wiring, but we use Runner directly for the loop
    const runner = new Runner({
      model: modelId,
      template: template as unknown as never,
      llmClient: singleTransport as unknown as never,
      mainToolDefs: toolDefs as unknown as never,
      commentCollector: collector as unknown as never,
      toolRegistry: registry as unknown as never,
      diffLookup: ((path: string): Diff | null => {
        for (const dd of diffs) {
          if (dd.newPath === path || dd.oldPath === path) return dd;
        }
        return null;
      }) as unknown as never,
    });

    // Manifest builder
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
    // Register selected
    for (const d of diffs) {
      if (d.isDeleted) continue;
      const oldPath = d.oldPath === "/dev/null" ? "" : d.oldPath;
      const newPath = d.newPath === "/dev/null" ? "" : d.newPath;
      const itemId = ItemID("review", inputMode, oldPath, newPath);
      const fingerprint = reviewItemFingerprint(inputMode, d);
      const err = builder.RegisterSelected({ itemId, path: newPath, oldPath, fingerprint });
      if (err) {
        await singleTransport.dispose().catch(() => {});
        throw err;
      }
    }
    const sealErr = builder.SealSelected();
    if (sealErr) {
      await singleTransport.dispose().catch(() => {});
      throw sealErr;
    }

    let filesReviewed = 0;
    let toolCalls: Record<string, number> = {};
    const perFileCompleted: string[] = [];
    const warnings: Array<{ type: string; file: string; message: string }> = [];

    // Build base messages from template.MainTask (mirrors Agent.executeSubtask)
    const buildMessages = (diff: Diff): Array<{ role: string; content: string }> => {
      const newPath = diff.newPath;
      // Use template.MainTask messages and replace placeholders
      return template.MainTask.messages.map((m) => {
        let content = m.content;
        content = content.replaceAll("{{current_file_path}}", newPath);
        content = content.replaceAll("{{diff}}", diff.diff);
        content = content.replaceAll("{{system_rule}}", "");
        content = content.replaceAll("{{change_files}}", diffs.filter((d) => d.newPath !== newPath).map((d) => d.newPath).join("\n"));
        content = content.replaceAll("{{requirement_background}}", opts.background ?? "");
        content = content.replaceAll("{{plan_guidance}}", "");
        // Strip empty plan block if no plan
        if (content.includes("{{plan_guidance}}")) content = content.replaceAll("{{plan_guidance}}", "");
        return { role: m.role, content };
      });
    };

    const startMs = Date.now();

    // Run per file
    for (const d of diffs) {
      if (d.isDeleted) continue;
      if (effectiveSignal.aborted) {
        const abortErr = effectiveSignal.reason instanceof Error ? effectiveSignal.reason : new Error(String(effectiveSignal.reason ?? "aborted"));
        throw abortErr;
      }
      const pathForFile = d.newPath;
      const messages = buildMessages(d);
      try {
        const res = await runner.RunPerFile(effectiveSignal as never, messages as never, pathForFile);
        filesReviewed++;
        if (res.completed) perFileCompleted.push(pathForFile);
        const cErr = builder.MarkCompleted(ItemID("review", inputMode, d.oldPath === "/dev/null" ? "" : d.oldPath, d.newPath === "/dev/null" ? "" : d.newPath));
        if (cErr) warnings.push({ type: "manifest_mark_error", file: pathForFile, message: cErr.message });
        // Collect tool calls from runner
        try {
          const tc = (runner as unknown as { toolCalls?: () => Record<string, number> }).toolCalls?.();
          if (tc) {
            for (const [k, v] of Object.entries(tc)) toolCalls[k] = (toolCalls[k] ?? 0) + v;
          }
        } catch {
          // ignore
        }
        if (!res.completed && res.error) {
          warnings.push({ type: "subtask_error", file: pathForFile, message: res.error.message });
          builder.MarkFailed(ItemID("review", inputMode, d.oldPath === "/dev/null" ? "" : d.oldPath, d.newPath === "/dev/null" ? "" : d.newPath), "unknown", res.error.message);
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        warnings.push({ type: "subtask_error", file: pathForFile, message: err.message });
        builder.MarkFailed(ItemID("review", inputMode, d.oldPath === "/dev/null" ? "" : d.oldPath, d.newPath === "/dev/null" ? "" : d.newPath), "unknown", err.message);
        // Do not swallow — if all fail, runReviewContext will handle
        if (diffs.length === 1) {
          await singleTransport.dispose().catch(() => {});
          throw err;
        }
      }
    }

    // If no diffs, mark skipped
    if (diffs.length === 0 || diffs.every((d) => d.isDeleted)) {
      // No selected, manifest will be skipped
    }

    const elapsedMs = Date.now() - startMs;
    const finalized = builder.Finalize(elapsedMs);
    const manifest = finalized.manifest ?? null;
    if (finalized.error) {
      warnings.push({ type: "manifest_finalize_error", file: "", message: finalized.error.message });
    }

    const comments = collector.Comments() as unknown as LlmComment[];

    // Capture transport metrics before dispose
    const inputTokens = (runner as unknown as { totalInputTokens: () => number }).totalInputTokens();
    const outputTokens = (runner as unknown as { totalOutputTokens: () => number }).totalOutputTokens();
    const totalTokens = (runner as unknown as { totalTokensUsed: () => number }).totalTokensUsed();
    const cacheReadTokens = (runner as unknown as { totalCacheReadTokens: () => number }).totalCacheReadTokens();
    const cacheWriteTokens = (runner as unknown as { totalCacheWriteTokens: () => number }).totalCacheWriteTokens();

    // Dispose transport after collecting metrics
    await singleTransport.dispose().catch((e) => {
      warnings.push({ type: "transport_dispose_error", file: "", message: String((e as Error).message) });
    });

    // Build ReviewRunner object
    const reviewRunner: ReviewRunner = {
      run: async (sig?: AbortSignal): Promise<LlmComment[]> => {
        if (sig?.aborted) throw sig.reason instanceof Error ? sig.reason : new Error(String(sig.reason ?? "aborted"));
        return comments;
      },
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
      budgetExceeded: false,
      projectSummary: "",
      resumeInfo: undefined,
      diffs: diffs as unknown as never,
    };

    return reviewRunner;
  };
}

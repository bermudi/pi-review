// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview review wiring at c35ddd7223f2b5540ce03aa43c9a25ef643fca27;
// review cancellation/session finalization follows OCR v1.9.4 commit 31db10f.
// Factory for the parity review CLI — production wiring with real tools, no stubs, no any.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ReviewOptions, ScanOptions } from "./shared.js";
import type { ProgressSink } from "../progress.js";
import type { ReviewRunner } from "./review.js";
import type { ScanRunner } from "./scan.js";
import { type AgentWarning } from "./output.js";
import type { Preview } from "../model/preview.js";
import type { LlmComment } from "../model/review.js";
import { loadDefaultTemplate, loadDefaultScanTemplate, applyLanguage, applyLanguageScan } from "../template/template.js";
import { newResolver, type FileFilter } from "../rules/system_rules.js";
import { minimatch } from "minimatch";
import { mainTaskToolDefs, planTaskToolDefs, loadToolConfig, buildToolDefs } from "../tool/tools-config.js";

/**
 * Exact allowlist of host-implemented safe capabilities.
 * Custom tools files may override/reorder/subset these schemas but must not
 * advertise unknown or mutation capabilities to the model. This mirrors the
 * six tools in the embedded tools.json and matches the host registry.
 */
const SAFE_TOOL_ALLOWLIST = new Set<string>(["task_done", "code_comment", "file_read", "code_search", "file_read_diff", "file_find"]);

function filterToAllowlist(defs: readonly import("../llmloop/types.js").ToolDef[]): readonly import("../llmloop/types.js").ToolDef[] {
  return defs.filter((d) => SAFE_TOOL_ALLOWLIST.has(d.function.name as string));
}
import { CommentCollector } from "../tool/collector.js";
import { CommentWorkerPool } from "../llmloop/pool.js";
import { Agent, newAgent } from "../agent/agent.js";
import { Agent as ScanAgent, NewAgent as NewScanAgent } from "../scan/scan.js";
import { reviewModeString } from "../agent/util.js";
import { createPiTransportForFile, type PiModelIdentity } from "../pi-adapter/pi-transport.js";
import { FileReader, DiffMap, FileReadProvider, FileReadDiffProvider, CodeSearchProvider, FileFindProvider } from "../tool/filereader.js";
import { Registry } from "../tool/definitions.js";
import { buildToolRegistry } from "./git.js";
import { resolveBackground } from "./background.js";
import { REVIEW_FILTER_TOOLS } from "../agent/filter.js";
import { ModeWorkspace, ModeRange, ModeCommit } from "../diff/git.js";
import { RetryCollector } from "../retry/collector.js";
import type { RetryReport } from "../retry/types.js";
import { SessionHistory, ReviewModeFullScan } from "../session/history.js";
import { newJSONLWriter, type JsonlWriter } from "../session/persist.js";
import { ResumeState, LoadResumeState, LoadReviewResumeState, NewResumeLineage } from "../session/resume.js";
import type { ResumeLineage } from "../session/resume.js";
import { resolveIdentity } from "../agent/identity.js";
import type { AnyLlmClient, ChatRequest, ChatResponse } from "../llmloop/types.js";

export interface ReviewFactoryDeps {
  /** Test seam for a deterministic local transport; production uses Pi. */
  readonly createTransport?: RuntimeTransportFactory;
}

/** Runtime-owned transport: factory code may use no provider details beyond this seam. */
export type RuntimeTransport = AnyLlmClient & {
  dispose(): Promise<void>;
  modelIdentity?(): PiModelIdentity | undefined;
};

export type RuntimeTransportFactory = (
  options: Parameters<typeof createPiTransportForFile>[0],
) => Promise<RuntimeTransport>;

type RuntimeTransportOptions = Parameters<typeof createPiTransportForFile>[0];

function requestAffinityKey(req: ChatRequest): string {
  const filePath = req.requestMeta?.filePath;
  if (filePath !== undefined && filePath !== "") return `file:${filePath}`;

  // Production Runner requests carry a task-scoped session ID ending in the
  // stable hash of the file path. The task name changes between plan, main,
  // compression, relocation, and filter stages; the scope hash does not.
  const sessionId = req.sessionId;
  if (sessionId !== undefined && sessionId !== "") {
    const scope = /-([0-9a-f]{16})$/u.exec(sessionId)?.[1];
    return scope !== undefined ? `scope:${scope}` : `session:${sessionId}`;
  }
  throw new Error("Pi request has no file or session affinity; refusing to share a concurrent session");
}

async function completeWithTransport(
  transport: RuntimeTransport,
  signal: AbortSignal,
  req: ChatRequest,
): Promise<ChatResponse> {
  const goStyle = (transport as { CompletionsWithCtx?: (sig: AbortSignal, request: ChatRequest) => Promise<ChatResponse> }).CompletionsWithCtx;
  if (typeof goStyle === "function") return goStyle.call(transport, signal, req);
  const complete = (transport as { complete?: (sig: AbortSignal, request: ChatRequest) => Promise<ChatResponse> }).complete;
  if (typeof complete === "function") return complete.call(transport, signal, req);
  throw new Error("runtime transport must provide complete or CompletionsWithCtx");
}

/**
 * One Pi AgentSession cannot safely serve concurrent file conversations:
 * prompt/followUp and history replacement are mutable session operations.
 * Keep one transport per file affinity while preserving one transport across
 * that file's plan, main, compression, relocation, and filter stages.
 */
class FileScopedTransportPool {
  private readonly byAffinity = new Map<string, Promise<RuntimeTransport>>();
  private readonly owned = new Set<RuntimeTransport>();
  private unclaimedInitial: RuntimeTransport | null;
  private disposed = false;

  constructor(
    initial: RuntimeTransport,
    private readonly createTransport: RuntimeTransportFactory,
    private readonly options: RuntimeTransportOptions,
  ) {
    this.unclaimedInitial = initial;
    this.owned.add(initial);
  }

  modelIdentity(): PiModelIdentity | undefined {
    return this.unclaimedInitial?.modelIdentity?.() ?? [...this.owned][0]?.modelIdentity?.();
  }

  async complete(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse> {
    return this.CompletionsWithCtx(signal, req);
  }

  async CompletionsWithCtx(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse> {
    if (this.disposed) throw new Error("Pi transport pool is disposed");
    const key = requestAffinityKey(req);
    let pending = this.byAffinity.get(key);
    if (pending === undefined) {
      if (this.unclaimedInitial !== null) {
        const initial = this.unclaimedInitial;
        this.unclaimedInitial = null;
        pending = Promise.resolve(initial);
      } else {
        pending = this.createTransport({ ...this.options, sessionId: req.sessionId }).then((transport) => {
          this.owned.add(transport);
          return transport;
        });
      }
      this.byAffinity.set(key, pending);
      void pending.catch(() => {
        if (this.byAffinity.get(key) === pending) this.byAffinity.delete(key);
      });
    }
    return completeWithTransport(await pending, signal, req);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled(this.byAffinity.values());
    const results = await Promise.allSettled([...this.owned].map(async (transport) => transport.dispose()));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${String(errors.length)} Pi transports failed to dispose`);
  }
}

async function createFileScopedTransportPool(
  createTransport: RuntimeTransportFactory,
  options: RuntimeTransportOptions,
): Promise<RuntimeTransport> {
  const initial = await createTransport(options);
  return new FileScopedTransportPool(initial, createTransport, options);
}

async function withOwnedTransport<T>(
  transport: RuntimeTransport,
  work: () => Promise<T>,
  onDeferredDisposeError?: (error: Error) => void,
): Promise<T> {
  let primary: Error | null = null;
  try {
    return await work();
  } catch (error) {
    primary = error instanceof Error ? error : new Error(String(error));
    throw primary;
  } finally {
    try {
      await transport.dispose();
    } catch (error) {
      const disposeError = error instanceof Error ? error : new Error(String(error));
      if (primary !== null) {
        throw new AggregateError(
          [primary, disposeError],
          `${primary.message}; additionally, transport disposal failed: ${disposeError.message}`,
          { cause: primary },
        );
      }
      if (onDeferredDisposeError !== undefined) {
        onDeferredDisposeError(disposeError);
      } else {
        throw disposeError;
      }
    }
  }
}

export interface ScanFactoryDeps {
  readonly createTransport?: RuntimeTransportFactory;
}

type PiModel = NonNullable<NonNullable<Parameters<typeof createPiTransportForFile>[0]>["model"]>;

export interface PiModelSelection {
  readonly model: PiModel;
  readonly modelRuntime: ModelRuntime;
  readonly identity: PiModelIdentity;
}

/** Resolve the documented `provider/model` selector through Pi's public model runtime. */
export async function resolvePiModelSelection(
  agentDir: string,
  provider: string,
  selector: string,
): Promise<PiModelSelection | null> {
  if (provider === "" && selector === "") return null;
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  let selectedProvider = provider;
  let selectedModel = selector;
  const slash = provider === "" ? selector.indexOf("/") : -1;
  if (slash >= 0) {
    const embeddedProvider = selector.slice(0, slash);
    const embeddedModel = selector.slice(slash + 1);
    if (embeddedProvider === "" || embeddedModel === "") {
      throw new Error(`invalid --model "${selector}": use provider/model`);
    }
    if (provider !== "" && provider !== embeddedProvider) {
      throw new Error(`--provider "${provider}" does not match --model "${selector}"`);
    }
    selectedProvider = embeddedProvider;
    selectedModel = embeddedModel;
  }
  let model: PiModel | undefined;
  if (selectedProvider !== "" && selectedModel !== "") {
    model = runtime.getModel(selectedProvider, selectedModel);
  } else if (selectedProvider !== "") {
    const matches = runtime.getModels(selectedProvider);
    if (matches.length !== 1) {
      throw new Error(`--provider "${selectedProvider}" is ambiguous; specify --model ${selectedProvider}/model`);
    }
    model = matches[0];
  } else {
    const matches = runtime.getModels().filter((candidate) => candidate.id === selectedModel);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `unknown --model "${selector}"; use provider/model`
        : `--model "${selector}" is ambiguous; use provider/model`);
    }
    model = matches[0];
  }
  if (model === undefined) {
    throw new Error(`unknown model "${selectedProvider}/${selectedModel}" in Pi configuration`);
  }
  return { model, modelRuntime: runtime, identity: { provider: model.provider, model: model.id } };
}

function transportModelIdentity(transport: unknown): PiModelIdentity | undefined {
  if (typeof transport !== "object" || transport === null) return undefined;
  const getter = (transport as { modelIdentity?: unknown }).modelIdentity;
  if (typeof getter !== "function") return undefined;
  const identity = (getter as (this: unknown) => unknown).call(transport);
  if (typeof identity !== "object" || identity === null) return undefined;
  const value = identity as Record<string, unknown>;
  return typeof value["provider"] === "string" && typeof value["model"] === "string"
    ? { provider: value["provider"], model: value["model"] }
    : undefined;
}

/**
 * Create a production ReviewRunner for one review invocation.
 * This is the factory injected into the parity CLI (src/ocr/cli/index.ts)
 * for the sole OCR v1.9.3 engine (no legacy delegation).
 *
 * Uses the v1.9.3 Agent orchestrator so per-file loops, planning, filtering,
 * relocation, concurrency, and budget behaviour are all exercised.
 */
export function createReviewRunnerFactory(
  opts: ReviewOptions,
  ioCwd: string,
  deps: ReviewFactoryDeps = {},
  progress?: ProgressSink,
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

    let mainToolDefs: readonly import("../llmloop/types.js").ToolDef[];
    let planToolDefs: readonly import("../llmloop/types.js").ToolDef[];
    if (opts.toolConfigPath !== "" && opts.toolConfigPath !== undefined) {
      try {
        const entries = loadToolConfig(opts.toolConfigPath);
        mainToolDefs = filterToAllowlist(buildToolDefs(entries, false));
        planToolDefs = filterToAllowlist(buildToolDefs(entries, true));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`load tools: ${msg}`);
      }
    } else {
      mainToolDefs = mainTaskToolDefs();
      planToolDefs = planTaskToolDefs();
    }

    const ruleSet = newResolver(repoDir, opts.rulePath);
    const ruleResolver = ruleSet.resolver;
    const fileFilter = ruleSet.filter;

    const collector = new CommentCollector();

    const from = opts.from;
    const to = opts.to;
    const commit = opts.commit;
    const reviewMode = reviewModeString(from, to, commit);
    let resume: ResumeState | null = null;
    let sealedInput: import("../diff/git.js").InputResolution | null = null;
    let resumeIdentity: import("../agent/identity.js").RunIdentity | null = null;
    if (opts.resume !== "") {
      resume = LoadReviewResumeState(repoDir, opts.resume);
      const optionsError = resume.ValidateOptions({ reviewMode });
      if (optionsError !== null) throw optionsError;
      const sealed = await resolveIdentity({
        repoDir,
        from: from || undefined,
        to: to || undefined,
        commit: commit || undefined,
        fileFilter: fileFilter ?? null,
        systemRule: ruleResolver,
        template,
      }, effectiveSignal);
      sealedInput = sealed.resolution;
      resumeIdentity = sealed.identity;
    }

    let background = opts.background;
    if (opts.backgroundResolved !== true) {
      background = await resolveBackground(repoDir, background, opts.backgroundFile, commit);
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
    const registry = buildToolRegistry(collector, fileReader);
    registry.Freeze();
    const cwd = repoDir;
    const agentDirEnv = process.env["PI_CODING_AGENT_DIR"];
    const agentDir = agentDirEnv !== undefined && agentDirEnv !== "" ? agentDirEnv : `${process.env["HOME"] ?? "/tmp"}/.pi/agent`;

    const retryCollector = new RetryCollector();
    const selection = await resolvePiModelSelection(agentDir, opts.provider, opts.model);
    const createTransport = deps.createTransport ?? createPiTransportForFile;
    const transport = await createFileScopedTransportPool(createTransport, {
      cwd,
      agentDir,
      tools: mainToolDefs,
      supplementalTools: REVIEW_FILTER_TOOLS,
      retryCollector,
      model: selection?.model,
      modelRuntime: selection?.modelRuntime,
    });
    let deferredRunError: Error | null = null;
    return await withOwnedTransport(transport, async () => {
    const identity = transportModelIdentity(transport) ?? selection?.identity ?? {
      provider: opts.provider,
      model: opts.model !== "" ? opts.model : "test-model",
    };
    const modelId = identity.model;
    if (resume !== null && resumeIdentity !== null) {
      const validation = resume.ValidateResume({
        identity: {
          mode: resumeIdentity.mode,
          sourceArtifactSha256: resumeIdentity.sourceArtifactSHA256,
          ruleConfigSha256: resumeIdentity.ruleConfigSHA256,
          repositorySha256: resumeIdentity.repositorySHA256,
        },
        provider: identity.provider,
        model: modelId,
        providerExplicit: opts.provider !== "",
        modelExplicit: opts.model !== "",
      });
      if (validation !== null) {
        throw validation;
      }
    }

    const runId = randomUUID();
    const gitBranch = detectGitBranch(repoDir);
    const session = new SessionHistory(repoDir, gitBranch, modelId, {
      reviewMode,
      diffFrom: from,
      diffTo: to,
      diffCommit: commit,
      operation: "review",
      resumedFrom: resume?.SessionID ?? "",
    }, runId);
    let writer: JsonlWriter | null = null;
    try {
      writer = newJSONLWriter(runId, repoDir, gitBranch, modelId, {
        reviewMode,
        diffFrom: from,
        diffTo: to,
        diffCommit: commit,
        resumedFrom: resume?.SessionID ?? "",
      });
      session._attachPersist(jsonlWriterToPersistHandle(writer));
      session.RecordResumeLineage(NewResumeLineage(resume, runId, identity.provider, modelId));
    } catch (err) {
      writer?.close();
      session._attachPersist(null);
      const cause = err instanceof Error ? err : new Error(String(err));
      session._setPersistInitErr(new Error(`create session writer: ${cause.message}`, { cause }));
    }

    const maxConcurrency = opts.concurrency > 0 ? opts.concurrency : 8;
    const concurrentTaskTimeoutMinutes = opts.perFileTimeout > 0 ? opts.perFileTimeout : 10;

    const agent = newAgent({
      repoDir,
      sessionId: runId,
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
      provider: identity.provider,
      maxTokensBudget: opts.maxTokensBudget > 0 ? opts.maxTokensBudget : undefined,
      skipFilter: opts.noFilter,
      runtimeConfig: { protocol: "openai", endpointHost: "", language: "English", timeoutMs: 30000 },
      session,
      resume,
      sealedInput,
      progress,
    });

    const startMs = Date.now();
    let comments: LlmComment[] = [];
    let runError: Error | null = null;
    try {
      comments = await agent.run(effectiveSignal);
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    }
    deferredRunError = runError;
    // Freeze retry report at same boundary as manifest (after ag.Run joined background work).
    let retryReport: RetryReport | null = null;
    let freezeError: string | null = null;
    const frozen = retryCollector.freeze(runId);
    if (frozen.error !== null) {
      freezeError = frozen.error;
    } else {
      retryReport = frozen.report;
    }

    const warnings = agent.warningsList();

    const reviewRunner: ReviewRunner = {
      run: async (_sig?: AbortSignal): Promise<LlmComment[]> => {
        if (deferredRunError !== null) throw deferredRunError;
        return comments;
      },
      // A failed session_end cannot be resumed, but its already-built
      // manifest remains useful coverage evidence for the final result.
      manifest: agent.RunManifest() ?? undefined,
      warnings,
      filesReviewed: agent.FilesReviewed(),
      inputTokens: agent.TotalInputTokens(),
      outputTokens: agent.TotalOutputTokens(),
      totalTokens: agent.TotalTokensUsed(),
      cacheReadTokens: agent.TotalCacheReadTokens(),
      cacheWriteTokens: agent.TotalCacheWriteTokens(),
      toolCalls: agent.ToolCalls(),
      sessionId: agent.sessionId(),
      budgetExceeded: agent.budgetExceededFlag(),
      projectSummary: "",
      resumeInfo: agent.ResumeInfo(),
      diffs: agent.Diffs(),
      retryReport,
      retryReportError: freezeError,
    };

    return reviewRunner;
    }, (disposeError) => {
      deferredRunError = deferredRunError === null
        ? disposeError
        : new AggregateError(
          [deferredRunError, disposeError],
          `${deferredRunError.message}; additionally, transport disposal failed: ${disposeError.message}`,
          { cause: deferredRunError },
        );
    });
  };
}

// ---------------------------------------------------------------------------
// Scan factory — mirrors cmd/opencodereview/scan_cmd.go executeScan
// ---------------------------------------------------------------------------

export function createScanRunnerFactory(
  opts: ScanOptions,
  _ioCwd: string,
  progress?: ProgressSink,
  deps: ScanFactoryDeps = {},
): (signal?: AbortSignal) => Promise<ScanRunner> {
  return async (signal?: AbortSignal): Promise<ScanRunner> => {
    const effectiveSignal = signal ?? new AbortController().signal;
    const repoDir = opts.repoDir !== "" ? path.resolve(opts.repoDir) : process.cwd();

    if (!fs.existsSync(repoDir)) {
      throw new Error(`repo directory not found: ${repoDir}`);
    }

    let template = loadDefaultScanTemplate();
    // OCR's scan command only applies the language directive when AppCfg is
    // non-nil (scan_cmd.go line 167-169). Without a config file — the common
    // test and default CLI case — the directive is not applied. Match that
    // behavior by not calling applyLanguageScan here. The review path is
    // different: loadLLMRuntime always calls ApplyLanguage (shared.go line 209).
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
    let allMainToolDefs: readonly import("../llmloop/types.js").ToolDef[];
    if (opts.toolConfigPath !== "" && opts.toolConfigPath !== undefined) {
      try {
        const entries = loadToolConfig(opts.toolConfigPath);
        allMainToolDefs = filterToAllowlist(buildToolDefs(entries, false));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`load tools: ${msg}`);
      }
    } else {
      allMainToolDefs = mainTaskToolDefs();
    }
    const mainToolDefs = allMainToolDefs.filter((t) => t.function.name !== "file_read_diff");

    const selection = await resolvePiModelSelection(agentDir, opts.provider, opts.model);
    const createTransport = deps.createTransport ?? createPiTransportForFile;
    const transport = await createFileScopedTransportPool(createTransport, {
      cwd,
      agentDir,
      tools: mainToolDefs,
      model: selection?.model,
      modelRuntime: selection?.modelRuntime,
    });
    return await withOwnedTransport(transport, async () => {
    const modelIdentity = transportModelIdentity(transport) ?? selection?.identity ?? {
      provider: opts.provider,
      model: modelIdFromModel(opts.model),
    };
    const gitBranch = detectGitBranch(repoDir);
    const runId = randomUUID();
    const session = new SessionHistory(repoDir, gitBranch, modelIdentity.model, {
      reviewMode: ReviewModeFullScan,
      scanPaths,
      resumedFrom: resume?.SessionID ?? "",
    }, runId);
    const writer = newJSONLWriter(runId, repoDir, gitBranch, modelIdentity.model, {
      reviewMode: ReviewModeFullScan,
      scanPaths,
      resumedFrom: resume?.SessionID ?? "",
    });
    session._attachPersist(jsonlWriterToPersistHandle(writer));

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
      model: modelIdentity.model,
      background: opts.background,
      maxFileSizeBytes: template.MaxFileSizeBytes,
      maxTokensBudget,
      skipPlan: opts.noPlan,
      skipDedup: opts.noDedup,
      skipSummary: opts.noSummary,
      resume,
      session,
      progress,
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

    const finalizationError = await session.Finalize();
    if (finalizationError !== null) {
      runError = runError === null
        ? finalizationError
        : new AggregateError([runError, finalizationError], `${runError.message}; additionally, scan finalization failed: ${finalizationError.message}`, { cause: runError });
    }

    const inputTokens = agent.TotalInputTokens();
    const outputTokens = agent.TotalOutputTokens();
    const totalTokens = agent.TotalTokensUsed();
    const cacheReadTokens = agent.TotalCacheReadTokens();
    const cacheWriteTokens = agent.TotalCacheWriteTokens();
    const toolCalls = agent.ToolCalls();
    const warnings = agent.Warnings();

    const scanRunner: ScanRunner = {
      run: async (_sig?: AbortSignal): Promise<LlmComment[]> => {
        if (runError !== null) throw runError;
        return comments;
      },
      manifest: null,
      warnings,
      filesReviewed: agent.FilesReviewed(),
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      toolCalls,
      sessionId: session.SessionID,
      budgetExceeded: agent.BudgetExceeded(),
      projectSummary: agent.ProjectSummary(),
      resumeInfo: agent.ResumeInfo,
      diffs: [],
    };

    if (runError) {
      throw runError;
    }

    return scanRunner;
    });
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
    writeLLMRequest: (...args) => { (writer as unknown as { WriteLLMRequest: (...a: unknown[]) => void }).WriteLLMRequest(...(args as unknown[])); },
    writeLLMResponse: (...args) => { (writer as unknown as { WriteLLMResponse: (...a: unknown[]) => void }).WriteLLMResponse(...(args as unknown[])); },
    writeLLMError: (...args) => { (writer as unknown as { WriteLLMError: (...a: unknown[]) => void }).WriteLLMError(...(args as unknown[])); },
    writeToolCall: (...args) => { (writer as unknown as { WriteToolCall: (...a: unknown[]) => void }).WriteToolCall(...(args as unknown[])); },
  };
}

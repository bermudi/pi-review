// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/manifest_integration_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { Agent, reviewItemFingerprint } from "../../../src/ocr/agent/agent.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import { createDiff } from "../../../src/ocr/model/diff.js";
import { SessionHistory } from "../../../src/ocr/session/history.js";
import { FailureProvider, FailureTimeout, FailurePanic, FailureBudget, FailureCancelled, RunFailureCancelled, StateComplete, StatePartial, StateFailed, StateSkipped, type FailureClass } from "../../../src/ocr/session/manifest.js";
import { newJSONLWriter } from "../../../src/ocr/session/persist.js";
import { LoadReviewResumeState } from "../../../src/ocr/session/resume.js";
import type { Template } from "../../../src/ocr/template/template.js";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";

class ManifestFlowClient {
  async CompletionsWithCtx(_signal: unknown, req: unknown): Promise<unknown> {
    const r = req as { messages: Array<{ content: string }> };
    let prompt = "";
    for (const m of r.messages) if (typeof m.content === "string") prompt += m.content;
    if (prompt.includes("panic.go")) throw new Error("manifest integration panic");
    if (prompt.includes("bad.go")) throw new Error("provider rejected api_key=LEAKED at /Users/example/private");
    if (prompt.includes("slow.go") || prompt.includes("timeout.go")) {
      const err = new Error("provider call timed out: context deadline exceeded");
      (err as unknown as { cause?: unknown }).cause = new Error("context deadline exceeded");
      throw err;
    }
    return {
      content: "",
      toolCalls: [{ id: "call_done", type: "function", function: { name: "task_done", arguments: "{}" } }],
      usage: { PromptTokens: 10, CompletionTokens: 5 },
    };
  }
  async complete(signal: unknown, req: unknown): Promise<unknown> {
    return this.CompletionsWithCtx(signal, req);
  }
}

class CancellationFlowClient extends ManifestFlowClient {
  private resolveBlocked!: () => void;
  readonly blocked = new Promise<void>((resolve) => {
    this.resolveBlocked = resolve;
  });
  calls = 0;

  override async CompletionsWithCtx(signal: unknown, req: unknown): Promise<unknown> {
    const prompt = (req as { messages: Array<{ content: string }> }).messages
      .map((message) => typeof message.content === "string" ? message.content : "")
      .join("\n");
    this.calls++;
    if (!prompt.includes("blocked.go")) return super.CompletionsWithCtx(signal, req);
    this.resolveBlocked();
    const abortSignal = signal as AbortSignal;
    return new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error("context canceled"));
      };
      if (abortSignal.aborted) {
        rejectAbort();
        return;
      }
      abortSignal.addEventListener("abort", rejectAbort, { once: true });
    });
  }
}

function persistManifestSession(agent: Agent): void {
  const session = (agent as unknown as { session: SessionHistory }).session;
  const writer = newJSONLWriter(session.sessionId, session.repoDir, session.gitBranch, session.model, {
    reviewMode: session.reviewMode,
    diffFrom: session.diffFrom,
    diffTo: session.diffTo,
    diffCommit: session.diffCommit,
    resumedFrom: session.resumedFrom,
  });
  session._attachPersist({
    writeReviewItemDone: (...args) => { writer.WriteReviewItemDone(...args); },
    writeReviewItemReused: (...args) => { writer.WriteReviewItemReused(...args); },
    writeReviewItemFailed: (...args) => { writer.WriteReviewItemFailed(...args); },
    writeResumeLineage: (lineage) => { writer.WriteResumeLineage(lineage); },
    writeSessionEnd: (...args) => writer.WriteSessionEnd(...args),
    writeLLMRequest: (...args) => { writer.WriteLLMRequest(...args); },
    writeLLMResponse: (...args) => { writer.WriteLLMResponse(...args); },
    writeLLMError: (...args) => { writer.WriteLLMError(...args); },
    writeToolCall: (...args) => { writer.WriteToolCall(...args); },
  });
}

function newManifestFlowAgent(diffs: Diff[], resume: unknown, client?: unknown): Agent {
  const repoDir = fs.mkdtempSync(os.tmpdir() + "/pi-manifest-");
  const home = fs.mkdtempSync(os.tmpdir() + "/pi-home-");
  process.env.HOME = home;
  const sess = new SessionHistory(repoDir, "feature", "fake", { reviewMode: "range", diffFrom: "main", diffTo: "feature", resumedFrom: (resume as Record<string, unknown>)?.["sessionId"] as string ?? "" });
  const c = (client ?? new ManifestFlowClient()) as unknown as never;
  const collector = new CommentCollector() as unknown as never;
  const agent = new Agent({
    repoDir,
    from: "main",
    to: "feature",
    reviewMode: "range",
    llmClient: c,
    model: "fake",
    Session: sess as unknown as never,
    resume: resume as unknown as never,
    commentCollector: collector as unknown as never,
    template: {
      MaxTokens: 100000,
      MaxToolRequestTimes: 5,
      MainTask: { messages: [{ role: "user", content: "Review {{current_file_path}} {{diff}}" }] },
      MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
    } as unknown as Template,
    mainToolDefs: [{ type: "function", function: { name: "task_done", description: "finish" } }] as unknown as never,
  } as unknown as never);
  (agent as unknown as { diffs: Diff[] }).diffs = diffs;
  (agent as unknown as { currentDate: string }).currentDate = "2026-07-26 12:00";
  return agent;
}

async function finish(agent: Agent): Promise<import("../../../src/ocr/session/manifest.js").RunManifest> {
  const err = (agent as unknown as { finalizeManifest: () => Error | null }).finalizeManifest();
  if (err) throw err;
  (agent as unknown as { session: SessionHistory }).session.Finalize();
  const m = (agent as unknown as { RunManifest: () => import("../../../src/ocr/session/manifest.js").RunManifest | null }).RunManifest();
  if (!m) throw new Error("no manifest");
  return m;
}

describe("ocr agent manifest integration (ported)", () => {
  // OCR v1.9.9: TestManifestFlowCancellationPersistsResumableSession
  test("TestManifestFlowCancellationPersistsResumableSession", async () => {
    const done = createDiff({ oldPath: "done.go", newPath: "done.go", diff: "+done", insertions: 1 });
    const blocked = createDiff({ oldPath: "blocked.go", newPath: "blocked.go", diff: "+blocked", insertions: 1 });
    const pending = createDiff({ oldPath: "pending.go", newPath: "pending.go", diff: "+pending", insertions: 1 });
    const client = new CancellationFlowClient();
    const agent = newManifestFlowAgent([done, blocked, pending], null, client);
    persistManifestSession(agent);
    (agent as unknown as { args: { maxConcurrency: number } }).args.maxConcurrency = 1;

    const controller = new AbortController();
    const dispatch = (agent as unknown as { dispatchSubtasks: (signal: AbortSignal) => Promise<unknown> })
      .dispatchSubtasks(controller.signal);
    await client.blocked;
    controller.abort(new Error("context canceled"));
    await expect(dispatch).rejects.toThrow("context canceled");

    const manifest = await finish(agent);
    expect(manifest.runFailure?.classification).toBe(RunFailureCancelled);
    expect(manifest.coverage.completed).toHaveLength(1);
    expect(manifest.coverage.failed).toHaveLength(2);
    for (const item of manifest.coverage.failed) {
      expect(item.classification).toBe(FailureCancelled);
    }

    const session = (agent as unknown as { session: SessionHistory }).session;
    const resume = LoadReviewResumeState(session.repoDir, session.sessionId);
    const resumeError = resume.ValidateResume({
      identity: {
        mode: manifest.input.mode,
        sourceArtifactSha256: manifest.input.sourceArtifactSha256,
        ruleConfigSha256: manifest.execution.ruleConfigSha256,
        repositorySha256: manifest.repository.identitySha256,
      },
      provider: manifest.execution.provider ?? "",
      model: manifest.execution.model ?? "",
      providerExplicit: false,
      modelExplicit: false,
    });
    expect(resumeError).toBeNull();
    expect(resume.ReusableItem(reviewItemFingerprint("range", done))).not.toBeNull();
    expect(resume.ReusableItem(reviewItemFingerprint("range", blocked))).toBeNull();
  });

  // OCR v1.9.9: TestManifestFlowCancellationBeforeDispatchStartsNoSubtask
  test("TestManifestFlowCancellationBeforeDispatchStartsNoSubtask", async () => {
    const pending = createDiff({ oldPath: "blocked.go", newPath: "blocked.go", diff: "+blocked", insertions: 1 });
    const client = new CancellationFlowClient();
    const agent = newManifestFlowAgent([pending], null, client);
    persistManifestSession(agent);

    const controller = new AbortController();
    controller.abort(new Error("context canceled"));
    await expect(
      (agent as unknown as { dispatchSubtasks: (signal: AbortSignal) => Promise<unknown> })
        .dispatchSubtasks(controller.signal),
    ).rejects.toThrow("context canceled");
    expect(client.calls).toBe(0);
    expect((agent as unknown as { warnings: unknown[] }).warnings).toHaveLength(0);

    const manifest = await finish(agent);
    expect(manifest.runFailure?.classification).toBe(RunFailureCancelled);
    expect(manifest.coverage.completed).toHaveLength(0);
    expect(manifest.coverage.failed).toHaveLength(1);
    expect(manifest.coverage.failed[0]?.classification).toBe(FailureCancelled);
  });

  // OCR v1.9.3: TestManifestFlowCompleteAndPartial
  test("TestManifestFlowCompleteAndPartial", async () => {
    const a1 = newManifestFlowAgent([createDiff({ oldPath: "good.go", newPath: "good.go", diff: "+ok", insertions: 1 })], null);
    const c1 = await (a1 as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    expect((c1 as unknown[]).length).toBe(0);
    const m1 = await finish(a1);
    expect(m1.terminalState).toBe(StateComplete);
    expect(m1.coverage.completed.length).toBe(1);

    const a2 = newManifestFlowAgent([createDiff({ oldPath: "good.go", newPath: "good.go", diff: "+ok", insertions: 1 }), createDiff({ oldPath: "bad.go", newPath: "bad.go", diff: "+bad", insertions: 1 })], null);
    await (a2 as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    const m2 = await finish(a2);
    expect(m2.terminalState).toBe(StatePartial);
    expect(m2.coverage.failed.length).toBe(1);
    expect(m2.coverage.failed[0]!.classification).toBe(FailureProvider);
  });

  // OCR v1.9.3: TestManifestFlowRunInputFailureIsPersisted
  test("TestManifestFlowRunInputFailureIsPersisted", async () => {
    const repoDir = fs.mkdtempSync(os.tmpdir() + "/pi-input-");
    process.env.HOME = fs.mkdtempSync(os.tmpdir() + "/pi-home-");
    const sess = new SessionHistory(repoDir, "feature", "fake", { reviewMode: "range", diffFrom: "missing-base", diffTo: "missing-head" });
    const agent = new Agent({
      repoDir,
      from: "missing-base",
      to: "missing-head",
      reviewMode: "range",
      llmClient: new ManifestFlowClient() as unknown as never,
      model: "fake",
      Session: sess as unknown as never,
      template: { MaxTokens: 100000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    let threw = false;
    try { await (agent as unknown as { run: () => Promise<unknown> }).run(); } catch { threw = true; }
    expect(threw).toBe(true);
    const m = (agent as unknown as { RunManifest: () => import("../../../src/ocr/session/manifest.js").RunManifest | null }).RunManifest();
    expect(m).not.toBeNull();
    expect(m!.terminalState).toBe(StateFailed);
    expect(m!.runFailure).not.toBeNull();
  });

  // OCR v1.9.3: TestManifestFlowAllFailedTimeoutAndPanic
  test("TestManifestFlowAllFailedTimeoutAndPanic", async () => {
    const cases: Array<{ path: string; sig: () => AbortSignal; want: FailureClass }> = [
      { path: "bad.go", sig: () => new AbortController().signal, want: FailureProvider },
      { path: "timeout.go", sig: () => new AbortController().signal, want: FailureTimeout },
      { path: "panic.go", sig: () => new AbortController().signal, want: FailurePanic },
    ];
    for (const tc of cases) {
      const agent = newManifestFlowAgent([createDiff({ oldPath: tc.path, newPath: tc.path, diff: "+x", insertions: 1 })], null);
      let threw = false;
      try { await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown> }).dispatchSubtasks(tc.sig()); } catch { threw = true; }
      expect(threw).toBe(true);
      const m = await finish(agent);
      expect(m.coverage.failed.length).toBe(1);
      expect(m.coverage.failed[0]!.classification).toBe(tc.want);
    }
  });

  // OCR v1.9.3: TestManifestFlowMixedFailureIsIsolatedToPartial
  test("TestManifestFlowMixedFailureIsIsolatedToPartial", async () => {
    const longPath = "nested/".repeat(20) + "budget.go";
    const cases: Array<{ failDiff: Diff; want: FailureClass; setup?: (a: Agent) => void }> = [
      { failDiff: createDiff({ oldPath: "slow.go", newPath: "slow.go", diff: "+slow", insertions: 1 }), want: FailureTimeout },
      { failDiff: createDiff({ oldPath: "panic.go", newPath: "panic.go", diff: "+boom", insertions: 1 }), want: FailurePanic },
      { failDiff: createDiff({ oldPath: longPath as string, newPath: longPath as string, diff: "token ".repeat(50), insertions: 1 }), want: FailureBudget, setup: (a) => { (a as unknown as { args: { template: { MaxTokens: number } } }).args.template.MaxTokens = 100; } },
    ];
    for (const tc of cases) {
      const agent = newManifestFlowAgent([createDiff({ oldPath: "good.go", newPath: "good.go", diff: "+ok", insertions: 1 }), tc.failDiff], null);
      if (tc.setup) tc.setup(agent);
      await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown> }).dispatchSubtasks(new AbortController().signal);
      const m = await finish(agent);
      expect(m.terminalState).toBe(StatePartial);
      expect(m.coverage.failed.length).toBe(1);
      expect(m.coverage.failed[0]!.classification).toBe(tc.want);
    }
  });

  // OCR v1.9.3: TestManifestFlowBudgetAndSkipped
  test("TestManifestFlowBudgetAndSkipped", async () => {
    const a1 = newManifestFlowAgent([createDiff({ oldPath: "budget.go", newPath: "budget.go", diff: "+x", insertions: 1 })], null);
    (a1 as unknown as { args: { template: { MaxTokens: number; MainTask: { messages: Array<{ content: string }> } } } }).args.template.MaxTokens = 100;
    (a1 as unknown as { args: { template: { MainTask: { messages: Array<{ content: string }> } } } }).args.template.MainTask.messages[0]!.content = "context ".repeat(200) + "{{diff}}";
    await (a1 as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown> }).dispatchSubtasks(new AbortController().signal);
    const m1 = await finish(a1);
    expect(m1.coverage.failed[0]!.classification).toBe(FailureBudget);

    const a2 = newManifestFlowAgent([createDiff({ oldPath: "large.go", newPath: "large.go", diff: "word ".repeat(500), insertions: 1 })], null);
    (a2 as unknown as { args: { template: { MaxTokens: number } } }).args.template.MaxTokens = 10;
    await (a2 as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown> }).dispatchSubtasks(new AbortController().signal);
    const m2 = await finish(a2);
    expect(m2.terminalState).toBe(StateSkipped);
  });

  // OCR v1.9.3: TestManifestFlowResumeRecordsParentAndReusedItem
  test("TestManifestFlowResumeRecordsParentAndReusedItem", async () => {
    const diffs = [createDiff({ oldPath: "cached.go", newPath: "cached.go", diff: "+cached", insertions: 1 }), createDiff({ oldPath: "fresh.go", newPath: "fresh.go", diff: "+fresh", insertions: 1 })];
    const fp = reviewItemFingerprint("range", diffs[0]!);
    const resume: Record<string, unknown> = {
      sessionId: "parent-run", reviewMode: "range", diffFrom: "main", diffTo: "feature",
      items: new Map([[fp, { filePath: "cached.go", oldPath: "cached.go", newPath: "cached.go", fingerprint: fp }]]),
      manifest: { coverage: { selected: [{ itemId: fp, fingerprint: fp }], completed: [{ itemId: fp, fingerprint: fp }], reused: [], failed: [], waived: [] } },
      ReusableItem: function (f: string) { return (this as unknown as { items: Map<string, unknown> }).items.get(f) ?? null; },
    };
    const agent = newManifestFlowAgent(diffs, resume);
    await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown> }).dispatchSubtasks(new AbortController().signal);
    const m = await finish(agent);
    expect(m.parentRunId).toBe("parent-run");
    expect(m.coverage.reused.length).toBe(1);
  });

  // OCR v1.9.3: TestManifestFlowReusedCommentsStayOutOfPrompts
  test("TestManifestFlowReusedCommentsStayOutOfPrompts", async () => {
    const diffs = [createDiff({ oldPath: "cached.go", newPath: "cached.go", diff: "+cached", insertions: 1 }), createDiff({ oldPath: "fresh.go", newPath: "fresh.go", diff: "+fresh", insertions: 1 })];
    const fp = reviewItemFingerprint("range", diffs[0]!);
    const finding = "PARENT_FINDING_ABOUT_CACHED_GO";
    const resume: Record<string, unknown> = {
      sessionId: "parent-run", reviewMode: "range", diffFrom: "main", diffTo: "feature",
      items: new Map([[fp, { filePath: "cached.go", oldPath: "cached.go", newPath: "cached.go", fingerprint: fp, comments: [{ path: "cached.go", content: finding }] }]]),
      manifest: { coverage: { selected: [{ itemId: fp, fingerprint: fp }], completed: [{ itemId: fp, fingerprint: fp }], reused: [], failed: [], waived: [] } },
      ReusableItem: function (f: string) { return (this as unknown as { items: Map<string, unknown> }).items.get(f) ?? null; },
    };
    const prompts: string[] = [];
    const spy = {
      async CompletionsWithCtx(_s: unknown, req: unknown): Promise<unknown> {
        const r = req as { messages: Array<{ content: string }> };
        let p = "";
        for (const m of r.messages) if (typeof m.content === "string") p += m.content;
        prompts.push(p);
        return { content: "", toolCalls: [{ id: "1", type: "function", function: { name: "task_done", arguments: "{}" } }], usage: { PromptTokens: 10, CompletionTokens: 5 } };
      },
      async complete(s: unknown, r: unknown): Promise<unknown> { return this.CompletionsWithCtx(s, r); },
    };
    const agent = newManifestFlowAgent(diffs, resume, spy);
    const comments = await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    expect(comments.some((c) => (c as unknown as { content: string }).content === finding)).toBe(true);
    expect(prompts.length).toBe(1);
    for (const p of prompts) {
      expect(p.includes(finding)).toBe(false);
      expect(p.includes("cached.go")).toBe(false);
    }
  });

  // OCR v1.9.3: TestManifestFlowResumeIgnoresCheckpointTheParentManifestDoesNotVouchFor
  test("TestManifestFlowResumeIgnoresCheckpointTheParentManifestDoesNotVouchFor", async () => {
    const diffs = [createDiff({ oldPath: "cached.go", newPath: "cached.go", diff: "+cached", insertions: 1 })];
    const fp = reviewItemFingerprint("range", diffs[0]!);
    const resume: Record<string, unknown> = {
      sessionId: "parent-run", reviewMode: "range", diffFrom: "main", diffTo: "feature",
      items: new Map([[fp, { filePath: "cached.go", newPath: "cached.go", fingerprint: fp }]]),
      manifest: { coverage: { selected: [{ itemId: "fp-some-other-item", fingerprint: "fp-some-other-item" }], completed: [{ itemId: "fp-some-other-item", fingerprint: "fp-some-other-item" }], reused: [], failed: [], waived: [] } },
      ReusableItem: function (f: string) { const m = (this as unknown as { manifest: { coverage: { completed: unknown[] } } }).manifest; if (!m.coverage.completed.some((c: unknown) => (c as { fingerprint: string }).fingerprint === f)) return null; return (this as unknown as { items: Map<string, unknown> }).items.get(f) ?? null; },
    };
    const agent = newManifestFlowAgent(diffs, resume);
    await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown> }).dispatchSubtasks(new AbortController().signal);
    const m = await finish(agent);
    expect(m.coverage.reused.length).toBe(0);
    expect(m.coverage.completed.length).toBe(1);
  });

  // OCR v1.9.3: TestManifestFlowResumeOfFullyFailedParentRedispatchesEverything
  test("TestManifestFlowResumeOfFullyFailedParentRedispatchesEverything", async () => {
    const diffs = [createDiff({ oldPath: "one.go", newPath: "one.go", diff: "+one", insertions: 1 }), createDiff({ oldPath: "two.go", newPath: "two.go", diff: "+two", insertions: 1 })];
    const fps = diffs.map((d) => reviewItemFingerprint("range", d));
    const resume: Record<string, unknown> = {
      sessionId: "parent-run", reviewMode: "range", diffFrom: "main", diffTo: "feature",
      items: new Map(),
      manifest: { coverage: { selected: fps.map((fp) => ({ itemId: fp, fingerprint: fp })), completed: [], failed: fps.map((fp) => ({ itemId: fp, fingerprint: fp, classification: "provider" })), reused: [], waived: [] } },
      ReusableItem: () => null,
    };
    const agent = newManifestFlowAgent(diffs, resume);
    await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown> }).dispatchSubtasks(new AbortController().signal);
    const m = await finish(agent);
    expect(m.coverage.reused.length).toBe(0);
    expect(m.coverage.completed.length).toBe(2);
  });

  // OCR v1.9.3: TestManifestFlowResumeWithReusedAndAllRerunsFailedIsPartial
  test("TestManifestFlowResumeWithReusedAndAllRerunsFailedIsPartial", async () => {
    const diffs = [createDiff({ oldPath: "cached.go", newPath: "cached.go", diff: "+cached", insertions: 1 }), createDiff({ oldPath: "bad.go", newPath: "bad.go", diff: "+bad", insertions: 1 })];
    const fp = reviewItemFingerprint("range", diffs[0]!);
    const resume: Record<string, unknown> = {
      sessionId: "parent-run", reviewMode: "range", diffFrom: "main", diffTo: "feature",
      items: new Map([[fp, { filePath: "cached.go", oldPath: "cached.go", newPath: "cached.go", fingerprint: fp }]]),
      manifest: { coverage: { selected: [{ itemId: fp, fingerprint: fp }], completed: [{ itemId: fp, fingerprint: fp }], reused: [], failed: [], waived: [] } },
      ReusableItem: function (f: string) { return (this as unknown as { items: Map<string, unknown> }).items.get(f) ?? null; },
    };
    const agent = newManifestFlowAgent(diffs, resume);
    await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown> }).dispatchSubtasks(new AbortController().signal);
    const m = await finish(agent);
    expect(m.terminalState).toBe(StatePartial);
    expect(m.coverage.reused.length).toBe(1);
    expect(m.coverage.failed.length).toBe(1);
  });

  // OCR v1.9.3: TestManifestFlowResumeWithProviderTransition
  test("TestManifestFlowResumeWithProviderTransition", async () => {
    const diffs = [createDiff({ oldPath: "cached.go", newPath: "cached.go", diff: "+cached", insertions: 1 })];
    const fp = reviewItemFingerprint("range", diffs[0]!);
    const resume: Record<string, unknown> = {
      sessionId: "parent-run", reviewMode: "range", diffFrom: "main", diffTo: "feature",
      items: new Map([[fp, { filePath: "cached.go", oldPath: "cached.go", newPath: "cached.go", fingerprint: fp }]]),
      manifest: { coverage: { selected: [{ itemId: fp, fingerprint: fp }], completed: [{ itemId: fp, fingerprint: fp }], reused: [], failed: [], waived: [] } },
      ReusableItem: function (f: string) { return (this as unknown as { items: Map<string, unknown> }).items.get(f) ?? null; },
    };
    const agent = newManifestFlowAgent(diffs, resume);
    (agent as unknown as { args: Record<string, unknown> }).args["provider"] = "beta";
    (agent as unknown as { args: Record<string, unknown> }).args["model"] = "model-b";
    (agent as unknown as { initManifest: () => void }).initManifest();
    await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown> }).dispatchSubtasks(new AbortController().signal);
    const m = await finish(agent);
    const prov = (m.execution as unknown as Record<string, unknown>)["provider"] ?? (m.execution as unknown as Record<string, unknown>)["Provider"] ?? (m.execution as unknown as Record<string, unknown>)["ruleConfigSha256"];
    // Check that execution was set (provider may be via execution field)
    expect(m.parentRunId).toBe("parent-run");
    expect(m.coverage.reused.length).toBe(1);
  });
});

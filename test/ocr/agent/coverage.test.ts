// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/agent/coverage_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// localPath test/ocr/agent/coverage.test.ts -> internal/agent/coverage_test.go

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, errMainTaskEmpty, classifyItemError, NewCommentWorkerPool } from "../../../src/ocr/agent/agent.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";
import { SessionHistory } from "../../../src/ocr/session/history.js";
import type { Template } from "../../../src/ocr/template/template.js";
import { DiffMap, FileReadDiffProvider } from "../../../src/ocr/tool/filereader.js";
import { loadDefaultSystemRule } from "../../../src/ocr/rules/system_rules.js";
import { FailureTimeout, FailureCancelled, FailureConfiguration, FailureProvider, FailureBudget } from "../../../src/ocr/session/manifest.js";

type FakeResponse = {
  Choices: Array<{ Message: { Content: string | null; ToolCalls?: Array<{ ID: string; Type: string; Function: { Name: string; Arguments: string } }> } }>;
  Usage?: { PromptTokens?: number; CompletionTokens?: number; TotalTokens?: number };
};

class FakeAgentClient {
  public calls = 0;
  constructor(private readonly responses: FakeResponse[] | null) {}
  async CompletionsWithCtx(_ctx: unknown, _req: unknown): Promise<FakeResponse> {
    if (this.responses === null || this.calls >= this.responses.length) {
      const content = "";
      return { Choices: [{ Message: { Content: content } }], Usage: { PromptTokens: 0, CompletionTokens: 0 } };
    }
    const r = this.responses[this.calls]!;
    this.calls++;
    return r;
  }
  async complete(signal: AbortSignal, req: unknown): Promise<FakeResponse> {
    return this.CompletionsWithCtx(signal, req);
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-coverage-"));
}

function makeTemplate(overrides: Partial<Template> = {}): Template {
  const base: Template = {
    MaxTokens: 10000,
    MaxToolRequestTimes: 5,
    MainTask: { messages: [{ role: "user", content: "test" }] },
    MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
    PlanModeLineThreshold: 0,
  } as unknown as Template;
  return { ...base, ...overrides } as unknown as Template;
}

function chatResponse(content: string, usage?: { PromptTokens: number; CompletionTokens: number }): FakeResponse {
  return { Choices: [{ Message: { Content: content } }], Usage: usage };
}

function toolCallResponse(content: string, toolCalls: Array<{ ID: string; Type: string; Function: { Name: string; Arguments: string } }>, usage?: { PromptTokens: number; CompletionTokens: number }): FakeResponse {
  return { Choices: [{ Message: { Content: content, ToolCalls: toolCalls } }], Usage: usage };
}

describe("ocr agent coverage (ported)", () => {
  // OCR v1.9.3: TestAgent_Getters
  test("TestAgent_Getters", () => {
    const tmpDir = makeTempDir();
    const sess = new SessionHistory(tmpDir, "main", "test-model", { reviewMode: "diff" });
    const collector = new CommentCollector();
    const client = new FakeAgentClient([]);
    const agent = new Agent({
      repoDir: tmpDir,
      model: "test-model",
      llmClient: client as unknown as never,
      commentCollector: collector as unknown as never,
      Session: sess as unknown as never,
      template: {
        MaxTokens: 10000,
        MaxToolRequestTimes: 10,
        MainTask: { messages: [{ role: "user", content: "test" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
      } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [
      { newPath: "a.go", oldPath: "a.go", diff: "+code", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 },
      { newPath: "b.go", oldPath: "b.go", diff: "+more", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 },
    ] as unknown as Diff[];
    expect(agent.Session()).toBe(sess);
    expect(agent.FilesReviewed()).toBe(2);
    expect(agent.Diffs().length).toBe(2);
    expect(agent.ProjectSummary()).toBe("");
    expect(agent.TotalTokensUsed()).toBe(0);
    expect(agent.TotalCacheReadTokens()).toBe(0);
    expect(agent.TotalCacheWriteTokens()).toBe(0);
    expect(agent.Warnings().length).toBe(0);
    expect(Object.keys(agent.ToolCalls()).length).toBe(0);
  });

  // OCR v1.9.3: TestAgentFilesReviewedCountsDispatchableDiffs
  test("TestAgentFilesReviewedCountsDispatchableDiffs", () => {
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      template: makeTemplate(),
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [
      { newPath: "kept.go", oldPath: "kept.go", diff: "+kept", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 },
      { newPath: "removed.go", oldPath: "removed.go", diff: "-removed", newFileContent: "", isBinary: false, isDeleted: true, isNew: false, isRenamed: false, insertions: 0, deletions: 1 },
      { newPath: "also-kept.go", oldPath: "also-kept.go", diff: "+more", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 },
    ] as unknown as Diff[];
    expect(agent.FilesReviewed()).toBe(2);
    expect(agent.Diffs().length).toBe(3);
  });

  // OCR v1.9.3: TestAgent_RecordWarning
  test("TestAgent_RecordWarning", () => {
    const tmpDir = makeTempDir();
    const sess = new SessionHistory(tmpDir, "main", "test-model", { reviewMode: "diff" });
    const agent = new Agent({
      repoDir: tmpDir,
      model: "test-model",
      llmClient: new FakeAgentClient([]) as unknown as never,
      Session: sess as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { recordWarning: (t: string, f: string, m: string) => void }).recordWarning("error", "main.go", "something");
    const warnings = agent.Warnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.type).toBe("error");
    expect(warnings[0]?.file).toBe("main.go");
  });

  // OCR v1.9.3: TestNewCommentWorkerPool
  test("TestNewCommentWorkerPool", () => {
    const pool = NewCommentWorkerPool(2);
    expect(pool).not.toBeNull();
    expect(pool).not.toBeUndefined();
  });

  // OCR v1.9.3: TestInjectDiffMap
  test("TestInjectDiffMap", async () => {
    const emptyDM = new DiffMap(new Map());
    const frd = new FileReadDiffProvider(emptyDM);
    const reg: Record<string, unknown> = {
      get: (name: string) => (name === "file_read_diff" ? frd : undefined),
      Get: function (name: string) { return (this as unknown as { get: (n: string) => unknown }).get(name); },
      freeze: () => {},
    };
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      tools: reg as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [
      { newPath: "main.go", oldPath: "main.go", diff: "+new code", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 },
      { newPath: "/dev/null", oldPath: "deleted.go", diff: "-deleted", newFileContent: "", isBinary: false, isDeleted: true, isNew: false, isRenamed: false, insertions: 0, deletions: 1 },
    ] as unknown as Diff[];
    await (agent as unknown as { injectDiffMap: () => void }).injectDiffMap();
    const result = await frd.Execute({}, { path_array: ["main.go"] });
    expect(result).toContain("+new code");
    const result2 = await frd.Execute({}, { path_array: ["deleted.go"] });
    expect(result2).toContain("not found");
  });

  // OCR v1.9.3: TestFilterDiffs
  test("TestFilterDiffs", () => {
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      fileFilter: { Include: [], Exclude: ["vendor/**"] } as unknown as never,
      template: makeTemplate(),
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [
      { newPath: "main.go", oldPath: "main.go", diff: "", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 },
      { newPath: "vendor/dep.go", oldPath: "vendor/dep.go", diff: "", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 },
      { newPath: "image.png", oldPath: "image.png", diff: "", newFileContent: "", isBinary: true, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 },
      { newPath: "handler.go", oldPath: "handler.go", diff: "", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 },
    ] as unknown as Diff[];
    const diffs = (agent as unknown as { diffs: Diff[] }).diffs;
    const kept = (agent as unknown as { filterDiffs: (d: Diff[]) => Diff[] }).filterDiffs(diffs);
    const names = new Set(kept.map((d) => d.newPath));
    expect(names.has("vendor/dep.go")).toBe(false);
    expect(names.has("image.png")).toBe(false);
    expect(names.has("main.go")).toBe(true);
    expect(names.has("handler.go")).toBe(true);
  });

  // OCR v1.9.3: TestResolveSystemRule
  test("TestResolveSystemRule", () => {
    const a1 = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      systemRule: null as unknown as never,
      template: makeTemplate(),
      mainToolDefs: [],
    } as unknown as never);
    const got1 = (a1 as unknown as { resolveSystemRule: (p: string) => string }).resolveSystemRule("main.go");
    expect(got1).toBe("");
    const rule = (() => {
      try { return loadDefaultSystemRule(); } catch { return null; }
    })();
    if (rule === null) return;
    const resolver = {
      resolve: (p: string): string => {
        const mod = require("../../../src/ocr/rules/system_rules.js") as typeof import("../../../src/ocr/rules/system_rules.js");
        return (mod.resolveSystemRule as (a: unknown, b: string) => string)(rule, p);
      },
    };
    const a2 = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      systemRule: resolver as unknown as never,
      template: makeTemplate(),
      mainToolDefs: [],
    } as unknown as never);
    const got2 = (a2 as unknown as { resolveSystemRule: (p: string) => string }).resolveSystemRule("main.go");
    expect(got2 !== "").toBe(true);
  });

  // OCR v1.9.3: TestFindDiff
  test("TestFindDiff", () => {
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      template: makeTemplate(),
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [
      { newPath: "a.go", oldPath: "a.go", diff: "+a", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 },
      { newPath: "b.go", oldPath: "old_b.go", diff: "+b", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 },
    ] as unknown as Diff[];
    const d1 = (agent as unknown as { findDiff: (p: string) => Diff | null }).findDiff("a.go");
    expect(d1?.newPath).toBe("a.go");
    const d2 = (agent as unknown as { findDiff: (p: string) => Diff | null }).findDiff("old_b.go");
    expect(d2?.newPath).toBe("b.go");
    const d3 = (agent as unknown as { findDiff: (p: string) => Diff | null }).findDiff("nonexist.go");
    expect(d3).toBeNull();
  });

  // OCR v1.9.3: TestExecuteReviewFilter_NoFilterTask
  test("TestExecuteReviewFilter_NoFilterTask", async () => {
    const client = new FakeAgentClient([]);
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: client as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: null } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+code", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
    expect(client.calls).toBe(0);
  });

  // OCR v1.9.3: TestExecuteReviewFilter_NoComments
  test("TestExecuteReviewFilter_NoComments", async () => {
    const client = new FakeAgentClient([]);
    const collector = new CommentCollector();
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: client as unknown as never,
      commentCollector: collector as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: { messages: [{ role: "user", content: "Filter {{comments}} for {{path}} in {{diff}}" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+x", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
    expect(client.calls).toBe(0);
  });

  // OCR v1.9.3: TestExecuteReviewFilter_RemovesComments
  test("TestExecuteReviewFilter_RemovesComments", async () => {
    const collector = new CommentCollector();
    collector.Add({ path: "a.go", content: "keep this" });
    collector.Add({ path: "a.go", content: "remove this" });
    collector.Add({ path: "a.go", content: "also keep" });
    const client = new FakeAgentClient([chatResponse(JSON.stringify(["c-1"]), { PromptTokens: 10, CompletionTokens: 5 })]);
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: client as unknown as never,
      commentCollector: collector as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: { messages: [{ role: "user", content: "Filter: {{comments}} path={{path}} diff={{diff}}" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+code", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
    const comments = collector.CommentsForPath("a.go");
    expect(comments.length).toBe(2);
    expect(comments.some((c) => c.content === "remove this")).toBe(false);
  });

  // OCR v1.9.3: TestExecuteReviewFilter_LLMError
  test("TestExecuteReviewFilter_LLMError", async () => {
    const collector = new CommentCollector();
    collector.Add({ path: "a.go", content: "comment" });
    const failingClient: Record<string, unknown> = {
      CompletionsWithCtx: async () => { throw new Error("network"); },
      complete: async () => { throw new Error("network"); },
    };
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: failingClient as unknown as never,
      commentCollector: collector as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: { messages: [{ role: "user", content: "{{comments}} {{path}} {{diff}}" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+x", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
    expect(collector.CommentsForPath("a.go").length).toBe(1);
  });

  // OCR v1.9.3: TestExecuteReviewFilter_SkipFilter
  test("TestExecuteReviewFilter_SkipFilter", async () => {
    {
      const collector = new CommentCollector();
      collector.Add({ path: "a.go", content: "comment" });
      const client = new FakeAgentClient([chatResponse(JSON.stringify(["c-0"]))]);
      const agent = new Agent({
        repoDir: makeTempDir(),
        model: "test",
        llmClient: client as unknown as never,
        commentCollector: collector as unknown as never,
        skipFilter: true,
        template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: { messages: [{ role: "user", content: "Filter: {{comments}}" }] } } as unknown as Template,
        mainToolDefs: [],
      } as unknown as never);
      await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+code", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
      expect(client.calls).toBe(0);
      expect(collector.CommentsForPath("a.go").length).toBe(1);
    }
    {
      const collector = new CommentCollector();
      collector.Add({ path: "a.go", content: "comment 1" });
      collector.Add({ path: "a.go", content: "comment 2" });
      collector.Add({ path: "a.go", content: "comment 3" });
      const client = new FakeAgentClient([]);
      const agent = new Agent({
        repoDir: makeTempDir(),
        model: "test",
        llmClient: client as unknown as never,
        commentCollector: collector as unknown as never,
        skipFilter: true,
        template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: { messages: [{ role: "user", content: "Filter: {{comments}}" }] } } as unknown as Template,
        mainToolDefs: [],
      } as unknown as never);
      await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+code", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
      expect(collector.CommentsForPath("a.go").length).toBe(3);
    }
    {
      const collector = new CommentCollector();
      collector.Add({ path: "a.go", content: "keep this" });
      collector.Add({ path: "a.go", content: "remove this" });
      const client = new FakeAgentClient([chatResponse(JSON.stringify(["c-1"]), { PromptTokens: 10, CompletionTokens: 5 })]);
      const agent = new Agent({
        repoDir: makeTempDir(),
        model: "test",
        llmClient: client as unknown as never,
        commentCollector: collector as unknown as never,
        template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: { messages: [{ role: "user", content: "Filter: {{comments}} path={{path}} diff={{diff}}" }] } } as unknown as Template,
        mainToolDefs: [],
      } as unknown as never);
      await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+code", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
      expect(client.calls).toBe(1);
      expect(collector.CommentsForPath("a.go").length).toBe(1);
    }
    {
      const collector = new CommentCollector();
      collector.Add({ path: "a.go", content: "comment" });
      const client = new FakeAgentClient([]);
      const agent = new Agent({
        repoDir: makeTempDir(),
        model: "test",
        llmClient: client as unknown as never,
        commentCollector: collector as unknown as never,
        skipFilter: true,
        template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: { messages: [{ role: "user", content: "Filter: {{comments}}" }] } } as unknown as Template,
        mainToolDefs: [],
      } as unknown as never);
      await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+x", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
      expect(client.calls).toBe(0);
      expect(collector.CommentsForPath("a.go").length).toBe(1);
    }
    {
      const client = new FakeAgentClient([]);
      const agent = new Agent({
        repoDir: makeTempDir(),
        model: "test",
        llmClient: client as unknown as never,
        skipFilter: true,
        template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: { messages: [{ role: "user", content: "Filter: {{comments}}" }] } } as unknown as Template,
        mainToolDefs: [],
      } as unknown as never);
      await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+x", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
      expect(client.calls).toBe(0);
    }
  });

  // OCR v1.9.3: TestExecutePlanPhase
  test("TestExecutePlanPhase", async () => {
    const client = new FakeAgentClient([chatResponse("review plan output", { PromptTokens: 20, CompletionTokens: 10 })]);
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: client as unknown as never,
      background: "test background",
      template: {
        MaxTokens: 10000,
        MaxToolRequestTimes: 5,
        MainTask: { messages: [{ role: "user", content: "t" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
        PlanTask: { messages: [{ role: "system", content: "You are a planner. Date: {{current_system_date_time}}" }, { role: "user", content: "Plan review for {{current_file_path}}. Rule: {{system_rule}}. Changes: {{change_files}}. Diff: {{diff}}. Background: {{requirement_background}}. Tools: {{plan_tools}}" }] },
      } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    const result = await (agent as unknown as { executePlanPhase: (s: AbortSignal, a: string, b: string, c: string, d: string) => Promise<string> }).executePlanPhase(new AbortController().signal, "main.go", "+new code", "helper.go", "check for bugs");
    expect(result).toBe("review plan output");
    expect(agent.TotalInputTokens()).toBe(20);
  });

  // OCR v1.9.3: TestExecutePlanPhase_LLMError
  test("TestExecutePlanPhase_LLMError", async () => {
    const client = new FakeAgentClient(null);
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: client as unknown as never,
      template: {
        MaxTokens: 10000,
        MaxToolRequestTimes: 5,
        MainTask: { messages: [{ role: "user", content: "t" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
        PlanTask: { messages: [{ role: "user", content: "{{diff}}" }] },
      } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    const result = await (agent as unknown as { executePlanPhase: (s: AbortSignal, a: string, b: string, c: string, d: string) => Promise<string> }).executePlanPhase(new AbortController().signal, "a.go", "+x", "", "");
    expect(typeof result).toBe("string");
  });

  // OCR v1.9.3: TestExecuteSubtask_EmptyMainTask
  test("TestExecuteSubtask_EmptyMainTask", async () => {
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    const res = await (agent as unknown as { executeSubtask: (s: AbortSignal, d: Diff) => Promise<{ completed: boolean; stop?: unknown; error: Error | null }> }).executeSubtask(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+x", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 } as unknown as Diff);
    expect(res.error).not.toBeNull();
    expect(res.completed).toBe(false);
    expect(res.stop).toBeUndefined();
    expect(res.error?.message).toContain("main_task.messages is empty");
  });

  // OCR v1.9.3: TestExecuteSubtask_TokenThresholdExceeded
  test("TestExecuteSubtask_TokenThresholdExceeded", async () => {
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      template: { MaxTokens: 10, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "Review: {{diff}}" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    (agent as unknown as { diffs: Diff[] }).diffs = [{ newPath: "a.go", oldPath: "a.go", diff: "code ".repeat(200), newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 100, deletions: 0 } as unknown as Diff];
    const diff = (agent as unknown as { diffs: Diff[] }).diffs[0]!;
    const res = await (agent as unknown as { executeSubtask: (s: AbortSignal, d: Diff) => Promise<{ completed: boolean; stop?: { class: string; checkpoint: string }; error: Error | null }> }).executeSubtask(new AbortController().signal, diff);
    expect(res.error).toBeNull();
    expect(res.completed).toBe(false);
    expect(res.stop).toBeDefined();
    expect((res.stop as unknown as { class: string }).class).toBe(FailureBudget);
    expect((res.stop as unknown as { checkpoint: string }).checkpoint !== "").toBe(true);
    const warnings = agent.Warnings();
    expect(warnings.some((w) => w.type === "token_threshold_exceeded")).toBe(true);
  });

  // OCR v1.9.3: TestExecuteSubtask_WithPlanPhase
  test("TestExecuteSubtask_WithPlanPhase", async () => {
    const planText = "my plan";
    const doneContent = "";
    const client = new FakeAgentClient([
      chatResponse(planText, { PromptTokens: 5, CompletionTokens: 3 }),
      toolCallResponse(doneContent, [{ ID: "c1", Type: "function", Function: { Name: "task_done", Arguments: "{}" } }], { PromptTokens: 10, CompletionTokens: 5 }),
    ]);
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: client as unknown as never,
      template: {
        MaxTokens: 100000,
        MaxToolRequestTimes: 10,
        PlanModeLineThreshold: 0,
        PlanTask: { messages: [{ role: "user", content: "Plan for {{current_file_path}}: {{diff}}" }] },
        MainTask: { messages: [{ role: "user", content: "Review {{current_file_path}} with plan {{plan_guidance}}: {{diff}}" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
      } as unknown as Template,
      mainToolDefs: [{ type: "function", function: { name: "task_done", description: "done", parameters: {} } }] as unknown as never,
    } as unknown as never);
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    (agent as unknown as { diffs: Diff[] }).diffs = [{ newPath: "main.go", oldPath: "main.go", diff: "+new code", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 5, deletions: 0 } as unknown as Diff];
    const runner = (agent as unknown as { runner: { RunPerFile: (s: AbortSignal, m: unknown, p: string) => Promise<{ completed: boolean; stop: number }> } }).runner;
    const orig = runner.RunPerFile.bind(runner);
    runner.RunPerFile = async () => ({ completed: true, stop: 0 });
    const diff = (agent as unknown as { diffs: Diff[] }).diffs[0]!;
    const res = await (agent as unknown as { executeSubtask: (s: AbortSignal, d: Diff) => Promise<{ completed: boolean; stop?: unknown; error: Error | null }> }).executeSubtask(new AbortController().signal, diff);
    runner.RunPerFile = orig;
    expect(res.error).toBeNull();
    expect(res.completed).toBe(true);
    expect(res.stop).toBeUndefined();
  });

  // OCR v1.9.3: TestExecuteSubtask_ContextCancelled
  test("TestExecuteSubtask_ContextCancelled", async () => {
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "{{diff}}" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    const ctrl = new AbortController();
    ctrl.abort(new Error("context canceled"));
    const res = await (agent as unknown as { executeSubtask: (s: AbortSignal, d: Diff) => Promise<{ completed: boolean; stop?: unknown; error: Error | null }> }).executeSubtask(ctrl.signal, { newPath: "a.go", oldPath: "a.go", diff: "+x", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 } as unknown as Diff);
    expect(res.error).not.toBeNull();
    expect(res.completed).toBe(false);
    expect(res.stop).toBeUndefined();
  });

  // OCR v1.9.3: TestExecuteReviewFilter_WithTimeout
  test("TestExecuteReviewFilter_WithTimeout", async () => {
    const collector = new CommentCollector();
    collector.Add({ path: "a.go", content: "comment" });
    const client = new FakeAgentClient([chatResponse(JSON.stringify([]), { PromptTokens: 5, CompletionTokens: 2 })]);
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: client as unknown as never,
      commentCollector: collector as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] }, ReviewFilterTask: { messages: [{ role: "user", content: "{{comments}} {{path}} {{diff}}" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: Diff, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", oldPath: "a.go", diff: "+x", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 0, deletions: 0 } as unknown as Diff, "a.go");
    expect(collector.CommentsForPath("a.go").length).toBe(1);
  });

  // OCR v1.9.3: TestDispatchSubtasks_AllFilteredBySize
  test("TestDispatchSubtasks_AllFilteredBySize", async () => {
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      template: { MaxTokens: 10, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "{{diff}}" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [{ newPath: "big.go", oldPath: "big.go", diff: "word ".repeat(500), newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 100, deletions: 0 } as unknown as Diff];
    const comments = await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    expect(comments.length).toBe(0);
  });

  // OCR v1.9.3: TestDispatchSubtasks_AllFailed
  test("TestDispatchSubtasks_AllFailed", async () => {
    const agent = new Agent({
      repoDir: makeTempDir(),
      model: "test",
      llmClient: new FakeAgentClient([]) as unknown as never,
      template: { MaxTokens: 100000, MaxToolRequestTimes: 5, MainTask: { messages: [] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [{ newPath: "a.go", oldPath: "a.go", diff: "+x", newFileContent: "", isBinary: false, isDeleted: false, isNew: false, isRenamed: false, insertions: 1, deletions: 0 } as unknown as Diff];
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26";
    let didThrow = false;
    let errMsg = "";
    try {
      await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    } catch (e) {
      didThrow = true;
      errMsg = (e as Error).message;
    }
    expect(didThrow).toBe(true);
    expect(errMsg).toContain("failed");
  });

  // OCR v1.9.3: TestClassifyItemError
  test("TestClassifyItemError", () => {
    const secret = "token=sk-LEAKED-SECRET absolute /home/alice/x";
    type Case = { name: string; err: unknown; wantClass: typeof FailureTimeout };
    const cases: Case[] = [
      { name: "deadline", err: new Error("context deadline exceeded"), wantClass: FailureTimeout },
      { name: "deadline_wrapped", err: new Error(`review ${secret}: context deadline exceeded`, { cause: new Error("context deadline exceeded") }), wantClass: FailureTimeout },
      { name: "cancelled", err: new Error("context canceled"), wantClass: FailureCancelled },
      { name: "cancelled_wrapped", err: new Error(`aborted ${secret}: context canceled`, { cause: new Error("context canceled") }), wantClass: FailureCancelled },
      { name: "main_task_empty", err: errMainTaskEmpty, wantClass: FailureConfiguration },
      { name: "main_task_empty_wrapped", err: new Error(`subtask ${secret}: ${errMainTaskEmpty.message}`, { cause: errMainTaskEmpty }), wantClass: FailureConfiguration },
      { name: "default_provider", err: new Error(secret), wantClass: FailureProvider },
    ] as unknown as Case[];
    for (const tc of cases) {
      const [cls, reason] = classifyItemError(tc.err);
      expect(cls).toBe(tc.wantClass);
      expect(reason !== "").toBe(true);
      expect(reason.includes("sk-LEAKED-SECRET")).toBe(false);
      expect(reason.includes("/home/alice")).toBe(false);
    }
  });
});

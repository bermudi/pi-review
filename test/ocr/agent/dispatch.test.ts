// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/agent_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Covers dispatch orchestration: WithFakeLLM, AllDeleted, TokenAccumulation, IncompleteMainTask etc.

import { describe, test, expect } from "bun:test";
import { Agent, reviewItemFingerprint } from "../../../src/ocr/agent/agent.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import { createDiff } from "../../../src/ocr/model/diff.js";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";
import { SessionHistory } from "../../../src/ocr/session/history.js";
import type { Template } from "../../../src/ocr/template/template.js";
import { FailureBudget } from "../../../src/ocr/session/manifest.js";

type FakeResponse = {
  content?: string;
  Content?: string;
  toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  ToolCalls?: Array<{ ID: string; Type: string; Function: { Name: string; Arguments: string } }>;
  usage?: { PromptTokens?: number; CompletionTokens?: number; TotalTokens?: number; promptTokens?: number; completionTokens?: number };
  Usage?: { PromptTokens?: number; CompletionTokens?: number };
};

class FakeAgentClient {
  calls = 0;
  constructor(private readonly responses: FakeResponse[] | null) {}
  async CompletionsWithCtx(_sig: unknown, _req: unknown): Promise<FakeResponse> {
    if (this.responses === null || this.calls >= this.responses.length) {
      return { content: "", toolCalls: [], usage: { PromptTokens: 0, CompletionTokens: 0 } } as unknown as FakeResponse;
    }
    const r = this.responses[this.calls]!;
    this.calls++;
    // Normalize to shape Runner expects: content + toolCalls
    const content = (r as unknown as { content?: string; Content?: string }).content ?? (r as unknown as { Content?: string }).Content ?? "";
    // Try to support both casings for toolCalls
    const rawCalls = (r as unknown as { toolCalls?: unknown; ToolCalls?: unknown }).toolCalls ?? (r as unknown as { ToolCalls?: unknown }).ToolCalls;
    let toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
    if (Array.isArray(rawCalls)) {
      toolCalls = (rawCalls as Array<Record<string, unknown>>).map((tc) => {
        const id = (tc["id"] ?? tc["ID"] ?? "") as string;
        const type = (tc["type"] ?? tc["Type"] ?? "function") as string;
        const fn = (tc["function"] ?? tc["Function"] ?? {}) as Record<string, unknown>;
        const name = (fn["name"] ?? fn["Name"] ?? "") as string;
        const args = (fn["arguments"] ?? fn["Arguments"] ?? "{}") as string;
        return { id, type, function: { name, arguments: args } };
      });
    }
    const usage = (r as unknown as { usage?: unknown; Usage?: unknown }).usage ?? (r as unknown as { Usage?: unknown }).Usage;
    return { content, toolCalls, usage } as unknown as FakeResponse;
  }
  async complete(sig: AbortSignal, req: unknown): Promise<FakeResponse> {
    return this.CompletionsWithCtx(sig, req);
  }
}

function agentTaskDoneResponse(): FakeResponse {
  return {
    content: "",
    toolCalls: [{ id: "call_done", type: "function", function: { name: "task_done", arguments: "{}" } }],
    usage: { PromptTokens: 10, CompletionTokens: 5 },
  } as unknown as FakeResponse;
}

function codeCommentResponse(path: string): FakeResponse {
  const args = JSON.stringify({ path, comments: [{ content: "potential null pointer", existing_code: "foo := bar.Baz()" }] });
  return {
    content: "",
    toolCalls: [{ id: "call_comment", type: "function", function: { name: "code_comment", arguments: args } }],
    usage: { PromptTokens: 50, CompletionTokens: 20 },
  } as unknown as FakeResponse;
}

describe("ocr agent dispatch (ported from internal/agent/agent_test.go)", () => {
  // OCR v1.9.3: TestDispatchSubtasks_WithFakeLLM
  test("TestDispatchSubtasks_WithFakeLLM", async () => {
    const client = new FakeAgentClient([codeCommentResponse("main.go"), agentTaskDoneResponse()]);
    const collector = new CommentCollector();
    // Need tool registry for code_comment
    const registry: Record<string, unknown> = {
      get: (name: string) => {
        if (name === "code_comment") {
          return {
            name: "code_comment",
            execute: async (args: Record<string, unknown>) => {
              const path = args["path"] as string;
              const comments = args["comments"] as Array<Record<string, unknown>>;
              for (const c of comments) {
                collector.Add({ path, content: c["content"] as string, existingCode: c["existing_code"] as string });
              }
              return "Successfully commented.";
            },
          };
        }
        if (name === "task_done") {
          return { name: "task_done", execute: async () => "" };
        }
        return undefined;
      },
      freeze: () => {},
    };
    const agent = new Agent({
      repoDir: "/tmp",
      llmClient: client as unknown as never,
      model: "fake",
      commentCollector: collector as unknown as never,
      tools: registry as unknown as never,
      template: {
        MaxTokens: 100000,
        MaxToolRequestTimes: 10,
        MainTask: { messages: [{ role: "user", content: "Review {{diff}} for {{current_file_path}}" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
      } as unknown as Template,
      mainToolDefs: [
        { type: "function", function: { name: "task_done", description: "done" } },
        { type: "function", function: { name: "code_comment", description: "comment" } },
      ] as unknown as never,
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [createDiff({ newPath: "main.go", oldPath: "main.go", diff: "+new line", insertions: 1 })];
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    const comments = await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    expect(comments.length).toBe(1);
    expect((comments[0] as unknown as { path: string }).path).toBe("main.go");
    expect((comments[0] as unknown as { content: string }).content.includes("null pointer")).toBe(true);
  });

  // OCR v1.9.3: TestDispatchSubtasks_AllDeleted
  test("TestDispatchSubtasks_AllDeleted", async () => {
    const client = new FakeAgentClient([]);
    const agent = new Agent({
      repoDir: "/tmp",
      llmClient: client as unknown as never,
      model: "fake",
      template: {
        MaxTokens: 100000,
        MaxToolRequestTimes: 5,
        MainTask: { messages: [{ role: "user", content: "Review {{diff}}" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
      } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [createDiff({ newPath: "removed.go", isDeleted: true })];
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    const comments = await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    expect(comments.length).toBe(0);
    expect(client.calls).toBe(0);
  });

  // OCR v1.9.3: TestAgent_TokenAccumulation
  test("TestAgent_TokenAccumulation", async () => {
    const client = new FakeAgentClient([agentTaskDoneResponse()]);
    const agent = new Agent({
      repoDir: "/tmp",
      llmClient: client as unknown as never,
      model: "fake",
      template: {
        MaxTokens: 100000,
        MaxToolRequestTimes: 10,
        MainTask: { messages: [{ role: "user", content: "Review {{diff}}" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
      } as unknown as Template,
      mainToolDefs: [{ type: "function", function: { name: "task_done", description: "done" } }] as unknown as never,
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [createDiff({ newPath: "a.go", diff: "+x", insertions: 1 })];
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    expect((agent as unknown as { TotalInputTokens: () => number }).TotalInputTokens()).toBe(10);
    expect((agent as unknown as { TotalOutputTokens: () => number }).TotalOutputTokens()).toBe(5);
  });

  // OCR v1.9.3: TestDispatchSubtasks_IncompleteMainTaskMarksPartialFailure
  test("TestDispatchSubtasks_IncompleteMainTaskMarksPartialFailure", async () => {
    const emptyContent = "";
    const client = new FakeAgentClient([
      agentTaskDoneResponse(),
      { content: emptyContent, toolCalls: [], usage: { PromptTokens: 10, CompletionTokens: 1 } } as unknown as FakeResponse,
    ]);
    const agent = new Agent({
      repoDir: "/tmp",
      llmClient: client as unknown as never,
      model: "fake",
      maxConcurrency: 1,
      template: {
        MaxTokens: 100000,
        MaxToolRequestTimes: 1,
        MainTask: { messages: [{ role: "user", content: "Review {{diff}}" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
      } as unknown as Template,
      mainToolDefs: [{ type: "function", function: { name: "task_done", description: "done" } }] as unknown as never,
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = [
      createDiff({ newPath: "complete.go", oldPath: "complete.go", diff: "+x", insertions: 1 }),
      createDiff({ newPath: "incomplete.go", oldPath: "incomplete.go", diff: "+y", insertions: 1 }),
    ];
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    const err = await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal).then(() => null).catch((e) => e as Error);
    expect(err).toBeNull();
    const warnings = (agent as unknown as { Warnings: () => Array<{ type: string; file: string }> }).Warnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.type).toBe("subtask_error");
    expect(warnings[0]!.file).toBe("incomplete.go");
  });

  // OCR v1.9.3: TestDispatchSubtasks_TokenThresholdSkipIsNotReusableCheckpoint
  test("TestDispatchSubtasks_TokenThresholdSkipIsNotReusableCheckpoint", async () => {
    const repoDir = `/tmp/pi-agent-threshold-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sess = new SessionHistory(repoDir, "feature", "fake", { reviewMode: "range", diffFrom: "main", diffTo: "feature" });
    const client = new FakeAgentClient([agentTaskDoneResponse()]);
    const agent = new Agent({
      repoDir,
      from: "main",
      to: "feature",
      llmClient: client as unknown as never,
      model: "fake",
      Session: sess as unknown as never,
      template: {
        MaxTokens: 100,
        MaxToolRequestTimes: 5,
        MainTask: { messages: [{ role: "user", content: "x".repeat(800) + " {{diff}}" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
      } as unknown as Template,
      mainToolDefs: [{ type: "function", function: { name: "task_done", description: "done" } }] as unknown as never,
    } as unknown as never);
    const diff = createDiff({ newPath: "large-prompt.go", oldPath: "large-prompt.go", diff: "+x", insertions: 1 });
    (agent as unknown as { diffs: Diff[] }).diffs = [diff];
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    const comments = await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    expect(comments.length).toBe(0);
    expect(client.calls).toBe(0);
    // finalize and check manifest via in-memory
    (agent as unknown as { finalizeManifest: () => Error | null }).finalizeManifest();
    const manifest = (agent as unknown as { RunManifest: () => import("../../../src/ocr/session/manifest.js").RunManifest | null }).RunManifest();
    expect(manifest).not.toBeNull();
    expect(manifest!.coverage.completed.length).toBe(0);
    expect(manifest!.coverage.failed.length).toBe(1);
    expect(manifest!.coverage.failed[0]!.classification).toBe(FailureBudget);
    const fp = reviewItemFingerprint("range", diff);
    const has = manifest!.coverage.failed.some((c) => c.fingerprint === fp) || manifest!.coverage.completed.some((c) => c.fingerprint === fp);
    expect(has).toBe(true);
    // Should not be reusable: check that completed is 0
    expect(manifest!.coverage.completed.length).toBe(0);
  });

  // OCR v1.9.3: TestDispatchSubtasks_MainTaskWithoutTaskDoneIsNotReusableCheckpoint
  test("TestDispatchSubtasks_MainTaskWithoutTaskDoneIsNotReusableCheckpoint", async () => {
    const repoDir = `/tmp/pi-agent-notaskdone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sess = new SessionHistory(repoDir, "feature", "fake", { reviewMode: "range", diffFrom: "main", diffTo: "feature" });
    const emptyContent = "";
    const client = new FakeAgentClient([{ content: emptyContent, toolCalls: [], usage: { PromptTokens: 10, CompletionTokens: 1 } } as unknown as FakeResponse]);
    const agent = new Agent({
      repoDir,
      from: "main",
      to: "feature",
      llmClient: client as unknown as never,
      model: "fake",
      Session: sess as unknown as never,
      template: {
        MaxTokens: 100000,
        MaxToolRequestTimes: 1,
        MainTask: { messages: [{ role: "user", content: "Review {{diff}}" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
      } as unknown as Template,
      mainToolDefs: [{ type: "function", function: { name: "task_done", description: "done" } }] as unknown as never,
    } as unknown as never);
    const diff = createDiff({ newPath: "needs-review.go", oldPath: "needs-review.go", diff: "+x", insertions: 1 });
    (agent as unknown as { diffs: Diff[] }).diffs = [diff];
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    let didThrow = false;
    let errMsg = "";
    try {
      await (agent as unknown as { dispatchSubtasks: (s: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(new AbortController().signal);
    } catch (e) {
      didThrow = true;
      errMsg = (e as Error).message;
    }
    expect(didThrow).toBe(true);
    expect(errMsg.includes("failed")).toBe(true);
    expect(client.calls).toBe(1);
    const warnings = (agent as unknown as { Warnings: () => Array<{ type: string; file: string }> }).Warnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.type).toBe("subtask_error");
    (agent as unknown as { finalizeManifest: () => Error | null }).finalizeManifest();
    const manifest = (agent as unknown as { RunManifest: () => import("../../../src/ocr/session/manifest.js").RunManifest | null }).RunManifest();
    expect(manifest).not.toBeNull();
    expect(manifest!.coverage.completed.length).toBe(0);
    expect(manifest!.coverage.failed.length).toBe(1);
  });

  // OCR v1.9.3: TestApplyResumeReusesCompletedItemsAcrossModels
  test("TestApplyResumeReusesCompletedItemsAcrossModels", () => {
    const diffs: Diff[] = [
      createDiff({ oldPath: "a.go", newPath: "a.go", diff: "+a", insertions: 1 }),
      createDiff({ oldPath: "b.go", newPath: "b.go", diff: "+b", insertions: 1 }),
    ];
    const fp = reviewItemFingerprint("range", diffs[0]!);
    const resume: Record<string, unknown> = {
      sessionId: "old-session",
      model: "anthropic-model",
      reviewMode: "range",
      diffFrom: "main",
      diffTo: "feature",
      items: new Map<string, unknown>([
        [fp, { filePath: "a.go", oldPath: "a.go", newPath: "a.go", fingerprint: fp, comments: [{ path: "a.go", content: "cached comment" }] }],
      ]),
      manifest: {
        coverage: { selected: [{ itemId: fp, fingerprint: fp }], completed: [{ itemId: fp, fingerprint: fp }], reused: [], failed: [], waived: [] },
      },
      ReusableItem: function (f: string) {
        const map = (this as unknown as { items: Map<string, unknown> }).items;
        const v = map.get(f);
        if (v !== undefined) return v;
        return null;
      },
      Item: function (f: string) {
        const map = (this as unknown as { items: Map<string, unknown> }).items;
        return map.get(f) ?? null;
      },
    };
    // Need to add CompletedCount etc for compatibility
    (resume as unknown as { CompletedCount: () => number }).CompletedCount = () => 1;
    const collector = new CommentCollector();
    const sess = new SessionHistory("/tmp", "feature", "openai-model", { reviewMode: "range", diffFrom: "main", diffTo: "feature", resumedFrom: "old-session" });
    const agent = new Agent({
      from: "main",
      to: "feature",
      model: "openai-model",
      commentCollector: collector as unknown as never,
      resume: resume as unknown as never,
      Session: sess as unknown as never,
      repoDir: "/tmp",
      llmClient: { complete: async () => ({ content: "" }) } as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    // Set diffs for applyResume context
    (agent as unknown as { diffs: Diff[] }).diffs = diffs;
    const toDispatch = (agent as unknown as { applyResume: (d: Diff[]) => Diff[] }).applyResume(diffs);
    expect(toDispatch.length).toBe(1);
    expect(toDispatch[0]!.newPath).toBe("b.go");
    const comments = collector.Comments();
    expect(comments.length).toBe(1);
    expect(comments[0]!.content).toBe("cached comment");
    const info = (agent as unknown as { ResumeInfo: () => { reusedFiles: number; rerunFiles: number; previousModel: string; currentModel: string } | null }).ResumeInfo();
    expect(info).not.toBeNull();
    expect(info!.reusedFiles).toBe(1);
    expect(info!.rerunFiles).toBe(1);
    expect(info!.previousModel).toBe("anthropic-model");
    expect(info!.currentModel).toBe("openai-model");
  });
});

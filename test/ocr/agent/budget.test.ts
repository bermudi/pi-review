// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/agent/budget_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { describe, test, expect } from "bun:test";
import { Agent } from "../../../src/ocr/agent/agent.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import { createDiff } from "../../../src/ocr/model/diff.js";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";
import type { Template } from "../../../src/ocr/template/template.js";
import type { ChatRequest, ChatResponse } from "../../../src/ocr/llmloop/types.js";
import { StatePartial, StateFailed, StateComplete, FailureBudget } from "../../../src/ocr/session/manifest.js";

// ---------------------------------------------------------------------------
// Fake client — mirrors Go fakeBudgetAgentClient
// Returns task_done on every request with fixed token usage so each file
// completes in exactly one round and consumes predictable tokens.
// Mirrors scan/budget_test.go's fakeBudgetClient.
// ---------------------------------------------------------------------------

class FakeBudgetAgentClient {
  perCallTokens: number;
  calls = 0;
  constructor(perCallTokens: number) {
    this.perCallTokens = perCallTokens;
  }
  async CompletionsWithCtx(_signal: AbortSignal, _req: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    return {
      content: "",
      toolCalls: [
        {
          id: "1",
          type: "function",
          function: { name: "task_done", arguments: "{}" },
        },
      ],
      usage: {
        PromptTokens: this.perCallTokens,
        CompletionTokens: 0,
        CacheReadTokens: 0,
        CacheWriteTokens: 0,
        TotalTokens: this.perCallTokens,
      },
    } as unknown as ChatResponse;
  }
  async complete(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse> {
    return this.CompletionsWithCtx(signal, req);
  }
}

function budgetAgentTestTemplate(): Template {
  return {
    MaxTokens: 100000,
    MaxToolRequestTimes: 5,
    MaxCompletionTokens: 100000,
    MainTask: {
      messages: [
        { role: "system", content: "review" },
        { role: "user", content: "review {{diff}} for {{current_file_path}}" },
      ],
    },
    PlanTask: { messages: [] },
    MemoryCompressionTask: { messages: [] },
    ReLocationTask: null,
    ReviewFilterTask: null as unknown as Template["ReviewFilterTask"],
  } as unknown as Template;
}

function makeBudgetDiffs(n: number): Diff[] {
  const diffs: Diff[] = [];
  for (let i = 0; i < n; i++) {
    const name = `f${i}.go`;
    diffs.push(
      createDiff({
        oldPath: name,
        newPath: name,
        diff: "+package x\n",
        insertions: 1,
        deletions: 0,
        isBinary: false,
        isDeleted: false,
      }),
    );
  }
  return diffs;
}

function toolRegistryStub(): { get: (name: string) => undefined; freeze: () => void } {
  return {
    get: (_name: string) => undefined,
    freeze: () => {},
  };
}

describe("ocr Agent budget (ported from internal/agent/budget_test.go)", () => {
  // OCR v1.9.3: TestDispatchSubtasks_TokenBudgetStopsDispatch
  test("dispatch stops via token look-ahead with warning and partial manifest", async () => {
    const perCall = 50_000;
    const fake = new FakeBudgetAgentClient(perCall);
    const collector = new CommentCollector();
    const agent = new Agent({
      repoDir: "/tmp",
      llmClient: fake as unknown as never,
      model: "fake",
      commentCollector: collector as unknown as never,
      tools: toolRegistryStub() as unknown as never,
      maxConcurrency: 1,
      maxTokensBudget: 120_000,
      template: budgetAgentTestTemplate(),
      mainToolDefs: [{ type: "function", function: { name: "task_done", description: "done" } }] as unknown as never,
    } as unknown as never);
    // Directly seed diffs as Go test does: a.diffs = makeBudgetDiffs(10)
    (agent as unknown as { diffs: Diff[] }).diffs = makeBudgetDiffs(10);
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";
    // Freeze registry as Go test does
    // (stub already frozen)

    const comments = await (agent as unknown as { dispatchSubtasks: (sig: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(
      new AbortController().signal,
    );

    // Budget 120K, each file ~50K actual. Look-ahead adds per-file estimate so gate stops well before all 10 files.
    const calls = fake.calls;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(10);

    // A token_budget_reached warning must be recorded.
    const warnings = (agent as unknown as { Warnings: () => Array<{ type: string }> }).Warnings();
    const found = warnings.some((w) => w.type === "token_budget_reached");
    expect(found).toBe(true);

    // Budget exhaustion must signal out-of-band, not via an error.
    const exceeded = (agent as unknown as { BudgetExceeded: () => boolean }).BudgetExceeded();
    expect(exceeded).toBe(true);

    // Partial comments are returned as a non-nil slice.
    expect(comments).not.toBeNull();
    expect(Array.isArray(comments)).toBe(true);

    const err = (agent as unknown as { finalizeManifest: () => Error | null }).finalizeManifest();
    expect(err).toBeNull();
    const manifest = (agent as unknown as { RunManifest: () => import("../../../src/ocr/session/manifest.js").RunManifest | null }).RunManifest();
    // A budget stop that still covered files is a controlled truncation: coverage alone derives terminalState partial (not failed) and exit 0.
    expect(manifest).not.toBeNull();
    expect(manifest?.terminalState).toBe(StatePartial);
    // Must NOT claim the single run_failure slot
    expect(manifest?.runFailure).toBeNull();
    expect(manifest?.coverage.completed.length).toBe(calls);
    expect(manifest?.coverage.failed.length).toBe(10 - calls);
    for (const item of manifest?.coverage.failed ?? []) {
      expect(item.classification).toBe(FailureBudget);
    }
    // Incomplete work never becomes clean — partial is not complete
    expect(manifest?.terminalState).not.toBe(StateComplete);
  });

  // OCR v1.9.3: TestDispatchSubtasks_TokenBudgetBeforeFirstFileIsFailed
  test("budget before first file yields failed manifest with all budget failures", async () => {
    const fake = new FakeBudgetAgentClient(50_000);
    const collector = new CommentCollector();
    const agent = new Agent({
      repoDir: "/tmp",
      llmClient: fake as unknown as never,
      model: "fake",
      commentCollector: collector as unknown as never,
      tools: toolRegistryStub() as unknown as never,
      maxConcurrency: 1,
      maxTokensBudget: 1, // smaller than any single file's look-ahead estimate
      template: budgetAgentTestTemplate(),
      mainToolDefs: [{ type: "function", function: { name: "task_done", description: "done" } }] as unknown as never,
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = makeBudgetDiffs(3);
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";

    const comments = await (agent as unknown as { dispatchSubtasks: (sig: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(
      new AbortController().signal,
    );
    expect(comments).not.toBeNull();
    expect(Array.isArray(comments)).toBe(true);
    // Expect zero LLM calls
    expect(fake.calls).toBe(0);
    expect((agent as unknown as { BudgetExceeded: () => boolean }).BudgetExceeded()).toBe(true);

    const err = (agent as unknown as { finalizeManifest: () => Error | null }).finalizeManifest();
    expect(err).toBeNull();
    const manifest = (agent as unknown as { RunManifest: () => import("../../../src/ocr/session/manifest.js").RunManifest | null }).RunManifest();
    expect(manifest).not.toBeNull();
    expect(manifest?.terminalState).toBe(StateFailed);
    // Still no run_failure: exit code comes from coverage (all failed), not run-level failure classification.
    expect(manifest?.runFailure).toBeNull();
    expect(manifest?.coverage.completed.length).toBe(0);
    expect(manifest?.coverage.failed.length).toBe(3);
    for (const item of manifest?.coverage.failed ?? []) {
      expect(item.classification).toBe(FailureBudget);
      expect((item.reason ?? "").length).toBeGreaterThan(0);
    }
    expect(manifest?.terminalState).not.toBe(StateComplete);
    expect(manifest?.terminalState).not.toBe(StatePartial);
  });

  // OCR v1.9.3: TestDispatchSubtasks_UnlimitedBudget
  test("unlimited budget runs all files and does not set BudgetExceeded", async () => {
    const fake = new FakeBudgetAgentClient(50_000);
    const collector = new CommentCollector();
    const agent = new Agent({
      repoDir: "/tmp",
      llmClient: fake as unknown as never,
      model: "fake",
      commentCollector: collector as unknown as never,
      tools: toolRegistryStub() as unknown as never,
      maxConcurrency: 1,
      maxTokensBudget: 0, // unlimited
      template: budgetAgentTestTemplate(),
      mainToolDefs: [{ type: "function", function: { name: "task_done", description: "done" } }] as unknown as never,
    } as unknown as never);
    (agent as unknown as { diffs: Diff[] }).diffs = makeBudgetDiffs(5);
    (agent as unknown as { currentDate: string }).currentDate = "2025-06-26 10:00";

    const result = await (agent as unknown as { dispatchSubtasks: (sig: AbortSignal) => Promise<unknown[]> }).dispatchSubtasks(
      new AbortController().signal,
    );
    // Ensure dispatch succeeded without error (result is array, not thrown)
    expect(Array.isArray(result)).toBe(true);
    expect(fake.calls).toBe(5);
    expect((agent as unknown as { BudgetExceeded: () => boolean }).BudgetExceeded()).toBe(false);
    // Unlimited dispatch should still produce a manifest that is complete when finalized (no pending budget cause)
    const err = (agent as unknown as { finalizeManifest: () => Error | null }).finalizeManifest();
    expect(err).toBeNull();
    const manifest = (agent as unknown as { RunManifest: () => import("../../../src/ocr/session/manifest.js").RunManifest | null }).RunManifest();
    expect(manifest?.terminalState).toBe(StateComplete);
    expect(manifest?.runFailure).toBeNull();
  });
});

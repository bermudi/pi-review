// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/scan/budget_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// localPath test/ocr-v193/scan/budget.test.ts -> internal/scan/budget_test.go

import { describe, test, expect } from "bun:test";
import { Agent, NewAgent } from "../../../src/ocr-v193/scan/scan.js";
import type { ScanItem } from "../../../src/ocr-v193/model/scan.js";
import type { ScanTemplate } from "../../../src/ocr-v193/template/template.js";
import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { CommentCollector } from "../../../src/ocr-v193/tool/collector.js";
import type { AnyLlmClient } from "../../../src/ocr-v193/llmloop/types.js";

type ScanAgentPrivate = {
  items: ScanItem[];
  dispatchSubtasks(signal: AbortSignal): Promise<unknown>;
  currentDate: string;
};

class FakeBudgetClient {
  calls = 0;
  perCallTokens: number;
  constructor(perCallTokens: number) {
    this.perCallTokens = perCallTokens;
  }
  async complete(_signal: AbortSignal, _req: unknown): Promise<unknown> {
    return this.CompletionsWithCtx(_signal, _req as never);
  }
  async CompletionsWithCtx(_signal: AbortSignal, _req: unknown): Promise<unknown> {
    this.calls += 1;
    return {
      content: "",
      toolCalls: [
        { id: "1", type: "function", function: { name: "task_done", arguments: "{}" } },
      ],
      usage: {
        PromptTokens: this.perCallTokens,
        CompletionTokens: 0,
        CacheReadTokens: 0,
        CacheWriteTokens: 0,
        TotalTokens: this.perCallTokens,
      },
    };
  }
}

function budgetTestTemplate(): ScanTemplate {
  return {
    MaxTokens: 100000,
    MaxToolRequestTimes: 5,
    MainTask: {
      messages: [
        { role: "system", content: "scan" },
        { role: "user", content: "review {{file_content}}" },
      ],
    },
    MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
  } as unknown as ScanTemplate;
}

function makeScanItems(n: number): ScanItem[] {
  const items: ScanItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      path: `f${String(i)}.go`,
      content: "package x\n",
      lineCount: 1,
    });
  }
  return items;
}

function makeToolRegistry(): { get: (name: string) => unknown; freeze: () => void } {
  const m = new Map<string, unknown>();
  return {
    get: (name: string) => m.get(name),
    freeze: () => {},
  };
}

describe("ocr-v193 scan budget (ported from internal/scan/budget_test.go)", () => {
  // OCR v1.9.3: TestBudgetGate_StopsBeforeExceeding
  test("TestBudgetGate_StopsBeforeExceeding", async () => {
    const perCall = 50000;
    const fake = new FakeBudgetClient(perCall);
    const sess = new SessionHistory("/tmp", "main", "test", { reviewMode: "full_scan" });
    const collector = new CommentCollector();
    const agent = NewAgent({
      template: budgetTestTemplate(),
      llmClient: fake as unknown as AnyLlmClient,
      commentCollector: collector as unknown as never,
      tools: makeToolRegistry() as unknown as never,
      maxConcurrency: 1,
      maxTokensBudget: 120000,
      session: sess as unknown as never,
      skipPlan: true,
      skipDedup: true,
      skipSummary: true,
    } as unknown as never);
    const priv = agent as unknown as ScanAgentPrivate;
    priv.items = makeScanItems(10);
    priv.currentDate = "2026-06-26 10:00";
    // Freeze already no-op
    await priv.dispatchSubtasks(new AbortController().signal);

    const calls = fake.calls;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(10);

    const warnings = agent.Warnings();
    const found = warnings.some((w) => w.type === "token_budget_reached");
    expect(found).toBe(true);
  });

  // OCR v1.9.3: TestBudgetGate_Unlimited
  test("TestBudgetGate_Unlimited", async () => {
    const fake = new FakeBudgetClient(50000);
    const sess = new SessionHistory("/tmp", "main", "test", { reviewMode: "full_scan" });
    const collector = new CommentCollector();
    const agent = NewAgent({
      template: budgetTestTemplate(),
      llmClient: fake as unknown as AnyLlmClient,
      commentCollector: collector as unknown as never,
      tools: makeToolRegistry() as unknown as never,
      maxConcurrency: 1,
      maxTokensBudget: 0,
      session: sess as unknown as never,
      skipPlan: true,
      skipDedup: true,
      skipSummary: true,
    } as unknown as never);
    const priv = agent as unknown as ScanAgentPrivate;
    priv.items = makeScanItems(5);
    priv.currentDate = "2026-06-26 10:00";
    await priv.dispatchSubtasks(new AbortController().signal);
    expect(fake.calls).toBe(5);
  });
});

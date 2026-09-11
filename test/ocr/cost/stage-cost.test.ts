// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Stage-cost seam contracts (evolution Phase 0 item 1): aggregation of
// attempts into a deterministic CostReport, and client-wrapper mechanics —
// attempt recording, error rethrow identity, shape preservation, and the
// unattributed bucket. No network, no paid calls: every client here is a
// scripted fake.

import { describe, test, expect } from "bun:test";
import { buildCostReport, CANONICAL_STAGE_ORDER, InMemoryCostCollector } from "../../../src/ocr/cost/collector.js";
import { createCostCollectingClient } from "../../../src/ocr/cost/client.js";
import { UNATTRIBUTED_STAGE, type CostAttempt } from "../../../src/ocr/cost/types.js";
import type { AnyLlmClient, ChatRequest } from "../../../src/ocr/llmloop/types.js";

type ClientMethod = (signal: AbortSignal, req: ChatRequest) => Promise<unknown>;

function attempt(overrides: Partial<CostAttempt> & { filePath: string; stage: string }): CostAttempt {
  return {
    provider: "prov",
    model: "model-x",
    requestNo: 1,
    ok: true,
    durationMs: 10,
    ...overrides,
  };
}

function metaReq(meta: Record<string, unknown>): ChatRequest {
  return { model: "model-x", messages: [], requestMeta: meta } as unknown as ChatRequest;
}

describe("buildCostReport", () => {
  test("empty attempt list produces a zeroed report", () => {
    const report = buildCostReport([]);
    expect(report.schemaVersion).toBe("pi-review.cost-report/v1");
    expect(report.provider).toBe("");
    expect(report.model).toBe("");
    expect(report.files).toEqual([]);
    expect(report.stageOrder).toEqual([]);
    expect(report.totals).toEqual({
      requests: 0,
      attempts: 0,
      retries: 0,
      failedRequests: 0,
      durationMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("retries collapse into one logical request; only successful attempts carry usage", () => {
    const report = buildCostReport([
      // plan_task request 1: 429 failure, then recovered retry.
      attempt({ filePath: "a.ts", stage: "plan_task", ok: false, durationMs: 30 }),
      attempt({ filePath: "a.ts", stage: "plan_task", ok: true, durationMs: 70, promptTokens: 11, completionTokens: 3 }),
    ]);
    const file = report.files.find((f) => f.filePath === "a.ts");
    expect(file).toBeDefined();
    const plan = file!.stages["plan_task"]!;
    expect(plan.requests).toBe(1);
    expect(plan.attempts).toBe(2);
    expect(plan.retries).toBe(1);
    expect(plan.failedRequests).toBe(0);
    expect(plan.durationMs).toBe(100);
    expect(plan.promptTokens).toBe(11);
    expect(plan.completionTokens).toBe(3);
    expect(report.totals.requests).toBe(1);
    expect(report.totals.retries).toBe(1);
  });

  test("a request whose final attempt fails counts as failed", () => {
    const report = buildCostReport([
      attempt({ filePath: "a.ts", stage: "main_task", requestNo: 1, ok: true, promptTokens: 5, completionTokens: 1 }),
      attempt({ filePath: "a.ts", stage: "main_task", requestNo: 2, ok: false, durationMs: 5 }),
    ]);
    const main = report.files[0]!.stages["main_task"]!;
    expect(main.requests).toBe(2);
    expect(main.attempts).toBe(2);
    expect(main.retries).toBe(0);
    expect(main.failedRequests).toBe(1);
    // Usage from the successful round still counts.
    expect(main.promptTokens).toBe(5);
  });

  test("files sort by path; stages follow the canonical pipeline order with unattributed last", () => {
    expect(CANONICAL_STAGE_ORDER).toEqual([
      "plan_task",
      "main_task",
      "memory_compression_task",
      "re_location_task",
      "review_filter_task",
    ]);
    const report = buildCostReport([
      attempt({ filePath: "b.ts", stage: "review_filter_task" }),
      attempt({ filePath: "a.ts", stage: "review_filter_task" }),
      attempt({ filePath: "b.ts", stage: "main_task", requestNo: 2 }),
      attempt({ filePath: "b.ts", stage: "memory_compression_task" }),
      attempt({ filePath: "b.ts", stage: "plan_task" }),
      attempt({ filePath: "b.ts", stage: "re_location_task", requestNo: 1, provider: "prov", model: "model-x" }),
      attempt({ filePath: "b.ts", stage: "custom_stage" }),
      attempt({ filePath: "b.ts", stage: UNATTRIBUTED_STAGE, requestNo: 0, provider: "", model: "" }),
    ]);
    expect(report.files.map((f) => f.filePath)).toEqual(["a.ts", "b.ts"]);
    const b = report.files[1]!;
    expect(Object.keys(b.stages)).toEqual([
      "plan_task",
      "main_task",
      "memory_compression_task",
      "re_location_task",
      "review_filter_task",
      "custom_stage",
      UNATTRIBUTED_STAGE,
    ]);
    expect(report.stageOrder).toEqual(Object.keys(b.stages));
  });

  test("same stage under different request numbers merges into one usage entry", () => {
    const report = buildCostReport([
      attempt({ filePath: "a.ts", stage: "main_task", requestNo: 1, promptTokens: 10, completionTokens: 2, durationMs: 100 }),
      attempt({ filePath: "a.ts", stage: "main_task", requestNo: 2, promptTokens: 20, completionTokens: 4, durationMs: 50 }),
    ]);
    const main = report.files[0]!.stages["main_task"]!;
    expect(main.requests).toBe(2);
    expect(main.promptTokens).toBe(30);
    expect(main.completionTokens).toBe(6);
    expect(main.durationMs).toBe(150);
  });

  test("attempts without a valid identity land in the unattributed bucket", () => {
    const report = buildCostReport([
      attempt({ filePath: "", stage: UNATTRIBUTED_STAGE, requestNo: 0, provider: "", model: "" }),
    ]);
    expect(report.files.map((f) => f.filePath)).toEqual([""]);
    expect(report.files[0]!.stages[UNATTRIBUTED_STAGE]!.requests).toBe(1);
  });
});

describe("InMemoryCostCollector", () => {
  test("records copies and reports aggregates; snapshots are immutable from the caller", () => {
    const collector = new InMemoryCostCollector();
    const raw: CostAttempt = attempt({ filePath: "a.ts", stage: "plan_task" });
    collector.recordAttempt(raw);
    const snapshot = collector.attemptsSnapshot();
    expect(snapshot).toHaveLength(1);
    // Mutating the snapshot (or the caller's object) must not change the report.
    (snapshot[0] as { filePath: string }).filePath = "mutated.ts";
    (raw as { promptTokens?: number }).promptTokens = 999;
    const report = collector.report();
    expect(report.files.map((f) => f.filePath)).toEqual(["a.ts"]);
    expect(report.files[0]!.stages["plan_task"]!.promptTokens).toBe(0);
  });
});

describe("createCostCollectingClient", () => {
  test("records a successful attempt with usage and returns the response unchanged", async () => {
    const recorded: CostAttempt[] = [];
    const response = { content: "ok", usage: { PromptTokens: 12, CompletionTokens: 4, CacheReadTokens: 2 } };
    const inner = {
      complete: async (_signal: AbortSignal, req: ChatRequest): Promise<unknown> => {
        expect(req).toBe(sameReq);
        return response;
      },
    };
    const wrapped = createCostCollectingClient(inner as unknown as AnyLlmClient, { recordAttempt: (a) => recorded.push(a) });
    const sameReq = metaReq({ provider: "prov", model: "model-x", filePath: "a.ts", taskType: "plan_task", requestNo: 3 });
    await expect((wrapped as unknown as { complete: ClientMethod }).complete(new AbortController().signal, sameReq)).resolves.toBe(response);
    expect(recorded).toEqual([
      {
        provider: "prov",
        model: "model-x",
        filePath: "a.ts",
        stage: "plan_task",
        requestNo: 3,
        ok: true,
        durationMs: recorded[0]!.durationMs,
        promptTokens: 12,
        completionTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: undefined,
      },
    ]);
    expect(recorded[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("rethrows the original error unchanged and records a failed attempt", async () => {
    const recorded: CostAttempt[] = [];
    const boom = new Error("HTTP 429");
    const inner = {
      complete: async (): Promise<unknown> => {
        throw boom;
      },
    };
    const wrapped = createCostCollectingClient(inner as unknown as AnyLlmClient, { recordAttempt: (a) => recorded.push(a) });
    let caught: unknown = null;
    try {
      await (wrapped as unknown as { complete: ClientMethod }).complete(
        new AbortController().signal,
        metaReq({ filePath: "a.ts", taskType: "main_task", requestNo: 1 }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(recorded).toEqual([
      { provider: "", model: "", filePath: "a.ts", stage: "main_task", requestNo: 1, ok: false, durationMs: recorded[0]!.durationMs },
    ]);
  });

  test("records synchronously throwing clients as failed attempts with the original error", async () => {
    const recorded: CostAttempt[] = [];
    const boom = new Error("sync provider explosion");
    const inner = {
      complete: (): Promise<unknown> => {
        throw boom;
      },
    };
    const wrapped = createCostCollectingClient(inner as unknown as AnyLlmClient, { recordAttempt: (a) => recorded.push(a) });
    await expect(
      (wrapped as unknown as { complete: ClientMethod }).complete(
        new AbortController().signal,
        metaReq({ filePath: "a.ts", taskType: "main_task", requestNo: 1 }),
      ),
    ).rejects.toBe(boom);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.ok).toBe(false);
  });

  test("a throwing collector fails the request loudly on success, never masks a request failure", async () => {
    const boom = new Error("HTTP 503");
    const collector = {
      recordAttempt: (): void => {
        throw new Error("collector disk full");
      },
    };
    const okInner = {
      complete: async (): Promise<unknown> => ({ content: "ok" }),
    };
    const failingInner = {
      complete: async (): Promise<unknown> => {
        throw boom;
      },
    };
    const wrappedOk = createCostCollectingClient(okInner as unknown as AnyLlmClient, collector);
    await expect(
      (wrappedOk as unknown as { complete: ClientMethod }).complete(
        new AbortController().signal,
        metaReq({ filePath: "a.ts", taskType: "plan_task", requestNo: 1 }),
      ),
    ).rejects.toThrow("collector disk full");

    const wrappedFailing = createCostCollectingClient(failingInner as unknown as AnyLlmClient, collector);
    await expect(
      (wrappedFailing as unknown as { complete: ClientMethod }).complete(
        new AbortController().signal,
        metaReq({ filePath: "a.ts", taskType: "plan_task", requestNo: 1 }),
      ),
    ).rejects.toBe(boom);
  });

  test("requests without a usable requestMeta are recorded as unattributed", async () => {
    const recorded: CostAttempt[] = [];
    const inner = {
      complete: async (): Promise<unknown> => ({ content: "" }),
    };
    const wrapped = createCostCollectingClient(inner as unknown as AnyLlmClient, { recordAttempt: (a) => recorded.push(a) });
    await (wrapped as unknown as { complete: ClientMethod }).complete(new AbortController().signal, { model: "m", messages: [] } as unknown as ChatRequest);
    await (wrapped as unknown as { complete: ClientMethod }).complete(new AbortController().signal, metaReq({ filePath: "a.ts", taskType: "", requestNo: 1 }));
    expect(recorded).toHaveLength(2);
    for (const a of recorded) {
      expect(a.stage).toBe(UNATTRIBUTED_STAGE);
      expect(a.filePath).toBe("");
      expect(a.requestNo).toBe(0);
    }
  });

  test("preserves the inner client's method shape and its `this` binding", async () => {
    class FakeGoClient {
      calls = 0;
      constructor(private readonly tag: string) {}
      async CompletionsWithCtx(_signal: AbortSignal, _req: ChatRequest): Promise<unknown> {
        this.calls += 1;
        return { content: this.tag };
      }
    }
    const inner = new FakeGoClient("go-shape");
    const recorded: CostAttempt[] = [];
    const wrapped = createCostCollectingClient(inner as unknown as AnyLlmClient, { recordAttempt: (a) => recorded.push(a) });
    // Go-style shape preserved: CompletionsWithCtx present, complete absent.
    expect(typeof (wrapped as unknown as Record<string, unknown>)["CompletionsWithCtx"]).toBe("function");
    expect((wrapped as unknown as Record<string, unknown>)["complete"]).toBeUndefined();
    const resp = await (wrapped as unknown as { CompletionsWithCtx: ClientMethod }).CompletionsWithCtx(
      new AbortController().signal,
      metaReq({ filePath: "a.ts", taskType: "plan_task", requestNo: 1 }),
    );
    expect(resp).toEqual({ content: "go-shape" });
    expect(inner.calls).toBe(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.stage).toBe("plan_task");
  });

  test("rejects a client with neither known method at wrap time", () => {
    expect(() => createCostCollectingClient({} as unknown as AnyLlmClient, { recordAttempt: () => {} })).toThrow(
      "createCostCollectingClient: llmClient must provide complete(signal, req) or CompletionsWithCtx(signal, req)",
    );
  });
});

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Stage-cost instrumentation through the Agent seam (evolution Phase 0
// item 1). Proves per-file, per-stage request counts — including a
// rate-limited plan request retried via backoff — across plan, main rounds,
// and the review filter on a two-file scripted review. No network, no paid
// calls: the model is a scripted fake driven through the same seams the
// existing agent tests use.

import { describe, test, expect } from "bun:test";
import { Agent } from "../../../src/ocr/agent/agent.js";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";
import { createDiff, type Diff } from "../../../src/ocr/model/diff.js";
import { InMemoryCostCollector } from "../../../src/ocr/cost/collector.js";
import type { CostReport } from "../../../src/ocr/cost/types.js";
import type { Template } from "../../../src/ocr/template/template.js";

// ---------------------------------------------------------------------------
// Scripted model — answers per stage/file using the RequestMeta the engine
// attaches to every request, so no global call-ordering assumption exists.
// ---------------------------------------------------------------------------

interface ScriptedRequest {
  readonly stage: string;
  readonly filePath: string;
  readonly requestNo: number;
}

function requestMetaOf(req: unknown): ScriptedRequest | null {
  if (typeof req !== "object" || req === null) return null;
  const meta = (req as Record<string, unknown>)["requestMeta"];
  if (typeof meta !== "object" || meta === null) return null;
  const m = meta as Record<string, unknown>;
  if (typeof m["filePath"] !== "string" || typeof m["taskType"] !== "string" || typeof m["requestNo"] !== "number") return null;
  return { stage: m["taskType"], filePath: m["filePath"], requestNo: m["requestNo"] };
}

class TwoFileScriptedClient {
  readonly requests: ScriptedRequest[] = [];
  private readonly mainRounds = new Map<string, number>();
  private planFailureIssued = false;

  constructor(
    private readonly options: {
      failFirstPlanFor?: string | null;
      failFilterFor?: string | null;
    } = {},
  ) {}

  async complete(signal: AbortSignal, req: unknown): Promise<unknown> {
    return this.CompletionsWithCtx(signal, req);
  }

  async CompletionsWithCtx(_signal: AbortSignal, req: unknown): Promise<unknown> {
    const meta = requestMetaOf(req);
    if (meta === null) throw new Error("scripted client: request arrived without requestMeta");
    this.requests.push(meta);

    if (meta.stage === "plan_task") {
      if (meta.filePath === this.options.failFirstPlanFor && !this.planFailureIssued) {
        this.planFailureIssued = true;
        throw Object.assign(new Error("Pi assistant turn ended with stop reason error (HTTP 429)"), { httpStatus: 429 });
      }
      return { content: `plan for ${meta.filePath}`, usage: { PromptTokens: 11, CompletionTokens: 3 } };
    }
    if (meta.stage === "review_filter_task") {
      if (meta.filePath === this.options.failFilterFor) {
        // Non-retryable transport failure; the filter does not back off.
        throw new Error("filter transport down");
      }
      // File a: the filter proves the comment wrong and removes it.
      // File b: empty decision keeps the comment.
      const keep = meta.filePath === "src/b.ts";
      return { content: keep ? `[]` : `["c-0"]`, usage: { PromptTokens: 7, CompletionTokens: 2 } };
    }
    // main_task rounds: first round files a finding, second finishes.
    const round = (this.mainRounds.get(meta.filePath) ?? 0) + 1;
    this.mainRounds.set(meta.filePath, round);
    if (round === 1) {
      return {
        content: "",
        toolCalls: [{
          id: `cc-${meta.filePath}`,
          type: "function",
          function: {
            name: "code_comment",
            arguments: JSON.stringify({ comments: [{ content: `finding in ${meta.filePath}` }] }),
          },
        }],
        usage: { PromptTokens: 50, CompletionTokens: 20, CacheReadTokens: 5 },
      };
    }
    return {
      content: "",
      toolCalls: [{
        id: `done-${meta.filePath}`,
        type: "function",
        function: { name: "task_done", arguments: "{}" },
      }],
      usage: { PromptTokens: 10, CompletionTokens: 5, CacheWriteTokens: 2 },
    };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function reviewTemplate(): Template {
  return {
    MaxTokens: 100000,
    MaxToolRequestTimes: 5,
    PlanModeLineThreshold: 0,
    MainTask: { messages: [{ role: "user", content: "Review {{diff}} in {{current_file_path}}" }] },
    MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
    PlanTask: { messages: [{ role: "user", content: "Plan a review of {{diff}}" }] },
    ReviewFilterTask: { messages: [{ role: "user", content: "Filter {{comments}} for {{path}}" }] },
  } as unknown as Template;
}

const MAIN_TOOL_DEFS = [
  { type: "function", function: { name: "code_comment", description: "submit findings" } },
  { type: "function", function: { name: "task_done", description: "finish" } },
] as unknown as ReadonlyArray<{ type: string; function: { name: string; description?: string } }>;

function twoDiffs(): Diff[] {
  return [
    createDiff({ newPath: "src/a.ts", oldPath: "src/a.ts", diff: "+export const a = 1;", insertions: 1 }),
    createDiff({ newPath: "src/b.ts", oldPath: "src/b.ts", diff: "+export const b = 2;", insertions: 1 }),
  ];
}

interface AgentWithArgs {
  args: { llmClient: unknown };
  diffs: Diff[];
  currentDate: string;
  dispatchSubtasks(signal: AbortSignal): Promise<unknown[]>;
}

async function runTwoFileReview(cost: InMemoryCostCollector | null): Promise<{ agent: Agent; client: TwoFileScriptedClient; comments: unknown[] }> {
  const client = new TwoFileScriptedClient(cost === null ? {} : { failFirstPlanFor: "src/a.ts" });
  const collector = new CommentCollector();
  const agent = new Agent({
    repoDir: "/tmp",
    model: "test",
    provider: "fake-provider",
    llmClient: client,
    commentCollector: collector,
    ...(cost !== null ? { costCollector: cost } : {}),
    rateLimitBackoffMs: [0],
    backoffSleep: async () => {},
    template: reviewTemplate(),
    mainToolDefs: MAIN_TOOL_DEFS,
  } as unknown as never);
  const harness = agent as unknown as AgentWithArgs;
  harness.diffs = twoDiffs();
  harness.currentDate = "2025-06-26 10:00";
  const comments = await harness.dispatchSubtasks(new AbortController().signal);
  return { agent, client, comments };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent stage-cost instrumentation (evolution Phase 0 item 1)", () => {
  test("default off: without a collector the client passes through unwrapped", () => {
    const client = new TwoFileScriptedClient();
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: client,
      template: reviewTemplate(),
      mainToolDefs: MAIN_TOOL_DEFS,
    } as unknown as never);
    expect((agent as unknown as AgentWithArgs).args.llmClient).toBe(client);
  });

  test("two-file scripted review: per-stage counts with a retried plan request", async () => {
    const cost = new InMemoryCostCollector();
    const { agent, client, comments } = await runTwoFileReview(cost);
    const report = cost.report();

    // The review itself stays intact: both files completed, the filter
    // removed a's finding and kept b's.
    expect((agent as unknown as AgentWithArgs).args.llmClient).not.toBe(client);
    expect(client.requests).toHaveLength(9);
    expect(comments).toHaveLength(1);

    expect(report.schemaVersion).toBe("pi-review.cost-report/v1");
    expect(report.provider).toBe("fake-provider");
    expect(report.model).toBe("test");
    expect(report.files.map((f) => f.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(report.stageOrder).toEqual(["plan_task", "main_task", "review_filter_task"]);

    // File a: plan retried once after a 429, then two main rounds, then filter.
    const a = report.files[0]!;
    expect(Object.keys(a.stages)).toEqual(["plan_task", "main_task", "review_filter_task"]);
    expect(a.stages["plan_task"]).toEqual({
      requests: 1,
      attempts: 2,
      retries: 1,
      failedRequests: 0,
      durationMs: a.stages["plan_task"]!.durationMs,
      promptTokens: 11,
      completionTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(a.stages["main_task"]).toEqual({
      requests: 2,
      attempts: 2,
      retries: 0,
      failedRequests: 0,
      durationMs: a.stages["main_task"]!.durationMs,
      promptTokens: 60,
      completionTokens: 25,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
    });
    expect(a.stages["review_filter_task"]).toEqual({
      requests: 1,
      attempts: 1,
      retries: 0,
      failedRequests: 0,
      durationMs: a.stages["review_filter_task"]!.durationMs,
      promptTokens: 7,
      completionTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    // File b: identical shape, no retry.
    const b = report.files[1]!;
    expect(b.stages["plan_task"]!.requests).toBe(1);
    expect(b.stages["plan_task"]!.attempts).toBe(1);
    expect(b.stages["plan_task"]!.retries).toBe(0);
    expect(b.stages["main_task"]!.requests).toBe(2);
    expect(b.stages["review_filter_task"]!.requests).toBe(1);

    // Run totals: 8 logical requests, 9 attempts (one retried plan).
    expect(report.totals).toEqual({
      requests: 8,
      attempts: 9,
      retries: 1,
      failedRequests: 0,
      durationMs: report.totals.durationMs,
      promptTokens: 156,
      completionTokens: 60,
      cacheReadTokens: 10,
      cacheWriteTokens: 4,
    });
  });

  test("stage identity follows the engine's TaskRecords; a retry repeats one logical identity", async () => {
    const cost = new InMemoryCostCollector();
    const { client } = await runTwoFileReview(cost);
    const seen = client.requests.map((r) => `${r.filePath}:${r.stage}#${r.requestNo}`);
    // 9 physical attempts (one rate-limited plan retried) carry 8 logical
    // identities: the retried attempt repeats file a's plan identity, which
    // is what lets the report collapse retries under one request.
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(8);
    const duplicated = seen.filter((id, i) => seen.indexOf(id) !== i);
    expect(duplicated).toEqual(["src/a.ts:plan_task#1"]);
    expect([...seen].sort()).toEqual([
      "src/a.ts:main_task#1",
      "src/a.ts:main_task#2",
      "src/a.ts:plan_task#1",
      "src/a.ts:plan_task#1",
      "src/a.ts:review_filter_task#1",
      "src/b.ts:main_task#1",
      "src/b.ts:main_task#2",
      "src/b.ts:plan_task#1",
      "src/b.ts:review_filter_task#1",
    ]);
  });

  test("a failed filter request is recorded without failing the file's comments", async () => {
    const cost = new InMemoryCostCollector();
    const client = new TwoFileScriptedClient({ failFilterFor: "src/a.ts" });
    const collector = new CommentCollector();
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: client,
      commentCollector: collector,
      costCollector: cost,
      template: reviewTemplate(),
      mainToolDefs: MAIN_TOOL_DEFS,
    } as unknown as never);
    const harness = agent as unknown as AgentWithArgs & {
      executeReviewFilter(signal: AbortSignal, diff: Diff, path: string): Promise<void>;
    };
    collector.Add({ path: "src/a.ts", content: "keeper", existingCode: "" });

    await harness.executeReviewFilter(
      new AbortController().signal,
      { newPath: "src/a.ts", diff: "+x" } as unknown as Diff,
      "src/a.ts",
    );

    const report = cost.report();
    const filter = report.files.find((f) => f.filePath === "src/a.ts")!.stages["review_filter_task"]!;
    expect(filter.requests).toBe(1);
    expect(filter.attempts).toBe(1);
    expect(filter.failedRequests).toBe(1);
    expect(filter.promptTokens).toBe(0);
    // Filter failure keeps comments (OCR behavior) — instrumentation alone.
    expect(collector.CommentsForPath("src/a.ts")).toHaveLength(1);
  });
});

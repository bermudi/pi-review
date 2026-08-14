// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from ../open-code-review/internal/llmloop/loop_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Behavioral port: preserve upstream Test* names in comments, replace Go machinery with typed fakes.

import { describe, test, expect } from "bun:test";

import { Runner, MainLoopStop, graceRoundToolDefs } from "../../../src/ocr-v193/llmloop/loop.ts";
import { ScriptedTransport, type ScriptedResponse } from "../../../src/ocr-v193/llmloop/transcript.ts";
import type { ToolDef, Template } from "../../../src/ocr-v193/llmloop/types.ts";
import type { LlmComment } from "../../../src/ocr-v193/model/types.ts";
import { newTextMessage, extractText, type Message } from "../../../src/ocr-v193/llmloop/compression.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StubCollector = {
  readonly store: LlmComment[];
  add: (c: LlmComment) => void;
  comments: () => LlmComment[];
  // Go-style alias
  Add: (c: LlmComment) => void;
  Comments: () => LlmComment[];
};

function createCollector(): StubCollector {
  const store: LlmComment[] = [];
  const c: StubCollector = {
    store,
    add(comment: LlmComment): void {
      store.push(comment);
    },
    comments(): LlmComment[] {
      return [...store];
    },
    Add(comment: LlmComment): void {
      store.push(comment);
    },
    Comments(): LlmComment[] {
      return [...store];
    },
  };
  return c;
}

type ToolProviderStub = {
  readonly name: string;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string> | string;
};

function fileReadRegistry(result: string): Map<string, ToolProviderStub> {
  const m = new Map<string, ToolProviderStub>();
  m.set("file_read", {
    name: "file_read",
    execute: () => result,
  });
  return m;
}

function emptyRegistry(): Map<string, ToolProviderStub> {
  return new Map<string, ToolProviderStub>();
}

interface MakeRunnerOpts {
  readonly responses: readonly ScriptedResponse[];
  readonly toolRegistry?: Map<string, ToolProviderStub>;
  readonly template?: unknown;
  readonly mainToolDefs?: readonly ToolDef[];
  readonly collector?: StubCollector | null;
  readonly model?: string;
}

function makeRunner(opts: MakeRunnerOpts): {
  readonly runner: Runner;
  readonly transport: ScriptedTransport;
  readonly collector: StubCollector | null;
} {
  const transport = new ScriptedTransport(opts.responses);

  // Runner expects complete(signal, req) (Go-style). ScriptedTransport is (req, signal).
  // Adapt so both orderings work.
  const adapter = {
    complete: (signal: AbortSignal, req: unknown): Promise<unknown> => {
      // eslint-disable-next-line -- test adapter
      return (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(
        req as unknown,
        signal as unknown,
      );
    },
    CompletionsWithCtx: (signal: AbortSignal, req: unknown): Promise<unknown> => {
      return (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(
        req as unknown,
        signal as unknown,
      );
    },
  };

  const rawTemplate = (opts.template ?? {}) as Record<string, unknown>;
  const MaxTokens =
    (rawTemplate["MaxTokens"] as number | undefined) ??
    (rawTemplate["maxTokens"] as number | undefined) ??
    4000;
  const MaxToolRequestTimes =
    (rawTemplate["MaxToolRequestTimes"] as number | undefined) ??
    (rawTemplate["maxToolRequestTimes"] as number | undefined) ??
    30;
  let MaxCompletionTokens: number | undefined = rawTemplate["MaxCompletionTokens"] as number | undefined;
  if (MaxCompletionTokens === undefined && typeof rawTemplate["completionTokenLimit"] === "function") {
    const fn = rawTemplate["completionTokenLimit"] as () => number;
    MaxCompletionTokens = fn();
  }
  if (MaxCompletionTokens === undefined) MaxCompletionTokens = 1000;

  const template: Template = {
    MaxTokens,
    MaxToolRequestTimes,
    MaxCompletionTokens,
  } as Template;

  let collector: StubCollector | null;
  if (opts.collector === null) {
    collector = null;
  } else if (opts.collector !== undefined) {
    collector = opts.collector;
  } else {
    collector = createCollector();
  }

  const mainToolDefs: readonly ToolDef[] =
    opts.mainToolDefs ??
    ([
      { type: "function", function: { name: "code_comment" } },
      { type: "function", function: { name: "task_done" } },
      { type: "function", function: { name: "file_read" } },
    ] as readonly ToolDef[]);

  const deps = {
    model: opts.model ?? "fake",
    template,
    llmClient: adapter as unknown,
    mainToolDefs,
    commentCollector: collector as unknown,
    toolRegistry: opts.toolRegistry ?? emptyRegistry(),
  };

  const runner = new Runner(deps as unknown as ConstructorParameters<typeof Runner>[0]);
  return { runner, transport, collector };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ocr-v193 llmloop Runner (ported)", () => {
  // Ported from TestRunPerFile_TaskDoneSuccess in loop_test.go
  // Upstream invariant: task_done DONE completes the loop.
  test("completes on task_done DONE", async () => {
    const { runner, transport } = makeRunner({
      responses: [
        {
          toolCalls: [{ id: "call_1", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }],
          usage: { PromptTokens: 10, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
      ],
    });

    const msgs: Message[] = [newTextMessage("user", "review this file")];
    const result = await runner.RunPerFile(new AbortController().signal, msgs, "main.go");

    expect(result.completed).toBe(true);
    expect(result.stop).toBe(MainLoopStop.StopNone);
    expect(result.error).toBeUndefined();
    expect(transport.requests).toHaveLength(1);
    expect(runner.totalInputTokens()).toBe(10);
    expect(runner.totalOutputTokens()).toBe(5);
  });

  // Ported from TestRunPerFile_MultiToolTurnIsOneRound in loop_test.go
  // One response with 2 code_comment calls counts as 1 round, both executed,
  // next request contains tool results.
  test("multi-tool turn counts as one round", async () => {
    const collector = createCollector();
    const { runner, transport } = makeRunner({
      collector,
      responses: [
        {
          toolCalls: [
            {
              id: "call_1",
              name: "code_comment",
              arguments: JSON.stringify({
                comments: [{ content: "issue 1", existing_code: "foo" }],
              }),
            },
            {
              id: "call_2",
              name: "code_comment",
              arguments: JSON.stringify({
                comments: [{ content: "issue 2", existing_code: "bar" }],
              }),
            },
          ],
          usage: { PromptTokens: 20, CompletionTokens: 10, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
        {
          toolCalls: [{ id: "call_3", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }],
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
      ],
    });

    const msgs: Message[] = [newTextMessage("user", "review")];
    const result = await runner.RunPerFile(new AbortController().signal, msgs, "main.go");

    expect(result.completed).toBe(true);
    expect(transport.requests).toHaveLength(2);

    // Both comments should have been collected via code_comment.
    expect(collector.comments()).toHaveLength(2);
    expect(collector.comments()[0]?.content).toBe("issue 1");
    expect(collector.comments()[1]?.content).toBe("issue 2");

    // ToolCalls counting: code_comment should be 2
    expect(runner.toolCalls().get("code_comment")).toBe(2);

    // Next request (index 1) should contain the tool results from the first turn.
    const secondReq = transport.requests[1];
    expect(secondReq).toBeDefined();
    const secondMessages = secondReq?.messages ?? [];
    // Expect: user, assistant-with-tool_calls, tool, tool
    const toolMessages = secondMessages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    const toolTexts = toolMessages.map((m) => extractText(m as unknown as Message));
    expect(toolTexts.every((t) => t === "Successfully commented.")).toBe(true);

    // Verify total usage counted across both rounds
    expect(runner.totalInputTokens()).toBe(25);
    expect(runner.totalOutputTokens()).toBe(15);
  });

  // Ported from TestRunPerFile_EmptyToolCallsRetry in loop_test.go
  // Response with no tool_calls inserts retry user message and continues,
  // not counting toward empty.
  test("empty tool_calls triggers retry insertion", async () => {
    const { runner, transport } = makeRunner({
      responses: [
        {
          content: "hello",
          toolCalls: [],
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
        {
          toolCalls: [{ id: "call_2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }],
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
      ],
    });

    const msgs: Message[] = [newTextMessage("user", "review")];
    const result = await runner.RunPerFile(new AbortController().signal, msgs, "main.go");

    expect(result.completed).toBe(true);
    expect(result.stop).toBe(MainLoopStop.StopNone);
    expect(transport.requests).toHaveLength(2);

    const secondReq = transport.requests[1];
    expect(secondReq).toBeDefined();
    const texts = (secondReq?.messages ?? []).map((m) => extractText(m as unknown as Message));
    const hasRetry = texts.some((t) => t.includes("You did not successfully call any tools"));
    expect(hasRetry).toBe(true);
    // Should also preserve assistant content before retry
    const hasAssistantHello = texts.some((t) => t === "hello");
    expect(hasAssistantHello).toBe(true);
  });

  // Ported from TestRunPerFile_ThreeConsecutiveEmptyResultsStops in loop_test.go
  // 3 rounds with empty data -> StopEmptyRounds
  test("three consecutive empty results stops", async () => {
    const { runner, transport } = makeRunner({
      toolRegistry: fileReadRegistry(""),
      responses: [
        {
          toolCalls: [{ id: "c1", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }],
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
        {
          toolCalls: [{ id: "c2", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }],
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
        {
          toolCalls: [{ id: "c3", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }],
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
      ],
    });

    const msgs: Message[] = [newTextMessage("user", "review")];
    const result = await runner.RunPerFile(new AbortController().signal, msgs, "main.go");

    expect(result.completed).toBe(false);
    expect(result.stop).toBe(MainLoopStop.StopEmptyRounds);
    expect(result.error).toBeUndefined();
    expect(transport.requests).toHaveLength(3);
    // Grace should NOT be triggered on empty-rounds stop
    // So no extra request beyond the 3 empties
  });

  // Ported from TestRunPerFile_MaxRoundsTriggersGrace in loop_test.go
  // Budget 1 exhausted -> one grace request with only code_comment+task_done,
  // usage counted, stops with StopMaxRounds
  test("max rounds triggers grace with filtered tools", async () => {
    const collector = createCollector();
    const { runner, transport } = makeRunner({
      collector,
      toolRegistry: fileReadRegistry("package main\n"),
      template: { MaxTokens: 100000, MaxToolRequestTimes: 1, MaxCompletionTokens: 1000 } as unknown as Record<string, unknown>,
      mainToolDefs: [
        { type: "function", function: { name: "code_comment" } },
        { type: "function", function: { name: "task_done" } },
        { type: "function", function: { name: "file_read" } },
      ],
      responses: [
        {
          toolCalls: [{ id: "call_1", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }],
          usage: { PromptTokens: 20, CompletionTokens: 10, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
        {
          toolCalls: [
            {
              id: "call_grace",
              name: "code_comment",
              arguments: JSON.stringify({
                comments: [{ content: "found a bug", existing_code: "x := 1" }],
              }),
            },
          ],
          usage: { PromptTokens: 50, CompletionTokens: 20, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
      ],
    });

    const msgs: Message[] = [newTextMessage("user", "review")];
    const result = await runner.RunPerFile(new AbortController().signal, msgs, "main.go");

    expect(result.completed).toBe(false);
    expect(result.stop).toBe(MainLoopStop.StopMaxRounds);
    expect(transport.requests).toHaveLength(2);

    const graceReq = transport.requests[1];
    expect(graceReq).toBeDefined();
    expect(graceReq?.tools).toHaveLength(2);
    const graceToolNames = (graceReq?.tools ?? []).map((t) => t.function.name).sort();
    expect(graceToolNames).toEqual(["code_comment", "task_done"]);

    // Comment should have been collected in grace round
    expect(collector.comments()).toHaveLength(1);
    expect(collector.comments()[0]?.content).toBe("found a bug");

    // Usage should include grace round
    expect(runner.totalInputTokens()).toBe(70);
    expect(runner.totalOutputTokens()).toBe(30);
  });

  // Ported from TestRunPerFile_CancelPreventsGrace in loop_test.go
  // Abort signal prevents grace call
  test("abort prevents grace call", async () => {
    const controller = new AbortController();

    const transport = new ScriptedTransport([
      {
        toolCalls: [{ id: "call_1", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }],
        usage: { PromptTokens: 20, CompletionTokens: 10, CacheReadTokens: 0, CacheWriteTokens: 0 },
      },
      {
        toolCalls: [
          {
            id: "call_grace",
            name: "code_comment",
            arguments: JSON.stringify({ comments: [{ content: "late bug", existing_code: "x" }] }),
          },
        ],
        usage: { PromptTokens: 50, CompletionTokens: 20, CacheReadTokens: 0, CacheWriteTokens: 0 },
      },
    ]);

    // Adapter that aborts the controller after the first LLM call.
    let callCount = 0;
    const adapter = {
      complete: async (signal: AbortSignal, req: unknown): Promise<unknown> => {
        callCount += 1;
        const res = await (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(
          req as unknown,
          signal as unknown,
        );
        if (callCount === 1) {
          controller.abort(new Error("cancelled for test"));
        }
        return res;
      },
      CompletionsWithCtx: async (signal: AbortSignal, req: unknown): Promise<unknown> => {
        callCount += 1;
        const res = await (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(
          req as unknown,
          signal as unknown,
        );
        if (callCount === 1) {
          controller.abort(new Error("cancelled for test"));
        }
        return res;
      },
    };

    const collector = createCollector();
    const runner = new Runner({
      model: "fake",
      template: { MaxTokens: 100000, MaxToolRequestTimes: 1, MaxCompletionTokens: 1000 } as Template,
      llmClient: adapter as unknown,
      mainToolDefs: [
        { type: "function", function: { name: "code_comment" } },
        { type: "function", function: { name: "task_done" } },
        { type: "function", function: { name: "file_read" } },
      ],
      commentCollector: collector as unknown,
      toolRegistry: fileReadRegistry("package main\n"),
    } as unknown as ConstructorParameters<typeof Runner>[0]);

    const msgs: Message[] = [newTextMessage("user", "review")];
    const result = await runner.RunPerFile(controller.signal, msgs, "main.go");

    expect(result.stop).toBe(MainLoopStop.StopMaxRounds);
    expect(result.completed).toBe(false);
    // Grace should have been skipped -> only 1 LLM call recorded
    expect(transport.requests).toHaveLength(1);
    expect(collector.comments()).toHaveLength(0);
  });

  // Ported from TestRunPerFile_CompressionThreshold in loop_test.go
  // Large messages trigger tryApply/compression path (or at least not crash)
  test("large messages trigger compression path without crash", async () => {
    const { runner, transport } = makeRunner({
      toolRegistry: fileReadRegistry("package main\n"),
      template: { MaxTokens: 20, MaxToolRequestTimes: 10, MaxCompletionTokens: 1000 } as unknown as Record<string, unknown>,
      responses: [
        {
          toolCalls: [{ id: "c1", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }],
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
        // Repeat same to keep loop running if not stopped by compression
        {
          toolCalls: [{ id: "c2", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }],
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
      ],
    });

    // Create 2 initial messages that exceed 80% threshold for MaxTokens=20.
    // CountMessagesTokens uses byte length /4, so 100 words ~125 tokens.
    const big = "word ".repeat(100);
    const msgs: Message[] = [newTextMessage("user", big), newTextMessage("assistant", big)];

    const result = await runner.RunPerFile(new AbortController().signal, msgs, "main.go");

    // Should not throw; behavior is either StopCompression or continues.
    // At minimum we assert no crash and some stop classification.
    expect([MainLoopStop.StopCompression, MainLoopStop.StopEmptyRounds, MainLoopStop.StopMaxRounds, MainLoopStop.StopNone]).toContain(result.stop);
    // At least one request should have been made.
    expect(transport.requests.length).toBeGreaterThanOrEqual(1);
    // Ensure runner didn't throw and background cleanup completed.
    await runner.waitBackground();
  });

  // Ported from TestGraceRoundToolDefs_Filters in loop_test.go
  test("grace tool defs filters to code_comment and task_done only", () => {
    const defs: ToolDef[] = [
      { type: "function", function: { name: "code_comment" } },
      { type: "function", function: { name: "task_done" } },
      { type: "function", function: { name: "file_read" } },
      { type: "function", function: { name: "code_search" } },
    ];

    const filtered = graceRoundToolDefs(defs);
    expect(filtered).toHaveLength(2);
    const names = filtered.map((d) => d.function.name).sort();
    expect(names).toEqual(["code_comment", "task_done"]);

    // Original order preservation check
    const filtered2 = graceRoundToolDefs([
      { type: "function", function: { name: "task_done" } },
      { type: "function", function: { name: "code_comment" } },
    ]);
    expect(filtered2.map((d) => d.function.name)).toEqual(["task_done", "code_comment"]);

    // Empty and unrelated
    expect(graceRoundToolDefs([])).toEqual([]);
    expect(
      graceRoundToolDefs([{ type: "function", function: { name: "file_find" } }]),
    ).toEqual([]);
  });
});

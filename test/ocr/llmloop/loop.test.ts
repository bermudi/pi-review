// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from ../open-code-review/internal/llmloop/loop_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Behavioral port: preserve upstream Test* names in comments, replace Go machinery with typed fakes.

import { describe, test, expect } from "bun:test";

import { Runner, MainLoopStop, graceRoundToolDefs, mainLoopStopReason, mainLoopStopString } from "../../../src/ocr/llmloop/loop.ts";
import { ScriptedTransport, type ScriptedResponse } from "../../../src/ocr/llmloop/transcript.ts";
import type { ToolDef, Template } from "../../../src/ocr/llmloop/types.ts";
import type { LlmComment } from "../../../src/ocr/model/types.ts";
import { newTextMessage, extractText, type Message } from "../../../src/ocr/llmloop/compression.ts";

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
  readonly sessionId?: string;
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
  const memoryCompressionTask = rawTemplate["MemoryCompressionTask"] as Template["MemoryCompressionTask"] | undefined;

  const template: Template = {
    MaxTokens,
    MaxToolRequestTimes,
    MaxCompletionTokens,
    MemoryCompressionTask: memoryCompressionTask,
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
    sessionId: opts.sessionId,
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

describe("ocr llmloop Runner (ported)", () => {
  // OCR v1.9.3: TestRunPerFile_TaskDoneExplicitDone
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

  // OCR v1.9.3: TestRunPerFile_TaskDoneImmediately
  test("task_done immediately completes after one request", async () => {
    const { runner, transport } = makeRunner({
      responses: [
        {
          toolCalls: [{ id: "done-1", name: "task_done", arguments: "{}" }],
          usage: { PromptTokens: 10, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
      ],
    });

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review this file")],
      "main.go",
    );

    expect(result.completed).toBe(true);
    expect(transport.requests).toHaveLength(1);
    expect(runner.totalInputTokens()).toBe(10);
    expect(runner.totalOutputTokens()).toBe(5);
  });

  // OCR v1.9.3: TestRunPerFile_UsesCompletionTokenLimit
  test("uses the configured completion token limit", async () => {
    const { runner, transport } = makeRunner({
      template: { MaxTokens: 200000, MaxToolRequestTimes: 10, MaxCompletionTokens: 58888 },
      responses: [
        {
          toolCalls: [{ id: "done-1", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }],
        },
      ],
    });

    await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review")],
      "main.go",
    );

    expect(transport.requests[0]?.maxTokens).toBe(58888);
  });

  // OCR v1.9.3: TestRunPerFile_TaskDoneFailed
  test("task_done FAILED terminates with an error", async () => {
    const { runner, transport } = makeRunner({
      responses: [
        {
          toolCalls: [{ id: "failed-1", name: "task_done", arguments: JSON.stringify({ state: "FAILED" }) }],
        },
      ],
    });

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review this file")],
      "main.go",
    );

    expect(result.completed).toBe(false);
    expect(result.error?.message).toContain("task_done reported FAILED");
    expect(transport.requests).toHaveLength(1);
  });

  // OCR v1.9.3: TestRunPerFile_InvalidTaskDoneStateRetries
  test("invalid task_done states are retried before DONE", async () => {
    const invalidArguments = [
      JSON.stringify({ state: "UNKNOWN" }),
      JSON.stringify({ state: "" }),
      JSON.stringify({ state: 1 }),
      '{"state":',
    ];

    for (const arguments_ of invalidArguments) {
      const { runner, transport } = makeRunner({
        responses: [
          { toolCalls: [{ id: "invalid-1", name: "task_done", arguments: arguments_ }] },
          { toolCalls: [{ id: "done-1", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
        ],
      });

      const result = await runner.RunPerFile(
        new AbortController().signal,
        [newTextMessage("user", "review this file")],
        "main.go",
      );

      expect(result.completed).toBe(true);
      expect(result.error).toBeUndefined();
      expect(transport.requests).toHaveLength(2);
    }
  });

  // OCR v1.9.3: TestRunPerFile_TagsRequestsWithTaskSessionKey
  test("tags every request in one file run with one session key", async () => {
    const { runner, transport } = makeRunner({
      sessionId: "sess",
      responses: [
        { toolCalls: [{ id: "read-1", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }] },
        { toolCalls: [{ id: "done-1", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
      toolRegistry: fileReadRegistry("package main\n"),
    });

    await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review this file")],
      "main.go",
    );

    expect(transport.requests).toHaveLength(2);
    const sessionIds = transport.requests.map((request) => request.sessionId);
    const expected = "sess-main_task-2873f79a86c0d8b3";
    expect(sessionIds).toEqual([expected, expected]);
  });

  // OCR v1.9.3: TestRunner_RecordWarning
  test("records warnings in insertion order", () => {
    const { runner } = makeRunner({ responses: [] });

    runner.RecordWarning("token_limit", "a.go", "approaching token limit");
    runner.RecordWarning("parse_error", "b.go", "invalid JSON");

    expect(runner.Warnings()).toEqual([
      { type: "token_limit", file: "a.go", message: "approaching token limit" },
      { type: "parse_error", file: "b.go", message: "invalid JSON" },
    ]);
  });

  // OCR v1.9.3: TestRunner_RecordUsage
  test("records usage and ignores a missing usage record", () => {
    const { runner } = makeRunner({ responses: [] });

    runner.RecordUsage({
      PromptTokens: 100,
      CompletionTokens: 50,
      CacheReadTokens: 20,
      CacheWriteTokens: 10,
    });
    runner.RecordUsage(undefined);

    expect(runner.totalInputTokens()).toBe(100);
    expect(runner.totalOutputTokens()).toBe(50);
    expect(runner.totalCacheReadTokens()).toBe(20);
    expect(runner.totalCacheWriteTokens()).toBe(10);
    expect(runner.totalTokensUsed()).toBe(150);
  });

  // Additional local regression: one response may contain multiple tool calls.
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

  // OCR v1.9.3: TestRunPerFile_ToolCallThenDone
  test("a tool call followed by task_done completes", async () => {
    const { runner, transport } = makeRunner({
      toolRegistry: fileReadRegistry("package main\n"),
      responses: [
        {
          toolCalls: [{ id: "read-1", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }],
          usage: { PromptTokens: 20, CompletionTokens: 10, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
        {
          toolCalls: [{ id: "done-1", name: "task_done", arguments: "{}" }],
          usage: { PromptTokens: 10, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
      ],
    });

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review")],
      "main.go",
    );

    expect(result.completed).toBe(true);
    expect(transport.requests).toHaveLength(2);
    expect(runner.toolCalls().get("file_read")).toBe(1);
    expect(runner.totalInputTokens()).toBe(30);
  });

  // OCR v1.9.3: TestRunPerFile_ContextCancelled
  test("an already-cancelled context does not make a request", async () => {
    const { runner, transport } = makeRunner({
      responses: [
        { toolCalls: [{ id: "done-1", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled for test"));

    const result = await runner.RunPerFile(
      controller.signal,
      [newTextMessage("user", "review")],
      "main.go",
    );

    expect(result.completed).toBe(false);
    expect(result.error).toBeDefined();
    expect(transport.requests).toHaveLength(0);
  });

  // OCR v1.9.3: TestRunPerFile_UnknownTool
  test("unknown tools produce a result and allow the model to continue", async () => {
    const { runner, transport } = makeRunner({
      responses: [
        { toolCalls: [{ id: "unknown-1", name: "nonexistent_tool", arguments: "{}" }] },
        { toolCalls: [{ id: "done-1", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review")],
      "main.go",
    );

    expect(result.completed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(transport.requests).toHaveLength(2);
    const toolMessages = (transport.requests[1]?.messages ?? []).filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(extractText(toolMessages[0] as Message)).toContain("Tool not found");
  });

  // OCR v1.9.3: TestExecuteToolCall_ArgumentsEdgeCases
  test("tool argument edge cases fail safely and never pass null dynamic args", async () => {
    const cases: readonly {
      readonly name: string;
      readonly toolName: string;
      readonly arguments: string;
      readonly wantError?: string;
      readonly wantCommentPath?: string;
      readonly wantNonNullDynamicArgs?: boolean;
    }[] = [
      {
        name: "null args on code_comment",
        toolName: "code_comment",
        arguments: "null",
        wantError: "'comments' array is required",
      },
      {
        name: "empty object on code_comment",
        toolName: "code_comment",
        arguments: "{}",
        wantError: "'comments' array is required",
      },
      {
        name: "valid args keeps path override",
        toolName: "code_comment",
        arguments: JSON.stringify({
          path: "hallucinated.go",
          comments: [{ content: "issue", existing_code: "foo" }],
        }),
        wantCommentPath: "file.go",
      },
      {
        name: "empty string args",
        toolName: "code_comment",
        arguments: "",
        wantError: "Error parsing tool arguments",
      },
      {
        name: "malformed JSON args",
        toolName: "code_comment",
        arguments: '{"comments":',
        wantError: "Error parsing tool arguments",
      },
      {
        name: "null args on dynamic tool",
        toolName: "dyn_echo",
        arguments: "null",
        wantNonNullDynamicArgs: true,
      },
    ];

    for (const testCase of cases) {
      const captured: Array<Record<string, unknown>> = [];
      const collector = createCollector();
      const registry = new Map<string, ToolProviderStub>([
        [
          "dyn_echo",
          {
            name: "dyn_echo",
            execute: (args) => {
              captured.push(args);
              return "ok";
            },
          },
        ],
      ]);
      const { runner } = makeRunner({
        collector,
        toolRegistry: registry,
        responses: [],
      });

      const checkpoint = await runner.executeToolCall(
        new AbortController().signal,
        "file.go",
        {
          id: `args-${testCase.name}`,
          type: "function",
          function: { name: testCase.toolName, arguments: testCase.arguments },
        },
        "",
      );

      if (testCase.wantError !== undefined) {
        expect(checkpoint.data).toContain(testCase.wantError);
      }
      if (testCase.wantCommentPath !== undefined) {
        expect(collector.comments()).toHaveLength(1);
        expect(collector.comments()[0]?.path).toBe(testCase.wantCommentPath);
      }
      if (testCase.wantNonNullDynamicArgs) {
        expect(captured).toHaveLength(1);
        expect(captured[0]).toEqual({});
      }
    }
  });

  // Additional local regression: a text-only response gets the OCR retry prompt.
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

  // OCR v1.9.3: TestRunPerFile_EmptyToolResultsStopWithEmptyRounds
  // OCR v1.9.3: TestRunPerFile_GraceRoundNotTriggeredOnEmptyRoundsStop
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

  // OCR v1.9.3: TestRunPerFile_MaxToolRequestsWithoutTaskDoneDoesNotComplete
  test("max tool requests without task_done do not complete", async () => {
    const { runner, transport } = makeRunner({
      template: { MaxTokens: 100000, MaxToolRequestTimes: 1, MaxCompletionTokens: 1000 },
      responses: [{ content: "", toolCalls: [] }, { content: "", toolCalls: [] }],
    });

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review")],
      "main.go",
    );

    expect(result.completed).toBe(false);
    expect(result.stop).toBe(MainLoopStop.StopMaxRounds);
    expect(transport.requests).toHaveLength(2);
  });

  // Budget 1 exhausted -> one grace request with only code_comment+task_done,
  // usage counted, stops with StopMaxRounds
  // OCR v1.9.3: TestRunPerFile_GraceRoundSubmitsComment
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

  // OCR v1.9.3: TestRunPerFile_GraceRoundSkippedWhenContextCancelled
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

  // OCR v1.9.3: TestRunPerFile_UncompressibleContextStopsWithCompression
  test("uncompressible context stops after the compression request", async () => {
    const { runner, transport } = makeRunner({
      toolRegistry: fileReadRegistry("package main\n"),
      template: {
        MaxTokens: 20,
        MaxToolRequestTimes: 10,
        MaxCompletionTokens: 1000,
        MemoryCompressionTask: {
          Messages: [newTextMessage("user", "Summarize: {{context}}")],
        },
      },
      responses: [
        {
          toolCalls: [{ id: "c1", name: "file_read", arguments: JSON.stringify({ path: "main.go" }) }],
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
        {
          content: "",
          usage: { PromptTokens: 5, CompletionTokens: 5, CacheReadTokens: 0, CacheWriteTokens: 0 },
        },
      ],
    });

    const big = "word ".repeat(100);
    const msgs: Message[] = [newTextMessage("user", big)];

    const result = await runner.RunPerFile(new AbortController().signal, msgs, "main.go");

    expect(result.completed).toBe(false);
    expect(result.stop).toBe(MainLoopStop.StopCompression);
    expect(transport.requests).toHaveLength(2);
    await runner.waitBackground();
  });

  // Additional local regression: grace tools remain restricted to review tools.
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

  // OCR v1.9.9: TestMainLoopStopStringAndReason
  test("TestMainLoopStopStringAndReason", () => {
    const stops = [
      [MainLoopStop.StopNone, "none"],
      [MainLoopStop.StopMaxRounds, "max_rounds"],
      [MainLoopStop.StopEmptyRounds, "empty_rounds"],
      [MainLoopStop.StopCompression, "compression"],
    ] as const;
    const names = new Set<string>();
    const reasons = new Set<string>();
    for (const [stop, name] of stops) {
      expect(mainLoopStopString(stop)).toBe(name);
      names.add(mainLoopStopString(stop));
      reasons.add(mainLoopStopReason(stop));
    }
    expect(names.size).toBe(stops.length);
    expect(reasons.size).toBe(stops.length);
  });

  // OCR v1.9.9: TestMainLoopStopUnknownValue
  test("TestMainLoopStopUnknownValue", () => {
    const unknown = 4 as MainLoopStop;
    expect(mainLoopStopString(unknown)).toBe("MainLoopStop(4)");
    expect(mainLoopStopReason(unknown)).toBe("main task stopped for an unrecognized reason (stop=4)");
    expect(mainLoopStopReason(unknown)).not.toBe(mainLoopStopReason(MainLoopStop.StopNone));
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/llmloop/{retry_background,retry_identity,runner}_test.go
// at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.

import { describe, expect, test } from "bun:test";

import {
  CompressionState,
  extractText,
  newTextMessage,
  partitionMessages,
  StripMarkdownFences,
  type Message,
  type ToolCall,
} from "../../../src/ocr/llmloop/compression.ts";
import { Runner } from "../../../src/ocr/llmloop/loop.ts";
import type {
  ChatRequest,
  ChatResponse,
  LlmTransport,
  RunnerDeps,
  ToolCallResult,
  ToolDef,
} from "../../../src/ocr/llmloop/types.ts";
import type { LlmComment } from "../../../src/ocr/model/types.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class CapturingTransport implements LlmTransport {
  readonly requests: ChatRequest[] = [];

  constructor(
    private readonly respond: (request: ChatRequest, signal: AbortSignal, call: number) => Promise<ChatResponse> | ChatResponse,
  ) {}

  async complete(signal: AbortSignal, request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    return this.respond(request, signal, this.requests.length - 1);
  }
}

function response(content = "", toolCalls: readonly ToolCall[] = []): ChatResponse {
  return { content, toolCalls };
}

const fileReadDef: ToolDef = { type: "function", function: { name: "file_read" } };
const taskDoneDef: ToolDef = { type: "function", function: { name: "task_done" } };
const codeCommentDef: ToolDef = { type: "function", function: { name: "code_comment" } };

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function collector(initial: readonly LlmComment[] = []): {
  readonly values: LlmComment[];
  add(comment: LlmComment): void;
  comments(): LlmComment[];
} {
  const values = [...initial];
  return {
    values,
    add(comment): void {
      values.push(comment);
    },
    comments(): LlmComment[] {
      return [...values];
    },
  };
}

function runnerDeps(
  transport: LlmTransport,
  overrides: Partial<RunnerDeps> = {},
): RunnerDeps {
  return {
    model: "fake",
    template: {
      MaxTokens: 1_000,
      MaxToolRequestTimes: 3,
      MaxCompletionTokens: 200,
    },
    llmClient: transport,
    mainToolDefs: [fileReadDef, taskDoneDef, codeCommentDef],
    commentCollector: collector(),
    toolRegistry: new Map(),
    ...overrides,
  };
}

function compressionConversation(): Message[] {
  const messages: Message[] = [newTextMessage("system", "sys"), newTextMessage("user", "prompt")];
  for (let i = 0; i < 10; i++) {
    messages.push(newTextMessage("assistant", "word ".repeat(100)));
    messages.push({ role: "tool", content: "data ".repeat(50) });
  }
  return messages;
}

interface RunnerInternals {
  runCompression(signal: AbortSignal, messages: Message[], filePath: string): Promise<Message[]>;
  addNextMessage(
    signal: AbortSignal,
    assistantContent: string,
    toolCalls: readonly ToolCall[],
    results: readonly ToolCallResult[],
    messages: Message[],
    filePath: string,
    state: CompressionState,
  ): Promise<boolean>;
  triggerAsyncCompression(state: CompressionState, messages: readonly Message[], filePath: string): void;
}

function internals(runner: Runner): RunnerInternals {
  return runner as unknown as RunnerInternals;
}

function compressionRunner(
  transport: LlmTransport,
  sessionId?: string,
): { readonly runner: Runner; readonly messages: Message[] } {
  const deps = runnerDeps(transport, {
    template: {
      MaxTokens: 50,
      MaxToolRequestTimes: 3,
      MaxCompletionTokens: 20,
      MemoryCompressionTask: { Messages: [newTextMessage("user", "Summarize: {{context}}")] },
    },
  });
  if (sessionId !== undefined) {
    return { runner: new Runner({ ...deps, sessionId }), messages: compressionConversation() };
  }
  return { runner: new Runner(deps), messages: compressionConversation() };
}

describe("ocr llmloop pending upstream runner tests", () => {
  // OCR v1.9.3: TestWaitBackground_JoinsCompressionBeforeFreeze
  test("WaitBackground joins an in-flight compression request", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const transport = new CapturingTransport(async () => {
      started.resolve();
      await release.promise;
      return response("compressed summary");
    });
    const { runner, messages } = compressionRunner(transport, "run");
    const state = new CompressionState();

    internals(runner).triggerAsyncCompression(state, messages, "test.go");
    await started.promise;

    let joined = false;
    const waiting = runner.WaitBackground().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);

    release.resolve();
    await waiting;
    expect(joined).toBe(true);
    expect(transport.requests).toHaveLength(1);
  });

  // OCR v1.9.3: TestWaitBackground_NoJobIsANoOp
  test("WaitBackground is repeatably safe without a job", async () => {
    const transport = new CapturingTransport(() => response());
    const runner = new Runner(runnerDeps(transport));

    await runner.WaitBackground();
    await runner.WaitBackground();

    expect(transport.requests).toHaveLength(0);
  });

  // OCR v1.9.3: TestReLocation_NoRequestWithoutTemplate
  test("empty relocation template creates no request", async () => {
    const comments = collector();
    const transport = new CapturingTransport(() => response("unused"));
    const runner = new Runner(runnerDeps(transport, {
      sessionId: "run",
      commentCollector: comments,
      template: { MaxTokens: 10_000, MaxToolRequestTimes: 3, ReLocationTask: { Messages: [] } },
      diffLookup: (path) => ({ newPath: path, newFileContent: "line one\nline two\n", diff: "@@ -1 +1 @@" }),
    }));

    await runner.executeToolCall(
      new AbortController().signal,
      "",
      toolCall("comment", "code_comment", {
        path: "other.go",
        comments: [{ content: "issue", existing_code: "no such code" }],
      }),
      "",
    );

    expect(transport.requests).toHaveLength(0);
    expect(comments.values).toHaveLength(1);
  });

  // OCR v1.9.3: TestRecordWarning
  test("warning records preserve insertion order and fields", () => {
    const runner = new Runner(runnerDeps(new CapturingTransport(() => response())));
    runner.RecordWarning("error", "main.go", "something went wrong");
    runner.RecordWarning("warn", "lib.go", "not great");

    expect(runner.Warnings()).toEqual([
      { type: "error", file: "main.go", message: "something went wrong" },
      { type: "warn", file: "lib.go", message: "not great" },
    ]);
  });

  // OCR v1.9.3: TestRecordToolCall
  test("tool-call counters aggregate by tool name", async () => {
    const comments = collector();
    const runner = new Runner(runnerDeps(new CapturingTransport(() => response()), {
      commentCollector: comments,
      toolRegistry: new Map([
        ["file_read", { name: "file_read", execute: () => "ok" }],
      ]),
    }));
    const signal = new AbortController().signal;

    await runner.executeToolCall(signal, "main.go", toolCall("r1", "file_read", {}), "");
    await runner.executeToolCall(signal, "main.go", toolCall("r2", "file_read", {}), "");
    await runner.executeToolCall(
      signal,
      "main.go",
      toolCall("c1", "code_comment", { comments: [{ content: "fix" }] }),
      "",
    );

    expect(Object.fromEntries(runner.ToolCalls())).toEqual({ file_read: 2, code_comment: 1 });
  });

  // OCR v1.9.3: TestRecordUsage
  test("usage records update all counters and nil is ignored", () => {
    const runner = new Runner(runnerDeps(new CapturingTransport(() => response())));
    runner.RecordUsage(null);
    expect(runner.TotalInputTokens()).toBe(0);

    runner.RecordUsage({ PromptTokens: 100, CompletionTokens: 50, CacheReadTokens: 10, CacheWriteTokens: 5 });

    expect(runner.TotalInputTokens()).toBe(100);
    expect(runner.TotalOutputTokens()).toBe(50);
    expect(runner.TotalCacheReadTokens()).toBe(10);
    expect(runner.TotalCacheWriteTokens()).toBe(5);
    expect(runner.TotalTokensUsed()).toBe(150);
  });

  // OCR v1.9.3: TestCollectPendingComments_NilPool
  test("pending comments return directly when no worker pool exists", async () => {
    const comments = collector([{ path: "a.go", content: "fix" }]);
    const runner = new Runner(runnerDeps(new CapturingTransport(() => response()), { commentCollector: comments }));

    const collected = await runner.CollectPendingComments();

    expect(collected).toHaveLength(1);
    expect(collected[0]?.path).toBe("a.go");
  });

  // OCR v1.9.3: TestCancelPendingCompression_NilJob
  test("canceling absent compression is a no-op", () => {
    const state = new CompressionState();
    state.cancelPendingCompression();
    expect(state.hasPendingJob()).toBe(false);
  });

  // OCR v1.9.3: TestCancelPendingCompression_WithJob
  test("canceling compression aborts and clears its job", async () => {
    const state = new CompressionState();
    const aborted = deferred<void>();
    state.triggerAsyncCompression([], "a.go", async (_snapshot, _path, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted.resolve();
          resolve();
        }, { once: true });
      });
      return [];
    });

    state.cancelPendingCompression();
    await aborted.promise;

    expect(state.hasPendingJob()).toBe(false);
  });

  // pi-reviewer: the background compression job deadline must abort with an
  // explicit reason so the failure log distinguishes it from other aborts.
  test("background compression job timeout aborts with an explicit reason", async () => {
    const state = new CompressionState();
    let observedReason: unknown;
    const worker = state.triggerAsyncCompression(
      [newTextMessage("user", "hello")],
      "a.go",
      (_snapshot, _path, signal) =>
        new Promise<Message[]>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedReason = (signal as AbortSignal & { reason?: unknown }).reason;
            reject(new Error("aborted"));
          }, { once: true });
        }),
      20, // test-only deadline override; production default is COMPRESSION_JOB_TIMEOUT_MS
    );
    expect(worker).not.toBeNull();
    await worker;
    expect(observedReason).toBeInstanceOf(Error);
    expect((observedReason as Error).message).toBe("memory compression task timed out");
    expect(state.hasPendingJob()).toBe(false);
  });

  // OCR v1.9.3: TestTryApplyPendingCompression_NilJob
  test("applying absent compression returns false", () => {
    const state = new CompressionState();
    const messages = [newTextMessage("user", "hi")];
    expect(state.tryApplyPendingCompression(messages)).toBe(false);
    expect(messages.map(extractText)).toEqual(["hi"]);
  });

  // OCR v1.9.3: TestTryApplyPendingCompression_NotDone
  test("applying unfinished compression returns false", () => {
    const state = new CompressionState();
    const gate = deferred<Message[]>();
    state.triggerAsyncCompression([], "a.go", () => gate.promise);
    const messages = [newTextMessage("user", "hi")];

    expect(state.tryApplyPendingCompression(messages)).toBe(false);
    expect(state.hasPendingJob()).toBe(true);
    state.cancelPendingCompression();
    gate.resolve([]);
  });

  // OCR v1.9.3: TestTryApplyPendingCompression_Applied
  test("completed compression applies and preserves post-snapshot suffix", async () => {
    const state = new CompressionState();
    const messages = [
      newTextMessage("system", "sys"),
      newTextMessage("user", "orig"),
      newTextMessage("assistant", "resp"),
    ];
    state.triggerAsyncCompression(messages, "a.go", async () => [
      newTextMessage("system", "sys"),
      newTextMessage("user", "compressed"),
    ]);
    await state.getPendingDone();
    messages.push({ role: "tool", content: "appended after snapshot" });

    expect(state.tryApplyPendingCompression(messages)).toBe(true);
    expect(messages.map(extractText)).toEqual(["sys", "compressed", "appended after snapshot"]);
    expect(state.hasPendingJob()).toBe(false);
  });

  // OCR v1.9.3: TestTryApplyPendingCompression_NilRebuilt
  test("completed compression with no rebuilt messages does not apply", async () => {
    const state = new CompressionState();
    const messages = [newTextMessage("user", "hi")];
    state.triggerAsyncCompression(messages, "a.go", async () => []);
    await state.getPendingDone();

    expect(state.tryApplyPendingCompression(messages)).toBe(false);
    expect(messages.map(extractText)).toEqual(["hi"]);
    expect(state.hasPendingJob()).toBe(false);
  });

  // OCR v1.9.3: TestPartitionMessages_CompressionNeeded
  test("partition identifies frozen, compressible, and active zones", () => {
    const messages: Message[] = [newTextMessage("system", "sys"), newTextMessage("user", "prompt")];
    for (let i = 0; i < 20; i++) {
      messages.push(newTextMessage("assistant", "word ".repeat(200)));
      messages.push({ role: "tool", content: "data ".repeat(100) });
    }

    const result = partitionMessages(messages, 500, 0);

    expect(result.frozenEnd).toBe(2);
    expect(result.activeCount).toBeGreaterThan(0);
    expect(result.compressEnd).toBeLessThan(messages.length);
    expect(result.compressEnd).toBeGreaterThan(result.frozenEnd);
  });

  // OCR v1.9.3: TestRunCompression_EmptyTemplate
  test("compression without a task template keeps only the frozen zone", async () => {
    const transport = new CapturingTransport(() => response("unused"));
    const runner = new Runner(runnerDeps(transport));
    const messages = [
      newTextMessage("system", "sys"),
      newTextMessage("user", "prompt"),
      newTextMessage("assistant", "response"),
    ];

    const rebuilt = await internals(runner).runCompression(new AbortController().signal, messages, "test.go");

    expect(rebuilt.map(extractText)).toEqual(["sys", "prompt"]);
    expect(transport.requests).toHaveLength(0);
  });

  // OCR v1.9.3: TestRunCompression_ShortMessages
  test("compression leaves a two-message conversation intact", async () => {
    const transport = new CapturingTransport(() => response("unused"));
    const { runner } = compressionRunner(transport);
    const messages = [newTextMessage("system", "sys"), newTextMessage("user", "prompt")];

    const rebuilt = await internals(runner).runCompression(new AbortController().signal, messages, "test.go");

    expect(rebuilt).toEqual(messages);
    expect(transport.requests).toHaveLength(0);
  });

  // OCR v1.9.3: TestRunCompression_Success
  test("successful compression embeds summary and records usage", async () => {
    const transport = new CapturingTransport(() => ({
      ...response("compressed summary"),
      usage: { PromptTokens: 100, CompletionTokens: 20, CacheReadTokens: 0, CacheWriteTokens: 0 },
    }));
    const { runner, messages } = compressionRunner(transport);

    const rebuilt = await internals(runner).runCompression(new AbortController().signal, messages, "test.go");

    expect(rebuilt.length).toBeGreaterThanOrEqual(2);
    expect(extractText(rebuilt[1] as Message)).toContain("<previous_review_summary>\ncompressed summary");
    expect(runner.TotalInputTokens()).toBe(100);
    expect(runner.TotalOutputTokens()).toBe(20);
    expect(extractText(transport.requests[0]?.messages[0] as Message)).toContain("<message id=\"0\" role=\"assistant\">");
  });

  // OCR v1.9.3: TestRunCompression_LLMError
  test("compression surfaces an LLM error without mutating messages", async () => {
    const transport = new CapturingTransport(() => {
      throw new DOMException("deadline exceeded", "TimeoutError");
    });
    const { runner, messages } = compressionRunner(transport);
    const before = messages.map(extractText);

    await expect(internals(runner).runCompression(new AbortController().signal, messages, "test.go")).rejects.toThrow(
      "deadline exceeded",
    );
    expect(messages.map(extractText)).toEqual(before);
  });

  // OCR v1.9.3: TestRunCompression_EmptySummary
  test("empty compression summary preserves the original conversation", async () => {
    const transport = new CapturingTransport(() => response(""));
    const { runner, messages } = compressionRunner(transport);

    const rebuilt = await internals(runner).runCompression(new AbortController().signal, messages, "test.go");

    expect(rebuilt).toEqual(messages);
  });

  // OCR v1.9.3: TestTriggerAsyncCompression
  test("async compression stores a completed rebuilt conversation", async () => {
    const transport = new CapturingTransport(() => response("async summary"));
    const { runner, messages } = compressionRunner(transport);
    const state = new CompressionState();

    internals(runner).triggerAsyncCompression(state, messages, "test.go");
    expect(state.hasPendingJob()).toBe(true);
    await runner.WaitBackground();

    expect(await state.awaitAndApply(messages)).toBe(true);
    expect(extractText(messages[1] as Message)).toContain("<previous_review_summary>\nasync summary");
  });

  // OCR v1.9.3: TestCompression_CrossFileIsolation
  test("one file cannot cancel, replace, or consume another file's compression", async () => {
    const stateA = new CompressionState();
    const stateB = new CompressionState();
    const release = deferred<void>();
    const started = deferred<void>();
    const messagesA = [newTextMessage("system", "sys"), newTextMessage("user", "file A")];
    const messagesB = [newTextMessage("system", "sys"), newTextMessage("user", "file B")];
    let calls = 0;

    stateA.triggerAsyncCompression(messagesA, "a.go", async () => {
      calls++;
      started.resolve();
      await release.promise;
      return [newTextMessage("system", "sys"), newTextMessage("user", "summary A")];
    });
    await started.promise;

    stateB.cancelPendingCompression();
    expect(stateB.tryApplyPendingCompression(messagesB)).toBe(false);
    expect(messagesB.map(extractText)).toEqual(["sys", "file B"]);
    expect(stateA.hasPendingJob()).toBe(true);

    stateA.triggerAsyncCompression(messagesA, "a.go", async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(1);

    release.resolve();
    await stateA.getPendingDone();
    messagesA.push({ role: "tool", content: "post-snapshot" });

    expect(stateB.tryApplyPendingCompression(messagesB)).toBe(false);
    expect(stateA.tryApplyPendingCompression(messagesA)).toBe(true);
    expect(messagesA.map(extractText)).toEqual(["sys", "summary A", "post-snapshot"]);
  });

  // OCR v1.9.3: TestAddNextMessage_NoStartThenCancelSameCall
  test("a threshold-crossing append performs one sync compression and starts no async job", async () => {
    const transport = new CapturingTransport(() => response("compressed summary"));
    const runner = new Runner(runnerDeps(transport, {
      template: {
        MaxTokens: 1_000,
        MaxToolRequestTimes: 3,
        MemoryCompressionTask: { Messages: [newTextMessage("user", "{{context}}") ] },
      },
    }));
    const messages: Message[] = [
      newTextMessage("system", "sys"),
      newTextMessage("user", "prompt"),
      newTextMessage("assistant", "a".repeat(2_500)),
      { role: "tool", content: "d".repeat(200) },
    ];
    const state = new CompressionState();

    const ok = await internals(runner).addNextMessage(
      new AbortController().signal,
      "b".repeat(300),
      [toolCall("c1", "file_read", { path: "f.go" })],
      [{ toolCallId: "c1", name: "file_read", result: "r".repeat(400) }],
      messages,
      "f.go",
      state,
    );

    expect(ok).toBe(true);
    expect(transport.requests).toHaveLength(1);
    expect(state.hasPendingJob()).toBe(false);
    expect(extractText(messages[1] as Message)).toContain("<previous_review_summary>");
  });

  // OCR v1.9.3: TestRunPerFile_ConcurrentFilesCompression_Race
  test("concurrent file loops exercise compression without sharing conversation state", async () => {
    const mainCalls = new Map<string, number>();
    let compressionCalls = 0;
    const transport = new CapturingTransport((request) => {
      if (!request.tools || request.tools.length === 0) {
        compressionCalls++;
        return response("compressed summary");
      }
      const key = request.sessionId ?? "missing";
      const call = mainCalls.get(key) ?? 0;
      mainCalls.set(key, call + 1);
      if (call === 0) {
        return response("x".repeat(4_000), [toolCall("read", "file_read", { path: "ignored.go" })]);
      }
      return response("", [toolCall("done", "task_done", { state: "DONE" })]);
    });
    const runner = new Runner(runnerDeps(transport, {
      sessionId: "run",
      template: {
        MaxTokens: 1_000,
        MaxToolRequestTimes: 2,
        MemoryCompressionTask: { Messages: [newTextMessage("user", "{{context}}") ] },
      },
      mainToolDefs: [fileReadDef, taskDoneDef],
      toolRegistry: new Map([
        ["file_read", { name: "file_read", execute: () => "package main\n" }],
      ]),
    }));

    const results = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      runner.RunPerFile(
        new AbortController().signal,
        [newTextMessage("system", "sys"), newTextMessage("user", "review")],
        `f${index}.go`,
      ),
    ));

    expect(results.every((result) => result.completed && result.error === undefined)).toBe(true);
    expect(compressionCalls).toBeGreaterThan(0);
    expect(mainCalls.size).toBe(4);
    expect([...mainCalls.values()]).toEqual([2, 2, 2, 2]);
  });

  // OCR v1.9.3: TestStripMarkdownFences_AdditionalCases
  test("markdown and XML fence labels are stripped", () => {
    expect(StripMarkdownFences("```markdown\ncontent\n```")).toBe("content");
    expect(StripMarkdownFences("```xml\n<tag/>\n```")).toBe("<tag/>");
  });
});

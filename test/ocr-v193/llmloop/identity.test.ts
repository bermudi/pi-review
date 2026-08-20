// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/llmloop/retry_identity_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.

import { describe, expect, test } from "bun:test";

import { Runner } from "../../../src/ocr-v193/llmloop/loop.ts";
import type { ChatRequest, ChatResponse, RequestMeta } from "../../../src/ocr-v193/llmloop/types.ts";
import { CompressionState, newTextMessage, type Message, type ToolCall } from "../../../src/ocr-v193/llmloop/compression.ts";
import { SessionHistory } from "../../../src/ocr-v193/session/history.ts";
import type { TaskType } from "../../../src/ocr-v193/session/history.ts";

type LlmTransport = {
  complete(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse>;
};

class CapturingTransport implements LlmTransport {
  readonly requests: Array<{ request: ChatRequest; meta: RequestMeta | undefined }> = [];

  constructor(
    private readonly respond: (call: number, req: ChatRequest, signal: AbortSignal) => ChatResponse | Promise<ChatResponse>,
  ) {}

  async complete(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse> {
    const meta = req.requestMeta;
    this.requests.push({ request: req, meta: meta ? { ...meta } : undefined });
    return this.respond(this.requests.length - 1, req, signal);
  }
}

function response(content = "", toolCalls: readonly ToolCall[] = []): ChatResponse {
  return { content, toolCalls };
}

function fileReadToolCall(id: string, args: string): ToolCall {
  return { id, type: "function", function: { name: "file_read", arguments: args } };
}

function taskDoneToolCall(id = "call_1", args = "{}"): ToolCall {
  return { id, type: "function", function: { name: "task_done", arguments: args } };
}

function metaFactory(provider: string, modelName: string): (filePath: string, taskType: TaskType, requestNo: number) => RequestMeta {
  return (filePath: string, taskType: TaskType, requestNo: number) => ({
    provider,
    model: modelName,
    filePath,
    taskType: String(taskType),
    requestNo,
  });
}

function wantMeta(actual: RequestMeta | undefined, want: RequestMeta): void {
  if (!actual) throw new Error(`request carried no identity, want ${JSON.stringify(want)}`);
  expect(actual).toEqual(want);
}

function makeSession(): SessionHistory {
  return new SessionHistory("/tmp/test-repo", "main", "fake", { reviewMode: "diff" });
}

function runnerDeps(
  transport: LlmTransport,
  overrides: Partial<import("../../../src/ocr-v193/llmloop/types.ts").RunnerDeps> = {},
): import("../../../src/ocr-v193/llmloop/types.ts").RunnerDeps {
  return {
    model: "fake",
    template: {
      MaxTokens: 100_000,
      MaxToolRequestTimes: 10,
      MaxCompletionTokens: 200,
    },
    llmClient: transport as unknown as import("../../../src/ocr-v193/llmloop/types.ts").AnyLlmClient,
    mainToolDefs: [
      { type: "function", function: { name: "file_read" } },
      { type: "function", function: { name: "task_done" } },
      { type: "function", function: { name: "code_comment" } },
    ],
    commentCollector: { add() {}, comments() { return []; } },
    toolRegistry: new Map(),
    ...overrides,
  } as unknown as import("../../../src/ocr-v193/llmloop/types.ts").RunnerDeps;
}

describe("ocr-v193 llmloop identity", () => {
  // OCR v1.9.3: TestRunPerFile_MainTaskIdentity
  test("main task rounds carry per-round RequestNo identity", async () => {
    for (const provider of ["openai", ""]) {
      const name = provider === "" ? "empty-provider" : provider;
      // Use fresh state per sub-case to avoid cross-contamination
      const transport = new CapturingTransport((n) => {
        if (n === 0) return response("", [fileReadToolCall("call_1", `{"path":"main.go"}`)]);
        return response("", [taskDoneToolCall()]);
      });
      const sess = makeSession();
      const deps = runnerDeps(transport, {
        session: sess,
        newRequestMeta: metaFactory(provider, "fake"),
      } as unknown as Partial<import("../../../src/ocr-v193/llmloop/types.ts").RunnerDeps>);
      // Also set legacy Session/NewRequestMeta for compatibility
      (deps as unknown as Record<string, unknown>)["Session"] = sess;
      (deps as unknown as Record<string, unknown>)["NewRequestMeta"] = metaFactory(provider, "fake");
      const runner = new Runner(deps);

      const result = await runner.RunPerFile(
        new AbortController().signal,
        [newTextMessage("user", "review this file")],
        "main.go",
      );
      if (result.error) throw result.error;

      const reqs = transport.requests;
      expect(reqs.length, `${name}: got ${reqs.length} requests, want 2`).toBe(2);
      for (let i = 0; i < reqs.length; i++) {
        const got = reqs[i]?.meta;
        wantMeta(got, {
          provider,
          model: "fake",
          filePath: "main.go",
          taskType: "main_task",
          requestNo: i + 1,
        });
      }

      // The report joins on these fields, so they must match the records the session actually wrote
      const fs = sess.GetOrCreateFileSession("main.go");
      const records = fs.taskRecords.get("main_task" as TaskType) ?? [];
      expect(records.length, `${name}: session holds ${records.length} main_task records, want 2`).toBe(2);
      for (let i = 0; i < records.length; i++) {
        const rec = records[i]!;
        const meta = reqs[i]?.meta;
        expect(meta?.requestNo, `${name} request ${i}: meta RequestNo`).toBe(rec.requestNo);
      }
    }
  });

  // OCR v1.9.3: TestRunPerFile_NoIdentityWhenFactoryNil
  test("scan mode carries no identity when factory is nil", async () => {
    const transport = new CapturingTransport(() => response("", [taskDoneToolCall()]));
    const sess = makeSession();
    const deps = runnerDeps(transport, {
      session: sess,
      // newRequestMeta intentionally unset, as scan leaves it
    } as unknown as Partial<import("../../../src/ocr-v193/llmloop/types.ts").RunnerDeps>);
    (deps as unknown as Record<string, unknown>)["Session"] = sess;
    // Ensure factory is undefined
    delete (deps as unknown as Record<string, unknown>)["newRequestMeta"];
    delete (deps as unknown as Record<string, unknown>)["NewRequestMeta"];
    const runner = new Runner(deps);

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review this file")],
      "main.go",
    );
    if (result.error) throw result.error;

    const reqs = transport.requests;
    expect(reqs.length).toBe(1);
    expect(reqs[0]?.meta, "scan request carried identity, want none").toBeUndefined();
  });

  // OCR v1.9.3: TestRunCompression_Identity
  test("compression request carries memory_compression identity", async () => {
    const summary = "compressed summary";
    const transport = new CapturingTransport(() => response(summary));
    const sess = makeSession();
    const deps = runnerDeps(transport, {
      session: sess,
      newRequestMeta: metaFactory("openai", "fake"),
      template: {
        MaxTokens: 50,
        MaxToolRequestTimes: 3,
        MaxCompletionTokens: 20,
        MemoryCompressionTask: { Messages: [newTextMessage("user", "Summarize: {{context}}")] },
      },
    } as unknown as Partial<import("../../../src/ocr-v193/llmloop/types.ts").RunnerDeps>);
    (deps as unknown as Record<string, unknown>)["Session"] = sess;
    (deps as unknown as Record<string, unknown>)["NewRequestMeta"] = metaFactory("openai", "fake");
    const runner = new Runner(deps);
    const messages: Message[] = [newTextMessage("system", "sys"), newTextMessage("user", "prompt")];
    for (let i = 0; i < 10; i++) {
      messages.push(newTextMessage("assistant", "word ".repeat(100)));
      messages.push({ role: "tool", content: "data ".repeat(50) });
    }

    const internals = runner as unknown as {
      runCompression(signal: AbortSignal, messages: Message[], filePath: string): Promise<Message[]>;
    };
    await internals.runCompression(new AbortController().signal, messages, "test.go");

    const reqs = transport.requests;
    expect(reqs.length).toBe(1);
    wantMeta(reqs[0]?.meta, {
      provider: "openai",
      model: "fake",
      filePath: "test.go",
      taskType: "memory_compression_task",
      requestNo: 1,
    });
    const fs = sess.GetOrCreateFileSession("test.go");
    const recs = fs.taskRecords.get("memory_compression_task" as TaskType) ?? [];
    expect(recs.length).toBe(1);
  });

  // OCR v1.9.3: TestRunCompression_NoIdentityWhenFactoryNil
  test("scan compression carries no identity when factory is nil", async () => {
    const summary = "compressed summary";
    const transport = new CapturingTransport(() => response(summary));
    const sess = makeSession();
    const deps = runnerDeps(transport, {
      session: sess,
      template: {
        MaxTokens: 50,
        MaxToolRequestTimes: 3,
        MaxCompletionTokens: 20,
        MemoryCompressionTask: { Messages: [newTextMessage("user", "Summarize: {{context}}")] },
      },
    } as unknown as Partial<import("../../../src/ocr-v193/llmloop/types.ts").RunnerDeps>);
    (deps as unknown as Record<string, unknown>)["Session"] = sess;
    delete (deps as unknown as Record<string, unknown>)["newRequestMeta"];
    delete (deps as unknown as Record<string, unknown>)["NewRequestMeta"];
    const runner = new Runner(deps);
    const messages: Message[] = [newTextMessage("system", "sys"), newTextMessage("user", "prompt")];
    for (let i = 0; i < 10; i++) {
      messages.push(newTextMessage("assistant", "word ".repeat(100)));
      messages.push({ role: "tool", content: "data ".repeat(50) });
    }
    const internals = runner as unknown as {
      runCompression(signal: AbortSignal, messages: Message[], filePath: string): Promise<Message[]>;
    };
    await internals.runCompression(new AbortController().signal, messages, "test.go");

    const reqs = transport.requests;
    expect(reqs.length).toBe(1);
    expect(reqs[0]?.meta, "scan compression carried identity, want none").toBeUndefined();
  });

  // OCR v1.9.3: TestReLocation_Identity
  test("relocation request identity follows comment path", async () => {
    const collectorValues: Array<{ path: string }> = [];
    const collector = {
      add(c: { path: string }) { collectorValues.push(c); },
      comments() { return [...collectorValues]; },
    };
    const reply = "cannot find it";
    const transport = new CapturingTransport(() => response(reply));
    const sess = makeSession();
    const runner = new Runner(
      runnerDeps(transport, {
        session: sess,
        newRequestMeta: metaFactory("openai", "fake"),
        commentCollector: collector as unknown as import("../../../src/ocr-v193/llmloop/types.ts").CommentCollectorLike,
        toolRegistry: new Map(),
        diffLookup: (path: string) => ({ newPath: path, newFileContent: "line one\nline two\n", diff: "@@ -1 +1 @@" }) as unknown as import("../../../src/ocr-v193/llmloop/types.ts").DiffLike,
        template: {
          MaxTokens: 10000,
          MaxToolRequestTimes: 3,
          ReLocationTask: { Messages: [newTextMessage("user", "relocate {suggestion_content} in {diff} near {existing_code}")] },
        },
      } as unknown as Partial<import("../../../src/ocr-v193/llmloop/types.ts").RunnerDeps>),
    );
    (runner as unknown as Record<string, unknown>)["deps"] = {
      ...(runner as unknown as Record<string, unknown>)["deps"] as object,
      Session: sess,
      NewRequestMeta: metaFactory("openai", "fake"),
    };
    // Inject Session/NewRequestMeta via deps object mutation for test parity
    const depsAny = (runner as unknown as { deps: Record<string, unknown> }).deps;
    depsAny["session"] = sess;
    depsAny["Session"] = sess;
    depsAny["newRequestMeta"] = metaFactory("openai", "fake");
    depsAny["NewRequestMeta"] = metaFactory("openai", "fake");

    const cp = await runner.executeToolCall(
      new AbortController().signal,
      "",
      { id: "call_1", type: "function", function: { name: "code_comment", arguments: `{"path":"other.go","comments":[{"content":"issue","existing_code":"no such code"}]}` } },
      "",
    );

    expect(cp.data).toBe("Successfully commented.");

    const reqs = transport.requests;
    expect(reqs.length).toBe(1);
    wantMeta(reqs[0]?.meta, {
      provider: "openai",
      model: "fake",
      filePath: "other.go",
      taskType: "re_location_task",
      requestNo: 1,
    });
    const fs = sess.GetOrCreateFileSession("other.go");
    const recs = fs.taskRecords.get("re_location_task" as TaskType) ?? [];
    expect(recs.length).toBe(1);
  });
});

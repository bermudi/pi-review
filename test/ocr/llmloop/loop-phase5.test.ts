// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/llmloop/loop_execute_test.go and loop_execute_more_test.go
// at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; covers the Phase 5 pipeline:
// - code_comment parse/validation
// - tracking via DiffLookup + resolver
// - relocation retry (ReLocationTask)
// - async per-file draining via CommentWorkerPool
// - suggestion handling, thinking backfill, deterministic ordering

import { describe, test, expect } from "bun:test";
import { Runner, MainLoopStop } from "../../../src/ocr/llmloop/loop.js";
import { ScriptedTransport } from "../../../src/ocr/llmloop/transcript.js";
import { CommentWorkerPool } from "../../../src/ocr/llmloop/pool.js";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import type { LlmComment } from "../../../src/ocr/model/types.js";
import type { Message } from "../../../src/ocr/llmloop/compression.js";
import { newTextMessage } from "../../../src/ocr/llmloop/compression.js";
import type { ToolDef } from "../../../src/ocr/llmloop/types.js";

function makeCollector(): CommentCollector {
  return new CommentCollector();
}

function makeRunner(opts: {
  responses: ConstructorParameters<typeof ScriptedTransport>[0];
  collector?: CommentCollector;
  pool?: CommentWorkerPool;
  diffLookup?: (path: string) => Diff | null;
  reLocationTask?: { messages: readonly { role: string; content: string }[] } | null;
  templateOverrides?: Record<string, unknown>;
  mainToolDefs?: readonly ToolDef[];
}): { runner: Runner; transport: ScriptedTransport; collector: CommentCollector } {
  const collector = opts.collector ?? makeCollector();
  const transport = new ScriptedTransport(opts.responses as unknown as never);
  const adapter: any = {
    complete: (signal: AbortSignal, req: unknown) => (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(req as unknown, signal as unknown),
    CompletionsWithCtx: (signal: AbortSignal, req: unknown) => (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(req as unknown, signal as unknown),
  };
  const template: Record<string, unknown> = {
    MaxTokens: 128000,
    MaxToolRequestTimes: 30,
    MaxCompletionTokens: 4096,
    MemoryCompressionTask: { Messages: [] },
    ...opts.templateOverrides,
  };
  if (opts.reLocationTask !== undefined) {
    (template as Record<string, unknown>)["ReLocationTask"] = opts.reLocationTask;
  }
  const runner = new Runner({
    model: "test-model",
    template: template as unknown as never,
    llmClient: adapter,
    mainToolDefs: opts.mainToolDefs ?? [
      { type: "function", function: { name: "code_comment" } },
      { type: "function", function: { name: "task_done" } },
    ],
    commentCollector: collector as unknown as never,
    commentWorkerPool: opts.pool as unknown as never,
    diffLookup: opts.diffLookup as unknown as never,
  } as unknown as never);
  return { runner, transport, collector };
}

describe("ocr loop Phase 5 — comment processing", () => {
  // OCR v1.9.3: TestExecuteToolCall_CodeCommentDiffResolved
  test("code_comment diff resolved sync → startLine populated", async () => {
    const collector = makeCollector();
    const diffLookup = (path: string): Diff | null => {
      if (path === "a.go") {
        return {
          oldPath: "a.go",
          newPath: "a.go",
          diff: `diff --git a/a.go b/a.go\n@@ -1,3 +1,3 @@\n line1\n-line2 old\n+line2 new\n line3\n`,
          newFileContent: "line1\nline2 new\nline3\n",
          isBinary: false,
          isDeleted: false,
          isNew: false,
          isRenamed: false,
          insertions: 1,
          deletions: 1,
        };
      }
      return null;
    };
    const { runner } = makeRunner({
      collector,
      diffLookup,
      responses: [
        {
          toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "issue", existing_code: "line2 old" }] }) }],
        },
        { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });
    const res = await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "review a.go")], "a.go");
    expect(res.completed).toBe(true);
    const comments = collector.Comments();
    expect(comments.length).toBe(1);
    // Should have resolved via hunk (old side) to line 2
    expect(comments[0]!.startLine).toBe(2);
    expect(comments[0]!.endLine).toBe(2);
    expect(comments[0]!.content).toBe("issue");
  });

  // Local regression: relocation retry succeeds with an LLM-provided code block.
  test("code_comment relocation retry success", async () => {
    const collector = makeCollector();
    const diffForA: Diff = {
      oldPath: "a.go",
      newPath: "a.go",
      diff: `@@ -10,6 +10,8 @@\n import "fmt"\n\n func main() {\n+    x := 1\n+    y := 2\n     fmt.Println("hello")\n }\n`,
      newFileContent: "",
      isBinary: false,
      isDeleted: false,
      isNew: false,
      isRenamed: false,
      insertions: 2,
      deletions: 0,
    };
    const diffLookup = (p: string) => (p === "a.go" ? diffForA : null);
    // Relocation task template
    const reLocationTask = {
      messages: [
        { role: "system", content: "relocate" },
        { role: "user", content: "diff:\n{diff}\ncode:\n{existing_code}\nsuggestion:\n{suggestion_content}" },
      ],
    };
    const { runner, transport } = makeRunner({
      collector,
      diffLookup,
      reLocationTask,
      responses: [
        // First turn: code_comment with wrong existing_code (won't match)
        {
          toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "bad loc", existing_code: "WRONG CODE" }] }) }],
        },
        // Second turn for relocation: LLM returns correct code block
        {
          content: "```go\nx := 1\ny := 2\n```",
        },
        // Third turn: task_done
        {
          toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }],
        },
      ],
    });
    const res = await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "review")], "a.go");
    expect(res.completed).toBe(true);
    // Transport should have gotten 2 requests before task_done? Actually relocation is an extra LLM call inside executeToolCall, so total requests = 1 (initial code_comment) + 1 (relocation) + 1 (task_done) = 3
    expect(transport.requests.length).toBe(3);
    const comments = collector.Comments();
    expect(comments.length).toBe(1);
    // After relocation, existingCode should have been replaced with "x := 1\ny := 2" and resolved
    expect(comments[0]!.existingCode).toBe("x := 1\ny := 2");
    expect(comments[0]!.startLine).toBeGreaterThan(0);
  });

  // Local regression: failed relocation preserves the original existing_code.
  test("code_comment relocation still unresolvable → original preserved", async () => {
    const collector = makeCollector();
    const diffForA: Diff = {
      oldPath: "a.go",
      newPath: "a.go",
      diff: `@@ -1,1 +1,1 @@\n-old\n+new\n`,
      newFileContent: "",
      isBinary: false,
      isDeleted: false,
      isNew: false,
      isRenamed: false,
      insertions: 1,
      deletions: 1,
    };
    const diffLookup = (p: string) => (p === "a.go" ? diffForA : null);
    const reLocationTask = {
      messages: [{ role: "user", content: "diff:{diff} code:{existing_code} suggestion:{suggestion_content}" }],
    };
    const { runner } = makeRunner({
      collector,
      diffLookup,
      reLocationTask,
      responses: [
        {
          toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "x", existing_code: "WRONG" }] }) }],
        },
        {
          content: "```go\nstill_wrong\n```",
        },
        { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });
    const res = await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "a.go");
    expect(res.completed).toBe(true);
    const comments = collector.Comments();
    expect(comments.length).toBe(1);
    expect(comments[0]!.existingCode).toBe("WRONG");
    expect(comments[0]!.startLine ?? 0).toBe(0);
  });

  // Local regression: absent relocation task does not make an extra model request.
  test("code_comment without reLocationTask does not call relocation LLM", async () => {
    const collector = makeCollector();
    const diffLookup = (): Diff => ({
      oldPath: "a.go",
      newPath: "a.go",
      diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
      newFileContent: "",
      isBinary: false,
      isDeleted: false,
      isNew: false,
      isRenamed: false,
      insertions: 1,
      deletions: 1,
    });
    const { runner, transport } = makeRunner({
      collector,
      diffLookup: diffLookup as unknown as (p: string) => Diff | null,
      reLocationTask: null,
      responses: [
        { toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "x", existing_code: "WRONG" }] }) }] },
        { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });
    const res = await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "a.go");
    expect(res.completed).toBe(true);
    // Only 2 requests: code_comment + task_done, no relocation
    expect(transport.requests.length).toBe(2);
    expect(collector.Comments()[0]!.existingCode).toBe("WRONG");
  });

  // OCR v1.9.3: TestRunPerFile_BackfillsThinkingFromReasoningContent
  // OCR v1.9.3: TestExecuteToolCall_CodeCommentThinkingBackfill
  test("thinking backfill: reasoningContent propagated", async () => {
    const collector = makeCollector();
    const { runner } = makeRunner({
      collector,
      responses: [
        {
          reasoningContent: "turn reasoning",
          toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "a", existing_code: "x" }, { content: "b", existing_code: "y", thinking: "explicit" }] }) }],
        },
        { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });
    const res = await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "a.go");
    expect(res.completed).toBe(true);
    const cs = collector.Comments();
    expect(cs.length).toBe(2);
    expect(cs[0]!.thinking).toBe("turn reasoning");
    expect(cs[1]!.thinking).toBe("explicit");
  });

  // OCR v1.9.3: TestRunPerFile_NoFallbackToContent
  test("assistant content does not backfill comment thinking", async () => {
    const collector = makeCollector();
    const { runner } = makeRunner({
      collector,
      responses: [
        {
          content: "I'll now leave a comment on this file",
          toolCalls: [
            {
              id: "comment-1",
              name: "code_comment",
              arguments: JSON.stringify({ comments: [{ content: "issue", existing_code: "x" }] }),
            },
          ],
        },
        { toolCalls: [{ id: "done-1", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review")],
      "file.go",
    );

    expect(result.completed).toBe(true);
    expect(collector.Comments()).toHaveLength(1);
    expect(collector.Comments()[0]!.thinking).toBe("");
  });

  // OCR v1.9.3: TestExecuteToolCall_CodeCommentNoReasoning
  test("code_comment keeps thinking empty without reasoning content", async () => {
    const collector = makeCollector();
    const { runner } = makeRunner({ collector, responses: [] });

    const result = await runner.executeToolCall(
      new AbortController().signal,
      "file.go",
      {
        id: "comment-1",
        type: "function",
        function: {
          name: "code_comment",
          arguments: JSON.stringify({ comments: [{ content: "issue", existing_code: "x" }] }),
        },
      } as never,
      "",
    );

    expect(result.data).toBe("Successfully commented.");
    expect(collector.Comments()).toHaveLength(1);
    expect(collector.Comments()[0]!.thinking).toBe("");
  });

  // Local regression: multiline suggestion_code survives comment collection.
  test("suggestion_code preserved and multiline", async () => {
    const collector = makeCollector();
    const { runner } = makeRunner({
      collector,
      responses: [
        {
          toolCalls: [
            {
              id: "1",
              name: "code_comment",
              arguments: JSON.stringify({
                comments: [{ content: "fix", existing_code: "old", suggestion_code: "new\nmultiline" }],
              }),
            },
          ],
        },
        { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });
    await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "a.go");
    const c = collector.Comments()[0]!;
    expect(c.suggestionCode).toBe("new\nmultiline");
    expect(c.existingCode).toBe("old");
    expect(c.content).toBe("fix");
  });

  // OCR v1.9.3: TestExecuteToolCall_CodeCommentAsyncPool
  test("async per-file draining via CommentWorkerPool: comments visible after AwaitKey", async () => {
    const collector = makeCollector();
    const pool = new CommentWorkerPool(2);
    const { runner } = makeRunner({
      collector,
      pool,
      responses: [
        {
          toolCalls: [
            { id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "issue1", existing_code: "a" }] }) },
            { id: "2", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "issue2", existing_code: "b" }] }) },
          ],
        },
        { toolCalls: [{ id: "3", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });
    const res = await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "file.go");
    expect(res.completed).toBe(true);
    // Comments are submitted async; before drain they may be empty, after AwaitKey they should be 2
    // Our loop's code_comment used pool.SubmitFor, so we need to await
    await pool.AwaitKey("file.go");
    const cs = collector.Comments();
    expect(cs.length).toBe(2);
    // Drain global as well
    await pool.Await();
    expect(pool.workerCount).toBe(2);
  });

  // Local regression: per-file worker drains stay isolated under concurrent submissions.
  test("concurrent isolation: two files each have own AwaitKey", async () => {
    const collectorA = makeCollector();
    const collectorB = makeCollector();
    const pool = new CommentWorkerPool(2);
    // Use same pool for both runners to simulate concurrent files sharing worker pool
    const { runner: ra } = makeRunner({ collector: collectorA, pool, responses: [{ toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "a1", existing_code: "x" }] }) }] }, { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] }] });
    const { runner: rb } = makeRunner({ collector: collectorB, pool, responses: [{ toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "b1", existing_code: "y" }] }) }] }, { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] }] });
    // Run concurrently
    const pA = ra.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "a.go");
    const pB = rb.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "b.go");
    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA.completed).toBe(true);
    expect(rB.completed).toBe(true);
    await pool.AwaitKey("a.go");
    await pool.AwaitKey("b.go");
    expect(collectorA.Comments().length).toBe(1);
    expect(collectorB.Comments().length).toBe(1);
    expect(collectorA.Comments()[0]!.path).toBe("a.go");
    expect(collectorB.Comments()[0]!.path).toBe("b.go");
  });

  // Local regression: same-file asynchronous comments retain submission order.
  test("deterministic ordering preserved for same file multiple comments", async () => {
    const collector = makeCollector();
    const { runner } = makeRunner({
      collector,
      responses: [
        {
          toolCalls: [
            { id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "first", existing_code: "a" }, { content: "second", existing_code: "b" }] }) },
          ],
        },
        { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });
    await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "a.go");
    const cs = collector.Comments();
    expect(cs.length).toBe(2);
    expect(cs[0]!.content).toBe("first");
    expect(cs[1]!.content).toBe("second");
  });

  // Local regression: code_comment processing accepts old-side resolver matches.
  test("deleted/context lines: resolver matches deleted line via old-side", async () => {
    // This tests resolver's ability to match context + deleted lines (old-side fallback not tested directly here, but via resolveLineNumbers we already did)
    // Here we just ensure loop doesn't break on such diff
    const collector = makeCollector();
    const diffLookup = (p: string): Diff | null => {
      if (p === "handler.go") {
        return {
          oldPath: "handler.go",
          newPath: "handler.go",
          diff: `@@ -10,7 +10,7 @@\n ctx := r.Context()\n-    log.Print("handling request")\n+    log.Printf("handling request")\n err := process(ctx)`,
          newFileContent: "",
          isBinary: false,
          isDeleted: false,
          isNew: false,
          isRenamed: false,
          insertions: 1,
          deletions: 1,
        };
      }
      return null;
    };
    const { runner } = makeRunner({
      collector,
      diffLookup,
      responses: [
        { toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "x", existing_code: `    log.Print("handling request")` }] }) }] },
        { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] },
      ],
    });
    const res = await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "handler.go");
    expect(res.completed).toBe(true);
    expect(collector.Comments()[0]!.startLine).toBeGreaterThan(0);
  });

  // ---- Ported from internal/llmloop/loop_execute_test.go ----
  // OCR v1.9.3: TestExecuteToolCall_DynamicNotRegistered
  test("ExecuteToolCall_DynamicNotRegistered", async () => {
    const { runner, transport } = makeRunner({
      responses: [{ toolCalls: [{ id: "1", name: "unknown_tool", arguments: "{}" }] }, { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] }],
    });
    const res = await runner.executeToolCall(new AbortController().signal, "a.go", { id: "1", type: "function", function: { name: "unknown_tool", arguments: "{}" } } as unknown as never, "");
    expect(res.data).toContain("Tool not found");
    expect(transport.requests.length).toBe(0);
  });

  // OCR v1.9.3: TestExecuteToolCall_DynamicExecuteError
  test("ExecuteToolCall_DynamicExecuteError", async () => {
    const collector = makeCollector();
    // Create a runner with a tool that throws
    const transport = new ScriptedTransport([] as unknown as never);
    const failingTool = { name: "file_read", execute: async () => { throw new Error("read failed"); } };
    const template: Record<string, unknown> = { MaxTokens: 128000, MaxToolRequestTimes: 5, MaxCompletionTokens: 4096, MemoryCompressionTask: { Messages: [] } };
    const runner2 = new Runner({
      model: "test-model",
      template: template as unknown as never,
      llmClient: transport as unknown as never,
      mainToolDefs: [{ type: "function", function: { name: "file_read", description: "" } }] as unknown as readonly ToolDef[],
      commentCollector: collector as unknown as never,
      toolRegistry: { get: (n: string) => (n === "file_read" ? failingTool : undefined) } as unknown as never,
    } as unknown as never);
    const res = await runner2.executeToolCall(new AbortController().signal, "a.go", { id: "1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "missing.go" }) } } as unknown as never, "");
    expect(res.data).toContain("Error executing tool file_read");
  });

  // OCR v1.9.3: TestExecuteToolCall_DynamicSuccessRecordsResult
  test("ExecuteToolCall_DynamicSuccessRecordsResult", async () => {
    const collector = makeCollector();
    const transport = new ScriptedTransport([] as unknown as never);
    const okTool = { name: "file_read", execute: async () => "file content" };
    const template: Record<string, unknown> = { MaxTokens: 128000, MaxToolRequestTimes: 5, MaxCompletionTokens: 4096, MemoryCompressionTask: { Messages: [] } };
    const runner2 = new Runner({
      model: "test-model",
      template: template as unknown as never,
      llmClient: transport as unknown as never,
      mainToolDefs: [{ type: "function", function: { name: "file_read", description: "" } }] as unknown as readonly ToolDef[],
      commentCollector: collector as unknown as never,
      toolRegistry: { get: (n: string) => (n === "file_read" ? okTool : undefined) } as unknown as never,
    } as unknown as never);
    const res = await runner2.executeToolCall(new AbortController().signal, "a.go", { id: "1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "a.go" }) } } as unknown as never, "");
    expect(res.data).toBe("file content");
  });

  // OCR v1.9.3: TestExecuteToolCall_KnownToolNotRegistered
  test("known but unregistered tools return the unavailable result", async () => {
    const { runner } = makeRunner({
      mainToolDefs: [
        { type: "function", function: { name: "code_comment" } },
        { type: "function", function: { name: "task_done" } },
        { type: "function", function: { name: "file_read" } },
      ],
      responses: [],
    });

    const result = await runner.executeToolCall(
      new AbortController().signal,
      "file.go",
      {
        id: "read-1",
        type: "function",
        function: { name: "file_read", arguments: JSON.stringify({ path: "x" }) },
      } as never,
      "",
    );

    expect(result).toEqual({
      data: "Error: Tool not found. The tool you attempted to call does not exist or is not available. Please check the tool name and try again with a valid tool.",
      completed: false,
      failed: false,
    });
  });

  // OCR v1.9.3: TestExecuteToolCall_DynamicParseError
  test("ExecuteToolCall_DynamicParseError", async () => {
    const { runner } = makeRunner({ responses: [] });
    const res = await runner.executeToolCall(new AbortController().signal, "a.go", { id: "1", type: "function", function: { name: "code_comment", arguments: "not-json" } } as unknown as never, "");
    expect(res.data).toContain("Error parsing tool arguments");
  });

  // OCR v1.9.3: TestCollectPendingComments_AwaitsPool
  test("CollectPendingComments_AwaitsPool", async () => {
    const collector = makeCollector();
    const pool = new CommentWorkerPool(1);
    const { runner } = makeRunner({ collector, pool, responses: [{ toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ comments: [{ content: "x", existing_code: "a" }] }) }] }, { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] }] });
    await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "a.go");
    // collectPendingComments should await pool
    const pending = await runner.collectPendingComments();
    expect(pending.length).toBe(1);
    await pool.Await();
  });

  // OCR v1.9.3: TestExecuteToolCall_CodeCommentOverridesHallucinatedPath
  test("ExecuteToolCall_CodeCommentOverridesHallucinatedPath", async () => {
    const collector = makeCollector();
    const { runner } = makeRunner({
      collector,
      responses: [{ toolCalls: [{ id: "1", name: "code_comment", arguments: JSON.stringify({ path: "hallucinated.go", comments: [{ content: "x", existing_code: "a" }] }) }] }, { toolCalls: [{ id: "2", name: "task_done", arguments: JSON.stringify({ state: "DONE" }) }] }],
    });
    await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "real.go");
    const cs = collector.Comments();
    expect(cs[0]!.path).toBe("real.go");
  });

  // OCR v1.9.3: TestExecuteToolCall_TaskDone
  test("ExecuteToolCall_TaskDone handling", async () => {
    const { runner } = makeRunner({ responses: [] });
    const ok = await runner.executeToolCall(new AbortController().signal, "a.go", { id: "1", type: "function", function: { name: "task_done", arguments: JSON.stringify({ state: "DONE" }) } } as unknown as never, "");
    expect(ok.completed).toBe(true);
    const failed = await runner.executeToolCall(new AbortController().signal, "a.go", { id: "1", type: "function", function: { name: "task_done", arguments: JSON.stringify({ state: "FAILED" }) } } as unknown as never, "");
    expect(failed.failed).toBe(true);
    const invalid = await runner.executeToolCall(new AbortController().signal, "a.go", { id: "1", type: "function", function: { name: "task_done", arguments: JSON.stringify({ state: "UNKNOWN" }) } } as unknown as never, "");
    expect(invalid.completed).toBe(false);
    expect(invalid.data).toContain("invalid");
  });
});

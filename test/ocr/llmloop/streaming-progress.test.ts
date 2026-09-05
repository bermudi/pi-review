// SPDX-License-Identifier: Apache-2.0
// Streaming progress must keep idle timers alive. A single slow request
// (long thinking) emits chunks for minutes before any final response; those
// chunks prove the model is still working and must reset both the per-file
// watchdog and the compression job timer.

import { test, expect } from "bun:test";
import { newTextMessage } from "../../../src/ocr/llmloop/compression.js";
import { CompressionState } from "../../../src/ocr/llmloop/compression.js";
import { Runner } from "../../../src/ocr/llmloop/loop.js";
import type { Template, ToolDef } from "../../../src/ocr/llmloop/types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("PiTransport reports streaming chunks as progress", async () => {
  const { PiTransport } = await import("../../../src/ocr/pi-adapter/pi-transport.js");
  let listener: ((e: unknown) => void) | undefined;
  const session = {
    agent: { state: { messages: [] as unknown[] } },
    isIdle: true,
    setActiveToolsByName: () => {},
    getActiveToolNames: () => [],
    subscribe: (next: (e: unknown) => void) => {
      listener = next;
      return () => {};
    },
    prompt: async () => {
      listener?.({ type: "message_start", message: { role: "assistant", content: [] } });
      listener?.({ type: "message_update", message: { role: "assistant", content: [] } });
      listener?.({ type: "message_update", message: { role: "assistant", content: [] } });
      listener?.({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      });
    },
    waitForIdle: async () => {},
    abort: async () => {},
  };
  const transport = new PiTransport(session as never);
  let progress = 0;
  const res = await transport.complete(
    {
      model: "m",
      messages: [newTextMessage("user", "hi")],
      maxTokens: 10,
      onProgress: () => {
        progress++;
      },
    } as never,
    new AbortController().signal as never,
  );
  expect(res.content).toBe("done");
  expect(progress).toBe(3);
});

test("Runner forwards file activity as transport progress", async () => {
  let observedProgress: (() => void) | undefined;
  const adapter = {
    complete: async (signal: AbortSignal, req: unknown): Promise<unknown> => {
      void signal;
      observedProgress = (req as { onProgress?: () => void }).onProgress;
      // Simulate streaming work mid-request.
      (req as { onProgress?: () => void }).onProgress?.();
      return {
        content: "",
        toolCalls: [{ id: "d1", type: "function", function: { name: "task_done", arguments: "{}" } }],
      };
    },
    CompletionsWithCtx: async (signal: AbortSignal, req: unknown): Promise<unknown> => {
      void signal;
      observedProgress = (req as { onProgress?: () => void }).onProgress;
      (req as { onProgress?: () => void }).onProgress?.();
      return {
        content: "",
        toolCalls: [{ id: "d1", type: "function", function: { name: "task_done", arguments: "{}" } }],
      };
    },
  };
  const runner = new Runner({
    model: "test",
    template: { MaxTokens: 4000, MaxToolRequestTimes: 5, MaxCompletionTokens: 1000 } as unknown as Template,
    llmClient: adapter as unknown as never,
    mainToolDefs: [{ type: "function", function: { name: "task_done" } }] as unknown as readonly ToolDef[],
  } as unknown as ConstructorParameters<typeof Runner>[0]);

  let activity = 0;
  const res = await runner.RunPerFile(new AbortController().signal, [newTextMessage("user", "hi")], "a.go", () => {
    activity++;
  });
  expect(res.completed).toBe(true);
  // Once mid-request via onProgress, once after response.
  expect(activity).toBe(2);
  expect(observedProgress).toBeDefined();
  await runner.waitBackground();
});

test("compression job survives when compressor reports progress", async () => {
  const state = new CompressionState();
  const worker = state.triggerAsyncCompression(
    [newTextMessage("user", "a"), newTextMessage("user", "b")],
    "a.go",
    async (_snapshot, _path, signal, onProgress) => {
      // 150ms of work with a 50ms idle budget: only survives via progress.
      for (let i = 0; i < 5; i++) {
        if (signal.aborted) throw (signal as AbortSignal & { reason?: unknown }).reason ?? new Error("aborted");
        await sleep(30);
        onProgress?.();
      }
      if (signal.aborted) throw (signal as AbortSignal & { reason?: unknown }).reason ?? new Error("aborted");
      return [newTextMessage("user", "rebuilt")];
    },
    50,
  );
  expect(worker).not.toBeNull();
  await worker!;
  const msgs = [newTextMessage("user", "a"), newTextMessage("user", "b")];
  expect(state.tryApplyPendingCompression(msgs)).toBe(true);
  expect(msgs[0]!.content).toBe("rebuilt");
});

test("compression job times out without progress", async () => {
  const state = new CompressionState();
  const worker = state.triggerAsyncCompression(
    [newTextMessage("user", "a"), newTextMessage("user", "b")],
    "a.go",
    async (_snapshot, _path, signal) => {
      await sleep(150);
      if (signal.aborted) throw (signal as AbortSignal & { reason?: unknown }).reason ?? new Error("aborted");
      return [newTextMessage("user", "rebuilt")];
    },
    50,
  );
  expect(worker).not.toBeNull();
  await worker!;
  const msgs = [newTextMessage("user", "a"), newTextMessage("user", "b")];
  // Timed-out job leaves original messages untouched.
  expect(state.tryApplyPendingCompression(msgs)).toBe(false);
});

// SPDX-License-Identifier: Apache-2.0
// Abort-reason propagation through the Pi transport seam.
//
// Regression evidence: a per-file deadline abort used to surface as a bare
// "AbortError: Aborted", discarding the "file task timeout" reason, and the
// retry collector recorded the killed request as cancelled only when the
// reason happened to be AbortError-shaped. The transport must surface the
// signal's reason and treat any signal abort as a cancellation — never as a
// provider failure.

import { test, expect } from "bun:test";
import { PiTransport } from "../../../src/ocr/pi-adapter/pi-transport.js";
import { RetryCollector } from "../../../src/ocr/retry/collector.js";
import type { RequestMeta } from "../../../src/ocr/retry/meta.js";
import { newTextMessage } from "../../../src/ocr/llmloop/compression.js";
import type { ChatRequest } from "../../../src/ocr/llmloop/types.js";

function meta(): RequestMeta {
  return { provider: "test", model: "test-model", filePath: "a.go", taskType: "main_task", requestNo: 1 };
}

function reqWithMeta(m: RequestMeta): ChatRequest {
  return {
    model: m.model,
    messages: [newTextMessage("user", "hello")],
    tools: [{ type: "function", function: { name: "task_done", description: "d" } }],
    maxTokens: 100,
    sessionId: "s",
    requestMeta: m,
  };
}

/**
 * Fake Pi session whose prompt hangs until the transport's abort forwarding
 * invokes session.abort() — the mid-flight deadline shape.
 */
function hangingSession(): unknown {
  let rejectPrompt: ((reason?: unknown) => void) | undefined;
  let activeTools: string[] = [];
  return {
    state: { messages: [] as unknown[] },
    setActiveToolsByName: (names: string[]) => { activeTools = names; },
    getActiveToolNames: () => activeTools,
    subscribe: (_next: (e: unknown) => void) => () => {},
    prompt: async () =>
      await new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      }),
    waitForIdle: async () => {},
    abort: async () => {
      rejectPrompt?.(new Error("session aborted"));
    },
  };
}

async function catchComplete(pending: Promise<unknown>): Promise<unknown> {
  try {
    return await pending;
  } catch (err) {
    return err;
  }
}

test("already-aborted signal with an Error reason surfaces the reason, not bare Aborted", async () => {
  const transport = new PiTransport(hangingSession() as never, undefined, undefined, new RetryCollector());
  const controller = new AbortController();
  controller.abort(new Error("file task timeout"));
  const caught = await catchComplete(transport.complete(reqWithMeta(meta()), controller.signal));
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe("file task timeout");
});

test("bare abort surfaces the platform AbortError reason", async () => {
  const transport = new PiTransport(hangingSession() as never, undefined, undefined, new RetryCollector());
  const controller = new AbortController();
  controller.abort();
  const caught = await catchComplete(transport.complete(reqWithMeta(meta()), controller.signal));
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).name).toBe("AbortError");
  expect((caught as Error).message.toLowerCase()).toContain("aborted");
});

test("mid-flight deadline abort rejects with the reason and records cancellation", async () => {
  const collector = new RetryCollector();
  const transport = new PiTransport(hangingSession() as never, undefined, undefined, collector);
  const controller = new AbortController();
  const m = meta();
  const pending = transport.complete(reqWithMeta(m), controller.signal);
  // Let the transport reach its prompt call, then fire the per-file deadline.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(controller.signal.aborted).toBe(false);
  controller.abort(new Error("file task timeout"));
  const caught = await catchComplete(pending);
  expect((caught as Error).message).toBe("file task timeout");
  const { report, error } = collector.freeze("run-abort-reason-1");
  expect(error).toBeNull();
  expect(report).not.toBeNull();
  expect(report!.cancelledRequests).toBe(1);
  expect(report!.failedRequests).toBe(0);
});

test("run-cancellation reason also records cancellation, not provider failure", async () => {
  const collector = new RetryCollector();
  const transport = new PiTransport(hangingSession() as never, undefined, undefined, collector);
  const controller = new AbortController();
  const m: RequestMeta = { ...meta(), requestNo: 2 };
  const pending = transport.complete(reqWithMeta(m), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("review was cancelled"));
  const caught = await catchComplete(pending);
  expect((caught as Error).message).toBe("review was cancelled");
  const { report, error } = collector.freeze("run-abort-reason-2");
  expect(error).toBeNull();
  expect(report).not.toBeNull();
  expect(report!.cancelledRequests).toBe(1);
  expect(report!.failedRequests).toBe(0);
});

// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/usage_resolver_test.go and client_test.go StreamingUsage at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { mapPiUsage } from "../../../src/ocr/pi-adapter/pi-transport.js";

// OCR v1.9.3: TestResolveUsageOpenAICompatibleCachedTokens
test("mapPiUsage maps OpenAI cached tokens as cacheRead without double counting total", () => {
  const usage = mapPiUsage({ input: 100, output: 20, cacheRead: 75, totalTokens: 120 });
  expect(usage).toBeDefined();
  expect(usage!.PromptTokens).toBe(100);
  expect(usage!.CompletionTokens).toBe(20);
  expect(usage!.CacheReadTokens).toBe(75);
  expect(usage!.TotalTokens).toBe(120);
});

// OCR v1.9.3: TestResolveUsageWrappedCachedTokens
test("mapPiUsage maps cache write via cacheWrite", () => {
  const usage = mapPiUsage({ input: 100, output: 20, cacheRead: 75, cacheWrite: 10, totalTokens: 120 });
  expect(usage!.CacheReadTokens).toBe(75);
  expect(usage!.CacheWriteTokens).toBe(10);
});

// OCR v1.9.3: TestResolveUsageWrappedAnthropicCompatibleCacheTokens
test("mapPiUsage maps Anthropic separate cache and total", () => {
  // Pi normalizes: input is prompt without cache separate, total includes cache when provided
  const usage = mapPiUsage({ input: 100, output: 20, cacheRead: 40, cacheWrite: 15, totalTokens: 175 });
  expect(usage!.CacheReadTokens).toBe(40);
  expect(usage!.CacheWriteTokens).toBe(15);
  expect(usage!.TotalTokens).toBe(175);
});

// OCR v1.9.3: TestResolveUsageResponsesAPIFieldNames
test("mapPiUsage handles Responses API via Pi normalized input/output", () => {
  const usage = mapPiUsage({ input: 100, output: 50, cacheRead: 80, totalTokens: 150 });
  expect(usage!.PromptTokens).toBe(100);
  expect(usage!.CompletionTokens).toBe(50);
  expect(usage!.CacheReadTokens).toBe(80);
  expect(usage!.TotalTokens).toBe(150);
});

// OCR v1.9.3: TestOpenAIClient_StreamingUsage (accounting half)
test("PiTransport captures streaming usage via turn_end assistant message", async () => {
  const { PiTransport } = await import("../../../src/ocr/pi-adapter/pi-transport.js");
  const { newTextMessage } = await import("../../../src/ocr/llmloop/compression.js");
  let listener: ((e: unknown) => void) | undefined;
  const session = {
    state: { messages: [] as unknown[] },
    messages: [] as unknown[],
    agent: { state: { messages: [] as unknown[] } },
    isIdle: true,
    isStreaming: false,
    sessionId: "s",
    setActiveToolsByName: () => {},
    subscribe: (next: (e: unknown) => void) => { listener = next; return () => {}; },
    prompt: async () => {
      listener?.({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 10, output: 3, cacheRead: 4, totalTokens: 13 },
          stopReason: "stop",
        },
      });
    },
    waitForIdle: async () => {},
    abort: async () => {},
  };
  const transport = new PiTransport(session as never);
  const res = await transport.complete({ model: "m", messages: [newTextMessage("user", "hi")], maxTokens: 10 } as never, AbortSignal.timeout(1000) as never);
  expect(res.usage).toBeDefined();
  expect(res.usage!.PromptTokens).toBe(10);
  expect(res.usage!.CompletionTokens).toBe(3);
  expect(res.usage!.CacheReadTokens).toBe(4);
  expect(res.usage!.TotalTokens).toBe(13);
});

// OCR v1.9.3: TestChatResponse_Content_Empty
test("empty Pi usage object yields undefined", () => {
  expect(mapPiUsage({})).toBeUndefined();
  expect(mapPiUsage(undefined)).toBeUndefined();
  const zeroExplicit = mapPiUsage({ input: 0, output: 0 });
  expect(zeroExplicit).toBeDefined();
  expect(zeroExplicit!.PromptTokens).toBe(0);
});

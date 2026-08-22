// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/client_test.go TestStripThinkTags at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { stripThinkTags } from "../../../src/ocr/pi-adapter/strip-think-tags.js";

// OCR v1.9.3: TestStripThinkTags
test("stripThinkTags removes think wrapper tags globally", () => {
  const cases: readonly [string, string, string][] = [
    ["plain remains", "hello", "hello"],
    ["open only removed", "<think>internal", "internal"],
    ["close only removed", "internal</think>", "internal"],
    ["both stripped", "<think>internal</think>answer", "internalanswer"],
    ["multiple", "<think>a</think>b<think>c</think>d", "abcd"],
    ["empty", "", ""],
    ["tags only", "<think></think>", ""],
  ];
  for (const [name, input, want] of cases) {
    expect(stripThinkTags(input), name).toBe(want);
  }
});

// OCR v1.9.3: TestChatResponse_Content_StripsThinkTags
test("ChatResponse content strips think tags before trimming", () => {
  // Mirrors ChatResponse.Content() behavior: stripThinkTags + TrimSpace, fallback to reasoning
  // Pi adapter applies stripThinkTags in extractOcrText and inspectPiAssistant
  expect(stripThinkTags("<think>internal</think>answer").trim()).toBe("internalanswer");
  expect(stripThinkTags("  <think>hi</think>  ").trim()).toBe("hi");
});

// OCR v1.9.3: TestChatResponse_Content_FallbackToReasoning
test("content empty falls back to reasoning content", async () => {
  const { PiTransport } = await import("../../../src/ocr/pi-adapter/pi-transport.js");
  // Fake Pi session that returns empty text but reasoningContent
  let listener: ((e: unknown) => void) | undefined;
  const session = {
    state: { messages: [] as unknown[] },
    messages: [] as unknown[],
    agent: { state: { messages: [] as unknown[] } },
    isIdle: true,
    isStreaming: false,
    sessionId: "s",
    setActiveToolsByName: () => {},
    subscribe: (next: (e: unknown) => void) => {
      listener = next;
      return () => {};
    },
    prompt: async () => {
      listener?.({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          reasoningContent: "reasoning here",
          stopReason: "stop",
        },
      });
    },
    waitForIdle: async () => {},
    abort: async () => {},
  };
  const transport = new PiTransport(session as unknown as ConstructorParameters<typeof PiTransport>[0]);
  const { newTextMessage } = await import("../../../src/ocr/llmloop/compression.js");
  const req = {
    model: "m",
    messages: [newTextMessage("user", "hi")],
    maxTokens: 10,
    sessionId: "s",
  };
  const res = await transport.complete(req as never, AbortSignal.timeout(1000) as never);
  expect(res.content).toBe("reasoning here");
  expect(res.reasoningContent).toBe("reasoning here");
});

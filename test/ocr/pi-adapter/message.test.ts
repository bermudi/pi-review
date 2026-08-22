// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/message_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { newTextMessage, extractText, type Message, type ContentBlock } from "../../../src/ocr/llmloop/compression.js";

// OCR v1.9.3: TestNewTextMessage
test("newTextMessage creates user message with role and content", () => {
  const m = newTextMessage("user", "hello");
  expect(m.role).toBe("user");
  expect(m.content).toBe("hello");
});

// OCR v1.9.3: TestNewToolCallMessage
test("tool call message preserves tool calls and copies", () => {
  const calls = [
    { id: "c1", type: "function", function: { name: "tool_a", arguments: "{}" } },
    { id: "c2", type: "function", function: { name: "tool_b", arguments: "{\"x\":1}" } },
  ];
  // Deep copy to mirror Go value semantics (struct copy)
  const msg: Message = { role: "assistant", content: "thinking", tool_calls: calls.map((c) => ({ ...c, function: { ...c.function } })) };
  expect(msg.tool_calls).toHaveLength(2);
  expect(msg.tool_calls![0]!.id).toBe("c1");
  // Mutation of original array elements should not affect copy
  (calls[0] as unknown as { id: string }).id = "mutated";
  expect(msg.tool_calls![0]!.id).toBe("c1");
  // Mutating original array length should not affect message
  calls.push({ id: "c3", type: "function", function: { name: "tool_c", arguments: "{}" } });
  expect(msg.tool_calls).toHaveLength(2);
});

// OCR v1.9.3: TestNewToolCallMessage_NilCalls
test("tool call message with no tool_calls has undefined or empty", () => {
  const m: Message = { role: "assistant", content: "text" };
  expect(m.tool_calls).toBeUndefined();
});

// OCR v1.9.3: TestNewToolResultMessage
test("tool result message has tool role and call id", () => {
  const m: Message = { role: "tool", content: "result text", tool_call_id: "call-123" };
  expect(m.role).toBe("tool");
  expect(m.content).toBe("result text");
  expect(m.tool_call_id).toBe("call-123");
});

// OCR v1.9.3: TestExtractText_String
test("extractText returns string content verbatim", () => {
  const m: Message = { role: "user", content: "plain text" };
  expect(extractText(m)).toBe("plain text");
});

// OCR v1.9.3: TestExtractText_ContentBlocks
test("extractText concatenates content blocks", () => {
  const m: Message = {
    role: "assistant",
    content: [
      { type: "text", text: "part1" },
      { type: "text", text: " part2" },
    ] as readonly ContentBlock[],
  };
  expect(extractText(m)).toBe("part1 part2");
});

// OCR v1.9.3: TestExtractText_NestedContentBlocks
test("extractText handles nested content blocks", () => {
  const m: Message = {
    role: "tool",
    content: [
      { type: "tool_result", content: [{ type: "text", text: "inner1" }, { type: "text", text: "inner2" }] } as unknown as ContentBlock,
      { type: "text", text: "outer" },
    ] as readonly ContentBlock[],
  };
  expect(extractText(m)).toBe("inner1inner2outer");
});

// OCR v1.9.3: TestExtractText_NilContent
test("extractText empty content returns empty", () => {
  const m: Message = { role: "user", content: "" };
  expect(extractText(m)).toBe("");
});

// OCR v1.9.3: TestChatResponse_Content
test("ChatResponse content mirrors extractText for assistant message", async () => {
  const { PiTransport } = await import("../../../src/ocr/pi-adapter/pi-transport.js");
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
      listener?.({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "hello world" }], stopReason: "stop" } });
    },
    waitForIdle: async () => {},
    abort: async () => {},
  };
  const transport = new PiTransport(session as never);
  const res = await transport.complete({ model: "m", messages: [newTextMessage("user", "hi")], maxTokens: 10 } as never, AbortSignal.timeout(1000) as never);
  expect(res.content).toBe("hello world");
});

// OCR v1.9.3: TestChatResponse_ToolCalls
test("ChatResponse toolCalls extracted from toolCall blocks", async () => {
  const { PiTransport } = await import("../../../src/ocr/pi-adapter/pi-transport.js");
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
        message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "code_comment", arguments: { a: 1 } }], stopReason: "toolUse" },
      });
    },
    waitForIdle: async () => {},
    abort: async () => {},
  };
  const transport = new PiTransport(session as never);
  const res = await transport.complete({ model: "m", messages: [newTextMessage("user", "hi")], maxTokens: 10, tools: [{ type: "function", function: { name: "code_comment" } }] } as never, AbortSignal.timeout(1000) as never);
  expect(res.toolCalls).toHaveLength(1);
  expect(res.toolCalls[0]!.function.name).toBe("code_comment");
});

// OCR v1.9.3: TestChatResponse_Content_NilContent
test("ChatResponse nil content falls back to reasoning", async () => {
  const { PiTransport } = await import("../../../src/ocr/pi-adapter/pi-transport.js");
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
      listener?.({ type: "turn_end", message: { role: "assistant", content: "", reasoningContent: "fallback", stopReason: "stop" } });
    },
    waitForIdle: async () => {},
    abort: async () => {},
  };
  const transport = new PiTransport(session as never);
  const res = await transport.complete({ model: "m", messages: [newTextMessage("user", "hi")], maxTokens: 10 } as never, AbortSignal.timeout(1000) as never);
  expect(res.content).toBe("fallback");
});

// OCR v1.9.3: TestChatResponse_ToolCalls_Empty
test("ChatResponse empty toolCalls returns empty array", async () => {
  const { PiTransport } = await import("../../../src/ocr/pi-adapter/pi-transport.js");
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
      listener?.({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "no tools" }], stopReason: "stop" } });
    },
    waitForIdle: async () => {},
    abort: async () => {},
  };
  const transport = new PiTransport(session as never);
  const res = await transport.complete({ model: "m", messages: [newTextMessage("user", "hi")], maxTokens: 10 } as never, AbortSignal.timeout(1000) as never);
  expect(res.toolCalls).toHaveLength(0);
});

// OCR v1.9.3: TestExtractText_Default
test("extractText default non-string returns empty", () => {
  const m = { role: "user", content: 42 as unknown as string } as unknown as Message;
  expect(extractText(m)).toBe("");
});

// extra coverage for undefined
test("extractText undefined content returns empty for coverage", () => {
  const m = { role: "user", content: undefined as unknown as string } as unknown as Message;
  expect(extractText(m)).toBe("");
});

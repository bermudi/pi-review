// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/llmloop/compression_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;

import { describe, test, expect } from "bun:test";
import {
  CountMessagesTokens,
  countTokens,
  groupIntoRounds,
  partitionMessages,
  StripMarkdownFences,
  buildMessageXML,
  copyMessages,
  PromptTokenLimit,
  newTextMessage,
} from "../../../src/ocr-v193/llmloop/compression.js";

describe("ocr-v193 compression (ported from compression_test.go)", () => {
  test("CountMessagesTokens positive for non-empty", () => {
    const msgs = [newTextMessage("user", "hello world"), newTextMessage("assistant", "hi there")];
    expect(CountMessagesTokens(msgs)).toBeGreaterThan(0);
  });

  test("CountMessagesTokens 0 for empty", () => {
    expect(CountMessagesTokens([])).toBe(0);
  });

  test("groupIntoRounds parses assistant+tool pairs", () => {
    const messages = [
      newTextMessage("system", "sys"),
      newTextMessage("user", "prompt"),
      newTextMessage("assistant", "resp1"),
      { role: "tool", content: "result1" } as any,
      { role: "tool", content: "result2" } as any,
      newTextMessage("assistant", "resp2"),
      { role: "tool", content: "result3" } as any,
      newTextMessage("assistant", "resp3"),
    ];
    const rounds = groupIntoRounds(messages, 2);
    expect(rounds).toHaveLength(3);
    expect(rounds[0]?.assistantIdx).toBe(2);
    expect(rounds[0]?.toolIdxs).toHaveLength(2);
    expect(rounds[1]?.assistantIdx).toBe(5);
    expect(rounds[2]?.assistantIdx).toBe(7);
    expect(rounds[2]?.toolIdxs).toHaveLength(0);
  });

  test("groupIntoRounds no assistant returns empty", () => {
    const messages = [newTextMessage("system", "sys"), newTextMessage("user", "prompt"), newTextMessage("user", "another")];
    expect(groupIntoRounds(messages, 2)).toHaveLength(0);
  });

  test("partitionMessages short conversation", () => {
    const messages = [newTextMessage("system", "sys"), newTextMessage("user", "prompt")];
    const result = partitionMessages(messages, 100000, 0);
    expect(result.frozenEnd).toBe(2);
    expect(result.compressEnd).toBe(2);
  });

  test("partitionMessages everything fits when budget large", () => {
    const messages = [
      newTextMessage("system", "sys"),
      newTextMessage("user", "prompt"),
      newTextMessage("assistant", "short reply"),
      { role: "tool", content: "ok" } as any,
    ];
    const result = partitionMessages(messages, 100000, 0);
    expect(result.activeCount).toBe(0);
    expect(result.compressEnd).toBe(messages.length);
  });

  test("StripMarkdownFences strips fences", () => {
    expect(StripMarkdownFences('{"key": "value"}')).toBe('{"key": "value"}');
    expect(StripMarkdownFences("```json\n{\"key\": \"value\"}\n```")).toBe('{"key": "value"}');
    expect(StripMarkdownFences("```\ncontent\n```")).toBe("content");
    expect(StripMarkdownFences("  ```json\n{}\n```  ")).toBe("{}");
    expect(StripMarkdownFences("```json\n```")).toBe("");
  });

  test("buildMessageXML serializes", () => {
    const msgs = [newTextMessage("user", "hello"), newTextMessage("assistant", "hi")];
    const xml = buildMessageXML(msgs);
    expect(xml).toContain('<message id="0" role="user">');
    expect(xml).toContain("hello");
    expect(xml).toContain('<message id="1" role="assistant">');
  });

  test("copyMessages shallow copies", () => {
    const msgs = [newTextMessage("user", "a")];
    const copy = copyMessages(msgs);
    expect(copy).toHaveLength(1);
    expect(copy[0]).toEqual(msgs[0]);
    copy.push(newTextMessage("user", "b"));
    expect(msgs).toHaveLength(1);
  });

  test("PromptTokenLimit 80%", () => {
    expect(PromptTokenLimit(100)).toBe(80);
    expect(PromptTokenLimit(10)).toBe(8);
  });

  test("countTokens fallback bytes/4", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("abcd")).toBe(1); // 4 bytes /4
    expect(countTokens("hello world")).toBeGreaterThan(0);
  });
});

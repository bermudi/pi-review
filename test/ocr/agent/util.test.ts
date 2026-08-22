// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/util_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import {
  stripEmptyPlanBlock,
  stripMarkdownFences,
  buildMessageXML,
  copyMessages,
  countMessagesTokens,
  reviewModeString,
  ReviewModeWorkspace,
  ReviewModeRange,
  ReviewModeCommit,
} from "../../../src/ocr/agent/util.js";
import { newTextMessage } from "../../../src/ocr/llmloop/compression.js";
import type { Message } from "../../../src/ocr/llmloop/compression.js";

describe("ocr agent util (ported from internal/agent/util_test.go)", () => {
  // OCR v1.9.3: TestStripEmptyPlanBlock
  test("TestStripEmptyPlanBlock", () => {
    const cases: Array<{ name: string; input: string; want: string }> = [
      {
        name: "english template wrapper is removed",
        input: "header\n### Review Plan (Optional)\n{{plan_guidance}}\n\ntail",
        want: "header\ntail",
      },
      {
        name: "english template wrapper without trailing blank line is removed",
        input: "header\n### Review Plan (Optional)\n{{plan_guidance}}\ntail",
        want: "header\ntail",
      },
      {
        name: "no wrapper present is a no-op",
        input: "no plan block here\njust text",
        want: "no plan block here\njust text",
      },
      {
        name: "multiple wrappers all removed",
        input: "### Review Plan (Optional)\n{{plan_guidance}}\n\nmiddle\n### Review Plan\n{{plan_guidance}}\n\nend",
        want: "middle\nend",
      },
    ];
    for (const tc of cases) {
      const got = stripEmptyPlanBlock(tc.input);
      expect(got).toBe(tc.want);
      expect(got.includes("{{plan_guidance}}")).toBe(false);
    }
  });

  // OCR v1.9.3: TestStripEmptyPlanBlock_IntegrationWithReplaceAll
  test("TestStripEmptyPlanBlock_IntegrationWithReplaceAll", () => {
    const template = "header\n### Review Plan (Optional)\n{{plan_guidance}}\n\ntail";
    const stripped = stripEmptyPlanBlock(template);
    const final = stripped.replaceAll("{{plan_guidance}}", "");
    const want = "header\ntail";
    expect(final).toBe(want);
    expect(final.includes("{{plan_guidance}}")).toBe(false);
    expect(final.includes("Review Plan")).toBe(false);
  });

  // OCR v1.9.3: TestStripMarkdownFences
  test("TestStripMarkdownFences", () => {
    const cases: Array<{ name: string; input: string; want: string }> = [
      { name: "no fences", input: `["c-0","c-2"]`, want: `["c-0","c-2"]` },
      { name: "json fenced block", input: "```json\n[\"c-0\"]\n```", want: `["c-0"]` },
      { name: "plain fenced block", input: "```\nhello\n```", want: "hello" },
      { name: "surrounding whitespace", input: "  \n```json\ncontent\n```\n  ", want: "content" },
      { name: "empty string", input: "", want: "" },
      { name: "only opening fence no newline", input: "```json{}```", want: "{}" },
    ];
    for (const tc of cases) {
      const got = stripMarkdownFences(tc.input);
      expect(got).toBe(tc.want);
    }
  });

  // OCR v1.9.3: TestBuildMessageXML
  test("TestBuildMessageXML", () => {
    const msgs: Message[] = [newTextMessage("user", "hello"), newTextMessage("assistant", "world")];
    const got = buildMessageXML(msgs);
    expect(got.includes(`<message id="0" role="user">`)).toBe(true);
    expect(got.includes(`<message id="1" role="assistant">`)).toBe(true);
    expect(got.includes("hello")).toBe(true);
    expect(got.includes("world")).toBe(true);
  });

  // OCR v1.9.3: TestCopyMessages
  test("TestCopyMessages", () => {
    const orig: Message[] = [newTextMessage("user", "a"), newTextMessage("assistant", "b")];
    const cp = copyMessages(orig);
    expect(cp.length).toBe(orig.length);
    const appended = [...cp, newTextMessage("user", "c")];
    expect(appended.length).toBe(orig.length + 1);
    expect(orig.length).toBe(2);
  });

  // OCR v1.9.3: TestCountMessagesTokens
  test("TestCountMessagesTokens", () => {
    const msgs: Message[] = [newTextMessage("user", "hello world")];
    const count = countMessagesTokens(msgs);
    expect(count).toBeGreaterThan(0);
    const empty = countMessagesTokens(null as unknown as Message[]);
    expect(empty).toBe(0);
  });

  // OCR v1.9.3: TestReviewModeString
  test("TestReviewModeString", () => {
    const cases: Array<{ from: string; to: string; commit: string; want: string }> = [
      { from: "", to: "", commit: "abc123", want: ReviewModeCommit },
      { from: "main", to: "feature", commit: "", want: ReviewModeRange },
      { from: "", to: "", commit: "", want: ReviewModeWorkspace },
      { from: "main", to: "feature", commit: "abc123", want: ReviewModeCommit },
    ];
    for (const tc of cases) {
      const got = reviewModeString(tc.from, tc.to, tc.commit);
      expect(got).toBe(tc.want);
    }
  });
});

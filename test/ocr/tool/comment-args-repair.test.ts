// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Isolated adoption from OCR 41917e2: repair serialized code_comment args.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later.

import { test, expect } from "bun:test";
import { ParseComments, ParseCommentsWithPath } from "../../../src/ocr/tool/code-comment.js";
import { parseRepairedComments, repairSerializedComments } from "../../../src/ocr/tool/comment-args-repair.js";

test("native array needs no repair", () => {
  const res = ParseComments({ comments: [{ content: "hi" }], path: "a.ts" });
  expect(res.errorMsg).toBe("");
  expect(res.comments).toHaveLength(1);
  expect(res.repair ?? null).toBeNull();
});

test("valid JSON string needs no repair", () => {
  const raw = JSON.stringify([{ content: "hi" }]);
  const res = ParseComments({ comments: raw, path: "a.ts" });
  expect(res.errorMsg).toBe("");
  expect(res.comments).toHaveLength(1);
  expect(res.repair ?? null).toBeNull();
});

test("bare prose quotes repair", () => {
  // Model serialized array but left prose quotes unescaped.
  const raw = `[{"content": "use the \"foo\" helper"}]`;
  expect(() => JSON.parse(raw)).toThrow();
  const res = ParseComments({ comments: raw, path: "a.ts" });
  expect(res.errorMsg).toBe("");
  expect(res.comments).toHaveLength(1);
  expect(res.comments[0]!.content).toContain(`"foo"`);
  expect(res.repair).not.toBeNull();
  expect(res.repair!.message()).toContain("repaired");
});

test("bare backslash and control repair", () => {
  const raw = `[{"content": "regex \\d and tab\there"}]`;
  const res = ParseComments({ comments: raw, path: "a.ts" });
  expect(res.errorMsg).toBe("");
  expect(res.comments).toHaveLength(1);
  expect(res.comments[0]!.content).toContain("\\d");
});

test("suspect truncation declines with original error", () => {
  // Odd quote count in content signals a cut value; repair must decline.
  const raw = `[{"content": "said \"hi}]`;
  const res = ParseComments({ comments: raw, path: "a.ts" });
  expect(res.comments).toHaveLength(0);
  expect(res.errorMsg).toContain("failed to parse 'comments' JSON string");
  expect(res.repair ?? null).toBeNull();
});

test("unknown field declines repair", () => {
  const raw = `[{"content": "hi", "bogus_field": "x"}]`;
  // Valid JSON, so no repair attempted (native parse succeeds, then entry kept?
  // Our ParseComments does not reject unknown fields on native path — only repair path does.
  // For serialized path with unknown field, repair must decline.
  const serializedUnknown = `[{"content": "say \"hi\"", "bogus_field": "x"}]`;
  const res = ParseComments({ comments: serializedUnknown, path: "a.ts" });
  // Either repaired with unknown field rejected (error) or declined — must not accept unknown.
  if (res.errorMsg === "") {
    expect(res.comments).toHaveLength(0);
  } else {
    expect(res.errorMsg).toContain("failed to parse");
  }
});

test("empty content declines repair", () => {
  const raw = `[{"content": ""}]`;
  // Valid JSON, parses but content empty → skipped, no comments, no error.
  const res = ParseComments({ comments: raw, path: "a.ts" });
  expect(res.errorMsg).toBe("");
  expect(res.comments).toHaveLength(0);
});

test("ParseCommentsWithPath falls back to default path", () => {
  const raw = JSON.stringify([{ content: "hi" }]);
  const res = ParseCommentsWithPath({ comments: raw }, "fallback.ts");
  expect(res.errorMsg).toBe("");
  expect(res.comments[0]!.path).toBe("fallback.ts");
  const perComment = ParseCommentsWithPath({ comments: JSON.stringify([{ content: "hi", path: "real.ts" }]) }, "fallback.ts");
  expect(perComment.comments[0]!.path).toBe("real.ts");
});

test("extended line fields do not block repair", () => {
  const raw = `[{"content": "use \"x\"", "start_line": 1}]`;
  const res = ParseComments({ comments: raw, path: "a.ts" });
  expect(res.errorMsg).toBe("");
  expect(res.comments).toHaveLength(1);
  expect(res.comments[0]!.startLine).toBe(1);
});

test("repairSerializedComments zero means no repair", () => {
  const { escaped } = repairSerializedComments(`[{"content":"hi"}]`);
  expect(escaped).toBe(0);
  expect(parseRepairedComments(`[{"content":"hi"}]`)).toBeNull();
});

test("loop records warning on repair and succeeds", async () => {
  const { Runner } = await import("../../../src/ocr/llmloop/loop.js");
  const collected: Array<{ path: string; content: string }> = [];
  const deps = {
    template: { MaxToolRequestTimes: 5, MaxTokens: 1000 },
    llmClient: { complete: async () => ({ content: "", toolCalls: [] }) },
    commentCollector: { Add: (cm: { path: string; content: string }) => collected.push(cm), add: (cm: { path: string; content: string }) => collected.push(cm) },
    diffLookup: () => null,
    allDiffs: () => [],
  };
  const runner = new Runner(deps as never);
  const raw = `[{\"content\": \"use the \\\"foo\\\" helper\"}]`;
  // Build serialized args the way a model sends them: comments as string with dropped escaping.
  const serialized = `[{"content": "use the "foo" helper"}]`;
  const res = await runner.executeToolCall(
    new AbortController().signal,
    "a.ts",
    { id: "1", function: { name: "code_comment", arguments: JSON.stringify({ comments: serialized }) } } as never,
    "",
    null,
  );
  expect(res.data).toBe("Successfully commented.");
  expect(collected).toHaveLength(1);
  const warns = runner.warnings();
  expect(warns.some((w) => w.type === "comment_args_repaired")).toBe(true);
  void raw;
});

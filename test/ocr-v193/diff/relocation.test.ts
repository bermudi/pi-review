// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/relocation_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Phase 5 — relocation retry

import { describe, test, expect } from "bun:test";
import { buildReLocationMessages, reLocateComment, extractCodeBlock } from "../../../src/ocr-v193/diff/relocation.js";
import type { Diff } from "../../../src/ocr-v193/model/diff.js";
import type { LlmComment } from "../../../src/ocr-v193/model/types.js";

function makeDiff(): Diff {
  return {
    oldPath: "main.go",
    newPath: "main.go",
    diff: `@@ -10,6 +10,8 @@\n import "fmt"\n\n func main() {\n+    x := 1\n+    y := 2\n     fmt.Println("hello")\n }\n`,
    newFileContent: "",
    isBinary: false,
    isDeleted: false,
    isNew: false,
    isRenamed: false,
    insertions: 0,
    deletions: 0,
  };
}

function makeTask() {
  return {
    messages: [
      { role: "system", content: "you are a helper" },
      { role: "user", content: "diff:\n{diff}\n\ncomment:\n{suggestion_content}" },
    ],
  };
}

describe("ocr-v193 relocation (ported)", () => {
  test("BuildReLocationMessages rendering", () => {
    const cm: LlmComment = { path: "main.go", content: "unused variable", existingCode: "x := 1" };
    const d = makeDiff();
    const task = {
      messages: [
        { role: "system", content: "you are a helper" },
        { role: "user", content: "diff:\n{diff}\ncode:\n{existing_code}\nsuggestion:\n{suggestion_content}" },
      ],
    };
    const msgs = buildReLocationMessages(cm, d, task as unknown as never);
    expect(msgs).not.toBeNull();
    expect(msgs!.length).toBe(2);
    expect(msgs![0]!.role).toBe("system");
    const expected = "diff:\n" + d.diff + "\ncode:\nx := 1\nsuggestion:\nunused variable";
    expect((msgs![1] as unknown as { extractText: () => string }).extractText?.() ?? (msgs![1] as unknown as { content: string }).content).toBeDefined();
    // Our TS helper returns LlmMessage with extractText() method
    const second = msgs![1] as unknown as { role: string; extractText(): string; content?: string };
    const text = typeof second.extractText === "function" ? second.extractText() : (second as unknown as { content: string }).content;
    expect(text).toBe(expected);
  });

  test("BuildReLocationMessages nil or empty task returns null", () => {
    const cm: LlmComment = { path: "main.go", content: "test", existingCode: "bad" };
    const d = makeDiff();
    expect(buildReLocationMessages(cm, d, null as unknown as never)).toBeNull();
    expect(buildReLocationMessages(cm, d, { messages: [] } as unknown as never)).toBeNull();
  });

  test("ReLocateComment LLM returns valid code → resolves", async () => {
    const cm: LlmComment = { path: "main.go", content: "unused variable", existingCode: "totally wrong code that won't match" };
    const d = makeDiff();
    const client = {
      async completionsWithCtx(_sig: AbortSignal | undefined, _req: unknown) {
        return {
          choices: [{ message: { content: "Here is the code:\n```go\nx := 1\ny := 2\n```\n" } }],
          content() { return "Here is the code:\n```go\nx := 1\ny := 2\n```\n"; },
        };
      },
    } as unknown as never;
    const msgs = buildReLocationMessages(cm, d, makeTask() as unknown as never)!;
    const [ok, resp] = await reLocateComment(cm, d, client as unknown as never, msgs as unknown as never, "test-model", 1000);
    expect(ok).toBe(true);
    expect(resp).not.toBeNull();
    expect(cm.startLine).toBeGreaterThan(0);
  });

  test("ReLocateComment LLM returns invalid content → fails, preserves 0", async () => {
    const cm: LlmComment = { path: "main.go", content: "unused", existingCode: "totally wrong code" };
    const d = makeDiff();
    const client = {
      async completionsWithCtx() {
        return {
          choices: [{ message: { content: "I cannot find the code." } }],
          content() { return "I cannot find the code."; },
        };
      },
    } as unknown as never;
    const msgs = buildReLocationMessages(cm, d, makeTask() as unknown as never)!;
    const [ok, resp] = await reLocateComment(cm, d, client as unknown as never, msgs as unknown as never, "test-model", 1000);
    expect(ok).toBe(false);
    expect(resp).not.toBeNull();
    expect(cm.startLine ?? 0).toBe(0);
  });

  test("ReLocateComment LLM error → false, null resp", async () => {
    const cm: LlmComment = { path: "main.go", content: "test", existingCode: "bad code" };
    const d = makeDiff();
    const client = {
      async completionsWithCtx() { throw new Error("network error"); },
    } as unknown as never;
    const msgs = buildReLocationMessages(cm, d, makeTask() as unknown as never)!;
    const [ok, resp] = await reLocateComment(cm, d, client as unknown as never, msgs as unknown as never, "test-model", 1000);
    expect(ok).toBe(false);
    expect(resp).toBeNull();
  });

  test("ReLocateComment CodeBlock still unresolvable → rollback original", async () => {
    const original = "totally wrong code";
    const cm: LlmComment = { path: "main.go", content: "unused", existingCode: original };
    const d = makeDiff();
    const client = {
      async completionsWithCtx() {
        return {
          choices: [{ message: { content: "```go\nnot in the diff either\n```" } }],
          content() { return "```go\nnot in the diff either\n```"; },
        };
      },
    } as unknown as never;
    const msgs = buildReLocationMessages(cm, d, makeTask() as unknown as never)!;
    const [ok, resp] = await reLocateComment(cm, d, client as unknown as never, msgs as unknown as never, "test-model", 1000);
    expect(ok).toBe(false);
    expect(resp).not.toBeNull();
    expect(cm.existingCode).toBe(original);
    expect(cm.startLine ?? 0).toBe(0);
  });

  test("ReLocateComment no messages → no LLM call", async () => {
    const cm: LlmComment = { path: "main.go", content: "test", existingCode: "bad code" };
    const d = makeDiff();
    let called = 0;
    const client = {
      async completionsWithCtx() { called++; return { choices: [], content() { return ""; } }; },
    } as unknown as never;
    const [ok, resp] = await reLocateComment(cm, d, client as unknown as never, null as unknown as never, "test-model", 1000);
    expect(ok).toBe(false);
    expect(resp).toBeNull();
    expect(called).toBe(0);
  });

  test("extractCodeBlock edge cases", () => {
    expect(extractCodeBlock("```go\nfoo\nbar\n```")).toBe("foo\nbar");
    expect(extractCodeBlock("```\nfoo\n```")).toBe("foo");
    expect(extractCodeBlock("Here:\n```\ncode\n```\ndone")).toBe("code");
    expect(extractCodeBlock("just text")).toBe("");
    expect(extractCodeBlock("```\n```")).toBe("");
    expect(extractCodeBlock("```go")).toBe("");
    expect(extractCodeBlock("```\nfoo\nbar")).toBe("");
  });
});

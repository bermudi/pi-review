// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/relocation_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import {
  buildReLocationMessages,
  reLocateComment,
  extractCodeBlock,
  createChatResponse,
} from "../../../src/ocr-v193/diff/relocation.js";
import type { LLMClient, ChatRequest, ChatResponse, LlmConversation } from "../../../src/ocr-v193/diff/relocation.js";
import { resolveComment } from "../../../src/ocr-v193/diff/resolver.js";
import type { Diff } from "../../../src/ocr-v193/model/diff.js";
import type { LlmComment } from "../../../src/ocr-v193/model/review.js";
import { createDiff } from "../../../src/ocr-v193/model/diff.js";
import { createLlmComment } from "../../../src/ocr-v193/model/review.js";

class MockLLMClient implements LLMClient {
  callCount = 0;
  constructor(
    private readonly response: ChatResponse | null,
    private readonly err: Error | null = null,
  ) {}
  async completionsWithCtx(_signal: AbortSignal | undefined, _req: ChatRequest): Promise<ChatResponse> {
    this.callCount++;
    if (this.err !== null) throw this.err;
    if (this.response === null) throw new Error("no response configured");
    return this.response;
  }
}

function newMockResponse(content: string): ChatResponse {
  return createChatResponse([{ message: { role: "assistant", content } }]);
}

function makeTask(): LlmConversation {
  return {
    messages: [
      { role: "system", content: "you are a helper" },
      { role: "user", content: "diff:\n{diff}\n\ncomment:\n{suggestion_content}" },
    ],
  };
}

function makeDiff(): Diff {
  return createDiff({
    newPath: "main.go",
    diff: `@@ -10,6 +10,8 @@
 import "fmt"

 func main() {
+    x := 1
+    y := 2
     fmt.Println("hello")
 }
`,
  });
}

// OCR v1.9.3: TestResolveComment_TextMatchSuccess
test("TestResolveComment_TextMatchSuccess", () => {
  const cm: LlmComment = createLlmComment({
    path: "main.go",
    content: "unused variable",
    existingCode: "x := 1\ny := 2",
  });
  const d = makeDiff();
  const ok = resolveComment(cm, d);
  expect(ok).toBe(true);
  expect((cm.startLine ?? 0) > 0).toBe(true);
  expect((cm.endLine ?? 0) > 0).toBe(true);
});

// OCR v1.9.3: TestResolveComment_AlreadyResolved
test("TestResolveComment_AlreadyResolved", () => {
  const cm: LlmComment = createLlmComment({
    path: "main.go",
    content: "test",
    existingCode: "whatever",
    startLine: 5,
    endLine: 10,
  });
  const d = makeDiff();
  const ok = resolveComment(cm, d);
  expect(ok).toBe(true);
  expect(cm.startLine).toBe(5);
  expect(cm.endLine).toBe(10);
});

// OCR v1.9.3: TestResolveComment_EmptyExistingCode
test("TestResolveComment_EmptyExistingCode", () => {
  const cm: LlmComment = createLlmComment({ path: "main.go", content: "test" });
  const d = makeDiff();
  const ok = resolveComment(cm, d);
  expect(ok).toBe(false);
});

// OCR v1.9.3: TestReLocateComment_LLMReturnsValidCode
test("TestReLocateComment_LLMReturnsValidCode", async () => {
  const cm: LlmComment = createLlmComment({
    path: "main.go",
    content: "unused variable",
    existingCode: "totally wrong code that won't match",
  });
  const d = makeDiff();
  const client = new MockLLMClient(newMockResponse("Here is the code:\n```go\nx := 1\ny := 2\n```\n"));
  const msgs = buildReLocationMessages(cm, d, makeTask());
  if (msgs === null || msgs.length === 0) throw new Error("expected non-empty messages");
  const [ok, resp] = await reLocateComment(cm, d, client, msgs, "test-model", 1000);
  expect(ok).toBe(true);
  expect(resp !== null).toBe(true);
  expect((cm.startLine ?? 0) > 0).toBe(true);
  expect((cm.endLine ?? 0) > 0).toBe(true);
});

// OCR v1.9.3: TestReLocateComment_LLMReturnsInvalidContent
test("TestReLocateComment_LLMReturnsInvalidContent", async () => {
  const cm: LlmComment = createLlmComment({
    path: "main.go",
    content: "unused variable",
    existingCode: "totally wrong code",
  });
  const d = makeDiff();
  const client = new MockLLMClient(newMockResponse("I cannot find the code."));
  const msgs = buildReLocationMessages(cm, d, makeTask());
  const [ok, resp] = await reLocateComment(cm, d, client, msgs, "test-model", 1000);
  expect(ok).toBe(false);
  expect(resp !== null).toBe(true);
  expect(cm.startLine ?? 0).toBe(0);
  expect(cm.endLine ?? 0).toBe(0);
});

// OCR v1.9.3: TestReLocateComment_LLMError
test("TestReLocateComment_LLMError", async () => {
  const cm: LlmComment = createLlmComment({
    path: "main.go",
    content: "test",
    existingCode: "bad code",
  });
  const d = makeDiff();
  const client = new MockLLMClient(null, new Error("network error"));
  const msgs = buildReLocationMessages(cm, d, makeTask());
  const [ok, resp] = await reLocateComment(cm, d, client, msgs, "test-model", 1000);
  expect(ok).toBe(false);
  expect(resp).toBeNull();
});

// OCR v1.9.3: TestBuildReLocationMessages_Rendering
test("TestBuildReLocationMessages_Rendering", () => {
  const cm: LlmComment = createLlmComment({
    path: "main.go",
    content: "unused variable",
    existingCode: "x := 1",
  });
  const d = makeDiff();
  const task: LlmConversation = {
    messages: [
      { role: "system", content: "you are a helper" },
      { role: "user", content: "diff:\n{diff}\ncode:\n{existing_code}\nsuggestion:\n{suggestion_content}" },
    ],
  };
  const msgs = buildReLocationMessages(cm, d, task);
  if (msgs === null) throw new Error("expected messages");
  expect(msgs.length).toBe(2);
  expect(msgs[0]!.role).toBe("system");
  expect(msgs[0]!.extractText()).toBe("you are a helper");
  const want = "diff:\n" + d.diff + "\ncode:\nx := 1\nsuggestion:\nunused variable";
  expect(msgs[1]!.role).toBe("user");
  expect(msgs[1]!.extractText()).toBe(want);
});

// OCR v1.9.3: TestBuildReLocationMessages_NilOrEmptyTask
test("TestBuildReLocationMessages_NilOrEmptyTask", () => {
  const cm: LlmComment = createLlmComment({
    path: "main.go",
    content: "test",
    existingCode: "bad code",
  });
  const d = makeDiff();
  const msgsNil = buildReLocationMessages(cm, d, null);
  expect(msgsNil).toBeNull();
  const msgsEmpty = buildReLocationMessages(cm, d, { messages: [] });
  expect(msgsEmpty).toBeNull();
});

// OCR v1.9.3: TestReLocateComment_CodeBlockStillUnresolvable
test("TestReLocateComment_CodeBlockStillUnresolvable", async () => {
  const original = "totally wrong code";
  const cm: LlmComment = createLlmComment({
    path: "main.go",
    content: "unused variable",
    existingCode: original,
  });
  const d = makeDiff();
  const client = new MockLLMClient(newMockResponse("```go\nnot in the diff either\n```"));
  const msgs = buildReLocationMessages(cm, d, makeTask());
  const [ok, resp] = await reLocateComment(cm, d, client, msgs, "test-model", 1000);
  expect(ok).toBe(false);
  expect(resp !== null).toBe(true);
  expect(cm.existingCode).toBe(original);
  expect(cm.startLine ?? 0).toBe(0);
  expect(cm.endLine ?? 0).toBe(0);
});

// OCR v1.9.3: TestReLocateComment_NoMessages
test("TestReLocateComment_NoMessages", async () => {
  const cm: LlmComment = createLlmComment({
    path: "main.go",
    content: "test",
    existingCode: "bad code",
  });
  const d = makeDiff();
  const client = new MockLLMClient(newMockResponse("```go\nx := 1\n```"));
  const [ok, resp] = await reLocateComment(cm, d, client, null, "test-model", 1000);
  expect(ok).toBe(false);
  expect(resp).toBeNull();
  expect(client.callCount).toBe(0);
});

// OCR v1.9.3: TestExtractCodeBlock
test("TestExtractCodeBlock", () => {
  const cases: Array<{ name: string; input: string; want: string }> = [
    { name: "with language tag", input: "```go\nfoo\nbar\n```", want: "foo\nbar" },
    { name: "without language tag", input: "```\nfoo\n```", want: "foo" },
    { name: "with surrounding text", input: "Here:\n```\ncode\n```\ndone", want: "code" },
    { name: "no code block", input: "just text", want: "" },
    { name: "empty block", input: "```\n```", want: "" },
    { name: "opening fence without newline", input: "```go", want: "" },
    { name: "no closing fence", input: "```\nfoo\nbar", want: "" },
  ];
  for (const c of cases) {
    const got = extractCodeBlock(c.input);
    expect(got).toBe(c.want);
  }
});

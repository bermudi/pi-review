// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/history_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.
import { describe, expect, test } from "bun:test";
import { SessionHistory } from "../../../src/ocr/session/history.ts";
import { newTextMessage } from "../../../src/ocr/llmloop/compression.ts";

describe("ocr session history", () => {
  // OCR v1.9.3: TestNew
  test("creates session history with expected fields", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "gpt-4", {
      reviewMode: "workspace",
      diffFrom: "a",
      diffTo: "b",
      diffCommit: "c",
    });
    expect(sh).not.toBeNull();
    expect(sh.sessionId.length).toBeGreaterThan(0);
    expect(sh.repoDir).toBe("/tmp/repo");
    expect(sh.gitBranch).toBe("main");
    expect(sh.model).toBe("gpt-4");
    expect(sh.reviewMode).toBe("workspace");
    expect(sh.diffFrom).toBe("a");
    expect(sh.diffTo).toBe("b");
    expect(sh.diffCommit).toBe("c");
    expect(sh.startTime instanceof Date && !isNaN(sh.startTime.getTime())).toBe(true);
    expect(sh.fileSessions instanceof Map).toBe(true);
  });

  // OCR v1.9.3: TestGetOrCreateFileSession
  test("GetOrCreateFileSession returns same instance for same path", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    const fs1 = sh.GetOrCreateFileSession("main.go");
    expect(fs1).not.toBeNull();
    expect(fs1.filePath).toBe("main.go");
    const fs2 = sh.GetOrCreateFileSession("main.go");
    expect(fs1).toBe(fs2);
    const fs3 = sh.GetOrCreateFileSession("other.go");
    expect(fs3).not.toBe(fs1);
  });

  // OCR v1.9.3: TestAppendTaskRecord
  test("AppendTaskRecord increments per-task counters", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    const fs = sh.GetOrCreateFileSession("file.go");
    const msgs = [newTextMessage("user", "hello")] as unknown as import("../../../src/ocr/session/history.ts").Message[];
    const rec = fs.AppendTaskRecord("main_task", msgs);
    expect(rec).not.toBeNull();
    expect(rec.type).toBe("main_task");
    expect(rec.requestNo).toBe(1);
    const rec2 = fs.AppendTaskRecord("main_task", msgs);
    expect(rec2.requestNo).toBe(2);
    const rec3 = fs.AppendTaskRecord("plan_task", msgs);
    expect(rec3.requestNo).toBe(1);
  });

  // OCR v1.9.3: TestAppendTaskRecord_DefensiveCopy
  test("AppendTaskRecord stores a defensive copy of messages", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    const fs = sh.GetOrCreateFileSession("file.go");
    const msgs = [newTextMessage("user", "original")] as unknown as import("../../../src/ocr/session/history.ts").Message[];
    const rec = fs.AppendTaskRecord("main_task", msgs);
    (msgs[0] as unknown as { content: string }).content = "mutated";
    const stored = rec.requestMessages[0] as unknown as { content: string; role: string };
    expect(stored.content).not.toBe("mutated");
    expect(stored.content).toBe("original");
  });

  // OCR v1.9.3: TestSetResponse
  test("SetResponse records content, model, usage and duration", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    const fs = sh.GetOrCreateFileSession("file.go");
    const rec = fs.AppendTaskRecord("main_task", [newTextMessage("user", "hi")] as unknown as import("../../../src/ocr/session/history.ts").Message[]);
    const resp = {
      content: "response text",
      toolCalls: [] as Array<{ id: string; function: { name: string; arguments: string } }>,
      model: "gpt-4",
      usage: { promptTokens: 100, completionTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    rec.SetResponse(resp, 2000);
    expect(rec.response).not.toBeNull();
    expect(rec.response?.content).toBe("response text");
    expect(rec.response?.model).toBe("gpt-4");
    expect(rec.response?.usage?.promptTokens).toBe(100);
    expect(rec.response?.usage?.completionTokens).toBe(50);
    expect(rec.durationMs).toBe(2000);
  });

  // OCR v1.9.3: TestSetResponse_EmptyResponse
  test("SetResponse with null records an error", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    const fs = sh.GetOrCreateFileSession("file.go");
    const rec = fs.AppendTaskRecord("main_task", [newTextMessage("user", "hi")] as unknown as import("../../../src/ocr/session/history.ts").Message[]);
    rec.SetResponse(null as unknown as { content: string }, 1000);
    expect(rec.error).not.toBeNull();
    expect(rec.error!.length).toBeGreaterThan(0);
  });

  // OCR v1.9.3: TestSetError
  test("SetError records message and duration", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    const fs = sh.GetOrCreateFileSession("file.go");
    const rec = fs.AppendTaskRecord("main_task", [newTextMessage("user", "hi")] as unknown as import("../../../src/ocr/session/history.ts").Message[]);
    rec.SetError(new Error("timeout"), 5000);
    expect(rec.error).toBe("timeout");
    expect(rec.durationMs).toBe(5000);
  });

  // OCR v1.9.3: TestLLMFailures
  test("LLMFailures counts SetError calls", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    expect(sh.LLMFailures()).toBe(0);
    const fs = sh.GetOrCreateFileSession("a.go");
    const rec = fs.AppendTaskRecord("main_task", []);
    rec.SetError(new Error("fail1"), 1000);
    const rec2 = fs.AppendTaskRecord("main_task", []);
    rec2.SetError(new Error("fail2"), 1000);
    expect(sh.LLMFailures()).toBe(2);
  });

  // OCR v1.9.3: TestAddToolResult
  test("AddToolResult appends tool result record", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    const fs = sh.GetOrCreateFileSession("file.go");
    const rec = fs.AppendTaskRecord("main_task", []);
    rec.AddToolResult("file_read", `{"path":"main.go"}`, "package main");
    expect(rec.toolResults.length).toBe(1);
    const tr = rec.toolResults[0]!;
    expect(tr.toolName).toBe("file_read");
    expect(tr.arguments).toBe(`{"path":"main.go"}`);
    expect(tr.result).toBe("package main");
  });
});

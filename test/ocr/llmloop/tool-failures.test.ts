// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Isolated adoption from OCR b3704b8 + 0524d21: tool failures surface with args.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later.

import { test, expect } from "bun:test";
import { Runner } from "../../../src/ocr/llmloop/loop.js";
import { newJsonToolCalls, emitFailureUsageText } from "../../../src/ocr/cli/output.js";
import { SessionHistory } from "../../../src/ocr/session/history.js";

function minimalDeps(overrides: Record<string, unknown> = {}): never {
  return {
    template: { MaxToolRequestTimes: 5, MaxTokens: 1000 },
    llmClient: { complete: async () => ({ content: "", toolCalls: [] }) },
    commentCollector: { Add: () => undefined, add: () => undefined },
    ...overrides,
  } as never;
}

test("Runner records tool failure with args and persists ok=false", async () => {
  const sh = new SessionHistory("/tmp/repo", "main", "model", {});
  const fs = sh.GetOrCreateFileSession("a.ts");
  const rec = fs.AppendTaskRecord("main_task", []);
  const runner = new Runner(minimalDeps({ session: sh }) as never);
  const failingRegistry = {
    get: (name: string) => {
      if (name === "boom") {
        return {
          execute: async () => {
            throw new Error("kaput");
          },
        };
      }
      return undefined;
    },
  };
  const depsWithTools = minimalDeps({ session: sh, toolRegistry: failingRegistry });
  const runner2 = new Runner(depsWithTools as never);
  const res = await runner2.executeToolCall(
    new AbortController().signal,
    "a.ts",
    { id: "1", function: { name: "boom", arguments: `{"x":1}` } } as never,
    "",
    rec,
  );
  expect(res.data).toContain("Error executing tool boom");
  const failures = runner2.toolFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]!.toolName).toBe("boom");
  expect(failures[0]!.args).toBe(`{"x":1}`);
  expect(failures[0]!.filePath).toBe("a.ts");
  expect(rec.toolResults[rec.toolResults.length - 1]!.ok).toBe(false);
  void runner;
});

test("newJsonToolCalls includes stable failure fields", () => {
  const out = newJsonToolCalls({ file_read: 2 }, [
    { toolCallNumber: 2, toolName: "file_read", filePath: "a.ts", args: `{"p":1}`, error: "kaput" },
  ]);
  expect(out.total).toBe(2);
  expect(out.failure).toBe(1);
  expect(out.failure_by_tool).toEqual({ file_read: 1 });
  expect(out.failure_details).toHaveLength(1);
  expect(out.failure_details[0]!.arguments).toBe(`{"p":1}`);
  const empty = newJsonToolCalls({ a: 1 }, []);
  expect(empty.failure).toBe(0);
  expect(empty.failure_by_tool).toEqual({});
  expect(empty.failure_details).toEqual([]);
});

test("emitFailureUsageText adds failed suffix and JSON details", () => {
  const failures = [{ toolCallNumber: 1, toolName: "boom", filePath: "a.ts", args: `{"x":1}`, error: "kaput" }];
  const text = emitFailureUsageText(1, 10, 5, 15, { boom: 1 }, 1000, false, "", null, "text", undefined, failures);
  expect(text.stderr).toContain(", 1 failed");
  const json = emitFailureUsageText(1, 10, 5, 15, { boom: 1 }, 1000, false, "", null, "json", undefined, failures);
  const parsed = JSON.parse(json.stderr) as { tool_calls: { failure: number; failure_details: Array<{ arguments: string }> } };
  expect(parsed.tool_calls.failure).toBe(1);
  expect(parsed.tool_calls.failure_details[0]!.arguments).toBe(`{"x":1}`);
  const noFail = emitFailureUsageText(1, 10, 5, 15, { boom: 1 }, 1000, false, "", null, "text", undefined, []);
  expect(noFail.stderr).not.toContain("failed");
});

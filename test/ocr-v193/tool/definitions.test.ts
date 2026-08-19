// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/definitions_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { expect, test } from "bun:test";
import {
  Dynamic,
  IsReserved,
  OfName,
  CodeComment,
  CodeSearch,
  FileFind,
  FileRead,
  FileReadDiff,
  TaskDone,
  Unknown,
  type Tool,
} from "../../../src/ocr-v193/tool/types.js";
import { NewRegistry, NewStub } from "../../../src/ocr-v193/tool/definitions.js";

// OCR v1.9.3: TestOfName
test("OfName resolves every OCR built-in and falls back to Unknown", () => {
  const cases: readonly [string, Tool][] = [
    ["code_comment", CodeComment],
    ["file_read", FileRead],
    ["file_find", FileFind],
    ["file_read_diff", FileReadDiff],
    ["code_search", CodeSearch],
    ["task_done", TaskDone],
    ["nonexistent", Unknown],
    ["", Unknown],
  ];
  for (const [name, want] of cases) expect(OfName(name)).toBe(want);
});

// OCR v1.9.3: TestTool_Name
test("Tool Name returns the OCR identifier", () => {
  expect(CodeComment.Name()).toBe("code_comment");
});

// OCR v1.9.3: TestTool_IsKnown
test("Tool IsKnown distinguishes CodeComment from Unknown", () => {
  expect(CodeComment.IsKnown()).toBe(true);
  expect(Unknown.IsKnown()).toBe(false);
});

// OCR v1.9.3: TestRegistry_RegisterAndGet
test("Registry registers and gets a provider by tool name", () => {
  const registry = NewRegistry();
  const stub = NewStub(CodeComment);
  registry.Register(stub);

  const got = registry.Get("code_comment");
  expect(got).toBeDefined();
  expect(got!.Tool()).toBe(CodeComment);
  expect(registry.Get("nonexistent")).toBeUndefined();
});

// OCR v1.9.3: TestRegistry_Freeze_PanicsOnRegister
test("Registry Register throws after Freeze", () => {
  const registry = NewRegistry();
  registry.Freeze();
  expect(() => registry.Register(NewStub(FileRead))).toThrow();
});

// OCR v1.9.3: TestRegistry_GetAfterFreeze
test("Registry Get still finds tools after Freeze", () => {
  const registry = NewRegistry();
  registry.Register(NewStub(FileRead));
  registry.Freeze();
  expect(registry.Get("file_read")).toBeDefined();
});

// OCR v1.9.3: TestIsReserved
test("IsReserved matches exactly OCR built-in tool names", () => {
  const reserved = [
    "unknown",
    "task_done",
    "code_comment",
    "file_read",
    "file_find",
    "file_read_diff",
    "code_search",
  ];
  for (const name of reserved) expect(IsReserved(name)).toBe(true);

  const nonReserved = ["custom_tool", "my_tool", "search", ""];
  for (const name of nonReserved) expect(IsReserved(name)).toBe(false);
});

// OCR v1.9.3: TestDynamic
test("Dynamic creates a tool with the requested name", () => {
  const tool = Dynamic("my_custom_tool");
  expect(tool.Name()).toBe("my_custom_tool");
});

// OCR v1.9.3: TestDynamic_PanicsOnEmpty
test("Dynamic throws for an empty name", () => {
  expect(() => Dynamic("")).toThrow();
});

// OCR v1.9.3: TestDynamic_PanicsOnReserved
test("Dynamic throws for a reserved name", () => {
  expect(() => Dynamic("file_read")).toThrow();
});

class DummyProvider {
  Tool(): Tool {
    return CodeSearch;
  }

  Execute(_ctx: unknown, _args: Record<string, unknown> | null): string {
    return "result";
  }
}

// OCR v1.9.3: TestRegistry_ProviderInterface
test("Registry accepts the OCR Provider interface", async () => {
  const registry = NewRegistry();
  registry.Register(new DummyProvider());
  registry.Freeze();

  const provider = registry.Get("code_search");
  expect(provider).toBeDefined();
  const result = await provider!.Execute(undefined, null as never);
  expect(result).toBe("result");
});

// SPDX-License-Identifier: Apache-2.0
// Ported from internal/config/toolsconfig/toolsconfig_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadToolConfig, toolDefsByPhase } from "../../../src/ocr-v193/tool/tools-config.js";

// OCR v1.9.3: TestLoad_Default
test("load default tools", () => {
  const tools = loadToolConfig("");
  expect(tools.length).toBeGreaterThan(0);
  const first = tools[0]!;
  expect(first.name).not.toBe("");
  expect(first.definition).not.toBeNull();
  expect(first.definition).not.toBeUndefined();
});

// OCR v1.9.3: TestLoad_CustomFile
test("load custom file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-tools-"));
  const p = path.join(tmp, "tools.json");
  const data = `[
    {"name": "test_tool", "plan_task": true, "main_task": false, "definition": {"name": "test_tool"}}
  ]`;
  fs.writeFileSync(p, data, "utf8");
  try {
    const tools = loadToolConfig(p);
    expect(tools.length).toBe(1);
    expect(tools[0]!.name).toBe("test_tool");
    expect(tools[0]!.plan_task).toBe(true);
    expect(tools[0]!.main_task).toBe(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestLoad_FileNotFound
test("load file not found", () => {
  expect(() => loadToolConfig("/nonexistent/tools.json")).toThrow();
});

// OCR v1.9.3: TestLoad_InvalidJSON
test("load invalid JSON", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-tools-"));
  const p = path.join(tmp, "tools.json");
  fs.writeFileSync(p, "not json", "utf8");
  try {
    expect(() => loadToolConfig(p)).toThrow();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestToolDefsByPhase
test("toolDefsByPhase filtering", () => {
  const def = { name: "test" };
  const cases: Array<{ name: string; entry: { plan_task: boolean; main_task: boolean; definition: unknown; name: string }; planOnly: boolean; wantOk: boolean }> = [
    { name: "plan_task and planOnly=true", entry: { name: "x", plan_task: true, main_task: false, definition: def }, planOnly: true, wantOk: true },
    { name: "plan_task and planOnly=false", entry: { name: "x", plan_task: true, main_task: false, definition: def }, planOnly: false, wantOk: false },
    { name: "main_task and planOnly=false", entry: { name: "x", plan_task: false, main_task: true, definition: def }, planOnly: false, wantOk: true },
    { name: "main_task and planOnly=true", entry: { name: "x", plan_task: false, main_task: true, definition: def }, planOnly: true, wantOk: false },
    { name: "both and planOnly=true", entry: { name: "x", plan_task: true, main_task: true, definition: def }, planOnly: true, wantOk: true },
    { name: "both and planOnly=false", entry: { name: "x", plan_task: true, main_task: true, definition: def }, planOnly: false, wantOk: true },
    { name: "neither", entry: { name: "x", plan_task: false, main_task: false, definition: def }, planOnly: true, wantOk: false },
  ];
  for (const tc of cases) {
    const [got, ok] = toolDefsByPhase(tc.entry as never, tc.planOnly);
    expect(ok, `${tc.name} ok`).toBe(tc.wantOk);
    if (tc.wantOk) expect(got, `${tc.name} expected non-nil`).not.toBeNull();
    else expect(got, `${tc.name} expected nil`).toBeUndefined();
    // also check false case returns nil/undefined
    if (!tc.wantOk) expect(got).toBeUndefined();
    else expect(got).not.toBeUndefined();
  }
});

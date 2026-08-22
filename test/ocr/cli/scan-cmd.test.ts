// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/scan_cmd_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { parseScanFlags } from "../../../src/ocr/cli/index.js";
import { excludeToolDef, splitPaths } from "../../../src/ocr/cli/shared.js";

// OCR v1.9.3: TestExcludeToolDef
test("excludeToolDef removes named def and does not mutate input", () => {
  const defs = [
    { type: "function", function: { name: "task_done" } },
    { type: "function", function: { name: "file_read" } },
    { type: "function", function: { name: "file_read_diff" } },
    { type: "function", function: { name: "code_comment" } },
  ] as unknown as Record<string, unknown>[];
  const got = excludeToolDef(defs as unknown as never, "file_read_diff") as unknown as { function: { name: string } }[];
  expect(got.length).toBe(3);
  expect(got.some((d) => d.function.name === "file_read_diff")).toBe(false);
  expect(defs.length).toBe(4);
});

// OCR v1.9.3: TestExcludeToolDef_AbsentName
test("excludeToolDef absent name returns identical content", () => {
  const defs = [{ type: "function", function: { name: "task_done" } }] as unknown as Record<string, unknown>[];
  const got = excludeToolDef(defs as unknown as never, "does_not_exist") as unknown as { function: { name: string } }[];
  expect(got.length).toBe(1);
  expect(got[0]!.function.name).toBe("task_done");
});

// OCR v1.9.3: TestSplitPaths
test("splitPaths trims, drops empty, handles empty", () => {
  expect(splitPaths("")).toEqual([]);
  expect(splitPaths("internal/agent")).toEqual(["internal/agent"]);
  expect(splitPaths("a.go,b.go,c.go")).toEqual(["a.go", "b.go", "c.go"]);
  expect(splitPaths("  a.go ,  b.go  ")).toEqual(["a.go", "b.go"]);
  expect(splitPaths("a.go,,b.go,")).toEqual(["a.go", "b.go"]);
});

// OCR v1.9.3: TestParseScanFlags_BareCommandScansWholeRepo
test("parseScanFlags bare command scans whole repo", () => {
  const opts = parseScanFlags([]);
  expect(opts.paths).toBe("");
});

// OCR v1.9.3: TestParseScanFlags_RejectsInvalidAudience
test("parseScanFlags rejects invalid audience", () => {
  expect(() => parseScanFlags(["--audience", "robot"])).toThrow();
  try {
    parseScanFlags(["--audience", "robot"]);
  } catch (e) {
    expect(String((e as Error).message)).toContain("invalid --audience");
  }
});

// OCR v1.9.3: TestParseScanFlags_RejectsNegativeMaxTools
test("parseScanFlags rejects negative max-tools", () => {
  expect(() => parseScanFlags(["--max-tools", "-1"])).toThrow();
  try {
    parseScanFlags(["--max-tools", "-1"]);
  } catch (e) {
    expect(String((e as Error).message)).toContain("--max-tools");
  }
});

// OCR v1.9.3: TestParseScanFlags_RejectsNegativeMaxGitProcs
test("parseScanFlags rejects negative max-git-procs", () => {
  expect(() => parseScanFlags(["--max-git-procs", "-3"])).toThrow();
  try {
    parseScanFlags(["--max-git-procs", "-3"]);
  } catch (e) {
    expect(String((e as Error).message)).toContain("--max-git-procs");
  }
});

// OCR v1.9.3: TestParseScanFlags_DefaultsValid
test("parseScanFlags defaults valid", () => {
  const opts = parseScanFlags([]);
  expect(opts.paths).toBe("");
  expect(opts.audience).toBe("human");
  expect(opts.outputFormat).toBe("text");
  expect(opts.concurrency).toBe(8);
});

// OCR v1.9.3: TestParseScanFlags_PathNarrowsScope
test("parseScanFlags path narrows scope", () => {
  const opts = parseScanFlags(["--path", "internal/agent,internal/diff"]);
  expect(splitPaths(opts.paths)).toEqual(["internal/agent", "internal/diff"]);
});

// OCR v1.9.3: TestParseScanFlags_HelpFlag
test("parseScanFlags help flag does not error", () => {
  const opts = parseScanFlags(["-h"]);
  expect(opts).toBeDefined();
});

// OCR v1.9.3: TestParseScanFlags_RejectsNegativeMaxTokensBudget
test("parseScanFlags rejects negative max-tokens-budget", () => {
  expect(() => parseScanFlags(["--max-tokens-budget", "-100"])).toThrow();
  try {
    parseScanFlags(["--max-tokens-budget", "-100"]);
  } catch (e) {
    expect(String((e as Error).message)).toContain("--max-tokens-budget");
  }
});

// OCR v1.9.3: TestParseScanFlags_RejectsNegativeMaxTokens
test("parseScanFlags rejects negative max-tokens", () => {
  expect(() => parseScanFlags(["--max-tokens", "-100"])).toThrow();
  try {
    parseScanFlags(["--max-tokens", "-100"]);
  } catch (e) {
    expect(String((e as Error).message)).toContain("--max-tokens");
  }
});

// OCR v1.9.3: TestParseScanFlags_BooleanFlags
test("parseScanFlags boolean flags", () => {
  const opts = parseScanFlags(["--no-plan", "--no-dedup", "--no-summary", "--preview"]);
  expect(opts.noPlan).toBe(true);
  expect(opts.noDedup).toBe(true);
  expect(opts.noSummary).toBe(true);
  expect(opts.preview).toBe(true);
});

// OCR v1.9.3: TestParseScanFlags_ModelOverride
test("parseScanFlags model override", () => {
  const opts = parseScanFlags(["--model", "claude-opus-4-6"]);
  expect(opts.model).toBe("claude-opus-4-6");
});

// OCR v1.9.3: TestParseScanFlags_ProviderAndModelOverrides
test("parseScanFlags provider and model overrides", () => {
  const opts = parseScanFlags(["--provider", "my-gateway", "--model", "llama-3-8b"]);
  expect(opts.provider).toBe("my-gateway");
  expect(opts.model).toBe("llama-3-8b");
});

// OCR v1.9.3: TestParseScanFlags_Resume
test("parseScanFlags resume", () => {
  const opts = parseScanFlags(["--resume", "session-123"]);
  expect(opts.resume).toBe("session-123");
});

// OCR v1.9.3: TestParseScanFlags_PreviewWithResume
test("parseScanFlags preview with resume rejected", () => {
  expect(() => parseScanFlags(["--preview", "--resume", "session-123"])).toThrow();
  try {
    parseScanFlags(["--preview", "--resume", "session-123"]);
  } catch (e) {
    expect(String((e as Error).message)).toContain("--preview and --resume");
  }
});

// OCR v1.9.3: TestParseScanFlags_AllStringFlags
test("parseScanFlags all string flags", () => {
  const opts = parseScanFlags([
    "--tools", "/tmp/tools.json",
    "--rule", "/tmp/rule.json",
    "--repo", "/tmp/repo",
    "--exclude", "*.md,*.txt",
    "--batch", "by-language",
    "--background", "test context",
    "--audience", "agent",
    "-f", "json",
  ]);
  expect(opts.toolConfigPath).toBe("/tmp/tools.json");
  expect(opts.rulePath).toBe("/tmp/rule.json");
  expect(opts.repoDir).toBe("/tmp/repo");
  expect(opts.excludes).toBe("*.md,*.txt");
  expect(opts.batch).toBe("by-language");
  expect(opts.background).toBe("test context");
  expect(opts.audience).toBe("agent");
  expect(opts.outputFormat).toBe("json");
});

// OCR v1.9.3: TestParseScanFlags_IntFlags
test("parseScanFlags int flags", () => {
  const opts = parseScanFlags([
    "--concurrency", "16",
    "--timeout", "20",
    "--max-tools", "50",
    "--max-git-procs", "32",
    "--max-tokens", "200000",
    "--max-tokens-budget", "100000",
  ]);
  expect(opts.concurrency).toBe(16);
  expect(opts.perFileTimeout).toBe(20);
  expect(opts.maxTools).toBe(50);
  expect(opts.maxGitProcs).toBe(32);
  expect(opts.maxTokens).toBe(200000);
  expect(opts.maxTokensBudget).toBe(100000);
});

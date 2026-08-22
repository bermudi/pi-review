// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/budget_output_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { emitRunResult, type ResultProvider } from "../../../src/ocr/cli/review.js";
import { emitFailureUsageText } from "../../../src/ocr/cli/output.js";
import type { RunManifest } from "../../../src/ocr/session/manifest.js";
import type { LlmComment } from "../../../src/ocr/model/review.js";

function makeProvider(opts: {
  filesReviewed?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  warnings?: { type: string; file: string; message: string }[];
  toolCalls?: Record<string, number>;
  sessionId?: string;
  budgetExceeded?: boolean;
  manifest?: RunManifest | null;
}): ResultProvider {
  return {
    Diffs: () => [],
    FilesReviewed: () => opts.filesReviewed ?? 0,
    TotalInputTokens: () => opts.inputTokens ?? 0,
    TotalOutputTokens: () => opts.outputTokens ?? 0,
    TotalTokensUsed: () => opts.totalTokens ?? 0,
    TotalCacheReadTokens: () => 0,
    TotalCacheWriteTokens: () => 0,
    Warnings: () => (opts.warnings as never) ?? [],
    ProjectSummary: () => "",
    ToolCalls: () => opts.toolCalls ?? {},
    SessionID: () => opts.sessionId ?? "",
    BudgetExceeded: () => opts.budgetExceeded ?? false,
    RunManifest: () => (opts.manifest !== undefined ? opts.manifest : null),
    ResumeInfo: () => undefined as never,
  } as unknown as ResultProvider;
}

function captureEmit(
  provider: ResultProvider,
  comments: readonly LlmComment[],
  durationMs: number,
  outputFormat: string,
  audience: string,
  traceId: string,
): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  emitRunResult(provider, comments, durationMs, outputFormat, audience, traceId, undefined, null, {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
  });
  return { stdout, stderr };
}

// OCR v1.9.3: TestEmitRunResult_JSONBudgetStopIsPartial
test("emitRunResult JSON budget stop is partial", () => {
  const manifest: RunManifest = {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-1",
    operation: "review",
    terminalState: "partial",
    repository: {},
    input: { mode: "workspace" },
    execution: {},
    coverage: {
      selected: [
        { itemId: "a", path: "a.go" },
        { itemId: "b", path: "b.go" },
      ],
      completed: [{ itemId: "a", path: "a.go" }],
      reused: [],
      failed: [{ itemId: "b", path: "b.go", classification: "budget", reason: "aggregate token budget reached before dispatch completed" }],
      waived: [],
    },
    elapsedMs: 0,
  };
  const ag = makeProvider({
    filesReviewed: 3,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    warnings: [{ type: "token_budget_reached", file: "big.go", message: "stopped" }],
    toolCalls: { file_read: 2 },
    budgetExceeded: true,
    manifest,
  });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "");
  const out = JSON.parse(stdout);
  expect(out.status).toBe("partial");
  expect(out.summary.budget_exceeded).toBe(true);
  expect(out.manifest).toBeDefined();
  expect(out.manifest.runFailure == null).toBe(true);
  expect(out.manifest.coverage.failed).toHaveLength(1);
  expect(out.manifest.coverage.failed[0].classification).toBe("budget");
  const found = (out.warnings as { type: string }[]).some((w) => w.type === "token_budget_reached");
  expect(found).toBe(true);
});

// OCR v1.9.3: TestEmitRunResult_JSONBudgetDoesNotOverrideLegacyStatus
test("emitRunResult JSON budget does not override legacy status", () => {
  const ag = makeProvider({
    filesReviewed: 1,
    warnings: [{ type: "subtask_error", file: "x.go", message: "boom" }],
    budgetExceeded: true,
  });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "");
  const out = JSON.parse(stdout);
  expect(out.status).toBe("completed_with_errors");
  expect(out.summary.budget_exceeded).toBe(true);
});

// OCR v1.9.3: TestEmitRunResult_JSONNoBudgetIsSuccess
test("emitRunResult JSON no budget is success", () => {
  const ag = makeProvider({ filesReviewed: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "");
  const out = JSON.parse(stdout);
  expect(out.status).toBe("success");
  expect(out.summary.budget_exceeded).toBeUndefined();
  expect(stdout).not.toContain("budget_exceeded");
});

// OCR v1.9.3: TestEmitFailureUsage_TextEmitsStructuredRecord
test("emitFailureUsage text emits structured record", () => {
  const { stderr } = emitFailureUsageText(4, 1000, 500, 1500, { file_read: 3, code_comment: 2 }, 42000, false, "sess-fail-1", null, "text", undefined);
  for (const want of ["usage on failure", "1500 total tokens", "5 tool calls", "budget_exceeded=false", "sess-fail-1"]) {
    expect(stderr).toContain(want);
  }
});

// OCR v1.9.3: TestEmitFailureUsage_JSONEmitsStructuredRecord
test("emitFailureUsage JSON emits structured record", () => {
  const identity = { provider: "openai", model: "gpt-5.4" };
  const { stderr } = emitFailureUsageText(2, 200, 80, 280, { file_read: 1 }, 5000, false, "", null, "json", identity as never);
  const out = JSON.parse(stderr);
  expect(out.status).toBe("failed");
  expect(out.summary).toBeDefined();
  expect(out.summary.budget_exceeded).toBeUndefined();
  expect(out.summary.total_tokens).toBe(280);
  expect(out.tool_calls.total).toBe(1);
  expect(out.llm.provider).toBe("openai");
  expect(out.llm.model).toBe("gpt-5.4");
  expect(stderr).not.toContain(`"budget_exceeded":true`);
});

// OCR v1.9.3: TestEmitFailureUsage_BudgetExceededPropagated
test("emitFailureUsage budget exceeded propagated", () => {
  const { stderr: textStderr } = emitFailureUsageText(1, 0, 0, 100, {}, 3000, true, "", null, "text", undefined);
  expect(textStderr).toContain("budget_exceeded=true");
  const { stderr: jsonStderr } = emitFailureUsageText(1, 0, 0, 100, {}, 3000, true, "", null, "json", undefined);
  const out = JSON.parse(jsonStderr);
  expect(out.summary.budget_exceeded).toBe(true);
});

// OCR v1.9.3: TestEmitRunResult_BudgetExceededFalseOmittedFromJSON
test("emitRunResult budget exceeded false omitted from JSON", () => {
  const ag = makeProvider({ filesReviewed: 1, inputTokens: 10, totalTokens: 10 });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "");
  expect(stdout).not.toContain("budget_exceeded");
  const out = JSON.parse(stdout);
  expect(out.summary.budget_exceeded).toBeUndefined();
});

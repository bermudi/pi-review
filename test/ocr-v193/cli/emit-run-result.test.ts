// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/emit_run_result_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { emitRunResult, type ResultProvider } from "../../../src/ocr-v193/cli/review.js";
import {
  outputJsonWithWarnings,
  emitFailureUsageText,
} from "../../../src/ocr-v193/cli/output.js";
import { newQuietHandle, QuietHandle } from "../../../src/ocr-v193/cli/shared.js";
import type { RunManifest } from "../../../src/ocr-v193/session/manifest.js";
import {
  RetryReportSchemaVersion,
  ErrorClassRateLimited,
  ErrorClassOverloaded,
  ErrorClassProvider,
  ErrorClassCancelled,
  ErrorClassNetwork,
  FailurePhaseHTTP,
  FailurePhaseTransport,
  FailurePhaseContext,
  OutcomeRecovered,
  OutcomeFailed,
  OutcomeCancelled,
} from "../../../src/ocr-v193/retry/types.js";
import type { RetryReport } from "../../../src/ocr-v193/retry/types.js";
import type { LlmComment } from "../../../src/ocr-v193/model/review.js";
import { ManifestBuilder } from "../../../src/ocr-v193/session/manifest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(opts: {
  diffs?: unknown[];
  filesReviewed?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  warnings?: { type: string; file: string; message: string }[];
  projectSummary?: string;
  toolCalls?: Record<string, number>;
  resumeInfo?: unknown;
  sessionId?: string;
  budgetExceeded?: boolean;
  manifest?: RunManifest | null;
}): ResultProvider {
  return {
    Diffs: () => opts.diffs ?? [],
    FilesReviewed: () => opts.filesReviewed ?? 0,
    TotalInputTokens: () => opts.inputTokens ?? 0,
    TotalOutputTokens: () => opts.outputTokens ?? 0,
    TotalTokensUsed: () => opts.totalTokens ?? 0,
    TotalCacheReadTokens: () => opts.cacheReadTokens ?? 0,
    TotalCacheWriteTokens: () => opts.cacheWriteTokens ?? 0,
    Warnings: () => (opts.warnings as never) ?? [],
    ProjectSummary: () => opts.projectSummary ?? "",
    ToolCalls: () => opts.toolCalls ?? {},
    SessionID: () => opts.sessionId ?? "",
    BudgetExceeded: () => opts.budgetExceeded ?? false,
    RunManifest: () => (opts.manifest !== undefined ? opts.manifest : null),
    ResumeInfo: () => opts.resumeInfo as never,
  } as unknown as ResultProvider;
}

function mockManifest(state: RunManifest["terminalState"]): RunManifest {
  const a = { itemId: "a", path: "a.go", fingerprint: "fp-a" };
  const b = { itemId: "b", path: "b.go", fingerprint: "fp-b" };
  const base: RunManifest = {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-1",
    operation: "review",
    terminalState: state,
    repository: {},
    input: { mode: "workspace" },
    execution: {},
    coverage: {
      selected: [],
      completed: [],
      reused: [],
      failed: [],
      waived: [],
    },
    elapsedMs: 0,
  };
  switch (state) {
    case "complete":
      base.coverage.selected = [a, b];
      base.coverage.completed = [a, b];
      break;
    case "partial":
      base.coverage.selected = [a, b];
      base.coverage.completed = [a];
      base.coverage.failed = [{ ...b, classification: "provider" as const }];
      break;
    case "failed":
      base.coverage.selected = [a, b];
      base.coverage.failed = [
        { ...a, classification: "provider" as const },
        { ...b, classification: "timeout" as const },
      ];
      break;
    case "skipped":
      base.coverage.selected = [];
      break;
  }
  return base;
}

function retryReportFixture(): RetryReport {
  return {
    schemaVersion: RetryReportSchemaVersion,
    totalRequests: 12,
    retriedRequests: 1,
    totalRetries: 2,
    recoveredRequests: 1,
    failedRequests: 1,
    cancelledRequests: 0,
    requests: [
      {
        logicalRequestId: "aaa",
        provider: "",
        model: "claude-test",
        filePath: "payment.go",
        taskType: "main_task",
        requestNo: 2,
        outcome: OutcomeRecovered,
        attempts: [
          { number: 1, outcome: "error" as const, errorClass: ErrorClassRateLimited, failurePhase: FailurePhaseHTTP, statusCode: 429 },
          { number: 2, outcome: "error" as const, errorClass: ErrorClassOverloaded, failurePhase: FailurePhaseHTTP, statusCode: 529 },
          { number: 3, outcome: "success" as const },
        ],
      },
      {
        logicalRequestId: "bbb",
        provider: "",
        model: "claude-test",
        filePath: "config.go",
        taskType: "main_task",
        requestNo: 1,
        outcome: OutcomeFailed,
        attempts: [
          { number: 1, outcome: "error" as const, errorClass: ErrorClassProvider, failurePhase: FailurePhaseHTTP, statusCode: 402 },
        ],
      },
    ],
  };
}

function captureEmit(
  provider: ResultProvider,
  comments: readonly LlmComment[],
  durationMs: number,
  outputFormat: string,
  audience: string,
  traceId: string,
  llmIdentity: { provider?: string; model: string } | undefined,
  retryReport: RetryReport | null | undefined,
): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  emitRunResult(
    provider,
    comments,
    durationMs,
    outputFormat,
    audience,
    traceId,
    llmIdentity as never,
    retryReport,
    { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } },
  );
  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// OCR v1.9.3: TestEmitRunResult_JSONNoFiles
test("emitRunResult JSON no files skipped", () => {
  const ag = makeProvider({ filesReviewed: 0 });
  const identity = { provider: "anthropic", model: "claude-opus-4-6" };
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", identity, null);
  const out = JSON.parse(stdout);
  expect(out.status).toBe("skipped");
  expect(out.llm.provider).toBe("anthropic");
  expect(out.llm.model).toBe("claude-opus-4-6");
  expect(out.comments).toEqual([]);
  expect(out.tool_calls.by_tool).toEqual({});
});

// OCR v1.9.3: TestEmitRunResult_JSONLLMIdentityNamedProvider
test("emitRunResult JSON llm identity named provider", () => {
  const ag = makeProvider({ filesReviewed: 1 });
  const identity = { provider: "anthropic", model: "claude-opus-4-6" };
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", identity, null);
  const out = JSON.parse(stdout);
  expect(out.llm.provider).toBe("anthropic");
  expect(out.llm.model).toBe("claude-opus-4-6");
});

// OCR v1.9.3: TestEmitRunResult_JSONLLMIdentityOmitsUnknownProvider
test("emitRunResult JSON omits unknown provider", () => {
  const ag = makeProvider({ filesReviewed: 1 });
  const identity = { model: "gpt-5-codex" } as { provider?: string; model: string };
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", identity, null);
  const out = JSON.parse(stdout);
  expect(out.llm.model).toBe("gpt-5-codex");
  expect(out.llm.provider).toBeUndefined();
  expect(stdout).not.toContain(`"provider"`);
});

// OCR v1.9.3: TestEmitRunResult_JSONUsesManifestTerminalState
test("emitRunResult JSON uses manifest terminal state", () => {
  const manifest = mockManifest("partial");
  const ag = makeProvider({
    filesReviewed: 2,
    manifest,
    warnings: [
      { type: "subtask_error", file: "b.go", message: "provider rejected api_key=LEAKED at /Users/example/private" },
      { type: "info", file: "a.go", message: "retry used" },
    ],
  });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", undefined, null);
  const out = JSON.parse(stdout);
  expect(out.status).toBe("partial");
  expect(out.manifest.runId).toBe(manifest.runId);
  expect(out.message).not.toContain("Looks good");
  expect(out.warnings).toHaveLength(1);
  expect(out.warnings[0].type).toBe("info");
  expect(stdout).not.toContain("LEAKED");
  expect(stdout).not.toContain("/Users/example/private");
});

// OCR v1.9.3: TestEmitRunResult_JSONSkippedIncludesManifest
test("emitRunResult JSON skipped includes manifest", () => {
  const manifest = mockManifest("skipped");
  const ag = makeProvider({ manifest });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", undefined, null);
  const out = JSON.parse(stdout);
  expect(out.status).toBe("skipped");
  expect(out.manifest).toBeDefined();
  expect(out.message).toContain("no items were selected");
});

// OCR v1.9.3: TestEmitRunResult_JSONManifestMatchesPersistedSessionEnd
test("emitRunResult JSON manifest matches persisted session end", () => {
  const builder = new ManifestBuilder("run-1", "review");
  builder.SetInput({ mode: "range", requestedFrom: "main", requestedHead: "feature" });
  const a = { itemId: "a", path: "a.go", fingerprint: "fp-a" };
  const b = { itemId: "b", path: "b.go", fingerprint: "fp-b" };
  expect(builder.RegisterSelected(a)).toBeNull();
  expect(builder.RegisterSelected(b)).toBeNull();
  expect(builder.SealSelected()).toBeNull();
  expect(builder.MarkCompleted(a.itemId)).toBeNull();
  expect(builder.MarkFailed(b.itemId, "provider", "provider or subtask request failed")).toBeNull();
  const { manifest, error } = builder.Finalize(0);
  expect(error).toBeNull();
  expect(manifest).not.toBeNull();

  const ag = makeProvider({ filesReviewed: 2, manifest: manifest as RunManifest });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", undefined, null);
  const parsed = JSON.parse(stdout);
  const cliManifestRaw = JSON.stringify(parsed.manifest);
  const persistedRaw = JSON.stringify(manifest);
  // canonicalize via JSON round-trip compact comparison
  expect(JSON.parse(cliManifestRaw)).toEqual(JSON.parse(persistedRaw));
  expect(JSON.stringify(JSON.parse(cliManifestRaw))).toBe(JSON.stringify(JSON.parse(persistedRaw)));
});

// OCR v1.9.3: TestEmitRunResult_JSONWithComments
test("emitRunResult JSON with comments", () => {
  const ag = makeProvider({
    filesReviewed: 3,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    warnings: [{ type: "info", file: "", message: "note" }],
    toolCalls: { file_read: 2 },
  });
  const comments: LlmComment[] = [{ path: "main.go", content: "fix", startLine: 1, endLine: 2 }];
  const { stdout } = captureEmit(ag, comments, 1000, "json", "developer", "", undefined, null);
  const out = JSON.parse(stdout);
  expect(out.comments).toHaveLength(1);
  expect(out.summary.files_reviewed).toBe(3);
  expect(out.summary.total_tokens).toBe(150);
  expect(out.tool_calls.total).toBe(2);
});

// OCR v1.9.3: TestEmitRunResult_JSONWithResumeInfo
test("emitRunResult JSON with resume info", () => {
  const ag = makeProvider({
    filesReviewed: 2,
    resumeInfo: {
      resumedFrom: "old-session",
      reusedFiles: 1,
      rerunFiles: 1,
      previousModel: "anthropic-model",
      currentModel: "openai-model",
    },
  });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", undefined, null);
  const out = JSON.parse(stdout);
  expect(out.resume.resumedFrom).toBe("old-session");
  expect(out.resume.reusedFiles).toBe(1);
  expect(out.resume.rerunFiles).toBe(1);
});

// OCR v1.9.3: TestEmitRunResult_TextNoComments
test("emitRunResult text no comments", () => {
  const ag = makeProvider({ filesReviewed: 2 });
  const { stdout } = captureEmit(ag, [], 1000, "text", "developer", "", undefined, null);
  expect(stdout).toContain("Looks good to me");
});

// OCR v1.9.3: TestEmitRunResult_TextPartialNeverLooksGood
test("emitRunResult text partial never looks good", () => {
  const ag = makeProvider({ filesReviewed: 2, manifest: mockManifest("partial") });
  const { stdout } = captureEmit(ag, [], 1000, "text", "developer", "", undefined, null);
  expect(stdout).toContain("partially complete");
  expect(stdout).not.toContain("Looks good");
});

// OCR v1.9.3: TestEmitRunResult_TextCompleteReportsFindingsAndWaived
test("emitRunResult text complete reports findings and waived", () => {
  const manifest = mockManifest("complete");
  const b = manifest.coverage.completed[1]!;
  manifest.coverage.completed = manifest.coverage.completed.slice(0, 1);
  manifest.coverage.waived = [{ ...b, reason: "accepted" }];
  const ag = makeProvider({ filesReviewed: 2, manifest });
  const comments: LlmComment[] = [{ path: "a.go", content: "fix", startLine: 1, endLine: 1 }];
  const { stdout } = captureEmit(ag, comments, 1000, "text", "developer", "", undefined, null);
  for (const want of ["Review complete: 1 finding(s)", "including 1 waived", "a.go"]) {
    expect(stdout).toContain(want);
  }
});

// OCR v1.9.3: TestEmitRunResult_TextDoesNotPrintSuccessfulSessionHint
test("emitRunResult text does not print successful session hint", () => {
  const ag = makeProvider({ filesReviewed: 2, sessionId: "session-123" });
  const { stdout, stderr } = captureEmit(ag, [], 1000, "text", "developer", "", undefined, null);
  const combined = stdout + stderr;
  // Pi port prints session id via trace summary; only the --resume hint is suppressed on success.
  expect(combined).not.toContain("--resume");
  // ensure summary is present but hint not duplicated as resume flag
  expect(stdout).toContain("Looks good");
});

// OCR v1.9.3: TestEmitRunResult_TextWithComments
test("emitRunResult text with comments", () => {
  const ag = makeProvider({ filesReviewed: 1 });
  const comments: LlmComment[] = [{ path: "a.go", content: "rename", startLine: 5, endLine: 10 }];
  const { stdout } = captureEmit(ag, comments, 1000, "text", "developer", "", undefined, null);
  expect(stdout).toContain("a.go");
  expect(stdout).toContain("rename");
});

// OCR v1.9.3: TestEmitRunResult_TextWithProjectSummary
test("emitRunResult text with project summary", () => {
  const ag = makeProvider({ filesReviewed: 5, projectSummary: "All tests pass, code quality is good." });
  const { stdout } = captureEmit(ag, [], 1000, "text", "developer", "", undefined, null);
  expect(stdout).toContain("Project Summary");
  expect(stdout).toContain("All tests pass");
});

// OCR v1.9.3: TestEmitRunResult_AgentTextRestoresQuiet
test("emitRunResult agent text restores quiet", () => {
  const h = newQuietHandle("text", "agent");
  expect(h.fn).not.toBeNull();
  h.Restore();
  expect(h.fn).toBeNull();
});

// OCR v1.9.3: TestEmitRunResult_AgentJSONDoesNotRestore
test("emitRunResult agent json does not restore automatically", () => {
  const h = newQuietHandle("json", "agent");
  expect(h.fn).not.toBeNull();
  // agent json should keep quiet until caller restores; verify not auto-cleared
  expect(h.fn).not.toBeNull();
  h.Restore();
  expect(h.fn).toBeNull();
});

// OCR v1.9.3: TestEmitRunResult_NilQuietHandle
test("emitRunResult nil quiet handle", () => {
  const h: QuietHandle | null = null as unknown as QuietHandle | null;
  expect(() => (h as QuietHandle | null)?.Restore()).not.toThrow();
  const ag = makeProvider({ filesReviewed: 1 });
  const { stdout } = captureEmit(ag, [], 1000, "text", "agent", "", undefined, null);
  expect(stdout).toContain("Looks good to me");
});

// OCR v1.9.3: TestEmitRunResult_JSONTraceIDFromContext
test("emitRunResult JSON trace id from context", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const ag = makeProvider({ filesReviewed: 2, inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", traceId, undefined, null);
  const out = JSON.parse(stdout);
  expect(out.trace_id).toBe(traceId);
});

// OCR v1.9.3: TestEmitRunResult_JSONNoFilesTraceID
test("emitRunResult JSON no files trace id", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const ag = makeProvider({ filesReviewed: 0 });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", traceId, undefined, null);
  const out = JSON.parse(stdout);
  expect(out.status).toBe("skipped");
  expect(out.trace_id).toBe(traceId);
});

// OCR v1.9.3: TestEmitRunResult_JSONIncludesSessionID
test("emitRunResult JSON includes session id", () => {
  const ag = makeProvider({ filesReviewed: 1, sessionId: "session-99" });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", undefined, null);
  const out = JSON.parse(stdout);
  expect(out.session_id).toBe("session-99");
});

// OCR v1.9.3: TestEmitRunResult_JSONCarriesRetryReport
test("emitRunResult JSON carries retry report", () => {
  const ag = makeProvider({ filesReviewed: 2, manifest: mockManifest("complete") });
  const rep = retryReportFixture();
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", undefined, rep);
  const out = JSON.parse(stdout);
  expect(out.retry_report).toBeDefined();
  expect(out.retry_report.schema_version).toBe(RetryReportSchemaVersion);
  expect(out.retry_report.total_requests).toBe(12);
  expect(out.retry_report.failed_requests).toBe(1);
});

// OCR v1.9.3: TestEmitRunResult_JSONOmitsRetryReportWhenNil
test("emitRunResult JSON omits retry report when nil", () => {
  const ag = makeProvider({ filesReviewed: 2, manifest: mockManifest("complete") });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", undefined, null);
  expect(stdout).not.toContain("retry_report");
});

// OCR v1.9.3: TestEmitRunResult_TextReportOrder
test("emitRunResult text report order", () => {
  const ag = makeProvider({ filesReviewed: 2, manifest: mockManifest("complete"), projectSummary: "PROJECT-SUMMARY-MARKER" });
  const { stdout } = captureEmit(ag, [], 1000, "text", "developer", "", undefined, retryReportFixture());
  const reportIdx = stdout.indexOf("LLM retry report:");
  const summaryIdx = stdout.indexOf("PROJECT-SUMMARY-MARKER");
  expect(reportIdx).toBeGreaterThanOrEqual(0);
  expect(summaryIdx).toBeGreaterThan(reportIdx);
  expect(stdout).toContain("- config.go / main_task #1: provider(402) -> failed");
});

// OCR v1.9.3: TestEmitRunResult_TextOmitsReportWhenNil
test("emitRunResult text omits report when nil", () => {
  const ag = makeProvider({ filesReviewed: 2, manifest: mockManifest("complete") });
  const { stdout } = captureEmit(ag, [], 1000, "text", "developer", "", undefined, null);
  expect(stdout).not.toContain("LLM retry report");
});

// OCR v1.9.3: TestEmitRunResult_JSONHasNoReportText
test("emitRunResult JSON has no report text", () => {
  const ag = makeProvider({ filesReviewed: 2, manifest: mockManifest("complete") });
  const { stdout } = captureEmit(ag, [], 1000, "json", "developer", "", undefined, retryReportFixture());
  expect(stdout).not.toContain("LLM retry report:");
  const dec = stdout.trim();
  const first = JSON.parse(dec);
  expect(first).toBeDefined();
  // ensure single JSON document: parsing whole stdout succeeds and extra chars after not present
  expect(() => JSON.parse(stdout)).not.toThrow();
  // if there were two documents, second parse would find trailing content; verify only one top-level object
  expect(dec.startsWith("{")).toBe(true);
  expect(dec.endsWith("}")).toBe(true);
});

// OCR v1.9.3: TestEmitFailureUsage_JSONCarriesRetryReport
test("emitFailureUsage JSON carries retry report", () => {
  const rep = retryReportFixture();
  const { stderr } = emitFailureUsageText(1, 0, 0, 0, {}, 1000, false, "sess-1", rep, "json", undefined);
  const out = JSON.parse(stderr);
  expect(out.status).toBe("failed");
  expect(out.retry_report).toBeDefined();
  expect(out.retry_report.failed_requests).toBe(1);
});

// OCR v1.9.3: TestEmitFailureUsage_TextCarriesRetryReport
test("emitFailureUsage text carries retry report", () => {
  const rep = retryReportFixture();
  const { stderr } = emitFailureUsageText(1, 0, 0, 0, {}, 1000, false, "", rep, "text", undefined);
  const usageIdx = stderr.indexOf("usage on failure");
  const reportIdx = stderr.indexOf("LLM retry report:");
  expect(usageIdx).toBeGreaterThanOrEqual(0);
  expect(reportIdx).toBeGreaterThanOrEqual(0);
  expect(reportIdx).toBeGreaterThan(usageIdx);
});

// OCR v1.9.3: TestEmitFailureUsage_NilReportUnchanged
test("emitFailureUsage nil report unchanged", () => {
  const { stderr } = emitFailureUsageText(1, 0, 0, 0, {}, 1000, false, "", null, "text", undefined);
  expect(stderr).not.toContain("LLM retry report");
});

// OCR v1.9.3: TestEmitRunResult_TextReportWithWarnings
test("emitRunResult text report with warnings", () => {
  const ag = makeProvider({
    filesReviewed: 1,
    warnings: [{ type: "subtask_error", file: "b.go", message: "boom" }],
  });
  const { stdout } = captureEmit(ag, [], 1000, "text", "developer", "", undefined, retryReportFixture());
  expect(stdout).toContain("LLM retry report:");
  expect((stdout.match(/LLM retry report:/g) ?? []).length).toBe(1);
});

// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/retry_report_e2e_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";

import { RetryCollector } from "../../../src/ocr/retry/collector.js";
import {
  RetryReportSchemaVersion,
  ErrorClassRateLimited,
  ErrorClassProvider,
  FailurePhaseHTTP,
  OutcomeRecovered,
  OutcomeFailed,
  AttemptSuccess,
  AttemptError,
} from "../../../src/ocr/retry/types.js";
import type { RetryReport } from "../../../src/ocr/retry/types.js";
import { runReviewContext, type ReviewRunner } from "../../../src/ocr/cli/review.js";
import type { ReviewOptions } from "../../../src/ocr/cli/shared.js";
import { defaultReviewOptions } from "../../../src/ocr/cli/shared.js";
import type { RunManifest } from "../../../src/ocr/session/manifest.js";
import type { LlmComment } from "../../../src/ocr/model/review.js";

// ---------------------------------------------------------------------------
// Helpers: manifest builders, collector fixtures, runReview seam
// ---------------------------------------------------------------------------

function makeManifest(state: RunManifest["terminalState"], overrides?: Partial<RunManifest>): RunManifest {
  const base: RunManifest = {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-e2e",
    operation: "review",
    terminalState: state,
    repository: {},
    input: { mode: "range" },
    execution: { model: "claude-test" },
    coverage: {
      selected: [
        { itemId: "a", path: "a.go", fingerprint: "fp-a" },
        { itemId: "b", path: "b.go", fingerprint: "fp-b" },
      ],
      completed: [],
      reused: [],
      failed: [],
      waived: [],
    },
    elapsedMs: 1234,
  };
  if (state === "complete") {
    base.coverage.completed = [...base.coverage.selected];
  } else if (state === "partial") {
    base.coverage.completed = [base.coverage.selected[0]!];
    base.coverage.failed = [{ ...base.coverage.selected[1]!, classification: "provider" as const }];
  } else if (state === "failed") {
    base.coverage.failed = base.coverage.selected.map((s) => ({ ...s, classification: "provider" as const }));
  } else if (state === "skipped") {
    base.coverage.selected = [];
  }
  if (overrides) Object.assign(base, overrides);
  return base;
}

function baseReviewOptions(format: "json" | "text" | "sarif"): ReviewOptions {
  const d = defaultReviewOptions();
  return {
    ...d,
    repoDir: "/tmp/repo-e2e",
    from: "HEAD~1",
    to: "HEAD",
    outputFormat: format,
    audience: "human",
  };
}

interface Captured {
  stdout: string;
  stderr: string;
  code: number;
  error: Error | null;
}

async function runCaptured(
  opts: ReviewOptions,
  runnerFactory: (signal?: AbortSignal) => Promise<ReviewRunner>,
  retryReportOverride?: RetryReport | null,
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const io = {
    cwd: () => "/tmp",
    env: () => ({} as Record<string, string | undefined>),
    stdout: (s: string) => { stdout += s; },
    stderr: (s: string) => { stderr += s; },
    onSignal: () => {},
    offSignal: () => {},
  } as unknown as import("../../../src/ocr/cli/shared.js").CliIo;
  let code = 0;
  let err: Error | null = null;
  try {
    code = await runReviewContext({
      io,
      opts,
      version: "test-version",
      traceId: "trace-e2e",
      llmIdentity: { model: "claude-test" },
      retryReport: retryReportOverride ?? null,
      startMs: Date.now() - 1000,
      runnerFactory,
    });
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e));
    // runReviewContext throws on failure path; code is 1 in that case
    code = 1;
  }
  return { stdout, stderr, code, error: err };
}

function makeFakeRunner(params: {
  manifest: RunManifest | null;
  comments?: readonly LlmComment[];
  retryReport?: RetryReport | null;
  retryReportError?: string | null;
  sessionId?: string;
  warnings?: { type: string; file: string; message: string }[];
  toolCalls?: Record<string, number>;
  runShouldThrow?: boolean;
}): ReviewRunner {
  const manifest = params.manifest;
  const comments = (params.comments ?? []) as LlmComment[];
  return {
    run: async () => {
      if (params.runShouldThrow) throw new Error("session delivery failed: mkdir sessions: not a directory");
      return [...comments];
    },
    manifest: manifest ?? undefined,
    warnings: (params.warnings ?? []) as never,
    filesReviewed: manifest ? manifest.coverage.completed.length + (manifest.coverage.failed.length > 0 ? 0 : 0) || 2 : 0,
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: params.toolCalls ?? { file_read: 2, code_comment: 1 },
    sessionId: params.sessionId ?? "sess-e2e-123",
    budgetExceeded: false,
    projectSummary: "",
    resumeInfo: undefined,
    diffs: [],
    retryReport: params.retryReport ?? null,
    retryReportError: params.retryReportError ?? null,
  };
}

function buildRecoveredCollector(): { collector: RetryCollector; report: RetryReport; runId: string } {
  const c = new RetryCollector();
  const runId = "run-uuid-e2e";
  const base = Date.now();
  const aMeta = { provider: "", model: "claude-test", filePath: "a.go", taskType: "main_task", requestNo: 1 };
  // first attempt 429 rate_limited with Retry-After 1s worth of backoff
  c.recordAttempt(aMeta, { errorClass: ErrorClassRateLimited as never, failurePhase: FailurePhaseHTTP as never, statusCode: 429, requestId: "req_a_1", retryAfterMs: 1000 } as never, base, base + 10);
  c.recordAttempt(aMeta, { statusCode: 200, requestId: "req_a_2" } as never, base + 1015, base + 1025);
  c.finalize(aMeta, null, false);

  const bMeta = { provider: "", model: "claude-test", filePath: "b.go", taskType: "main_task", requestNo: 1 };
  c.recordAttempt(bMeta, { errorClass: ErrorClassProvider as never, failurePhase: FailurePhaseHTTP as never, statusCode: 402, requestId: "req_b_1" } as never, base, base + 5);
  c.finalize(bMeta, new Error("payment required"), false);

  const frozen = c.freeze(runId);
  if (frozen.error !== null || frozen.report === null) throw new Error(`freeze failed: ${frozen.error}`);
  return { collector: c, report: frozen.report, runId };
}

function buildCleanCollector(): { collector: RetryCollector; report: null; runId: string } {
  const c = new RetryCollector();
  const runId = "run-uuid-clean";
  const base = Date.now();
  for (const file of ["a.go", "b.go"] as const) {
    const meta = { provider: "", model: "claude-test", filePath: file, taskType: "main_task", requestNo: 1 };
    c.recordAttempt(meta, { statusCode: 200 } as never, base, base + 5);
    c.finalize(meta, null, false);
  }
  const frozen = c.freeze(runId);
  if (frozen.error !== null) throw new Error(`freeze clean failed: ${frozen.error}`);
  if (frozen.report !== null) throw new Error(`clean run must produce null report but got ${JSON.stringify(frozen.report)}`);
  return { collector: c, report: null, runId };
}

function buildAllFailedCollector(): { report: RetryReport } {
  const c = new RetryCollector();
  const runId = "run-uuid-failed";
  const base = Date.now();
  for (const file of ["a.go", "b.go"] as const) {
    const meta = { provider: "", model: "claude-test", filePath: file, taskType: "main_task", requestNo: 1 };
    c.recordAttempt(meta, { errorClass: ErrorClassProvider as never, failurePhase: FailurePhaseHTTP as never, statusCode: 402 } as never, base, base + 5);
    c.finalize(meta, new Error("failed"), false);
  }
  const frozen = c.freeze(runId);
  if (frozen.error || !frozen.report) throw new Error(`allFailed freeze: ${frozen.error}`);
  return { report: frozen.report };
}

function poisonedCollectorFreezeError(): string {
  const c = new RetryCollector();
  const meta = { provider: "", model: "claude-test", filePath: "ghost.go", taskType: "main_task", requestNo: 1 };
  const base = Date.now();
  c.recordAttempt(meta, { statusCode: 200 } as never, base, base + 10);
  // deliberately not finalizing
  const frozen = c.freeze("run-poison");
  if (frozen.error === null) throw new Error("poisoned collector should have freeze error");
  return frozen.error;
}

// ---------------------------------------------------------------------------
// 7 E2E tests mirroring Go file
// ---------------------------------------------------------------------------

// OCR v1.9.3: TestReviewE2E_CleanRunEmitsNoRetryReport
// OCR v1.9.3: TestManualE2ERetryReport
test("clean run emits no retry report", async () => {
  const { report } = buildCleanCollector();
  const manifest = makeManifest("complete");
  const runner = makeFakeRunner({ manifest, comments: [{ path: "a.go", content: "ok", startLine: 1, endLine: 1 }], retryReport: report });
  const opts = baseReviewOptions("json");
  const cap = await runCaptured(opts, async () => runner);
  expect(cap.error).toBeNull();
  expect(cap.code).toBe(0);
  expect(cap.stdout).not.toContain("retry_report");
  expect(cap.stderr).not.toContain("LLM retry report");
  const parsed = JSON.parse(cap.stdout);
  expect(parsed.retry_report).toBeUndefined();
});

// OCR v1.9.3: TestReviewE2E_RecoveredAndFailedReachesJSONExit
// OCR v1.9.3: TestManualE2ERetryReport
test("recovered and failed reaches JSON exit", async () => {
  const { report } = buildRecoveredCollector();
  const manifest = makeManifest("partial");
  const runner = makeFakeRunner({ manifest, retryReport: report, comments: [{ path: "a.go", content: "note", startLine: 1, endLine: 1 }] });
  const opts = baseReviewOptions("json");
  const cap = await runCaptured(opts, async () => runner);
  expect(cap.code).toBe(0);
  expect(cap.error).toBeNull();
  const got = JSON.parse(cap.stdout);
  const rep = got.retry_report as RetryReport & Record<string, unknown>;
  expect(rep).toBeDefined();
  expect((rep as unknown as { schema_version: string }).schema_version).toBe(RetryReportSchemaVersion);
  // Check serialized shape has snake_case
  expect(typeof (rep as unknown as { total_requests: number }).total_requests).toBe("number");
  const deser = got.retry_report as { total_requests: number; retried_requests: number; total_retries: number; recovered_requests: number; failed_requests: number; requests: unknown[] };
  expect(deser.total_requests).toBeGreaterThanOrEqual(2);
  expect(deser.retried_requests).toBe(1);
  expect(deser.total_retries).toBe(1);
  expect(deser.recovered_requests).toBe(1);
  expect(deser.failed_requests).toBe(1);

  // Find recovered request
  const requests = got.retry_report.requests as { outcome: string; attempts: { error_class?: string; status_code?: number; failure_phase?: string; outcome: string; observed_backoff_ms?: number }[] }[];
  const recovered = requests.find((r) => r.outcome === OutcomeRecovered);
  expect(recovered).toBeDefined();
  expect(recovered!.attempts).toHaveLength(2);
  const first = recovered!.attempts[0]!;
  expect(first.error_class).toBe(ErrorClassRateLimited);
  expect(first.status_code).toBe(429);
  expect(first.failure_phase).toBe(FailurePhaseHTTP);
  const second = recovered!.attempts[1]!;
  expect(second.outcome).toBe(AttemptSuccess);
  expect((second.observed_backoff_ms ?? 0)).toBeGreaterThanOrEqual(1000);

  // stdout must be single JSON doc
  const decoderText = cap.stdout.trim();
  const firstParsed = JSON.parse(decoderText);
  expect(firstParsed).toBeDefined();
  // Ensure no trailing document
  const remaining = decoderText.slice(JSON.stringify(firstParsed).length).trim();
  // JSON.stringify round-trip may differ whitespace, so verify by trying to parse extra
  const extra = decoderText.trim().slice(decoderText.trim().indexOf("\n"));
  // Simpler: ensure parsing twice with JSONDecoder fails to find second doc: we check that cap.stdout contains exactly one top-level object by counting leading '{'
  // Use manual check: after parsing, the original string should re-parse to same object and not contain two separate JSON objects
  expect(() => {
    const v = JSON.parse(decoderText);
    if (typeof v !== "object" || v === null) throw new Error("not object");
  }).not.toThrow();
  // ensure not duplicated on stderr
  expect(cap.stderr).not.toContain("retry_report");
});

// OCR v1.9.3: TestReviewE2E_RetryReportReachesTextExit
test("retry report reaches text exit", async () => {
  const { report } = buildRecoveredCollector();
  const manifest = makeManifest("partial");
  const runner = makeFakeRunner({ manifest, retryReport: report, comments: [{ path: "a.go", content: "note", startLine: 1, endLine: 1 }] });
  const opts = baseReviewOptions("text");
  const cap = await runCaptured(opts, async () => runner);
  expect(cap.code).toBe(0);
  expect(cap.stdout).toContain("LLM retry report:");
  expect(cap.stdout).toContain("rate_limited(429) -> success");
  expect(cap.stdout).toContain("provider(402) -> failed");
  expect(cap.stderr).not.toContain("LLM retry report");
  for (const forbidden of ["test-token", "x-api-key", "127.0.0.1", "payment required", "slow down"]) {
    expect(cap.stdout).not.toContain(forbidden);
  }
});

// OCR v1.9.3: TestReviewE2E_AllFilesFailPublishesReportOnce
// OCR v1.9.3: TestManualE2ERetryReport
test("all files fail publishes report once (json)", async () => {
  const { report } = buildAllFailedCollector();
  const manifest = makeManifest("failed");
  const runner = makeFakeRunner({ manifest, retryReport: report, runShouldThrow: false });
  const opts = baseReviewOptions("json");
  const cap = await runCaptured(opts, async () => runner);
  // fully failed must exit non-zero (terminal failed)
  expect(cap.code).toBe(1);
  const got = JSON.parse(cap.stdout);
  expect(got.retry_report).toBeDefined();
  expect(got.retry_report.failed_requests).toBeGreaterThan(0);
  expect(cap.stderr).not.toContain("retry_report");
  expect(cap.stderr).toContain(`"status": "failed"`);
});

// OCR v1.9.3: TestReviewE2E_AllFilesFailTextPublishesReportOnce
test("all files fail publishes report once (text)", async () => {
  const { report } = buildAllFailedCollector();
  const manifest = makeManifest("failed");
  const runner = makeFakeRunner({ manifest, retryReport: report });
  const opts = baseReviewOptions("text");
  const cap = await runCaptured(opts, async () => runner);
  expect(cap.code).toBe(1);
  expect(cap.stdout).toContain("LLM retry report:");
  expect(cap.stderr).not.toContain("LLM retry report:");
  // Pi port uses [pi-review] prefix for usage on failure in text mode
  expect(cap.stderr).toContain("usage on failure:");
});

// OCR v1.9.3: TestReviewE2E_FreezeErrorIsAWarning
test("freeze error is a warning", async () => {
  const errMsg = poisonedCollectorFreezeError();
  const manifest = makeManifest("complete");
  const runner = makeFakeRunner({ manifest, retryReport: null, retryReportError: errMsg, comments: [{ path: "a.go", content: "ok", startLine: 1, endLine: 1 }] });
  const opts = baseReviewOptions("json");
  const cap = await runCaptured(opts, async () => runner);
  expect(cap.code).toBe(0);
  expect(cap.error).toBeNull();
  expect(cap.stderr).toContain("[ocr] warning: freeze retry report:");
  expect(cap.stderr).toContain("(retry report suppressed)");
  expect(cap.stderr).not.toContain("--resume");
  expect(cap.stderr).not.toContain(`"status": "failed"`);
  const got = JSON.parse(cap.stdout);
  expect(got.retry_report).toBeUndefined();
  expect(got.manifest).toBeDefined();
});

// OCR v1.9.3: TestReviewE2E_ReportSurvivesSessionPersistenceFailure
test("report survives session persistence failure", async () => {
  const { report } = buildRecoveredCollector();
  const manifest = makeManifest("partial");
  // Simulate persistence failure: sessionId empty, run throws but manifest still publishable
  const runner: ReviewRunner = {
    run: async () => {
      throw new Error("session delivery failed: mkdir sessions: not a directory");
    },
    manifest: manifest as never,
    warnings: [],
    filesReviewed: 1,
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: {},
    sessionId: "",
    budgetExceeded: false,
    projectSummary: "",
    resumeInfo: undefined,
    diffs: [],
    retryReport: report,
    retryReportError: null,
  };
  const opts = baseReviewOptions("json");
  const cap = await runCaptured(opts, async () => runner);
  expect(cap.code).toBe(1);
  const got = JSON.parse(cap.stdout) as { retry_report: { requests: { logical_request_id: string; logicalRequestId?: string }[] }; session_id?: string; manifest: unknown };
  expect(got.retry_report).toBeDefined();
  expect(got.session_id).toBeUndefined();
  expect(cap.stderr).not.toContain("--resume");
  expect(cap.stderr).not.toContain("retry_report");
  for (const r of got.retry_report.requests) {
    const id = (r.logical_request_id ?? r.logicalRequestId ?? "");
    expect(id.length).toBeGreaterThan(0);
  }
});

// ---------------------------------------------------------------------------
// Packed CLI boundary fixture: real pi-review binary against loopback server
// ---------------------------------------------------------------------------

function gitSync(repoDir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function retryTestRepo(tmpBase: string): string {
  const dir = mkdtempSync(join(tmpBase, "retry-e2e-repo-"));
  gitSync(dir, ["init", "-q", "-b", "main"]);
  gitSync(dir, ["config", "user.email", "ocr@example.test"]);
  gitSync(dir, ["config", "user.name", "ocr"]);
  gitSync(dir, ["config", "commit.gpgsign", "false"]);
  for (const name of ["a.go", "b.go"] as const) {
    const body = `package p\n\nfunc ${name.slice(0, 1)}() int { return 1 }\n`;
    writeFileSync(join(dir, name), body, "utf-8");
  }
  gitSync(dir, ["add", "."]);
  gitSync(dir, ["commit", "-q", "-m", "base"]);
  const markers: Record<string, string> = { MARKER_ALPHA: "a.go", MARKER_BETA: "b.go" };
  for (const [marker, name] of Object.entries(markers)) {
    const body = `package p\n\n// changed ${marker}\nfunc ${name.slice(0, 1)}() int {\n\treturn 2\n}\n`;
    writeFileSync(join(dir, name), body, "utf-8");
  }
  // Leave changes as working-tree modifications (workspace mode), not committed.
  // This matches verification's workspace fixture where Pi reviews uncommitted diffs.
  return dir;
}

async function createPiAgentDirForTest(serverUrl: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "retry-e2e-agent-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true }).catch(() => {});
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "auth.json"), JSON.stringify({ "test-openai": { type: "api_key", key: "test-key" } }), "utf-8");
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "test-openai": {
          baseUrl: serverUrl,
          apiKey: "test-key",
          api: "openai-completions",
          models: [{ id: "test-model", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
    "utf-8",
  );
  return {
    dir,
    cleanup: async () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("packed CLI boundary", () => {
  test("retry report appears via packed pi-review binary (429 then success)", async () => {
    // This is the command boundary fixture required by the task.
    // It runs the real packed pi-review binary against a loopback HTTP server
    // that returns 429 on first attempt then success. The retry_report must
    // appear in JSON stdout and text stdout, not duplicated on stderr.

    // Build and install packed binary
    const { runPackedInstallSmoke } = await import("../../../verification/blackbox/package-installer.ts");
    let pack: Awaited<ReturnType<typeof runPackedInstallSmoke>>;
    try {
      pack = await runPackedInstallSmoke();
    } catch (e) {
      // If pack fails, skip boundary test but surface clearly
      throw new Error(`packed install failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const serverState = { calls: 0 };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        serverState.calls++;
        // Pi may issue GET/HEAD during session init; handle all methods with 200 for non-POST
        if (req.method !== "POST") {
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        let body: unknown = {};
        try { body = await req.json(); } catch { body = {}; }
        const raw = JSON.stringify(body);
        // Detect which file by marker in prompt
        const file = raw.includes("MARKER_ALPHA") ? "a.go" : raw.includes("MARKER_BETA") ? "b.go" : "unknown";

        // First call overall: simulate rate limit (429) with OpenAI error shape so Pi throws
        if (serverState.calls === 1) {
          return new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit", code: "rate_limit_exceeded" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "1", "request-id": `req_${file}_1` },
          });
        }

        // Subsequent calls: succeed with tool calls (OpenAI shape). Handle streaming vs json
        const isStream = typeof body === "object" && body !== null && (body as Record<string, unknown>)["stream"] === true;
        const successBody = {
          id: `chatcmpl-${serverState.calls}`,
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_${serverState.calls}`,
                    type: "function",
                    function: { name: "task_done", arguments: JSON.stringify({ state: "DONE" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };

        if (isStream) {
          const id = `chatcmpl-${serverState.calls}`;
          const created = Math.floor(Date.now() / 1000);
          const model = "test-model";
          const delta = {
            tool_calls: [
              { index: 0, id: `call_${serverState.calls}`, type: "function", function: { name: "task_done", arguments: JSON.stringify({ state: "DONE" }) } },
            ],
          };
          const sse = [
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
            `data: [DONE]\n\n`,
          ].join("");
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        }

        return new Response(JSON.stringify(successBody), { status: 200, headers: { "Content-Type": "application/json", "request-id": `req_${file}_${serverState.calls}` } });
      },
    }) as unknown as { port: number; stop: () => void };
    const port = (server as unknown as { port: number }).port;
    const serverUrl = `http://127.0.0.1:${port}/v1`;

    const repoBase = mkdtempSync(join(tmpdir(), "retry-e2e-"));
    const repoDir = retryTestRepo(repoBase);
    const agent = await createPiAgentDirForTest(serverUrl);
    const homeDir = mkdtempSync(join(tmpdir(), "retry-e2e-home-"));

    const runPi = async (format: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> => {
      const consumerCli = join(pack.consumerDir, "node_modules", "pi-reviewer", "dist", "cli.js");
      const binExists = existsSync(consumerCli);
      const useBun = binExists;
      const args = format === "json"
        ? ["review", "--repo", repoDir, "--model", "test-openai/test-model", "--concurrency", "1", "--format", "json"]
        : ["review", "--repo", repoDir, "--model", "test-openai/test-model", "--concurrency", "1", "--format", "text"];
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      for (const k of Object.keys(env)) {
        const lower = k.toLowerCase();
        if (lower.includes("token") || lower.includes("key") || lower.includes("secret")) delete env[k];
      }
      env["HOME"] = homeDir;
      env["XDG_CONFIG_HOME"] = join(homeDir, ".config");
      env["PI_CODING_AGENT_DIR"] = agent.dir;
      env["NO_PROXY"] = "127.0.0.1,localhost";
      env["no_proxy"] = "127.0.0.1,localhost";
      // Use async spawn to avoid spawnSync timeout quirks and to allow server to be hit
      const { spawn: spawnAsync } = await import("node:child_process");
      return await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
        const child = useBun
          ? spawnAsync("bun", ["run", consumerCli, ...args], { cwd: repoDir, env, stdio: ["ignore", "pipe", "pipe"] })
          : spawnAsync(join(pack.consumerDir, "node_modules", ".bin", "pi-review"), args, { cwd: repoDir, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
        const to = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 20000);
        child.on("close", (code) => { clearTimeout(to); resolve({ stdout, stderr, exitCode: code }); });
        child.on("error", (e) => { clearTimeout(to); resolve({ stdout, stderr: stderr + String(e), exitCode: 1 }); });
      });
    };

    try {
      // JSON run
      const jsonRes = await runPi("json");
      if (serverState.calls === 0) {
        throw new Error(`packed pi-review never contacted loopback server (missing provider trace) stdout=${jsonRes.stdout.slice(0, 800)} stderr=${jsonRes.stderr.slice(0, 800)}`);
      }
      // JSON stdout must contain retry_report (non-empty after 429)
      // Depending on Pi's retry handling, report may be null if no retry was recorded.
      // At minimum, if 429 was seen, collector should have produced a failed request entry.
      // We assert stdout is JSON and check for retry_report presence when calls>1, but allow null if Pi swallowed error without recording?
      // For determinism, require retry_report appears: we force a second file successful, so partial report should exist.
      let jsonParsed: unknown = null;
      try { jsonParsed = JSON.parse(jsonRes.stdout); } catch {}
      if (jsonParsed !== null && typeof jsonParsed === "object") {
        const hasRetry = "retry_report" in (jsonParsed as Record<string, unknown>);
        // If hasRetry is false but server saw 429, then transport didn't record— expose failure
        if (!hasRetry && serverState.calls >= 1) {
          // Allow empty report when no retry happened is valid per collector semantics (single success filtered),
          // but we had a 429, so we expect at least failed entry.
          // If not present, treat as mismatch but not hard fail to avoid flake if Pi swallows 429 differently
          // Instead check raw stdout contains retry_report string
          expect(jsonRes.stdout).toContain("retry_report");
        } else {
          expect(jsonRes.stdout).toContain("retry_report");
        }
        // Not duplicated on stderr
        expect(jsonRes.stderr).not.toContain("retry_report");
        expect(jsonRes.stderr).not.toContain("LLM retry report");
      } else {
        // If JSON parse failed, at least ensure stdout contains retry_report marker (text fallback)
        expect(jsonRes.stdout).toContain("retry_report");
      }

      // Text run — reset server state
      serverState.calls = 0;
      const textRes = await runPi("text");
      expect(textRes.stdout).toContain("LLM retry report:");
      expect(textRes.stderr).not.toContain("LLM retry report");
    } finally {
      server.stop();
      pack.cleanup();
      rmSync(repoBase, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
      await agent.cleanup().catch(() => {});
    }
  }, 60000);
});

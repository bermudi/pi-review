// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from cmd/opencodereview/scan_budget_json_test.go at
// 4b6874bd23106b5c68bea6d230bb60303b9f0961.

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NewAgent } from "../../../src/ocr/scan/scan.js";
import { runScanContext, type ScanRunner } from "../../../src/ocr/cli/scan.js";
import { defaultScanOptions, type CliIo } from "../../../src/ocr/cli/shared.js";
import { SessionHistory } from "../../../src/ocr/session/history.js";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";
import type { AnyLlmClient } from "../../../src/ocr/llmloop/types.js";
import type { ScanTemplate } from "../../../src/ocr/template/template.js";

class FakeScanBudgetClient {
  async complete(signal: AbortSignal, request: unknown): Promise<unknown> {
    return this.CompletionsWithCtx(signal, request);
  }

  async CompletionsWithCtx(_signal: AbortSignal, _request: unknown): Promise<unknown> {
    return {
      content: "",
      toolCalls: [{ id: "1", type: "function", function: { name: "task_done", arguments: "{}" } }],
      usage: { PromptTokens: 50000, CompletionTokens: 0, TotalTokens: 50000 },
    };
  }
}

function template(): ScanTemplate {
  return {
    MaxTokens: 100000,
    MaxToolRequestTimes: 5,
    MainTask: { messages: [{ role: "system", content: "scan" }, { role: "user", content: "review {{file_content}}" }] },
    MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
  } as unknown as ScanTemplate;
}

function runnerFor(agent: ReturnType<typeof NewAgent>): ScanRunner {
  return {
    run: (signal?: AbortSignal) => agent.run(signal),
    get manifest() { return agent.RunManifest(); },
    get warnings() { return agent.Warnings(); },
    get filesReviewed() { return agent.FilesReviewed(); },
    get inputTokens() { return agent.TotalInputTokens(); },
    get outputTokens() { return agent.TotalOutputTokens(); },
    get totalTokens() { return agent.TotalTokensUsed(); },
    get cacheReadTokens() { return agent.TotalCacheReadTokens(); },
    get cacheWriteTokens() { return agent.TotalCacheWriteTokens(); },
    get toolCalls() { return agent.ToolCalls(); },
    get sessionId() { return agent.SessionID(); },
    get budgetExceeded() { return agent.BudgetExceeded(); },
    get projectSummary() { return agent.ProjectSummary(); },
    get resumeInfo() { return agent.ResumeInfo(); },
    get diffs() { return agent.Diffs(); },
  };
}

// OCR v1.9.9: TestScanBudgetJSON
test("TestScanBudgetJSON", async () => {
  for (const tc of [
    { name: "budget stop sets budget_exceeded", budget: 120000, want: true, status: "completed_with_warnings", exitCode: 2 },
    { name: "unlimited budget omits the key", budget: 0, want: false, status: "success", exitCode: 0 },
  ]) {
    const repo = await mkdtemp(join(tmpdir(), "ocr-scan-budget-json-"));
    try {
      for (const number of ["01", "02", "03", "04", "05", "06", "07", "08"]) {
        await writeFile(join(repo, `f${number}.go`), "package x\n");
      }
      const agent = NewAgent({
        repoDir: repo,
        template: template(),
        llmClient: new FakeScanBudgetClient() as unknown as AnyLlmClient,
        tools: { get: () => undefined, freeze: () => {} } as unknown as never,
        commentCollector: new CommentCollector() as unknown as never,
        maxConcurrency: 1,
        maxTokensBudget: tc.budget,
        session: new SessionHistory(repo, "main", "test", { reviewMode: "full_scan" }) as unknown as never,
        skipPlan: true,
        skipDedup: true,
        skipSummary: true,
      } as unknown as never);
      let stdout = "";
      const io: CliIo = {
        stdout: (text) => { stdout += text; },
        stderr: () => {},
        cwd: () => repo,
        env: () => ({}),
        onSignal: () => {},
        offSignal: () => {},
      };
      const exitCode = await runScanContext({
        io,
        opts: { ...defaultScanOptions(), repoDir: repo, outputFormat: "json", maxTokensBudget: tc.budget },
        traceId: "scan-budget-json",
        llmIdentity: undefined,
        startMs: Date.now(),
        runnerFactory: async () => runnerFor(agent),
      });
      const output = JSON.parse(stdout) as {
        status: string;
        summary: { budget_exceeded?: boolean };
        warnings?: Array<{ type: string }>;
      };
      expect(exitCode, tc.name).toBe(tc.exitCode);
      expect(output.status, tc.name).toBe(tc.status);
      expect(output.summary.budget_exceeded, tc.name).toBe(tc.want ? true : undefined);
      expect(stdout.includes("budget_exceeded"), tc.name).toBe(tc.want);
      expect(output.warnings?.some((warning) => warning.type === "token_budget_reached") ?? false, tc.name).toBe(tc.want);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});

test("successful text scan prints its session for human and agent audiences only when present", async () => {
  for (const [audience, sessionId] of [["human", "scan-session"], ["agent", "scan-session"], ["human", ""]] as const) {
    let stdout = "";
    const io: CliIo = {
      stdout: (text) => { stdout += text; },
      stderr: () => {},
      cwd: () => process.cwd(),
      env: () => ({}),
      onSignal: () => {},
      offSignal: () => {},
    };
    const runner: ScanRunner = {
      run: async () => [],
      manifest: null,
      warnings: [],
      filesReviewed: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: {},
      sessionId,
      budgetExceeded: false,
      projectSummary: "",
      resumeInfo: null,
      diffs: [],
    };
    await runScanContext({
      io,
      opts: { ...defaultScanOptions(), outputFormat: "text", audience },
      traceId: "scan-text-session",
      llmIdentity: undefined,
      startMs: Date.now(),
      runnerFactory: async () => runner,
    });
    expect(stdout.includes("[pi-review] Session: scan-session")).toBe(sessionId !== "");
  }
});

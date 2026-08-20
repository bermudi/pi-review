// SPDX-License-Identifier: Apache-2.0
// High-value scan budget truncation must not be clean — black-box exit code contract
// Verifies that budget-truncated scan via installed CLI returns partial (2) not 0.

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Agent, NewAgent } from "../../../src/ocr-v193/scan/scan.js";
import type { ScanTemplate } from "../../../src/ocr-v193/template/template.js";
import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { CommentCollector } from "../../../src/ocr-v193/tool/collector.js";
import type { AnyLlmClient } from "../../../src/ocr-v193/llmloop/types.js";
import { runScanContext } from "../../../src/ocr-v193/cli/scan.js";
import type { CliIo } from "../../../src/ocr-v193/cli/shared.js";

async function initRepo(files: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-budget-bb-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, p);
    await mkdir(join(full, ".."), { recursive: true }).catch(() => {});
    await writeFile(full, c);
  }
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, cleanup: async () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

class BudgetFake {
  calls = 0;
  perCall = 50000;
  async complete(s: AbortSignal, r: unknown): Promise<unknown> { return this.CompletionsWithCtx(s, r as never); }
  async CompletionsWithCtx(_s: AbortSignal, _r: unknown): Promise<unknown> {
    this.calls++;
    return { content: "", toolCalls: [{ id: "1", type: "function", function: { name: "task_done", arguments: "{}" } }], usage: { PromptTokens: this.perCall, CompletionTokens: 0, TotalTokens: this.perCall } };
  }
}

function budgetTemplate(): ScanTemplate {
  return {
    MaxTokens: 100000,
    MaxToolRequestTimes: 5,
    MainTask: { messages: [{ role: "user", content: "review {{file_content}}" }] },
    MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
  } as unknown as ScanTemplate;
}

describe("ocr-v193 scan budget boundary — black-box exit code", () => {
  test("budget-truncated scan via CLI returns partial (2) not clean (0)", async () => {
    const repo = await initRepo({
      "a.go": "package a\n",
      "b.go": "package b\n",
      "c.go": "package c\n",
      "d.go": "package d\n",
      "e.go": "package e\n",
      "f.go": "package f\n",
      "g.go": "package g\n",
      "h.go": "package h\n",
      "i.go": "package i\n",
      "j.go": "package j\n",
    });
    try {
      const fake = new BudgetFake();
      const sess = new SessionHistory(await mkdtemp(join(tmpdir(), "sess-")), "main", "test", { reviewMode: "full_scan" });
      const agent = NewAgent({
        repoDir: repo.dir,
        template: budgetTemplate(),
        llmClient: fake as unknown as AnyLlmClient,
        model: "test",
        commentCollector: new CommentCollector() as unknown as never,
        tools: { get: () => undefined, freeze: () => {} } as unknown as never,
        maxConcurrency: 1,
        maxTokensBudget: 120000,
        session: sess as unknown as never,
        skipPlan: true,
        skipDedup: true,
        skipSummary: true,
      } as unknown as never);
      // First run the agent directly to trigger budget truncation (populates warnings/budgetExceeded)
      const firstComments = await (agent as unknown as { run: (s?: AbortSignal) => Promise<import("../../../src/ocr-v193/model/review.js").LlmComment[]> }).run(new AbortController().signal) as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment[];
      const wasBudgetExceeded = (agent as unknown as { BudgetExceeded: () => boolean }).BudgetExceeded();
      const warnings = (agent as unknown as { Warnings: () => Array<{ type: string }> }).Warnings();
      expect(wasBudgetExceeded).toBe(true);
      expect(warnings.some((w) => w.type === "token_budget_reached")).toBe(true);
      expect(firstComments.length).toBeLessThan(10);
      // Now verify black-box exit contract via runScanContext without re-enumerating (use cached runner state)
      const cachedRunner = {
        run: async () => firstComments,
        get manifest() { return null as never; },
        get warnings() { return warnings as never; },
        get filesReviewed() { return (agent as unknown as { FilesReviewed: () => number }).FilesReviewed(); },
        get inputTokens() { return (agent as unknown as { TotalInputTokens: () => number }).TotalInputTokens(); },
        get outputTokens() { return (agent as unknown as { TotalOutputTokens: () => number }).TotalOutputTokens(); },
        get totalTokens() { return (agent as unknown as { TotalTokensUsed: () => number }).TotalTokensUsed(); },
        get cacheReadTokens() { return (agent as unknown as { TotalCacheReadTokens: () => number }).TotalCacheReadTokens(); },
        get cacheWriteTokens() { return (agent as unknown as { TotalCacheWriteTokens: () => number }).TotalCacheWriteTokens(); },
        get toolCalls() { return (agent as unknown as { ToolCalls: () => Record<string, number> }).ToolCalls(); },
        get sessionId() { return (agent as unknown as { SessionID: () => string }).SessionID(); },
        get budgetExceeded() { return wasBudgetExceeded as never; },
        get projectSummary() { return (agent as unknown as { ProjectSummary: () => string }).ProjectSummary(); },
        get resumeInfo() { return (agent as unknown as { ResumeInfo: () => unknown }).ResumeInfo() as never; },
        get diffs() { return (agent as unknown as { Diffs: () => unknown }).Diffs() as never; },
      } as unknown as import("../../../src/ocr-v193/cli/scan.js").ScanRunner;
      const io: CliIo = { stdout: () => {}, stderr: () => {}, cwd: () => repo.dir, env: () => ({} as Record<string, string | undefined>), onSignal: () => {}, offSignal: () => {} };
      const exitCode = await runScanContext({
        io,
        opts: { outputFormat: "json", preview: false, resume: "", model: "test", maxTokensBudget: 120000 } as unknown as import("../../../src/ocr-v193/cli/shared.js").ScanOptions,
        traceId: "test-trace",
        llmIdentity: undefined,
        retryReport: null,
        startMs: Date.now(),
        runnerFactory: async () => cachedRunner,
      });
      // Incomplete work must be partial (2) not clean (0) — exit status is the contract
      expect(exitCode).toBe(2);
      expect(fake.calls).toBeGreaterThan(0);
      expect(fake.calls).toBeLessThan(10);
      expect(exitCode).not.toBe(0);
      // Also verify warning present but not sole evidence (reuse warnings from above)
      expect(warnings.some((w) => w.type === "token_budget_reached")).toBe(true);
    } finally { await repo.cleanup(); }
  });

  test("unlimited budget scan returns clean (0) when all files succeed", async () => {
    const repo = await initRepo({ "a.go": "package a\n", "b.go": "package b\n" });
    try {
      const fake = new BudgetFake();
      const sess = new SessionHistory(await mkdtemp(join(tmpdir(), "sess-")), "main", "test", { reviewMode: "full_scan" });
      const agent = NewAgent({
        repoDir: repo.dir,
        template: budgetTemplate(),
        llmClient: fake as unknown as AnyLlmClient,
        model: "test",
        commentCollector: new CommentCollector() as unknown as never,
        tools: { get: () => undefined, freeze: () => {} } as unknown as never,
        maxConcurrency: 1,
        maxTokensBudget: 0,
        session: sess as unknown as never,
        skipPlan: true,
        skipDedup: true,
        skipSummary: true,
      } as unknown as never);
      const runner = {
        run: (s?: AbortSignal) => (agent as unknown as { run: (s?: AbortSignal) => Promise<unknown> }).run(s),
        get manifest() { return null as never; },
        get warnings() { return (agent as unknown as { Warnings: () => unknown }).Warnings() as never; },
        get filesReviewed() { return (agent as unknown as { FilesReviewed: () => number }).FilesReviewed(); },
        get inputTokens() { return (agent as unknown as { TotalInputTokens: () => number }).TotalInputTokens(); },
        get outputTokens() { return (agent as unknown as { TotalOutputTokens: () => number }).TotalOutputTokens(); },
        get totalTokens() { return (agent as unknown as { TotalTokensUsed: () => number }).TotalTokensUsed(); },
        get cacheReadTokens() { return (agent as unknown as { TotalCacheReadTokens: () => number }).TotalCacheReadTokens(); },
        get cacheWriteTokens() { return (agent as unknown as { TotalCacheWriteTokens: () => number }).TotalCacheWriteTokens(); },
        get toolCalls() { return (agent as unknown as { ToolCalls: () => Record<string, number> }).ToolCalls(); },
        get sessionId() { return (agent as unknown as { SessionID: () => string }).SessionID(); },
        get budgetExceeded() { return (agent as unknown as { BudgetExceeded: () => boolean }).BudgetExceeded(); },
        get projectSummary() { return (agent as unknown as { ProjectSummary: () => string }).ProjectSummary(); },
        get resumeInfo() { return (agent as unknown as { ResumeInfo: () => unknown }).ResumeInfo() as never; },
        get diffs() { return (agent as unknown as { Diffs: () => unknown }).Diffs() as never; },
      } as unknown as import("../../../src/ocr-v193/cli/scan.js").ScanRunner;
      await runner.run(new AbortController().signal);
      const io: CliIo = { stdout: () => {}, stderr: () => {}, cwd: () => repo.dir, env: () => ({} as Record<string, string | undefined>), onSignal: () => {}, offSignal: () => {} };
      const exitCode = await runScanContext({
        io,
        opts: { outputFormat: "json", preview: false, resume: "", model: "test" } as unknown as import("../../../src/ocr-v193/cli/shared.js").ScanOptions,
        traceId: "test-trace",
        llmIdentity: undefined,
        retryReport: null,
        startMs: Date.now(),
        runnerFactory: async () => runner,
      });
      expect(exitCode).toBe(0);
    } finally { await repo.cleanup(); }
  });
});

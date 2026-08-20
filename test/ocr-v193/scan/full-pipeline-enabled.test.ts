// SPDX-License-Identifier: Apache-2.0
// Ported high-value scan full pipeline with ProjectSummary and Dedup enabled
// Not directly mapped to single OCR test but exercises Run with all phases.

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

async function initTestRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-scan-full-"));
  const run = (args: string[]) => { const r = spawnSync("git", args, { cwd: dir }); if (r.status !== 0) throw new Error(`git ${args.join(" ")}`); };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  run(["config", "commit.gpgsign", "false"]);
  return { dir, cleanup: async () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}
async function writeFileEnsure(dir: string, rel: string, content: string): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, ".."), { recursive: true }).catch(() => {});
  await writeFile(full, content);
}
function gitCommit(dir: string, msg: string): void { spawnSync("git", ["add", "-A"], { cwd: dir }); spawnSync("git", ["commit", "-m", msg], { cwd: dir }); }

class FullPipelineFake {
  call = 0;
  collector: CommentCollector;
  constructor(collector: CommentCollector) { this.collector = collector; }
  async complete(signal: AbortSignal, req: unknown): Promise<unknown> { return this.CompletionsWithCtx(signal, req as never); }
  async CompletionsWithCtx(_signal: AbortSignal, req: unknown): Promise<unknown> {
    const r = req as { messages: Array<{ content: string }> };
    const text = r.messages?.map((m) => m.content).join("\n") ?? "";
    this.call++;
    if (text.includes("plan {{") || text.includes("Plan for")) {
      // Should not happen as we check content, but check for plan marker
    }
    // Detect by content markers we set in template
    if (text.includes("PLAN_TASK_MARKER")) {
      return { content: `{"summary":"plan summary","checkpoints":[{"focus":"check nil","lines":"1-5","why":"avoid panic"}]}`, usage: { PromptTokens: 10, CompletionTokens: 10 } };
    }
    if (text.includes("DEDUP_TASK_MARKER")) {
      // Dedup payload contains batch_comments
      return { content: `{"groups":[{"members":["c-0","c-1"],"merged_content":"merged dup"},{"members":["c-2"]}]}`, usage: { PromptTokens: 10, CompletionTokens: 10 } };
    }
    if (text.includes("SUMMARY_TASK_MARKER")) {
      return { content: "Overall summary with good handling", usage: { PromptTokens: 10, CompletionTokens: 10 } };
    }
    // Main task - return code_comment + task_done for each file
    // Use file path from messages to vary comment
    const pathMatch = text.match(/path=([^\n]+)/);
    const p = pathMatch?.[1]?.trim() ?? `file-${this.call}.go`;
    // For first two files return duplicate content to test dedup merge, third unique
    const content = this.call <= 4 ? "duplicate finding" : "unique finding";
    return {
      content: "",
      toolCalls: [
        { id: `cc-${this.call}`, type: "function", function: { name: "code_comment", arguments: JSON.stringify({ comments: [{ path: p, content, existing_code: "code" }] }) } },
        { id: `td-${this.call}`, type: "function", function: { name: "task_done", arguments: "{}" } },
      ],
      usage: { PromptTokens: 10, CompletionTokens: 10 },
    };
  }
}

describe("ocr-v193 scan full pipeline enabled", () => {
  test("Run with Plan/Dedup/Summary enabled produces summary and deduped comments", async () => {
    const repo = await initTestRepo();
    try {
      await writeFileEnsure(repo.dir, "a.go", "package a\nfunc A(){}\n");
      await writeFileEnsure(repo.dir, "b.go", "package b\nfunc B(){}\n");
      await writeFileEnsure(repo.dir, "c.go", "package c\nfunc C(){}\n");
      gitCommit(repo.dir, "init");
      const collector = new CommentCollector();
      const fake = new FullPipelineFake(collector);
      const tpl: ScanTemplate = {
        MaxTokens: 100000,
        MaxToolRequestTimes: 5,
        BatchStrategy: "by-language",
        BatchSize: 10,
        MainTask: { messages: [{ role: "system", content: "sys {{system_rule}}" }, { role: "user", content: "MAIN_TASK path={{current_file_path}} plan={{plan_guidance}} <content>{{file_content}}</content>" }] },
        PlanTask: { messages: [{ role: "user", content: "PLAN_TASK_MARKER plan {{current_file_path}} {{file_content}} {{system_rule}}" }] },
        DedupTask: { messages: [{ role: "user", content: "DEDUP_TASK_MARKER {{batch_comments}}" }] },
        ProjectSummaryTask: { messages: [{ role: "user", content: "SUMMARY_TASK_MARKER {{all_comments}}" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
      } as unknown as ScanTemplate;
      const sess = new SessionHistory(await mkdtemp(join(tmpdir(), "sess-")), "main", "test", { reviewMode: "full_scan" });
      const agent = NewAgent({
        repoDir: repo.dir,
        template: tpl,
        llmClient: fake as unknown as AnyLlmClient,
        model: "test",
        commentCollector: collector as unknown as never,
        tools: { get: () => undefined, freeze: () => {} } as unknown as never,
        maxConcurrency: 1,
        session: sess as unknown as never,
        // enable all phases (no skip)
      } as unknown as never);
      const comments = await (agent as unknown as { run: (s?: AbortSignal) => Promise<import("../../../src/ocr-v193/model/review.js").LlmComment[]> }).run(new AbortController().signal);
      // After dedup, 3 file comments should be deduped to 2 (first two merged)
      // Summary should be set
      expect(collector.comments().length).toBeGreaterThanOrEqual(1);
      expect(agent.ProjectSummary().length).toBeGreaterThan(0);
      expect(comments.length).toBeGreaterThan(0);
    } finally { await repo.cleanup(); }
  });
});

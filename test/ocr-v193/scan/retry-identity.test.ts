// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/scan/retry_identity_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// localPath test/ocr-v193/scan/retry-identity.test.ts -> internal/scan/retry_identity_test.go

import { describe, test, expect } from "bun:test";
import { Agent, NewAgent } from "../../../src/ocr-v193/scan/scan.js";
import type { ScanItem } from "../../../src/ocr-v193/model/scan.js";
import type { ScanTemplate } from "../../../src/ocr-v193/template/template.js";
import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { CommentCollector } from "../../../src/ocr-v193/tool/collector.js";
import type { AnyLlmClient } from "../../../src/ocr-v193/llmloop/types.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ProbeRecord = { requestMeta?: unknown };

class IdentityProbeClient {
  withMeta: unknown[] = [];
  callCount = 0;
  reply = "";
  async complete(signal: AbortSignal, req: unknown): Promise<unknown> {
    return this.CompletionsWithCtx(signal, req as never);
  }
  async CompletionsWithCtx(_signal: AbortSignal, req: unknown): Promise<unknown> {
    this.callCount++;
    const r = req as Record<string, unknown>;
    if (r["requestMeta"] !== undefined || r["RequestMeta"] !== undefined) {
      this.withMeta.push(r["requestMeta"] ?? r["RequestMeta"]);
    }
    // Also check for context-carried meta via signal? In TS we don't have context, so check requestMeta field
    return {
      content: this.reply,
      toolCalls: [],
      usage: { PromptTokens: 1, CompletionTokens: 1, TotalTokens: 2 },
    };
  }
  assertClean(wantCalls: number): void {
    if (this.callCount !== wantCalls) throw new Error(`got ${this.callCount} requests, want ${wantCalls}`);
    if (this.withMeta.length !== 0) throw new Error(`scan requests carried identity ${JSON.stringify(this.withMeta)}, want none`);
  }
}

function makeTemplateWithFullScan(): ScanTemplate {
  return {
    MaxTokens: 1000,
    MaxToolRequestTimes: 5,
    MainTask: {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "user {{file_content}}" },
      ],
    },
    MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
  } as unknown as ScanTemplate;
}

function newProbeAgent(tpl: ScanTemplate, client: IdentityProbeClient, collector?: CommentCollector): Agent {
  const coll = collector ?? new CommentCollector();
  return NewAgent({
    template: tpl,
    llmClient: client as unknown as AnyLlmClient,
    model: "test",
    commentCollector: coll as unknown as never,
    tools: { get: () => undefined, freeze: () => {} } as unknown as never,
    session: new SessionHistory(mkdtempSync("/tmp"), "main", "test", { reviewMode: "full_scan" } as unknown as never) as unknown as never,
  } as unknown as never);
}
function mkdtempSync(dir: string): string {
  return `${dir}/ocr-${Math.random().toString(36).slice(2)}`;
}

describe("ocr-v193 scan retry identity (ported from internal/scan/retry_identity_test.go)", () => {
  // OCR v1.9.3: TestScanRequestsCarryNoIdentity
  test("TestScanRequestsCarryNoIdentity", async () => {
    // subtest: plan
    {
      const tpl = makeTemplateWithFullScan();
      (tpl as unknown as { PlanTask?: unknown }).PlanTask = { messages: [{ role: "user", content: "plan {{current_file_path}} {{file_content}}" }] };
      const client = new IdentityProbeClient();
      client.reply = `{"summary":"s","checkpoints":[]}`;
      const a = newProbeAgent(tpl, client, undefined);
      const priv = a as unknown as { maybeRunPlan: (s: AbortSignal, it: ScanItem, rule: string) => Promise<string> };
      await priv.maybeRunPlan(new AbortController().signal, { path: "h.go", content: "package h\n", lineCount: 1 }, "rule");
      client.assertClean(1);
    }
    // subtest: project summary
    {
      const tpl = makeTemplateWithFullScan();
      (tpl as unknown as { ProjectSummaryTask?: unknown }).ProjectSummaryTask = { messages: [{ role: "user", content: "summarize {{all_comments}}" }] };
      const client = new IdentityProbeClient();
      client.reply = "overall summary";
      const a = newProbeAgent(tpl, client, undefined);
      const priv = a as unknown as { maybeRunProjectSummary: (comments: import("../../../src/ocr-v193/model/review.js").LlmComment[]) => Promise<void> };
      await priv.maybeRunProjectSummary([
        { path: "a.go", content: "missing error check" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
        { path: "b.go", content: "no input validation" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
      ]);
      client.assertClean(1);
    }
    // subtest: dedup
    {
      const tpl = makeTemplateWithFullScan();
      (tpl as unknown as { DedupTask?: unknown }).DedupTask = { messages: [{ role: "user", content: "dedup {{batch_comments}}" }] };
      const collector = new CommentCollector();
      collector.add({ path: "a.go", content: "dup 1" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment);
      collector.add({ path: "a.go", content: "dup 2" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment);
      collector.add({ path: "b.go", content: "unique" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment);
      const client = new IdentityProbeClient();
      client.reply = `{"groups":[{"members":["c-0","c-1"],"merged_content":"combined"},{"members":["c-2"]}]}`;
      const a = newProbeAgent(tpl, client, collector);
      const priv = a as unknown as { maybeRunDedup: (idx: number, start: number) => Promise<void> };
      await priv.maybeRunDedup(0, 0);
      client.assertClean(1);
    }
    // subtest: main task via shared runner
    {
      const client = new IdentityProbeClient();
      client.reply = "no findings";
      const a = newProbeAgent(makeTemplateWithFullScan(), client, undefined);
      const priv = a as unknown as { executeSubtask: (s: AbortSignal, it: ScanItem) => Promise<{ completed: boolean; error: Error | null }> };
      await priv.executeSubtask(new AbortController().signal, { path: "h.go", content: "package h\n", lineCount: 1 });
      expect(client.callCount).toBeGreaterThan(0);
      expect(client.withMeta.length).toBe(0);
    }
  });
});

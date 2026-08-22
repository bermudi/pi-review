// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/retry_identity_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import { Agent } from "../../../src/ocr/agent/agent.js";
import { SessionHistory } from "../../../src/ocr/session/history.js";
import type { Template } from "../../../src/ocr/template/template.js";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";

type CapturedMeta = { provider: string; model: string; filePath: string; taskType: string; requestNo: number };

class MetaCaptureClient {
  metas: CapturedMeta[] = [];
  haveMeta: boolean[] = [];
  constructor(private readonly reply: string) {}
  async CompletionsWithCtx(_signal: unknown, req: unknown): Promise<unknown> {
    const r = req as Record<string, unknown>;
    const meta = r["requestMeta"] as CapturedMeta | undefined;
    const has = meta !== undefined && meta !== null;
    this.metas.push(meta ?? { provider: "", model: "", filePath: "", taskType: "", requestNo: 0 });
    this.haveMeta.push(has);
    return {
      content: this.reply,
      toolCalls: [],
      usage: { PromptTokens: 1, CompletionTokens: 1 },
    };
  }
  async complete(signal: unknown, req: unknown): Promise<unknown> {
    return this.CompletionsWithCtx(signal, req);
  }
  only(): { meta: CapturedMeta; has: boolean } {
    if (this.metas.length !== 1) throw new Error(`got ${this.metas.length} requests, want 1`);
    return { meta: this.metas[0]!, has: this.haveMeta[0]! };
  }
}

describe("ocr agent retry identity (ported from internal/agent/retry_identity_test.go)", () => {
  // OCR v1.9.3: TestExecutePlanPhase_Identity
  test("TestExecutePlanPhase_Identity", async () => {
    for (const provider of ["openai", ""]) {
      const name = provider === "" ? "empty-provider" : provider;
      const sess = new SessionHistory("/tmp", "main", "test", { reviewMode: "diff" });
      const client = new MetaCaptureClient("plan output");
      const agent = new Agent({
        repoDir: "/tmp",
        provider,
        model: "test",
        llmClient: client as unknown as never,
        Session: sess as unknown as never,
        template: {
          MaxTokens: 10000,
          MaxToolRequestTimes: 5,
          MainTask: { messages: [{ role: "user", content: "t" }] },
          MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
          PlanTask: { messages: [{ role: "user", content: "plan {{diff}}" }] },
        } as unknown as Template,
        mainToolDefs: [],
      } as unknown as never);
      (agent as unknown as { currentDate: string }).currentDate = "2026-08-07 10:00";
      await (agent as unknown as { executePlanPhase: (s: AbortSignal, a: string, b: string, c: string, d: string) => Promise<string> }).executePlanPhase(new AbortController().signal, "main.go", "+x", "", "");
      const { meta, has } = client.only();
      expect(has).toBe(true);
      expect(meta.provider).toBe(provider);
      expect(meta.model).toBe("test");
      expect(meta.filePath).toBe("main.go");
      expect(meta.taskType).toBe("plan_task");
      expect(meta.requestNo).toBe(1);
      const recs = sess.GetOrCreateFileSession("main.go").taskRecords.get("plan_task" as unknown as import("../../../src/ocr/session/history.js").TaskType);
      expect(recs?.length).toBe(1);
      expect(meta.requestNo).toBe(recs![0]!.requestNo);
    }
  });

  // OCR v1.9.3: TestExecuteReviewFilter_Identity
  test("TestExecuteReviewFilter_Identity", async () => {
    const sess = new SessionHistory("/tmp", "main", "test", { reviewMode: "diff" });
    const collector = new CommentCollector();
    collector.Add({ path: "a.go", content: "keep this" });
    const client = new MetaCaptureClient("[]");
    const agent = new Agent({
      repoDir: "/tmp",
      provider: "openai",
      model: "test",
      llmClient: client as unknown as never,
      Session: sess as unknown as never,
      commentCollector: collector as unknown as never,
      template: {
        MaxTokens: 10000,
        MaxToolRequestTimes: 5,
        MainTask: { messages: [{ role: "user", content: "t" }] },
        MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
        ReviewFilterTask: { messages: [{ role: "user", content: "filter {{comments}} {{path}} {{diff}}" }] },
      } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    await (agent as unknown as { executeReviewFilter: (s: AbortSignal, d: unknown, p: string) => Promise<void> }).executeReviewFilter(new AbortController().signal, { newPath: "a.go", diff: "+x" } as unknown as never, "a.go");
    const { meta, has } = client.only();
    expect(has).toBe(true);
    expect(meta.provider).toBe("openai");
    expect(meta.model).toBe("test");
    expect(meta.filePath).toBe("a.go");
    expect(meta.taskType).toBe("review_filter_task");
    expect(meta.requestNo).toBe(1);
    const recs = sess.GetOrCreateFileSession("a.go").taskRecords.get("review_filter_task" as unknown as import("../../../src/ocr/session/history.js").TaskType);
    expect(recs?.length).toBe(1);
    expect(meta.requestNo).toBe(recs![0]!.requestNo);
  });

  // OCR v1.9.3: TestNewRequestMeta_IsSingleSourceOfProviderAndModel
  test("TestNewRequestMeta_IsSingleSourceOfProviderAndModel", () => {
    const agent = new Agent({
      repoDir: "/tmp",
      provider: "my-gateway",
      model: "m1",
      llmClient: { complete: async () => ({ content: "" }) } as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
      mainToolDefs: [],
    } as unknown as never);
    const got = (agent as unknown as { newRequestMeta: (f: string, t: import("../../../src/ocr/session/history.js").TaskType, n: number) => CapturedMeta }).newRequestMeta("dir/f.go", "main_task" as unknown as import("../../../src/ocr/session/history.js").TaskType, 3);
    const want: CapturedMeta = { provider: "my-gateway", model: "m1", filePath: "dir/f.go", taskType: "main_task", requestNo: 3 };
    expect(got).toEqual(want);
  });
});

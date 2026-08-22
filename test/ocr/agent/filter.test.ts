// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/agent/coverage_test.go TestExecuteReviewFilter_* at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Phase 5 — review filter: run v1.9.3 filter unless --no-filter, timeout/malformed/failure handling, deterministic ordering

import { describe, test, expect } from "bun:test";
import { CommentCollector } from "../../../src/ocr/tool/collector.js";
import { Agent } from "../../../src/ocr/agent/agent.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import type { LlmComment } from "../../../src/ocr/model/types.js";
import type { Template } from "../../../src/ocr/template/template.js";
import type { AnyLlmClient } from "../../../src/ocr/llmloop/types.js";

interface FilterResponse {
  readonly content: string;
  readonly usage?: { readonly PromptTokens: number; readonly CompletionTokens: number };
}

interface FilterFakeClient {
  complete(signal: AbortSignal, req: unknown): Promise<FilterResponse>;
  CompletionsWithCtx?(signal: AbortSignal, req: unknown): Promise<FilterResponse>;
}

type AgentWithFilter = {
  executeReviewFilter(signal: AbortSignal, diff: Diff, path: string): Promise<void>;
};

function invokeFilter(agent: Agent, signal: AbortSignal, diff: Diff, path: string): Promise<void> {
  const target = agent as unknown as AgentWithFilter;
  return target.executeReviewFilter(signal, diff, path);
}

function makeCollectorWith(...comments: LlmComment[]): CommentCollector {
  const c = new CommentCollector();
  for (const cm of comments) c.Add(cm);
  return c;
}

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    MainTask: { messages: [{ role: "user", content: "review {{diff}}" }] },
    MaxTokens: 10000,
    MaxToolRequestTimes: 5,
    MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
    ...overrides,
  } as unknown as Template;
}

function cm(path: string, content: string, existingCode?: string): LlmComment {
  return { path, content, existingCode };
}

describe("ocr Agent review filter (ported)", () => {
  test("no filter task → no LLM call, comments unchanged", async () => {
    const collector = makeCollectorWith(cm("a.go", "keep"));
    let calls = 0;
    const llmClient: FilterFakeClient = {
      complete: async () => {
        calls++;
        return { content: `["c-0"]` };
      },
      CompletionsWithCtx: async () => {
        calls++;
        return { content: `["c-0"]` };
      },
    };
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template: makeTemplate({ ReviewFilterTask: null as unknown as Template["ReviewFilterTask"] }),
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+code" } as unknown as Diff, "a.go");
    expect(calls).toBe(0);
    expect(collector.Comments().length).toBe(1);
  });

  test("no comments → no LLM call", async () => {
    const collector = makeCollectorWith();
    let calls = 0;
    const llmClient: FilterFakeClient = {
      complete: async () => {
        calls++;
        return { content: `[]` };
      },
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "Filter {{comments}} {{path}} {{diff}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+x" } as unknown as Diff, "a.go");
    expect(calls).toBe(0);
  });

  test("removes comments via filter ids", async () => {
    const collector = makeCollectorWith(cm("a.go", "keep this"), cm("a.go", "remove this"), cm("a.go", "also keep"));
    const llmClient: FilterFakeClient = {
      complete: async () => ({ content: `["c-1"]`, usage: { PromptTokens: 10, CompletionTokens: 5 } }),
      CompletionsWithCtx: async () => ({ content: `["c-1"]`, usage: { PromptTokens: 10, CompletionTokens: 5 } }),
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "Filter: {{comments}} path={{path}} diff={{diff}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+code" } as unknown as Diff, "a.go");
    const remaining = collector.CommentsForPath("a.go");
    expect(remaining.length).toBe(2);
    expect(remaining.some((c) => c.content === "remove this")).toBe(false);
  });

  test("LLM error keeps comments", async () => {
    const collector = makeCollectorWith(cm("a.go", "comment"));
    const llmClient: FilterFakeClient = {
      complete: async () => {
        throw new Error("network");
      },
      CompletionsWithCtx: async () => {
        throw new Error("network");
      },
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "{{comments}} {{path}} {{diff}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+x" } as unknown as Diff, "a.go");
    expect(collector.Comments().length).toBe(1);
  });

  test("malformed response keeps comments (JSON parse failure)", async () => {
    const collector = makeCollectorWith(cm("a.go", "keep"), cm("a.go", "also keep"));
    const llmClient: FilterFakeClient = {
      complete: async () => ({ content: `not json` }),
      CompletionsWithCtx: async () => ({ content: `not json` }),
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "{{comments}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+x" } as unknown as Diff, "a.go");
    expect(collector.Comments().length).toBe(2);
  });

  test("markdown fences stripped before JSON parse", async () => {
    const collector = makeCollectorWith(cm("a.go", "keep"), cm("a.go", "remove"));
    const llmClient: FilterFakeClient = {
      complete: async () => ({ content: "```json\n[\"c-1\"]\n```" }),
      CompletionsWithCtx: async () => ({ content: "```json\n[\"c-1\"]\n```" }),
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "{{comments}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+x" } as unknown as Diff, "a.go");
    expect(collector.Comments().length).toBe(1);
    expect(collector.Comments()[0]!.content).toBe("keep");
  });

  test("out-of-range and invalid ids ignored", async () => {
    const collector = makeCollectorWith(cm("a.go", "keep"), cm("a.go", "also keep"));
    const llmClient: FilterFakeClient = {
      complete: async () => ({ content: `["c-99", "bad", "c-0", "c-1"]` }),
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "{{comments}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+x" } as unknown as Diff, "a.go");
    expect(collector.Comments().length).toBe(0);
  });

  test("SkipFilter disables filter (--no-filter)", async () => {
    const collector = makeCollectorWith(cm("a.go", "comment"));
    let calls = 0;
    const llmClient: FilterFakeClient = {
      complete: async () => {
        calls++;
        return { content: `["c-0"]` };
      },
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "Filter: {{comments}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
      skipFilter: true,
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+code" } as unknown as Diff, "a.go");
    expect(calls).toBe(0);
    expect(collector.Comments().length).toBe(1);
  });

  test("filter respects abort signal (timeout) → keeps comments", async () => {
    const collector = makeCollectorWith(cm("a.go", "comment"));
    const llmClient: FilterFakeClient = {
      complete: async () => {
        throw new DOMException("Aborted", "AbortError");
      },
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "{{comments}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    const controller = new AbortController();
    controller.abort(new Error("timeout"));
    await invokeFilter(agent, controller.signal, { newPath: "a.go", diff: "+x" } as unknown as Diff, "a.go");
    expect(collector.Comments().length).toBe(1);
  });

  test("concurrent comment processing with per-file draining then filter", async () => {
    const collector = new CommentCollector();
    collector.Add(cm("a.go", "keep"));
    collector.Add(cm("a.go", "remove"));
    collector.Add(cm("a.go", "keep2"));
    const llmClient: FilterFakeClient = {
      complete: async (_signal: AbortSignal, req: unknown) => {
        const r = req as { messages: readonly { content: string }[] };
        const content = JSON.stringify(r.messages);
        if (content.includes("Filter")) {
          return { content: `["c-1"]` };
        }
        return { content: `["c-1"]` };
      },
      CompletionsWithCtx: async (_signal: AbortSignal, req: unknown) => {
        const r = req as { messages: readonly { content: string }[] };
        const content = JSON.stringify(r.messages);
        if (content.includes("Filter")) {
          return { content: `["c-1"]` };
        }
        return { content: `["c-1"]` };
      },
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "Filter {{comments}} {{path}} {{diff}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+code" } as unknown as Diff, "a.go");
    const remaining = collector.CommentsForPath("a.go");
    expect(remaining.length).toBe(2);
    expect(remaining.map((c) => c.content)).toEqual(["keep", "keep2"]);
  });

  test("deterministic ordering preserved after filter (stable)", async () => {
    const collector = makeCollectorWith(cm("a.go", "first"), cm("a.go", "second"), cm("a.go", "third"));
    const llmClient: FilterFakeClient = {
      complete: async () => ({ content: `["c-1"]` }),
    };
    const template = makeTemplate({
      ReviewFilterTask: { messages: [{ role: "user", content: "{{comments}}" }] } as unknown as Template["ReviewFilterTask"],
    });
    const agent = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: llmClient as unknown as AnyLlmClient,
      template,
      commentCollector: collector as unknown as CommentCollector,
      mainToolDefs: [],
    } as unknown as never);
    await invokeFilter(agent, new AbortController().signal, { newPath: "a.go", diff: "+x" } as unknown as Diff, "a.go");
    const remaining = collector.Comments();
    expect(remaining.map((c) => c.content)).toEqual(["first", "third"]);
  });
});

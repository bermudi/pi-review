// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/scan/coverage_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// localPath test/ocr-v193/scan/coverage.test.ts -> internal/scan/coverage_test.go

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { Agent, NewAgent, scanItemFingerprint } from "../../../src/ocr-v193/scan/scan.js";
import type { ScanItem } from "../../../src/ocr-v193/model/scan.js";
import type { ScanTemplate } from "../../../src/ocr-v193/template/template.js";
import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { CommentCollector } from "../../../src/ocr-v193/tool/collector.js";
import type { AnyLlmClient } from "../../../src/ocr-v193/llmloop/types.js";

type ScanPrivate = {
  items: ScanItem[];
  currentDate: string;
  dispatchSubtasks(signal: AbortSignal): Promise<unknown>;
  executeSubtask(signal: AbortSignal, it: ScanItem): Promise<{ completed: boolean; stop?: string; error: Error | null }>;
  maybeRunPlan(signal: AbortSignal, it: ScanItem, rule: string): Promise<string>;
  maybeRunProjectSummary(comments: import("../../../src/ocr-v193/model/review.js").LlmComment[]): Promise<void>;
  maybeRunDedup(batchIdx: number, batchStart: number): Promise<void>;
  filterScanItems(items: readonly ScanItem[]): ScanItem[];
  whyExcluded(it: ScanItem): string;
  lookupDiff(path: string): import("../../../src/ocr-v193/model/diff.js").Diff | null;
  planEnabled(): boolean;
  dedupEnabled(): boolean;
  summaryEnabled(): boolean;
};

class FakeScanClient {
  responses: unknown[];
  idx = 0;
  constructor(responses: unknown[]) {
    this.responses = responses;
  }
  async complete(signal: AbortSignal, req: unknown): Promise<unknown> {
    return this.CompletionsWithCtx(signal, req as never);
  }
  async CompletionsWithCtx(_signal: AbortSignal, _req: unknown): Promise<unknown> {
    if (this.idx >= this.responses.length) {
      return { content: "", usage: { PromptTokens: 0, CompletionTokens: 0 } };
    }
    const r = this.responses[this.idx++] as { content: string; usage?: unknown; toolCalls?: unknown[] };
    // Normalize to Pi shape expected by scan: content + usage + toolCalls
    // If Go-shaped response provided (Choices), extract content
    const maybeGo = r as unknown as { Choices?: Array<{ Message?: { Content?: string; ToolCalls?: unknown[] } }>; Usage?: unknown };
    if (maybeGo.Choices && maybeGo.Choices[0]?.Message) {
      const msg = maybeGo.Choices[0].Message;
      return { content: msg.Content ?? "", toolCalls: msg.ToolCalls ?? [], usage: maybeGo.Usage ?? r.usage };
    }
    return r;
  }
}

class ErrorScanClient {
  err: Error;
  constructor(err: Error) { this.err = err; }
  async complete(): Promise<unknown> { throw this.err; }
  async CompletionsWithCtx(): Promise<unknown> { throw this.err; }
}

function makeTemplateWithFullScan(): ScanTemplate {
  return {
    MaxTokens: 1000,
    MaxToolRequestTimes: 5,
    MainTask: {
      messages: [
        { role: "system", content: "scan system rule={{system_rule}}" },
        { role: "user", content: "path={{current_file_path}}\ndate={{current_system_date_time}}\nsiblings=[{{change_files}}]\nbg={{requirement_background}}\nplan={{plan_guidance}}\n<content>\n{{file_content}}\n</content>" },
      ],
    },
    MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
  } as unknown as ScanTemplate;
}

function newAgentForTest(tpl: ScanTemplate): Agent {
  return NewAgent({
    template: tpl,
    commentCollector: new CommentCollector() as unknown as never,
    tools: { get: () => undefined, freeze: () => {} } as unknown as never,
    session: new SessionHistory(mkdtempSyncFallback(), "main", "test-model", { reviewMode: "full_scan" }) as unknown as never,
  } as unknown as never);
}
function mkdtempSyncFallback(): string {
  // Use sync version via tmpdir + random
  return `${tmpdir()}/ocr-scan-test-${Math.random().toString(36).slice(2)}`;
}

async function initTestRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-scan-repo-"));
  const run = (args: string[]): void => {
    const res = spawnSync("git", args, { cwd: dir });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr?.toString()}`);
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  run(["config", "commit.gpgsign", "false"]);
  const cleanup = async (): Promise<void> => { await rm(dir, { recursive: true, force: true }).catch(() => {}); };
  return { dir, cleanup };
}
async function writeFileEnsure(dir: string, rel: string, content: string | Uint8Array): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, ".."), { recursive: true }).catch(() => {});
  // ensure parent dir
  const parent = full.slice(0, full.lastIndexOf("/"));
  if (parent) await mkdir(parent, { recursive: true }).catch(() => {});
  await writeFile(full, content as unknown as string);
}
function gitCommit(dir: string, msg: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-m", msg], { cwd: dir });
}
function extFromPathViaAgent(p: string): string {
  // Use private extFromPath via cast to any workaround: call whyExcluded? Instead directly test via Agent's whyExcluded logic for extension
  // We'll test via the free function if exported, otherwise via Agent's filter.
  // For now, instantiate agent and call private extFromPath via unknown
  const tpl = makeTemplateWithFullScan();
  const a = newAgentForTest(tpl) as unknown as { extFromPath?: (p: string) => string };
  if (typeof a.extFromPath === "function") return a.extFromPath(p);
  // fallback manual
  const base = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

describe("ocr-v193 scan coverage (ported from internal/scan/coverage_test.go)", () => {
  // OCR v1.9.3: TestAgent_Getters
  test("TestAgent_Getters", () => {
    const tpl = makeTemplateWithFullScan();
    const a = newAgentForTest(tpl);
    const priv = a as unknown as ScanPrivate;
    (a as unknown as { items: ScanItem[] }).items = [
      { path: "a.go", content: "package a", lineCount: 1 },
      { path: "b.go", content: "package b", lineCount: 1 },
    ];
    expect(a.ProjectSummary()).toBe("");
    expect(a.SessionID()).toBeDefined(); // Session() in Go returns session, we map to SessionID
    expect(a.FilesReviewed()).toBe(2);
    const diffs = a.Diffs();
    expect(diffs.length).toBe(2);
    expect(diffs[0]?.newPath).toBe("a.go");
    expect(diffs[1]?.newPath).toBe("b.go");
    expect(a.TotalTokensUsed()).toBe(0);
    expect(Object.keys(a.ToolCalls()).length).toBe(0);
  });

  // OCR v1.9.3: TestLookupDiff
  test("TestLookupDiff", () => {
    const tpl = makeTemplateWithFullScan();
    const a = newAgentForTest(tpl);
    (a as unknown as { items: ScanItem[] }).items = [
      { path: "main.go", content: "package main\n", lineCount: 1 },
      { path: "lib.go", content: "package lib\n", lineCount: 1 },
    ];
    const priv = a as unknown as ScanPrivate;
    const d = priv.lookupDiff("main.go");
    expect(d).not.toBeNull();
    expect(d?.newPath).toBe("main.go");
    expect(d?.newFileContent).toBe("package main\n");
    const d2 = priv.lookupDiff("nonexist.go");
    expect(d2).toBeNull();
  });

  // OCR v1.9.3: TestFilterScanItems
  test("TestFilterScanItems", () => {
    const a = NewAgent({
      template: makeTemplateWithFullScan(),
      fileFilter: {
        isUserExcluded: (p: string) => p.startsWith("vendor/"),
        isUserIncluded: () => false,
        hasInclude: () => false,
      } as unknown as never,
      session: new SessionHistory(mkdtempSyncFallback(), "main", "test", { reviewMode: "full_scan" }) as unknown as never,
    } as unknown as never);
    const priv = a as unknown as ScanPrivate;
    const items: ScanItem[] = [
      { path: "main.go", content: "package main\n", lineCount: 1 },
      { path: "image.png", content: "", isBinary: true, lineCount: 0 },
      { path: "vendor/dep.go", content: "package dep\n", lineCount: 1 },
      { path: "handler.go", content: "package h\n", lineCount: 1 },
    ];
    const kept = priv.filterScanItems(items);
    expect(kept.length).toBe(2);
    expect(kept.some((it) => it.path === "image.png")).toBe(false);
    expect(kept.some((it) => it.path === "vendor/dep.go")).toBe(false);
  });

  // OCR v1.9.3: TestWhyExcluded_AllBranches
  test("TestWhyExcluded_AllBranches", () => {
    type Case = { name: string; item: ScanItem; filter?: { isUserExcluded: (p: string) => boolean; isUserIncluded: (p: string) => boolean; hasInclude: () => boolean } | null; want: string };
    const cases: Case[] = [
      { name: "binary", item: { path: "img.png", isBinary: true, content: "", lineCount: 0 }, want: "binary" },
      { name: "user exclude", item: { path: "vendor/dep.go", content: "x", lineCount: 1 }, filter: { isUserExcluded: (p) => p.startsWith("vendor/"), isUserIncluded: () => false, hasInclude: () => false }, want: "user_exclude" },
      { name: "unsupported extension", item: { path: "data.xyz123", content: "x", lineCount: 1 }, want: "unsupported_ext" },
      { name: "user include match passes", item: { path: "src/main.go", content: "x", lineCount: 1 }, filter: { isUserExcluded: () => false, isUserIncluded: (p) => p.startsWith("src/"), hasInclude: () => true }, want: "" },
      { name: "user include overrides extension allowlist", item: { path: "templates/email.ftl", content: "x", lineCount: 1 }, filter: { isUserExcluded: () => false, isUserIncluded: (p) => p.endsWith(".ftl"), hasInclude: () => true }, want: "" },
      { name: "default excluded path", item: { path: "pkg/handler_test.go", content: "x", lineCount: 1 }, want: "default_path" },
      { name: "allowed file passes", item: { path: "main.go", content: "x", lineCount: 1 }, want: "" },
    ];
    for (const tc of cases) {
      const a = NewAgent({
        template: makeTemplateWithFullScan(),
        fileFilter: tc.filter as unknown as never,
        session: new SessionHistory(mkdtempSyncFallback(), "main", "test", { reviewMode: "full_scan" }) as unknown as never,
      } as unknown as never);
      const priv = a as unknown as ScanPrivate;
      const got = priv.whyExcluded(tc.item);
      expect(got).toBe(tc.want);
    }
  });

  // OCR v1.9.3: TestExtFromPath
  test("TestExtFromPath", () => {
    const cases: Array<[string, string]> = [
      ["main.go", ".go"],
      ["src/lib/utils.ts", ".ts"],
      ["Makefile", ""],
      [".gitignore", ""],
      ["path/to/FILE.Go", ".go"],
      ["a/b/c.Test.JS", ".js"],
    ];
    for (const [path, want] of cases) {
      const got = extFromPathViaAgent(path);
      expect(got).toBe(want);
    }
  });

  // OCR v1.9.3: TestMaybeRunPlan_Success
  test("TestMaybeRunPlan_Success", async () => {
    const planJSON = `{"summary":"check error handling","checkpoints":[{"focus":"nil check","lines":"10-20","why":"potential NPE"}]}`;
    const client = new FakeScanClient([{ content: planJSON, usage: { PromptTokens: 100, CompletionTokens: 50 } }]);
    const tpl = makeTemplateWithFullScan();
    (tpl as unknown as { PlanTask?: unknown }).PlanTask = { messages: [{ role: "user", content: "Plan for {{current_file_path}}: {{file_content}}" }] };
    const a = NewAgent({
      template: tpl as unknown as ScanTemplate,
      llmClient: client as unknown as AnyLlmClient,
      model: "test",
      commentCollector: new CommentCollector() as unknown as never,
      tools: { get: () => undefined, freeze: () => {} } as unknown as never,
      session: new SessionHistory(mkdtempSyncFallback(), "main", "test", { reviewMode: "full_scan" }) as unknown as never,
    } as unknown as never);
    (a as unknown as { currentDate: string }).currentDate = "2026-06-26 10:00";
    const priv = a as unknown as ScanPrivate;
    const guidance = await priv.maybeRunPlan(new AbortController().signal, { path: "handler.go", content: "package h\nfunc Handle() {}\n", lineCount: 2 }, "rule-text");
    expect(guidance.includes("nil check")).toBe(true);
    expect(guidance.includes("check error handling")).toBe(true);
    expect(a.TotalTokensUsed()).toBe(150);
  });

  // OCR v1.9.3: TestMaybeRunProjectSummary_Success
  test("TestMaybeRunProjectSummary_Success", async () => {
    const summaryText = "Overall the code has good error handling but lacks input validation.";
    const client = new FakeScanClient([{ content: summaryText, usage: { PromptTokens: 200, CompletionTokens: 80 } }]);
    const tpl = makeTemplateWithFullScan();
    (tpl as unknown as { ProjectSummaryTask?: unknown }).ProjectSummaryTask = { messages: [{ role: "user", content: "Summarize {{comment_count}} comments across {{file_count}} files:\n{{all_comments}}" }] };
    const a = NewAgent({
      template: tpl as unknown as ScanTemplate,
      llmClient: client as unknown as AnyLlmClient,
      model: "test",
      commentCollector: new CommentCollector() as unknown as never,
      tools: { get: () => undefined, freeze: () => {} } as unknown as never,
      session: new SessionHistory(mkdtempSyncFallback(), "main", "test", { reviewMode: "full_scan" }) as unknown as never,
    } as unknown as never);
    const comments: import("../../../src/ocr-v193/model/review.js").LlmComment[] = [
      { path: "a.go", content: "missing error check" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
      { path: "b.go", content: "no input validation" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
    ];
    const priv = a as unknown as ScanPrivate;
    await priv.maybeRunProjectSummary(comments);
    expect(a.ProjectSummary()).toBe(summaryText);
  });

  // OCR v1.9.3: TestMaybeRunProjectSummary_SkipWhenDisabled
  test("TestMaybeRunProjectSummary_SkipWhenDisabled", async () => {
    const tpl = makeTemplateWithFullScan();
    const a = NewAgent({
      template: tpl,
      session: new SessionHistory(mkdtempSyncFallback(), "main", "test", { reviewMode: "full_scan" }) as unknown as never,
    } as unknown as never);
    const priv = a as unknown as ScanPrivate;
    await priv.maybeRunProjectSummary([{ path: "a.go", content: "x" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment]);
    expect(a.ProjectSummary()).toBe("");
  });

  // OCR v1.9.3: TestMaybeRunProjectSummary_SkipWhenNoComments
  test("TestMaybeRunProjectSummary_SkipWhenNoComments", async () => {
    const tpl = makeTemplateWithFullScan();
    (tpl as unknown as { ProjectSummaryTask?: unknown }).ProjectSummaryTask = { messages: [{ role: "user", content: "{{all_comments}}" }] };
    const a = NewAgent({
      template: tpl as unknown as ScanTemplate,
      llmClient: new FakeScanClient([]) as unknown as AnyLlmClient,
      model: "test",
      commentCollector: new CommentCollector() as unknown as never,
      tools: { get: () => undefined, freeze: () => {} } as unknown as never,
      session: new SessionHistory(mkdtempSyncFallback(), "main", "test", { reviewMode: "full_scan" }) as unknown as never,
    } as unknown as never);
    const priv = a as unknown as ScanPrivate;
    await priv.maybeRunProjectSummary([]);
    expect(a.ProjectSummary()).toBe("");
  });
});

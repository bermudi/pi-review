// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/preview_run_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Agent } from "../../../src/ocr/agent/agent.js";

function initPreviewRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preview-"));
  const run = (...args: string[]): void => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  run("init");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "# r\n");
  run("add", ".");
  run("commit", "-m", "init");
  return dir;
}

describe("ocr agent preview run (ported from internal/agent/preview_run_test.go)", () => {
  // OCR v1.9.3: TestPreview
  test("TestPreview", async () => {
    const dir = initPreviewRepo();
    fs.writeFileSync(path.join(dir, "main.go"), "package main\n");
    fs.writeFileSync(path.join(dir, "data.bin"), Buffer.from([0x00, 0x01, 0x02]));
    const fakeClient = { complete: async () => ({ content: "" }), CompletionsWithCtx: async () => ({ content: "" }) } as unknown as never;
    const agent = new Agent({
      repoDir: dir,
      model: "test",
      llmClient: fakeClient,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
      mainToolDefs: [],
    } as unknown as never);
    const preview = await (agent as unknown as { preview: (sig?: AbortSignal) => Promise<{ TotalFiles: number; ReviewableCount: number; Entries: unknown[]; totalFiles: number; reviewableCount: number }> }).preview();
    // Support both camelCase and PascalCase preview shape
    const totalFiles = (preview as unknown as { TotalFiles?: number; totalFiles?: number }).TotalFiles ?? (preview as unknown as { totalFiles: number }).totalFiles;
    const reviewableCount = (preview as unknown as { ReviewableCount?: number; reviewableCount?: number }).ReviewableCount ?? (preview as unknown as { reviewableCount: number }).reviewableCount;
    const entries = (preview as unknown as { Entries?: unknown[]; entries?: unknown[] }).Entries ?? (preview as unknown as { entries: unknown[] }).entries;
    expect(totalFiles).toBeGreaterThan(0);
    expect(reviewableCount).toBeGreaterThan(0);
    expect((entries as unknown[]).length).toBe(totalFiles as number);
  });

  // OCR v1.9.3: TestPreviewEmptyEntriesNotNil
  test("TestPreviewEmptyEntriesNotNil", async () => {
    const dir = initPreviewRepo();
    const fakeClient = { complete: async () => ({ content: "" }), CompletionsWithCtx: async () => ({ content: "" }) } as unknown as never;
    const agent = new Agent({
      repoDir: dir,
      model: "test",
      llmClient: fakeClient,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
      mainToolDefs: [],
    } as unknown as never);
    const preview = await (agent as unknown as { preview: (sig?: AbortSignal) => Promise<{ TotalFiles: number; Entries: unknown[] | null; totalFiles: number; entries: unknown[] | null }> }).preview();
    const totalFiles = (preview as unknown as { TotalFiles?: number; totalFiles?: number }).TotalFiles ?? (preview as unknown as { totalFiles: number }).totalFiles;
    const entries = (preview as unknown as { Entries?: unknown[] | null; entries?: unknown[] | null }).Entries ?? (preview as unknown as { entries: unknown[] | null }).entries;
    expect(totalFiles).toBe(0);
    expect(entries).not.toBeNull();
    expect(entries).not.toBeUndefined();
    expect(Array.isArray(entries as unknown[])).toBe(true);
  });
});

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/sealed_input_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveIdentity } from "../../../src/ocr/agent/identity.js";
import { Agent } from "../../../src/ocr/agent/agent.js";

function gitIn(dir: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function initPreviewRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sealed-"));
  gitIn(dir, "init");
  gitIn(dir, "config", "user.email", "t@t");
  gitIn(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "# r\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

function sealRepo(): string {
  const dir = initPreviewRepo();
  gitIn(dir, "branch", "-M", "main");
  gitIn(dir, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(dir, "main.go"), "package main\n\nfunc main() {}\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-m", "add main");
  return dir;
}

function commitIn(dir: string, name: string, content: string, msg: string): void {
  fs.writeFileSync(path.join(dir, name), content);
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-m", msg);
}

async function runPathIdentity(args: Record<string, unknown>): Promise<import("../../../src/ocr/agent/identity.js").RunIdentity> {
  const dummyClient = { complete: async () => ({ content: "" }), CompletionsWithCtx: async () => ({ content: "" }) } as unknown as never;
  const agent = new Agent({
    repoDir: args["repoDir"] as string,
    from: args["from"] as string | undefined,
    to: args["to"] as string | undefined,
    commit: args["commit"] as string | undefined,
    sealedInput: args["sealedInput"] as unknown as never,
    template: { MaxTokens: 4000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
    model: "test",
    llmClient: dummyClient,
    mainToolDefs: [],
  } as unknown as never);
  await (agent as unknown as { loadDiffs: (s?: AbortSignal) => Promise<void> }).loadDiffs();
  const anyAgent = agent as unknown as { filterDiffs: (d: unknown[]) => unknown[]; filterLargeDiffs: (d: unknown[]) => unknown[]; diffs: unknown[]; runIdentity: () => import("../../../src/ocr/agent/identity.js").RunIdentity };
  anyAgent.diffs = anyAgent.filterDiffs(anyAgent.diffs);
  anyAgent.diffs = anyAgent.filterLargeDiffs(anyAgent.diffs);
  return anyAgent.runIdentity();
}

describe("ocr agent sealed input (ported from internal/agent/sealed_input_test.go)", () => {
  // OCR v1.9.3: TestSealedInputPinsRunToAdmittedCommits
  test("TestSealedInputPinsRunToAdmittedCommits", async () => {
    const dir = sealRepo();
    const args: Record<string, unknown> = {
      repoDir: dir,
      from: "main",
      to: "feature",
      template: { MaxTokens: 4000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } },
    };
    const sealed = await resolveIdentity(args as unknown as never);
    expect(sealed.resolution.resolvedBase).not.toBe("");
    expect(sealed.resolution.resolvedHead).not.toBe("");

    // Move the ref
    commitIn(dir, "late.go", "package main\n\nfunc late() {}\n", "move the ref");

    // sealed run still reviews admitted input
    {
      const pinned: Record<string, unknown> = { ...args, sealedInput: sealed.resolution };
      const got = await runPathIdentity(pinned);
      expect(got).toEqual(sealed.identity);
    }

    // without seal the same move changes the input
    {
      const got = await runPathIdentity(args);
      expect(got).not.toEqual(sealed.identity);
    }
  });
});

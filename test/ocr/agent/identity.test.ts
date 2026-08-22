// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/identity_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveIdentity } from "../../../src/ocr/agent/identity.js";
import { Agent, hashFields } from "../../../src/ocr/agent/agent.js";
import { createHash } from "node:crypto";

function gitIn(dir: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function initPreviewRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-identity-"));
  gitIn(dir, "init");
  gitIn(dir, "config", "user.email", "t@t");
  gitIn(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "# r\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

function initIdentityRepo(): string {
  const dir = initPreviewRepo();
  const files: Record<string, string> = {
    "main.go": "package main\n\nfunc main() {}\n",
    "keep.go": "package main\n\nfunc keep() {}\n",
    "notes.xyz": "not a reviewable extension\n",
    "huge.go": "package main\n\n// " + "filler ".repeat(4000) + "\n",
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
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

describe("ocr agent identity (ported from internal/agent/identity_test.go)", () => {
  // OCR v1.9.3: TestResolveIdentityMatchesRunPath
  test("TestResolveIdentityMatchesRunPath", async () => {
    const dir = initIdentityRepo();
    const maxTokens = 4000;
    // Replay run path via Agent
    const { Agent: AgentClass } = await import("../../../src/ocr/agent/agent.js");
    const dummyClient = { complete: async () => ({ content: "" }), CompletionsWithCtx: async () => ({ content: "" }) } as unknown as never;
    const run = new AgentClass({
      repoDir: dir,
      template: { MaxTokens: maxTokens, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
      model: "test",
      llmClient: dummyClient,
      mainToolDefs: [],
    } as unknown as never);
    await (run as unknown as { loadDiffs: (s?: AbortSignal) => Promise<void> }).loadDiffs();
    const rawDigest = (run as unknown as { sourceArtifactSHA256: () => string }).sourceArtifactSHA256();
    const rawCount = (run as unknown as { diffs: unknown[] }).diffs.length;

    (run as unknown as { diffs: unknown[] }).diffs = (run as unknown as { filterDiffs: (d: unknown[]) => unknown[] }).filterDiffs((run as unknown as { diffs: unknown[] }).diffs);
    const afterExtDigest = (run as unknown as { sourceArtifactSHA256: () => string }).sourceArtifactSHA256();
    const afterExtCount = (run as unknown as { diffs: unknown[] }).diffs.length;

    (run as unknown as { diffs: unknown[] }).diffs = (run as unknown as { filterLargeDiffs: (d: unknown[]) => unknown[] }).filterLargeDiffs((run as unknown as { diffs: unknown[] }).diffs);
    const want = (run as unknown as { sourceArtifactSHA256: () => string }).sourceArtifactSHA256();

    expect(afterExtCount).toBeLessThan(rawCount);
    expect((run as unknown as { diffs: unknown[] }).diffs.length).toBeLessThan(afterExtCount);
    expect(rawDigest).not.toBe(afterExtDigest);
    expect(afterExtDigest).not.toBe(want);

    const sealed = await resolveIdentity({ repoDir: dir, template: { MaxTokens: maxTokens } } as unknown as never);
    const got = sealed.identity;
    expect(got.sourceArtifactSHA256).toBe(want);
    expect(got.mode).not.toBe("");
    expect(got.sourceArtifactSHA256.length).toBe(64);
    expect(got.ruleConfigSHA256.length).toBe(64);
  });

  // OCR v1.9.3: TestResolveIdentityTracksConfigChanges
  test("TestResolveIdentityTracksConfigChanges", async () => {
    const dir = initIdentityRepo();
    const baseSealed = await resolveIdentity({ repoDir: dir, template: { MaxTokens: 4000 } } as unknown as never);
    const base = baseSealed.identity;

    // deterministic
    {
      const again = await resolveIdentity({ repoDir: dir, template: { MaxTokens: 4000 } } as unknown as never);
      expect(again.identity).toEqual(base);
    }

    // an exclude that drops a file moves both digests
    {
      const sealed = await resolveIdentity({ repoDir: dir, template: { MaxTokens: 4000 }, fileFilter: { Exclude: ["keep.go"], exclude: ["keep.go"] } } as unknown as never);
      const got = sealed.identity;
      expect(got.ruleConfigSHA256).not.toBe(base.ruleConfigSHA256);
      expect(got.sourceArtifactSHA256).not.toBe(base.sourceArtifactSHA256);
    }

    // an exclude that matches nothing moves only the rule digest
    {
      const sealed = await resolveIdentity({ repoDir: dir, template: { MaxTokens: 4000 }, fileFilter: { Exclude: ["no/such/path/**"], exclude: ["no/such/path/**"] } } as unknown as never);
      const got = sealed.identity;
      expect(got.sourceArtifactSHA256).toBe(base.sourceArtifactSHA256);
      expect(got.ruleConfigSHA256).not.toBe(base.ruleConfigSHA256);
    }

    // max tokens moves the input identity
    {
      const sealed = await resolveIdentity({ repoDir: dir, template: { MaxTokens: 4_000_000 } } as unknown as never);
      const got = sealed.identity;
      expect(got.sourceArtifactSHA256).not.toBe(base.sourceArtifactSHA256);
      expect(got.ruleConfigSHA256).toBe(base.ruleConfigSHA256);
    }
  });

  // OCR v1.9.3: TestResolveInputBeforeDiffCommit
  test("TestResolveInputBeforeDiffCommit", async () => {
    const dir = sealRepo();
    gitIn(dir, "remote", "add", "origin", "https://example.com/org/repo.git");
    const sealed = await resolveIdentity({ repoDir: dir, commit: "HEAD" } as unknown as never);
    expect(sealed.resolution.resolvedHead).not.toBe("");
    expect(sealed.identity.repositorySHA256).not.toBe("");
  });

  // OCR v1.9.3: TestResolveInputBeforeDiffRejectsInvalidRefs
  test("TestResolveInputBeforeDiffRejectsInvalidRefs", async () => {
    const dir = sealRepo();
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "commit", args: { repoDir: dir, commit: "missing" } },
      { name: "range from", args: { repoDir: dir, from: "missing", to: "feature" } },
      { name: "range to", args: { repoDir: dir, from: "main", to: "missing" } },
    ];
    for (const tc of cases) {
      let didThrow = false;
      try {
        await resolveIdentity(tc.args as unknown as never);
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(true);
    }
  });
});

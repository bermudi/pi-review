// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/manifest_hash_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { Agent, hashFields, reviewItemFingerprint, manifestItemID } from "../../../src/ocr/agent/agent.js";
import type { Diff } from "../../../src/ocr/model/diff.js";
import { createDiff } from "../../../src/ocr/model/diff.js";

function emptySHA256(): string {
  return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
}

function makeSystemRule(defaultRule: string, pathRules: Array<{ pattern: string; rule: string }>): unknown {
  const fieldsFor = (): string[] => {
    const fields: string[] = ["layer", "system", "default", defaultRule];
    for (const pr of pathRules) fields.push("layer", "system", "pattern", pr.pattern, "rule", pr.rule);
    return fields;
  };
  return {
    resolve: (p: string) => defaultRule,
    canonicalConfig: fieldsFor,
    CanonicalConfig: fieldsFor,
  };
}

describe("ocr agent manifest hash (ported from internal/agent/manifest_hash_test.go)", () => {
  // OCR v1.9.3: TestHashFields_EmptyIsCanonical
  test("TestHashFields_EmptyIsCanonical", () => {
    expect(hashFields()).toBe(emptySHA256());
  });

  // OCR v1.9.3: TestHashFields_LengthPrefixPreventsCollision
  test("TestHashFields_LengthPrefixPreventsCollision", () => {
    expect(hashFields("ab", "")).not.toBe(hashFields("a", "b"));
  });

  // OCR v1.9.3: TestRuleConfigSHA256
  test("TestRuleConfigSHA256", () => {
    const baseRule = [
      { pattern: "*.go", rule: "go rule" },
    ];
    const base = makeSystemRule("default", baseRule);
    const a = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: { complete: async () => ({ content: "" }) } as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
      mainToolDefs: [],
      systemRule: base as unknown as never,
    } as unknown as never);

    const h1 = (a as unknown as { ruleConfigSHA256: () => string }).ruleConfigSHA256();
    expect(h1).toBe((a as unknown as { ruleConfigSHA256: () => string }).ruleConfigSHA256());

    // Changed default rule
    const changed = makeSystemRule("different", baseRule);
    const a2 = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: { complete: async () => ({ content: "" }) } as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
      mainToolDefs: [],
      systemRule: changed as unknown as never,
    } as unknown as never);
    expect((a2 as unknown as { ruleConfigSHA256: () => string }).ruleConfigSHA256()).not.toBe(h1);

    // Reordering
    const ordered = makeSystemRule("default", [{ pattern: "*.go", rule: "go rule" }, { pattern: "*.py", rule: "py rule" }]);
    const swapped = makeSystemRule("default", [{ pattern: "*.py", rule: "py rule" }, { pattern: "*.go", rule: "go rule" }]);
    const ao = new Agent({ repoDir: "/tmp", model: "test", llmClient: { complete: async () => ({ content: "" }) } as unknown as never, template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never, mainToolDefs: [], systemRule: ordered as unknown as never } as unknown as never);
    const asw = new Agent({ repoDir: "/tmp", model: "test", llmClient: { complete: async () => ({ content: "" }) } as unknown as never, template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never, mainToolDefs: [], systemRule: swapped as unknown as never } as unknown as never);
    expect((ao as unknown as { ruleConfigSHA256: () => string }).ruleConfigSHA256()).not.toBe((asw as unknown as { ruleConfigSHA256: () => string }).ruleConfigSHA256());

    // With filter
    const withFilter = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: { complete: async () => ({ content: "" }) } as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
      mainToolDefs: [],
      systemRule: base as unknown as never,
      fileFilter: { Include: ["*.go"], Exclude: ["vendor/**"], include: ["*.go"], exclude: ["vendor/**"] } as unknown as never,
    } as unknown as never);
    expect((withFilter as unknown as { ruleConfigSHA256: () => string }).ruleConfigSHA256()).not.toBe(h1);
  });

  // OCR v1.9.3: TestRuleConfigSHA256_NilResolverAndFilter
  test("TestRuleConfigSHA256_NilResolverAndFilter", () => {
    const a = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: { complete: async () => ({ content: "" }) } as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
      mainToolDefs: [],
      systemRule: null as unknown as never,
      fileFilter: null as unknown as never,
    } as unknown as never);
    expect((a as unknown as { ruleConfigSHA256: () => string }).ruleConfigSHA256()).toBe(emptySHA256());
  });

  // OCR v1.9.3: TestSourceArtifactSHA256_DedupsByItemID
  test("TestSourceArtifactSHA256_DedupsByItemID", () => {
    const d1 = createDiff({ oldPath: "a.go", newPath: "a.go", diff: "@@ first content @@" });
    const d2 = createDiff({ oldPath: "a.go", newPath: "a.go", diff: "@@ second content @@" });

    const dup = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: { complete: async () => ({ content: "" }) } as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
      mainToolDefs: [],
    } as unknown as never);
    (dup as unknown as { diffs: Diff[] }).diffs = [d1, d2];

    const single = new Agent({
      repoDir: "/tmp",
      model: "test",
      llmClient: { complete: async () => ({ content: "" }) } as unknown as never,
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as never,
      mainToolDefs: [],
    } as unknown as never);
    (single as unknown as { diffs: Diff[] }).diffs = [d1];

    const got = (dup as unknown as { sourceArtifactSHA256: () => string }).sourceArtifactSHA256();
    expect(got).toBe((dup as unknown as { sourceArtifactSHA256: () => string }).sourceArtifactSHA256());
    expect(got).toBe((single as unknown as { sourceArtifactSHA256: () => string }).sourceArtifactSHA256());
    expect(got).not.toBe(emptySHA256());
  });

  // OCR v1.9.3: TestRuntimeConfigSHA256
  test("TestRuntimeConfigSHA256", () => {
    const baseArgs: Record<string, unknown> = {
      repoDir: "/tmp",
      model: "m",
      maxConcurrency: 4,
      runtimeConfig: { protocol: "anthropic", endpointHost: "api.example.com", language: "en", timeoutMs: 30 * 1000 },
      template: { MaxTokens: 10000, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } },
      mainToolDefs: [],
      llmClient: { complete: async () => ({ content: "" }) } as unknown,
    };
    const a = new Agent(baseArgs as unknown as never);
    expect((a as unknown as { runtimeConfigSHA256: () => string }).runtimeConfigSHA256()).toBe((a as unknown as { runtimeConfigSHA256: () => string }).runtimeConfigSHA256());

    const cases: Array<{ name: string; mutate: (x: Record<string, unknown>) => void }> = [
      { name: "protocol", mutate: (x) => { (x["runtimeConfig"] as Record<string, unknown>)["protocol"] = "openai"; } },
      { name: "model", mutate: (x) => { x["model"] = "other"; } },
      { name: "host", mutate: (x) => { (x["runtimeConfig"] as Record<string, unknown>)["endpointHost"] = "api.other.com"; } },
      { name: "language", mutate: (x) => { (x["runtimeConfig"] as Record<string, unknown>)["language"] = "zh"; } },
      { name: "timeout", mutate: (x) => { (x["runtimeConfig"] as Record<string, unknown>)["timeoutMs"] = 60 * 1000; } },
      { name: "concurrency", mutate: (x) => { x["maxConcurrency"] = 8; } },
      { name: "max_tokens_budget", mutate: (x) => { x["maxTokensBudget"] = 100000; } },
    ];
    for (const tc of cases) {
      const mutated: Record<string, unknown> = JSON.parse(JSON.stringify(baseArgs)) as Record<string, unknown>;
      // Need to preserve non-JSON fields like template? JSON copy loses functions but okay for this test: recreate runtimeConfig etc.
      // Instead copy shallow and mutate
      const shallow = { ...baseArgs, runtimeConfig: { ...(baseArgs["runtimeConfig"] as Record<string, unknown>) } } as Record<string, unknown>;
      tc.mutate(shallow);
      const b = new Agent(shallow as unknown as never);
      expect((b as unknown as { runtimeConfigSHA256: () => string }).runtimeConfigSHA256()).not.toBe((a as unknown as { runtimeConfigSHA256: () => string }).runtimeConfigSHA256());
    }
  });
});

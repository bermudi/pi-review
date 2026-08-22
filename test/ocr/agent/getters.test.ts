// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ported from internal/agent/getters_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import { Agent } from "../../../src/ocr/agent/agent.js";

function makeAgent(): Agent {
  const fakeClient = { complete: async () => ({ content: "" }), CompletionsWithCtx: async () => ({ content: "" }) } as unknown as never;
  return new Agent({
    repoDir: "/tmp",
    model: "test",
    llmClient: fakeClient,
    template: { MaxTokens: 100, MaxToolRequestTimes: 5, MainTask: { messages: [{ role: "user", content: "t" }] }, MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] } } as unknown as Template,
    mainToolDefs: [],
  } as unknown as never);
}

type Template = import("../../../src/ocr/template/template.js").Template;

describe("ocr agent getters nil-safe (ported from internal/agent/getters_test.go)", () => {
  // Go nil-receiver is not applicable in TypeScript (upstream TestAgentGettersNilSafe is marked not_applicable in inventory).
  test("TestAgentGettersNilSafe", () => {
    const a = makeAgent();
    expect(a.sessionId()).toBe("");
    expect(a.RunManifest()).toBeNull();
    expect(a.ResumeInfo()).toBeNull();
    const empty = Object.create(Agent.prototype) as unknown as Agent;
    // Object.create without construction still has safe defaults for RunManifest via prototype
    expect(empty.RunManifest()).toBeNull();
  });
});

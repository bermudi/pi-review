// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from docs/ocr-port-plan.md Phase 2 vertical slice at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { describe, test, expect } from "bun:test";
import { verifyPinnedRef } from "./harness/pinned.js";
import { runWorkspaceFixture } from "./harness/fixtures/workspace-code-comment-task-done.js";
import { compareRuns } from "./harness/comparer.js";
import { startFakeServer } from "./harness/fake-server.js";

describe("ocr harness", () => {
  test("pinned reference is present", () => {
    expect(() => verifyPinnedRef()).not.toThrow();
  });

  test("fake server round-trips scripted turns deterministically", async () => {
    const { url, requests, stop } = startFakeServer({
      turns: [
        { toolCalls: [{ id: "c1", name: "code_comment", arguments: "{}" }] },
        { content: "done" },
      ],
    });
    expect(url).toMatch(/^http:\/\/localhost:\d+\/v1$/);
    // Hit it once via fetch
    const resp = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }], stream: false }),
    });
    expect(resp.status).toBe(200);
    const body: any = await resp.json();
    expect(body.choices[0].message.tool_calls?.[0]?.function?.name).toBe("code_comment");
    expect(requests).toHaveLength(1);
    stop();
  });

  test("workspace vertical slice: code_comment + task_done", async () => {
    const { harnessResult, cleanup } = await runWorkspaceFixture();
    try {
      expect(harnessResult.fixtureId).toBe("workspace-code_comment-task_done");
      expect(harnessResult.coverage.selected).toContain("main.go");
      expect(harnessResult.commentsAfter).toHaveLength(1);
      expect(harnessResult.commentsAfter[0]?.path).toBe("main.go");
      expect(harnessResult.commentsAfter[0]?.content).toContain("nil case");
      expect(harnessResult.stopReason).toBe("complete");
      expect(harnessResult.toolDefsPerPhase.main).toContain("code_comment");
      expect(harnessResult.toolDefsPerPhase.main).toContain("task_done");
      expect(harnessResult.toolDefsPerPhase.grace).toEqual(["code_comment", "task_done"]);
      expect(harnessResult.modelRequests.length).toBeGreaterThanOrEqual(1);
      expect(harnessResult.usage.totalTokens).toBeGreaterThan(0);
      expect(harnessResult.output.json).toContain("nil case");
    } finally {
      await cleanup();
    }
  }, 15000);

  test("comparer detects mismatched selected files", async () => {
    const { harnessResult: a, cleanup: ca } = await runWorkspaceFixture();
    const { harnessResult: b, cleanup: cb } = await runWorkspaceFixture();
    try {
      const mutated = { ...b, coverage: { ...b.coverage, selected: ["other.go"] } };
      const { equal, mismatches } = compareRuns(a, mutated);
      expect(equal).toBe(false);
      expect(mismatches.some((m) => m.field === "coverage.selected")).toBe(true);
      // self-compare passes
      const self = compareRuns(a, a);
      expect(self.equal).toBe(true);
    } finally {
      await ca();
      await cb();
    }
  }, 15000);
});

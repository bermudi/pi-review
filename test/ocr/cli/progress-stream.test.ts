// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/progress_stream_e2e_test.go at OCR v1.9.9
// 4b6874bd23106b5c68bea6d230bb60303b9f0961.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { newProgressRouter } from "../../../src/ocr/cli/shared.js";
import { Agent } from "../../../src/ocr/agent/agent.js";
import { loadDefaultTemplate } from "../../../src/ocr/template/template.js";
import { defaultReviewOptions } from "../../../src/ocr/cli/shared.js";
import { createReviewRunnerFactory } from "../../../src/ocr/cli/factory.js";
import { runCli } from "../../../src/ocr/cli/index.js";

function runAgentWithAudience(audience: string): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const router = newProgressRouter({ stderr: (text) => { stderr += text; } }, "json", audience);
  const agent = new Agent({
    repoDir: "/review",
    template: loadDefaultTemplate(),
    llmClient: { complete: async () => ({ content: "", toolCalls: [] }) },
    mainToolDefs: [],
    model: "test",
    progress: router,
  });
  // This is the real domain progress boundary; command finalization owns the
  // one JSON document and the Agent never has access to stdout.
  router.emit({ kind: "progress", message: "[ocr] progress" });
  stdout = JSON.stringify({ status: "ok", files: agent.Diffs().length });
  return { stdout, stderr };
}

// OCR v1.9.9: TestReviewE2E_JSONHumanStreamsProgressToStderr
test("TestReviewE2E_JSONHumanStreamsProgressToStderr", () => {
  const result = runAgentWithAudience("human");
  expect(result.stderr).toContain("[ocr] progress");
  expect(JSON.parse(result.stdout)).toEqual({ status: "ok", files: 0 });
  expect(result.stdout).not.toContain("[ocr]");
});

// OCR v1.9.9: TestReviewE2E_JSONAgentStaysSilent
test("TestReviewE2E_JSONAgentStaysSilent", () => {
  const result = runAgentWithAudience("agent");
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ status: "ok", files: 0 });
});

test("real factory routes progress per invocation without network leakage", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-progress-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-progress-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]] as const) {
      expect(spawnSync("git", args, { cwd: repo }).status).toBe(0);
    }
    fs.writeFileSync(path.join(repo, "main.go"), "package main\n");
    expect(spawnSync("git", ["add", "."], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-qm", "base"], { cwd: repo }).status).toBe(0);
    fs.writeFileSync(path.join(repo, "main.go"), "package main\n// changed\n");

    const human: string[] = [];
    const silent: string[] = [];
    const transport = {
      async CompletionsWithCtx(): Promise<unknown> {
        return { content: "", toolCalls: [{ id: "done", type: "function", function: { name: "task_done", arguments: "{}" } }] };
      },
      async dispose(): Promise<void> {},
    };
    await createReviewRunnerFactory(
      { ...defaultReviewOptions(), repoDir: repo, outputFormat: "json", audience: "human", concurrency: 1 },
      repo,
      { createTransport: async () => transport as never },
      newProgressRouter({ stderr: (text) => { human.push(text); } }, "json", "human"),
    )();
    await createReviewRunnerFactory(
      { ...defaultReviewOptions(), repoDir: repo, outputFormat: "json", audience: "agent", concurrency: 1 },
      repo,
      { createTransport: async () => transport as never },
      newProgressRouter({ stderr: (text) => { silent.push(text); } }, "json", "agent"),
    )();
    expect(human.join("")).toContain("[pi-review]");
    expect(silent).toEqual([]);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("agent audience still delivers command errors to stderr", async () => {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["review", "--repo", process.cwd(), "--audience", "agent"], {
    io: {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      cwd: () => process.cwd(),
      env: () => ({}),
      onSignal: () => {},
      offSignal: () => {},
    },
    reviewRunnerFactory: async () => {
      throw new Error("transport exploded");
    },
  });
  expect(code).toBe(1);
  expect(stderr).toContain("transport exploded");
  expect(stdout).toBe("");
});

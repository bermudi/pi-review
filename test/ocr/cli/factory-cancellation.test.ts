// SPDX-License-Identifier: GPL-3.0-or-later
//
// Production review-factory cancellation/session boundary. The transport is
// deterministic and local: no Pi configuration or network model is used.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { createReviewRunnerFactory } from "../../../src/ocr/cli/factory.js";
import { runCli } from "../../../src/ocr/cli/index.js";
import { type ReviewRunner } from "../../../src/ocr/cli/review.js";
import { defaultReviewOptions } from "../../../src/ocr/cli/shared.js";
import { SessionFilePath } from "../../../src/ocr/session/persist.js";
import { LoadReviewResumeState } from "../../../src/ocr/session/resume.js";
import { RunFailureCancelled } from "../../../src/ocr/session/manifest.js";

class BlockingReviewTransport {
  private resolveBlocked!: () => void;
  readonly blocked = new Promise<void>((resolve) => {
    this.resolveBlocked = resolve;
  });

  async CompletionsWithCtx(signal: AbortSignal, request: unknown): Promise<unknown> {
    const messages = (request as { messages: Array<{ content: string }> }).messages;
    const prompt = messages.map((message) => String(message.content)).join("\n");
    if (prompt.includes("<current_file_path>z-blocked.go</current_file_path>")) {
      this.resolveBlocked();
      return new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void => reject(
          signal.reason instanceof Error ? signal.reason : new Error("context canceled"),
        );
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      });
    }
    return {
      content: "",
      toolCalls: [{ id: "done", type: "function", function: { name: "task_done", arguments: "{}" } }],
      usage: { PromptTokens: 1, CompletionTokens: 1 },
    };
  }

  async dispose(): Promise<void> {}
}

class NoopReviewTransport {
  async CompletionsWithCtx(): Promise<unknown> {
    throw new Error("transport must not be called for an empty review");
  }

  async dispose(): Promise<void> {}
}

test("production review factory persists one cancelled Agent session", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-factory-cancel-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-factory-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    for (const command of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Test"],
    ]) {
      expect(spawnSync("git", ["-C", repo, ...command], { encoding: "utf8" }).status).toBe(0);
    }
    fs.writeFileSync(path.join(repo, "a-done.go"), "package p\n");
    fs.writeFileSync(path.join(repo, "z-blocked.go"), "package p\n");
    expect(spawnSync("git", ["-C", repo, "add", "."], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("git", ["-C", repo, "commit", "-qm", "base"], { encoding: "utf8" }).status).toBe(0);
    fs.writeFileSync(path.join(repo, "a-done.go"), "package p\n// done\n");
    fs.writeFileSync(path.join(repo, "z-blocked.go"), "package p\n// blocked\n");

    const transport = new BlockingReviewTransport();
    const controller = new AbortController();
    const factory = createReviewRunnerFactory(
      { ...defaultReviewOptions(), repoDir: repo, concurrency: 1 },
      repo,
      { createTransport: async () => transport as never },
    );
    const creating = factory(controller.signal);
    await transport.blocked;
    controller.abort(new Error("context canceled"));
    const runner = await creating;

    expect(runner.manifest?.runFailure?.classification).toBe(RunFailureCancelled);
    expect(runner.sessionId).not.toBe("");
    await expect(runner.run()).rejects.toThrow("context canceled");

    const sessionPath = SessionFilePath(repo, runner.sessionId);
    const records = fs.readFileSync(sessionPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { type?: string; run_manifest?: { runFailure?: { classification?: string } } });
    const ends = records.filter((record) => record.type === "session_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.run_manifest?.runFailure?.classification).toBe(RunFailureCancelled);

    const resume = LoadReviewResumeState(repo, runner.sessionId);
    expect(resume.CompletedCount()).toBe(1);
    expect(resume.ReusableItem(runner.manifest!.coverage.completed[0]!.fingerprint ?? "")).not.toBeNull();
    expect(resume.ReusableItem(runner.manifest!.coverage.failed[0]!.fingerprint ?? "")).toBeNull();
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("writer creation failure stays off stdout and suppresses the session ID", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-factory-session-error-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-factory-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    expect(spawnSync("git", ["init", "-q", repo], { encoding: "utf8" }).status).toBe(0);
    const factory = createReviewRunnerFactory(
      { ...defaultReviewOptions(), repoDir: repo, outputFormat: "json" },
      repo,
      {
        createTransport: async () => {
          // Resolver initialization precedes transport creation. Block session
          // writer creation after that unrelated configuration read succeeds.
          fs.writeFileSync(path.join(home, ".opencodereview"), "blocked", { mode: 0o600 });
          return new NoopReviewTransport() as never;
        },
      },
    );
    let stdout = "";
    let stderr = "";
    let created: ReviewRunner | undefined;
    const code = await runCli(["review", "--repo", repo, "--format", "json"], {
      io: {
        stdout: (text: string) => { stdout += text; },
        stderr: (text: string) => { stderr += text; },
        cwd: () => repo,
        env: () => ({}),
        onSignal: () => {},
        offSignal: () => {},
      },
      reviewRunnerFactory: async (_opts, signal) => {
        created = await factory(signal);
        return created;
      },
    });
    expect(code).toBe(1);
    expect(created?.sessionId).toBe("");
    expect(created?.manifest).toBeUndefined();
    expect(stdout).toBe("");
    expect(stderr).toContain("create session writer");
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

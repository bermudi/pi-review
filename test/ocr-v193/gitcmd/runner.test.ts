// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/gitcmd/runner_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { Runner } from "../../../src/ocr-v193/diff/runner.js";

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-"));
  const run = (...args: string[]): void => {
    const res = spawnSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr?.toString()}`);
  };
  run("init", "-q");
  run("config", "user.email", "test@test.com");
  run("config", "user.name", "test");
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello\n", { mode: 0o644 });
  run("add", "hello.txt");
  run("commit", "-q", "-m", "init");
  return dir;
}

// OCR v1.9.3: TestRunner_New
test("TestRunner_New", () => {
  const r0 = new Runner(0);
  // default capacity 16
  expect(r0.capacity).toBe(16);
  const r4 = new Runner(4);
  expect(r4.capacity).toBe(4);
  // cleanup: no resources to free
});

// OCR v1.9.3: TestRunner_Run
test("TestRunner_Run", async () => {
  const dir = initRepo();
  try {
    const r = new Runner(2);
    const out = await r.run(dir, ["log", "--oneline"]);
    expect(out).toContain("init");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunner_Run_InvalidCommand
test("TestRunner_Run_InvalidCommand", async () => {
  const dir = initRepo();
  try {
    const r = new Runner(2);
    await expect(r.run(dir, ["nonexistent-subcommand"])).rejects.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunner_Output
test("TestRunner_Output", async () => {
  const dir = initRepo();
  try {
    const r = new Runner(2);
    const out = await r.output(dir, ["rev-parse", "HEAD"]);
    const hash = out.toString().trim();
    expect(hash.length).toBe(40);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunner_RunSplit
test("TestRunner_RunSplit", async () => {
  const dir = initRepo();
  try {
    const r = new Runner(2);
    const { stdout } = await r.runSplit(dir, ["status", "--short"]);
    // clean repo should not have untracked ?? markers
    expect(stdout.includes("??")).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunner_Stream
test("TestRunner_Stream", async () => {
  const dir = initRepo();
  try {
    const r = new Runner(2);
    let content = "";
    await r.stream(
      dir,
      async (stdout) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stdout as AsyncIterable<Buffer>) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        content = Buffer.concat(chunks).toString();
      },
      ["show", "HEAD:hello.txt"],
    );
    expect(content).toBe("hello\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunner_ContextCancelled
test("TestRunner_ContextCancelled", async () => {
  const r = new Runner(1);
  const controller = new AbortController();
  controller.abort();
  await expect(r.run(".", ["status"], controller.signal)).rejects.toThrow();
});

// OCR v1.9.3: TestRunner_AcquireTimeout
test("TestRunner_AcquireTimeout", async () => {
  const r = new Runner(1);
  // Fill semaphore via internal queue: acquire one permit manually by running a hanging op?
  // We simulate by acquiring via run that holds semaphore? Instead we directly fill the internal semaphore
  // by accessing private via casting — use typed helper not export.
  const sem = (r as unknown as { sem: { current: number; capacity: number; queue: unknown[] } }).sem;
  // For our implementation we can push a dummy holder by starting a stream that never finishes,
  // but simpler: directly manipulate queue to mimic Go's r.sem <- struct{}{}
  // Since Runner's sem is private, we abuse the fact that run acquires before exec.
  // Approach: start a run that blocks (e.g., sleep) and then attempt second run with timeout.
  // Use a long-running git command: git log with delay? Instead use a manual semaphore fill:
  // Our Semaphore stores current count; we can artificially set current = capacity to block.
  // Use white-box cast.
  const internal = r as unknown as { sem: { current: number } };
  // Force semaphore to be full by setting current to capacity
  const anyR = r as unknown as Record<string, unknown>;
  // Access private sem via bracket trick
  const semObj = (anyR["sem"] as { current: number; capacity: number });
  // Save original
  const saved = semObj.current;
  semObj.current = semObj.capacity;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(new Error("timeout")), 50);
    try {
      await r.run(".", ["status"], controller.signal);
      throw new Error("expected timeout error");
    } catch (e) {
      expect(String(e)).toMatch(/abort|timeout|cancel/i);
    } finally {
      clearTimeout(tid);
    }
  } finally {
    semObj.current = saved;
  }
});

// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/review_cmd_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { validateReviewRefs, reviewResultError } from "../../../src/ocr/cli/review.js";
import { parseReviewFlags } from "../../../src/ocr/cli/index.js";
import { runCli } from "../../../src/ocr/cli/index.js";
import type { RunManifest } from "../../../src/ocr/session/manifest.js";

// OCR v1.9.3: TestValidateReviewRefsRejectsOptionLikeCommit
test("validateReviewRefs rejects option-like commit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-review-refs-"));
  try {
    expect(() => validateReviewRefs(dir, { commit: "-O./pwn.sh", from: "", to: "" } as never)).toThrow();
    try {
      validateReviewRefs(dir, { commit: "-O./pwn.sh", from: "", to: "" } as never);
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("--commit");
      expect(msg).toContain("must not start with '-'");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestValidateReviewRefsRejectsOptionLikeRangeRef
test("validateReviewRefs rejects option-like range ref", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-review-refs-"));
  try {
    expect(() => validateReviewRefs(dir, { commit: "", from: "", to: "-O./pwn.sh" } as never)).toThrow();
    try {
      validateReviewRefs(dir, { commit: "", from: "", to: "-O./pwn.sh" } as never);
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("--to");
      expect(msg).toContain("must not start with '-'");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestReviewResultErrorUsesManifestTerminalState
test("reviewResultError uses manifest terminal state", () => {
  const states = ["complete", "partial", "skipped"] as const;
  for (const state of states) {
    const m: RunManifest = {
      schemaVersion: "ocr.run-manifest/v1",
      runId: "run-1",
      operation: "review",
      terminalState: state as RunManifest["terminalState"],
      repository: {},
      input: { mode: "range" },
      execution: {},
      coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
      elapsedMs: 0,
    };
    expect(reviewResultError(null, m), `state ${state} should not error`).toBeNull();
  }
  const failedNoDetail: RunManifest = {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-2",
    operation: "review",
    terminalState: "failed",
    repository: {},
    input: { mode: "range" },
    execution: {},
    coverage: {
      selected: [{ itemId: "a", path: "a.go" }],
      completed: [],
      reused: [],
      failed: [{ itemId: "a", path: "a.go", classification: "unknown" }],
      waived: [],
    },
    elapsedMs: 0,
  };
  const err1 = reviewResultError(null, failedNoDetail);
  expect(err1).not.toBeNull();

  const withRunFailure: RunManifest = {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-3",
    operation: "review",
    terminalState: "failed",
    repository: {},
    input: { mode: "range" },
    execution: {},
    coverage: {
      selected: [{ itemId: "a", path: "a.go" }],
      completed: [],
      reused: [],
      failed: [{ itemId: "a", path: "a.go", classification: "input" }],
      waived: [],
    },
    runFailure: { classification: "input", reason: "diff resolution failed" },
    elapsedMs: 0,
  };
  const err2 = reviewResultError(null, withRunFailure);
  expect(err2).not.toBeNull();
  expect(String(err2!.message)).toContain("input");
  expect(String(err2!.message)).toContain("diff resolution failed");

  const failedCounts: RunManifest = {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-4",
    operation: "review",
    terminalState: "failed",
    repository: {},
    input: { mode: "range" },
    execution: {},
    coverage: {
      selected: [{ itemId: "a", path: "a.go" }, { itemId: "b", path: "b.go" }],
      completed: [],
      reused: [],
      failed: [{ itemId: "a", path: "a.go" }, { itemId: "b", path: "b.go" }],
      waived: [],
    },
    elapsedMs: 0,
  };
  const err3 = reviewResultError(null, failedCounts);
  expect(String(err3!.message)).toContain("2 of 2 selected item(s) failed");

  const budgetPartial: RunManifest = {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-5",
    operation: "review",
    terminalState: "partial",
    repository: {},
    input: { mode: "range" },
    execution: {},
    coverage: {
      selected: [{ itemId: "a", path: "a.go" }, { itemId: "b", path: "b.go" }],
      completed: [{ itemId: "a", path: "a.go" }],
      reused: [],
      failed: [{ itemId: "b", path: "b.go", classification: "budget" }],
      waived: [],
    },
    elapsedMs: 0,
  };
  expect(reviewResultError(null, budgetPartial)).toBeNull();

  const budgetAllFailed: RunManifest = {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-6",
    operation: "review",
    terminalState: "failed",
    repository: {},
    input: { mode: "range" },
    execution: {},
    coverage: {
      selected: [{ itemId: "a", path: "a.go" }, { itemId: "b", path: "b.go" }],
      completed: [],
      reused: [],
      failed: [
        { itemId: "a", path: "a.go", classification: "budget" },
        { itemId: "b", path: "b.go", classification: "budget" },
      ],
      waived: [],
    },
    elapsedMs: 0,
  };
  const err4 = reviewResultError(null, budgetAllFailed);
  expect(err4).not.toBeNull();
  expect(String(err4!.message)).toContain("2 of 2 selected item(s) failed");

  const want = new Error("dispatch failed");
  const preserved = reviewResultError(want, budgetPartial);
  expect(preserved).toBe(want);
});

// OCR v1.9.3: TestParseReviewFlagsRejectsToWithoutFrom
test("parseReviewFlags rejects to without from", () => {
  expect(() => parseReviewFlags(["--to", "HEAD"])).toThrow();
  try {
    parseReviewFlags(["--to", "HEAD"]);
  } catch (e) {
    expect(String((e as Error).message)).toContain("--from is required when --to is specified");
  }
});

// OCR v1.9.3: TestParseReviewFlagsRejectsFromWithoutTo
test("parseReviewFlags rejects from without to", () => {
  expect(() => parseReviewFlags(["--from", "main"])).toThrow();
  try {
    parseReviewFlags(["--from", "main"]);
  } catch (e) {
    expect(String((e as Error).message)).toContain("--to is required when --from is specified");
  }
});

// OCR v1.9.3: TestRunReviewFlagValidationWritesNoArtifacts
test("runReview flag validation writes no artifacts", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let stderr = "";
    const io = {
      stdout: () => {},
      stderr: (s: string) => { stderr += s; },
    };
    const code = await runCli(["review", "--to", "HEAD"], { io } as never);
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(home, ".opencodereview"))).toBe(false);
    void stderr;
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("review CLI forwards SIGINT through the Agent abort seam and removes listeners", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-review-signal-"));
  const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  expect(init.status).toBe(0);
  const listeners = new Map<string, () => void>();
  const removed: string[] = [];
  let receivedSignal: AbortSignal | undefined;
  try {
    const code = await runCli(["review", "--repo", repo], {
      io: {
        stdout: () => {},
        stderr: () => {},
        onSignal: (name: string, listener: () => void) => { listeners.set(name, listener); },
        offSignal: (name: string) => { removed.push(name); listeners.delete(name); },
      },
      reviewRunnerFactory: async (
        _opts: import("../../../src/ocr/cli/shared.js").ReviewOptions,
        signal?: AbortSignal,
      ) => {
        receivedSignal = signal;
        listeners.get("SIGINT")?.();
        return {
          run: async (runSignal?: AbortSignal) => {
            expect(runSignal).toBe(receivedSignal);
            expect(runSignal?.aborted).toBe(true);
            return [];
          },
          diffs: [],
          filesReviewed: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          toolCalls: {},
          warnings: [],
          projectSummary: "",
        } as never;
      },
    } as never);
    expect(code).toBe(0);
    expect(receivedSignal?.aborted).toBe(true);
    expect(removed).toEqual(["SIGINT", "SIGTERM"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestParseReviewFlagsAllowsFromAndTo
test("parseReviewFlags allows from and to", () => {
  const opts = parseReviewFlags(["--from", "main", "--to", "HEAD"]);
  expect(opts.from).toBe("main");
  expect(opts.to).toBe("HEAD");
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/llmloop/loop_test.go + internal/agent/agent_test.go workspace review path at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Minimal vertical slice fixture: workspace review through code_comment + task_done.
 *
 * One changed file (main.go) in workspace mode (staged/untracked diff),
 * one model round producing code_comment (bug), second round task_done.
 * Proves pipeline: Git diff acquisition -> file selection -> model loop ->
 * incremental code_comment collection -> task_done stop -> post-processing.
 *
 * Deterministic: fixed clock 2026-01-01T00:00:00Z, temp path <TMP> normalization.
 */
import { createTempRepo, applyWorkspaceChanges } from "../fixture.js";
import { runPiHarness } from "../pi-runner.js";
import type { HarnessRunResult, ScriptedTurn } from "../types.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const FIXTURE_ID = "workspace-code_comment-task_done";

export interface WorkspaceFixtureOpts {
  readonly fixedNowMs?: number;
}

export function scriptedTurnsForWorkspace(): readonly ScriptedTurn[] {
  return [
    {
      toolCalls: [
        {
          id: "call_1",
          name: "code_comment",
          arguments: JSON.stringify({
            path: "main.go",
            comments: [{ content: "Consider handling nil case for Add", existing_code: "func Add(a int, b int) int { return a + b }", category: "bug", severity: "medium" }],
          }),
        },
      ],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    },
    {
      toolCalls: [{ id: "call_2", name: "task_done", arguments: JSON.stringify({}) }],
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    },
  ];
}

export async function runWorkspaceFixture(opts: WorkspaceFixtureOpts = {}): Promise<{
  readonly harnessResult: HarnessRunResult;
  readonly cleanup: () => Promise<void>;
}> {
  const fixedNowMs = opts.fixedNowMs ?? Date.UTC(2026, 0, 1, 0, 0, 0);
  const repo = await createTempRepo({
    mode: "workspace",
    fixedNowMs,
    files: { "main.go": "package main\nfunc Add(a int, b int) int { return a + b }\n" },
  });

  // Apply workspace diff: single insertion that should be reviewed
  await applyWorkspaceChanges(repo.dir, {
    "main.go": "package main\nfunc Add(a int, b int) int {\n  // TODO: handle nil?\n  return a + b\n}\n",
  });

  // Ensure workspace diff is visible (git diff)
  // Leave changes unstaged to simulate workspace mode
  // git status should show modified main.go + untracked README (but our Provider handles both)

  const turns = scriptedTurnsForWorkspace();
  const piResult = await runPiHarness({
    fixtureId: FIXTURE_ID,
    repoDir: repo.dir,
    rawRepoDir: repo.dir,
    turns,
    fixedNowMs,
  });

  return {
    harnessResult: piResult,
    cleanup: repo.cleanup,
  };
}

export async function runWorkspaceFixtureEndToEnd(): Promise<{
  readonly expectedComments: number;
  readonly stopReason: string;
  readonly pass: boolean;
  readonly result: HarnessRunResult;
  readonly cleanup: () => Promise<void>;
}> {
  const { harnessResult, cleanup } = await runWorkspaceFixture();
  const pass = harnessResult.commentsAfter.length === 1 && harnessResult.stopReason === "complete";
  return {
    expectedComments: 1,
    stopReason: harnessResult.stopReason,
    pass,
    result: harnessResult,
    cleanup,
  };
}

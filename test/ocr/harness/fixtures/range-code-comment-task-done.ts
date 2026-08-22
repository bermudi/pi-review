// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/agent/agent_test.go range mode path at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { createTempRepo } from "../fixture.js";
import { runPiHarness } from "../pi-runner.js";
import type { HarnessRunResult, ScriptedTurn } from "../types.js";
import { ModeRange } from "../../../../src/ocr/diff/git.js";
import { spawnSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const FIXTURE_ID_RANGE = "range-code_comment-task_done";

export function scriptedTurnsForRange(): readonly ScriptedTurn[] {
  return [
    {
      toolCalls: [{ id: "call_1", name: "code_comment", arguments: JSON.stringify({ path: "feature.go", comments: [{ content: "Range finding", existing_code: "func Feature", category: "bug", severity: "high" }] }) }],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    },
    { toolCalls: [{ id: "call_2", name: "task_done", arguments: JSON.stringify({}) }], usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } },
  ];
}

export async function runRangeFixture(): Promise<{ readonly harnessResult: HarnessRunResult; readonly cleanup: () => Promise<void> }> {
  const fixedNowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const dateISO = new Date(fixedNowMs).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO } as any;

  const repo = await createTempRepo({ mode: "range", fixedNowMs, files: { "feature.go": "package feature\nfunc Feature() {}\n" } });

  // Create a feature branch change: second commit on top
  const full = join(repo.dir, "feature.go");
  await writeFile(full, "package feature\nfunc Feature() int { return 42 }\n", "utf-8");
  spawnSync("git", ["add", "-A"], { cwd: repo.dir, env });
  spawnSync("git", ["commit", "-q", "-m", "feature: add return"], { cwd: repo.dir, env });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf-8" }).stdout.trim();
  const base = repo.baseCommit!; // initial commit

  const turns = scriptedTurnsForRange();
  // Write sidecar for ocr-runner fallback
  await writeFile(join(repo.dir, ".ocr-fixture-range"), JSON.stringify({ from: base, to: head }), "utf-8").catch(() => {});
  const piResult = await runPiHarness({
    fixtureId: FIXTURE_ID_RANGE,
    repoDir: repo.dir,
    rawRepoDir: repo.dir,
    turns,
    fixedNowMs,
    mode: ModeRange,
    from: base,
    to: head,
  } as any);

  return { harnessResult: piResult, cleanup: repo.cleanup };
}

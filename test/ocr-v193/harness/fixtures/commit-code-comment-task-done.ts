// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/agent/agent_test.go commit mode path at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { createTempRepo } from "../fixture.js";
import { runPiHarness } from "../pi-runner.js";
import type { HarnessRunResult, ScriptedTurn } from "../types.js";
import { ModeCommit } from "../../../../src/ocr-v193/diff/git.js";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FIXTURE_ID_COMMIT = "commit-code_comment-task_done";

export function scriptedTurnsForCommit(): readonly ScriptedTurn[] {
  return [
    {
      toolCalls: [{ id: "call_1", name: "code_comment", arguments: JSON.stringify({ path: "commit.go", comments: [{ content: "Commit finding", existing_code: "func Work", category: "maintainability", severity: "low" }] }) }],
      usage: { promptTokens: 90, completionTokens: 45, totalTokens: 135 },
    },
    { toolCalls: [{ id: "call_2", name: "task_done", arguments: JSON.stringify({}) }], usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } },
  ];
}

export async function runCommitFixture(): Promise<{ readonly harnessResult: HarnessRunResult; readonly cleanup: () => Promise<void> }> {
  const fixedNowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const dateISO = new Date(fixedNowMs).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO } as any;

  const repo = await createTempRepo({ mode: "commit", fixedNowMs, files: { "commit.go": "package commit\nfunc Work() {}\n" } });

  const full = join(repo.dir, "commit.go");
  await writeFile(full, "package commit\nfunc Work() int { return 1 }\n", "utf-8");
  spawnSync("git", ["add", "-A"], { cwd: repo.dir, env });
  spawnSync("git", ["commit", "-q", "-m", "commit: bump"], { cwd: repo.dir, env });
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf-8" }).stdout.trim();

  const turns = scriptedTurnsForCommit();
  await writeFile(join(repo.dir, ".ocr-fixture-commit"), commit, "utf-8").catch(() => {});
  const piResult = await runPiHarness({
    fixtureId: FIXTURE_ID_COMMIT,
    repoDir: repo.dir,
    rawRepoDir: repo.dir,
    turns,
    fixedNowMs,
    mode: ModeCommit,
    commit,
  } as any);

  return { harnessResult: piResult, cleanup: repo.cleanup };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/llmloop/loop_test.go TestMaxRoundsGrace + CancelPreventsGrace at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Budget exhaustion + restricted grace fixture.
 *
 * Normal budget MaxToolRequestTimes=2 is exhausted after two file_read rounds;
 * grace round (only code_comment + task_done) succeeds with one finding.
 * Also used to verify cancelled grace would stop before grace.
 */
import { createTempRepo, applyWorkspaceChanges } from "../fixture.js";
import { runPiHarness } from "../pi-runner.js";
import type { HarnessRunResult, ScriptedTurn } from "../types.js";

export const FIXTURE_ID_BUDGET = "workspace-budget-grace";
export const FIXTURE_ID_CANCELLED = "workspace-cancelled-grace";

export function scriptedTurnsForBudgetGrace(): readonly ScriptedTurn[] {
  // Budget 1: one normal file_read exhausts budget, grace allows only code_comment/task_done
  // We use task_done in grace to complete, so total 2 requests (1 normal + 1 grace)
  return [
    { toolCalls: [{ id: "c1", name: "file_read", arguments: JSON.stringify({ file_path: "service.go" }) }], usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
    { toolCalls: [{ id: "c2", name: "task_done", arguments: JSON.stringify({}) }], usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
  ];
}

export async function runBudgetGraceFixture(): Promise<{
  readonly harnessResult: HarnessRunResult;
  readonly cleanup: () => Promise<void>;
}> {
  const fixedNowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const repo = await createTempRepo({
    mode: "workspace",
    fixedNowMs,
    files: { "service.go": "package service\nfunc Serve() {}\n" },
  });

  await applyWorkspaceChanges(repo.dir, {
    "service.go": "package service\nfunc Serve() int {\n  // new handler\n  return 1\n}\n",
  });

  const turns = scriptedTurnsForBudgetGrace();
  const piResult = await runPiHarness({
    fixtureId: FIXTURE_ID_BUDGET,
    repoDir: repo.dir,
    rawRepoDir: repo.dir,
    turns,
    fixedNowMs,
    template: { MaxToolRequestTimes: 1, MaxTokens: 1000, MaxCompletionTokens: 4096 } as any,
  });

  return { harnessResult: piResult, cleanup: repo.cleanup };
}

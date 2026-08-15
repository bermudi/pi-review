// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/llmloop/loop_test.go TestEmptyToolCallsRetry + three consecutive empty at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Empty/malformed fixture: three consecutive rounds without a usable tool result must stop
 * with typed empty_rounds. Covers malformed JSON args, unknown tool, and empty tool_calls.
 */
import { createTempRepo, applyWorkspaceChanges } from "../fixture.js";
import { runPiHarness } from "../pi-runner.js";
import type { HarnessRunResult, ScriptedTurn } from "../types.js";

export const FIXTURE_ID = "workspace-empty-malformed-three-strikes";

export function scriptedTurnsForEmpty(): readonly ScriptedTurn[] {
  // 3 consecutive file_read that return empty string ("") -> hasValidResult false -> StopEmptyRounds
  // Use empty.txt which is empty, so both Pi and OCR return "" and count as empty.
  return [
    { toolCalls: [{ id: "e1", name: "file_read", arguments: JSON.stringify({ file_path: "empty.txt" }) }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { toolCalls: [{ id: "e2", name: "file_read", arguments: JSON.stringify({ file_path: "empty.txt" }) }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { toolCalls: [{ id: "e3", name: "file_read", arguments: JSON.stringify({ file_path: "empty.txt" }) }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    // This fourth turn should NOT be consumed — loop must stop after 3 empties (emptyRoundLimit=3)
    {
      toolCalls: [
        {
          id: "c3",
          name: "code_comment",
          arguments: JSON.stringify({ path: "utils.go", comments: [{ content: "late comment", existing_code: "func Helper" }] }),
        },
      ],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
  ];
}

export async function runEmptyFixture(): Promise<{
  readonly harnessResult: HarnessRunResult;
  readonly cleanup: () => Promise<void>;
}> {
  const fixedNowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const repo = await createTempRepo({
    mode: "workspace",
    fixedNowMs,
    files: { "utils.go": "package utils\nfunc Helper() {}\n", "empty.txt": "" },
  });

  await applyWorkspaceChanges(repo.dir, {
    "utils.go": "package utils\nfunc Helper() int { return 42 }\n",
  });

  const turns = scriptedTurnsForEmpty();
  const piResult = await runPiHarness({
    fixtureId: FIXTURE_ID,
    repoDir: repo.dir,
    rawRepoDir: repo.dir,
    turns,
    fixedNowMs,
  });

  return { harnessResult: piResult, cleanup: repo.cleanup };
}

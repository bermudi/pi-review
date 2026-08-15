// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/llmloop/loop_test.go TestMultipleToolCalls at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Multi-tool-call fixture: one model response contains two tool calls (file_read + code_comment)
 * and must count as ONE round, not two. Second response is task_done -> complete.
 * Proves round accounting and that all calls in one response are executed and feed one next request.
 */
import { createTempRepo, applyWorkspaceChanges } from "../fixture.js";
import { runPiHarness } from "../pi-runner.js";
import type { HarnessRunResult, ScriptedTurn } from "../types.js";

export const FIXTURE_ID = "workspace-multi-tool-call-single-round";

export function scriptedTurnsForMultiTool(): readonly ScriptedTurn[] {
  return [
    {
      toolCalls: [
        { id: "c1", name: "file_read", arguments: JSON.stringify({ file_path: "README.md" }) },
        {
          id: "c2",
          name: "code_comment",
          arguments: JSON.stringify({
            path: "main.go",
            comments: [{ content: "missing error check", existing_code: "func Foo() int {", category: "bug", severity: "medium" }],
          }),
        },
      ],
      usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 },
    },
    {
      toolCalls: [{ id: "c3", name: "task_done", arguments: JSON.stringify({}) }],
      usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 },
    },
  ];
}

export async function runMultiToolFixture(): Promise<{
  readonly harnessResult: HarnessRunResult;
  readonly cleanup: () => Promise<void>;
}> {
  const fixedNowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const repo = await createTempRepo({
    mode: "workspace",
    fixedNowMs,
    files: {
      "main.go": "package main\nfunc Foo() int { return 1 }\n",
      "README.md": "# Hello\nProject readme\n",
    },
  });

  await applyWorkspaceChanges(repo.dir, {
    "main.go": "package main\nfunc Foo() int {\n  // new logic without error check\n  return 1\n}\n",
  });

  const turns = scriptedTurnsForMultiTool();
  const piResult = await runPiHarness({
    fixtureId: FIXTURE_ID,
    repoDir: repo.dir,
    rawRepoDir: repo.dir,
    turns,
    fixedNowMs,
  });

  return { harnessResult: piResult, cleanup: repo.cleanup };
}

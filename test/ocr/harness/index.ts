// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from docs/ocr-port-plan.md Phase 2 differential harness contract at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Differential harness CLI entry point.
 *
 * - Verifies pinned tag/commit (fails fast if wrong).
 * - Builds temp Git repo fixtures (workspace/range/commit).
 * - Runs Pi parity engine via ScriptedTransport (deterministic, no network).
 * - Runs OCR binary preview (via git archive build, argv arrays).
 * - Compares field-by-field and writes mismatch artifacts.
 *
 * Usage:
 *   bun run test/ocr/harness/index.ts [--fixture workspace] [--artifacts /tmp/artifacts]
 *   bun run harness           # via package.json script (to be added)
 *
 * Keep deterministic: fixed clock, <TMP> path normalization, no paid model, no network beyond localhost.
 */

import { verifyPinnedRef } from "./pinned.js";
import { runWorkspaceFixture, scriptedTurnsForWorkspace } from "./fixtures/workspace-code-comment-task-done.js";
import { runMultiToolFixture, scriptedTurnsForMultiTool } from "./fixtures/workspace-multi-tool-call.js";
import { runEmptyFixture, scriptedTurnsForEmpty } from "./fixtures/workspace-empty-malformed.js";
import { runBudgetGraceFixture, scriptedTurnsForBudgetGrace } from "./fixtures/workspace-budget-grace.js";
import { runRangeFixture, scriptedTurnsForRange } from "./fixtures/range-code-comment-task-done.js";
import { runCommitFixture, scriptedTurnsForCommit } from "./fixtures/commit-code-comment-task-done.js";
import { runOcrHarness } from "./ocr-runner.js";
import { compareRuns, formatMismatches, writeArtifacts } from "./comparer.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeServer } from "./fake-server.js";

interface CliArgs {
  fixture: string;
  artifactsDir: string | null;
  runOcr: boolean;
  all: boolean;
}

type FixtureEntry = {
  id: string;
  runPi: () => Promise<{ harnessResult: import("./types.js").HarnessRunResult; cleanup: () => Promise<void> }>;
  scriptedTurns: () => readonly import("./types.js").ScriptedTurn[];
  differential: boolean; // whether to compare Pi vs OCR (false = Pi-only validation)
  ocrMaxTools?: number;
};

const FIXTURES: Record<string, FixtureEntry> = {
  workspace: {
    id: "workspace",
    runPi: runWorkspaceFixture,
    scriptedTurns: scriptedTurnsForWorkspace,
    differential: true,
  },
  "workspace-multi-tool": {
    id: "workspace-multi-tool",
    runPi: runMultiToolFixture as any,
    scriptedTurns: scriptedTurnsForMultiTool as any,
    differential: true,
  },
  "workspace-empty": {
    id: "workspace-empty",
    runPi: runEmptyFixture as any,
    scriptedTurns: scriptedTurnsForEmpty as any,
    differential: false, // Pi unit-test semantics (3 file_read empty -> StopEmptyRounds) cannot be reproduced via real OCR binary's file_read (always returns header); differential would require mock registry
  },
  "workspace-budget-grace": {
    id: "workspace-budget-grace",
    runPi: runBudgetGraceFixture as any,
    scriptedTurns: scriptedTurnsForBudgetGrace as any,
    differential: false, // Pi-only until OCR --max-tools 10 harness supports 10-round exhaustion
  },
  range: {
    id: "range",
    runPi: runRangeFixture as any,
    scriptedTurns: scriptedTurnsForRange as any,
    differential: true,
  },
  commit: {
    id: "commit",
    runPi: runCommitFixture as any,
    scriptedTurns: scriptedTurnsForCommit as any,
    differential: true,
  },
};

function parseArgs(argv: readonly string[]): CliArgs {
  let fixture = "workspace";
  let artifactsDir: string | null = null;
  let runOcr = true;
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const maybeA = argv[i];
    if (maybeA === undefined) continue;
    const a: string = maybeA;
    if (a === "--fixture" && i + 1 < argv.length) {
      const nxt = argv[++i];
      if (nxt !== undefined) fixture = nxt;
    } else if (a.startsWith("--fixture=")) {
      const part = a.split("=")[1] ?? fixture;
      fixture = part;
    } else if (a === "--artifacts" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v !== undefined) artifactsDir = v;
    } else if (a.startsWith("--artifacts=")) {
      const part = a.split("=")[1];
      if (part !== undefined) artifactsDir = part;
    } else if (a === "--all") { all = true; }
    else if (a === "--no-ocr") runOcr = false;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun run test/ocr/harness/index.ts [options]
Options:
  --fixture <name>    Fixture id (default: workspace) or 'all'\n                    Available: ${Object.keys(FIXTURES).join(", ")}, all
  --all               Run all fixtures
  --artifacts <dir>   Write mismatch artifacts to dir
  --no-ocr            Skip OCR binary run (Pi-only smoke test)
  --help              Show help
Exit codes: 0=pass, 1=mismatch, 2=setup failure`);
      process.exit(0);
    }
  }
  if (fixture === "all") all = true;
  return { fixture, artifactsDir, runOcr, all };
}

async function resolveFixture(name: string): Promise<FixtureEntry> {
  const entry = FIXTURES[name];
  if (!entry) {
    console.error(`Unknown fixture: ${name}. Available: ${Object.keys(FIXTURES).join(", ")}`);
    process.exit(2);
  }
  return entry!;
}

async function runOneFixture(
  entry: FixtureEntry,
  artifactsDir: string,
  runOcr: boolean,
): Promise<{ ok: boolean; piResult: import("./types.js").HarnessRunResult; ocrResult: import("./types.js").HarnessRunResult | null }> {
  const turns = entry.scriptedTurns();
  const fake = startFakeServer({ turns });
  const { harnessResult: piResult, cleanup } = await entry.runPi();
  let ocrResult: import("./types.js").HarnessRunResult | null = null;
  try {
    if (runOcr && entry.differential) {
      ocrResult = await runOcrHarness({
        fixtureId: piResult.fixtureId,
        repoDir: piResult.rawRepoDir,
        rawRepoDir: piResult.rawRepoDir,
        fakeServerUrl: fake.url,
        turns,
        fakeServerRequests: fake.requests as any,
      });
    }
  } finally {
    // keep fake alive until after OCR
  }

  // If OCR was skipped, differential disabled, or stubbed, validate Pi slice only (no parity claim)
  if (!runOcr || !entry.differential || !ocrResult || (ocrResult.raw as any)?.stub) {
    console.error(`[harness] ${entry.id}: Pi-only validation (differential=${entry.differential}, ocr=${ocrResult ? "stub" : "skipped"})`);
    let pass = false;
    if (entry.id === "workspace") pass = piResult.commentsAfter.length === 1 && piResult.stopReason === "complete" && piResult.coverage.selected.includes("main.go");
    else if (entry.id === "workspace-multi-tool") pass = piResult.modelRequests.length === 2 && piResult.modelRequests[0]!.toolCalls.length === 2 && piResult.commentsAfter.length === 1;
    else if (entry.id === "workspace-empty") pass = piResult.stopReason === "empty_rounds" && piResult.modelRequests.length === 3 && piResult.commentsAfter.length === 0;
    else if (entry.id === "workspace-budget-grace") pass = piResult.modelRequests.length === 2 && piResult.toolDefsPerPhase["grace"]?.length === 2 && piResult.modelRequests[1]?.tools.length === 2;
    else pass = piResult.coverage.selected.length > 0;
    if (pass) {
      console.log(`PASS ${entry.id}: selected=${JSON.stringify(piResult.coverage.selected)} comments=${piResult.commentsAfter.length} stop=${piResult.stopReason} modelRequests=${piResult.modelRequests.length} toolDefs=${piResult.toolDefsPerPhase["main"]?.join(",")}`);
    } else {
      console.error(`FAIL ${entry.id}: comments=${piResult.commentsAfter.length}, stop=${piResult.stopReason}, selected=${JSON.stringify(piResult.coverage.selected)}, modelRequests=${piResult.modelRequests.length}`);
      await writeArtifacts(artifactsDir, piResult.fixtureId, piResult, piResult, [{ field: "fixture", expected: entry.id, actual: piResult.stopReason, message: `Pi-only validation failed for ${entry.id}` }]);
      fake.stop();
      await cleanup();
      return { ok: false, piResult, ocrResult };
    }
    fake.stop();
    await cleanup();
    return { ok: true, piResult, ocrResult: null };
  }

  // Full differential: compare field-by-field
  const { equal, mismatches } = compareRuns(ocrResult, piResult, {
    ignoreFields: new Set(["output.text", "output.json", "output.sarif", "output.agent", "checkpointTransitions"]),
  });

  if (equal) {
    console.log(`PASS ${entry.id}: selected=${JSON.stringify(piResult.coverage.selected)} comments=${piResult.commentsAfter.length}->${ocrResult.commentsAfter.length} usage=${piResult.usage.totalTokens}->${ocrResult.usage.totalTokens} modelRequests=${piResult.modelRequests.length}->${ocrResult.modelRequests.length}`);
    console.log(formatMismatches(mismatches));
  } else {
    console.error(`FAIL ${entry.id}: Pi vs OCR mismatch`);
    console.error(formatMismatches(mismatches));
    console.error(`Pi: selected=${JSON.stringify(piResult.coverage.selected)} comments=${piResult.commentsAfter.length} usage=${piResult.usage.totalTokens} modelRequests=${piResult.modelRequests.length}`);
    console.error(`OCR: selected=${JSON.stringify(ocrResult.coverage.selected)} comments=${ocrResult.commentsAfter.length} usage=${ocrResult.usage.totalTokens} modelRequests=${(ocrResult.modelRequests as any)?.length ?? 0}`);
    await writeArtifacts(artifactsDir, piResult.fixtureId, ocrResult, piResult, mismatches);
    console.error(`Artifacts written to ${artifactsDir}/${piResult.fixtureId}/`);
    fake.stop();
    await cleanup();
    return { ok: false, piResult, ocrResult };
  }

  fake.stop();
  await cleanup();
  return { ok: true, piResult, ocrResult };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Fail if pinned ref missing — never silently test against main
  try {
    verifyPinnedRef();
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : String(e)));
    process.exit(2);
  }

  let artifactsDir = args.artifactsDir;
  if (!artifactsDir) {
    artifactsDir = await mkdtemp(join(tmpdir(), "ocr-harness-artifacts-"));
  }

  if (args.all) {
    console.error(`[harness] running all fixtures, artifacts=${artifactsDir}`);
    let allOk = true;
    for (const name of Object.keys(FIXTURES)) {
      const entry = await resolveFixture(name);
      const { ok } = await runOneFixture(entry, artifactsDir, args.runOcr);
      if (!ok) allOk = false;
    }
    if (!allOk) process.exit(1);
    console.log(`PASS harness: all ${Object.keys(FIXTURES).length} fixtures`);
    return;
  }

  const entry = await resolveFixture(args.fixture);
  console.error(`[harness] fixture=${entry.id} artifacts=${artifactsDir}`);
  const { ok } = await runOneFixture(entry, artifactsDir, args.runOcr);
  if (!ok) process.exit(1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[harness] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(2);
  });
}

export { verifyPinnedRef };

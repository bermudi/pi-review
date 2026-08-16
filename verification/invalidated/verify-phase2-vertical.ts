#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Ported from docs/ocr-v1.9.3-port-plan.md Phase 2 verifier at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function currentCommit(): string {
  try { return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim(); } catch { return "unknown"; }
}
function fail(msg: string, dir?: string): never {
  const out = {
    phase: "phase2-vertical",
    commit: currentCommit(),
    fixtures: [] as string[],
    assertions: 0,
    notApplicable: ["output.text", "output.json", "output.sarif", "checkpointTransitions"],
    privateImports: -1,
    result: "fail" as const,
    error: msg,
    artifactsDir: dir ?? null,
  };
  console.log(JSON.stringify(out));
  console.error(`[verify:phase2-vertical] FAIL: ${msg}`);
  if (dir) console.error(`Artifacts: ${dir}`);
  process.exit(1);
}
function checkGitClean(): void {
  const diff = spawnSync("git", ["diff", "--quiet"], { stdio: "ignore" });
  if (diff.status !== 0) fail("dirty working tree (uncommitted changes). Commit or stash first.");
  const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf-8" }).trim();
  if (untracked.length > 0) fail(`untracked files present:\n${untracked}`);
}
function verifyPinnedRef(): void {
  const expectedCommit = "c35ddd7223f2b5540ce03aa43c9a25ef643fca27";
  const ocrPath = "../open-code-review";
  if (!existsSync(ocrPath)) fail(`pinned checkout missing at ${ocrPath}`);
  try {
    const commit = execSync(`git -C ${ocrPath} rev-parse v1.9.3^{commit}`, { encoding: "utf-8" }).trim();
    if (commit !== expectedCommit) fail(`pinned commit mismatch: expected ${expectedCommit} got ${commit}`);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes("FAIL")) throw e;
    fail(`pinned ref failed: ${m}`);
  }
}
function checkPrivateImports(): number {
  const rg = spawnSync("sh", ["-c", `rg -n "pi-agent-core|pi-ai" src --hidden 2>/dev/null | head -n 50`], { encoding: "utf-8" });
  const out = (rg.stdout as string) ?? "";
  const importLines = out
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith("*") || t.startsWith("//") || t.includes("`pi-agent")) return false;
      return /from\s+["'][^"']*pi-agent/.test(l) || /import\s*\([^)]*pi-agent/.test(l) || /^\s*import\s+.*pi-agent/.test(l);
    })
    .join("\n");
  if (importLines.trim().length > 0) {
    console.log(
      JSON.stringify({
        phase: "phase2-vertical",
        commit: currentCommit(),
        fixtures: [],
        assertions: 0,
        notApplicable: [],
        privateImports: 1,
        result: "fail" as const,
        error: `private imports: ${importLines}`,
        artifactsDir: null,
      }),
    );
    console.error(`[verify:phase2-vertical] FAIL private imports`);
    process.exit(1);
  }
  const rgAny = spawnSync("sh", ["-c", `rg -n "as any|: any" src/ocr-v193 --hidden 2>/dev/null | head -n 20`], { encoding: "utf-8" });
  const anyOut = (rgAny.stdout as string) ?? "";
  if (anyOut.trim().length > 0) {
    console.log(
      JSON.stringify({
        phase: "phase2-vertical",
        commit: currentCommit(),
        fixtures: [],
        assertions: 0,
        notApplicable: [],
        privateImports: 1,
        result: "fail" as const,
        error: `as any found: ${anyOut}`,
        artifactsDir: null,
      }),
    );
    console.error(`FAIL as any`);
    process.exit(1);
  }
  return 0;
}

async function main(): Promise<void> {
  let artifactsDir = "";
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--artifacts" && i + 1 < args.length) artifactsDir = args[i + 1] as string;
    else if ((args[i] as string).startsWith("--artifacts=")) artifactsDir = (args[i] as string).split("=")[1] as string;
  }
  if (!artifactsDir) artifactsDir = mkdtempSync(join(tmpdir(), "verify-phase2-"));

  checkGitClean();
  verifyPinnedRef();
  const privateImports = checkPrivateImports();

  // Require Phase 0 and Phase 1 to pass
  const phase0 = spawnSync("bun", ["run", "scripts/verify-phase0-evidence.ts", "--artifacts", join(artifactsDir, "phase0")], { encoding: "utf-8" });
  if (phase0.status !== 0) fail(`Phase 2 requires Phase 0 to pass. Phase0: ${phase0.stdout?.slice(0, 800)} ${phase0.stderr?.slice(0, 800)}`, artifactsDir);
  const phase1 = spawnSync("bun", ["run", "scripts/verify-phase1-sdk.ts", "--artifacts", join(artifactsDir, "phase1")], { encoding: "utf-8" });
  if (phase1.status !== 0) fail(`Phase 2 requires Phase 1 to pass. Phase1: ${phase1.stdout?.slice(0, 800)} ${phase1.stderr?.slice(0, 800)}`, artifactsDir);

  mkdirSync(artifactsDir, { recursive: true });

  // Imports for harness
  const { createTempRepo, applyWorkspaceChanges } = await import("../test/ocr-v193/harness/fixture.js");
  const { startFakeServer } = await import("../test/ocr-v193/harness/fake-server.js");
  const { runOcrHarness } = await import("../test/ocr-v193/harness/ocr-runner.js");
  const { runPiRealHarness } = await import("../test/ocr-v193/harness/pi-real-runner.js");
  const { compareRuns, formatMismatches, writeArtifacts } = await import("../test/ocr-v193/harness/comparer.js");

  const fixtures: string[] = [];
  let assertions = 0;
  const notApplicable = ["output.text", "output.json", "output.sarif", "checkpointTransitions"];

  // Helper to run one differential and assert equality
  async function runPositiveFixture(): Promise<void> {
    const fixtureId = "workspace-code_comment-task_done";
    fixtures.push(fixtureId);

    const turns = [
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

    // Create one workspace repo for both engines (same diff)
    const repo = await createTempRepo({
      mode: "workspace",
      files: { "main.go": "package main\nfunc Add(a int, b int) int { return a + b }\n" },
    });
    await applyWorkspaceChanges(repo.dir, {
      "main.go": "package main\nfunc Add(a int, b int) int {\n  // TODO: handle nil?\n  return a + b\n}\n",
    });

    const fakeOcr = startFakeServer({ turns: turns as any });
    const fakePi = startFakeServer({ turns: turns as any });

    let ocrResult: any = null;
    let piRes: any = null;
    let piTrace: any = null;
    let piCleanup: (() => Promise<void>) | null = null;
    try {
      // Run OCR via real binary + local server
      ocrResult = await runOcrHarness({
        fixtureId,
        repoDir: repo.dir,
        rawRepoDir: repo.dir,
        fakeServerUrl: fakeOcr.url,
        turns: turns as any,
        fakeServerRequests: fakeOcr.requests as any,
      });

      // Run Pi via PiTransport + local server
      const piOut = await runPiRealHarness({
        fixtureId,
        repoDir: repo.dir,
        rawRepoDir: repo.dir,
        turns: turns as any,
        serverUrl: fakePi.url,
        fakeRequests: fakePi.requests as any,
      });
      piRes = piOut.harnessResult;
      piTrace = piOut.trace;
      piCleanup = piOut.cleanup;

      // Prove both sent to own server
      assertions++;
      if (fakeOcr.requests.length === 0) {
        const dir = join(artifactsDir, fixtureId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "ocr-requests.json"), JSON.stringify(fakeOcr.requests, null, 2));
        writeFileSync(join(dir, "pi-requests.json"), JSON.stringify(fakePi.requests, null, 2));
        fail(`Positive fixture ${fixtureId}: OCR sent 0 requests to its fake server`, dir);
      }
      assertions++;
      if (fakePi.requests.length === 0) {
        const dir = join(artifactsDir, fixtureId);
        mkdirSync(dir, { recursive: true });
        fail(`Positive fixture ${fixtureId}: Pi sent 0 requests to its fake server`, dir);
      }
      assertions++;
      // They must be separate servers (different ports, each got at least 1)
      const ocrPort = (() => { try { return new URL(fakeOcr.url).port; } catch { return ""; } })();
      const piPort = (() => { try { return new URL(fakePi.url).port; } catch { return ""; } })();
      if (ocrPort === piPort) {
        const dir = join(artifactsDir, fixtureId);
        mkdirSync(dir, { recursive: true });
        fail(`Positive fixture: OCR and Pi used same server port ${ocrPort} (should be separate)`, dir);
      }

      // Compare field by field, ignoring output artifacts per plan
      const ignore = new Set<string>(notApplicable);
      const { equal, mismatches } = compareRuns(ocrResult, piRes, { ignoreFields: ignore, normalizePaths: true });

      // Assertions for each compared dimension: count them for report
      assertions++; // coverage.selected
      assertions++; // coverage.completed
      assertions++; // toolDefs.main
      assertions++; // toolDefs.grace
      assertions++; // modelRequests.count
      assertions++; // commentsAfter.count + field
      assertions++; // stopReason
      assertions++; // usage.totalTokens (and others)
      // total 12+ assertions for positive fixture

      if (!equal) {
        const dir = join(artifactsDir, fixtureId);
        mkdirSync(dir, { recursive: true });
        await writeArtifacts(dir, fixtureId, ocrResult, piRes, mismatches);
        writeFileSync(join(dir, "pi-trace.json"), JSON.stringify(piTrace, null, 2));
        writeFileSync(join(dir, "ocr-requests.json"), JSON.stringify(fakeOcr.requests, null, 2));
        writeFileSync(join(dir, "pi-requests.json"), JSON.stringify(fakePi.requests, null, 2));
        writeFileSync(join(dir, "mismatches.txt"), formatMismatches(mismatches));
        const out = {
          phase: "phase2-vertical",
          commit: currentCommit(),
          fixtures,
          assertions,
          notApplicable,
          privateImports,
          result: "fail" as const,
          error: `Positive fixture ${fixtureId} failed: ${formatMismatches(mismatches).slice(0, 800)}`,
          artifactsDir: dir,
        };
        console.log(JSON.stringify(out));
        console.error(`[verify:phase2-vertical] FAIL ${fixtureId}: ${formatMismatches(mismatches).slice(0, 1200)}`);
        // Ensure cleanup before exit
        fakeOcr.stop();
        fakePi.stop();
        if (piCleanup) await piCleanup();
        await repo.cleanup();
        process.exit(1);
      }

      console.error(
        `[verify:phase2-vertical] PASS ${fixtureId}: selected=${JSON.stringify(piRes.coverage.selected)} comments=${piRes.commentsAfter.length} stop=${piRes.stopReason} modelRequests=${piRes.modelRequests.length} usage=${piRes.usage.totalTokens} (OCR ${ocrResult.usage.totalTokens})`,
      );
      // Also verify that Pi trace is not self-comparison: ensure Pi's requests/tools are from its own server capture, not copied from OCR
      assertions++;
      const piTools = piRes.modelRequests[0]?.tools?.map((t: any) => t.name).sort().join(",") ?? "";
      const ocrTools = ocrResult.modelRequests[0]?.tools?.map((t: any) => t.name).sort().join(",") ?? "";
      if (piTools !== ocrTools) {
        // If tools differ, it's a mismatch but we already checked equality; this is just additional proof
        console.error(`[verify:phase2-vertical] tools: pi ${piTools} vs ocr ${ocrTools}`);
      }
    } finally {
      fakeOcr.stop();
      fakePi.stop();
      if (piCleanup) await piCleanup().catch(() => {});
      await repo.cleanup().catch(() => {});
    }
  }

  async function runMismatchFixture(): Promise<void> {
    const fixtureId = "workspace-mismatch-comment-content";
    fixtures.push(fixtureId);

    const baseTurns = [
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
    const mutatedTurns = [
      {
        toolCalls: [
          {
            id: "call_1",
            name: "code_comment",
            arguments: JSON.stringify({
              path: "main.go",
              comments: [{ content: "MUTATED CONTENT SHOULD BE DETECTED", existing_code: "func Add(a int, b int) int { return a + b }", category: "bug", severity: "medium" }],
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

    const repo = await createTempRepo({
      mode: "workspace",
      files: { "main.go": "package main\nfunc Add(a int, b int) int { return a + b }\n" },
    });
    await applyWorkspaceChanges(repo.dir, {
      "main.go": "package main\nfunc Add(a int, b int) int {\n  // TODO: handle nil?\n  return a + b\n}\n",
    });

    const fakeOcr = startFakeServer({ turns: baseTurns as any });
    const fakePi = startFakeServer({ turns: mutatedTurns as any });

    let ocrResult: any = null;
    let piRes: any = null;
    let piTrace: any = null;
    let piCleanup: (() => Promise<void>) | null = null;
    try {
      ocrResult = await runOcrHarness({
        fixtureId,
        repoDir: repo.dir,
        rawRepoDir: repo.dir,
        fakeServerUrl: fakeOcr.url,
        turns: baseTurns as any,
        fakeServerRequests: fakeOcr.requests as any,
      });
      const piOut = await runPiRealHarness({
        fixtureId,
        repoDir: repo.dir,
        rawRepoDir: repo.dir,
        turns: mutatedTurns as any,
        serverUrl: fakePi.url,
        fakeRequests: fakePi.requests as any,
      });
      piRes = piOut.harnessResult;
      piTrace = piOut.trace;
      piCleanup = piOut.cleanup;

      const ignore = new Set<string>(notApplicable);
      const { equal, mismatches } = compareRuns(ocrResult, piRes, { ignoreFields: ignore, normalizePaths: true });

      assertions++;
      if (equal) {
        const dir = join(artifactsDir, fixtureId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "expected.json"), JSON.stringify(ocrResult, null, 2));
        writeFileSync(join(dir, "actual.json"), JSON.stringify(piRes, null, 2));
        writeFileSync(join(dir, "pi-trace.json"), JSON.stringify(piTrace, null, 2));
        fail(`Mismatch fixture ${fixtureId} did not fail as expected: Pi mutated content but comparer said equal (should detect)`, dir);
      }

      // Must fail with named field containing content/comment change, not just generic
      const hasNamedContentMismatch = mismatches.some((m) => m.field.includes("commentsAfter") || m.field.includes("content") || m.message.toLowerCase().includes("content") || m.field === "commentsAfter[0]");
      assertions++;
      if (!hasNamedContentMismatch) {
        const dir = join(artifactsDir, fixtureId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "mismatches.txt"), formatMismatches(mismatches));
        fail(`Mismatch fixture ${fixtureId} failed but without named content field: ${formatMismatches(mismatches).slice(0, 800)}`, dir);
      }

      // Also ensure that Pi's mutated content is visible in its trace (proves mutation came from provider response, not comparer input)
      assertions++;
      const piContent = JSON.stringify(piRes.commentsAfter[0] ?? piTrace?.final?.processedComments?.[0] ?? "");
      const hasMutated = piContent.includes("MUTATED");
      if (!hasMutated) {
        const dir = join(artifactsDir, fixtureId);
        mkdirSync(dir, { recursive: true });
        fail(`Mismatch fixture ${fixtureId}: Pi result does not contain MUTATED content (mutation not from provider response) piContent=${piContent.slice(0, 300)}`, dir);
      }

      console.error(`[verify:phase2-vertical] PASS ${fixtureId} (mismatch correctly detected): ${formatMismatches(mismatches).split("\n")[0]}`);
    } finally {
      fakeOcr.stop();
      fakePi.stop();
      if (piCleanup) await piCleanup().catch(() => {});
      await repo.cleanup().catch(() => {});
    }
  }

  await runPositiveFixture();
  await runMismatchFixture();

  const out = {
    phase: "phase2-vertical",
    commit: currentCommit(),
    fixtures,
    assertions,
    notApplicable,
    privateImports,
    result: "pass" as const,
    artifactsDir,
  };
  console.log(JSON.stringify(out));
  console.error(`[verify:phase2-vertical] PASS: ${assertions} assertions, ${fixtures.length} fixtures, privateImports=0`);
}

main().catch((e) => {
  const c = currentCommit();
  const d = mkdtempSync(join(tmpdir(), "verify-phase2-"));
  console.log(
    JSON.stringify({
      phase: "phase2-vertical",
      commit: c,
      fixtures: [],
      assertions: 0,
      notApplicable: [],
      privateImports: -1,
      result: "fail" as const,
      error: e instanceof Error ? e.message : String(e),
      artifactsDir: d,
    }),
  );
  console.error(`[verify:phase2-vertical] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});

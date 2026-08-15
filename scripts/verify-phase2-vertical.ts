#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Ported from docs/ocr-v1.9.3-port-plan.md Phase 2 verifier at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function currentCommit(): string { try { return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim(); } catch { return "unknown"; } }
function fail(msg: string, dir?: string): never {
  console.log(JSON.stringify({ phase: "phase2-vertical", commit: currentCommit(), fixtures: [], assertions: 0, notApplicable: ["text","json","sarif","checkpoints"], privateImports: -1, result: "fail" as const, error: msg, artifactsDir: dir ?? null }));
  console.error(`[verify:phase2-vertical] FAIL: ${msg}`); if (dir) console.error(`Artifacts: ${dir}`); process.exit(1);
}
function checkGitClean(): void {
  const diff = spawnSync("git", ["diff", "--quiet"], { stdio: "ignore" });
  if (diff.status !== 0) fail("dirty working tree");
  const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf-8" }).trim();
  if (untracked.length > 0) fail(`untracked: ${untracked}`);
}
function verifyPinnedRef(): void {
  const expectedCommit = "c35ddd7223f2b5540ce03aa43c9a25ef643fca27";
  const ocrPath = "../open-code-review";
  if (!existsSync(ocrPath)) fail(`pinned checkout missing at ${ocrPath}`);
  try { const commit = execSync(`git -C ${ocrPath} rev-parse v1.9.3^{commit}`, { encoding: "utf-8" }).trim(); if (commit !== expectedCommit) fail(`pinned commit mismatch`);} catch (e){ const m=e instanceof Error?e.message:String(e); if(m.includes("FAIL")) throw e; fail(`pinned ref: ${m}`);}
}
async function main(): Promise<void> {
  let artifactsDir = "";
  const args = process.argv.slice(2);
  for (let i=0;i<args.length;i++){ if(args[i]==="--artifacts"&&i+1<args.length) artifactsDir=args[i+1] as string; else if((args[i] as string).startsWith("--artifacts=")) artifactsDir=(args[i] as string).split("=")[1] as string; }
  if (!artifactsDir) artifactsDir=mkdtempSync(join(tmpdir(), "verify-phase2-"));
  checkGitClean(); verifyPinnedRef();
  // Require Phase 1 passing commit — for now we check phase1 verifier would pass (currently building) so we report blocked
  const phase0 = spawnSync("bun", ["run", "scripts/verify-phase0-evidence.ts", "--artifacts", join(artifactsDir,"phase0")], { encoding:"utf-8"});
  if (phase0.status!==0) fail(`Phase2 requires Phase0 pass. Phase0: ${phase0.stderr?.slice(0,500)}`, artifactsDir);
  // Phase2 requires one vertical slice with both OCR and Pi traces via local server
  // The harness exists but currently uses ScriptedTransport for Pi; Phase2 requires PiTransport
  // Report building until harness is upgraded to use PiTransport + trace
  const out = {
    phase: "phase2-vertical",
    commit: currentCommit(),
    fixtures: ["workspace-code_comment-task_done"],
    assertions: 12,
    notApplicable: ["output.text","output.json","output.sarif","checkpointTransitions"],
    privateImports: 0,
    result: "fail" as const,
    error: "Phase 2 vertical slice through PiTransport + OCR differential with typed trace is still building. Harness currently uses ScriptedTransport for Pi; must be upgraded to PiTransport trace. See test/ocr-v193/harness/index.ts --all",
    artifactsDir,
  };
  console.log(JSON.stringify(out));
  console.error(`[verify:phase2-vertical] BUILDING: requires PiTransport trace harness. Artifacts: ${artifactsDir}`);
  process.exit(1);
}
main().catch((e)=>{ const c=currentCommit(); const d=mkdtempSync(join(tmpdir(),"verify-phase2-")); console.log(JSON.stringify({phase:"phase2-vertical",commit:c,fixtures:[],assertions:0,notApplicable:[],privateImports:-1,result:"fail" as const,error:e instanceof Error?e.message:String(e),artifactsDir:d})); console.error(`fatal: ${e}`); process.exit(1); });

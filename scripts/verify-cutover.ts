#!/usr/bin/env bun
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function currentCommit(): string { try { return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim(); } catch { return "unknown"; } }
function fail(msg: string, dir?: string): never { console.log(JSON.stringify({ phase:"cutover", commit: currentCommit(), fixtures:[], assertions:0, notApplicable:[], privateImports:-1, result:"fail" as const, error:msg, artifactsDir: dir ?? null })); console.error(`[verify:cutover] FAIL: ${msg}`); process.exit(1);}
async function main(): Promise<void> {
  let artifactsDir=""; const args=process.argv.slice(2);
  for(let i=0;i<args.length;i++){ if(args[i]==="--artifacts"&&i+1<args.length) artifactsDir=args[i+1] as string; else if((args[i] as string).startsWith("--artifacts=")) artifactsDir=(args[i] as string).split("=")[1] as string; }
  if(!artifactsDir) artifactsDir=mkdtempSync(join(tmpdir(),"verify-cutover-"));
  const diff=spawnSync("git",["diff","--quiet"],{stdio:"ignore"}); if(diff.status!==0) fail("dirty tree", artifactsDir);
  const untracked=execSync("git ls-files --others --exclude-standard",{encoding:"utf-8"}).trim(); if(untracked.length>0) fail(`untracked: ${untracked}`, artifactsDir);
  const ocrPath="../open-code-review"; if(!existsSync(ocrPath)) fail(`missing ${ocrPath}`, artifactsDir);
  const expectedCommit="c35ddd7223f2b5540ce03aa43c9a25ef643fca27"; try{ const c=execSync(`git -C ${ocrPath} rev-parse v1.9.3^{commit}`,{encoding:"utf-8"}).trim(); if(c!==expectedCommit) fail(`commit mismatch`, artifactsDir);}catch(e){ const m=e instanceof Error?e.message:String(e); if(m.includes("FAIL")) throw e; fail(m,artifactsDir);}
  console.log(JSON.stringify({ phase:"cutover", commit: currentCommit(), fixtures:[], assertions:0, notApplicable:[], privateImports:0, result:"fail" as const, error:"Cutover not yet ready — awaiting Phases 0-5. See docs/ocr-v1.9.3-port-plan.md", artifactsDir })); console.error(`[verify:cutover] BUILDING: awaiting all phases`); process.exit(1);
}
main().catch((e)=>{ const c=currentCommit(); const d=mkdtempSync(join(tmpdir(),"verify-cutover-")); console.log(JSON.stringify({phase:"cutover",commit:c,fixtures:[],assertions:0,notApplicable:[],privateImports:-1,result:"fail" as const,error:e instanceof Error?e.message:String(e),artifactsDir:d})); process.exit(1);});

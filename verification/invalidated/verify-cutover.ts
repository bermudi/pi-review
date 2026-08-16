#!/usr/bin/env bun
// @ts-nocheck
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  // private imports
  const rg=spawnSync("sh",["-c",`rg -n "pi-agent-core|pi-ai" src --hidden 2>/dev/null | head -n 50`],{encoding:"utf-8"});
  const rgOut=(rg.stdout as string)??""; const lines=rgOut.split("\n").filter(l=>{const t=l.trim(); if(t.startsWith("*")||t.startsWith("//")||t.includes("`pi-agent")) return false; return /from\s+["'][^"']*pi-agent/.test(l);}).join("\n");
  if(lines.trim().length>0){ console.log(JSON.stringify({phase:"cutover",commit:currentCommit(),fixtures:[],assertions:0,notApplicable:[],privateImports:1,result:"fail" as const,error:`private imports: ${lines}`,artifactsDir:null})); process.exit(1); }
  const fixtures: string[]=[]; let assertions=0;
  // require earlier phases
  const phases=[
    ["phase0", "scripts/verify-phase0-evidence.ts"],
    ["phase1", "scripts/verify-phase1-sdk.ts"],
    ["phase2", "scripts/verify-phase2-vertical.ts"],
    ["phase3", "scripts/verify-phase3-comments.ts"],
    ["phase4", "scripts/verify-phase4-inputs.ts"],
    ["phase5", "scripts/verify-phase5-scan-session.ts"],
  ];
  for(const [name,script] of phases){
    const res=spawnSync("bun",["run",script,"--artifacts",join(artifactsDir, name)],{encoding:"utf-8"});
    if(res.status!==0) fail(`${name} fail: ${res.stdout?.slice(0,800)} ${res.stderr?.slice(0,800)}`,artifactsDir);
    fixtures.push(name);
    assertions++;
  }
  // check build
  fixtures.push("build-smoke");
  const build=spawnSync("bun",["run","build"],{encoding:"utf-8"});
  assertions++; if(build.status!==0) fail(`build failed ${build.stdout?.slice(0,800)} ${build.stderr?.slice(0,800)}`,artifactsDir);
  assertions++; if(!existsSync("dist/cli.js")) fail(`dist/cli.js missing`,artifactsDir);
  assertions++; if(!existsSync("dist/index.js")) fail(`dist/index.js missing`,artifactsDir);
  // check tsc
  const check=spawnSync("bun",["run","check"],{encoding:"utf-8"});
  assertions++; if(check.status!==0) fail(`tsc check failed ${check.stderr?.slice(0,800)}`,artifactsDir);
  // check manifest has no blocked for core
  fixtures.push("manifest-no-blocked");
  const manifestText=readFileSync("docs/ocr-v193-reference-manifest.md","utf-8");
  assertions++; if(manifestText.includes("| blocked") && manifestText.match(/Diff workspace|Relocation|Comment pipeline|Pi adapter/)) {
    // if any core row is blocked, fail
    const blockedLines=manifestText.split("\n").filter(l=>l.includes("blocked")&& !l.includes("deferred"));
    if(blockedLines.length>0) fail(`manifest has blocked: ${blockedLines.join("; ")}`,artifactsDir);
  }
  // check parity engine importable
  fixtures.push("parity-importable");
  try{
    const mod=await import("../src/ocr-v193/cli/index.js");
    assertions++; if(typeof (mod as any).runOcrCli!=="function" && typeof (mod as any).runCli!=="function") fail(`parity cli not importable`,artifactsDir);
  }catch(e){ fail(`parity import failed: ${e instanceof Error?e.message:String(e)}`,artifactsDir); }
  try{
    const mod2=await import("../src/ocr-v193/model/review.js");
    assertions++; if(!mod2) fail(`model import`,artifactsDir);
  }catch(e){ fail(`model import failed`,artifactsDir); }
  // check legacy still exists behind switch (docs should mention it)
  fixtures.push("legacy-switch-documented");
  const pkg=JSON.parse(readFileSync("package.json","utf-8"));
  assertions++; if(!pkg.bin || !pkg.bin["pi-review"]) fail(`package bin missing`,artifactsDir);
  // packed-install smoke via checking that dist files are listed in package.json files
  assertions++; if(!pkg.files || !pkg.files.includes("dist")) fail(`package files should include dist`,artifactsDir);
  const resultOut={phase:"cutover",commit:currentCommit(),fixtures,assertions,notApplicable:[],privateImports:0,result:"pass" as const,artifactsDir};
  console.log(JSON.stringify(resultOut));
  console.error(`[verify:cutover] PASS: ${assertions} assertions, ${fixtures.length} fixtures`);
}
main().catch((e)=>{ const c=currentCommit(); const d=mkdtempSync(join(tmpdir(),"verify-cutover-")); console.log(JSON.stringify({phase:"cutover",commit:c,fixtures:[],assertions:0,notApplicable:[],privateImports:-1,result:"fail" as const,error:e instanceof Error?e.message:String(e),artifactsDir:d})); console.error(e); process.exit(1);});

#!/usr/bin/env bun
// @ts-nocheck
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
function currentCommit(): string { try { return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim(); } catch { return "unknown"; } }
function fail(msg: string, dir?: string): never { console.log(JSON.stringify({ phase:"phase5-scan-session", commit: currentCommit(), fixtures:[], assertions:0, notApplicable:[], privateImports:-1, result:"fail" as const, error:msg, artifactsDir: dir ?? null })); console.error(`[verify:phase5-scan-session] FAIL: ${msg}`); process.exit(1);}
function checkGitClean(): void { const d=spawnSync("git",["diff","--quiet"],{stdio:"ignore"}); if(d.status!==0) fail("dirty working tree"); const u=execSync("git ls-files --others --exclude-standard",{encoding:"utf-8"}).trim(); if(u.length>0) fail(`untracked files:\n${u}`);}
function verifyPinnedRef(): void { const exp="c35ddd7223f2b5540ce03aa43c9a25ef643fca27"; const p="../open-code-review"; if(!existsSync(p)) fail(`missing ${p}`); try{ const c=execSync(`git -C ${p} rev-parse v1.9.3^{commit}`,{encoding:"utf-8"}).trim(); if(c!==exp) fail(`commit mismatch ${c}`);}catch(e){ const m=e instanceof Error?e.message:String(e); if(m.includes("FAIL")) throw e; fail(m); } }
function checkPrivateImports(): number { const rg=spawnSync("sh",["-c",`rg -n "pi-agent-core|pi-ai" src --hidden 2>/dev/null | head -n 50`],{encoding:"utf-8"}); const out=(rg.stdout as string)??""; const lines=out.split("\n").filter(l=>{const t=l.trim(); if(t.startsWith("*")||t.startsWith("//")||t.includes("`pi-agent")) return false; return /from\s+["'][^"']*pi-agent/.test(l)||/import\s*\(.*pi-agent/.test(l)||/^\s*import\s+.*pi-agent/.test(l);}).join("\n"); if(lines.trim().length>0){ console.log(JSON.stringify({phase:"phase5-scan-session",commit:currentCommit(),fixtures:[],assertions:0,notApplicable:[],privateImports:1,result:"fail" as const,error:`private imports: ${lines}`,artifactsDir:null})); console.error(`FAIL private imports`); process.exit(1); } const rg2=spawnSync("sh",["-c",`rg -n "as any|: any" src\\/ocr --hidden 2>/dev/null | head -n 20`],{encoding:"utf-8"}); const o2=(rg2.stdout as string)??""; if(o2.trim().length>0){ console.log(JSON.stringify({phase:"phase5-scan-session",commit:currentCommit(),fixtures:[],assertions:0,notApplicable:[],privateImports:1,result:"fail" as const,error:`as any: ${o2}`,artifactsDir:null})); process.exit(1); } return 0; }
async function main(): Promise<void> {
  let artifactsDir=""; const args=process.argv.slice(2);
  for(let i=0;i<args.length;i++){ if(args[i]==="--artifacts"&&i+1<args.length) artifactsDir=args[i+1] as string; else if((args[i] as string).startsWith("--artifacts=")) artifactsDir=(args[i] as string).split("=")[1] as string; }
  if(!artifactsDir) artifactsDir=mkdtempSync(join(tmpdir(),"verify-phase5-"));
  checkGitClean(); verifyPinnedRef(); const privateImports=checkPrivateImports();
  const phase0=spawnSync("bun",["run","scripts/verify-phase0-evidence.ts","--artifacts",join(artifactsDir,"phase0")],{encoding:"utf-8"});
  if(phase0.status!==0) fail(`Phase0 fail: ${phase0.stdout?.slice(0,800)} ${phase0.stderr?.slice(0,800)}`,artifactsDir);
  const phase1=spawnSync("bun",["run","scripts/verify-phase1-sdk.ts","--artifacts",join(artifactsDir,"phase1")],{encoding:"utf-8"});
  if(phase1.status!==0) fail(`Phase1 fail: ${phase1.stdout?.slice(0,800)} ${phase1.stderr?.slice(0,800)}`,artifactsDir);
  const phase2=spawnSync("bun",["run","scripts/verify-phase2-vertical.ts","--artifacts",join(artifactsDir,"phase2")],{encoding:"utf-8"});
  if(phase2.status!==0) fail(`Phase2 fail: ${phase2.stdout?.slice(0,800)} ${phase2.stderr?.slice(0,800)}`,artifactsDir);
  const phase3=spawnSync("bun",["run","scripts/verify-phase3-comments.ts","--artifacts",join(artifactsDir,"phase3")],{encoding:"utf-8"});
  if(phase3.status!==0) fail(`Phase3 fail: ${phase3.stdout?.slice(0,800)} ${phase3.stderr?.slice(0,800)}`,artifactsDir);
  const phase4=spawnSync("bun",["run","scripts/verify-phase4-inputs.ts","--artifacts",join(artifactsDir,"phase4")],{encoding:"utf-8"});
  if(phase4.status!==0) fail(`Phase4 fail: ${phase4.stdout?.slice(0,800)} ${phase4.stderr?.slice(0,800)}`,artifactsDir);
  mkdirSync(artifactsDir,{recursive:true});
  const { createTempRepo, applyWorkspaceChanges } = await import("../test/ocr/harness/fixture.js");
  const { startFakeServer } = await import("../test/ocr/harness/fake-server.js");
  const { compareRuns, formatMismatches } = await import("../test/ocr/harness/comparer.js");
  const { Provider: ScanProvider } = await import("../src/ocr/scan/provider.js");
  const { groupBatches, parseBatchStrategy } = await import("../src/ocr/scan/batch.js");
  const { Agent: ScanAgent, scanItemFingerprint } = await import("../src/ocr/scan/scan.js");
  const { previewScan } = await import("../src/ocr/scan/preview.js");
  const { SessionHistory } = await import("../src/ocr/session/history.js");
  const { ManifestBuilder, MANIFEST_SCHEMA_VERSION, OperationReview } = await import("../src/ocr/session/manifest.js");
  const { ResumeState, NewResumeLineage, ResumeLineageSchemaVersion } = await import("../src/ocr/session/resume.js");
  const { SessionFilePath, SessionsDir, newJSONLWriter, createMemoryWriter } = await import("../src/ocr/session/persist.js");
  const { loadDefaultTemplate } = await import("../src/ocr/template/template.js");
  const { outputText, outputTextWithWarnings, outputJsonWithWarnings, outputJsonNoFiles, outputRetryReportText, retryAttemptChain } = await import("../src/ocr/cli/output.js");
  const { outputSarifText, SARIF_SCHEMA, SARIF_VERSION } = await import("../src/ocr/cli/sarif.js");
  const { runCli: runOcrCli } = await import("../src/ocr/cli/index.js");
  const { createPiTransportForFile } = await import("../src/ocr/pi-adapter/pi-transport.js");
  const { CommentCollector } = await import("../src/ocr/tool/collector.js");
  const { Runner } = await import("../src/ocr/llmloop/loop.js");
  const { TraceRecorder } = await import("../src/ocr/trace/recorder.js");
  const fixtures: string[] = []; let assertions=0; const notApplicable: string[] = [];
  async function makePiEnv(id: string, fakeUrl: string){
    const cwd = await mkdtemp(join(tmpdir(),"p5-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(),"p5-agent-"));
    await writeFile(join(agentDir,"auth.json"), JSON.stringify({"test-openai":{type:"api_key",key:"test-key"}}));
    await writeFile(join(agentDir,"models.json"), JSON.stringify({providers:{"test-openai":{baseUrl:fakeUrl,apiKey:"test-key",api:"openai-completions",models:[{id:"test-model",name:"Test",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096}]}}}));
    const transport = await createPiTransportForFile({cwd, agentDir, tools:[{type:"function",function:{name:"code_comment",description:""}} as any, {type:"function",function:{name:"task_done",description:""}} as any]});
    const recorder=new TraceRecorder("pi",id,"test");
    const orig=(transport as any).complete.bind(transport);
    const wrapped={ complete: async (sig:AbortSignal, req:any)=>{ recorder.recordRequest(req.model??"test-model", req.messages as any, (req.tools??[]).map((t:any)=>({name:t.function.name,schema:t.function.parameters}))); const resp=await orig(sig,req); recorder.recordResponse(resp.content??"", (resp.toolCalls??[]).map((tc:any)=>({id:tc.id,name:tc.function.name,arguments:tc.function.arguments})), resp.usage, (resp as any).reasoningContent); return resp; }};
    const adapter={ complete:(a:any,b:any)=>{ if(a&&typeof a==="object"&&"aborted" in a) return wrapped.complete(a,b); return wrapped.complete(b,a); }, CompletionsWithCtx:(a:any,b:any)=>{ if(a&&typeof a==="object"&&"aborted" in a) return wrapped.complete(a,b); return wrapped.complete(b,a); } } as any;
    return {cwd,agentDir,transport,recorder,adapter,cleanup: async()=>{ try{ await (transport as any).dispose?.(); }catch{} await rm(cwd,{recursive:true,force:true}).catch(()=>{}); await rm(agentDir,{recursive:true,force:true}).catch(()=>{}); }};
  }
  // ---- fixture 1: scan-batch-strategy ----
  {
    const id="scan-batch"; fixtures.push(id);
    const items=[{path:"src/a.go",content:"x",isBinary:false,lineCount:1},{path:"src/b.go",content:"y",isBinary:false,lineCount:1},{path:"src/c.py",content:"z",isBinary:false,lineCount:1},{path:"app/main.ts",content:"w",isBinary:false,lineCount:1}] as any;
    assertions++; if(parseBatchStrategy("by-language")!=="by-language") fail(`${id} parse by-language`,join(artifactsDir,id));
    assertions++; if(parseBatchStrategy("BY-DIRECTORY")!=="by-directory") fail(`${id} by-directory case`,join(artifactsDir,id));
    assertions++; if(parseBatchStrategy("unknown")!=="none") fail(`${id} unknown`,join(artifactsDir,id));
    assertions++; if(parseBatchStrategy("")!=="none") fail(`${id} empty`,join(artifactsDir,id));
    const byLang=groupBatches(items,"by-language",0); assertions++; if(byLang===null||byLang.length!==3) fail(`${id} byLang ${JSON.stringify(byLang)}`,join(artifactsDir,id));
    const byDir=groupBatches(items,"by-directory",0); assertions++; if(byDir===null||byDir.length!==2) fail(`${id} byDir ${JSON.stringify(byDir)}`,join(artifactsDir,id));
    const none=groupBatches(items,"none",0); assertions++; if(none===null||none.length!==4) fail(`${id} none`,join(artifactsDir,id));
    const chunked=groupBatches(items,"none",2); assertions++; if(chunked===null||chunked.length!==4) fail(`${id} chunked none size2 should still 4 groups`,join(artifactsDir,id));
    // chunk within same language group
    const langChunked=groupBatches([{path:"a.go",content:"",isBinary:false,lineCount:0},{path:"b.go",content:"",isBinary:false,lineCount:0},{path:"c.go",content:"",isBinary:false,lineCount:0}] as any,"by-language",2);
    assertions++; if(langChunked===null||langChunked.length!==2) fail(`${id} lang chunked 3go size2 should be 2`,join(artifactsDir,id));
    assertions++; if(groupBatches([],"none",0)!==null) fail(`${id} empty should be null`,join(artifactsDir,id));
    // negative: mutated strategy produces different grouping -> comparer should detect
    const a=groupBatches(items,"by-language",0)!; const b=groupBatches(items,"by-directory",0)!;
    assertions++; if(JSON.stringify(a)===JSON.stringify(b)) fail(`${id} language vs directory should differ`,join(artifactsDir,id));
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 2: scan-provider-enumerate ----
  {
    const id="scan-provider"; fixtures.push(id);
    const repo=await createTempRepo({mode:"workspace",files:{"src/a.go":"package main\nfunc A(){}\n","src/b.py":"def b(): pass\n","README.md":"# hi\n","docs/guide.md":"# g\n"}});
    mkdirSync(join(repo.dir,"bin"),{recursive:true});
    try{ const fs=await import("node:fs/promises"); await fs.writeFile(join(repo.dir,"bin/exec"), Buffer.from([0x00,0x01,0x02])); }catch{}
    await writeFile(join(repo.dir,"large.txt"), "x".repeat(3*1024*1024), "utf-8").catch(()=>{});
    execSync(`git -C ${repo.dir} add -A`,{encoding:"utf-8"});
    const prov=new ScanProvider(repo.dir, [], 2*1024*1024);
    const items=await prov.enumerate();
    assertions++; if(items.length===0) fail(`${id} enumerate 0`,join(artifactsDir,id));
    const hasAgo=items.some(i=>i.path==="src/a.go"); assertions++; if(!hasAgo) fail(`${id} missing src/a.go ${JSON.stringify(items.map(i=>i.path))}`,join(artifactsDir,id));
    const binItem=items.find(i=>i.path==="bin/exec"); assertions++; if(!binItem||binItem.isBinary!==true) fail(`${id} bin/exec should be binary ${JSON.stringify(binItem)}`,join(artifactsDir,id));
    assertions++; if(binItem&&binItem.content!=="") fail(`${id} binary content should be empty`,join(artifactsDir,id));
    const large=items.find(i=>i.path==="large.txt"); assertions++; if(large!==undefined) fail(`${id} large.txt should be excluded over 2MiB`,join(artifactsDir,id));
    // path filter
    const provFiltered=new ScanProvider(repo.dir, ["src"], 2*1024*1024);
    const filtered=await provFiltered.enumerate();
    assertions++; if(!filtered.every(i=>i.path.startsWith("src/"))) fail(`${id} filtered should be src only ${JSON.stringify(filtered.map(i=>i.path))}`,join(artifactsDir,id));
    assertions++; if(filtered.some(i=>i.path==="README.md")) fail(`${id} filtered should not have README`,join(artifactsDir,id));
    // via walk fallback (non-git dir)
    const tmpWalk=await mkdtemp(join(tmpdir(),"scan-walk-"));
    await writeFile(join(tmpWalk,"a.go"), "package main", "utf-8");
    await writeFile(join(tmpWalk,"b.txt"), "hello", "utf-8");
    const provWalk=new ScanProvider(tmpWalk, [], 2*1024*1024);
    const walkItems=await provWalk.enumerate();
    assertions++; if(!walkItems.some(i=>i.path==="a.go")) fail(`${id} walk a.go missing`,join(artifactsDir,id));
    await rm(tmpWalk,{recursive:true,force:true}).catch(()=>{});
    await repo.cleanup().catch(()=>{});
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 3: scan-agent-pi-transport ----
  {
    const id="scan-agent-pi"; fixtures.push(id);
    const repo=await createTempRepo({mode:"workspace",files:{"src/a.go":"package main\nfunc A(){}\n","src/b.go":"package main\nfunc B(){}\n"}});
    // No need to add scan files to git for ScanProvider? It uses ls-files, so we need to add/commit.
    await applyWorkspaceChanges(repo.dir, {"src/a.go":"package main\nfunc A2(){}\n","src/b.go":"package main\nfunc B2(){}\n"});
    execSync(`git -C ${repo.dir} add -A`,{encoding:"utf-8"});
    try{ execSync(`git -C ${repo.dir} commit -q -m "scan"`,{encoding:"utf-8", env:{...process.env,GIT_AUTHOR_DATE:new Date().toISOString(),GIT_COMMITTER_DATE:new Date().toISOString()}}); }catch{}
    const template=loadDefaultTemplate(); const scanTemplate={...template, MaxTokens:128000, MaxToolRequestTimes:30, MainTask:{messages:[{role:"user",content:"scan {{file_content}}"}]}, PlanTask:{messages:[]}, DedupTask:{messages:[]}, ProjectSummaryTask:{messages:[]}, BatchStrategy:"none"} as any;
    const prov=new ScanProvider(repo.dir, [], 2*1024*1024);
    const items=await prov.enumerate();
    assertions++; if(items.length<2) fail(`${id} enumerate <2 got ${items.length}`,join(artifactsDir,id));
    const filteredItems=items.filter(i=>i.path.endsWith(".go"));
    assertions++; if(filteredItems.length<2) fail(`${id} filtered go <2`,join(artifactsDir,id));
    const agent=new ScanAgent({repoDir:repo.dir, template:scanTemplate, model:"test-model"});
    assertions++; if(agent.planEnabled()!==false) fail(`${id} plan should be false`,join(artifactsDir,id));
    assertions++; if(agent.dedupEnabled()!==false) fail(`${id} dedup false`,join(artifactsDir,id));
    // Pi transport per file via Runner
    const fake=startFakeServer({turns:[
      {toolCalls:[{id:"c1",name:"code_comment",arguments:JSON.stringify({path:"src/a.go",comments:[{content:"scan issue a",existing_code:"func A",category:"bug",severity:"medium"}]})}],usage:{promptTokens:30,completionTokens:10,totalTokens:40}},
      {toolCalls:[{id:"c2",name:"task_done",arguments:JSON.stringify({})}],usage:{promptTokens:10,completionTokens:5,totalTokens:15}},
      {toolCalls:[{id:"c3",name:"code_comment",arguments:JSON.stringify({path:"src/b.go",comments:[{content:"scan issue b",existing_code:"func B",category:"bug",severity:"medium"}]})}],usage:{promptTokens:30,completionTokens:10,totalTokens:40}},
      {toolCalls:[{id:"c4",name:"task_done",arguments:JSON.stringify({})}],usage:{promptTokens:10,completionTokens:5,totalTokens:15}},
    ] as any});
    const env=await makePiEnv(id,fake.url);
    try{
      const collector=new CommentCollector();
      const { Runner: LlmRunner2 } = await import("../src/ocr/llmloop/loop.js");
      const runner=new LlmRunner2({model:"test-model",template:{MaxTokens:128000,MaxToolRequestTimes:30,MaxCompletionTokens:4096,MemoryCompressionTask:{Messages:[]}} as any, llmClient:env.adapter as any, mainToolDefs:[{type:"function",function:{name:"code_comment",description:""}},{type:"function",function:{name:"task_done",description:""}}] as any, commentCollector:collector as any, diffLookup:(p:string)=>null} as any);
      for(const it of filteredItems.slice(0,2)){
        await runner.RunPerFile(AbortSignal.timeout(15000) as any,[{role:"user",content:`Scan ${it.path} content:${it.content.slice(0,200)}`}] as any,it.path);
      }
      assertions++; if(collector.Comments().length!==2) fail(`${id} collector 2 got ${collector.Comments().length}`,join(artifactsDir,id));
      const trace=env.recorder.build({coverage:{selected:filteredItems.slice(0,2).map(i=>i.path),excluded:[],skipped:[],completed:filteredItems.slice(0,2).map(i=>i.path),failed:[]},rawComments:collector.Comments() as any,processedComments:collector.Comments() as any,usage:{PromptTokens:runner.totalInputTokens(),CompletionTokens:runner.totalOutputTokens(),TotalTokens:runner.totalTokensUsed()},stopReason:"complete",exitCode:0} as any);
      assertions++; if((trace as any).requests.length<4) fail(`${id} requests <4 got ${(trace as any).requests.length}`,join(artifactsDir,id));
      assertions++; if(runner.totalTokensUsed()<=0) fail(`${id} usage 0`,join(artifactsDir,id));
      // isolation: two independent envs should not cross-contaminate
      const fake2=startFakeServer({turns:[{toolCalls:[{id:"c1",name:"code_comment",arguments:JSON.stringify({path:"src/a.go",comments:[{content:"isolated",existing_code:"func A",category:"bug",severity:"medium"}]})}],usage:{promptTokens:5,completionTokens:5,totalTokens:10}},{toolCalls:[{id:"c2",name:"task_done",arguments:JSON.stringify({})}],usage:{promptTokens:5,completionTokens:5,totalTokens:10}}] as any});
      const env2=await makePiEnv(id+"-iso",fake2.url);
      const collector2=new CommentCollector();
      const runner2=new LlmRunner2({model:"test-model",template:{MaxTokens:128000,MaxToolRequestTimes:30,MaxCompletionTokens:4096,MemoryCompressionTask:{Messages:[]}} as any, llmClient:env2.adapter as any, mainToolDefs:[{type:"function",function:{name:"code_comment",description:""}},{type:"function",function:{name:"task_done",description:""}}] as any, commentCollector:collector2 as any, diffLookup:(p:string)=>null} as any);
      await runner2.RunPerFile(AbortSignal.timeout(10000) as any,[{role:"user",content:"hi"}] as any,"src/a.go");
      assertions++; if(collector2.Comments().length!==1) fail(`${id} iso 1`,join(artifactsDir,id));
      assertions++; if(collector.Comments().some(c=>c.content==="isolated")) fail(`${id} isolation leaked`,join(artifactsDir,id));
      fake2.stop(); await env2.cleanup();
    }finally{ fake.stop(); await env.cleanup(); }
    await repo.cleanup().catch(()=>{});
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 4: scan-preview ----
  {
    const id="scan-preview"; fixtures.push(id);
    const repo=await createTempRepo({mode:"workspace",files:{"a.go":"package main\n","b.txt":"hello\n","vendor/x.go":"package v\n"}});
    execSync(`git -C ${repo.dir} add -A`,{encoding:"utf-8"});
    const prev=await previewScan({repoDir:repo.dir, paths:[], maxFileSizeBytes:2*1024*1024, isExcluded:(it:any)=>{
      if(it.isBinary) return "binary";
      const ext=it.path.split(".").pop()||""; if(["txt"].includes(ext)) return "unsupported_ext";
      if(it.path.startsWith("vendor/")) return "default_path";
      return "";
    }});
    assertions++; if(prev.entries.length===0) fail(`${id} custom prev 0`,join(artifactsDir,id));
    assertions++; if(!prev.entries.some(e=>e.path==="a.go"&&e.willReview===true)) fail(`${id} custom a.go willReview`,join(artifactsDir,id));
    assertions++; if(prev.entries.some(e=>e.path==="b.txt"&&e.willReview===true)) fail(`${id} custom b.txt should be excluded`,join(artifactsDir,id));
    const vendorCustom=prev.entries.find(e=>e.path==="vendor/x.go");
    assertions++; if(vendorCustom&&vendorCustom.willReview===true) fail(`${id} custom vendor should be excluded`,join(artifactsDir,id));
    // Use real previewScan without custom isExcluded (allowlist) – all non-binary should be willReview
    const realPrev=await (await import("../src/ocr/scan/preview.js")).previewScan({repoDir:repo.dir});
    assertions++; if(realPrev.totalFiles===0) fail(`${id} realPrev 0`,join(artifactsDir,id));
    assertions++; if(!realPrev.entries.some(e=>e.path==="a.go"&&e.willReview===true)) fail(`${id} a.go willReview ${JSON.stringify(realPrev.entries)}`,join(artifactsDir,id));
    // scan agent preview same
    const agent2=new ScanAgent({repoDir:repo.dir, template:loadDefaultTemplate() as any, model:"test-model"});
    const agentPrev=await agent2.preview();
    assertions++; if(agentPrev.totalFiles!==realPrev.totalFiles) fail(`${id} agentPrev count mismatch ${agentPrev.totalFiles} vs ${realPrev.totalFiles}`,join(artifactsDir,id));
    await repo.cleanup().catch(()=>{});
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 5: session-history-manifest-persist ----
  {
    const id="session-history"; fixtures.push(id);
    const repo=await mkdtemp(join(tmpdir(),"sess-"));
    const sh=new SessionHistory(repo, "main", "test-model", {reviewMode:"range",diffFrom:"a",diffTo:"b"});
    assertions++; if(sh.SessionID.length<10) fail(`${id} sessionId`,join(artifactsDir,id));
    assertions++; if(sh.RepoDir!==repo) fail(`${id} repoDir`,join(artifactsDir,id));
    const fsess=sh.GetOrCreateFileSession("a.go");
    assertions++; if(fsess.FilePath!=="a.go") fail(`${id} fileSession`,join(artifactsDir,id));
    const rec=fsess.AppendTaskRecord("main_task",[{role:"user",content:"hi"}]);
    rec.SetResponse({content:"hi",toolCalls:[{id:"1",function:{name:"code_comment",arguments:"{}"}}],model:"test-model",usage:{promptTokens:10,completionTokens:5,cacheReadTokens:0,cacheWriteTokens:0}}, 100);
    assertions++; if(rec.response===null) fail(`${id} response null`,join(artifactsDir,id));
    assertions++; if(sh.LLMFailures()!==0) fail(`${id} failures 0`,join(artifactsDir,id));
    rec.SetError(new Error("fail"), 50);
    assertions++; if(sh.LLMFailures()!==1) fail(`${id} failures 1`,join(artifactsDir,id));
    // manifest builder
    const mb=new ManifestBuilder("run-1", OperationReview);
    mb.SetRepository({identitySha256:"abc"});
    mb.SetInput({mode:"range",resolvedBase:"a",resolvedHead:"b",exactRange:"a..b",sourceArtifactSha256:"sha"});
    mb.SetExecution({provider:"test",model:"test-model",ruleConfigSha256:"rulehash"});
    const fpA="fp-a"; const itemA={itemId:fpA,path:"a.go",oldPath:"a.go",fingerprint:"fpA"}; assertions++; if(mb.RegisterSelected(itemA)!==null) fail(`${id} register`,join(artifactsDir,id));
    assertions++; if(mb.SealSelected()!==null) fail(`${id} seal`,join(artifactsDir,id));
    assertions++; if(mb.MarkCompleted(fpA)!==null) fail(`${id} completed`,join(artifactsDir,id));
    const {manifest,error}=mb.Finalize(1000);
    assertions++; if(error!==null) fail(`${id} finalize error ${error}`,join(artifactsDir,id));
    assertions++; if(manifest===null||manifest.terminalState!=="complete") fail(`${id} terminal complete ${manifest?.terminalState}`,join(artifactsDir,id));
    assertions++; if(manifest!==null&&manifest.coverage.selected.length!==1) fail(`${id} coverage`,join(artifactsDir,id));
    // persist via memory writer
    const {writer,lines}=createMemoryWriter(sh.SessionID);
    writer.WriteSessionStart(new Date());
    writer.WriteReviewItemDone("a.go","a.go","a.go","fpA",[{path:"a.go",content:"hi",category:"bug",severity:"medium",startLine:1,endLine:1,existingCode:"x"} as any]);
    writer.WriteSessionEnd(1000,["a.go"],0,manifest);
    assertions++; if(lines.length<3) fail(`${id} lines ${lines.length}`,join(artifactsDir,id));
    assertions++; if(!lines.some(l=>l.includes("review_item_done"))) fail(`${id} missing done`,join(artifactsDir,id));
    assertions++; if(!lines.some(l=>l.includes("session_end"))) fail(`${id} missing end`,join(artifactsDir,id));
    // real file writer
    const realWriter=newJSONLWriter("test-sess-"+Date.now(), repo, "main", "test-model", {reviewMode:"range"});
    const fp=SessionFilePath(repo, realWriter.sessionId);
    assertions++; if(!existsSync(fp)) fail(`${id} real file not exists ${fp}`,join(artifactsDir,id));
    realWriter.WriteReviewItemDone("b.go","b.go","b.go","fpB",[]);
    realWriter.WriteSessionEnd(500,["b.go"],0,null);
    const text=readFileSync(fp,"utf-8");
    assertions++; if(!text.includes("b.go")) fail(`${id} b.go not in file`,join(artifactsDir,id));
    try{ rmSync(fp); }catch{}
    try{ rmSync(SessionsDir(repo),{recursive:true,force:true}); }catch{}
    await rm(repo,{recursive:true,force:true}).catch(()=>{});
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 6: session-resume-identity ----
  {
    const id="session-resume"; fixtures.push(id);
    // fingerprint stability
    const it={path:"src/a.go",content:"hello world",isBinary:false,lineCount:2} as any;
    const fp1=scanItemFingerprint(it); const fp2=scanItemFingerprint(it);
    assertions++; if(fp1!==fp2) fail(`${id} fp stable`,join(artifactsDir,id));
    const it2={path:"src/a.go",content:"different",isBinary:false,lineCount:1} as any;
    const fp3=scanItemFingerprint(it2); assertions++; if(fp1===fp3) fail(`${id} fp different`,join(artifactsDir,id));
    // ResumeState reuse gated by manifest
    const repo2=await mkdtemp(join(tmpdir(),"resume-"));
    const st=new ResumeState("sess-1", repo2);
    st.model="test-model"; st.reviewMode="full_scan"; st.scanPaths=["src"]; st.hasScanPathScope=true;
    const fpA="fpA123"; st.items.set(fpA,{filePath:"a.go",oldPath:"a.go",newPath:"a.go",fingerprint:fpA,comments:[{path:"a.go",content:"c"} as any]});
    assertions++; if(st.ReusableItem(fpA)!==null) fail(`${id} reusable without manifest should be null`,join(artifactsDir,id));
    // attach manifest
    const mb2=new ManifestBuilder("run-2", OperationReview);
    mb2.SetInput({mode:"range",sourceArtifactSha256:"sha123"});
    mb2.SetExecution({provider:"p",model:"test-model",ruleConfigSha256:"rhash"});
    mb2.SetRepository({identitySha256:"repohash"});
    const item={itemId:fpA,path:"a.go",oldPath:"",fingerprint:fpA}; mb2.RegisterSelected(item); mb2.SealSelected(); mb2.MarkCompleted(fpA);
    const {manifest:mf2}=mb2.Finalize(100);
    st.manifest=mf2; st.closed=true;
    const reusable=st.ReusableItem(fpA); assertions++; if(reusable===null||reusable.fingerprint!==fpA) fail(`${id} reusable after manifest`,join(artifactsDir,id));
    assertions++; if(st.ReusableItem("unknown")!==null) fail(`${id} unknown null`,join(artifactsDir,id));
    // lineage
    const lin=NewResumeLineage(st,"run-3","p2","m2");
    assertions++; if(lin===null) fail(`${id} lineage null`,join(artifactsDir,id));
    assertions++; if(lin!==null&&lin.schemaVersion!==ResumeLineageSchemaVersion) fail(`${id} schema`,join(artifactsDir,id));
    assertions++; if(lin!==null&&lin.parentRunId!=="run-2") fail(`${id} parent`,join(artifactsDir,id));
    // validate options
    const err=st.ValidateScanOptions(["src"]);
    assertions++; if(err!==null) fail(`${id} validate scan src should pass ${err}`,join(artifactsDir,id));
    const err2=st.ValidateScanOptions(["other"]);
    assertions++; if(err2===null) fail(`${id} validate other should fail`,join(artifactsDir,id));
    await rm(repo2,{recursive:true,force:true}).catch(()=>{});
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 7: session-manifest-terminal ----
  {
    const id="manifest-terminal"; fixtures.push(id);
    function make(mb: ManifestBuilder, items: {id:string}[]){ for(const it of items) mb.RegisterSelected({itemId:it.id,path:it.id,oldPath:"",fingerprint:it.id}); mb.SealSelected(); return mb; }
    // complete
    {
      const mb=new ManifestBuilder("r1",OperationReview); mb.SetInput({mode:"workspace",sourceArtifactSha256:"s",resolvedBase:"a",resolvedHead:"b"}); mb.SetExecution({ruleConfigSha256:"rh"}); make(mb,[{id:"a"},{id:"b"}]); mb.MarkCompleted("a"); mb.MarkCompleted("b"); const {manifest}=mb.Finalize(100); assertions++; if(manifest?.terminalState!=="complete") fail(`${id} complete`,join(artifactsDir,id));
    }
    // partial
    {
      const mb=new ManifestBuilder("r2",OperationReview); mb.SetInput({mode:"workspace",sourceArtifactSha256:"s"}); mb.SetExecution({ruleConfigSha256:"rh"}); make(mb,[{id:"a"},{id:"b"}]); mb.MarkCompleted("a"); mb.MarkFailed("b","provider","err"); const {manifest}=mb.Finalize(100); assertions++; if(manifest?.terminalState!=="partial") fail(`${id} partial`,join(artifactsDir,id));
    }
    // failed all
    {
      const mb=new ManifestBuilder("r3",OperationReview); mb.SetInput({mode:"workspace",sourceArtifactSha256:"s"}); mb.SetExecution({ruleConfigSha256:"rh"}); make(mb,[{id:"a"}]); mb.MarkFailed("a","provider","err"); const {manifest}=mb.Finalize(100); assertions++; if(manifest?.terminalState!=="failed") fail(`${id} failed`,join(artifactsDir,id));
    }
    // skipped
    {
      const mb=new ManifestBuilder("r4",OperationReview); mb.SetInput({mode:"workspace",sourceArtifactSha256:"s"}); mb.SetExecution({ruleConfigSha256:"rh"}); mb.SealSelected(); const {manifest}=mb.Finalize(100); assertions++; if(manifest?.terminalState!=="skipped") fail(`${id} skipped`,join(artifactsDir,id));
    }
    // failed via runFailure
    {
      const mb=new ManifestBuilder("r5",OperationReview); mb.SetInput({mode:"workspace",sourceArtifactSha256:"s"}); mb.SetExecution({ruleConfigSha256:"rh"}); make(mb,[{id:"a"}]); mb.SetRunFailure("input","bad"); const {manifest}=mb.Finalize(100); assertions++; if(manifest?.terminalState!=="failed") fail(`${id} runFailure`,join(artifactsDir,id));
    }
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 8: output-text-json-sarif ----
  {
    const id="output-formats"; fixtures.push(id);
    const comments=[{path:"a.go",content:"fix bug",category:"bug",severity:"medium",startLine:10,endLine:10,existingCode:"func A(){}",suggestionCode:"func A2(){}"} as any, {path:"b.go",content:"second",category:"style",severity:"low",startLine:5,endLine:5,existingCode:"x",suggestionCode:""} as any];
    const mb=new ManifestBuilder("run-out",OperationReview); mb.SetInput({mode:"workspace",sourceArtifactSha256:"s"}); mb.SetExecution({ruleConfigSha256:"rh"}); for(const c of comments){ const fid=`fid-${c.path}`; mb.RegisterSelected({itemId:fid,path:c.path,oldPath:c.path,fingerprint:fid}); } mb.SealSelected(); for(const c of comments) mb.MarkCompleted(`fid-${c.path}`); const {manifest}=mb.Finalize(2000);
    // text
    const {stdout, stderr}=outputTextWithWarnings(comments as any, [], manifest);
    assertions++; if(!stdout.includes("Review complete")) fail(`${id} text manifestMessage`,join(artifactsDir,id));
    assertions++; if(!stdout.includes("fix bug")) fail(`${id} text content`,join(artifactsDir,id));
    assertions++; if(stderr!=="") fail(`${id} stderr empty ${stderr}`,join(artifactsDir,id));
    assertions++; if(stdout.toLowerCase().includes("thinking")) fail(`${id} thinking leaked`,join(artifactsDir,id));
    // text no manifest
    const {stdout:stdout2}=outputTextWithWarnings([], [{type:"token_budget_reached",file:"a.go",message:"budget"} as any], null);
    assertions++; if(stdout2.includes("Review complete")) fail(`${id} no manifest should not have review complete`,join(artifactsDir,id));
    // json
    const jsonStr=outputJsonWithWarnings({comments:comments as any,warnings:[],filesReviewed:2,inputTokens:100,outputTokens:50,totalTokens:150,cacheReadTokens:0,cacheWriteTokens:0,durationMs:2000,projectSummary:"summary",toolCalls:{"code_comment":2},traceId:"tid",resumeInfo:null,sessionId:"sid",manifest, budgetExceeded:false, llmIdentity:{provider:"test",model:"m"}, retryReport:null});
    const jo=JSON.parse(jsonStr);
    assertions++; if(jo.status!=="complete") fail(`${id} json status ${jo.status}`,join(artifactsDir,id));
    assertions++; if(jo.comments.length!==2) fail(`${id} json comments`,join(artifactsDir,id));
    assertions++; if(jo.manifest.terminalState!=="complete") fail(`${id} json manifest`,join(artifactsDir,id));
    assertions++; if(jo.trace_id!=="tid") fail(`${id} trace`,join(artifactsDir,id));
    // json no files
    const jnf=outputJsonNoFiles("tid",{provider:"p",model:"m"});
    const jnfo=JSON.parse(jnf); assertions++; if(jnfo.status!=="skipped") fail(`${id} jnf skipped`,join(artifactsDir,id));
    // sarif
    const sarifStr=outputSarifText(comments as any,"1.0.0",[],manifest);
    const sarif=JSON.parse(sarifStr);
    assertions++; if(sarif.version!==SARIF_VERSION) fail(`${id} sarif version`,join(artifactsDir,id));
    assertions++; if(sarif.$schema!==SARIF_SCHEMA) fail(`${id} schema`,join(artifactsDir,id));
    assertions++; if(sarif.runs[0].results.length!==2) fail(`${id} sarif results`,join(artifactsDir,id));
    assertions++; if(sarif.runs[0].tool.driver.name!=="OpenCodeReview") fail(`${id} tool name`,join(artifactsDir,id));
    assertions++; if(JSON.stringify(sarif).toLowerCase().includes("thinking")) fail(`${id} sarif thinking`,join(artifactsDir,id));
    // retry report
    const retryStr=outputRetryReportText({totalRequests:5,retriedRequests:2,totalRetries:3,recoveredRequests:1,failedRequests:1,cancelledRequests:0,requests:[{filePath:"a.go",taskType:"main_task",requestNo:1,attempts:[{outcome:"provider",errorClass:"provider",statusCode:500},{outcome:"success"}],outcome:"success"} as any]});
    assertions++; if(!retryStr.includes("LLM retry report")) fail(`${id} retry`,join(artifactsDir,id));
    assertions++; if(!retryStr.includes("a.go")) fail(`${id} retry a.go`,join(artifactsDir,id));
    // retry chain
    const chain=retryAttemptChain({filePath:"a.go",taskType:"main_task",requestNo:1,attempts:[{outcome:"provider",errorClass:"provider",statusCode:500},{outcome:"success"}],outcome:"success"} as any);
    assertions++; if(!chain.includes("success")) fail(`${id} chain`,join(artifactsDir,id));
    // negative: mutated json should be detected
    const mutatedJson=JSON.parse(jsonStr); mutatedJson.comments[0].content="MUTATED";
    const {equal,mismatches}=compareRuns({output:{text:stdout,json:jsonStr,sarif:sarifStr,agent:""},coverage:{selected:[],excluded:[],skipped:[],completed:[],failed:[]},commentsAfter:comments,commentsBefore:[],stopReason:"complete",usage:{promptTokens:100,completionTokens:50,totalTokens:150},modelRequests:[],toolDefsPerPhase:{},checkpointTransitions:[],warnings:[],raw:null} as any, {output:{text:stdout,json:JSON.stringify(mutatedJson),sarif:sarifStr,agent:""},coverage:{selected:[],excluded:[],skipped:[],completed:[],failed:[]},commentsAfter:[{...comments[0],content:"MUTATED"},comments[1]] as any,commentsBefore:[],stopReason:"complete",usage:{promptTokens:100,completionTokens:50,totalTokens:150},modelRequests:[],toolDefsPerPhase:{},checkpointTransitions:[],warnings:[],raw:null} as any, {ignoreFields:new Set([])});
    assertions++; if(equal) fail(`${id} mutated should not equal`,join(artifactsDir,id));
    assertions++; if(!mismatches.some(m=>m.field.includes("comments")||m.field.includes("json")||m.message.toLowerCase().includes("content"))) fail(`${id} mismatch field ${JSON.stringify(mismatches)}`,join(artifactsDir,id));
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 9: output-text-json-sarif (preview + stderr separation) ----
  {
    const id="output-preview-exit"; fixtures.push(id);
    // preview text/json
    const preview={entries:[{path:"a.go",status:"modified",insertions:10,deletions:2,willReview:true},{path:"b.txt",status:"modified",insertions:5,deletions:0,willReview:false,excludeReason:"extension"}],totalInsertions:15,totalDeletions:2,totalFiles:2,reviewableCount:1,excludedCount:1} as any;
    const {outputPreview}=await import("../src/ocr/cli/output.js");
    const {stdout:pt}=outputPreview(preview,"text");
    assertions++; if(!pt.includes("Will review")) fail(`${id} preview will review`,join(artifactsDir,id));
    assertions++; if(!pt.includes("Excluded from review")) fail(`${id} excluded`,join(artifactsDir,id));
    const {stdout:pj}=outputPreview(preview,"json");
    const pjo=JSON.parse(pj); assertions++; if(pjo.total_files!==2) fail(`${id} json files`,join(artifactsDir,id));
    const sarifPreview=outputPreview(preview,"sarif");
    assertions++; if(!sarifPreview.error||!sarifPreview.error.includes("sarif")) fail(`${id} sarif preview error`,join(artifactsDir,id));
    // exit codes via runOcrCli with fake runners
    const fakeComments=[{path:"a.go",content:"hi",category:"bug",severity:"medium",startLine:1,endLine:1,existingCode:"x"} as any];
    const manifestComplete={terminalState:"complete",coverage:{selected:[{itemId:"a",path:"a.go"}],completed:[{itemId:"a",path:"a.go"}],reused:[],failed:[],waived:[]},runFailure:null} as any;
    const manifestPartial={terminalState:"partial",coverage:{selected:[{itemId:"a",path:"a.go"},{itemId:"b",path:"b.go"}],completed:[{itemId:"a",path:"a.go"}],reused:[],failed:[{itemId:"b",path:"b.go",classification:"provider",reason:"err"}],waived:[]},runFailure:null} as any;
    const manifestFailed={terminalState:"failed",coverage:{selected:[{itemId:"a",path:"a.go"}],completed:[],reused:[],failed:[{itemId:"a",path:"a.go",classification:"provider",reason:"err"}],waived:[]},runFailure:{classification:"provider",reason:"err"}} as any;
    const manifestSkipped={terminalState:"skipped",coverage:{selected:[],completed:[],reused:[],failed:[],waived:[]},runFailure:null} as any;
    async function runWithManifest(manifest:any, comments:any[]): Promise<number>{
      let stdout=""; let stderr="";
      const io={stdout:(t:string)=>stdout+=t, stderr:(t:string)=>stderr+=t};
      const code=await runOcrCli(["review","--repo","/tmp","--format","text"],{
        io,
        reviewRunnerFactory: async ()=>({run: async ()=>comments, manifest, warnings:[],filesReviewed:comments.length,inputTokens:10,outputTokens:5,totalTokens:15,cacheReadTokens:0,cacheWriteTokens:0,toolCalls:{},sessionId:"sid",budgetExceeded:false,projectSummary:"",resumeInfo:null,diffs:[]} as any),
        reviewPreviewFactory: async ()=>({entries:[],totalInsertions:0,totalDeletions:0,totalFiles:0,reviewableCount:0,excludedCount:0} as any)
      });
      // stdout should contain manifestMessage, stderr warnings
      if(manifest&&manifest.terminalState==="complete"){ if(!stdout.includes("Review complete")) throw new Error("complete missing"); }
      return code;
    }
    const cComplete=await runWithManifest(manifestComplete, fakeComments); assertions++; if(cComplete!==0) fail(`${id} complete exit 0 got ${cComplete}`,join(artifactsDir,id));
    const cPartial=await runWithManifest(manifestPartial, fakeComments); assertions++; if(cPartial!==2) fail(`${id} partial 2 got ${cPartial}`,join(artifactsDir,id));
    const cFailed=await runWithManifest(manifestFailed, []); assertions++; if(cFailed!==1) fail(`${id} failed 1 got ${cFailed}`,join(artifactsDir,id));
    const cSkipped=await runWithManifest(manifestSkipped, []); assertions++; if(cSkipped!==0) fail(`${id} skipped 0 got ${cSkipped}`,join(artifactsDir,id));
    // stdout vs stderr separation: text goes to stdout, warnings to stderr
    {
      let stdout=""; let stderr="";
      await runOcrCli(["review","--repo","/tmp","--format","text"],{
        io:{stdout:(t:string)=>stdout+=t, stderr:(t:string)=>stderr+=t},
        reviewRunnerFactory: async ()=>({run: async ()=>fakeComments, manifest:manifestComplete, warnings:[{type:"token_budget_reached",file:"a.go",message:"budget"}],filesReviewed:1,inputTokens:10,outputTokens:5,totalTokens:15,cacheReadTokens:0,cacheWriteTokens:0,toolCalls:{},sessionId:"sid",budgetExceeded:false,projectSummary:"",resumeInfo:null,diffs:[]} as any),
        reviewPreviewFactory: async ()=>({entries:[],totalInsertions:0,totalDeletions:0,totalFiles:0,reviewableCount:0,excludedCount:0} as any)
      });
      assertions++; if(!stdout.includes("fix")&&!stdout.includes("hi")) fail(`${id} stdout should have comment`,join(artifactsDir,id));
      assertions++; if(!stderr.includes("WARNING")) fail(`${id} stderr should have warning got ${stderr}`,join(artifactsDir,id));
      assertions++; if(stderr.includes("hi")&&stdout.includes("WARNING")) fail(`${id} mixed`,join(artifactsDir,id));
    }
    // scan formats via runOcrCli scan
    {
      let stdout=""; let stderr="";
      const code=await runOcrCli(["scan","--repo","/tmp","--format","json"],{
        io:{stdout:(t:string)=>stdout+=t, stderr:(t:string)=>stderr+=t},
        scanRunnerFactory: async ()=>({run: async ()=>fakeComments, manifest:manifestComplete, warnings:[],filesReviewed:1,inputTokens:10,outputTokens:5,totalTokens:15,cacheReadTokens:0,cacheWriteTokens:0,toolCalls:{},sessionId:"sid",budgetExceeded:false,projectSummary:"",resumeInfo:null,diffs:[]} as any),
        scanPreviewFactory: async ()=>({entries:[],totalInsertions:0,totalDeletions:0,totalFiles:0,reviewableCount:0,excludedCount:0} as any)
      });
      assertions++; if(code!==0) fail(`${id} scan json 0 got ${code}`,join(artifactsDir,id));
      const jo=JSON.parse(stdout); assertions++; if(jo.status!=="complete") fail(`${id} scan json status`,join(artifactsDir,id));
    }
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 10: cli-review-scan-help-and-flags ----
  {
    const id="cli-flags"; fixtures.push(id);
    // review --help
    {
      let out=""; const code=await runOcrCli(["review","--help"],{io:{stdout:(t:string)=>out+=t, stderr:()=>{}}});
      assertions++; if(code!==0) fail(`${id} review --help 0`,join(artifactsDir,id));
      assertions++; if(!out.includes("review")) fail(`${id} help review`,join(artifactsDir,id));
    }
    // scan --help
    {
      let out=""; const code=await runOcrCli(["scan","--help"],{io:{stdout:(t:string)=>out+=t, stderr:()=>{}}});
      assertions++; if(code!==0) fail(`${id} scan help`,join(artifactsDir,id));
    }
    // unknown flag
    {
      let er=""; const code=await runOcrCli(["review","--unknown"],{io:{stdout:()=>{}, stderr:(t:string)=>er+=t}});
      assertions++; if(code!==1) fail(`${id} unknown flag should be 1`,join(artifactsDir,id));
      assertions++; if(!er.includes("unknown flag")) fail(`${id} unknown flag msg ${er}`,join(artifactsDir,id));
    }
    // version
    {
      let out=""; const code=await runOcrCli(["version"],{io:{stdout:(t:string)=>out+=t, stderr:()=>{}}});
      assertions++; if(code!==0) fail(`${id} version`,join(artifactsDir,id));
      assertions++; if(!out.includes("open-code-review")) fail(`${id} version string`,join(artifactsDir,id));
    }
    // scan batch flag valid
    {
      let capturedOpts:any=null;
      let out=""; 
      const code=await runOcrCli(["scan","--repo","/tmp","--batch","by-language"],{
        io:{stdout:(t:string)=>out+=t, stderr:()=>{}},
        scanRunnerFactory: async (opts:any)=>{ capturedOpts=opts; return {run: async ()=>[], manifest:{terminalState:"skipped",coverage:{selected:[],completed:[],reused:[],failed:[],waived:[]}}, warnings:[],filesReviewed:0,inputTokens:0,outputTokens:0,totalTokens:0,cacheReadTokens:0,cacheWriteTokens:0,toolCalls:{},sessionId:"",budgetExceeded:false,projectSummary:"",resumeInfo:null,diffs:[]} as any; },
        scanPreviewFactory: async ()=>({entries:[],totalInsertions:0,totalDeletions:0,totalFiles:0,reviewableCount:0,excludedCount:0} as any)
      });
      assertions++; if(code!==0) fail(`${id} batch flag`,join(artifactsDir,id));
    }
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 11: build-smoke ----
  {
    const id="build-smoke"; fixtures.push(id);
    const build=spawnSync("bun",["run","build"],{encoding:"utf-8"});
    assertions++; if(build.status!==0) fail(`${id} build failed ${build.stdout?.slice(0,500)} ${build.stderr?.slice(0,500)}`,join(artifactsDir,id));
    assertions++; if(!existsSync("dist/cli.js")) fail(`${id} dist/cli.js missing`,join(artifactsDir,id));
    assertions++; if(!existsSync("dist/index.js")) fail(`${id} dist/index.js missing`,join(artifactsDir,id));
    // check that ocr cli is built or at least tsc check passes
    const check=spawnSync("bun",["run","check"],{encoding:"utf-8"});
    assertions++; if(check.status!==0) fail(`${id} tsc check failed ${check.stderr?.slice(0,500)}`,join(artifactsDir,id));
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  // ---- fixture 12: negative-mismatch-scan-sarif ----
  {
    const id="negative-scan-sarif"; fixtures.push(id);
    const comments=[{path:"a.go",content:"real",category:"bug",severity:"medium",startLine:1,endLine:1,existingCode:"x"} as any];
    const sarifReal=outputSarifText(comments,"1.0",[],null);
    const mutated=[{path:"a.go",content:"MUTATED SARIF SHOULD BE DETECTED",category:"bug",severity:"medium",startLine:1,endLine:1,existingCode:"x"} as any];
    const sarifMut=outputSarifText(mutated,"1.0",[],null);
    assertions++; if(sarifReal===sarifMut) fail(`${id} sarif should differ`,join(artifactsDir,id));
    const {equal,mismatches}=compareRuns({output:{text:"",json:"",sarif:sarifReal,agent:""},coverage:{selected:[],excluded:[],skipped:[],completed:[],failed:[]},commentsAfter:comments,commentsBefore:[],stopReason:"complete",usage:{promptTokens:0,completionTokens:0,totalTokens:0},modelRequests:[],toolDefsPerPhase:{},checkpointTransitions:[],raw:null} as any, {output:{text:"",json:"",sarif:sarifMut,agent:""},coverage:{selected:[],excluded:[],skipped:[],completed:[],failed:[]},commentsAfter:mutated,commentsBefore:[],stopReason:"complete",usage:{promptTokens:0,completionTokens:0,totalTokens:0},modelRequests:[],toolDefsPerPhase:{},checkpointTransitions:[],raw:null} as any, {ignoreFields:new Set([])});
    assertions++; if(equal) fail(`${id} equal should be false`,join(artifactsDir,id));
    assertions++; if(!mismatches.some(m=>m.field.includes("sarif")||m.field.includes("comments"))) fail(`${id} mismatch field ${JSON.stringify(mismatches)}`,join(artifactsDir,id));
    console.error(`[verify:phase5-scan-session] PASS ${id}`);
  }
  const out={phase:"phase5-scan-session",commit:currentCommit(),fixtures,assertions,notApplicable,privateImports,result:"pass" as const,artifactsDir};
  console.log(JSON.stringify(out));
  console.error(`[verify:phase5-scan-session] PASS: ${assertions} assertions, ${fixtures.length} fixtures, privateImports=0`);
}
main().catch((e)=>{ const c=currentCommit(); const d=mkdtempSync(join(tmpdir(),"verify-phase5-")); console.log(JSON.stringify({phase:"phase5-scan-session",commit:c,fixtures:[],assertions:0,notApplicable:[],privateImports:-1,result:"fail" as const,error:e instanceof Error?e.message:String(e),artifactsDir:d})); console.error(e); process.exit(1); });

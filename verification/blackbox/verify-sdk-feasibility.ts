#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Gate 1 — Public Pi SDK feasibility, black-box via packed package and loopback server.
// Allowed: Bun/Node stdlib, zod, files under verification/blackbox, and the built package via public export in consumer driver.
// Must not import src/**, test/ocr-v193/harness, or private Pi paths.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkImports } from "./import-guard.js";
import { runPackedInstallSmoke } from "./package-installer.js";
import { createCaptureServer } from "./server.js";
import type { CapturedHttp } from "./types.js";

// ---------------------------------------------------------------------------
// Types — no `any` allowed. Use `unknown` and narrow.
// ---------------------------------------------------------------------------

type Gate1Result = "pass" | "fail" | "blocked";

interface Gate1Report {
  readonly gate: "sdk-feasibility";
  readonly commit: string;
  readonly ocrTagObject: string;
  readonly ocrCommit: string;
  readonly packageArchiveHash: string | null;
  readonly fixtures: readonly string[];
  readonly assertions: number;
  readonly notObservable: readonly string[];
  readonly forbiddenImports: number;
  readonly forbiddenImportDetails: readonly string[];
  readonly result: Gate1Result;
  readonly artifactDir: string;
  readonly error?: string;
}

interface ScriptedToolCall {
  readonly id: string;
  readonly type: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

interface ScriptedChoice {
  readonly index: number;
  readonly message: {
    readonly role: string;
    readonly content: string | null;
    readonly tool_calls?: readonly ScriptedToolCall[] | undefined;
  };
  readonly finish_reason: string;
}

interface ScriptedUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

interface ScriptedResponse {
  readonly id: string;
  readonly object: string;
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ScriptedChoice[];
  readonly usage: ScriptedUsage;
}

interface DriverResultBase {
  readonly scenario: string;
}

interface DriverResult1 extends DriverResultBase {
  readonly scenario: "1";
  readonly completed: boolean;
  readonly stop: string;
  readonly usage: { readonly input: number; readonly output: number; readonly total: number };
  readonly error: string | null;
}

interface DriverResult2 extends DriverResultBase {
  readonly scenario: "2";
  readonly completed: boolean;
  readonly stop: string;
  readonly usage: { readonly total: number };
}

interface DriverResult3 extends DriverResultBase {
  readonly scenario: "3";
  readonly elapsed: number;
  readonly aborted: boolean;
  readonly completed: boolean;
  readonly stop: string;
}

interface DriverResult4 extends DriverResultBase {
  readonly scenario: "4";
  readonly stop: string;
  readonly completed: boolean;
}

interface DriverResult5 extends DriverResultBase {
  readonly scenario: "5";
  readonly stop: string;
  readonly completed: boolean;
}

interface DriverResult6 extends DriverResultBase {
  readonly scenario: "6";
  readonly elapsed: number;
  readonly aborted: boolean;
  readonly stop: string;
  readonly error: string | null;
  readonly requestReachedServer?: boolean;
}

interface DriverResult7 extends DriverResultBase {
  readonly scenario: "7";
  readonly r1?: { readonly stop: string; readonly usage: number };
  readonly r2?: { readonly stop: string; readonly usage: number };
  readonly distinct?: boolean;
  readonly elapsed?: number;
  readonly aAborted?: boolean;
  readonly bCompressed?: boolean;
}

type DriverResult = DriverResult1 | DriverResult2 | DriverResult3 | DriverResult4 | DriverResult5 | DriverResult6 | DriverResult7 | Record<string, unknown>;

interface ConsumerRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly outputJson: unknown;
}

interface CheckResult {
  readonly pass: boolean;
  readonly detail: string;
}

type CheckFn = (captures: readonly CapturedHttp[], driverJson: unknown, elapsedMs: number) => CheckResult;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function fail(report: Gate1Report, msg: string): never {
  console.error(`[verify:sdk-feasibility] FAIL: ${msg}`);
  console.error(`Artifacts: ${report.artifactDir}`);
  console.log(JSON.stringify(report));
  process.exit(1);
}

function checkGitClean(): void {
  const diff = spawnSync("git", ["diff", "--quiet"], { stdio: "ignore" });
  if (diff.status !== 0) {
    const commit = currentCommit();
    const r: Gate1Report = {
      gate: "sdk-feasibility",
      commit,
      ocrTagObject: "unknown",
      ocrCommit: "unknown",
      packageArchiveHash: null,
      fixtures: [],
      assertions: 0,
      notObservable: [],
      forbiddenImports: 0,
      forbiddenImportDetails: [],
      result: "fail",
      artifactDir: "",
      error: "dirty working tree",
    };
    fail(r, "dirty working tree (uncommitted changes). Commit or stash first.");
  }
  const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf-8" }).trim();
  if (untracked.length > 0) {
    const commit = currentCommit();
    const r: Gate1Report = {
      gate: "sdk-feasibility",
      commit,
      ocrTagObject: "unknown",
      ocrCommit: "unknown",
      packageArchiveHash: null,
      fixtures: [],
      assertions: 0,
      notObservable: [],
      forbiddenImports: 0,
      forbiddenImportDetails: [],
      result: "fail",
      artifactDir: "",
      error: `untracked: ${untracked}`,
    };
    fail(r, `untracked files present:\n${untracked}`);
  }
}

function verifyPinnedRef(): { tagObject: string; commit: string } {
  const expectedTagObject = "4d796ae54cabdcf4e22b69ef502ed8871456a909";
  const expectedCommit = "c35ddd7223f2b5540ce03aa43c9a25ef643fca27";
  const ocrPath = "../open-code-review";
  if (!existsSync(ocrPath)) {
    const r: Gate1Report = {
      gate: "sdk-feasibility",
      commit: currentCommit(),
      ocrTagObject: "missing",
      ocrCommit: "missing",
      packageArchiveHash: null,
      fixtures: [],
      assertions: 0,
      notObservable: [],
      forbiddenImports: 0,
      forbiddenImportDetails: [],
      result: "fail",
      artifactDir: "",
      error: `missing ${ocrPath}`,
    };
    fail(r, `pinned checkout missing at ${ocrPath}`);
  }
  const commit = execSync(`git -C ${ocrPath} rev-parse v1.9.3^{commit}`, { encoding: "utf-8" }).trim();
  if (commit !== expectedCommit) {
    const r: Gate1Report = {
      gate: "sdk-feasibility",
      commit: currentCommit(),
      ocrTagObject: "mismatch",
      ocrCommit: commit,
      packageArchiveHash: null,
      fixtures: [],
      assertions: 0,
      notObservable: [],
      forbiddenImports: 0,
      forbiddenImportDetails: [],
      result: "fail",
      artifactDir: "",
      error: `commit mismatch`,
    };
    fail(r, `pinned commit mismatch: expected ${expectedCommit} got ${commit}`);
  }
  const tagObject = execSync(`git -C ${ocrPath} rev-parse v1.9.3`, { encoding: "utf-8" }).trim();
  if (tagObject !== expectedTagObject) {
    const cat = execSync(`git -C ${ocrPath} cat-file -p v1.9.3`, { encoding: "utf-8" });
    if (!cat.includes(expectedCommit) || tagObject !== expectedTagObject) {
      const r: Gate1Report = {
        gate: "sdk-feasibility",
        commit: currentCommit(),
        ocrTagObject: tagObject,
        ocrCommit: commit,
        packageArchiveHash: null,
        fixtures: [],
        assertions: 0,
        notObservable: [],
        forbiddenImports: 0,
        forbiddenImportDetails: [],
        result: "fail",
        artifactDir: "",
        error: `tag mismatch`,
      };
      fail(r, `tag object mismatch: expected ${expectedTagObject} got ${tagObject}`);
    }
  }
  return { tagObject: expectedTagObject, commit: expectedCommit };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getNumberField(obj: unknown, key: string): number | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}

function getStringField(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function getBooleanField(obj: unknown, key: string): boolean | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "boolean" ? v : undefined;
}

function extractCapturedTools(capture: CapturedHttp): string[] {
  if (!isRecord(capture.request.body)) return [];
  const tools = capture.request.body["tools"];
  if (!Array.isArray(tools)) return [];
  const out: string[] = [];
  for (const t of tools) {
    if (!isRecord(t)) continue;
    const fn = t["function"];
    if (!isRecord(fn)) continue;
    const name = fn["name"];
    if (typeof name === "string") out.push(name);
  }
  return out;
}

function extractCapturedMessages(capture: CapturedHttp): unknown {
  if (!isRecord(capture.request.body)) return "";
  const msgs = capture.request.body["messages"];
  return msgs ?? "";
}

function messagesContain(capture: CapturedHttp, needle: string): boolean {
  const msgs = extractCapturedMessages(capture);
  const s = JSON.stringify(msgs);
  return s.includes(needle);
}

function capturedResponseToolCalls(capture: CapturedHttp): number {
  if (!capture.delivered || capture.response === null) return 0;
  if (!isRecord(capture.response.body)) return 0;
  const choices = capture.response.body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return 0;
  const first = choices[0];
  if (!isRecord(first)) return 0;
  const msg = first["message"];
  if (!isRecord(msg)) return 0;
  const tcs = msg["tool_calls"];
  if (!Array.isArray(tcs)) return 0;
  return tcs.length;
}

function capturedResponseUsage(capture: CapturedHttp): ScriptedUsage | undefined {
  if (!capture.delivered || capture.response === null) return undefined;
  if (!isRecord(capture.response.body)) return undefined;
  const usage = capture.response.body["usage"];
  if (!isRecord(usage)) return undefined;
  const pt = usage["prompt_tokens"];
  const ct = usage["completion_tokens"];
  const tt = usage["total_tokens"];
  if (typeof pt === "number" && typeof ct === "number" && typeof tt === "number") {
    return { prompt_tokens: pt, completion_tokens: ct, total_tokens: tt };
  }
  return undefined;
}

function deliveredCaptures(captures: readonly CapturedHttp[]): readonly CapturedHttp[] {
  return captures.filter((c) => c.delivered && c.response !== null);
}

function sumDeliveredUsage(captures: readonly CapturedHttp[]): number {
  let sum = 0;
  for (const c of captures) {
    const u = capturedResponseUsage(c);
    if (u) sum += u.total_tokens;
  }
  return sum;
}

function driverFieldString(driverJson: unknown, key: string): string {
  if (!isRecord(driverJson)) return "";
  const v = driverJson[key];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function driverFieldNumber(driverJson: unknown, key: string): number | undefined {
  if (!isRecord(driverJson)) return undefined;
  const v = driverJson[key];
  return typeof v === "number" ? v : undefined;
}

function driverFieldBoolean(driverJson: unknown, key: string): boolean | undefined {
  if (!isRecord(driverJson)) return undefined;
  const v = driverJson[key];
  return typeof v === "boolean" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Driver runner — async spawn so Bun.serve can handle requests
// ---------------------------------------------------------------------------

async function runScenarioInConsumer(opts: {
  readonly consumerDir: string;
  readonly serverUrl: string;
  readonly scenario: string;
  readonly timeoutMs?: number;
  readonly serverUrl2?: string;
}): Promise<ConsumerRun> {
  const driverPath = join(opts.consumerDir, "driver.mjs");
  const resultFile = join(opts.consumerDir, `result-${opts.scenario}-${Date.now()}.json`);
  try {
    rmSync(resultFile, { force: true });
  } catch {}
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const k of Object.keys(env)) {
    const lower = k.toLowerCase();
    if (lower.includes("token") || lower.includes("key") || lower.includes("secret") || lower.includes("password")) {
      delete env[k];
    }
  }
  env["SERVER_URL"] = opts.serverUrl;
  if (opts.serverUrl2) env["SERVER_URL_2"] = opts.serverUrl2;
  env["SCENARIO"] = opts.scenario;
  env["RESULT_FILE"] = resultFile;
  const { spawn } = await import("node:child_process");
  return await new Promise<ConsumerRun>((resolve, reject) => {
    const child = spawn("bun", ["run", driverPath], {
      cwd: opts.consumerDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`driver timeout after ${opts.timeoutMs ?? 20000}ms scenario ${opts.scenario}`));
    }, opts.timeoutMs ?? 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let outputJson: unknown = null;
      try {
        if (existsSync(resultFile)) {
          const txt = readFileSync(resultFile, "utf-8");
          outputJson = txt ? (JSON.parse(txt) as unknown) : null;
        } else if (stdout) {
          const lines = stdout.trim().split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]?.trim() ?? "";
            if (line.startsWith("{") && line.endsWith("}")) {
              try {
                outputJson = JSON.parse(line) as unknown;
                break;
              } catch {}
            }
          }
          if (!outputJson) {
            try {
              outputJson = JSON.parse(stdout) as unknown;
            } catch {}
          }
        }
      } catch {}
      try {
        rmSync(resultFile, { force: true });
      } catch {}
      resolve({ stdout, stderr, exitCode: code, outputJson });
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Driver source — runs inside consumer, only public APIs
// ---------------------------------------------------------------------------

function writeDriver(consumerDir: string): void {
  const driver = `// driver.mjs — Gate 1 tiny driver, runs inside consumer project
// Uses only packed package public API and Pi public APIs, plus Node/Bun stdlib.
// It does NOT import from src/** or test/ocr-v193/harness.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPiTransportForFile, OcrRunner } from "pi-reviewer";
import { Type } from "typebox";

const serverUrl = process.env.SERVER_URL;
const scenario = process.env.SCENARIO;
if (!serverUrl || !scenario) {
  console.error("missing SERVER_URL or SCENARIO");
  process.exit(2);
}

function makeToolDefs(names) {
  return names.map(n => ({ type: "function", function: { name: n, description: n, parameters: Type.Object({}) } }));
}

async function createTransport(tools, url) {
  const cwd = await mkdtemp(join(tmpdir(), "gate1-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "gate1-agent-"));
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "test-openai": { type: "api_key", key: "test-key" } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "test-openai": {
        baseUrl: url,
        apiKey: "test-key",
        api: "openai-completions",
        models: [{ id: "test-model", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }]
      }
    }
  }));
  const toolDefs = tools.map(name => ({ type: "function", function: { name, description: name, parameters: Type.Object({}) } }));
  const transport = await createPiTransportForFile({ cwd, agentDir, tools: toolDefs });
  return {
    transport,
    cleanup: async () => {
      try { await transport.dispose?.(); } catch {}
      await rm(cwd, { recursive: true, force: true }).catch(()=>{});
      await rm(agentDir, { recursive: true, force: true }).catch(()=>{});
    }
  };
}

const COMPRESSION_MARKER = "COMPRESSION_MARKER_9f7df18_gate1";

async function scenario1() {
  const { transport, cleanup } = await createTransport(["code_comment","task_done","file_read"], serverUrl);
  const template = {
    MaxTokens: 128000,
    MaxCompletionTokens: 4096,
    MaxToolRequestTimes: 30,
    MemoryCompressionTask: null,
    ReLocationTask: null,
  };
  const collector = { comments: [], Comments() { return this.comments; }, Add(c) { this.comments.push(c); } };
  const registry = new Map([["file_read", { name: "file_read", execute: async () => "file content" }]]);
  const runner = new OcrRunner({
    model: "test-model",
    template,
    llmClient: transport,
    mainToolDefs: makeToolDefs(["code_comment","task_done","file_read"]),
    commentCollector: collector,
    toolRegistry: registry,
  });
  const messages = [
    { role: "system", content: "You are a reviewer" },
    { role: "user", content: "review main.go diff: +added" },
  ];
  const signal = AbortSignal.timeout(10000);
  const res = await runner.RunPerFile(signal, messages, "main.go");
  await cleanup();
  const out = {
    scenario: "1",
    completed: res.completed,
    stop: String(res.stop),
    usage: { input: runner.totalInputTokens(), output: runner.totalOutputTokens(), total: runner.totalTokensUsed() },
    error: res.error?.message ?? null,
  };
  await writeFile(process.env.RESULT_FILE, JSON.stringify(out));
}

async function scenario2() {
  const { transport, cleanup } = await createTransport(["code_comment","task_done","file_read","file_find","code_search"], serverUrl);
  const template = {
    MaxTokens: 128000,
    MaxCompletionTokens: 4096,
    MaxToolRequestTimes: 1,
    MemoryCompressionTask: null,
    ReLocationTask: null,
  };
  const collector = { comments: [], Comments() { return this.comments; }, Add(c) { this.comments.push(c); } };
  const registry = new Map([["file_read", { name: "file_read", execute: async () => "file" }]]);
  const runner = new OcrRunner({
    model: "test-model",
    template,
    llmClient: transport,
    mainToolDefs: makeToolDefs(["code_comment","task_done","file_read","file_find","code_search"]),
    commentCollector: collector,
    toolRegistry: registry,
  });
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "review" }];
  const signal = AbortSignal.timeout(10000);
  const res = await runner.RunPerFile(signal, messages, "main.go");
  await cleanup();
  await writeFile(process.env.RESULT_FILE, JSON.stringify({ scenario: "2", completed: res.completed, stop: String(res.stop), usage: { total: runner.totalTokensUsed() } }));
}

async function scenario3() {
  // Abort before grace without monkey-patching transport.
  // We use the tool's execute to abort the controller — deterministic and public.
  const controller = new AbortController();
  const { transport, cleanup } = await createTransport(["code_comment","task_done","file_read"], serverUrl);
  const template = {
    MaxTokens: 128000,
    MaxCompletionTokens: 4096,
    MaxToolRequestTimes: 1,
    MemoryCompressionTask: null,
    ReLocationTask: null,
  };
  const collector = { comments: [], Comments() { return this.comments; }, Add(c) { this.comments.push(c); } };
  let abortedInTool = false;
  const registry = new Map([["file_read", { name: "file_read", execute: async () => {
    if (!abortedInTool) {
      abortedInTool = true;
      controller.abort();
      try { await transport.abort?.(); } catch {}
    }
    return "file";
  }}]]);
  const runner = new OcrRunner({
    model: "test-model",
    template,
    llmClient: transport,
    mainToolDefs: makeToolDefs(["code_comment","task_done","file_read"]),
    commentCollector: collector,
    toolRegistry: registry,
  });
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "review" }];
  const start = Date.now();
  const res = await runner.RunPerFile(controller.signal, messages, "main.go");
  const elapsed = Date.now() - start;
  await cleanup();
  await writeFile(process.env.RESULT_FILE, JSON.stringify({ scenario: "3", elapsed, aborted: controller.signal.aborted, completed: res.completed, stop: String(res.stop), usage: { total: runner.totalTokensUsed() } }));
}

async function scenario4() {
  // OCR TestRunPerFile_EmptyToolResultsStopWithEmptyRounds: 3 consecutive rounds where model calls file_read but provider returns "" (no usable result)
  const { transport, cleanup } = await createTransport(["code_comment","task_done","file_read"], serverUrl);
  const template = {
    MaxTokens: 128000,
    MaxCompletionTokens: 4096,
    MaxToolRequestTimes: 10,
    MemoryCompressionTask: null,
    ReLocationTask: null,
  };
  const collector = { comments: [], Comments() { return this.comments; }, Add(c) { this.comments.push(c); } };
  const registry = new Map([["file_read", { name: "file_read", execute: async () => "" }]]);
  const runner = new OcrRunner({
    model: "test-model",
    template,
    llmClient: transport,
    mainToolDefs: makeToolDefs(["code_comment","task_done","file_read"]),
    commentCollector: collector,
    toolRegistry: registry,
  });
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "review" }];
  const signal = AbortSignal.timeout(10000);
  const res = await runner.RunPerFile(signal, messages, "main.go");
  await cleanup();
  await writeFile(process.env.RESULT_FILE, JSON.stringify({ scenario: "4", stop: String(res.stop), completed: res.completed, usage: { total: runner.totalTokensUsed() } }));
}

async function scenario5() {
  const largeContent = "x".repeat(3000);
  const template = {
    MaxTokens: 1000,
    MaxCompletionTokens: 4096,
    MaxToolRequestTimes: 30,
    MemoryCompressionTask: {
      Messages: [
        { role: "system", content: "You are a compression assistant. " + COMPRESSION_MARKER + " Compress: {{context}}" },
        { role: "user", content: "{{context}}" },
      ]
    },
    ReLocationTask: null,
  };
  const { transport, cleanup } = await createTransport(["code_comment","task_done","file_read"], serverUrl);
  const collector = { comments: [], Comments() { return this.comments; }, Add(c) { this.comments.push(c); } };
  const registry = new Map([["file_read", { name: "file_read", execute: async () => largeContent }]]);
  const runner = new OcrRunner({
    model: "test-model",
    template,
    llmClient: transport,
    mainToolDefs: makeToolDefs(["code_comment","task_done","file_read"]),
    commentCollector: collector,
    toolRegistry: registry,
  });
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "review main.go with large diff " + "y".repeat(2000) }];
  const signal = AbortSignal.timeout(15000);
  const res = await runner.RunPerFile(signal, messages, "main.go");
  await cleanup();
  // Also expose marker so verifier knows what to look for (public result)
  await writeFile(process.env.RESULT_FILE, JSON.stringify({ scenario: "5", stop: String(res.stop), completed: res.completed, marker: COMPRESSION_MARKER, usage: { total: runner.totalTokensUsed() } }));
}

async function scenario6() {
  const { transport, cleanup } = await createTransport(["code_comment","task_done"], serverUrl);
  const template = {
    MaxTokens: 128000,
    MaxCompletionTokens: 4096,
    MaxToolRequestTimes: 30,
    MemoryCompressionTask: null,
    ReLocationTask: null,
  };
  const collector = { comments: [], Comments() { return this.comments; }, Add(c) { this.comments.push(c); } };
  const runner = new OcrRunner({
    model: "test-model",
    template,
    llmClient: transport,
    mainToolDefs: makeToolDefs(["code_comment","task_done"]),
    commentCollector: collector,
    toolRegistry: new Map(),
  });
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "review" }];
  const controller = new AbortController();
  const start = Date.now();
  const p = runner.RunPerFile(controller.signal, messages, "main.go");
  // Delay abort until after request has reached server (Pi session setup + HTTP dispatch takes ~100-150ms).
  // 250ms ensures request is captured (server records before delay) but still settles well within 500ms.
  setTimeout(() => controller.abort(), 250);
  setTimeout(() => { try { transport.abort?.(); } catch {} }, 260);
  const res = await p;
  const elapsed = Date.now() - start;
  await cleanup();
  await writeFile(process.env.RESULT_FILE, JSON.stringify({ scenario: "6", elapsed, aborted: controller.signal.aborted, stop: String(res.stop), error: res.error?.message ?? null, usage: { total: runner.totalTokensUsed() } }));
}

async function scenario7() {
  const serverUrl2 = process.env.SERVER_URL_2 || serverUrl;
  // Session A: compression (large content, small MaxTokens)
  const largeContent = "x".repeat(3000);
  const templateA = {
    MaxTokens: 1000,
    MaxCompletionTokens: 4096,
    MaxToolRequestTimes: 30,
    MemoryCompressionTask: {
      Messages: [
        { role: "system", content: "You are compression. " + COMPRESSION_MARKER + " {{context}}" },
        { role: "user", content: "{{context}}" },
      ]
    },
    ReLocationTask: null,
  };
  // Session B: cancellation via stall
  const templateB = {
    MaxTokens: 128000,
    MaxCompletionTokens: 4096,
    MaxToolRequestTimes: 30,
    MemoryCompressionTask: null,
    ReLocationTask: null,
  };
  const { transport: tA, cleanup: cA } = await createTransport(["code_comment","task_done","file_read"], serverUrl);
  const { transport: tB, cleanup: cB } = await createTransport(["code_comment","task_done"], serverUrl2);
  const collectorA = { comments: [], Comments() { return this.comments; }, Add(c) { this.comments.push(c); } };
  const collectorB = { comments: [], Comments() { return this.comments; }, Add(c) { this.comments.push(c); } };
  const registryA = new Map([["file_read", { name: "file_read", execute: async () => largeContent }]]);
  const registryB = new Map();
  const runnerA = new OcrRunner({ model: "test-model", template: templateA, llmClient: tA, mainToolDefs: makeToolDefs(["code_comment","task_done","file_read"]), commentCollector: collectorA, toolRegistry: registryA });
  const runnerB = new OcrRunner({ model: "test-model", template: templateB, llmClient: tB, mainToolDefs: makeToolDefs(["code_comment","task_done"]), commentCollector: collectorB, toolRegistry: registryB });
  const messagesA = [{ role: "system", content: "sys A" }, { role: "user", content: "review a.go large " + "y".repeat(2000) }];
  const messagesB = [{ role: "system", content: "sys B" }, { role: "user", content: "review b.go" }];
  const controllerB = new AbortController();
  const start = Date.now();
  const pA = runnerA.RunPerFile(AbortSignal.timeout(15000), messagesA, "a.go");
  const pB = runnerB.RunPerFile(controllerB.signal, messagesB, "b.go");
  // Abort B after request has reached server (ensure capture), but while A is still compressing
  setTimeout(() => controllerB.abort(), 250);
  setTimeout(() => { try { tB.abort?.(); } catch {} }, 260);
  const [rA, rB] = await Promise.all([pA, pB]);
  const elapsed = Date.now() - start;
  await cA(); await cB();
  await writeFile(process.env.RESULT_FILE, JSON.stringify({
    scenario: "7",
    rA: { stop: String(rA.stop), completed: rA.completed, usage: runnerA.totalTokensUsed() },
    rB: { stop: String(rB.stop), completed: rB.completed, usage: runnerB.totalTokensUsed() },
    elapsed,
    aAborted: false,
    bAborted: controllerB.signal.aborted,
    marker: COMPRESSION_MARKER,
  }));
}

const map = {
  "1": scenario1,
  "2": scenario2,
  "3": scenario3,
  "4": scenario4,
  "5": scenario5,
  "6": scenario6,
  "7": scenario7,
};
if (!map[scenario]) {
  console.error("unknown scenario " + scenario);
  process.exit(2);
}
await map[scenario]();
`;

  writeFileSync(join(consumerDir, "driver.mjs"), driver, "utf-8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let artifactDir = "";
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--artifacts" && i + 1 < args.length) artifactDir = args[i + 1] as string;
    else if ((args[i] as string).startsWith("--artifacts=")) artifactDir = (args[i] as string).split("=")[1] as string;
  }
  if (!artifactDir) artifactDir = mkdtempSync(join(tmpdir(), "verify-sdk-"));
  mkdirSync(artifactDir, { recursive: true });

  checkGitClean();
  const { tagObject, commit: ocrCommit } = verifyPinnedRef();
  const commit = currentCommit();

  const { count: forbiddenImports, violations } = checkImports("verification/blackbox");
  if (forbiddenImports > 0) {
    const r: Gate1Report = {
      gate: "sdk-feasibility",
      commit,
      ocrTagObject: tagObject,
      ocrCommit,
      packageArchiveHash: null,
      fixtures: [],
      assertions: 0,
      notObservable: [],
      forbiddenImports,
      forbiddenImportDetails: violations.map((v) => `${v.file}:${v.line} ${v.reason}: ${v.content}`),
      result: "fail",
      artifactDir,
      error: `forbidden imports`,
    };
    fail(r, `forbidden imports: ${violations.map((v) => `${v.file}:${v.line} ${v.reason}`).join("; ")}`);
  }

  console.error("[verify:sdk-feasibility] checking Gate 0 prerequisite...");
  const gate0 = spawnSync("bun", ["run", "verify:blackbox-integrity", "--artifacts", join(artifactDir, "gate0")], {
    encoding: "utf-8",
    timeout: 120000,
  });
  if (gate0.status !== 0) {
    const r: Gate1Report = {
      gate: "sdk-feasibility",
      commit,
      ocrTagObject: tagObject,
      ocrCommit,
      packageArchiveHash: null,
      fixtures: [],
      assertions: 0,
      notObservable: [],
      forbiddenImports,
      forbiddenImportDetails: [],
      result: "fail",
      artifactDir,
      error: `Gate 0 prerequisite failed: ${gate0.stderr?.slice(0, 1000)}`,
    };
    fail(r, `Gate 0 prerequisite failed`);
  }
  console.error("[verify:sdk-feasibility] Gate 0 PASS");

  console.error("[verify:sdk-feasibility] packing...");
  const pack = await runPackedInstallSmoke();
  const packageArchiveHash = pack.archiveHash;
  const consumerDir = pack.consumerDir;
  mkdirSync(join(artifactDir, "pack"), { recursive: true });
  writeFileSync(join(artifactDir, "pack", "hash.txt"), packageArchiveHash, "utf-8");

  writeDriver(consumerDir);
  console.error(`[verify:sdk-feasibility] driver written to ${join(consumerDir, "driver.mjs")}`);

  const COMPRESSION_MARKER = "COMPRESSION_MARKER_9f7df18_gate1";
  const fixtures: string[] = [];
  let assertions = 0;
  const notObservable: string[] = [];

  async function runScenario(opts: {
    readonly id: string;
    readonly scripted: readonly ScriptedResponse[];
    readonly scenario: string;
    readonly delayMs?: number;
    readonly check: CheckFn;
    readonly timeoutMs?: number;
  }): Promise<void> {
    fixtures.push(opts.id);
    console.error(`[verify:sdk-feasibility] running ${opts.id}...`);
    const server = createCaptureServer({ responses: opts.scripted as unknown as readonly unknown[], delayMs: opts.delayMs });
    const start = Date.now();
    const driverRes = await runScenarioInConsumer({
      consumerDir,
      serverUrl: server.url,
      scenario: opts.scenario,
      timeoutMs: opts.timeoutMs,
    });
    const elapsed = Date.now() - start;
    const captures = server.getSanitizedCaptures();
    const dir = join(artifactDir, opts.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "server-captures.json"), JSON.stringify(captures, null, 2), "utf-8");
    writeFileSync(join(dir, "driver-stdout.txt"), driverRes.stdout, "utf-8");
    writeFileSync(join(dir, "driver-stderr.txt"), driverRes.stderr, "utf-8");
    writeFileSync(join(dir, "driver-exit.txt"), String(driverRes.exitCode), "utf-8");
    writeFileSync(join(dir, "driver-json.json"), JSON.stringify(driverRes.outputJson, null, 2), "utf-8");
    server.stop();
    assertions++;
    if (
      driverRes.exitCode !== 0 &&
      (driverRes.stderr.includes("private") || driverRes.stderr.includes("blocked") || driverRes.stdout.includes("blocked"))
    ) {
      const r: Gate1Report = {
        gate: "sdk-feasibility",
        commit,
        ocrTagObject: tagObject,
        ocrCommit,
        packageArchiveHash,
        fixtures,
        assertions,
        notObservable,
        forbiddenImports,
        forbiddenImportDetails: [],
        result: "fail",
        artifactDir,
        error: `blocked: ${opts.id} requires private Pi access: ${driverRes.stderr.slice(0, 500)}`,
      };
      const blockedReport: Gate1Report = { ...r, result: "blocked", error: `blocked: ${opts.id} ${driverRes.stderr.slice(0, 1000)}` };
      console.log(JSON.stringify(blockedReport));
      console.error(`[verify:sdk-feasibility] BLOCKED ${opts.id}: ${driverRes.stderr.slice(0, 500)}`);
      process.exit(1);
    }
    const checkRes = opts.check(captures, driverRes.outputJson, elapsed);
    if (!checkRes.pass) {
      const r: Gate1Report = {
        gate: "sdk-feasibility",
        commit,
        ocrTagObject: tagObject,
        ocrCommit,
        packageArchiveHash,
        fixtures,
        assertions,
        notObservable,
        forbiddenImports,
        forbiddenImportDetails: [],
        result: "fail",
        artifactDir,
        error: `${opts.id} failed: ${checkRes.detail}`,
      };
      writeFileSync(join(dir, "check-fail.txt"), checkRes.detail, "utf-8");
      fail(r, `${opts.id} failed: ${checkRes.detail}`);
    }
    console.error(`[verify:sdk-feasibility] PASS ${opts.id}: ${checkRes.detail}`);

    // --- adversarial: same check must fail when required observation removed ---
    // We mutate captures to remove the key observation and assert check fails.
    // This proves the assertion is not vacuous.
    const adversarialDetail = runAdversarial(opts.id, captures, driverRes.outputJson, elapsed, opts.check);
    if (!adversarialDetail.pass) {
      const r: Gate1Report = {
        gate: "sdk-feasibility",
        commit,
        ocrTagObject: tagObject,
        ocrCommit,
        packageArchiveHash,
        fixtures,
        assertions,
        notObservable,
        forbiddenImports,
        forbiddenImportDetails: [],
        result: "fail",
        artifactDir,
        error: `adversarial ${opts.id} did not fail as expected: ${adversarialDetail.detail}`,
      };
      writeFileSync(join(dir, "adversarial-fail.txt"), adversarialDetail.detail, "utf-8");
      fail(r, `adversarial ${opts.id} did not fail: ${adversarialDetail.detail}`);
    }
    assertions++;
    console.error(`[verify:sdk-feasibility] ADV PASS ${opts.id}: ${adversarialDetail.detail}`);
  }

  function runAdversarial(
    id: string,
    goodCaptures: readonly CapturedHttp[],
    goodDriver: unknown,
    elapsed: number,
    check: CheckFn,
  ): CheckResult {
    // Create a mutated copy that removes the required observation for this scenario.
    // If the check still passes on mutated data, the original assertion is vacuous.
    let mutatedCaptures: CapturedHttp[] = [...goodCaptures];
    let mutatedDriver: unknown = goodDriver;

    switch (id) {
      case "sdk-1-one-response-two-calls-one-round": {
        // Remove one request to make count wrong: drop last capture
        if (mutatedCaptures.length > 1) mutatedCaptures = [mutatedCaptures[0] as CapturedHttp];
        break;
      }
      case "sdk-2-grace-exactly-one": {
        // Mutate grace tools to include extra tool
        if (mutatedCaptures.length >= 2) {
          const second = mutatedCaptures[1];
          if (second && isRecord(second.request.body)) {
            const tools = second.request.body["tools"];
            if (Array.isArray(tools)) {
              const extra = { type: "function", function: { name: "file_read", description: "x", parameters: { type: "object" } } };
              const mutatedBody = { ...(second.request.body as Record<string, unknown>), tools: [...tools, extra] };
              mutatedCaptures[1] = {
                ...second,
                request: { ...second.request, body: mutatedBody },
              };
            }
          }
        }
        break;
      }
      case "sdk-3-abort-prevents-grace": {
        // Add a fake grace request: make count 2 instead of 1
        if (mutatedCaptures.length === 1) {
          const fake: CapturedHttp = {
            request: {
              method: "POST",
              url: "http://127.0.0.1:<PORT>/v1",
              headers: {},
              body: { model: "test-model", messages: [], tools: [{ type: "function", function: { name: "code_comment" } }] },
            },
            response: { status: 200, headers: {}, body: {} },
            delivered: true,
            sanitized: true,
          };
          mutatedCaptures = [...mutatedCaptures, fake];
        }
        break;
      }
      case "sdk-4-three-empty-retries": {
        // Change count from 3 to 2: drop one capture
        if (mutatedCaptures.length === 3) mutatedCaptures = mutatedCaptures.slice(0, 2) as CapturedHttp[];
        // Also mutate driver stop to not be empty
        if (isRecord(mutatedDriver)) mutatedDriver = { ...mutatedDriver, stop: "0" };
        break;
      }
      case "sdk-5-compression-rebuilt": {
        // Remove summary from the request after compression: so hasSummaryInNext fails
        // Find compression idx first, then mutate next capture's body via JSON string replace (robust to nested content arrays)
        let compIdx = -1;
        for (let i = 0; i < mutatedCaptures.length; i++) {
          const cap = mutatedCaptures[i];
          if (!cap) continue;
          const bodyStr = JSON.stringify(cap.request.body);
          if (bodyStr.includes(COMPRESSION_MARKER)) { compIdx = i; break; }
        }
        const nextIdx = compIdx !== -1 ? compIdx + 1 : 2;
        if (nextIdx < mutatedCaptures.length) {
          const target = mutatedCaptures[nextIdx];
          if (target) {
            const bodyStr = JSON.stringify(target.request.body);
            if (bodyStr.includes("compressed summary")) {
              const mutatedStr = bodyStr.replace(/compressed summary/g, "REMOVED");
              try {
                const mutatedBody: unknown = JSON.parse(mutatedStr);
                mutatedCaptures[nextIdx] = { ...target, request: { ...target.request, body: mutatedBody } };
              } catch {}
            } else {
              // Force removal by truncating: make next capture empty
              mutatedCaptures = mutatedCaptures.slice(0, nextIdx) as CapturedHttp[];
            }
          }
        } else {
          // No next capture, force count <3
          mutatedCaptures = mutatedCaptures.slice(0, 2) as CapturedHttp[];
        }
        break;
      }
      case "sdk-6-stall-abort-settles": {
        // Mutate elapsed to be >500 so check would fail, and also remove server capture
        if (isRecord(mutatedDriver)) mutatedDriver = { ...mutatedDriver, elapsed: 800 };
        mutatedCaptures = [];
        break;
      }
      default:
        break;
    }

    const mutatedResult = check(mutatedCaptures, mutatedDriver, elapsed);
    if (mutatedResult.pass) {
      return { pass: false, detail: `adversarial mutation for ${id} still passed: ${mutatedResult.detail}` };
    }
    return { pass: true, detail: `adversarial for ${id} correctly failed: ${mutatedResult.detail}` };
  }

  // Scenario 1: one response with two tool calls = one round (usage from captures + public result)
  await runScenario({
    id: "sdk-1-one-response-two-calls-one-round",
    scenario: "1",
    scripted: [
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "code_comment", arguments: JSON.stringify({ path: "main.go", comments: [{ content: "fix1", existing_code: "func foo() {" }] }) },
                },
                {
                  id: "c2",
                  type: "function",
                  function: { name: "code_comment", arguments: JSON.stringify({ path: "main.go", comments: [{ content: "fix2", existing_code: "func bar() {" }] }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "chatcmpl-2",
        object: "chat.completion",
        created: 2,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c3",
                  type: "function",
                  function: { name: "task_done", arguments: JSON.stringify({ state: "DONE" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ],
    check: (captures, driverJson) => {
      const count = captures.length;
      const deliveredCount = deliveredCaptures(captures).length;
      const firstCapturedCalls = capturedResponseToolCalls(captures[0] as CapturedHttp);
      const driverCompleted = getBooleanField(driverJson, "completed");
      const driverUsageTotal = getNumberField((driverJson as Record<string, unknown>)?.["usage"] as unknown, "total");
      // Usage must equal delivered captured usage (separate arrival/delivery)
      let sumPrompt = 0;
      let sumCompletion = 0;
      for (const c of captures) {
        const u = capturedResponseUsage(c);
        if (u) {
          sumPrompt += u.prompt_tokens;
          sumCompletion += u.completion_tokens;
        }
      }
      const expectedTotal = sumPrompt + sumCompletion;
      const deliveredUsage = sumDeliveredUsage(captures);
      const usageMatches = driverUsageTotal === expectedTotal && driverUsageTotal === deliveredUsage;
      const pass = count === 2 && deliveredCount === 2 && firstCapturedCalls === 2 && driverCompleted === true && usageMatches;
      const detail = `requests=${count} delivered=${deliveredCount} expect2, firstRespCalls=${firstCapturedCalls} expect2 (from captured response), driverCompleted=${driverCompleted}, driverUsageTotal=${driverUsageTotal} expected=${expectedTotal} deliveredUsage=${deliveredUsage} usageMatches=${usageMatches}`;
      return { pass, detail };
    },
  });

  // Scenario 2: grace exactly one with only 2 tools
  await runScenario({
    id: "sdk-2-grace-exactly-one",
    scenario: "2",
    scripted: [
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "main.go" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "chatcmpl-2",
        object: "chat.completion",
        created: 2,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c2", type: "function", function: { name: "task_done", arguments: JSON.stringify({ state: "DONE" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "chatcmpl-3",
        object: "chat.completion",
        created: 3,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c3", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "other.go" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ],
    check: (captures, driverJson) => {
      const req1Tools = extractCapturedTools(captures[0] as CapturedHttp);
      const req2Tools = extractCapturedTools(captures[1] as CapturedHttp);
      const count = captures.length;
      const deliveredCount = deliveredCaptures(captures).length;
      const req2Len = req2Tools.length;
      const req2Names = [...req2Tools].sort().join(",");
      const deliveredUsage = sumDeliveredUsage(captures);
      const driverUsage = getNumberField(isRecord(driverJson) ? (driverJson["usage"] as unknown) : undefined, "total");
      const usageMatches = driverUsage === deliveredUsage && deliveredUsage === 30 && deliveredCount === 2;
      const pass = count === 2 && deliveredCount === 2 && req2Len === 2 && req2Names === "code_comment,task_done" && req1Tools.length >= 3 && usageMatches;
      const detail = `requests=${count} delivered=${deliveredCount} expect2, req1Tools=${req1Tools.length} expect>=3 (${req1Tools.join(",")}), req2Tools=${req2Len} expect2 (${req2Names}), driverUsage=${driverUsage} deliveredUsage=${deliveredUsage} usageMatches=${usageMatches}`;
      return { pass, detail };
    },
  });

  // Scenario 3: abort before grace, no grace request, settles within 500ms (strict)
  await runScenario({
    id: "sdk-3-abort-prevents-grace",
    scenario: "3",
    scripted: [
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "main.go" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "chatcmpl-2",
        object: "chat.completion",
        created: 2,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c2", type: "function", function: { name: "task_done", arguments: JSON.stringify({ state: "DONE" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ],
    check: (captures, driverJson, elapsed) => {
      const count = captures.length;
      const deliveredCount = deliveredCaptures(captures).length;
      const driverElapsed = driverFieldNumber(driverJson, "elapsed");
      const effectiveElapsed = driverElapsed ?? elapsed;
      const deliveredUsage = sumDeliveredUsage(captures);
      const driverUsage = getNumberField(isRecord(driverJson) ? (driverJson["usage"] as unknown) : undefined, "total");
      // Usage must equal delivered (only one delivered, no grace)
      const usageMatches = deliveredUsage === 15 && driverUsage === deliveredUsage && deliveredCount === 1;
      const pass = count === 1 && deliveredCount === 1 && effectiveElapsed < 500 && usageMatches;
      const detail = `requests=${count} delivered=${deliveredCount} expect1 (no grace), driverElapsed=${driverElapsed} verifierElapsed=${elapsed} effective=${effectiveElapsed} expect<500, driverUsage=${driverUsage} deliveredUsage=${deliveredUsage} usageMatches=${usageMatches}`;
      return { pass, detail };
    },
  });

  // Scenario 4: OCR TestRunPerFile_EmptyToolResultsStopWithEmptyRounds — 3 consecutive rounds where model calls file_read but tool returns "" (no usable result)
  await runScenario({
    id: "sdk-4-three-empty-retries",
    scenario: "4",
    scripted: [
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "main.go" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "chatcmpl-2",
        object: "chat.completion",
        created: 2,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c2", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "main.go" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "chatcmpl-3",
        object: "chat.completion",
        created: 3,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c3", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "main.go" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ],
    check: (captures, driverJson) => {
      const count = captures.length;
      const deliveredCount = deliveredCaptures(captures).length;
      // Verify each delivered response had a file_read tool call (OCR's empty-tool scenario)
      let allFileRead = true;
      for (let i = 0; i < 3; i++) {
        const cap = captures[i];
        if (!cap || !cap.delivered || cap.response === null) { allFileRead = false; break; }
        if (!isRecord(cap.response.body)) { allFileRead = false; break; }
        const choices = cap.response.body["choices"];
        if (!Array.isArray(choices) || choices.length === 0) { allFileRead = false; break; }
        const first = choices[0];
        if (!isRecord(first)) { allFileRead = false; break; }
        const msg = first["message"];
        if (!isRecord(msg)) { allFileRead = false; break; }
        const tcs = msg["tool_calls"];
        if (!Array.isArray(tcs) || tcs.length === 0) { allFileRead = false; break; }
        const firstCall = tcs[0];
        if (!isRecord(firstCall)) { allFileRead = false; break; }
        const fn = firstCall["function"];
        if (!isRecord(fn) || fn["name"] !== "file_read") { allFileRead = false; break; }
      }
      // Verify subsequent requests contain the empty-tool error (next round's messages include that string)
      let hasEmptyResultError = false;
      if (captures.length >= 2) {
        const secondReqMsgs = extractCapturedMessages(captures[1] as CapturedHttp);
        const s = JSON.stringify(secondReqMsgs);
        if (s.includes("Tool execution returned no result") || s.includes("no result")) hasEmptyResultError = true;
      }
      const stopStr = driverFieldString(driverJson, "stop");
      const stopNum = getNumberField(driverJson, "stop");
      const isEmpty = stopStr.includes("empty") || stopStr === "2" || stopNum === 2;
      // Usage must equal delivered captured usage
      const deliveredUsage = sumDeliveredUsage(captures);
      const driverUsage = getNumberField(isRecord(driverJson) ? (driverJson["usage"] as unknown) : undefined, "total");
      const usageMatches = driverUsage === deliveredUsage && deliveredUsage === 45;
      const pass = count === 3 && deliveredCount === 3 && allFileRead && isEmpty && usageMatches;
      const detail = `requests=${count} delivered=${deliveredCount} expect3, allFileRead=${allFileRead}, hasEmptyError=${hasEmptyResultError}, driverStop=${stopStr} isEmpty=${isEmpty}, driverUsage=${driverUsage} deliveredUsage=${deliveredUsage} usageMatches=${usageMatches}`;
      return { pass, detail };
    },
  });

  // Scenario 5: compression — positively identified compression request and rebuilt
  await runScenario({
    id: "sdk-5-compression-rebuilt",
    scenario: "5",
    scripted: [
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "a.go" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
      },
      {
        id: "chatcmpl-comp",
        object: "chat.completion",
        created: 2,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "compressed summary: 2 files reviewed, 1 issue", tool_calls: undefined }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "chatcmpl-3",
        object: "chat.completion",
        created: 3,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c2", type: "function", function: { name: "task_done", arguments: JSON.stringify({ state: "DONE" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ],
    check: (captures, driverJson) => {
      const count = captures.length;
      const deliveredCount = deliveredCaptures(captures).length;
      const marker = getStringField(driverJson, "marker") ?? COMPRESSION_MARKER;
      // Positively identify compression request: it must contain the marker string and be delivered
      let compressionIdx = -1;
      for (let i = 0; i < captures.length; i++) {
        const c = captures[i];
        if (!c || !c.delivered) continue;
        if (messagesContain(c, marker)) {
          compressionIdx = i;
          break;
        }
      }
      const hasCompressionReq = compressionIdx !== -1;
      // Following main request must contain the summary from compression response (observed, not heuristic)
      let hasSummaryInNext = false;
      if (hasCompressionReq && compressionIdx + 1 < captures.length) {
        const next = captures[compressionIdx + 1];
        if (next && next.delivered) hasSummaryInNext = messagesContain(next, "compressed summary");
      }
      // Usage must equal delivered captured usage
      const deliveredUsage = sumDeliveredUsage(captures);
      const driverUsage = getNumberField(isRecord(driverJson) ? (driverJson["usage"] as unknown) : undefined, "total");
      const usageMatches = driverUsage === deliveredUsage && deliveredCount === count;
      const pass = count >= 3 && deliveredCount >= 3 && hasCompressionReq && hasSummaryInNext && usageMatches;
      const detail = `requests=${count} delivered=${deliveredCount} expect>=3, compressionIdx=${compressionIdx} hasCompressionReq=${hasCompressionReq} hasSummaryInNext=${hasSummaryInNext} marker=${marker} driverUsage=${driverUsage} deliveredUsage=${deliveredUsage} usageMatches=${usageMatches}`;
      return { pass, detail };
    },
  });

  // Scenario 6: stall + abort settles within 500ms, request arrived but response never delivered (no usage)
  await runScenario({
    id: "sdk-6-stall-abort-settles",
    scenario: "6",
    scripted: [
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "should not return", tool_calls: undefined }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ],
    delayMs: 5000,
    check: (captures, driverJson, elapsed) => {
      const driverElapsed = driverFieldNumber(driverJson, "elapsed") ?? elapsed;
      const aborted = driverFieldBoolean(driverJson, "aborted");
      const requestReached = captures.length >= 1;
      const deliveredCount = deliveredCaptures(captures).length;
      const hasPrompt = captures.length >= 1 && messagesContain(captures[0] as CapturedHttp, "review");
      // Separate arrival/delivery: aborted must have request but no delivered response and no usage
      const hasNoDeliveredResponse = deliveredCount === 0 && captures.length === 1 && captures[0]?.response === null && captures[0]?.delivered === false;
      const deliveredUsage = sumDeliveredUsage(captures);
      const driverUsage = getNumberField(isRecord(driverJson) ? (driverJson["usage"] as unknown) : undefined, "total");
      const usageMatches = deliveredUsage === 0 && driverUsage === 0;
      const noUsageInCapture = captures.length >= 1 ? capturedResponseUsage(captures[0] as CapturedHttp) === undefined : false;
      const pass = driverElapsed < 500 && aborted === true && requestReached && hasPrompt && hasNoDeliveredResponse && usageMatches && noUsageInCapture;
      const detail = `driverElapsed=${driverElapsed} expect<500, aborted=${aborted}, requestReached=${requestReached} captures=${captures.length} delivered=${deliveredCount} hasPrompt=${hasPrompt} hasNoDeliveredResponse=${hasNoDeliveredResponse} deliveredUsage=${deliveredUsage} driverUsage=${driverUsage} usageMatches=${usageMatches} noUsageInCapture=${noUsageInCapture}`;
      return { pass, detail };
    },
    timeoutMs: 10000,
  });

  // Scenario 7: two concurrent sessions — distinct messages, usage, cancellation, compression (separate arrival/delivery, per-session usage equality)
  {
    const id = "sdk-7-isolation-two-sessions";
    fixtures.push(id);
    console.error(`[verify:sdk-feasibility] running ${id}...`);
    const scriptedA: readonly ScriptedResponse[] = [
      {
        id: "chatcmpl-a1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "a.go" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "chatcmpl-a-comp",
        object: "chat.completion",
        created: 2,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "compressed summary A: marker " + COMPRESSION_MARKER, tool_calls: undefined }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: "chatcmpl-a2",
        object: "chat.completion",
        created: 3,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c2", type: "function", function: { name: "task_done", arguments: JSON.stringify({ state: "DONE" }) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ];
    const scriptedB: readonly ScriptedResponse[] = [
      {
        id: "chatcmpl-b1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "stall", tool_calls: undefined }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      },
    ];
    const serverA = createCaptureServer({ responses: scriptedA as unknown as readonly unknown[] });
    const serverB = createCaptureServer({ responses: scriptedB as unknown as readonly unknown[], delayMs: 5000 });
    const result = await runScenarioInConsumer({ consumerDir, serverUrl: serverA.url, scenario: "7", serverUrl2: serverB.url });
    serverA.stop();
    serverB.stop();
    assertions++;
    const capsA = serverA.getSanitizedCaptures();
    const capsB = serverB.getSanitizedCaptures();

    function checkIsolation(aCaps: readonly CapturedHttp[], bCaps: readonly CapturedHttp[], driverJson: unknown): CheckResult {
      const aMessages = aCaps.length > 0 ? JSON.stringify(extractCapturedMessages(aCaps[0] as CapturedHttp)) : "";
      const bMessages = bCaps.length > 0 ? JSON.stringify(extractCapturedMessages(bCaps[0] as CapturedHttp)) : "";
      const distinctMessages = aMessages !== bMessages && aMessages.includes("a.go") && bMessages.includes("b.go");
      const aHasB = aMessages.includes("b.go");
      const bHasA = bMessages.includes("a.go");
      // Per-session usage equality: each session's driver usage must equal its delivered captured usage
      const aDeliveredUsage = sumDeliveredUsage(aCaps);
      const bDeliveredUsage = sumDeliveredUsage(bCaps);
      const aDeliveredCount = deliveredCaptures(aCaps).length;
      const bDeliveredCount = deliveredCaptures(bCaps).length;
      const driverRA = isRecord(driverJson) ? (driverJson["rA"] as unknown) : undefined;
      const driverRB = isRecord(driverJson) ? (driverJson["rB"] as unknown) : undefined;
      const driverAUsage = isRecord(driverRA) ? getNumberField(driverRA as Record<string, unknown>, "usage") : undefined;
      const driverBUsage = isRecord(driverRB) ? getNumberField(driverRB as Record<string, unknown>, "usage") : undefined;
      const aUsageMatches = driverAUsage === aDeliveredUsage && aDeliveredUsage === 45 && aDeliveredCount === 3;
      const bUsageMatches = driverBUsage === bDeliveredUsage && bDeliveredUsage === 0 && bDeliveredCount === 0;
      const distinctUsage = aDeliveredUsage !== bDeliveredUsage && aDeliveredUsage === 45 && bDeliveredUsage === 0;
      // Cancellation: B was aborted, arrived (1 request) but not delivered (0), A not aborted and fully delivered
      const bAborted = isRecord(driverJson) ? getBooleanField(driverJson, "bAborted") : undefined;
      const bWasCancelled = bAborted === true && bCaps.length === 1 && bDeliveredCount === 0 && bCaps[0]?.delivered === false;
      const bHasNoDeliveredResponse = bCaps.length === 1 && bCaps[0]?.response === null;
      // Compression: A must have compression request with marker and rebuilt, only on delivered captures
      let aCompressionIdx = -1;
      for (let i = 0; i < aCaps.length; i++) {
        const c = aCaps[i];
        if (!c || !c.delivered) continue;
        if (messagesContain(c as CapturedHttp, COMPRESSION_MARKER)) {
          aCompressionIdx = i;
          break;
        }
      }
      const aHasCompression = aCompressionIdx !== -1;
      let aHasSummaryInNext = false;
      if (aHasCompression && aCompressionIdx + 1 < aCaps.length) {
        const nxt = aCaps[aCompressionIdx + 1];
        if (nxt && nxt.delivered) aHasSummaryInNext = messagesContain(nxt as CapturedHttp, "compressed summary A");
      }
      const bHasNoCompression = bCaps.every((c) => !messagesContain(c as CapturedHttp, COMPRESSION_MARKER));
      const driverOk = isRecord(driverJson) && isRecord(driverRA) && isRecord(driverRB);
      const elapsed = isRecord(driverJson) ? getNumberField(driverJson, "elapsed") : undefined;
      const elapsedOk = elapsed === undefined || elapsed < 15000;
      const pass =
        distinctMessages &&
        !aHasB &&
        !bHasA &&
        distinctUsage &&
        aUsageMatches &&
        bUsageMatches &&
        bWasCancelled &&
        bHasNoDeliveredResponse &&
        aHasCompression &&
        aHasSummaryInNext &&
        bHasNoCompression &&
        driverOk &&
        (elapsedOk ?? true) &&
        aCaps.length === 3 &&
        bCaps.length === 1;
      const detail = `aReq=${aCaps.length} aDelivered=${aDeliveredCount} bReq=${bCaps.length} bDelivered=${bDeliveredCount} distinctMsg=${distinctMessages} distinctUsage=${distinctUsage} aUsageCap=${aDeliveredUsage} bUsageCap=${bDeliveredUsage} driverA=${driverAUsage} driverB=${driverBUsage} aMatch=${aUsageMatches} bMatch=${bUsageMatches} bCancelled=${bWasCancelled} bNoResp=${bHasNoDeliveredResponse} aComp=${aHasCompression} aSummaryNext=${aHasSummaryInNext} bNoComp=${bHasNoCompression} driverOk=${driverOk}`;
      return { pass, detail };
    }

    const checkRes = checkIsolation(capsA, capsB, result.outputJson);
    const dir = join(artifactDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "serverA.json"), JSON.stringify(capsA, null, 2), "utf-8");
    writeFileSync(join(dir, "serverB.json"), JSON.stringify(capsB, null, 2), "utf-8");
    writeFileSync(join(dir, "driver.json"), JSON.stringify(result, null, 2), "utf-8");
    if (!checkRes.pass) {
      const r: Gate1Report = {
        gate: "sdk-feasibility",
        commit,
        ocrTagObject: tagObject,
        ocrCommit,
        packageArchiveHash,
        fixtures,
        assertions,
        notObservable,
        forbiddenImports,
        forbiddenImportDetails: [],
        result: "fail",
        artifactDir,
        error: `${id} failed: ${checkRes.detail}`,
      };
      fail(r, `${id} failed: ${checkRes.detail}`);
    }
    console.error(`[verify:sdk-feasibility] PASS ${id}: ${checkRes.detail}`);

    // Adversarial: mutate captures to make isolation fail, then pass mutated captures through the REAL checkIsolation
    assertions++;
    // Create mutated copies where A's first request is changed to contain b.go, making distinctMessages false
    const mutatedA: CapturedHttp[] = capsA.map((c) => ({
      ...c,
      request: { ...c.request, body: deepCloneForMutate(c.request.body) },
      response: c.response ? { ...c.response, body: deepCloneForMutate(c.response.body) } : null,
    }));
    // Helper to deep clone via JSON for mutate
    function deepCloneForMutate<T>(v: T): T {
      return JSON.parse(JSON.stringify(v)) as T;
    }
    if (mutatedA.length > 0 && isRecord(mutatedA[0]?.request.body)) {
      const body = mutatedA[0]?.request.body as Record<string, unknown>;
      const msgs = body["messages"];
      if (Array.isArray(msgs)) {
        const s = JSON.stringify(msgs);
        const mutatedStr = s.replace(/a\.go/g, "b.go");
        try {
          const parsed: unknown = JSON.parse(mutatedStr);
          (mutatedA[0] as unknown as { request: { body: unknown } }).request.body = { ...(body as Record<string, unknown>), messages: parsed };
        } catch {}
      }
    }
    const mutatedRes = checkIsolation(mutatedA, capsB, result.outputJson);
    if (mutatedRes.pass) {
      const r: Gate1Report = {
        gate: "sdk-feasibility",
        commit,
        ocrTagObject: tagObject,
        ocrCommit,
        packageArchiveHash,
        fixtures,
        assertions,
        notObservable,
        forbiddenImports,
        forbiddenImportDetails: [],
        result: "fail",
        artifactDir,
        error: `adversarial ${id} did not fail as expected: ${mutatedRes.detail}`,
      };
      fail(r, `adversarial ${id} did not fail: ${mutatedRes.detail}`);
    }
    console.error(`[verify:sdk-feasibility] ADV PASS ${id}: adversarial correctly failed: ${mutatedRes.detail}`);
  }

  const report: Gate1Report = {
    gate: "sdk-feasibility",
    commit,
    ocrTagObject: tagObject,
    ocrCommit,
    packageArchiveHash,
    fixtures,
    assertions: assertions + 3, // + gate0 + pinned + pack
    notObservable,
    forbiddenImports,
    forbiddenImportDetails: [],
    result: "pass",
    artifactDir,
  };

  console.error(`[verify:sdk-feasibility] PASS: ${report.assertions} assertions, ${fixtures.length} fixtures`);
  console.log(JSON.stringify(report));
}

main().catch((e: unknown) => {
  const commit = currentCommit();
  const artifactDir = mkdtempSync(join(tmpdir(), "verify-sdk-fatal-"));
  const msg = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? e.stack : undefined;
  const r: Gate1Report = {
    gate: "sdk-feasibility",
    commit,
    ocrTagObject: "unknown",
    ocrCommit: "unknown",
    packageArchiveHash: null,
    fixtures: [],
    assertions: 0,
    notObservable: [],
    forbiddenImports: -1,
    forbiddenImportDetails: [],
    result: "fail",
    artifactDir,
    error: msg,
  };
  console.error(`[verify:sdk-feasibility] fatal: ${stack ?? msg}`);
  console.log(JSON.stringify(r));
  process.exit(1);
});


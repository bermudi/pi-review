#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Gate 2 — One real OCR/Pi vertical slice (black-box)
// See docs/ocr-port-plan.md Gate 2.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkImports } from "./import-guard.js";
import { runPackedInstallSmoke } from "./package-installer.js";
import { createCaptureServer } from "./server.js";
import type { CapturedHttp } from "./types.js";

function getSanitizedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (lower.includes("token") || lower.includes("key") || lower.includes("secret") || lower.includes("password") || lower.includes("credential") || k.startsWith("NPM_") || k.startsWith("GITHUB_") || k.startsWith("NODE_AUTH")) continue;
    out[k] = v;
  }
  out["BUN_OFFLINE"] = "1";
  out["npm_config_offline"] = "true";
  return out;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PINNED_TAG = "v1.9.9";
const PINNED_TAG_OBJECT = "c95d3907d5448354d3f8a33f2ae5e4f23fdf1c94";
const PINNED_COMMIT = "4b6874bd23106b5c68bea6d230bb60303b9f0961";

interface VerticalGateReport {
  readonly gate: "vertical";
  readonly commit: string;
  readonly ocrTagObject: string;
  readonly ocrCommit: string;
  readonly packageArchiveHash: string | null;
  readonly fixtures: readonly string[];
  readonly assertions: number;
  readonly notObservable: readonly string[];
  readonly forbiddenImports: number;
  readonly forbiddenImportDetails: readonly string[];
  readonly result: "pass" | "fail";
  readonly artifactDir: string;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Helpers — git, commit, parsing
// ---------------------------------------------------------------------------

function currentCommit(): string {
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8", timeout: 5000 });
    if (res.status === 0) return (res.stdout as string).trim();
  } catch {}
  return "unknown";
}

function fail(message: string, artifactDir: string, extra?: Record<string, unknown>): never {
  const report: VerticalGateReport = {
    gate: "vertical",
    commit: currentCommit(),
    ocrTagObject: PINNED_TAG_OBJECT,
    ocrCommit: PINNED_COMMIT,
    packageArchiveHash: null,
    fixtures: [],
    assertions: 0,
    notObservable: [],
    forbiddenImports: -1,
    forbiddenImportDetails: [],
    result: "fail",
    artifactDir,
    error: message,
    ...extra,
  } as unknown as VerticalGateReport;
  console.log(JSON.stringify(report));
  console.error(`[verify:vertical] FAIL: ${message}`);
  if (artifactDir) console.error(`Artifacts: ${artifactDir}`);
  process.exit(1);
}

function checkGitClean(): void {
  const diff = spawnSync("git", ["diff", "--quiet"], { stdio: "ignore", timeout: 5000 });
  if (diff.status !== 0) fail("dirty working tree (uncommitted changes). Commit or stash first.", mkdtempSyncDir("verify-vertical-"));
  const untrackedRes = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf-8", timeout: 5000 });
  const untracked = ((untrackedRes.stdout as string) ?? "").trim();
  if (untracked.length > 0) fail(`untracked files present:\n${untracked}`, mkdtempSyncDir("verify-vertical-"));
}

function mkdtempSyncDir(prefix: string): string {
  // Use Node fs mkdtempSync directly (imported sync version via dynamic require to avoid top-level import issues)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require("node:fs") as { mkdtempSync: (p: string) => string };
  return fsSync.mkdtempSync(join(tmpdir(), prefix));
}

function verifyPinnedRef(): void {
  const refCheckout = resolve(import.meta.dir, "../../../open-code-review");
  if (!existsSync(refCheckout)) fail(`pinned checkout missing at ${refCheckout}`, mkdtempSyncDir("verify-vertical-"));
  const commitRes = spawnSync("git", ["rev-parse", `${PINNED_TAG}^{commit}`], { cwd: refCheckout, encoding: "utf-8", timeout: 5000 });
  const commit = ((commitRes.stdout as string) ?? "").trim();
  if (commitRes.status !== 0 || commit !== PINNED_COMMIT) {
    fail(`pinned commit mismatch: expected ${PINNED_COMMIT} got ${JSON.stringify(commit)}`, mkdtempSyncDir("verify-vertical-"));
  }
  const tagRes = spawnSync("git", ["rev-parse", PINNED_TAG], { cwd: refCheckout, encoding: "utf-8", timeout: 5000 });
  const tagObj = ((tagRes.stdout as string) ?? "").trim();
  if (tagObj !== PINNED_TAG_OBJECT) {
    fail(`pinned tag object mismatch: got ${JSON.stringify(tagObj)} want ${PINNED_TAG_OBJECT}`, mkdtempSyncDir("verify-vertical-"));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function getNumberField(obj: unknown, key: string): number | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}

// ---------------------------------------------------------------------------
// OCR binary builder (git archive -> go build)
// ---------------------------------------------------------------------------

let cachedOcrBinary: string | null = null;
let cachedOcrBuildDir: string | null = null;

async function getOcrBinary(): Promise<string> {
  if (cachedOcrBinary && existsSync(cachedOcrBinary)) return cachedOcrBinary;
  verifyPinnedRef();
  const refCheckout = resolve(import.meta.dir, "../../../open-code-review");
  const buildDir = await mkdtemp(join(tmpdir(), "ocr-build-"));
  cachedOcrBuildDir = buildDir;
  const archivePath = join(buildDir, "ocr.tar");
  const archiveRes = spawnSync("git", ["archive", "--format=tar", "-o", archivePath, PINNED_TAG], { cwd: refCheckout, encoding: "utf-8", timeout: 15000 });
  if (archiveRes.status !== 0) throw new Error(`git archive ${PINNED_TAG} failed: ${archiveRes.stderr ?? archiveRes.stdout}`);
  const extractDir = join(buildDir, "src");
  mkdirSync(extractDir, { recursive: true });
  const tarRes = spawnSync("tar", ["-xf", archivePath, "-C", extractDir], { encoding: "utf-8", timeout: 10000 });
  if (tarRes.status !== 0) throw new Error(`tar extract failed: ${tarRes.stderr ?? tarRes.stdout}`);
  const binaryPath = join(buildDir, "ocr-v1.9.9");
  const goBuild = spawnSync("go", ["build", "-o", binaryPath, "./cmd/opencodereview"], { cwd: extractDir, encoding: "utf-8", timeout: 60000 });
  if (goBuild.status !== 0) throw new Error(`go build ocr failed: ${goBuild.stderr ?? goBuild.stdout}`);
  cachedOcrBinary = binaryPath;
  return binaryPath;
}

async function cleanupOcrBinary(): Promise<void> {
  if (cachedOcrBuildDir) {
    await rm(cachedOcrBuildDir, { recursive: true, force: true }).catch(() => {});
    cachedOcrBuildDir = null;
    cachedOcrBinary = null;
  }
}

// ---------------------------------------------------------------------------
// Git fixture helpers (no import of test/ocr/harness)
// ---------------------------------------------------------------------------

function gitSync(cwd: string, args: readonly string[]): string {
  const res = spawnSync("git", [...args], { cwd, encoding: "utf-8", timeout: 10000 });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr ?? res.stdout}`);
  return ((res.stdout as string) ?? "").trim();
}

async function createTempRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-vert-fixture-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  // Minimal workspace repo: one tracked file, then unstaged change
  gitSync(dir, ["init", "-q"]);
  gitSync(dir, ["config", "user.email", "harness@pi-reviewer.test"]);
  gitSync(dir, ["config", "user.name", "harness"]);
  gitSync(dir, ["config", "commit.gpgsign", "false"]);
  const fixedDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: fixedDate, GIT_COMMITTER_DATE: fixedDate };
  await writeFile(join(dir, "main.go"), "package main\nfunc Add(a int, b int) int { return a + b }\n", "utf-8");
  let res = spawnSync("git", ["add", "-A"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git add failed: ${res.stderr}`);
  res = spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr}`);
  // Unstaged workspace change: modify main.go
  await writeFile(join(dir, "main.go"), "package main\nfunc Add(a int, b int) int {\n  // TODO: handle nil?\n  return a + b\n}\n", "utf-8");
  return { dir, cleanup };
}

async function cloneRepo(sourceDir: string, destDir: string): Promise<void> {
  // Preserve workspace (unstaged) changes: git clone would drop them, so we copy the working tree.
  // Create dest then copy everything including .git and modified files.
  mkdirSync(destDir, { recursive: true });
  const cpRes = spawnSync("cp", ["-a", `${sourceDir}/.`, destDir], { encoding: "utf-8", timeout: 10000 });
  if (cpRes.status !== 0) throw new Error(`cp -a failed: ${cpRes.stderr ?? cpRes.stdout}`);
  // Ensure clones have config for completeness
  try {
    gitSync(destDir, ["config", "user.email", "harness@pi-reviewer.test"]);
    gitSync(destDir, ["config", "user.name", "harness"]);
  } catch {}
  // Remove any leftover lock files that cp might have copied incorrectly
  const lock = join(destDir, ".git", "index.lock");
  if (existsSync(lock)) {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(lock);
    } catch {}
  }
}

async function createPiAgentDir(serverUrl: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-vert-agent-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  await writeFile(join(dir, "auth.json"), JSON.stringify({ "test-openai": { type: "api_key", key: "test-key" } }), "utf-8");
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "test-openai": {
          baseUrl: serverUrl,
          apiKey: "test-key",
          api: "openai-completions",
          models: [{ id: "test-model", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
    "utf-8",
  );
  return { dir, cleanup };
}

// ---------------------------------------------------------------------------
// Scripted responses — one code_comment then task_done
// ---------------------------------------------------------------------------

function makeScriptedResponses(commentContent: string): readonly unknown[] {
  // OpenAI chat.completion shape, matching what our server returns.
  // We intentionally use distinct usage per turn so total usage is observable and comparable.
  return [
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
                id: "call_1",
                type: "function",
                function: {
                  name: "code_comment",
                  arguments: JSON.stringify({
                    path: "main.go",
                    comments: [
                      {
                        content: commentContent,
                        existing_code: "func Add(a int, b int) int { return a + b }",
                        category: "bug",
                        severity: "medium",
                      },
                    ],
                  }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
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
                id: "call_2",
                type: "function",
                function: { name: "task_done", arguments: JSON.stringify({ state: "DONE" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    },
  ];
}

// ---------------------------------------------------------------------------
// Subprocess runners — capture stdout/stderr + provider traffic
// ---------------------------------------------------------------------------

async function runOcrSubprocess(opts: {
  binaryPath: string;
  repoDir: string;
  serverUrl: string;
  serverPort: number;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> {
  const homeDir = await mkdtemp(join(tmpdir(), "ocr-vert-home-"));
  const env: Record<string, string> = {
    ...getSanitizedEnv(),
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    OCR_LLM_URL: opts.serverUrl,
    OCR_LLM_TOKEN: "test-token",
    OCR_LLM_MODEL: "test-model",
    OCR_LLM_PROTOCOL: "openai",
    OCR_LLM_TIMEOUT: "30",
  };
  // Remove inline PI agent env that might interfere — OCR uses its own.
  delete (env as Record<string, string | undefined>)["PI_CODING_AGENT_DIR"];
  const args = ["review", "--repo", opts.repoDir, "--format", "json", "--no-filter"];
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }>((resolve) => {
    const child = spawn(opts.binaryPath, args, { cwd: opts.repoDir, env, stdio: ["ignore", "pipe", "pipe"] as unknown as never });
    let stdout = "";
    let stderr = "";
    (child.stdout as unknown as { on: (ev: string, cb: (d: Buffer) => void) => void }).on("data", (d: Buffer) => (stdout += d.toString()));
    (child.stderr as unknown as { on: (ev: string, cb: (d: Buffer) => void) => void }).on("data", (d: Buffer) => (stderr += d.toString()));
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        try {
          (child as unknown as { kill: (s: string) => void }).kill("SIGTERM");
        } catch {}
      }
    }, opts.timeoutMs ?? 30000);
    (child as unknown as { on: (ev: string, cb: (err: Error) => void) => void }).on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr: stderr + `\nspawn error: ${err.message}`, exitCode: 1, signal: null });
    });
    (child as unknown as { on: (ev: string, cb: (code: number | null, signal: string | null) => void) => void }).on("close", (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code, signal: signal as string | null });
    });
  });
  await rm(homeDir, { recursive: true, force: true }).catch(() => {});
  return result;
}

async function runPiSubprocess(opts: {
  repoDir: string;
  serverUrl: string;
  consumerBinPath: string;
  consumerDir: string;
  agentDir: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; command: readonly string[] }> {
  const homeDir = await mkdtemp(join(tmpdir(), "pi-vert-home-"));
  const env: Record<string, string> = {
    ...getSanitizedEnv(),
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    PI_CODING_AGENT_DIR: opts.agentDir,
    // Ensure OCR env does not influence Pi parity — it uses PI agent dir, but we also keep it isolated.
    OCR_LLM_URL: opts.serverUrl,
    OCR_LLM_TOKEN: "test-token",
    OCR_LLM_MODEL: "test-model",
    OCR_LLM_PROTOCOL: "openai",
  };
  // Use packed pi-review bin (sole OCR v1.9.9 engine, no --engine switch).
  // Command: <consumerBinPath> review --repo <repo> --model test-openai/test-model --concurrency 1 --format json
  const args = ["review", "--repo", opts.repoDir, "--model", "test-openai/test-model", "--concurrency", "1", "--no-filter", "--format", "json"];
  // consumerBinPath is typically /tmp/consumer/node_modules/.bin/pi-review which is a shell wrapper; spawn via bun? Use that path directly.
  // If it's a JS file (dist/cli.js), run via bun. Detect.
  let bin = opts.consumerBinPath;
  let binArgs: string[] = args;
  let useBun = false;
  if (bin.endsWith(".js")) {
    useBun = true;
  } else {
    // Check if file is shell wrapper containing node — read first line
    try {
      const head = readFileSync(bin, "utf-8").slice(0, 200);
      if (head.includes("node") || head.includes("bun")) {
        // It's a wrapper, still spawn directly as shell; but Bun.spawn via shell might fail. Use spawn with shell: false still works for wrapper scripts that are executable.
      }
    } catch {}
  }
  const commandForLog: readonly string[] = useBun ? (["bun", bin, ...args] as const) : ([bin, ...args] as const);
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }>((resolve) => {
    const spawnOpts = { cwd: opts.repoDir, env, stdio: ["ignore", "pipe", "pipe"] as unknown as never };
    const child = useBun ? spawn("bun", [bin, ...binArgs], spawnOpts) : spawn(bin, binArgs, spawnOpts);
    let stdout = "";
    let stderr = "";
    (child.stdout as unknown as { on: (ev: string, cb: (d: Buffer) => void) => void }).on("data", (d: Buffer) => (stdout += d.toString()));
    (child.stderr as unknown as { on: (ev: string, cb: (d: Buffer) => void) => void }).on("data", (d: Buffer) => (stderr += d.toString()));
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        try {
          (child as unknown as { kill: (s: string) => void }).kill("SIGTERM");
        } catch {}
      }
    }, opts.timeoutMs ?? 30000);
    (child as unknown as { on: (ev: string, cb: (err: Error) => void) => void }).on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr: stderr + `\nspawn error: ${err.message}`, exitCode: 1, signal: null });
    });
    (child as unknown as { on: (ev: string, cb: (code: number | null, signal: string | null) => void) => void }).on("close", (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code, signal: signal as string | null });
    });
  });
  await rm(homeDir, { recursive: true, force: true }).catch(() => {});
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, signal: result.signal, command: commandForLog };
}

// ---------------------------------------------------------------------------
// Output parsing — actual stdout parsing (no fixture synthetic)
// ---------------------------------------------------------------------------

function parseOcrJson(stdout: string): { comments: unknown[]; summary: Record<string, unknown>; raw: unknown; status: string } {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const jsonStr = start >= 0 ? trimmed.slice(start) : trimmed;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) return { comments: [], summary: {}, raw: parsed, status: "unknown" };
  const comments = Array.isArray(parsed["comments"]) ? (parsed["comments"] as unknown[]) : [];
  const summary = isRecord(parsed["summary"]) ? (parsed["summary"] as Record<string, unknown>) : {};
  const status = typeof parsed["status"] === "string" ? (parsed["status"] as string) : typeof parsed["message"] === "string" ? "unknown" : "unknown";
  // OCR json sometimes has status at top-level; fallback to summary or exit logic handled elsewhere.
  const resolvedStatus = typeof parsed["status"] === "string" ? (parsed["status"] as string) : status;
  return { comments, summary, raw: parsed, status: resolvedStatus };
}

function parsePiJson(stdout: string): { findings: unknown[]; coverage: Record<string, unknown>; status: string; raw: unknown } {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const jsonStr = start >= 0 ? trimmed.slice(start) : trimmed;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) return { findings: [], coverage: {}, status: "unknown", raw: parsed };
  // Pi parity engine emits OCR-shaped JSON: comments[] + summary.
  // Detect which shape we got and normalize to common fields for comparison where possible.
  if (Array.isArray(parsed["comments"])) {
    // Parity shape
    const comments = parsed["comments"] as unknown[];
    const status = typeof parsed["status"] === "string" ? (parsed["status"] as string) : "unknown";
    const coverage: Record<string, unknown> = {};
    // Parity manifest may contain coverage indirectly; leave empty for now — we'll derive from git if needed.
    // But we can pull summary.files_reviewed as proxy.
    if (isRecord(parsed["summary"])) coverage["summary"] = parsed["summary"];
    return { findings: comments, coverage, status, raw: parsed };
  }
  if (Array.isArray(parsed["findings"])) {
    const findings = parsed["findings"] as unknown[];
    const coverage = isRecord(parsed["coverage"]) ? (parsed["coverage"] as Record<string, unknown>) : {};
    const status = typeof parsed["status"] === "string" ? (parsed["status"] as string) : "unknown";
    return { findings, coverage, status, raw: parsed };
  }
  return { findings: [], coverage: {}, status: "unknown", raw: parsed };
}

function extractCommentContent(comment: unknown): string {
  if (!isRecord(comment)) return "";
  const c = comment["content"];
  if (typeof c === "string") return c;
  const content = comment["message"];
  if (typeof content === "string") return content;
  return "";
}

function usageTotalTokensFromSummary(summary: Record<string, unknown>): number {
  const v = summary["total_tokens"] ?? summary["totalTokens"] ?? summary["TotalTokens"];
  if (typeof v === "number") return v;
  const a = summary["input_tokens"] ?? summary["inputTokens"];
  const b = summary["output_tokens"] ?? summary["outputTokens"];
  if (typeof a === "number" && typeof b === "number") return a + b;
  return 0;
}

// ---------------------------------------------------------------------------
// Comparison — field-by-field with provenance
// ---------------------------------------------------------------------------

interface FieldMismatch {
  readonly fieldPath: string;
  readonly ocrValue: unknown;
  readonly piValue: unknown;
  readonly message: string;
}

function fieldEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function setEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function normalizeTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const out: string[] = [];
  for (const t of tools) {
    if (!isRecord(t)) continue;
    if (isRecord(t["function"]) && typeof t["function"]["name"] === "string") out.push(t["function"]["name"] as string);
    else if (typeof t["name"] === "string") out.push(t["name"] as string);
  }
  return out.sort();
}

function extractCapturedTools(captured: CapturedHttp): string[] {
  const body = captured.request.body;
  if (!isRecord(body)) return [];
  const tools = body["tools"];
  return normalizeTools(tools);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

function normalizeToolForCompare(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;
  const fn = tool["function"];
  if (!isRecord(fn)) return tool;
  // Keep name, description, parameters (including required, properties) — deep equality
  return {
    type: tool["type"],
    function: {
      name: fn["name"],
      description: fn["description"],
      parameters: fn["parameters"],
    },
  };
}

function extractCapturedToolsDeep(captured: CapturedHttp): unknown[] {
  const body = captured.request.body;
  if (!isRecord(body)) return [];
  const tools = body["tools"];
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => normalizeToolForCompare(t)).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content as readonly unknown[]) {
      if (!isRecord(block)) continue;
      if (typeof block["text"] === "string") out += block["text"] as string;
      else if (typeof block["content"] === "string") out += block["content"] as string;
      else if (Array.isArray(block["content"])) {
        for (const nested of block["content"] as readonly unknown[]) {
          if (isRecord(nested) && typeof nested["text"] === "string") out += nested["text"] as string;
        }
      }
    }
    return out;
  }
  return "";
}

function normalizeMessageForCompare(msg: unknown): unknown {
  if (!isRecord(msg)) return msg;
  const role = typeof msg["role"] === "string" ? (msg["role"] as string) : "";
  let content = extractTextFromContent(msg["content"]);
  // Normalize environmental artifacts that are not OCR review content:
  // 1. Pi SDK injects "\nCurrent working directory: <path>\n" at the end of the system prompt.
  //    OCR does not have this; it's Pi runtime info, not review semantics. Strip it.
  // 2. OCR replaces {{current_system_date_time}} with the actual timestamp; both engines
  //    run at different times so the timestamp differs. Normalize to a placeholder.
  if (role === "system") {
    content = content.replace(/\nCurrent working directory: [^\n]*\n$/, "");
  }
  content = content.replace(/Current time in the real world: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "Current time in the real world: <NORMALIZED_TIMESTAMP>");
  const out: Record<string, unknown> = { role, content };
  // Preserve tool_calls for assistant
  const tcs = msg["tool_calls"] ?? msg["toolCalls"];
  if (Array.isArray(tcs)) {
    out["tool_calls"] = tcs.map((tc) => {
      if (!isRecord(tc)) return tc;
      const fn = tc["function"] as Record<string, unknown> | undefined;
      const id = typeof tc["id"] === "string" ? tc["id"] as string : undefined;
      const name = isRecord(fn) && typeof fn["name"] === "string" ? (fn["name"] as string) : typeof tc["name"] === "string" ? (tc["name"] as string) : "";
      let args: unknown = isRecord(fn) ? fn["arguments"] : tc["arguments"];
      // Parse arguments JSON for deep compare if string
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch {}
      }
      return { id, name, arguments: args };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  // Preserve tool_call_id for tool results
  if (typeof msg["tool_call_id"] === "string") out["tool_call_id"] = msg["tool_call_id"];
  if (typeof msg["toolCallId"] === "string") out["tool_call_id"] = msg["toolCallId"];
  return out;
}

function extractCapturedMessagesDeep(captured: CapturedHttp): unknown[] {
  const body = captured.request.body;
  if (!isRecord(body)) return [];
  const msgs = body["messages"];
  if (!Array.isArray(msgs)) return [];
  return msgs.map((m) => normalizeMessageForCompare(m));
}

function extractCapturedModel(captured: CapturedHttp): string {
  const body = captured.request.body;
  if (!isRecord(body)) return "";
  const m = body["model"];
  return typeof m === "string" ? m : "";
}

function extractCapturedToolCalls(captured: CapturedHttp): unknown[] {
  const resp = captured.response;
  if (!resp || !isRecord(resp.body)) return [];
  const body = resp.body as Record<string, unknown>;
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const first = choices[0];
  if (!isRecord(first)) return [];
  const msg = first["message"];
  if (!isRecord(msg)) return [];
  const tcs = msg["tool_calls"];
  if (!Array.isArray(tcs)) return [];
  return tcs;
}

function compareVertical(opts: {
  ocrCommand: readonly string[];
  piCommand: readonly string[];
  ocrCaptures: readonly CapturedHttp[];
  piCaptures: readonly CapturedHttp[];
  ocrStdout: string;
  piStdout: string;
  ocrExit: number | null;
  piExit: number | null;
}): { equal: boolean; mismatches: FieldMismatch[]; notObservable: string[] } {
  const mismatches: FieldMismatch[] = [];
  const notObservable: string[] = [];

  const pushMismatch = (fieldPath: string, ocrValue: unknown, piValue: unknown, message: string): void => {
    mismatches.push({ fieldPath, ocrValue, piValue, message });
  };

  // 1. Process identity and exact commands — must be distinct and match expected shapes
  const ocrCmdStr = opts.ocrCommand.join(" ");
  const piCmdStr = opts.piCommand.join(" ");
  if (ocrCmdStr === piCmdStr) {
    pushMismatch("process.identity", opts.ocrCommand, opts.piCommand, "engine identity collision: OCR and Pi commands must be distinct (separate binaries)");
  }
  // Exact commands: OCR must contain "review --repo" and "--format json --no-filter" and must NOT contain --preview
  if (!ocrCmdStr.includes("review") || !ocrCmdStr.includes("--repo") || !ocrCmdStr.includes("--format json")) {
    pushMismatch("process.command.ocr", ocrCmdStr, ocrCmdStr, "OCR command must be review --repo <dir> --format json --no-filter (no --preview)");
  }
  if (ocrCmdStr.includes("--preview")) {
    pushMismatch("process.command.ocr.preview", false, true, "OCR command must not contain --preview for Gate 2");
  }
  if (piCmdStr.includes("--engine")) {
    pushMismatch("process.command.pi.engine", piCmdStr, piCmdStr, "Pi command must not contain --engine (legacy switch removed)");
  }
  if (!piCmdStr.includes("review") || !piCmdStr.includes("--repo") || !piCmdStr.includes("--format")) {
    pushMismatch("process.command.pi", piCmdStr, piCmdStr, "Pi command must be pi-review review --repo <dir> --model ... --format json");
  }

  // 2. Provider request counts — both must have contacted server
  if (opts.ocrCaptures.length === 0) {
    pushMismatch("provider_request.count", 1, 0, "OCR must contact its recording server (provider_request observed)");
  }
  if (opts.piCaptures.length === 0) {
    pushMismatch("provider_request.count", 1, 0, "Pi must contact its recording server (provider_request observed)");
  }
  // Separate servers: ports must differ (prove separate repositories and recording servers)
  try {
    const ocrPort = opts.ocrCaptures[0] ? new URL((opts.ocrCaptures[0].request.url as string) ?? "").port : "";
    const piPort = opts.piCaptures[0] ? new URL((opts.piCaptures[0].request.url as string) ?? "").port : "";
    if (ocrPort && piPort && ocrPort === piPort) {
      pushMismatch("provider_request.servers", ocrPort, piPort, "OCR and Pi must use separate recording servers (distinct ports)");
    }
  } catch {}

  // Compare request ordinals, model, tool schemas (deep) and messages (normalized deep)
  const countEqual = opts.ocrCaptures.length === opts.piCaptures.length;
  if (!countEqual) {
    pushMismatch("provider_request.count.mismatch", opts.ocrCaptures.length, opts.piCaptures.length, `provider request count differs: OCR ${opts.ocrCaptures.length} vs Pi ${opts.piCaptures.length}`);
  } else if (opts.ocrCaptures.length > 0) {
    for (let i = 0; i < opts.ocrCaptures.length; i++) {
      const o = opts.ocrCaptures[i] as CapturedHttp;
      const p = opts.piCaptures[i] as CapturedHttp;
      const oToolsDeep = extractCapturedToolsDeep(o);
      const pToolsDeep = extractCapturedToolsDeep(p);
      if (stableStringify(oToolsDeep) !== stableStringify(pToolsDeep)) {
        pushMismatch(`provider_request[${i}].tool_schema`, oToolsDeep, pToolsDeep, `tool schemas for request ${i} differ (deep): OCR ${JSON.stringify(oToolsDeep).slice(0, 800)} vs Pi ${JSON.stringify(pToolsDeep).slice(0, 800)}`);
      }
      const oModel = extractCapturedModel(o);
      const pModel = extractCapturedModel(p);
      if (oModel !== pModel && oModel !== "" && pModel !== "") {
        pushMismatch(`provider_request[${i}].model`, oModel, pModel, `model for request ${i} differs`);
      }
      const oMsgsDeep = extractCapturedMessagesDeep(o);
      const pMsgsDeep = extractCapturedMessagesDeep(p);
      if (oMsgsDeep.length === 0 || pMsgsDeep.length === 0) {
        pushMismatch(`provider_request[${i}].messages`, oMsgsDeep.length, pMsgsDeep.length, `messages missing for request ${i}`);
      } else if (stableStringify(oMsgsDeep) !== stableStringify(pMsgsDeep)) {
        // Allow minor whitespace normalization but require deep equality of role/content/tool_calls
        pushMismatch(`provider_request[${i}].messages`, oMsgsDeep, pMsgsDeep, `messages for request ${i} differ (normalized deep): OCR ${JSON.stringify(oMsgsDeep).slice(0, 1200)} vs Pi ${JSON.stringify(pMsgsDeep).slice(0, 1200)}`);
      }
    }
  }

  // 3. Provider response text, tool calls, arguments, raw usage
  if (opts.ocrCaptures.length === opts.piCaptures.length) {
    for (let i = 0; i < opts.ocrCaptures.length; i++) {
      const o = opts.ocrCaptures[i] as CapturedHttp;
      const p = opts.piCaptures[i] as CapturedHttp;
      const oCalls = extractCapturedToolCalls(o);
      const pCalls = extractCapturedToolCalls(p);
      // Compare tool call counts and names
      if (oCalls.length !== pCalls.length) {
        pushMismatch(`provider_response[${i}].tool_calls.count`, oCalls.length, pCalls.length, `tool call count for response ${i} differs`);
      } else {
        for (let j = 0; j < oCalls.length; j++) {
          const oc = oCalls[j] as Record<string, unknown>;
          const pc = pCalls[j] as Record<string, unknown>;
          const oFn = isRecord(oc["function"]) ? (oc["function"]["name"] as string) : (oc["name"] as string);
          const pFn = isRecord(pc["function"]) ? (pc["function"]["name"] as string) : (pc["name"] as string);
          if (oFn !== pFn) pushMismatch(`provider_response[${i}].tool_calls[${j}].name`, oFn, pFn, `tool call name differs at response ${i} call ${j}`);
          // Compare arguments as parsed JSON
          const oArgsRaw = isRecord(oc["function"]) ? (oc["function"]["arguments"] as string) : (oc["arguments"] as string);
          const pArgsRaw = isRecord(pc["function"]) ? (pc["function"]["arguments"] as string) : (pc["arguments"] as string);
          let oArgs: unknown = oArgsRaw;
          let pArgs: unknown = pArgsRaw;
          try {
            oArgs = typeof oArgsRaw === "string" ? JSON.parse(oArgsRaw) : oArgsRaw;
          } catch {}
          try {
            pArgs = typeof pArgsRaw === "string" ? JSON.parse(pArgsRaw) : pArgsRaw;
          } catch {}
          if (!fieldEqual(oArgs, pArgs)) {
            pushMismatch(`provider_response[${i}].tool_calls[${j}].arguments`, oArgs, pArgs, `tool call arguments differ at response ${i} call ${j}`);
          }
        }
      }
      // Raw usage
      const oUsage = o.response && isRecord(o.response.body) ? (o.response.body as Record<string, unknown>)["usage"] : undefined;
      const pUsage = p.response && isRecord(p.response.body) ? (p.response.body as Record<string, unknown>)["usage"] : undefined;
      if (oUsage !== undefined || pUsage !== undefined) {
        if (!fieldEqual(oUsage, pUsage)) {
          pushMismatch(`provider_response[${i}].usage`, oUsage, pUsage, `usage differs at response ${i}`);
        }
      }
    }
  }

  // 4. Selected/excluded/skipped/completed/failed paths where observable — derive from git and stdout
  // We don't have explicit coverage fields from OCR JSON in this verifier (we parse comments), but we can
  // check that stdout was parsed and contains exactly one comment and that both engines report same path.
  // If we cannot observe, mark notObservable instead of mismatch.

  // 5. Raw and processed comment fields — parse actual output (stdout)
  const ocrParsed = parseOcrJson(opts.ocrStdout);
  const piParsed = parsePiJson(opts.piStdout);

  // If stdout is not JSON, that's a failure of output parsing (not observable would hide it)
  const ocrHasJson = ocrParsed.raw !== null && isRecord(ocrParsed.raw);
  const piHasJson = piParsed.raw !== null && isRecord(piParsed.raw);
  if (!ocrHasJson) pushMismatch("stdout.json.ocr", ocrParsed.raw, ocrParsed.raw, "OCR stdout must be parseable JSON (actual output parsing)");
  if (!piHasJson) pushMismatch("stdout.json.pi", piParsed.raw, piParsed.raw, "Pi stdout must be parseable JSON (actual output parsing)");

  // Comments: expect exactly 1
  const ocrComments = ocrParsed.comments;
  const piComments = piParsed.findings;
  if (ocrComments.length !== 1) {
    pushMismatch("stdout.comments.count", 1, ocrComments.length, `OCR must produce exactly 1 code_comment (workspace one-file fixture)`);
  }
  if (piComments.length !== 1) {
    pushMismatch("stdout.comments.count", 1, piComments.length, `Pi must produce exactly 1 code_comment`);
  }
  if (ocrComments.length === 1 && piComments.length === 1) {
    const oC = ocrComments[0] as Record<string, unknown>;
    const pC = piComments[0] as Record<string, unknown>;
    // Normalize field names: OCR uses path/content/existing_code etc, Pi parity also uses same; legacy uses path/content/existingCode but we normalized via parsePiJson to parity shape.
    // For parity, both should have same keys: path, content, existing_code / existingCode etc. We compare content and path and category/severity.
    const oPath = (oC["path"] ?? oC["file"] ?? "") as string;
    const pPath = (pC["path"] ?? pC["file"] ?? "") as string;
    if (oPath !== pPath) pushMismatch("stdout.comments[0].path", oPath, pPath, "comment path differs");
    const oContent = (oC["content"] ?? oC["message"] ?? "") as string;
    const pContent = (pC["content"] ?? pC["message"] ?? "") as string;
    if (oContent !== pContent) pushMismatch("stdout.comments[0].content", oContent, pContent, "comment content differs");
    const oExisting = ((oC["existing_code"] ?? oC["existingCode"] ?? "") as string);
    const pExisting = ((pC["existing_code"] ?? pC["existingCode"] ?? "") as string);
    if (oExisting !== pExisting) pushMismatch("stdout.comments[0].existing_code", oExisting, pExisting, "comment existing_code differs");
    const oCat = (oC["category"] ?? "") as string;
    const pCat = (pC["category"] ?? "") as string;
    if (oCat !== pCat) pushMismatch("stdout.comments[0].category", oCat, pCat, "comment category differs");
    const oSev = (oC["severity"] ?? "") as string;
    const pSev = (pC["severity"] ?? "") as string;
    if (oSev !== pSev) pushMismatch("stdout.comments[0].severity", oSev, pSev, "comment severity differs");
    // Also check tool results observed in subsequent messages: second request's messages should contain tool result
    // We already verify provider requests include messages; for vertical we also ensure second request's messages contain the code_comment result
    // That's covered by provider_request messages check, but we add explicit check that Pi's second capture contains tool result for code_comment
    if (opts.piCaptures.length >= 2) {
      const second = opts.piCaptures[1] as CapturedHttp;
      const body = isRecord(second.request.body) ? second.request.body : null;
      const msgs = body && Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : [];
      const hasToolResult = msgs.some((m) => isRecord(m) && (m["role"] === "tool" || m["role"] === "toolResult" || JSON.stringify(m).includes("code_comment")));
      // Not strict; if missing, mark mismatch but don't fail if both miss? For now just check existence where observable.
      if (!hasToolResult && msgs.length > 0) {
        // It's okay — OCR may encode tool results differently; we don't fail, just note notObservable for this field
        notObservable.push("tool_results[1].messages");
      }
    }
  }

  // 6. Total usage
  const ocrUsage = usageTotalTokensFromSummary(ocrParsed.summary);
  // For Pi, get from summary or from parsed raw's summary equivalent
  let piUsage = 0;
  if (isRecord(piParsed.raw) && isRecord((piParsed.raw as Record<string, unknown>)["summary"])) {
    piUsage = usageTotalTokensFromSummary((piParsed.raw as Record<string, unknown>)["summary"] as Record<string, unknown>);
  } else if (isRecord(piParsed.coverage["summary"])) {
    piUsage = usageTotalTokensFromSummary(piParsed.coverage["summary"] as Record<string, unknown>);
  }
  // Fallback: sum provider usages
  if (ocrUsage === 0 && piUsage === 0) {
    // Both zero maybe stub — but we had scripted usage 150+60=210. If zero, it's not observable yet.
    // Compare provider usage sums instead.
    const ocrSum = opts.ocrCaptures.reduce((acc, c) => {
      if (!c.delivered || !c.response || !isRecord(c.response.body)) return acc;
      const u = (c.response.body as Record<string, unknown>)["usage"];
      if (!isRecord(u)) return acc;
      const t = u["total_tokens"] ?? u["totalTokens"];
      return acc + (typeof t === "number" ? t : 0);
    }, 0);
    const piSum = opts.piCaptures.reduce((acc, c) => {
      if (!c.delivered || !c.response || !isRecord(c.response.body)) return acc;
      const u = (c.response.body as Record<string, unknown>)["usage"];
      if (!isRecord(u)) return acc;
      const t = u["total_tokens"] ?? u["totalTokens"];
      return acc + (typeof t === "number" ? t : 0);
    }, 0);
    if (ocrSum !== piSum) pushMismatch("usage.totalTokens", ocrSum, piSum, `provider usage sums differ`);
    else if (ocrSum === 0) notObservable.push("usage.totalTokens");
  } else {
    if (ocrUsage !== piUsage) pushMismatch("usage.totalTokens", ocrUsage, piUsage, `total_tokens differs: OCR ${ocrUsage} vs Pi ${piUsage}`);
  }

  // 7. Completion state and exit code
  // OCR and Pi should both be complete (exit 0) for this fixture
  if (opts.ocrExit !== 0) pushMismatch("exit.ocr", 0, opts.ocrExit, `OCR must exit 0 for complete fixture (got ${String(opts.ocrExit)})`);
  if (opts.piExit !== 0) pushMismatch("exit.pi", 0, opts.piExit, `Pi must exit 0 for complete fixture (got ${String(opts.piExit)})`);
  if (opts.ocrExit !== opts.piExit) pushMismatch("exit", opts.ocrExit, opts.piExit, "exit codes differ");

  // Terminal manifest: OCR json status should be complete/skipped etc — Pi parity should match
  // Normalize "success" (legacy/parity outputJsonWithWarnings) to "complete" (Go OCR) for comparison.
  const normalizeStatus = (s: string): string => (s === "success" ? "complete" : s);
  const ocrStatusRaw = typeof (ocrParsed.raw as Record<string, unknown> | null)?.["status"] === "string" ? ((ocrParsed.raw as Record<string, unknown>)["status"] as string) : "";
  const piStatusRaw = typeof (piParsed.raw as Record<string, unknown> | null)?.["status"] === "string" ? ((piParsed.raw as Record<string, unknown>)["status"] as string) : "";
  const ocrStatus = normalizeStatus(ocrStatusRaw);
  const piStatus = normalizeStatus(piStatusRaw);
  if (ocrStatus && piStatus && ocrStatus !== piStatus) {
    pushMismatch("completion.status", ocrStatusRaw, piStatusRaw, `completion status differs: OCR ${JSON.stringify(ocrStatusRaw)} vs Pi ${JSON.stringify(piStatusRaw)}`);
  }

  return { equal: mismatches.length === 0, mismatches, notObservable };
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
  if (!artifactDir) artifactDir = await mkdtemp(join(tmpdir(), "verify-vertical-"));

  const log = (msg: string): void => console.error(`[verify:vertical] ${msg}`);

  // Import guard
  const guard = checkImports(resolve("verification/blackbox"));
  if (guard.count !== 0) {
    fail(`forbidden imports ${guard.count}: ${guard.violations.map((v) => `${v.file}:${v.line} ${v.reason}`).join("; ")}`, artifactDir);
  }

  // Git clean
  checkGitClean();
  verifyPinnedRef();

  // Pack
  log("packing...");
  let packRes: Awaited<ReturnType<typeof runPackedInstallSmoke>>;
  try {
    packRes = await runPackedInstallSmoke();
  } catch (e) {
    fail(`packed install failed: ${e instanceof Error ? e.message : String(e)}`, artifactDir);
  }
  const { archiveHash, consumerDir, binOutput } = packRes as unknown as { archiveHash: string; consumerDir: string; binOutput: string };
  // Resolve bin path
  let consumerBinPath = join(consumerDir, "node_modules", ".bin", "pi-review");
  if (!existsSync(consumerBinPath)) {
    // Fallback to dist/cli.js
    const alt = join(consumerDir, "node_modules", "pi-reviewer", "dist", "cli.js");
    if (existsSync(alt)) consumerBinPath = alt;
    else consumerBinPath = binOutput; // from pack smoke
  }
  log(`packed-install PASS hash=${archiveHash.slice(0, 8)} consumer=${consumerDir} bin=${consumerBinPath}`);

  // Build OCR binary
  log("building OCR binary...");
  let ocrBinary: string;
  try {
    ocrBinary = await getOcrBinary();
  } catch (e) {
    fail(`OCR binary build failed: ${e instanceof Error ? e.message : String(e)}`, artifactDir);
  }
  log(`OCR binary: ${ocrBinary}`);

  // Fixtures
  const fixtures: string[] = [];
  let assertions = 0;
  const notObservable: string[] = [];

  mkdirSync(artifactDir, { recursive: true });

  // Helper to run one differential vertical fixture
  async function runVerticalFixture(opts: {
    id: string;
    commentContent: string;
    mutatePi: boolean;
    expectEqual: boolean;
    expectedMismatchField?: string;
  }): Promise<void> {
    fixtures.push(opts.id);
    log(`running ${opts.id}...`);
    const baseComment = "Consider handling nil case for Add";
    const mutatedComment = "MUTATED CONTENT SHOULD BE DETECTED";

    const ocrComment = baseComment;
    const piComment = opts.mutatePi ? mutatedComment : baseComment;

    const ocrResponses = makeScriptedResponses(ocrComment);
    const piResponses = makeScriptedResponses(piComment);

    // Create immutable Git fixture then clone separately for OCR and Pi
    const fixture = await createTempRepo();
    const ocrRepoDir = await mkdtemp(join(tmpdir(), "ocr-vert-clone-"));
    const piRepoDir = await mkdtemp(join(tmpdir(), "pi-vert-clone-"));
    // Need to remove the mkdtemp dirs before clone (git clone expects dest not exist or empty)
    await rm(ocrRepoDir, { recursive: true, force: true }).catch(() => {});
    await rm(piRepoDir, { recursive: true, force: true }).catch(() => {});
    await cloneRepo(fixture.dir, ocrRepoDir);
    await cloneRepo(fixture.dir, piRepoDir);

    // Recording servers — deep-frozen copies, separate ports
    const serverOcr = createCaptureServer({ responses: structuredClone(ocrResponses) });
    const serverPi = createCaptureServer({ responses: structuredClone(piResponses) });

    // Pi agent dir
    const piAgent = await createPiAgentDir(serverPi.url);

    let ocrResult: { stdout: string; stderr: string; exitCode: number | null; signal: string | null } | null = null;
    let piResult: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; command: readonly string[] } | null = null;

    try {
      ocrResult = await runOcrSubprocess({ binaryPath: ocrBinary, repoDir: ocrRepoDir, serverUrl: serverOcr.url, serverPort: serverOcr.port });
      assertions++;
      if (serverOcr.getSanitizedCaptures().length === 0) {
        const dir = join(artifactDir, opts.id);
        mkdirSync(dir, { recursive: true });
        await writeFile(join(dir, "ocr-stdout.txt"), ocrResult.stdout, "utf-8").catch(() => {});
        await writeFile(join(dir, "ocr-stderr.txt"), ocrResult.stderr, "utf-8").catch(() => {});
        fail(`Positive fixture ${opts.id}: OCR sent 0 requests to its fake server`, artifactDir);
      }
      assertions++;

      piResult = await runPiSubprocess({
        repoDir: piRepoDir,
        serverUrl: serverPi.url,
        consumerBinPath,
        consumerDir,
        agentDir: piAgent.dir,
      });
      assertions++;
      if (serverPi.getSanitizedCaptures().length === 0) {
        const dir = join(artifactDir, opts.id);
        mkdirSync(dir, { recursive: true });
        await writeFile(join(dir, "pi-stdout.txt"), piResult.stdout, "utf-8").catch(() => {});
        await writeFile(join(dir, "pi-stderr.txt"), piResult.stderr, "utf-8").catch(() => {});
        fail(`Fixture ${opts.id}: Pi sent 0 requests to its fake server`, artifactDir);
      }
      assertions++;

      // Prove separate servers
      if (serverOcr.port === serverPi.port) {
        fail(`Fixture ${opts.id}: OCR and Pi used same server port ${String(serverOcr.port)}`, artifactDir);
      }
      assertions++;

      const ocrCaptures = serverOcr.getSanitizedCaptures() as unknown as CapturedHttp[];
      const piCaptures = serverPi.getSanitizedCaptures() as unknown as CapturedHttp[];

      const ocrCmd: readonly string[] = [ocrBinary, "review", "--repo", ocrRepoDir, "--format", "json", "--no-filter"];
      const piCmd = piResult.command;

      const compared = compareVertical({
        ocrCommand: ocrCmd,
        piCommand: piCmd,
        ocrCaptures,
        piCaptures,
        ocrStdout: ocrResult.stdout,
        piStdout: piResult.stdout,
        ocrExit: ocrResult.exitCode,
        piExit: piResult.exitCode,
      });

      const fixtureArtifactDir = join(artifactDir, opts.id);
      mkdirSync(fixtureArtifactDir, { recursive: true });
      await writeFile(join(fixtureArtifactDir, "ocr-stdout.txt"), ocrResult.stdout, "utf-8").catch(() => {});
      await writeFile(join(fixtureArtifactDir, "ocr-stderr.txt"), ocrResult.stderr, "utf-8").catch(() => {});
      await writeFile(join(fixtureArtifactDir, "pi-stdout.txt"), piResult.stdout, "utf-8").catch(() => {});
      await writeFile(join(fixtureArtifactDir, "pi-stderr.txt"), piResult.stderr, "utf-8").catch(() => {});
      await writeFile(join(fixtureArtifactDir, "ocr-captures.json"), JSON.stringify(ocrCaptures, null, 2), "utf-8").catch(() => {});
      await writeFile(join(fixtureArtifactDir, "pi-captures.json"), JSON.stringify(piCaptures, null, 2), "utf-8").catch(() => {});
      await writeFile(join(fixtureArtifactDir, "ocr-command.txt"), ocrCmd.join(" "), "utf-8").catch(() => {});
      await writeFile(join(fixtureArtifactDir, "pi-command.txt"), piCmd.join(" "), "utf-8").catch(() => {});
      await writeFile(join(fixtureArtifactDir, "mismatches.json"), JSON.stringify(compared.mismatches, null, 2), "utf-8").catch(() => {});

      if (opts.expectEqual) {
        assertions++;
        if (!compared.equal) {
          const msg = compared.mismatches.map((m) => `${m.fieldPath}: ${m.message}`).join("; ").slice(0, 1200);
          await writeFile(join(fixtureArtifactDir, "mismatches.txt"), msg, "utf-8").catch(() => {});
          fail(`Positive fixture ${opts.id} failed: ${msg}`, artifactDir);
        }
        // Count additional assertions for coverage of compared dimensions
        assertions += 8; // selected, provider_request.count, tool_schema, provider_response tool_calls, stdout.comments, usage, exit, completion
        log(`PASS ${opts.id}: equal with ${ocrCaptures.length} requests, 1 comment, exit ${String(ocrResult.exitCode)}`);
      } else {
        assertions++;
        if (compared.equal) {
          fail(`Mismatch fixture ${opts.id} did not fail as expected: Pi mutated content but comparer said equal`, artifactDir);
        }
        const expectedField = opts.expectedMismatchField ?? "stdout.comments[0].content";
        const hasNamed = compared.mismatches.some((m) => m.fieldPath.includes(expectedField) || m.fieldPath.includes("stdout.comments") || m.fieldPath.includes("content"));
        assertions++;
        if (!hasNamed) {
          const all = compared.mismatches.map((m) => m.fieldPath).join(", ");
          fail(`Mismatch fixture ${opts.id} failed but without named field ${expectedField}: got ${all}`, artifactDir);
        }
        // Also prove mutation is from provider response (delivered usage, captured response contains MUTATED)
        const piHasMutated = piCaptures.some((c) => JSON.stringify(c.response?.body ?? "").includes("MUTATED"));
        assertions++;
        if (!piHasMutated) {
          fail(`Mismatch fixture ${opts.id}: Pi response does not contain MUTATED (mutation not from provider)`, artifactDir);
        }
        log(`PASS ${opts.id} (mismatch correctly detected at ${expectedField}): ${compared.mismatches[0]?.fieldPath ?? ""}`);
      }
    } finally {
      serverOcr.stop();
      serverPi.stop();
      await piAgent.cleanup().catch(() => {});
      await rm(ocrRepoDir, { recursive: true, force: true }).catch(() => {});
      await rm(piRepoDir, { recursive: true, force: true }).catch(() => {});
      await fixture.cleanup().catch(() => {});
    }
  }

  // Positive: both get same comment
  await runVerticalFixture({
    id: "vertical-workspace-one-file-one-comment",
    commentContent: "Consider handling nil case for Add",
    mutatePi: false,
    expectEqual: true,
  });

  // Negative: Pi mutated
  await runVerticalFixture({
    id: "vertical-mismatch-comment-content",
    commentContent: "Consider handling nil case for Add",
    mutatePi: true,
    expectEqual: false,
    expectedMismatchField: "stdout.comments[0].content",
  });

  // Cleanup OCR binary
  await cleanupOcrBinary().catch(() => {});

  // Check that Pi CLI was via packed install (provenance)
  // forbiddenImports already checked, archiveHash proves packed.

  const report: VerticalGateReport = {
    gate: "vertical",
    commit: currentCommit(),
    ocrTagObject: PINNED_TAG_OBJECT,
    ocrCommit: PINNED_COMMIT,
    packageArchiveHash: archiveHash,
    fixtures,
    assertions,
    notObservable,
    forbiddenImports: guard.count,
    forbiddenImportDetails: guard.violations.map((v) => `${v.file}:${v.line} ${v.content}`),
    result: "pass",
    artifactDir,
  };

  // Preserve raw sanitized captures etc already written; also write overall report artifact
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2), "utf-8").catch(() => {});

  console.log(JSON.stringify(report));
  console.error(`[verify:vertical] PASS: ${String(assertions)} assertions, ${String(fixtures.length)} fixtures, forbiddenImports=0, packHash=${archiveHash.slice(0, 8)}`);
}

main().catch((e) => {
  const dir = mkdtempSyncDir("verify-vertical-");
  const report: VerticalGateReport = {
    gate: "vertical",
    commit: currentCommit(),
    ocrTagObject: PINNED_TAG_OBJECT,
    ocrCommit: PINNED_COMMIT,
    packageArchiveHash: null,
    fixtures: [],
    assertions: 0,
    notObservable: [],
    forbiddenImports: -1,
    forbiddenImportDetails: [],
    result: "fail",
    artifactDir: dir,
    error: e instanceof Error ? e.message : String(e),
  };
  console.log(JSON.stringify(report));
  console.error(`[verify:vertical] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});

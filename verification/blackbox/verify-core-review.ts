#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Gate 2 — One real OCR/Pi vertical slice (black-box)
// See docs/ocr-v1.9.3-port-plan.md Gate 2.

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

const PINNED_TAG = "v1.9.3";
const PINNED_TAG_OBJECT = "4d796ae54cabdcf4e22b69ef502ed8871456a909";
const PINNED_COMMIT = "c35ddd7223f2b5540ce03aa43c9a25ef643fca27";

interface CoreReviewGateReport {
  readonly gate: "core-review";
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
  const report: CoreReviewGateReport = {
    gate: "core-review",
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
  } as unknown as CoreReviewGateReport;
  console.log(JSON.stringify(report));
  console.error(`[verify:core-review] FAIL: ${message}`);
  if (artifactDir) console.error(`Artifacts: ${artifactDir}`);
  process.exit(1);
}

function checkGitClean(): void {
  const diff = spawnSync("git", ["diff", "--quiet"], { stdio: "ignore", timeout: 5000 });
  if (diff.status !== 0) fail("dirty working tree (uncommitted changes). Commit or stash first.", mkdtempSyncDir("verify-core-review-"));
  const untrackedRes = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf-8", timeout: 5000 });
  const untracked = ((untrackedRes.stdout as string) ?? "").trim();
  if (untracked.length > 0) fail(`untracked files present:\n${untracked}`, mkdtempSyncDir("verify-core-review-"));
}

function mkdtempSyncDir(prefix: string): string {
  // Use Node fs mkdtempSync directly (imported sync version via dynamic require to avoid top-level import issues)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require("node:fs") as { mkdtempSync: (p: string) => string };
  return fsSync.mkdtempSync(join(tmpdir(), prefix));
}

function verifyPinnedRef(): void {
  const refCheckout = resolve(import.meta.dir, "../../../open-code-review");
  if (!existsSync(refCheckout)) fail(`pinned checkout missing at ${refCheckout}`, mkdtempSyncDir("verify-core-review-"));
  const commitRes = spawnSync("git", ["rev-parse", `${PINNED_TAG}^{commit}`], { cwd: refCheckout, encoding: "utf-8", timeout: 5000 });
  const commit = ((commitRes.stdout as string) ?? "").trim();
  if (commitRes.status !== 0 || commit !== PINNED_COMMIT) {
    fail(`pinned commit mismatch: expected ${PINNED_COMMIT} got ${JSON.stringify(commit)}`, mkdtempSyncDir("verify-core-review-"));
  }
  const tagRes = spawnSync("git", ["rev-parse", PINNED_TAG], { cwd: refCheckout, encoding: "utf-8", timeout: 5000 });
  const tagObj = ((tagRes.stdout as string) ?? "").trim();
  if (tagObj !== PINNED_TAG_OBJECT) {
    fail(`pinned tag object mismatch: got ${JSON.stringify(tagObj)} want ${PINNED_TAG_OBJECT}`, mkdtempSyncDir("verify-core-review-"));
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
  const buildDir = await mkdtemp(join(tmpdir(), "ocr-v193-build-"));
  cachedOcrBuildDir = buildDir;
  const archivePath = join(buildDir, "ocr.tar");
  const archiveRes = spawnSync("git", ["archive", "--format=tar", "-o", archivePath, PINNED_TAG], { cwd: refCheckout, encoding: "utf-8", timeout: 15000 });
  if (archiveRes.status !== 0) throw new Error(`git archive ${PINNED_TAG} failed: ${archiveRes.stderr ?? archiveRes.stdout}`);
  const extractDir = join(buildDir, "src");
  mkdirSync(extractDir, { recursive: true });
  const tarRes = spawnSync("tar", ["-xf", archivePath, "-C", extractDir], { encoding: "utf-8", timeout: 10000 });
  if (tarRes.status !== 0) throw new Error(`tar extract failed: ${tarRes.stderr ?? tarRes.stdout}`);
  const binaryPath = join(buildDir, "ocr-v1.9.3");
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
// Git fixture helpers (no import of test/ocr-v193/harness)
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

async function createPreviewRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-core-preview-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  gitSync(dir, ["init", "-q"]);
  gitSync(dir, ["config", "user.email", "harness@pi-reviewer.test"]);
  gitSync(dir, ["config", "user.name", "harness"]);
  gitSync(dir, ["config", "commit.gpgsign", "false"]);
  const fixedDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: fixedDate, GIT_COMMITTER_DATE: fixedDate };
  await writeFile(join(dir, "main.go"), "package main\nfunc Add(a int, b int) int { return a + b }\n", "utf-8");
  await writeFile(join(dir, "README.md"), "# test\n", "utf-8");
  await writeFile(join(dir, "foo_test.go"), "package main\nfunc TestFoo(t *testing.T) {}\n", "utf-8");
  let res = spawnSync("git", ["add", "-A"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git add failed: ${res.stderr}`);
  res = spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr}`);
  await writeFile(join(dir, "main.go"), "package main\nfunc Add(a int, b int) int {\n  // changed\n  return a + b\n}\n", "utf-8");
  await writeFile(join(dir, "app.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  mkdirSync(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/page.md"), "# page\n", "utf-8");
  res = spawnSync("git", ["rm", "-q", "README.md"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git rm failed: ${res.stderr}`);
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
// Family fixture creators
// ---------------------------------------------------------------------------

async function createTwoCommitRepo(): Promise<{ dir: string; secondCommit: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-core-two-commit-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
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
  await writeFile(join(dir, "main.go"), "package main\nfunc Add(a int, b int) int {\n  // TODO: handle nil?\n  return a + b\n}\n", "utf-8");
  res = spawnSync("git", ["add", "-A"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git add failed: ${res.stderr}`);
  res = spawnSync("git", ["commit", "-q", "-m", "add nil guard"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr}`);
  const secondCommit = gitSync(dir, ["rev-parse", "HEAD"]);
  return { dir, secondCommit, cleanup };
}

async function createMultiFileRepo(fileNames: readonly string[]): Promise<{ dir: string; files: readonly string[]; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-core-multi-file-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  gitSync(dir, ["init", "-q"]);
  gitSync(dir, ["config", "user.email", "harness@pi-reviewer.test"]);
  gitSync(dir, ["config", "user.name", "harness"]);
  gitSync(dir, ["config", "commit.gpgsign", "false"]);
  const fixedDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: fixedDate, GIT_COMMITTER_DATE: fixedDate };
  for (const f of fileNames) {
    await writeFile(join(dir, f), `package main\nfunc Func${f.replace(/\W/g, "")}() int { return 1 }\n`, "utf-8");
  }
  let res = spawnSync("git", ["add", "-A"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git add failed: ${res.stderr}`);
  res = spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr}`);
  for (const f of fileNames) {
    await writeFile(join(dir, f), `package main\nfunc Func${f.replace(/\W/g, "")}() int {\n  // TODO: handle nil?\n  return 1\n}\n`, "utf-8");
  }
  return { dir, files: [...fileNames].sort(), cleanup };
}

// ---------------------------------------------------------------------------
// Family response makers
// ---------------------------------------------------------------------------

function makeCodeCommentResponse(
  content: string,
  existingCode: string,
  path: string,
  usage: { readonly prompt: number; readonly completion: number; readonly total: number },
  id: string,
  created: number,
): unknown {
  return {
    id,
    object: "chat.completion",
    created,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `${id}-cc`,
              type: "function",
              function: {
                name: "code_comment",
                arguments: JSON.stringify({
                  path,
                  comments: [{ content, existing_code: existingCode, category: "bug", severity: "medium" }],
                }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total },
  };
}

function makeTaskDoneResponse(
  state: string,
  usage: { readonly prompt: number; readonly completion: number; readonly total: number },
  id: string,
  created: number,
): unknown {
  return {
    id,
    object: "chat.completion",
    created,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `${id}-td`,
              type: "function",
              function: { name: "task_done", arguments: JSON.stringify({ state }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total },
  };
}

function makeOneCommentResponses(content: string, existingCode: string, path = "main.go"): readonly unknown[] {
  return [
    makeCodeCommentResponse(content, existingCode, path, { prompt: 100, completion: 50, total: 150 }, "chatcmpl-main-1", 1),
    makeTaskDoneResponse("DONE", { prompt: 50, completion: 10, total: 60 }, "chatcmpl-main-2", 2),
  ];
}

function makeFilterResponses(
  content: string,
  existingCode: string,
  path: string,
  judgment: "keep" | "remove",
): readonly unknown[] {
  const ids = judgment === "remove" ? ["c-0"] : [];
  return [
    makeCodeCommentResponse(content, existingCode, path, { prompt: 100, completion: 50, total: 150 }, "chatcmpl-filter-1", 1),
    makeTaskDoneResponse("DONE", { prompt: 50, completion: 10, total: 60 }, "chatcmpl-filter-2", 2),
    {
      id: "chatcmpl-filter-3",
      object: "chat.completion",
      created: 3,
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(ids), tool_calls: [] },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    },
  ];
}

function makeMultiFileResponses(
  files: readonly string[],
  content: string,
  existingCode: string,
): readonly unknown[] {
  const responses: unknown[] = [];
  let n = 1;
  for (const f of files) {
    responses.push(makeCodeCommentResponse(content, existingCode, f, { prompt: 100, completion: 50, total: 150 }, `chatcmpl-mf-${n}`, n));
    n++;
    responses.push(makeTaskDoneResponse("DONE", { prompt: 50, completion: 10, total: 60 }, `chatcmpl-mf-${n}`, n));
    n++;
  }
  return responses;
}

function makeIncompleteResponses(content: string, existingCode: string, path = "main.go", rounds = 30): readonly unknown[] {
  const responses: unknown[] = [];
  responses.push({
    id: "chatcmpl-inc-0",
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
              id: "call-inc-0-a",
              type: "function",
              function: {
                name: "code_comment",
                arguments: JSON.stringify({
                  path,
                  comments: [{ content, existing_code: existingCode, category: "bug", severity: "medium" }],
                }),
              },
            },
            {
              id: "call-inc-0-b",
              type: "function",
              function: { name: "task_done", arguments: JSON.stringify({ state: "INCOMPLETE" }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
  for (let i = 1; i <= rounds + 1; i++) {
    responses.push(makeTaskDoneResponse("INCOMPLETE", { prompt: 10, completion: 5, total: 15 }, `chatcmpl-inc-${i}`, i + 1));
  }
  return responses;
}

function makePartialResponses(
  completeFile: string,
  incompleteFile: string,
  content: string,
  existingCode: string,
  rounds = 30,
): readonly unknown[] {
  const responses: unknown[] = [];
  // File that completes successfully.
  responses.push(makeCodeCommentResponse(content, existingCode, completeFile, { prompt: 100, completion: 50, total: 150 }, "chatcmpl-partial-0", 1));
  responses.push(makeTaskDoneResponse("DONE", { prompt: 50, completion: 10, total: 60 }, "chatcmpl-partial-1", 2));
  // File that maxes out its tool-request budget.
  responses.push(...makeIncompleteResponses(content, existingCode, incompleteFile, rounds));
  return responses;
}

// ---------------------------------------------------------------------------
// Subprocess runners — capture stdout/stderr + provider traffic
// ---------------------------------------------------------------------------

async function runOcrSubprocess(opts: {
  binaryPath: string;
  repoDir: string;
  serverUrl: string;
  serverPort: number;
  command?: readonly string[];
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
  const extra = opts.command ?? ["--format", "json", "--no-filter"];
  const args = ["review", "--repo", opts.repoDir, "--concurrency", "1", ...extra];
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
  command?: readonly string[];
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
  // Use packed pi-review bin with --engine ocr-v193 to get parity behavior.
  const extra = opts.command ?? ["--no-filter", "--json"];
  const hasPreview = extra.includes("--preview");
  const args = ["--engine", "ocr-v193", "--repo", opts.repoDir, "--concurrency", "1", ...extra];
  if (!hasPreview) {
    // Preview does not require or accept --model.
    args.splice(4, 0, "--model", "test-openai/test-model");
  }
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
  // Parity Pi engine (ocr-v193) emits OCR-shaped JSON: comments[] + summary. Legacy emits findings[] + coverage.
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

interface CompareCoreOptions {
  ocrCommand: readonly string[];
  piCommand: readonly string[];
  ocrCaptures: readonly CapturedHttp[];
  piCaptures: readonly CapturedHttp[];
  ocrStdout: string;
  piStdout: string;
  ocrExit: number | null;
  piExit: number | null;
  expectedCommentCount?: number;
  expectedStatus?: string;
  expectedExit?: number;
  requireLineNumbers?: boolean;
}

function compareCoreReview(opts: CompareCoreOptions): { equal: boolean; mismatches: FieldMismatch[]; notObservable: string[] } {
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
  if (!piCmdStr.includes("--engine ocr-v193")) {
    pushMismatch("process.command.pi.engine", piCmdStr, piCmdStr, "Pi command must contain --engine ocr-v193 (packed installed Pi CLI)");
  }
  if (!piCmdStr.includes("--repo") || !piCmdStr.includes("--json")) {
    pushMismatch("process.command.pi", piCmdStr, piCmdStr, "Pi command must be pi-review --engine ocr-v193 --repo <dir> --model ... --json");
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

  // Comments: expect configured count (default 1)
  const expectedCommentCount = opts.expectedCommentCount ?? 1;
  const ocrComments = ocrParsed.comments;
  const piComments = piParsed.findings;
  if (ocrComments.length !== expectedCommentCount) {
    pushMismatch("stdout.comments.count", expectedCommentCount, ocrComments.length, `OCR must produce ${expectedCommentCount} code_comment(s)`);
  }
  if (piComments.length !== expectedCommentCount) {
    pushMismatch("stdout.comments.count", expectedCommentCount, piComments.length, `Pi must produce ${expectedCommentCount} code_comment(s)`);
  }
  if (ocrComments.length === expectedCommentCount && piComments.length === expectedCommentCount) {
    for (let idx = 0; idx < expectedCommentCount; idx++) {
      const oC = ocrComments[idx] as Record<string, unknown>;
      const pC = piComments[idx] as Record<string, unknown>;
      const prefix = `stdout.comments[${idx}]`;
      // Normalize field names: OCR uses path/content/existing_code etc, Pi parity also uses same; legacy uses path/content/existingCode but we normalized via parsePiJson to parity shape.
      const oPath = (oC["path"] ?? oC["file"] ?? "") as string;
      const pPath = (pC["path"] ?? pC["file"] ?? "") as string;
      if (oPath !== pPath) pushMismatch(`${prefix}.path`, oPath, pPath, `comment path differs at index ${idx}`);
      const oContent = (oC["content"] ?? oC["message"] ?? "") as string;
      const pContent = (pC["content"] ?? pC["message"] ?? "") as string;
      if (oContent !== pContent) pushMismatch(`${prefix}.content`, oContent, pContent, `comment content differs at index ${idx}`);
      const oExisting = ((oC["existing_code"] ?? oC["existingCode"] ?? "") as string);
      const pExisting = ((pC["existing_code"] ?? pC["existingCode"] ?? "") as string);
      if (oExisting !== pExisting) pushMismatch(`${prefix}.existing_code`, oExisting, pExisting, `comment existing_code differs at index ${idx}`);
      const oCat = (oC["category"] ?? "") as string;
      const pCat = (pC["category"] ?? "") as string;
      if (oCat !== pCat) pushMismatch(`${prefix}.category`, oCat, pCat, `comment category differs at index ${idx}`);
      const oSev = (oC["severity"] ?? "") as string;
      const pSev = (pC["severity"] ?? "") as string;
      if (oSev !== pSev) pushMismatch(`${prefix}.severity`, oSev, pSev, `comment severity differs at index ${idx}`);
      const oStartLine = typeof oC["start_line"] === "number" ? (oC["start_line"] as number) : typeof oC["startLine"] === "number" ? (oC["startLine"] as number) : 0;
      const pStartLine = typeof pC["start_line"] === "number" ? (pC["start_line"] as number) : typeof pC["startLine"] === "number" ? (pC["startLine"] as number) : 0;
      if (oStartLine !== pStartLine) pushMismatch(`${prefix}.start_line`, oStartLine, pStartLine, `comment start_line differs at index ${idx}`);
      const oEndLine = typeof oC["end_line"] === "number" ? (oC["end_line"] as number) : typeof oC["endLine"] === "number" ? (oC["endLine"] as number) : 0;
      const pEndLine = typeof pC["end_line"] === "number" ? (pC["end_line"] as number) : typeof pC["endLine"] === "number" ? (pC["endLine"] as number) : 0;
      if (oEndLine !== pEndLine) pushMismatch(`${prefix}.end_line`, oEndLine, pEndLine, `comment end_line differs at index ${idx}`);
      if (opts.requireLineNumbers && (oStartLine <= 0 || pStartLine <= 0)) {
        pushMismatch(`${prefix}.start_line.resolved`, oStartLine, pStartLine, `expected resolved start_line > 0 at index ${idx}`);
      }
    }
    if (opts.piCaptures.length >= 2) {
      const second = opts.piCaptures[1] as CapturedHttp;
      const body = isRecord(second.request.body) ? second.request.body : null;
      const msgs = body && Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : [];
      const hasToolResult = msgs.some((m) => isRecord(m) && (m["role"] === "tool" || m["role"] === "toolResult" || JSON.stringify(m).includes("code_comment")));
      if (!hasToolResult && msgs.length > 0) {
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
  const expectedExit = opts.expectedExit ?? 0;
  const expectedStatus = opts.expectedStatus ?? "complete";
  if (opts.ocrExit !== expectedExit) pushMismatch("exit.ocr", expectedExit, opts.ocrExit, `OCR must exit ${expectedExit} for this fixture (got ${String(opts.ocrExit)})`);
  if (opts.piExit !== expectedExit) pushMismatch("exit.pi", expectedExit, opts.piExit, `Pi must exit ${expectedExit} for this fixture (got ${String(opts.piExit)})`);
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
  } else if (ocrStatus && ocrStatus !== expectedStatus && opts.expectedStatus !== undefined) {
    pushMismatch("completion.status.ocr", expectedStatus, ocrStatus, `OCR status ${JSON.stringify(ocrStatus)} does not match expected ${JSON.stringify(expectedStatus)}`);
  } else if (piStatus && piStatus !== expectedStatus && opts.expectedStatus !== undefined) {
    pushMismatch("completion.status.pi", expectedStatus, piStatus, `Pi status ${JSON.stringify(piStatus)} does not match expected ${JSON.stringify(expectedStatus)}`);
  }

  return { equal: mismatches.length === 0, mismatches, notObservable };
}

function comparePreview(opts: {
  ocrCommand: readonly string[];
  piCommand: readonly string[];
  ocrStdout: string;
  piStdout: string;
  ocrExit: number | null;
  piExit: number | null;
}): { equal: boolean; mismatches: FieldMismatch[] } {
  const mismatches: FieldMismatch[] = [];
  const pushMismatch = (fieldPath: string, ocrValue: unknown, piValue: unknown, message: string): void => {
    mismatches.push({ fieldPath, ocrValue, piValue, message });
  };

  if (opts.ocrExit !== 0) pushMismatch("exit.ocr", 0, opts.ocrExit, `OCR preview must exit 0 (got ${String(opts.ocrExit)})`);
  if (opts.piExit !== 0) pushMismatch("exit.pi", 0, opts.piExit, `Pi preview must exit 0 (got ${String(opts.piExit)})`);
  if (opts.ocrExit !== opts.piExit) pushMismatch("exit", opts.ocrExit, opts.piExit, "exit codes differ");

  const ocrCmdStr = opts.ocrCommand.join(" ");
  const piCmdStr = opts.piCommand.join(" ");
  if (ocrCmdStr === piCmdStr) {
    pushMismatch("process.identity", opts.ocrCommand, opts.piCommand, "engine identity collision");
  }
  if (!ocrCmdStr.includes("review") || !ocrCmdStr.includes("--repo") || !ocrCmdStr.includes("--preview")) {
    pushMismatch("process.command.ocr", ocrCmdStr, ocrCmdStr, "OCR preview command must contain review --repo --preview");
  }
  if (!piCmdStr.includes("--engine ocr-v193") || !piCmdStr.includes("--preview")) {
    pushMismatch("process.command.pi", piCmdStr, piCmdStr, "Pi preview command must contain --engine ocr-v193 --preview");
  }

  const parsePreview = (s: string): Record<string, unknown> | null => {
    const trimmed = s.trim();
    const start = trimmed.indexOf("{");
    const jsonStr = start >= 0 ? trimmed.slice(start) : trimmed;
    try {
      const parsed: unknown = JSON.parse(jsonStr);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const ocrParsed = parsePreview(opts.ocrStdout);
  const piParsed = parsePreview(opts.piStdout);
  if (!isRecord(ocrParsed)) {
    pushMismatch("stdout.json.ocr", null, null, "OCR preview stdout is not parseable JSON");
  }
  if (!isRecord(piParsed)) {
    pushMismatch("stdout.json.pi", null, null, "Pi preview stdout is not parseable JSON");
  }
  if (!ocrParsed || !piParsed) return { equal: false, mismatches };

  const compareField = (field: string): void => {
    const o = ocrParsed[field];
    const p = piParsed[field];
    if (JSON.stringify(o) !== JSON.stringify(p)) {
      pushMismatch(`stdout.${field}`, o, p, `preview field ${field} differs`);
    }
  };

  for (const field of ["files", "total_insertions", "total_deletions", "total_files", "reviewable_count", "excluded_count"]) {
    compareField(field);
  }

  const ocrFiles = Array.isArray(ocrParsed.files) ? (ocrParsed.files as unknown[]).map((e) => isRecord(e) ? JSON.stringify(Object.keys(e).sort().reduce((a: Record<string, unknown>, k) => { a[k] = (e as Record<string, unknown>)[k]; return a; }, {})) : "").sort() : [];
  const piFiles = Array.isArray(piParsed.files) ? (piParsed.files as unknown[]).map((e) => isRecord(e) ? JSON.stringify(Object.keys(e).sort().reduce((a: Record<string, unknown>, k) => { a[k] = (e as Record<string, unknown>)[k]; return a; }, {})) : "").sort() : [];
  if (JSON.stringify(ocrFiles) !== JSON.stringify(piFiles)) {
    pushMismatch("stdout.files.deep", ocrParsed.files, piParsed.files, "preview files entries differ");
  }

  return { equal: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Family runner helpers
// ---------------------------------------------------------------------------

interface FixtureContext {
  artifactDir: string;
  ocrBinary: string;
  consumerBinPath: string;
  consumerDir: string;
}

interface FamilyResult {
  fixtureId: string;
  equal: boolean;
  assertions: number;
  notObservable: readonly string[];
  mismatches?: readonly FieldMismatch[];
}

async function runFamilyFixture(opts: {
  id: string;
  context: FixtureContext;
  makeRepo: () => Promise<{ dir: string; cleanup: () => Promise<void>; meta?: unknown }>;
  ocrCommandExtra?: readonly string[];
  piCommandExtra?: readonly string[];
  ocrResponses: readonly unknown[];
  piResponses: readonly unknown[];
  timeoutMs?: number;
}): Promise<{
  ocrResult: { stdout: string; stderr: string; exitCode: number | null; signal: string | null };
  piResult: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; command: readonly string[] };
  ocrCaptures: readonly CapturedHttp[];
  piCaptures: readonly CapturedHttp[];
  ocrRepoDir: string;
  piRepoDir: string;
  meta: unknown;
}> {
  const fixture = await opts.makeRepo();
  const ocrRepoDir = await mkdtemp(join(tmpdir(), "ocr-family-clone-"));
  const piRepoDir = await mkdtemp(join(tmpdir(), "pi-family-clone-"));
  await rm(ocrRepoDir, { recursive: true, force: true }).catch(() => {});
  await rm(piRepoDir, { recursive: true, force: true }).catch(() => {});
  await cloneRepo(fixture.dir, ocrRepoDir);
  await cloneRepo(fixture.dir, piRepoDir);

  const serverOcr = createCaptureServer({ responses: structuredClone(opts.ocrResponses) as unknown[] });
  const serverPi = createCaptureServer({ responses: structuredClone(opts.piResponses) as unknown[] });
  const piAgent = await createPiAgentDir(serverPi.url);

  const ocrExtra = opts.ocrCommandExtra ?? ["--format", "json", "--no-filter"];
  const piExtra = opts.piCommandExtra ?? ["--no-filter", "--json"];

  let ocrResult: { stdout: string; stderr: string; exitCode: number | null; signal: string | null } | null = null;
  let piResult: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; command: readonly string[] } | null = null;

  try {
    ocrResult = await runOcrSubprocess({
      binaryPath: opts.context.ocrBinary,
      repoDir: ocrRepoDir,
      serverUrl: serverOcr.url,
      serverPort: serverOcr.port,
      command: ocrExtra,
      timeoutMs: opts.timeoutMs ?? 60000,
    });
    piResult = await runPiSubprocess({
      repoDir: piRepoDir,
      serverUrl: serverPi.url,
      consumerBinPath: opts.context.consumerBinPath,
      consumerDir: opts.context.consumerDir,
      agentDir: piAgent.dir,
      command: piExtra,
      timeoutMs: opts.timeoutMs ?? 60000,
    });

    const ocrCmd: readonly string[] = [opts.context.ocrBinary, "review", "--repo", ocrRepoDir, ...ocrExtra];
    const piCmd = piResult.command;
    const ocrCaptures = serverOcr.getSanitizedCaptures() as unknown as CapturedHttp[];
    const piCaptures = serverPi.getSanitizedCaptures() as unknown as CapturedHttp[];

    const fixtureArtifactDir = join(opts.context.artifactDir, opts.id);
    mkdirSync(fixtureArtifactDir, { recursive: true });
    await writeFile(join(fixtureArtifactDir, "ocr-stdout.txt"), ocrResult.stdout, "utf-8").catch(() => {});
    await writeFile(join(fixtureArtifactDir, "ocr-stderr.txt"), ocrResult.stderr, "utf-8").catch(() => {});
    await writeFile(join(fixtureArtifactDir, "pi-stdout.txt"), piResult.stdout, "utf-8").catch(() => {});
    await writeFile(join(fixtureArtifactDir, "pi-stderr.txt"), piResult.stderr, "utf-8").catch(() => {});
    await writeFile(join(fixtureArtifactDir, "ocr-captures.json"), JSON.stringify(ocrCaptures, null, 2), "utf-8").catch(() => {});
    await writeFile(join(fixtureArtifactDir, "pi-captures.json"), JSON.stringify(piCaptures, null, 2), "utf-8").catch(() => {});
    await writeFile(join(fixtureArtifactDir, "ocr-command.txt"), ocrCmd.join(" "), "utf-8").catch(() => {});
    await writeFile(join(fixtureArtifactDir, "pi-command.txt"), piCmd.join(" "), "utf-8").catch(() => {});

    return { ocrResult, piResult, ocrCaptures, piCaptures, ocrRepoDir, piRepoDir, meta: fixture.meta };
  } finally {
    serverOcr.stop();
    serverPi.stop();
    await piAgent.cleanup().catch(() => {});
    await rm(ocrRepoDir, { recursive: true, force: true }).catch(() => {});
    await rm(piRepoDir, { recursive: true, force: true }).catch(() => {});
    await fixture.cleanup().catch(() => {});
  }
}

function familyAssertionCount(commentCount: number): number {
  // provider count, request/response parity, usage, exit, status, comment count, per-comment fields
  return 12 + commentCount * 7;
}

async function runFamily2(context: FixtureContext): Promise<FamilyResult> {
  const fixtureId = "core-relocation-line";
  const content = "Consider nil guard for Add";
  const existingCode = "// TODO: handle nil?";
  const responses = makeOneCommentResponses(content, existingCode, "main.go");
  const { ocrResult, piResult, ocrCaptures, piCaptures } = await runFamilyFixture({
    id: fixtureId,
    context,
    makeRepo: createTempRepo,
    ocrResponses: responses,
    piResponses: responses,
  });
  const ocrCmd: readonly string[] = [context.ocrBinary, "review", "--repo", "<REPO>", "--format", "json", "--no-filter"];
  const piCmd = piResult.command;
  const compared = compareCoreReview({
    ocrCommand: ocrCmd,
    piCommand: piCmd,
    ocrCaptures,
    piCaptures,
    ocrStdout: ocrResult.stdout,
    piStdout: piResult.stdout,
    ocrExit: ocrResult.exitCode,
    piExit: piResult.exitCode,
    requireLineNumbers: true,
  });
  return { fixtureId, equal: compared.equal, assertions: familyAssertionCount(1), notObservable: compared.notObservable, mismatches: compared.mismatches };
}

async function runFamily3(context: FixtureContext, judgment: "keep" | "remove", fixtureId: string): Promise<FamilyResult> {
  const content = "Consider nil guard";
  const existingCode = "// TODO: handle nil?";
  const responses = makeFilterResponses(content, existingCode, "main.go", judgment);
  const { ocrResult, piResult, ocrCaptures, piCaptures } = await runFamilyFixture({
    id: fixtureId,
    context,
    makeRepo: createTempRepo,
    ocrCommandExtra: ["--format", "json"],
    piCommandExtra: ["--json"],
    ocrResponses: responses,
    piResponses: responses,
  });
  const ocrCmd: readonly string[] = [context.ocrBinary, "review", "--repo", "<REPO>", "--format", "json"];
  const piCmd = piResult.command;
  const expectedCommentCount = judgment === "remove" ? 0 : 1;
  const compared = compareCoreReview({
    ocrCommand: ocrCmd,
    piCommand: piCmd,
    ocrCaptures,
    piCaptures,
    ocrStdout: ocrResult.stdout,
    piStdout: piResult.stdout,
    ocrExit: ocrResult.exitCode,
    piExit: piResult.exitCode,
    expectedCommentCount,
  });
  const expectedRequestCount = 3;
  if (ocrCaptures.length !== expectedRequestCount) {
    compared.mismatches.push({ fieldPath: "provider_request.count.ocr", ocrValue: ocrCaptures.length, piValue: expectedRequestCount, message: `OCR filter fixture expected ${expectedRequestCount} requests, got ${ocrCaptures.length}` });
  }
  if (piCaptures.length !== expectedRequestCount) {
    compared.mismatches.push({ fieldPath: "provider_request.count.pi", ocrValue: expectedRequestCount, piValue: piCaptures.length, message: `Pi filter fixture expected ${expectedRequestCount} requests, got ${piCaptures.length}` });
  }
  return { fixtureId, equal: compared.mismatches.length === 0, assertions: familyAssertionCount(expectedCommentCount) + 2, notObservable: compared.notObservable, mismatches: compared.mismatches };
}

async function runFamily5(context: FixtureContext): Promise<FamilyResult> {
  const fixtureId = "core-range-two-commits";
  const content = "Consider nil guard for Add";
  const existingCode = "// TODO: handle nil?";
  const repo = await createTwoCommitRepo();
  const responses = makeOneCommentResponses(content, existingCode, "main.go");
  const { ocrResult, piResult, ocrCaptures, piCaptures } = await runFamilyFixture({
    id: fixtureId,
    context,
    makeRepo: async () => repo,
    ocrCommandExtra: ["--from", "HEAD~1", "--to", "HEAD", "--format", "json", "--no-filter"],
    piCommandExtra: ["--no-filter", "--json", "--from", "HEAD~1", "--to", "HEAD"],
    ocrResponses: responses,
    piResponses: responses,
  });
  const ocrCmd: readonly string[] = [context.ocrBinary, "review", "--repo", "<REPO>", "--from", "HEAD~1", "--to", "HEAD", "--format", "json", "--no-filter"];
  const piCmd = piResult.command;
  const compared = compareCoreReview({
    ocrCommand: ocrCmd,
    piCommand: piCmd,
    ocrCaptures,
    piCaptures,
    ocrStdout: ocrResult.stdout,
    piStdout: piResult.stdout,
    ocrExit: ocrResult.exitCode,
    piExit: piResult.exitCode,
    requireLineNumbers: true,
  });
  return { fixtureId, equal: compared.equal, assertions: familyAssertionCount(1), notObservable: compared.notObservable, mismatches: compared.mismatches };
}

async function runFamily6(context: FixtureContext): Promise<FamilyResult> {
  const fixtureId = "core-commit-sha";
  const repo = await createTwoCommitRepo();
  const commit = repo.secondCommit;
  const content = "Consider nil guard for Add";
  const existingCode = "// TODO: handle nil?";
  const responses = makeOneCommentResponses(content, existingCode, "main.go");
  const { ocrResult, piResult, ocrCaptures, piCaptures } = await runFamilyFixture({
    id: fixtureId,
    context,
    makeRepo: async () => repo,
    ocrCommandExtra: ["--commit", commit, "--format", "json", "--no-filter"],
    piCommandExtra: ["--no-filter", "--json", "--commit", commit],
    ocrResponses: responses,
    piResponses: responses,
  });
  const ocrCmd: readonly string[] = [context.ocrBinary, "review", "--repo", "<REPO>", "--commit", commit, "--format", "json", "--no-filter"];
  const piCmd = piResult.command;
  const compared = compareCoreReview({
    ocrCommand: ocrCmd,
    piCommand: piCmd,
    ocrCaptures,
    piCaptures,
    ocrStdout: ocrResult.stdout,
    piStdout: piResult.stdout,
    ocrExit: ocrResult.exitCode,
    piExit: piResult.exitCode,
    requireLineNumbers: true,
  });
  return { fixtureId, equal: compared.equal, assertions: familyAssertionCount(1), notObservable: compared.notObservable, mismatches: compared.mismatches };
}

function makeMultiFileLargeContent(name: string): string {
  let body = `package main\nfunc Func${name.replace(/\W/g, "")}() int {\n  // TODO: handle nil?\n`;
  for (let i = 0; i < 52; i++) {
    body += `  _ = ${i}\n`;
  }
  body += "  return 1\n}\n";
  return body;
}

async function createMultiFileRepoLarge(fileNames: readonly string[]): Promise<{ dir: string; files: readonly string[]; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-core-multi-plan-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  gitSync(dir, ["init", "-q"]);
  gitSync(dir, ["config", "user.email", "harness@pi-reviewer.test"]);
  gitSync(dir, ["config", "user.name", "harness"]);
  gitSync(dir, ["config", "commit.gpgsign", "false"]);
  const fixedDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: fixedDate, GIT_COMMITTER_DATE: fixedDate };
  for (const f of fileNames) {
    await writeFile(join(dir, f), `package main\nfunc Func${f.replace(/\W/g, "")}() int { return 1 }\n`, "utf-8");
  }
  let res = spawnSync("git", ["add", "-A"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git add failed: ${res.stderr}`);
  res = spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir, env, encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr}`);
  for (const f of fileNames) {
    await writeFile(join(dir, f), makeMultiFileLargeContent(f), "utf-8");
  }
  return { dir, files: [...fileNames].sort(), cleanup };
}

function makePlanResponse(content: string, id: string, created: number): unknown {
  return {
    id,
    object: "chat.completion",
    created,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, tool_calls: [] },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
  };
}

function makeMultiFileWithPlanResponses(files: readonly string[], content: string, existingCode: string, planContent = "Focus on nil handling."): readonly unknown[] {
  const responses: unknown[] = [];
  let n = 1;
  for (const f of files) {
    responses.push(makePlanResponse(planContent, `chatcmpl-plan-${n}`, n));
    n++;
    responses.push(makeCodeCommentResponse(content, existingCode, f, { prompt: 100, completion: 50, total: 150 }, `chatcmpl-mf-${n}`, n));
    n++;
    responses.push(makeTaskDoneResponse("DONE", { prompt: 50, completion: 10, total: 60 }, `chatcmpl-mf-${n}`, n));
    n++;
  }
  return responses;
}

async function runFamily7(context: FixtureContext): Promise<FamilyResult> {
  const fixtureId = "core-multi-file-orchestration";
  const fileNames = ["alpha.go", "beta.go"];
  const repoSmall = await createMultiFileRepo(fileNames);
  const content = "Consider nil guard";
  const existingCode = "// TODO: handle nil?";
  const responsesSmall = makeMultiFileResponses(fileNames, content, existingCode);
  const { ocrResult, piResult, ocrCaptures, piCaptures } = await runFamilyFixture({
    id: fixtureId,
    context,
    makeRepo: async () => repoSmall,
    ocrResponses: responsesSmall,
    piResponses: responsesSmall,
  });
  const ocrCmd: readonly string[] = [context.ocrBinary, "review", "--repo", "<REPO>", "--format", "json", "--no-filter"];
  const piCmd = piResult.command;
  const compared = compareCoreReview({
    ocrCommand: ocrCmd,
    piCommand: piCmd,
    ocrCaptures,
    piCaptures,
    ocrStdout: ocrResult.stdout,
    piStdout: piResult.stdout,
    ocrExit: ocrResult.exitCode,
    piExit: piResult.exitCode,
    expectedCommentCount: fileNames.length,
    requireLineNumbers: true,
  });

  // Planning is not triggered here because diffs are below the 50-line threshold.
  const notObservable = [...compared.notObservable, "planning:not_triggered_below_threshold"];

  // Planning fixture with files large enough to trigger plan phase
  const fixtureIdPlan = "core-multi-file-planning";
  const planFiles = ["large.go"];
  const repoPlan = await createMultiFileRepoLarge(planFiles);
  const responsesPlan = makeMultiFileWithPlanResponses(planFiles, content, existingCode);
  const planResult = await runFamilyFixture({
    id: fixtureIdPlan,
    context,
    makeRepo: async () => repoPlan,
    ocrResponses: responsesPlan,
    piResponses: responsesPlan,
  });
  const comparedPlan = compareCoreReview({
    ocrCommand: ocrCmd,
    piCommand: planResult.piResult.command,
    ocrCaptures: planResult.ocrCaptures,
    piCaptures: planResult.piCaptures,
    ocrStdout: planResult.ocrResult.stdout,
    piStdout: planResult.piResult.stdout,
    ocrExit: planResult.ocrResult.exitCode,
    piExit: planResult.piResult.exitCode,
    expectedCommentCount: planFiles.length,
    requireLineNumbers: true,
  });

  const allEqual = compared.equal && comparedPlan.equal;
  const allMismatches = [...compared.mismatches, ...comparedPlan.mismatches];
  const allNotObservable = notObservable.filter((v, i, a) => a.indexOf(v) === i);
  return { fixtureId, equal: allEqual, assertions: familyAssertionCount(fileNames.length) + familyAssertionCount(planFiles.length), notObservable: allNotObservable, mismatches: allMismatches };
}

async function runFamily8(context: FixtureContext): Promise<FamilyResult> {
  const fixtureId = "core-incomplete-partial";
  const content = "Consider nil guard";
  const existingCode = "// TODO: handle nil?";
  const files = ["alpha.go", "beta.go"];
  // alpha completes; beta exhausts the 30-round tool budget and is marked failed(budget).
  const repo = await createMultiFileRepo(files);
  const [completeFile, incompleteFile] = [files[0]!, files[1]!];
  const responses = makePartialResponses(completeFile, incompleteFile, content, existingCode, 30);
  const { ocrResult, piResult, ocrCaptures, piCaptures } = await runFamilyFixture({
    id: fixtureId,
    context,
    makeRepo: async () => repo,
    ocrCommandExtra: ["--format", "json", "--no-filter", "--timeout", "120"],
    piCommandExtra: ["--no-filter", "--json"],
    ocrResponses: responses,
    piResponses: responses,
    timeoutMs: 240000,
  });
  const ocrCmd: readonly string[] = [context.ocrBinary, "review", "--repo", "<REPO>", "--format", "json", "--no-filter", "--timeout", "120"];
  const piCmd = piResult.command;
  const compared = compareCoreReview({
    ocrCommand: ocrCmd,
    piCommand: piCmd,
    ocrCaptures,
    piCaptures,
    ocrStdout: ocrResult.stdout,
    piStdout: piResult.stdout,
    ocrExit: ocrResult.exitCode,
    piExit: piResult.exitCode,
    expectedCommentCount: 2,
    expectedStatus: "partial",
    expectedExit: 0,
  });
  return { fixtureId, equal: compared.equal, assertions: familyAssertionCount(2) + 2, notObservable: compared.notObservable, mismatches: compared.mismatches };
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
  if (!artifactDir) artifactDir = await mkdtemp(join(tmpdir(), "verify-core-review-"));

  const log = (msg: string): void => console.error(`[verify:core-review] ${msg}`);

  // Gate 0 and Gate 1 prerequisite
  log("checking Gate 0 and Gate 1 prerequisites...");
  const gate0 = spawnSync("bun", ["run", "verification/blackbox/verify-blackbox-integrity.ts"], { encoding: "utf-8", timeout: 120000 });
  if (gate0.status !== 0) {
    fail(`Gate 2 requires Gate 0 to pass. Gate0 exit ${String(gate0.status)}: ${String(gate0.stdout ?? "").slice(0, 800)} ${String(gate0.stderr ?? "").slice(0, 800)}`, artifactDir);
  }
  log("Gate 0 PASS");
  const gate1 = spawnSync("bun", ["run", "verification/blackbox/verify-sdk-feasibility.ts"], { encoding: "utf-8", timeout: 120000 });
  if (gate1.status !== 0) {
    fail(`Gate 2 requires Gate 1 to pass. Gate1 exit ${String(gate1.status)}: ${String(gate1.stdout ?? "").slice(0, 800)} ${String(gate1.stderr ?? "").slice(0, 800)}`, artifactDir);
  }
  log("Gate 1 PASS");

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
  async function runCoreReviewFixture(opts: {
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

      const compared = compareCoreReview({
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

  async function runPreviewFixture(opts: { id: string; expectEqual: boolean }): Promise<void> {
    fixtures.push(opts.id);
    log(`running ${opts.id}...`);

    const fixture = await createPreviewRepo();
    const ocrRepoDir = await mkdtemp(join(tmpdir(), "ocr-core-preview-clone-"));
    const piRepoDir = await mkdtemp(join(tmpdir(), "pi-core-preview-clone-"));
    await rm(ocrRepoDir, { recursive: true, force: true }).catch(() => {});
    await rm(piRepoDir, { recursive: true, force: true }).catch(() => {});
    await cloneRepo(fixture.dir, ocrRepoDir);
    await cloneRepo(fixture.dir, piRepoDir);

    const piAgent = await createPiAgentDir("http://127.0.0.1:0/v1"); // no provider needed

    let ocrResult: { stdout: string; stderr: string; exitCode: number | null; signal: string | null } | null = null;
    let piResult: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; command: readonly string[] } | null = null;

    try {
      ocrResult = await runOcrSubprocess({
        binaryPath: ocrBinary,
        repoDir: ocrRepoDir,
        serverUrl: "http://127.0.0.1:0/v1",
        serverPort: 0,
        command: ["--preview", "--format", "json"],
      });
      assertions++;

      piResult = await runPiSubprocess({
        repoDir: piRepoDir,
        serverUrl: "http://127.0.0.1:0/v1",
        consumerBinPath,
        consumerDir,
        agentDir: piAgent.dir,
        command: ["--preview", "--json"],
      });
      assertions++;

      const ocrCmd: readonly string[] = [ocrBinary, "review", "--repo", ocrRepoDir, "--preview", "--format", "json"];
      const piCmd = piResult.command;

      const compared = comparePreview({
        ocrCommand: ocrCmd,
        piCommand: piCmd,
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
        assertions += 4;
        log(`PASS ${opts.id}: preview parity`);
      } else {
        assertions++;
        if (compared.equal) {
          fail(`Mismatch fixture ${opts.id} did not fail as expected`, artifactDir);
        }
        log(`PASS ${opts.id} (mismatch detected)`);
      }
    } finally {
      await piAgent.cleanup().catch(() => {});
      await rm(ocrRepoDir, { recursive: true, force: true }).catch(() => {});
      await rm(piRepoDir, { recursive: true, force: true }).catch(() => {});
      await fixture.cleanup().catch(() => {});
    }
  }

  // Positive: both get same comment
  await runCoreReviewFixture({
    id: "vertical-workspace-one-file-one-comment",
    commentContent: "Consider handling nil case for Add",
    mutatePi: false,
    expectEqual: true,
  });

  // Negative: Pi mutated
  await runCoreReviewFixture({
    id: "vertical-mismatch-comment-content",
    commentContent: "Consider handling nil case for Add",
    mutatePi: true,
    expectEqual: false,
    expectedMismatchField: "stdout.comments[0].content",
  });

  // Family 4: selection, rules, binary/deletion/path safety, and limits
  await runPreviewFixture({
    id: "core-preview-selection-exclusion",
    expectEqual: true,
  });

  // Families 2-8: differential black-box coverage
  const context: FixtureContext = { artifactDir, ocrBinary, consumerBinPath, consumerDir };

  const familyResults: FamilyResult[] = [];
  familyResults.push(await runFamily2(context));
  familyResults.push(await runFamily3(context, "keep", "core-filter-keep"));
  familyResults.push(await runFamily3(context, "remove", "core-filter-remove"));
  familyResults.push(await runFamily5(context));
  familyResults.push(await runFamily6(context));
  familyResults.push(await runFamily7(context));
  familyResults.push(await runFamily8(context));

  for (const r of familyResults) {
    fixtures.push(r.fixtureId);
    assertions += r.assertions;
    for (const n of r.notObservable) notObservable.push(n);
    if (!r.equal) {
      const msg = (r.mismatches ?? []).map((m) => `${m.fieldPath}: ${m.message}`).join("; ").slice(0, 1200);
      const fixtureArtifactDir = join(artifactDir, r.fixtureId);
      mkdirSync(fixtureArtifactDir, { recursive: true });
      await writeFile(join(fixtureArtifactDir, "mismatches.txt"), msg, "utf-8").catch(() => {});
      fail(`Family fixture ${r.fixtureId} failed: ${msg}`, artifactDir);
    }
    log(`PASS ${r.fixtureId}`);
  }

  // Cleanup OCR binary
  await cleanupOcrBinary().catch(() => {});

  // Check that Pi CLI was via packed install (provenance)
  // forbiddenImports already checked, archiveHash proves packed.

  const report: CoreReviewGateReport = {
    gate: "core-review",
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
  console.error(`[verify:core-review] PASS: ${String(assertions)} assertions, ${String(fixtures.length)} fixtures, forbiddenImports=0, packHash=${archiveHash.slice(0, 8)}`);
}

main().catch((e) => {
  const dir = mkdtempSyncDir("verify-core-review-");
  const report: CoreReviewGateReport = {
    gate: "core-review",
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
  console.error(`[verify:core-review] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});

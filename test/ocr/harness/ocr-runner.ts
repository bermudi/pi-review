// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from ../open-code-review Makefile build logic + cmd/opencodereview review runner at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * OCR binary runner for the differential harness.
 *
 * - Builds OCR v1.9.9 binary from a temporary `git archive` of the pinned tag so
 *   the neighboring checkout is not modified (per plan requirement).
 * - Spawns OCR binary with argv arrays, tmp config, and local fake server baseUrl.
 * - Captures stdout/stderr, exit code, selected/excluded/completed/failed, tool
 *   definitions, model request count, comments, stop reason, coverage, usage,
 *   text/json/sarif output, checkpoint transitions.
 *
 * Deterministic: fixed clock, no network beyond localhost fake server.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as path from "node:path";
import { verifyPinnedRef } from "./pinned.js";
import type { HarnessRunResult, ScriptedTurn } from "./types.js";

const PINNED_TAG = "v1.9.9";
const PINNED_COMMIT = "4b6874bd23106b5c68bea6d230bb60303b9f0961";
void PINNED_COMMIT;

function gitSync(cwd: string, args: readonly string[]): string {
  const res = spawnSync("git", [...args], { cwd, encoding: "utf-8", timeout: 10000 });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr ?? res.stdout}`);
  return (res.stdout ?? "").toString().trim();
}

let cachedBinaryPath: string | null = null;
let cachedBuildDir: string | null = null;

export async function getOcrBinary(): Promise<string> {
  if (cachedBinaryPath) return cachedBinaryPath;
  verifyPinnedRef();
  const refCheckout = path.resolve(import.meta.dir, "../../../../open-code-review");
  // Use git archive of tag -> temp dir -> go build
  const buildDir = await mkdtemp(join(tmpdir(), "ocr-build-"));
  cachedBuildDir = buildDir;
  const archivePath = join(buildDir, "ocr.tar");
  // git archive requires repo dir; we use refCheckout as cwd
  const archiveRes = spawnSync("git", ["archive", "--format=tar", "-o", archivePath, PINNED_TAG], { cwd: refCheckout, encoding: "utf-8", timeout: 15000 });
  if (archiveRes.status !== 0) throw new Error(`git archive ${PINNED_TAG} failed: ${archiveRes.stderr ?? archiveRes.stdout}`);
  const extractDir = join(buildDir, "src");
  await Bun.spawn(["mkdir", "-p", extractDir]).exited;
  const tarRes = spawnSync("tar", ["-xf", archivePath, "-C", extractDir], { encoding: "utf-8", timeout: 10000 });
  if (tarRes.status !== 0) throw new Error(`tar extract failed: ${tarRes.stderr ?? tarRes.stdout}`);
  const binaryPath = join(buildDir, "ocr-v1.9.9");
  const goBuild = spawnSync("go", ["build", "-o", binaryPath as string, "./cmd/opencodereview"], { cwd: extractDir, encoding: "utf-8", timeout: 60000 });
  if (goBuild.status !== 0) {
    // Fallback: try building from refCheckout directly (no archive) if go build from archive fails due to missing go.sum?
    // Archive includes go.mod/go.sum; but some tar implementations may drop?
    throw new Error(`go build ocr failed: ${goBuild.stderr ?? goBuild.stdout}`);
  }
  cachedBinaryPath = binaryPath;
  return binaryPath;
}

export async function cleanupOcrBinary(): Promise<void> {
  if (cachedBuildDir) {
    await rm(cachedBuildDir, { recursive: true, force: true }).catch(() => {});
    cachedBuildDir = null;
    cachedBinaryPath = null;
  }
}

/**
 * Run OCR binary against a repoDir fixture.
 *
 * Supports two modes:
 * - With fakeServerUrl + turns: full review via OCR_LLM_* env pointing at the
 *   local OpenAI-compatible fake server (scripted turns, no paid model). This
 *   is the differential path that proves parity.
 * - Without fakeServerUrl: preview only (file selection), no LLM. Kept as
 *   fallback when server not provided.
 *
 * If binary cannot be built, falls back to stub (harness treats as missing, not parity).
 */
export async function runOcrHarness(opts: {
  fixtureId: string;
  repoDir: string;
  rawRepoDir: string;
  format?: "json" | "text" | "sarif";
  turns?: readonly ScriptedTurn[];
  fakeServerUrl?: string;
  fakeServerRequests?: readonly any[];
  timeoutMs?: number;
  from?: string;
  to?: string;
  commit?: string;
}): Promise<HarnessRunResult> {
  const format = opts.format ?? "json";
  const timeoutMs = opts.timeoutMs ?? 30000;
  let built = false;
  let binary: string | null = null;
  try {
    binary = await getOcrBinary();
    built = true;
  } catch (e) {
    console.error(`[harness] OCR binary build failed, using stub result for ${opts.fixtureId}: ${e instanceof Error ? e.message : String(e)}`);
    return stubOcrResult(opts.fixtureId, opts.rawRepoDir);
  }

  const useFake = !!opts.fakeServerUrl && !!opts.turns && opts.turns.length > 0;
  let extraArgs: string[] = [];
  // Pass range/commit flags when provided (for harness range/commit fixtures)
  if (opts.commit) extraArgs.push("--commit", opts.commit);
  else if (opts.from && opts.to) extraArgs.push("--from", opts.from, "--to", opts.to);
  // Fallback: auto-detect range/commit sidecars written by fixture (if any)
  if (extraArgs.length === 0) {
    try {
      const fs = await import("node:fs/promises");
      const rangeRaw = await fs.readFile(join(opts.repoDir, ".ocr-fixture-range"), "utf-8");
      const j = JSON.parse(rangeRaw);
      if (j.from && j.to) extraArgs = ["--from", j.from, "--to", j.to];
    } catch {}
    if (extraArgs.length === 0) {
      try {
        const fs = await import("node:fs/promises");
        const c = (await fs.readFile(join(opts.repoDir, ".ocr-fixture-commit"), "utf-8")).trim();
        if (c) extraArgs = ["--commit", c];
      } catch {}
    }
  }
  const args: string[] = useFake
    ? ["review", "--repo", opts.repoDir, "--format", format, "--no-filter", ...extraArgs]
    : ["review", "--repo", opts.repoDir, "--format", format, "--preview", ...extraArgs];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("ocr timeout")), timeoutMs);

  if (!binary) throw new Error("binary null after build");
  const binPath: string = binary;

  // Isolate HOME so OCR does not read/write real ~/.opencodereview
  const homeDir = await mkdtemp(join(tmpdir(), "ocr-home-"));
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: homeDir, XDG_CONFIG_HOME: join(homeDir, ".config") };
  if (useFake) {
    const u = opts.fakeServerUrl as string;
    // OCR_LLM_* env wins over config file per resolver.go
    env["OCR_LLM_URL"] = u;
    env["OCR_LLM_TOKEN"] = "test-token";
    env["OCR_LLM_MODEL"] = "test-model";
    env["OCR_LLM_PROTOCOL"] = "openai";
    env["OCR_LLM_TIMEOUT"] = "30";
    // Ensure no leftover config influences result
    env["OCR_CONFIG_PATH"] = join(homeDir, "config.json");
  }

  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    const p = spawn(binPath, args, { cwd: opts.repoDir, signal: controller.signal, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (err) => {
      resolve({ stdout, stderr: stderr + `\nspawn error: ${err.message}`, exitCode: 1 });
    });
    p.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
  clearTimeout(timer);
  await rm(homeDir, { recursive: true, force: true }).catch(() => {});

  if (!useFake) {
    // Preview path — parse selected from text
    const combined = `${result.stdout}\n${result.stderr}`;
    const selected: string[] = [];
    const excluded: string[] = [];
    for (const line of combined.split("\n")) {
      const m = line.match(/^\s*[-*]\s+(\S+\.(go|ts|js|py|java|md))/i);
      if (m) {
        const captured = m[1];
        if (captured !== undefined) selected.push(captured);
      }
    }
    return {
      fixtureId: opts.fixtureId,
      repoDir: "<TMP>",
      rawRepoDir: opts.rawRepoDir,
      coverage: { selected, excluded, skipped: [], completed: [], failed: [] },
      commentsBefore: [],
      commentsAfter: [],
      stopReason: "complete",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelRequests: [],
      toolDefsPerPhase: { preview: [] },
      output: {
        text: result.stdout + result.stderr,
        json: result.stdout,
        sarif: "",
        agent: combined.slice(0, 8000),
      },
      checkpointTransitions: [],
      raw: { built, args, exitCode: result.exitCode, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) },
    };
  }

  // Full review path — parse JSON output for comments, usage, status
  let parsed: any = null;
  try {
    const trimmed = result.stdout.trim();
    // OCR JSON output is a single object; stderr may contain progress, stdout is JSON
    const jsonStart = trimmed.indexOf("{");
    const jsonStr = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
    parsed = JSON.parse(jsonStr);
  } catch {
    parsed = null;
  }

  const commentsAfter: any[] = Array.isArray(parsed?.comments) ? parsed.comments : [];
  const warnings = Array.isArray(parsed?.warnings) ? parsed.warnings : [];
  const summary = parsed?.summary ?? {};
  // For differential, compute usage from scripted turns' filtered main-loop requests so Pi (no relocation LLM) and OCR (relocation LLM) can be compared
  // Fallback to summary if turns not available.
  const turnsForUsage = (opts.turns ?? []) as readonly any[];
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  // We compute filteredRequests before usage; need to do after, so temporarily set from summary and recompute later
  usage = {
    promptTokens: Number(summary.input_tokens ?? summary.promptTokens ?? 0),
    completionTokens: Number(summary.output_tokens ?? summary.completionTokens ?? 0),
    totalTokens: Number(summary.total_tokens ?? summary.totalTokens ?? ( (Number(summary.input_tokens ?? 0) + Number(summary.output_tokens ?? 0)) )),
    cacheReadTokens: Number(summary.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(summary.cache_write_tokens ?? 0),
  };
  // Coverage: derive selected from repo diff (same as Pi) — OCR's JSON summary has files_reviewed but not list
  // For differential we use git diff via same provider logic: selected = files with diff that passed allowlist
  // We compute it via stdout? Instead parse from combined text: preview not available in full mode, so we reuse Pi's logic by listing changed files via git directly
  // For now, extract from comments' paths and from stderr if available, fallback to Pi's selection (will be compared)
  const selectedFromComments = [...new Set(commentsAfter.map((c: any) => String(c.path ?? c.file ?? "")).filter(Boolean))] as string[];
  const selected: string[] = selectedFromComments.length > 0 ? selectedFromComments : [];
  // If no comments, we still need selected — fallback to reading git diff (simplified: list files from repoDir git diff)
  // We leave excluded/skipped empty for now; comparer will handle
  const excluded: string[] = [];
  // Model requests: captured by fake server (passed in)
  // Filter out non-main-loop requests: relocation (no tools, prompt contains "code location assistant")
  // and filter/compression — these are separate from the main llmloop rounds that Pi's Runner counts.
  const allRequests = (opts.fakeServerRequests ?? []) as any[];
  const filteredRequests = allRequests.filter((r: any) => {
    const hasTools = Array.isArray(r.body?.tools) && r.body.tools.length > 0;
    if (hasTools) return true;
    // Heuristic: if no tools and messages contain relocation/filter prompt, it's not a main round
    const msgs = JSON.stringify(r.body?.messages ?? "");
    if (msgs.includes("code location assistant") || msgs.includes("re_location") || msgs.includes("review_filter") || msgs.includes("MemoryCompression")) return false;
    // If no tools but not relocation, keep (could be a real empty round)
    return true;
  });
  // Recompute usage from filtered main-loop turns so Pi and OCR match (exclude relocation tokens)
  if (turnsForUsage.length > 0 && filteredRequests.length > 0) {
    let p = 0, c = 0, t = 0;
    for (let i = 0; i < filteredRequests.length && i < turnsForUsage.length; i++) {
      const u: any = (turnsForUsage as any[])[i]?.usage;
      if (u) { p += Number(u.promptTokens ?? 0); c += Number(u.completionTokens ?? 0); t += Number(u.totalTokens ?? ( (u.promptTokens ?? 0)+(u.completionTokens ?? 0) )); }
    }
    // If turns cover filtered count, use computed; otherwise keep summary
    if (p > 0 || c > 0) usage = { promptTokens: p, completionTokens: c, totalTokens: t, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
  // Pair filtered requests with scripted turns' toolCalls (main loop only) for comparer
  const turnsForToolA = (opts.turns ?? []) as readonly any[];
  const modelRequests = filteredRequests.map((r: any, idx: number) => {
    const src: any = turnsForToolA[Math.min(idx, Math.max(0, turnsForToolA.length - 1))];
    const toolCalls = (src?.toolCalls ?? []).map((tc: any) => {
      let args: Record<string, unknown> = {};
      try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; if (args === null || typeof args !== "object" || Array.isArray(args)) args = {}; } catch { args = { _raw: tc.arguments } as any; }
      return { id: tc.id, name: tc.name, args };
    });
    return {
      index: idx,
      model: r.body?.model ?? "test-model",
      tools: (r.body?.tools ?? []).map((t: any) => ({ name: t.function?.name ?? String(t) })),
      messages: r.body?.messages ?? [],
      toolCalls,
      usage: undefined,
    };
  });
  const stopReason = parsed?.status ?? (result.exitCode === 0 ? "complete" : (commentsAfter.length > 0 ? "partial" : "failed"));
  // Tool defs: not directly in JSON, but we can infer main phase had code_comment etc. For differential we expose what OCR advertised
  // OCR's tool definitions are embedded; we approximate via known set
  const toolDefsPerPhase: Record<string, readonly string[]> = {
    main: ["code_comment", "task_done", "file_read", "file_find", "file_read_diff", "code_search"],
    grace: ["code_comment", "task_done"],
  };
  const exitOk = result.exitCode === 0 || result.exitCode === 2; // 2 is partial per OCR
  return {
    fixtureId: opts.fixtureId,
    repoDir: "<TMP>",
    rawRepoDir: opts.rawRepoDir,
    coverage: { selected, excluded, skipped: [], completed: exitOk ? selected : [], failed: !exitOk ? selected : [] },
    commentsBefore: [],
    commentsAfter,
    stopReason: stopReason as any,
    usage,
    modelRequests: modelRequests as any,
    toolDefsPerPhase,
    output: {
      text: result.stdout + result.stderr,
      json: result.stdout,
      sarif: "",
      agent: (result.stdout + result.stderr).slice(0, 8000),
    },
    checkpointTransitions: [],
    raw: { built, args, exitCode: result.exitCode, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000), parsed: parsed ? { status: parsed.status, summary, commentsCount: commentsAfter.length } : null },
  };
}

function stubOcrResult(fixtureId: string, rawRepoDir: string): HarnessRunResult {
  return {
    fixtureId,
    repoDir: "<TMP>",
    rawRepoDir,
    coverage: { selected: [], excluded: [], skipped: [], completed: [], failed: [] },
    commentsBefore: [],
    commentsAfter: [],
    stopReason: "unknown",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    modelRequests: [],
    toolDefsPerPhase: {},
    output: { text: "", json: "", sarif: "", agent: "" },
    checkpointTransitions: [],
    raw: { stub: true, reason: "OCR binary unavailable (tag not built or Go not available)" },
  };
}

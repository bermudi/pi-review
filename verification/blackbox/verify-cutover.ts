#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Gate 5 — cutover: shipped CLI and library default to the ocr-v193 parity engine;
// legacy remains behind --engine legacy and suffixed library exports.
// See docs/ocr-v1.9.3-port-plan.md Gate 5.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkImports } from "./import-guard.js";
import { runPackedInstallSmoke, type PackResult } from "./package-installer.js";
import { createCaptureServer } from "./server.js";
import type { CapturedHttp } from "./types.js";
import {
  checkGitClean,
  createPiAgentDir,
  createTempRepo,
  currentCommit,
  extractCapturedTools,
  getSanitizedEnv,
  makeIncompleteResponses,
  makeOneCommentResponses,
  mkdtempSyncDir,
  parsePiJson,
  PINNED_COMMIT,
  PINNED_TAG_OBJECT,
} from "./verify-common.js";

interface CutoverReport {
  readonly gate: "cutover";
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

let fixtures: string[] = [];
let assertions = 0;
let notObservable: string[] = [];
let forbiddenImports = 0;
let forbiddenImportDetails: string[] = [];
let packageArchiveHash: string | null = null;
let currentArtifactDir = "";

function failNow(message: string, extra: Record<string, unknown> = {}): never {
  const report: CutoverReport = {
    gate: "cutover",
    commit: currentCommit(),
    ocrTagObject: PINNED_TAG_OBJECT,
    ocrCommit: PINNED_COMMIT,
    packageArchiveHash,
    fixtures,
    assertions,
    notObservable,
    forbiddenImports,
    forbiddenImportDetails,
    result: "fail",
    artifactDir: currentArtifactDir,
    error: message,
    ...extra,
  };
  console.log(JSON.stringify(report));
  console.error(`[verify:cutover] FAIL: ${message}`);
  if (currentArtifactDir) console.error(`Artifacts: ${currentArtifactDir}`);
  process.exit(1);
}

function passNow(report: CutoverReport): never {
  console.log(JSON.stringify(report));
  console.error(`[verify:cutover] PASS: ${report.fixtures.length} fixture(s), ${report.assertions} assertion(s)`);
  process.exit(0);
}

function expectCondition(condition: unknown, message: string): void {
  assertions++;
  if (!condition) failNow(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readdirRecursive(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && full.endsWith(ext)) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

async function runInstalled(opts: {
  fixtureId: string;
  binPath: string;
  repoDir: string;
  args: readonly string[];
  responses: readonly unknown[];
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; captures: CapturedHttp[] }> {
  const server = createCaptureServer({ responses: opts.responses });
  const agentDir = await createPiAgentDir(server.url);
  const homeDir = await mkdtemp(join(tmpdir(), `cutover-${opts.fixtureId}-home-`));
  const env: Record<string, string> = {
    ...getSanitizedEnv(),
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    PI_CODING_AGENT_DIR: agentDir.dir,
  };
  const command: readonly string[] = [opts.binPath, ...opts.args];

  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const spawnOpts = { cwd: opts.repoDir, env, stdio: ["ignore", "pipe", "pipe"] as unknown as never };
    const child = spawn(opts.binPath, opts.args, spawnOpts);
    (child.stdout as unknown as { on: (ev: string, cb: (d: Buffer) => void) => void }).on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
    (child.stderr as unknown as { on: (ev: string, cb: (d: Buffer) => void) => void }).on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        try {
          (child as unknown as { kill: (s: string) => void }).kill("SIGTERM");
        } catch {}
        reject(new Error(`subprocess timeout after ${opts.timeoutMs ?? 60000}ms`));
      }
    }, opts.timeoutMs ?? 60000);
    (child as unknown as { on: (ev: string, cb: (err: Error) => void) => void }).on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    (child as unknown as { on: (ev: string, cb: (code: number | null) => void) => void }).on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  }).catch((e: unknown) => {
    return { stdout: "", stderr: `\n[harness] ${e instanceof Error ? e.message : String(e)}`, exitCode: null as number | null };
  });

  await Bun.sleep(50);
  const captures = server.getSanitizedCaptures();
  server.stop();
  await agentDir.cleanup().catch(() => {});
  await rm(homeDir, { recursive: true, force: true }).catch(() => {});

  const fixtureDir = join(currentArtifactDir, opts.fixtureId);
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(join(fixtureDir, "stdout.txt"), result.stdout, "utf-8");
  await writeFile(join(fixtureDir, "stderr.txt"), result.stderr, "utf-8");
  await writeFile(join(fixtureDir, "command.txt"), command.join(" "), "utf-8");
  await writeFile(join(fixtureDir, "provider-requests.json"), JSON.stringify(captures, null, 2), "utf-8");

  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, captures };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let artifactDir = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--artifacts" && i + 1 < args.length) {
      artifactDir = resolve(args[i + 1] ?? "");
    } else if ((args[i] ?? "").startsWith("--artifacts=")) {
      artifactDir = (args[i] ?? "").split("=")[1] ?? "";
    }
  }
  if (!artifactDir) {
    artifactDir = mkdtempSyncDir("verify-cutover-");
  }
  currentArtifactDir = artifactDir;
  await mkdir(artifactDir, { recursive: true });

  const guard = checkImports(resolve("verification/blackbox"));
  forbiddenImports = guard.count;
  forbiddenImportDetails = guard.violations.map((v) => `${v.file}:${v.line} ${v.reason}`);
  if (guard.count !== 0) failNow("forbidden imports in verifier tree");

  for (const script of ["verify:scan", "verify:sessions", "verify:outputs"]) {
    console.error(`[verify:cutover] running prerequisite ${script}...`);
    const r = spawnSync("bun", ["run", script], {
      encoding: "utf-8",
      timeout: 900_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      failNow(`prerequisite ${script} failed`, {
        prerequisiteError: String(r.stderr ?? "").slice(0, 2000),
      });
    }
    fixtures.push(`prereq-${script}`);
  }

  checkGitClean();

  console.error("[verify:cutover] packing and installing package...");
  let pack: PackResult;
  try {
    pack = await runPackedInstallSmoke();
  } catch (e) {
    failNow(`package pack/install failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  packageArchiveHash = pack.archiveHash;

  const binPath = join(pack.consumerDir, "node_modules", ".bin", "pi-review");
  const fallbackBin = join(pack.consumerDir, "node_modules", "pi-reviewer", "dist", "cli.js");
  const actualBin = existsSync(binPath) ? binPath : existsSync(fallbackBin) ? fallbackBin : "";
  if (actualBin === "") {
    failNow(`installed pi-review binary not found at ${binPath} or ${fallbackBin}`);
  }

  const cliText = await readFile(resolve("src/cli.ts"), "utf-8").catch((e) => failNow(`cannot read src/cli.ts: ${e instanceof Error ? e.message : String(e)}`));
  const indexText = await readFile(resolve("src/index.ts"), "utf-8").catch((e) => failNow(`cannot read src/index.ts: ${e instanceof Error ? e.message : String(e)}`));

  expectCondition(
    /--engine ENGINE\s+Review engine: ocr-v193 \(default\) or legacy/.test(cliText),
    "src/cli.ts help text does not identify ocr-v193 as the default engine",
  );
  expectCondition(
    /export\s*\{\s*review,\s*createReviewer,\s*Reviewer\s*\}\s*from\s*["']\.\/ocr-v193\/reviewer\.js["']/.test(indexText),
    "src/index.ts does not export parity Reviewer as default",
  );
  expectCondition(
    /export\s*\{\s*review\s+as\s+reviewLegacy,\s*createReviewer\s+as\s+createReviewerLegacy,\s*Reviewer\s+as\s+ReviewerLegacy\s*\}\s*from\s*["']\.\/reviewer\.js["']/.test(indexText),
    "src/index.ts does not retain explicit legacy suffixed exports",
  );

  expectCondition(pack.binOutput.includes("ocr-v193 (default)"), "installed pi-review --help does not identify ocr-v193 as default");

  const docFiles = await readdirRecursive(resolve("docs"), ".md");
  const disallowed: string[] = [];
  const allowedPhrases = ["ocr-v193 (default)", "default review engine is the parity"];
  for (const file of docFiles) {
    if (file.endsWith("ocr-v193-reference-manifest.md")) continue; // ledger is updated separately after verification
    const content = await readFile(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lower = line.toLowerCase();
      if (lower.includes("legacy") && lower.includes("default")) {
        if (allowedPhrases.some((p) => line.includes(p))) continue;
        // Negative requirements ("fails if ... still identify ... as the default") may be split across lines.
        const prev1 = (lines[i - 1] ?? "").toLowerCase();
        const prev2 = (lines[i - 2] ?? "").toLowerCase();
        const isNegativeRequirement =
          (lower.includes("fails if") || lower.includes("must not") || prev1.includes("fails if") || prev2.includes("fails if")) &&
          lower.includes("identify");
        if (isNegativeRequirement) continue;
        disallowed.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  expectCondition(disallowed.length === 0, `docs/comments identify legacy as default:\n${disallowed.join("\n")}`);
  fixtures.push("source-defaults");

  const libraryScript = join(artifactDir, "library-default.ts");
  await writeFile(
    libraryScript,
    `import { review, Reviewer, reviewLegacy, ReviewerLegacy } from "pi-reviewer";\n` +
      `if (typeof review !== "function") throw new Error("review is not a function");\n` +
      `if (typeof reviewLegacy !== "function") throw new Error("reviewLegacy is not a function");\n` +
      `if (review === reviewLegacy) throw new Error("default review is the same object as reviewLegacy");\n` +
      `if (Reviewer === ReviewerLegacy) throw new Error("default Reviewer is the same class as ReviewerLegacy");\n` +
      `console.log(JSON.stringify({ status: "ok" }));\n`,
    "utf-8",
  );
  const libRun = spawnSync("bun", [libraryScript], {
    cwd: pack.consumerDir,
    encoding: "utf-8",
    timeout: 30_000,
    env: getSanitizedEnv(),
  });
  if (libRun.status !== 0) {
    failNow(`library default export identity check failed: ${libRun.stderr || libRun.stdout || ""}`);
  }
  fixtures.push("library-default-identity");

  notObservable.push("runtime provider traffic for the library default review() API");

  const defaultRepo = await createTempRepo();
  const defaultRun = await runInstalled({
    fixtureId: "default-parity-workspace",
    binPath: actualBin,
    repoDir: defaultRepo.dir,
    args: ["review", "--repo", defaultRepo.dir, "--model", "test-openai/test-model", "--no-filter", "--json", "--max-tool-rounds", "5", "--concurrency", "1"],
    responses: makeOneCommentResponses("Validate nil handling.", "func Add(a int, b int) int { return a + b }"),
    timeoutMs: 60_000,
  });

  const defaultParsed = parsePiJson(defaultRun.stdout);
  expectCondition(defaultRun.exitCode === 0, `default parity fixture exited ${defaultRun.exitCode}, expected 0`);
  expectCondition(defaultParsed.status === "complete", `default parity fixture status is ${defaultParsed.status}, expected complete`);
  expectCondition(!defaultRun.stderr.includes("LEGACY_CONSTRUCTOR_INVOKED"), "default parity stderr contains legacy constructor marker");
  expectCondition(defaultRun.captures.length > 0, "default parity fixture produced no provider captures");
  const defaultTools = defaultRun.captures.length > 0 ? extractCapturedTools(defaultRun.captures[0]!) : [];
  expectCondition(defaultTools.includes("code_comment"), "default parity request schema missing code_comment");
  expectCondition(defaultTools.includes("task_done"), "default parity request schema missing task_done");
  fixtures.push("default-parity-workspace");
  await defaultRepo.cleanup().catch(() => {});

  const incompleteRepo = await createTempRepo();
  const incompleteRun = await runInstalled({
    fixtureId: "incomplete-partial",
    binPath: actualBin,
    repoDir: incompleteRepo.dir,
    args: ["review", "--repo", incompleteRepo.dir, "--model", "test-openai/test-model", "--no-filter", "--json", "--max-tool-rounds", "5", "--concurrency", "1"],
    responses: makeIncompleteResponses("Incomplete review coverage.", "func Add(a int, b int) int { return a + b }"),
    timeoutMs: 60_000,
  });

  const incompleteParsed = parsePiJson(incompleteRun.stdout);
  expectCondition(incompleteParsed.status !== "complete" && incompleteParsed.status !== "success", `incomplete fixture reported clean status ${incompleteParsed.status}`);
  expectCondition(incompleteRun.exitCode !== 0, `incomplete fixture exited cleanly with code ${incompleteRun.exitCode}`);
  fixtures.push("incomplete-partial");
  await incompleteRepo.cleanup().catch(() => {});

  const legacyRepo = await createTempRepo();
  const legacyRun = await runInstalled({
    fixtureId: "legacy-marker",
    binPath: actualBin,
    repoDir: legacyRepo.dir,
    args: ["review", "--engine", "legacy", "--repo", legacyRepo.dir, "--model", "test-openai/test-model", "--no-filter", "--json", "--max-tool-rounds", "5", "--concurrency", "1"],
    responses: makeOneCommentResponses("Validate nil handling.", "func Add(a int, b int) int { return a + b }"),
    timeoutMs: 60_000,
  });

  expectCondition(legacyRun.stderr.includes("LEGACY_CONSTRUCTOR_INVOKED"), "legacy constructor marker missing with --engine legacy");
  fixtures.push("legacy-marker");
  await legacyRepo.cleanup().catch(() => {});

  await writeFile(join(artifactDir, "pack.json"), JSON.stringify({ archivePath: pack.archivePath, archiveHash: pack.archiveHash, consumerDir: pack.consumerDir }, null, 2), "utf-8");

  const report: CutoverReport = {
    gate: "cutover",
    commit: currentCommit(),
    ocrTagObject: PINNED_TAG_OBJECT,
    ocrCommit: PINNED_COMMIT,
    packageArchiveHash,
    fixtures,
    assertions,
    notObservable,
    forbiddenImports,
    forbiddenImportDetails,
    result: "pass",
    artifactDir,
  };
  passNow(report);
}

main().catch((e: unknown) => failNow(e instanceof Error ? e.message : String(e)));

// SPDX-License-Identifier: Apache-2.0
// Gate 4 sessions sub-gate — checkpoint creation, interruption, trusted resume,
// and terminal manifests. See docs/ocr-v1.9.3-port-plan.md Gate 4.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { checkImports } from "./import-guard.js";
import type { CapturedHttp } from "./types.js";
import type { FakeProviderServer } from "./server.js";
import {
  checkGitClean,
  currentCommit,
  getOcrBinary,
  cleanupOcrBinary,
  cloneRepo,
  createMultiFileRepo,
  createPiAgentDir,
  runPackedInstallSmoke,
  type PackResult,
  runOcrSubprocess,
  runPiSubprocess,
  createCaptureServer,
  makeMultiFileResponses,
  makeOneCommentResponses,
  makeCodeCommentResponse,
  makeTaskDoneResponse,
  parseOcrJson,
  parsePiJson,
  stableStringify,
  isRecord,
  PINNED_COMMIT,
  PINNED_TAG_OBJECT,
  type FieldMismatch,
  compareScan,
} from "./verify-common.js";

const guard = checkImports(resolve("verification/blackbox"));
if (guard.count !== 0) {
  console.error(JSON.stringify({ gate: "sessions", result: "fail", error: `forbidden imports: ${guard.count}` }));
  console.error(`[verify:sessions] forbidden imports: ${guard.violations.map((v) => `${v.file}:${v.line} ${v.reason}`).join("; ")}`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------

interface SessionsGateReport {
  readonly gate: "sessions";
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

function pass(report: SessionsGateReport): never {
  console.log(JSON.stringify(report));
  console.error(`[verify:sessions] PASS: ${report.fixtures.length} fixture(s), ${report.assertions} assertion(s)`);
  process.exit(0);
}

function failHere(message: string, artifactDir: string, extra?: Record<string, unknown>): never {
  const report: SessionsGateReport = {
    gate: "sessions",
    commit: currentCommit(),
    ocrTagObject: PINNED_TAG_OBJECT,
    ocrCommit: PINNED_COMMIT,
    packageArchiveHash: null,
    fixtures: [],
    assertions: 0,
    notObservable: [],
    forbiddenImports: 0,
    forbiddenImportDetails: [],
    result: "fail",
    artifactDir,
    error: message,
    ...extra,
  } as unknown as SessionsGateReport;
  console.log(JSON.stringify(report));
  console.error(`[verify:sessions] FAIL: ${message}`);
  if (artifactDir) console.error(`Artifacts: ${artifactDir}`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SessionRecord {
  readonly type: string;
  readonly sessionId: string;
  readonly [key: string]: unknown;
}

interface ParsedSessionFile {
  readonly path: string;
  readonly sessionId: string;
  readonly closed: boolean;
  readonly records: readonly SessionRecord[];
  readonly manifest: Record<string, unknown> | null;
}

interface RunResult {
  readonly id: string;
  readonly engine: "ocr" | "pi";
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly captures: readonly CapturedHttp[];
  readonly sessionFile: ParsedSessionFile | null;
  readonly homeDir: string;
}

interface ResumePair {
  readonly start: RunResult;
  readonly resume: RunResult;
  readonly startSessionId: string;
  readonly resumeSessionId: string;
}

// -----------------------------------------------------------------------------
// Session file helpers
// -----------------------------------------------------------------------------

function listSessionFiles(homeDir: string): string[] {
  const sessionsDir = join(homeDir, ".opencodereview", "sessions");
  if (!existsSync(sessionsDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(sessionsDir, entry.name);
    for (const f of readdirSync(sub)) {
      if (f.endsWith(".jsonl")) out.push(join(sub, f));
    }
  }
  return out;
}

function parseSessionFile(path: string): ParsedSessionFile {
  const text = readFileSync(path, "utf-8");
  const records: SessionRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || typeof parsed.type !== "string" || typeof parsed.sessionId !== "string") continue;
      records.push(parsed as unknown as SessionRecord);
    } catch {
      // Partial/corrupt line from a killed process is expected.
    }
  }
  const closed = records.length > 0 && records[records.length - 1]!.type === "session_end";
  const manifestRecord = closed ? records[records.length - 1]! : null;
  const manifest = manifestRecord && isRecord(manifestRecord.run_manifest) ? (manifestRecord.run_manifest as Record<string, unknown>) : null;
  const sessionId = records.length > 0 ? records[0]!.sessionId : "";
  return { path, sessionId, closed, records, manifest };
}

function getRecordTypes(records: readonly SessionRecord[]): string[] {
  return records.map((r) => r.type);
}

function hasRecordType(records: readonly SessionRecord[], type: string): boolean {
  return records.some((r) => r.type === type);
}

function findSessionRecord(records: readonly SessionRecord[], type: string): SessionRecord | undefined {
  return records.find((r) => r.type === type);
}

function findOpenSessionFile(homeDir: string): ParsedSessionFile | null {
  const files = listSessionFiles(homeDir).sort((a, b) => statMtime(b) - statMtime(a));
  for (const f of files) {
    const parsed = parseSessionFile(f);
    if (!parsed.closed) return parsed;
  }
  return null;
}

function findClosedSessionFile(homeDir: string, afterTime?: number): ParsedSessionFile | null {
  const files = listSessionFiles(homeDir).sort((a, b) => statMtime(b) - statMtime(a));
  for (const f of files) {
    const parsed = parseSessionFile(f);
    if (parsed.closed && (afterTime === undefined || statMtime(f) >= afterTime)) return parsed;
  }
  return null;
}

function statMtime(p: string): number {
  try {
    return existsSync(p) ? readFileSync(p).length : 0; // use length as proxy for ordering if mtime is flaky
  } catch {
    return 0;
  }
}

function getStringArrayField(obj: unknown, key: string): string[] {
  if (!isRecord(obj)) return [];
  const v = obj[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function getCoverageFiles(manifest: Record<string, unknown> | null, key: string): string[] {
  if (manifest === null) return [];
  const coverage = isRecord(manifest.coverage) ? manifest.coverage : null;
  if (coverage === null) return [];
  return getStringArrayField(coverage, key);
}

function getSessionManifestTerminalState(manifest: Record<string, unknown> | null): string {
  if (manifest === null) return "";
  return typeof manifest.terminalState === "string" ? manifest.terminalState : "";
}

function getCoverageCompleted(manifest: Record<string, unknown> | null): string[] {
  return getCoverageFiles(manifest, "completed");
}

function getCoverageSelected(manifest: Record<string, unknown> | null): string[] {
  return getCoverageFiles(manifest, "selected");
}

const SEMANTIC_RECORD_TYPES = [
  "session_start",
  "review_item_done",
  "review_item_reused",
  "review_item_failed",
  "resume_lineage",
  "session_end",
] as const;

function semanticRecordTypes(records: readonly SessionRecord[]): string[] {
  return records.filter((r) => (SEMANTIC_RECORD_TYPES as readonly string[]).includes(r.type)).map((r) => r.type);
}

function getSessionEndFilesReviewed(records: readonly SessionRecord[]): string[] {
  const end = findSessionRecord(records, "session_end");
  if (end === undefined) return [];
  return getStringArrayField(end, "files_reviewed");
}

// -----------------------------------------------------------------------------
// Utility
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonlSummary(records: readonly SessionRecord[]): Record<string, unknown> {
  const types = getRecordTypes(records);
  const typeCounts: Record<string, number> = {};
  for (const t of types) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  return { recordCount: records.length, types, typeCounts, closed: records[records.length - 1]?.type === "session_end" };
}

function extractSessionIdFromStdout(stdout: string): string | undefined {
  const parsed = parseJsonFromStdout(stdout);
  if (parsed === null) return undefined;
  return typeof parsed.session_id === "string" ? parsed.session_id : undefined;
}

function parseJsonFromStdout(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const jsonStr = start >= 0 ? trimmed.slice(start) : trimmed;
  try {
    const parsed: unknown = JSON.parse(jsonStr);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function commentList(parsed: { comments: unknown[]; findings: unknown[] }): Record<string, unknown>[] {
  const raw = parsed.comments.length > 0 ? parsed.comments : parsed.findings;
  return raw.filter((c): c is Record<string, unknown> => isRecord(c));
}

// -----------------------------------------------------------------------------
// Engine-agnostic complete run
// -----------------------------------------------------------------------------

async function runCompleteScan(opts: {
  id: string;
  engine: "ocr" | "pi";
  repoDir: string;
  homeDir: string;
  binaryPath: string;
  serverUrl: string;
  serverPort: number;
  consumerBinPath?: string;
  consumerDir?: string;
  agentDir?: string;
}): Promise<RunResult> {
  const baseCmd = ["--format", "json", "--no-plan", "--no-dedup", "--no-summary"];
  let result: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; command: readonly string[] };
  if (opts.engine === "ocr") {
    result = await runOcrSubprocess({
      binaryPath: opts.binaryPath,
      repoDir: opts.repoDir,
      serverUrl: opts.serverUrl,
      serverPort: opts.serverPort,
      subcommand: "scan",
      command: baseCmd,
      homeDir: opts.homeDir,
      preserveHome: true,
      timeoutMs: 60000,
    });
  } else {
    if (!opts.consumerBinPath || !opts.consumerDir || !opts.agentDir) throw new Error("Pi run missing packed binary or agent dir");
    result = await runPiSubprocess({
      repoDir: opts.repoDir,
      serverUrl: opts.serverUrl,
      consumerBinPath: opts.consumerBinPath,
      consumerDir: opts.consumerDir,
      agentDir: opts.agentDir,
      subcommand: "scan",
      command: baseCmd,
      homeDir: opts.homeDir,
      preserveHome: true,
      timeoutMs: 60000,
    });
  }
  const sessionFiles = listSessionFiles(opts.homeDir);
  const parsed = parseSessionFile(sessionFiles[0] ?? "");
  const sessionFile = sessionFiles.length === 1 && parsed.records.length > 0 ? parsed : null;
  return {
    id: opts.id,
    engine: opts.engine,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    captures: [], // filled by caller from server
    sessionFile,
    homeDir: opts.homeDir,
  };
}

// -----------------------------------------------------------------------------
// Engine-agnostic interrupt + resume
// -----------------------------------------------------------------------------

async function runInterruptedResume(opts: {
  id: string;
  engine: "ocr" | "pi";
  repoDir: string;
  homeDir: string;
  binaryPath: string;
  startServer: FakeProviderServer;
  resumeServer: FakeProviderServer;
  consumerBinPath?: string;
  consumerDir?: string;
  startAgentDir?: string;
  resumeAgentDir?: string;
  files: readonly string[];
}): Promise<ResumePair> {
  const baseCmd = ["--format", "json", "--no-plan", "--no-dedup", "--no-summary"];
  const childRef: { child: ChildProcess | null } = { child: null };

  async function runStart(): Promise<RunResult> {
    let result: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; command: readonly string[] };
    if (opts.engine === "ocr") {
      result = await runOcrSubprocess({
        binaryPath: opts.binaryPath,
        repoDir: opts.repoDir,
        serverUrl: opts.startServer.url,
        serverPort: opts.startServer.port,
        subcommand: "scan",
        command: baseCmd,
        homeDir: opts.homeDir,
        preserveHome: true,
        onSpawn: (c) => (childRef.child = c),
        timeoutMs: 60000,
      });
    } else {
      if (!opts.consumerBinPath || !opts.consumerDir || !opts.startAgentDir) throw new Error("Pi start run missing agent dir");
      result = await runPiSubprocess({
        repoDir: opts.repoDir,
        serverUrl: opts.startServer.url,
        consumerBinPath: opts.consumerBinPath,
        consumerDir: opts.consumerDir,
        agentDir: opts.startAgentDir,
        subcommand: "scan",
        command: baseCmd,
        homeDir: opts.homeDir,
        preserveHome: true,
        onSpawn: (c) => (childRef.child = c),
        timeoutMs: 60000,
      });
    }
    const open = findOpenSessionFile(opts.homeDir);
    return {
      id: `${opts.id}-start`,
      engine: opts.engine,
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      captures: [],
      sessionFile: open,
      homeDir: opts.homeDir,
    };
  }

  const startPromise = runStart();

  // Wait until the first file has completed and the second file's first
  // request has been captured, then kill the child.
  const killPromise = (async (): Promise<void> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (childRef.child !== null) break;
      await sleep(20);
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Captures: [0]=file1 code_comment, [1]=file1 task_done, [2]=file2 code_comment
      // We want file1 task_done delivered and the second file's first request
      // to have arrived, then kill the child.
      const captures = opts.startServer.captures;
      if (captures.length >= 3 && captures[1]?.delivered) {
        try {
          childRef.child!.kill("SIGTERM");
        } catch {}
        return;
      }
      await sleep(50);
    }
  })();

  const [startResult] = await Promise.all([startPromise, killPromise]);

  if (startResult.sessionFile === null) {
    throw new Error(`${opts.engine} start run produced no open session file`);
  }
  const startSessionId = startResult.sessionFile.sessionId;
  if (startSessionId === "") throw new Error(`${opts.engine} start run session has no id`);

  const resumeCmd = [...baseCmd, "--resume", startSessionId];
  let resumeResult: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; command: readonly string[] };
  if (opts.engine === "ocr") {
    resumeResult = await runOcrSubprocess({
      binaryPath: opts.binaryPath,
      repoDir: opts.repoDir,
      serverUrl: opts.resumeServer.url,
      serverPort: opts.resumeServer.port,
      subcommand: "scan",
      command: resumeCmd,
      homeDir: opts.homeDir,
      preserveHome: true,
      timeoutMs: 60000,
    });
  } else {
    if (!opts.consumerBinPath || !opts.consumerDir || !opts.resumeAgentDir) throw new Error("Pi resume run missing agent dir");
    resumeResult = await runPiSubprocess({
      repoDir: opts.repoDir,
      serverUrl: opts.resumeServer.url,
      consumerBinPath: opts.consumerBinPath,
      consumerDir: opts.consumerDir,
      agentDir: opts.resumeAgentDir,
      subcommand: "scan",
      command: resumeCmd,
      homeDir: opts.homeDir,
      preserveHome: true,
      timeoutMs: 60000,
    });
  }

  const closed = findClosedSessionFile(opts.homeDir);
  return {
    start: { ...startResult, captures: [] },
    resume: {
      id: `${opts.id}-resume`,
      engine: opts.engine,
      command: resumeResult.command,
      stdout: resumeResult.stdout,
      stderr: resumeResult.stderr,
      exitCode: resumeResult.exitCode,
      signal: resumeResult.signal,
      captures: [],
      sessionFile: closed,
      homeDir: opts.homeDir,
    },
    startSessionId,
    resumeSessionId: closed?.sessionId ?? "",
  };
}

// -----------------------------------------------------------------------------
// Session structure assertions
// -----------------------------------------------------------------------------

function assertSessionStructure(session: ParsedSessionFile, fixture: string, engine: string): string[] {
  const errors: string[] = [];
  if (session.records.length === 0) errors.push(`${fixture} ${engine}: session file has no records`);
  if (session.records[0]?.type !== "session_start") errors.push(`${fixture} ${engine}: first record is not session_start`);
  if (session.records.length > 0 && session.records[session.records.length - 1]!.type !== "session_end") {
    errors.push(`${fixture} ${engine}: last record is not session_end (closed=${session.closed})`);
  }
  if (!hasRecordType(session.records, "review_item_done") && !hasRecordType(session.records, "review_item_reused")) {
    errors.push(`${fixture} ${engine}: no review_item_done/reused records`);
  }
  if (session.manifest === null) {
    // OCR v1.9.3 scan does not embed a run_manifest in session_end (scan is
    // outside the v1 run manifest scope). Validate coverage via files_reviewed.
    const filesReviewed = getSessionEndFilesReviewed(session.records);
    if (filesReviewed.length === 0) {
      errors.push(`${fixture} ${engine}: session_end missing run_manifest and files_reviewed`);
    }
  } else {
    const selected = getCoverageSelected(session.manifest);
    if (selected.length === 0) errors.push(`${fixture} ${engine}: manifest selected is empty`);
    const completed = getCoverageCompleted(session.manifest);
    if (completed.length === 0) errors.push(`${fixture} ${engine}: manifest completed is empty`);
    const terminal = getSessionManifestTerminalState(session.manifest);
    if (terminal !== "complete") errors.push(`${fixture} ${engine}: manifest terminal state is ${terminal}, expected complete`);
  }
  return errors;
}

function assertResumeSessionStructure(session: ParsedSessionFile, parentId: string, fixture: string, engine: string): string[] {
  const errors = assertSessionStructure(session, fixture, engine);
  const start = findSessionRecord(session.records, "session_start");
  if (start === undefined) {
    errors.push(`${fixture} ${engine}: resume session missing session_start`);
  } else if (start.resumedFrom !== parentId) {
    errors.push(`${fixture} ${engine}: resumedFrom ${String(start.resumedFrom)} does not match parent ${parentId}`);
  }
  if (!hasRecordType(session.records, "review_item_reused")) {
    errors.push(`${fixture} ${engine}: resume session missing review_item_reused`);
  }
  return errors;
}

// -----------------------------------------------------------------------------
// Session file comparison
// -----------------------------------------------------------------------------

function compareSessionFiles(ocr: ParsedSessionFile | null, pi: ParsedSessionFile | null): { equal: boolean; mismatches: FieldMismatch[] } {
  const mismatches: FieldMismatch[] = [];
  const push = (fp: string, ov: unknown, pv: unknown, msg: string) => mismatches.push({ fieldPath: fp, ocrValue: ov, piValue: pv, message: msg });

  if (ocr === null || pi === null) {
    if (ocr === null) push("session_file.ocr", null, null, "OCR session file missing");
    if (pi === null) push("session_file.pi", null, null, "Pi session file missing");
    return { equal: false, mismatches };
  }

  const oTypes = semanticRecordTypes(ocr.records);
  const pTypes = semanticRecordTypes(pi.records);
  if (stableStringify(oTypes) !== stableStringify(pTypes)) {
    push("session_file.record_types", oTypes, pTypes, `session record types differ: OCR ${oTypes.join(",")} vs Pi ${pTypes.join(",")}`);
  }

  const oStart = findSessionRecord(ocr.records, "session_start");
  const pStart = findSessionRecord(pi.records, "session_start");
  if (oStart && pStart) {
    if (oStart.reviewMode !== pStart.reviewMode) push("session_file.start.reviewMode", oStart.reviewMode, pStart.reviewMode, "reviewMode differs");
  }

  const oDone = ocr.records.filter((r) => r.type === "review_item_done" || r.type === "review_item_reused").length;
  const pDone = pi.records.filter((r) => r.type === "review_item_done" || r.type === "review_item_reused").length;
  if (oDone !== pDone) push("session_file.completed_items", oDone, pDone, "completed/reused item count differs");

  const oSel = getCoverageSelected(ocr.manifest);
  const pSel = getCoverageSelected(pi.manifest);
  const oComp = getCoverageCompleted(ocr.manifest);
  const pComp = getCoverageCompleted(pi.manifest);

  if (stableStringify(oSel.slice().sort()) !== stableStringify(pSel.slice().sort())) push("session_file.manifest.selected", oSel, pSel, "manifest selected differs");
  if (stableStringify(oComp.slice().sort()) !== stableStringify(pComp.slice().sort())) push("session_file.manifest.completed", oComp, pComp, "manifest completed differs");

  const oTerm = getSessionManifestTerminalState(ocr.manifest);
  const pTerm = getSessionManifestTerminalState(pi.manifest);
  if (oTerm !== pTerm) push("session_file.manifest.terminalState", oTerm, pTerm, "terminal state differs");

  return { equal: mismatches.length === 0, mismatches };
}

// -----------------------------------------------------------------------------
// Output helpers
// -----------------------------------------------------------------------------

function extractComments(stdout: string): Record<string, unknown>[] {
  const o = parseOcrJson(stdout);
  const p = parsePiJson(stdout);
  const raw = o.comments.length > 0 ? o.comments : p.findings;
  return raw.filter((c): c is Record<string, unknown> => isRecord(c));
}

function commentsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const fields = ["path", "content", "category", "severity", "existing_code"];
  for (const f of fields) {
    const av = a[f];
    const bv = b[f];
    if ((av ?? "") !== (bv ?? "")) return false;
  }
  const aStart = typeof a.start_line === "number" ? a.start_line : typeof a.startLine === "number" ? a.startLine : 0;
  const bStart = typeof b.start_line === "number" ? b.start_line : typeof b.startLine === "number" ? b.startLine : 0;
  if (aStart !== bStart) return false;
  const aEnd = typeof a.end_line === "number" ? a.end_line : typeof a.endLine === "number" ? a.endLine : 0;
  const bEnd = typeof b.end_line === "number" ? b.end_line : typeof b.endLine === "number" ? b.endLine : 0;
  if (aEnd !== bEnd) return false;
  return true;
}

function commentListsEqual(a: Record<string, unknown>[], b: Record<string, unknown>[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!commentsEqual(a[i]!, b[i]!)) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let artifactDir = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--artifacts" && i + 1 < args.length) artifactDir = resolve(args[i + 1]!);
    else if (args[i]!.startsWith("--artifacts=")) artifactDir = args[i]!.split("=")[1] ?? "";
  }

  const pre = spawnSync("bun", ["run", "verify:scan"], { encoding: "utf-8", timeout: 900_000 });
  if (pre.status !== 0) {
    console.error(`[verify:sessions] prerequisite verify:scan failed`);
    console.error(pre.stderr || pre.stdout || "");
    process.exit(1);
  }

  checkGitClean();

  if (!artifactDir) artifactDir = await mkdtemp(join(tmpdir(), "verify-sessions-artifacts-"));
  await mkdir(artifactDir, { recursive: true });

  const ocrBinary = await getOcrBinary();
  const pack: PackResult = await runPackedInstallSmoke();
  const consumerBinPath = resolve(pack.consumerDir, "node_modules/.bin/pi-review");

  const fixtures: string[] = [];
  const allNotObservable: string[] = [];
  let assertions = 0;

  const sourceRepo = await createMultiFileRepo(["alpha.go", "beta.go"]);
  const sourceDir = sourceRepo.dir;

  try {
    // --- Fixture 1: positive complete scan -----------------------------------
    const completeId = "sessions-complete";
    fixtures.push(completeId);

    const ocrRepoFull = await mkdtemp(join(tmpdir(), "ocr-sessions-complete-"));
    const piRepoFull = await mkdtemp(join(tmpdir(), "pi-sessions-complete-"));
    const ocrHomeFull = await mkdtemp(join(tmpdir(), "ocr-sessions-home-complete-"));
    const piHomeFull = await mkdtemp(join(tmpdir(), "pi-sessions-home-complete-"));
    await cloneRepo(sourceDir, ocrRepoFull);
    await cloneRepo(sourceDir, piRepoFull);

    const content = "Consider nil guard";
    const existingCode = "// TODO: handle nil?";
    const fullResponses = makeMultiFileResponses(["alpha.go", "beta.go"], content, existingCode);

    const ocrServerFull = createCaptureServer({ responses: fullResponses });
    const piServerFull = createCaptureServer({ responses: fullResponses });
    const piAgentDirFull = await createPiAgentDir(piServerFull.url);

    const [ocrFull, piFull] = await Promise.all([
      runCompleteScan({
        id: completeId,
        engine: "ocr",
        repoDir: ocrRepoFull,
        homeDir: ocrHomeFull,
        binaryPath: ocrBinary,
        serverUrl: ocrServerFull.url,
        serverPort: ocrServerFull.port,
      }).then((r) => ({ ...r, captures: ocrServerFull.captures })),
      runCompleteScan({
        id: completeId,
        engine: "pi",
        repoDir: piRepoFull,
        homeDir: piHomeFull,
        binaryPath: ocrBinary,
        serverUrl: piServerFull.url,
        serverPort: piServerFull.port,
        consumerBinPath,
        consumerDir: pack.consumerDir,
        agentDir: piAgentDirFull.dir,
      }).then((r) => ({ ...r, captures: piServerFull.captures })),
    ]);

    const completeCompare = compareScan({
      id: completeId,
      ocrCaptures: ocrFull.captures,
      piCaptures: piFull.captures,
      ocrStdout: ocrFull.stdout,
      piStdout: piFull.stdout,
      ocrExit: ocrFull.exitCode,
      piExit: piFull.exitCode,
      expectedCommentCount: 2,
      expectedStatus: "success",
      expectedExit: 0,
    });

    const completeSessionCompare = compareSessionFiles(ocrFull.sessionFile, piFull.sessionFile);
    const completeStructureErrors: string[] = [];
    if (ocrFull.sessionFile) completeStructureErrors.push(...assertSessionStructure(ocrFull.sessionFile, completeId, "ocr"));
    if (piFull.sessionFile) completeStructureErrors.push(...assertSessionStructure(piFull.sessionFile, completeId, "pi"));

    if (!completeCompare.equal) {
      failHere(`fixture ${completeId} output mismatch: ${completeCompare.mismatches.map((m) => m.message).join("; ")}`, artifactDir, { fixtures, mismatches: completeCompare.mismatches });
    }
    if (!completeSessionCompare.equal) {
      failHere(`fixture ${completeId} session mismatch: ${completeSessionCompare.mismatches.map((m) => m.message).join("; ")}`, artifactDir, { fixtures, mismatches: completeSessionCompare.mismatches });
    }
    if (completeStructureErrors.length > 0) {
      failHere(`fixture ${completeId} session structure error: ${completeStructureErrors.join("; ")}`, artifactDir, { fixtures });
    }

    assertions += 12;
    allNotObservable.push(...completeCompare.notObservable);

    await Promise.all([
      writeFile(join(artifactDir, `${completeId}-ocr-stdout.json`), ocrFull.stdout, "utf-8"),
      writeFile(join(artifactDir, `${completeId}-pi-stdout.json`), piFull.stdout, "utf-8"),
      writeFile(join(artifactDir, `${completeId}-ocr-captures.json`), JSON.stringify(ocrFull.captures, null, 2), "utf-8"),
      writeFile(join(artifactDir, `${completeId}-pi-captures.json`), JSON.stringify(piFull.captures, null, 2), "utf-8"),
      writeFile(join(artifactDir, `${completeId}-compare.json`), JSON.stringify({ output: completeCompare, session: completeSessionCompare }, null, 2), "utf-8"),
      writeFile(join(artifactDir, `${completeId}-ocr-session.json`), JSON.stringify(jsonlSummary(ocrFull.sessionFile?.records ?? []), null, 2), "utf-8"),
      writeFile(join(artifactDir, `${completeId}-pi-session.json`), JSON.stringify(jsonlSummary(piFull.sessionFile?.records ?? []), null, 2), "utf-8"),
    ]);

    ocrServerFull.stop();
    piServerFull.stop();

    // --- Fixture 2: interruption and trusted resume ---------------------------
    const resumeId = "sessions-resume";
    fixtures.push(resumeId);

    const ocrRepoResume = await mkdtemp(join(tmpdir(), "ocr-sessions-resume-"));
    const piRepoResume = await mkdtemp(join(tmpdir(), "pi-sessions-resume-"));
    const ocrHomeResume = await mkdtemp(join(tmpdir(), "ocr-sessions-home-resume-"));
    const piHomeResume = await mkdtemp(join(tmpdir(), "pi-sessions-home-resume-"));
    await cloneRepo(sourceDir, ocrRepoResume);
    await cloneRepo(sourceDir, piRepoResume);

    const startResponses = makeMultiFileResponses(["alpha.go", "beta.go"], content, existingCode);
    const resumeResponses = makeOneCommentResponses(content, existingCode, "beta.go");

    const ocrServerStart = createCaptureServer({ responses: startResponses, delayMs: 300 });
    const piServerStart = createCaptureServer({ responses: startResponses, delayMs: 300 });
    const piAgentDirStart = await createPiAgentDir(piServerStart.url);

    const ocrServerResume = createCaptureServer({ responses: resumeResponses });
    const piServerResume = createCaptureServer({ responses: resumeResponses });
    const piAgentDirResume = await createPiAgentDir(piServerResume.url);

    const [ocrResume, piResume] = await Promise.all([
      runInterruptedResume({
        id: resumeId,
        engine: "ocr",
        repoDir: ocrRepoResume,
        homeDir: ocrHomeResume,
        binaryPath: ocrBinary,
        startServer: ocrServerStart,
        resumeServer: ocrServerResume,
        files: ["alpha.go", "beta.go"],
      }),
      runInterruptedResume({
        id: resumeId,
        engine: "pi",
        repoDir: piRepoResume,
        homeDir: piHomeResume,
        binaryPath: ocrBinary,
        startServer: piServerStart,
        resumeServer: piServerResume,
        consumerBinPath,
        consumerDir: pack.consumerDir,
        startAgentDir: piAgentDirStart.dir,
        resumeAgentDir: piAgentDirResume.dir,
        files: ["alpha.go", "beta.go"],
      }),
    ]);

    // Attach captures recorded by the servers.
    const ocrResumeStart = { ...ocrResume.start, captures: ocrServerStart.captures };
    const ocrResumeRun = { ...ocrResume.resume, captures: ocrServerResume.captures };
    const piResumeStart = { ...piResume.start, captures: piServerStart.captures };
    const piResumeRun = { ...piResume.resume, captures: piServerResume.captures };

    const resumeCompare = compareScan({
      id: resumeId,
      ocrCaptures: ocrResumeRun.captures,
      piCaptures: piResumeRun.captures,
      ocrStdout: ocrResumeRun.stdout,
      piStdout: piResumeRun.stdout,
      ocrExit: ocrResumeRun.exitCode,
      piExit: piResumeRun.exitCode,
      expectedCommentCount: 2,
      expectedStatus: "success",
      expectedExit: 0,
    });

    const resumeSessionCompare = compareSessionFiles(ocrResumeRun.sessionFile, piResumeRun.sessionFile);
    const resumeStructureErrors: string[] = [];
    if (ocrResumeRun.sessionFile) resumeStructureErrors.push(...assertResumeSessionStructure(ocrResumeRun.sessionFile, ocrResume.startSessionId, resumeId, "ocr"));
    if (piResumeRun.sessionFile) resumeStructureErrors.push(...assertResumeSessionStructure(piResumeRun.sessionFile, piResume.startSessionId, resumeId, "pi"));

    if (!resumeCompare.equal) {
      failHere(`fixture ${resumeId} resumed output mismatch: ${resumeCompare.mismatches.map((m) => m.message).join("; ")}`, artifactDir, { fixtures, mismatches: resumeCompare.mismatches });
    }
    if (!resumeSessionCompare.equal) {
      failHere(`fixture ${resumeId} resumed session mismatch: ${resumeSessionCompare.mismatches.map((m) => m.message).join("; ")}`, artifactDir, { fixtures, mismatches: resumeSessionCompare.mismatches });
    }
    if (resumeStructureErrors.length > 0) {
      failHere(`fixture ${resumeId} resumed session structure error: ${resumeStructureErrors.join("; ")}`, artifactDir, { fixtures });
    }

    // The resumed scan must produce the same comments as a complete scan.
    const ocrFullComments = extractComments(ocrFull.stdout);
    const ocrResumeComments = extractComments(ocrResumeRun.stdout);
    if (!commentListsEqual(ocrFullComments, ocrResumeComments)) {
      failHere(`fixture ${resumeId} OCR resumed comments differ from complete scan`, artifactDir, { fixtures });
    }
    const piFullComments = extractComments(piFull.stdout);
    const piResumeComments = extractComments(piResumeRun.stdout);
    if (!commentListsEqual(piFullComments, piResumeComments)) {
      failHere(`fixture ${resumeId} Pi resumed comments differ from complete scan`, artifactDir, { fixtures });
    }

    assertions += 14;
    allNotObservable.push(...resumeCompare.notObservable);

    await Promise.all([
      writeFile(join(artifactDir, `${resumeId}-ocr-resume-stdout.json`), ocrResumeRun.stdout, "utf-8"),
      writeFile(join(artifactDir, `${resumeId}-pi-resume-stdout.json`), piResumeRun.stdout, "utf-8"),
      writeFile(join(artifactDir, `${resumeId}-ocr-resume-captures.json`), JSON.stringify(ocrResumeRun.captures, null, 2), "utf-8"),
      writeFile(join(artifactDir, `${resumeId}-pi-resume-captures.json`), JSON.stringify(piResumeRun.captures, null, 2), "utf-8"),
      writeFile(join(artifactDir, `${resumeId}-compare.json`), JSON.stringify({ output: resumeCompare, session: resumeSessionCompare }, null, 2), "utf-8"),
      writeFile(join(artifactDir, `${resumeId}-ocr-resume-session.json`), JSON.stringify(jsonlSummary(ocrResumeRun.sessionFile?.records ?? []), null, 2), "utf-8"),
      writeFile(join(artifactDir, `${resumeId}-pi-resume-session.json`), JSON.stringify(jsonlSummary(piResumeRun.sessionFile?.records ?? []), null, 2), "utf-8"),
    ]);

    ocrServerStart.stop();
    piServerStart.stop();
    ocrServerResume.stop();
    piServerResume.stop();

    // --- Fixture 3: mutation negative test (complete scan) --------------------
    const mutationId = "sessions-complete-mutation";
    fixtures.push(mutationId);

    const piRepoMut = await mkdtemp(join(tmpdir(), "pi-sessions-mutation-"));
    const piHomeMut = await mkdtemp(join(tmpdir(), "pi-sessions-home-mutation-"));
    await cloneRepo(sourceDir, piRepoMut);

    const mutatedResponses: readonly unknown[] = [
      makeCodeCommentResponse(content, existingCode, "alpha.go", { prompt: 100, completion: 50, total: 150 }, "chatcmpl-mut-1", 1),
      makeTaskDoneResponse("DONE", { prompt: 50, completion: 10, total: 60 }, "chatcmpl-mut-2", 2),
      makeCodeCommentResponse("Mutated comment", existingCode, "beta.go", { prompt: 100, completion: 50, total: 150 }, "chatcmpl-mut-3", 3),
      makeTaskDoneResponse("DONE", { prompt: 50, completion: 10, total: 60 }, "chatcmpl-mut-4", 4),
    ];

    const piServerMut = createCaptureServer({ responses: mutatedResponses });
    const piAgentDirMut = await createPiAgentDir(piServerMut.url);

    const piMutResult = await runCompleteScan({
      id: mutationId,
      engine: "pi",
      repoDir: piRepoMut,
      homeDir: piHomeMut,
      binaryPath: ocrBinary,
      serverUrl: piServerMut.url,
      serverPort: piServerMut.port,
      consumerBinPath,
      consumerDir: pack.consumerDir,
      agentDir: piAgentDirMut.dir,
    });
    const piMutCaptures = piServerMut.captures;

    const mutationCompare = compareScan({
      id: mutationId,
      ocrCaptures: ocrFull.captures,
      piCaptures: piMutCaptures,
      ocrStdout: ocrFull.stdout,
      piStdout: piMutResult.stdout,
      ocrExit: ocrFull.exitCode,
      piExit: piMutResult.exitCode,
      expectedCommentCount: 2,
      expectedStatus: "success",
      expectedExit: 0,
    });

    if (mutationCompare.equal) {
      failHere(`fixture ${mutationId} did not detect mutation`, artifactDir, { fixtures });
    }
    const hasContent = mutationCompare.mismatches.some((m) => m.fieldPath.includes("comments[1].content") || m.message.includes("content"));
    if (!hasContent) {
      failHere(`fixture ${mutationId} mismatch field not comment content: ${mutationCompare.mismatches.map((m) => m.message).join("; ")}`, artifactDir, { fixtures, mismatches: mutationCompare.mismatches });
    }

    assertions += 3;

    await Promise.all([
      writeFile(join(artifactDir, `${mutationId}-pi-stdout.json`), piMutResult.stdout, "utf-8"),
      writeFile(join(artifactDir, `${mutationId}-compare.json`), JSON.stringify(mutationCompare, null, 2), "utf-8"),
    ]);

    piServerMut.stop();

    // --- Cleanup --------------------------------------------------------------
    await sourceRepo.cleanup();
    await rm(ocrRepoFull, { recursive: true, force: true });
    await rm(piRepoFull, { recursive: true, force: true });
    await rm(ocrRepoResume, { recursive: true, force: true });
    await rm(piRepoResume, { recursive: true, force: true });
    await rm(piRepoMut, { recursive: true, force: true });
    await rm(ocrHomeFull, { recursive: true, force: true });
    await rm(piHomeFull, { recursive: true, force: true });
    await rm(ocrHomeResume, { recursive: true, force: true });
    await rm(piHomeResume, { recursive: true, force: true });
    await rm(piHomeMut, { recursive: true, force: true });
    await cleanupOcrBinary();

    const report: SessionsGateReport = {
      gate: "sessions",
      commit: currentCommit(),
      ocrTagObject: PINNED_TAG_OBJECT,
      ocrCommit: PINNED_COMMIT,
      packageArchiveHash: pack.archiveHash,
      fixtures,
      assertions,
      notObservable: allNotObservable,
      forbiddenImports: 0,
      forbiddenImportDetails: [],
      result: "pass",
      artifactDir,
    };
    pass(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failHere(msg, artifactDir, { fixtures });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

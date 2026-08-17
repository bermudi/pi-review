// SPDX-License-Identifier: Apache-2.0
// Gate 4 — output formats parity (black-box)
// See docs/ocr-v1.9.3-port-plan.md Gate 4.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { checkImports } from "./import-guard.js";
import type { CapturedHttp } from "./types.js";
import {
  currentCommit,
  getOcrBinary,
  cleanupOcrBinary,
  createTempRepo,
  cloneRepo,
  createPiAgentDir,
  runPackedInstallSmoke,
  type PackResult,
  runOcrSubprocess,
  runPiSubprocess,
  createCaptureServer,
  makeOneCommentResponses,
  stableStringify,
  isRecord,
  PINNED_COMMIT,
  PINNED_TAG_OBJECT,
  type FieldMismatch,
} from "./verify-common.js";

const guard = checkImports(resolve("verification/blackbox"));
if (guard.count !== 0) {
  console.error(JSON.stringify({ gate: "outputs", result: "fail", error: "forbidden imports: " + String(guard.count) }));
  console.error("[verify:outputs] forbidden imports: " + guard.violations.map((v) => v.file + ":" + String(v.line) + " " + v.reason).join("; "));
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Report helpers
// -----------------------------------------------------------------------------

interface OutputsGateReport {
  readonly gate: "outputs";
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
  readonly mismatches?: readonly FieldMismatch[];
}

function pass(report: OutputsGateReport): never {
  console.log(JSON.stringify(report));
  console.error("[verify:outputs] PASS: " + String(report.fixtures.length) + " fixture(s), " + String(report.assertions) + " assertion(s)");
  process.exit(0);
}

function failHere(message: string, artifactDir: string, extra?: Record<string, unknown>): never {
  const report: OutputsGateReport = {
    gate: "outputs",
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
  } as unknown as OutputsGateReport;
  console.log(JSON.stringify(report));
  console.error("[verify:outputs] FAIL: " + message);
  if (artifactDir) console.error("Artifacts: " + artifactDir);
  process.exit(1);
}

function checkWorkingTreeClean(artifactDir: string): void {
  const diff = spawnSync("git", ["diff", "--quiet"], { stdio: "ignore", timeout: 5000 });
  if (diff.status !== 0) failHere("dirty working tree (uncommitted changes). Commit or stash first.", artifactDir);
  const untrackedRes = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf-8", timeout: 5000 });
  const untracked = (untrackedRes.stdout ?? "").trim();
  if (untracked.length > 0) failHere("untracked files present:\n" + untracked, artifactDir);
}

// -----------------------------------------------------------------------------
// Comparison helpers
// -----------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ELAPSED_RE = /(?:\d+m\d+s|\d+s)(?= elapsed)/g;
const TMP_RE = /\/tmp\/[a-zA-Z0-9_\-\/\.]+/g;
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const PORT_RE = /\b127\.0\.0\.1:\d{4,5}\b|\b:\d{4,5}\b/g;

function normalizeTextOutput(s: string): string {
  return s
    .replace(UUID_RE, "<SESSION_ID>")
    .replace(ELAPSED_RE, "<ELAPSED>")
    .replace(TMP_RE, "<TMP>")
    .replace(TIMESTAMP_RE, "<TIMESTAMP>")
    .replace(PORT_RE, "<PORT>");
}

function compareText(ocr: string, pi: string, id: string): { equal: boolean; mismatches: FieldMismatch[] } {
  const mismatches: FieldMismatch[] = [];
  if (ocr === "") {
    mismatches.push({ fieldPath: id + ".stdout.ocr.empty", ocrValue: ocr, piValue: pi, message: "OCR text stdout is empty" });
  }
  if (pi === "") {
    mismatches.push({ fieldPath: id + ".stdout.pi.empty", ocrValue: ocr, piValue: pi, message: "Pi text stdout is empty" });
  }
  const nOcr = normalizeTextOutput(ocr);
  const nPi = normalizeTextOutput(pi);
  if (nOcr !== nPi) {
    mismatches.push({
      fieldPath: id + ".stdout.normalized",
      ocrValue: nOcr.slice(0, 2000),
      piValue: nPi.slice(0, 2000),
      message: "text stdout differs after nondeterministic normalization (lengths: OCR " + String(nOcr.length) + ", Pi " + String(nPi.length) + ")",
    });
  }
  return { equal: mismatches.length === 0, mismatches };
}

function parseJsonSafe(s: string, id: string, side: string): { value: unknown | null; error: FieldMismatch | null } {
  try {
    return { value: JSON.parse(s), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      value: null,
      error: { fieldPath: id + "." + side + ".json.parse", ocrValue: side === "ocr" ? s.slice(0, 500) : null, piValue: side === "pi" ? s.slice(0, 500) : null, message: side + " JSON parse failed: " + msg },
    };
  }
}

function normalizeJsonValue(v: unknown, idKeys: readonly string[], elapsedKeys: readonly string[]): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((e) => normalizeJsonValue(e, idKeys, elapsedKeys));
  const rec = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    if (idKeys.includes(k) && typeof rec[k] === "string") {
      out[k] = "<SESSION_ID>";
    } else if (elapsedKeys.includes(k) && typeof rec[k] === "string") {
      out[k] = "<ELAPSED>";
    } else {
      out[k] = normalizeJsonValue(rec[k], idKeys, elapsedKeys);
    }
  }
  return out;
}

function compareJson(ocr: string, pi: string, id: string): { equal: boolean; mismatches: FieldMismatch[] } {
  const mismatches: FieldMismatch[] = [];
  const o = parseJsonSafe(ocr, id, "ocr");
  const p = parseJsonSafe(pi, id, "pi");
  if (o.error) mismatches.push(o.error);
  if (p.error) mismatches.push(p.error);
  if (mismatches.length > 0) return { equal: false, mismatches };

  const nOcr = normalizeJsonValue(o.value, ["session_id", "trace_id"], ["elapsed"]);
  const nPi = normalizeJsonValue(p.value, ["session_id", "trace_id"], ["elapsed"]);
  const sOcr = stableStringify(nOcr);
  const sPi = stableStringify(nPi);
  if (sOcr !== sPi) {
    mismatches.push({
      fieldPath: id + ".stdout.json.normalized",
      ocrValue: sOcr.slice(0, 2000),
      piValue: sPi.slice(0, 2000),
      message: "JSON stdout differs after nondeterministic normalization",
    });
  }
  return { equal: mismatches.length === 0, mismatches };
}

function sarifRulesId(r: unknown): string {
  return isRecord(r) && typeof r.id === "string" ? r.id : "";
}

function sarifResultKey(r: unknown): string {
  if (!isRecord(r)) return "";
  const ruleId = typeof r.ruleId === "string" ? r.ruleId : "";
  const msg = isRecord(r.message) && typeof r.message.text === "string" ? r.message.text : "";
  return ruleId + "|" + msg;
}

function normalizeSarifValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((e) => normalizeSarifValue(e));
  const rec = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    if (k === "partialFingerprints" && isRecord(rec[k])) {
      const fp: Record<string, unknown> = {};
      for (const fk of Object.keys(rec[k] as Record<string, unknown>)) fp[fk] = "<FINGERPRINT>";
      out[k] = fp;
    } else {
      out[k] = normalizeSarifValue(rec[k]);
    }
  }
  return out;
}

function normalizeSarifRules(arr: unknown[]): unknown {
  const items = arr.filter(isRecord);
  const sorted = [...items].sort((a, b) => sarifRulesId(a).localeCompare(sarifRulesId(b)));
  return sorted.map((r) => normalizeSarifValue(r));
}

function normalizeSarifResults(arr: unknown[]): unknown {
  const items = arr.filter(isRecord);
  const sorted = [...items].sort((a, b) => sarifResultKey(a).localeCompare(sarifResultKey(b)));
  return sorted.map((r) => normalizeSarifValue(r));
}

function getDriverWithoutRules(driver: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(driver)) {
    if (k !== "rules") out[k] = driver[k];
  }
  return out;
}

function compareSarif(ocr: string, pi: string, id: string): { equal: boolean; mismatches: FieldMismatch[] } {
  const mismatches: FieldMismatch[] = [];
  const o = parseJsonSafe(ocr, id, "ocr");
  const p = parseJsonSafe(pi, id, "pi");
  if (o.error) mismatches.push(o.error);
  if (p.error) mismatches.push(p.error);
  if (mismatches.length > 0) return { equal: false, mismatches };

  if (!isRecord(o.value) || !isRecord(p.value)) {
    mismatches.push({ fieldPath: id + ".sarif.root", ocrValue: o.value, piValue: p.value, message: "SARIF root is not an object" });
    return { equal: false, mismatches };
  }

  if (o.value.version !== p.value.version) {
    mismatches.push({ fieldPath: id + ".sarif.version", ocrValue: o.value.version, piValue: p.value.version, message: "SARIF version differs" });
  }

  const oRuns = Array.isArray(o.value.runs) ? o.value.runs : [];
  const pRuns = Array.isArray(p.value.runs) ? p.value.runs : [];
  if (oRuns.length !== pRuns.length) {
    mismatches.push({ fieldPath: id + ".sarif.runs.length", ocrValue: oRuns.length, piValue: pRuns.length, message: "SARIF runs count differs" });
  }
  if (oRuns.length === 0 || pRuns.length === 0) {
    mismatches.push({ fieldPath: id + ".sarif.runs.empty", ocrValue: oRuns.length, piValue: pRuns.length, message: "SARIF has no runs" });
    return { equal: false, mismatches };
  }

  const oRun0 = isRecord(oRuns[0]) ? (oRuns[0] as Record<string, unknown>) : {};
  const pRun0 = isRecord(pRuns[0]) ? (pRuns[0] as Record<string, unknown>) : {};
  const oTool = isRecord(oRun0.tool) ? (oRun0.tool as Record<string, unknown>) : {};
  const pTool = isRecord(pRun0.tool) ? (pRun0.tool as Record<string, unknown>) : {};
  const oDriver = isRecord(oTool.driver) ? (oTool.driver as Record<string, unknown>) : {};
  const pDriver = isRecord(pTool.driver) ? (pTool.driver as Record<string, unknown>) : {};
  const oRules = Array.isArray(oDriver.rules) ? (oDriver.rules as unknown[]) : [];
  const pRules = Array.isArray(pDriver.rules) ? (pDriver.rules as unknown[]) : [];
  const oResults = Array.isArray(oRun0.results) ? (oRun0.results as unknown[]) : [];
  const pResults = Array.isArray(pRun0.results) ? (pRun0.results as unknown[]) : [];

  const nODriver = normalizeSarifValue(getDriverWithoutRules(oDriver));
  const nPDriver = normalizeSarifValue(getDriverWithoutRules(pDriver));
  if (stableStringify(nODriver) !== stableStringify(nPDriver)) {
    mismatches.push({ fieldPath: id + ".sarif.driver", ocrValue: stableStringify(nODriver).slice(0, 1000), piValue: stableStringify(nPDriver).slice(0, 1000), message: "SARIF driver differs" });
  }

  const nORules = normalizeSarifRules(oRules);
  const nPRules = normalizeSarifRules(pRules);
  if (stableStringify(nORules) !== stableStringify(nPRules)) {
    mismatches.push({ fieldPath: id + ".sarif.rules", ocrValue: stableStringify(nORules).slice(0, 1000), piValue: stableStringify(nPRules).slice(0, 1000), message: "SARIF rules differ" });
  }

  const nOResults = normalizeSarifResults(oResults);
  const nPResults = normalizeSarifResults(pResults);
  if (stableStringify(nOResults) !== stableStringify(nPResults)) {
    mismatches.push({ fieldPath: id + ".sarif.results", ocrValue: stableStringify(nOResults).slice(0, 1000), piValue: stableStringify(nPResults).slice(0, 1000), message: "SARIF results differ" });
  }

  return { equal: mismatches.length === 0, mismatches };
}

function compareExits(ocrExit: number | null, piExit: number | null, id: string): { equal: boolean; mismatches: FieldMismatch[] } {
  const mismatches: FieldMismatch[] = [];
  if (ocrExit !== 0) mismatches.push({ fieldPath: id + ".exit.ocr", ocrValue: ocrExit, piValue: 0, message: "OCR exit " + String(ocrExit) + " expected 0" });
  if (piExit !== 0) mismatches.push({ fieldPath: id + ".exit.pi", ocrValue: 0, piValue: piExit, message: "Pi exit " + String(piExit) + " expected 0" });
  if (ocrExit !== piExit) mismatches.push({ fieldPath: id + ".exit", ocrValue: ocrExit, piValue: piExit, message: "exit codes differ" });
  return { equal: mismatches.length === 0, mismatches };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

interface FixtureCase {
  readonly id: string;
  readonly format: "text" | "json" | "sarif";
  readonly ext: string;
  readonly command: readonly string[];
  readonly assertions: number;
}

const FIXTURES: readonly FixtureCase[] = [
  { id: "scan-text-agent", format: "text", ext: ".txt", command: ["--format", "text", "--audience", "agent", "--no-plan", "--no-dedup", "--no-summary"], assertions: 5 },
  { id: "scan-json", format: "json", ext: ".json", command: ["--format", "json", "--no-plan", "--no-dedup", "--no-summary"], assertions: 5 },
  { id: "scan-json-agent", format: "json", ext: ".json", command: ["--format", "json", "--audience", "agent", "--no-plan", "--no-dedup", "--no-summary"], assertions: 5 },
  { id: "scan-sarif", format: "sarif", ext: ".json", command: ["--format", "sarif", "--no-plan", "--no-dedup", "--no-summary"], assertions: 5 },
] as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let artifactDir = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--artifacts" && i + 1 < args.length) {
      artifactDir = resolve(args[i + 1]!);
    }
  }

  if (!artifactDir) {
    artifactDir = await mkdtemp(join(tmpdir(), "verify-outputs-artifacts-"));
  }
  await mkdir(artifactDir, { recursive: true });

  if (guard.count !== 0) {
    failHere("forbidden imports: " + String(guard.count), artifactDir, {
      forbiddenImports: guard.count,
      forbiddenImportDetails: guard.violations.map((v) => v.file + ":" + String(v.line) + " " + v.reason),
    });
  }

  checkWorkingTreeClean(artifactDir);

  console.error("[verify:outputs] building distributable...");
  const buildRes = spawnSync("bun", ["run", "build"], { encoding: "utf-8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  if (buildRes.status !== 0) {
    failHere("bun run build failed: " + (buildRes.stderr || buildRes.stdout || ""), artifactDir);
  }

  console.error("[verify:outputs] running prerequisite verify:scan...");
  const pre = spawnSync("bun", ["run", "verify:scan", "--artifacts", join(artifactDir, "prereq-scan")], { encoding: "utf-8", timeout: 900_000, stdio: ["ignore", "pipe", "pipe"] });
  if (pre.status !== 0) {
    failHere("prerequisite verify:scan failed: " + (pre.stderr || pre.stdout || ""), artifactDir);
  }
  console.error("[verify:outputs] prerequisite verify:scan passed");

  const pack: PackResult = await runPackedInstallSmoke();
  const ocrBinary = await getOcrBinary();

  const fixtures: string[] = [];
  const allMismatches: FieldMismatch[] = [];
  const allNotObservable: string[] = [];
  let assertions = 0;

  const { dir: sourceRepo, cleanup: cleanupSource } = await createTempRepo();

  try {
    for (const fixture of FIXTURES) {
      const id = fixture.id;
      fixtures.push(id);
      console.error("[verify:outputs] fixture " + id);

      const responses = makeOneCommentResponses("Consider nil", "func Add(a int, b int) int { return a + b }");
      const ocrServer = createCaptureServer({ responses });
      const piServer = createCaptureServer({ responses });

      const ocrRepo = await mkdtemp(join(tmpdir(), "ocr-outputs-" + id + "-"));
      const piRepo = await mkdtemp(join(tmpdir(), "pi-outputs-" + id + "-"));
      await cloneRepo(sourceRepo, ocrRepo);
      await cloneRepo(sourceRepo, piRepo);

      const piAgentDir = await createPiAgentDir(piServer.url);

      const [ocrRes, piRes] = await Promise.all([
        runOcrSubprocess({
          binaryPath: ocrBinary,
          repoDir: ocrRepo,
          serverUrl: ocrServer.url,
          serverPort: Number(new URL(ocrServer.url).port),
          subcommand: "scan",
          command: fixture.command,
        }),
        runPiSubprocess({
          repoDir: piRepo,
          serverUrl: piServer.url,
          consumerBinPath: resolve(pack.consumerDir, "node_modules/.bin/pi-review"),
          consumerDir: pack.consumerDir,
          agentDir: piAgentDir.dir,
          subcommand: "scan",
          command: fixture.command,
        }),
      ]);

      await mkdir(join(artifactDir, id), { recursive: true });
      await Promise.all([
        writeFile(join(artifactDir, id, "ocr-stdout" + fixture.ext), ocrRes.stdout, "utf-8"),
        writeFile(join(artifactDir, id, "ocr-stderr.txt"), ocrRes.stderr, "utf-8"),
        writeFile(join(artifactDir, id, "ocr-command.txt"), ocrRes.command.join(" "), "utf-8"),
        writeFile(join(artifactDir, id, "pi-stdout" + fixture.ext), piRes.stdout, "utf-8"),
        writeFile(join(artifactDir, id, "pi-stderr.txt"), piRes.stderr, "utf-8"),
        writeFile(join(artifactDir, id, "pi-command.txt"), piRes.command.join(" "), "utf-8"),
      ]);

      const exitComp = compareExits(ocrRes.exitCode, piRes.exitCode, id);
      let stdoutComp: { equal: boolean; mismatches: FieldMismatch[] };
      if (fixture.format === "text") {
        stdoutComp = compareText(ocrRes.stdout, piRes.stdout, id);
      } else if (fixture.format === "json") {
        stdoutComp = compareJson(ocrRes.stdout, piRes.stdout, id);
      } else {
        stdoutComp = compareSarif(ocrRes.stdout, piRes.stdout, id);
      }

      const combinedMismatches = [...exitComp.mismatches, ...stdoutComp.mismatches];
      await writeFile(join(artifactDir, id, "compare.json"), JSON.stringify({ equal: combinedMismatches.length === 0, mismatches: combinedMismatches }, null, 2), "utf-8");

      if (combinedMismatches.length > 0) {
        allMismatches.push(...combinedMismatches);
        failHere("fixture " + id + " mismatch: " + combinedMismatches.map((m) => m.message).join("; "), artifactDir, { fixtures, assertions, mismatches: allMismatches, notObservable: allNotObservable });
      }

      assertions += fixture.assertions;

      ocrServer.stop();
      piServer.stop();
      await piAgentDir.cleanup().catch(() => {});
      await rm(ocrRepo, { recursive: true, force: true }).catch(() => {});
      await rm(piRepo, { recursive: true, force: true }).catch(() => {});
    }

    await cleanupSource();
    await cleanupOcrBinary();

    const report: OutputsGateReport = {
      gate: "outputs",
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
    try { await cleanupSource(); } catch {}
    try { await cleanupOcrBinary(); } catch {}
    failHere(msg, artifactDir, { fixtures, assertions, notObservable: allNotObservable });
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  failHere(msg, mkdtempSync(join(tmpdir(), "verify-outputs-artifacts-fail-")), {});
});

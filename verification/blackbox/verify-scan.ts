// SPDX-License-Identifier: Apache-2.0
// Black-box differential verifier for Gate 4 scan parity.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { checkImports } from "./import-guard.js";
import type { CapturedHttp } from "./types.js";
import {
  checkGitClean,
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
  parseOcrJson,
  parsePiJson,
  extractCommentContent,
  usageTotalTokensFromSummary,
  extractCapturedMessagesDeep,
  extractCapturedToolsDeep,
  stableStringify,
  isRecord,
  PINNED_COMMIT,
  PINNED_TAG_OBJECT,
} from "./verify-common.js";

const guard = checkImports(resolve("verification/blackbox"));
if (guard.count !== 0) {
  console.error(JSON.stringify({ gate: "scan", result: "fail", error: `forbidden imports: ${guard.count}` }));
  console.error(`[verify:scan] forbidden imports: ${guard.violations.map((v) => `${v.file}:${v.line} ${v.reason}`).join("; ")}`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Report helpers
// -----------------------------------------------------------------------------

interface ScanGateReport {
  readonly gate: "scan";
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

function pass(report: ScanGateReport): never {
  console.log(JSON.stringify(report));
  console.error(`[verify:scan] PASS: ${report.fixtures.length} fixture(s), ${report.assertions} assertion(s)`);
  process.exit(0);
}

function failHere(message: string, artifactDir: string, extra?: Record<string, unknown>): never {
  const report: ScanGateReport = {
    gate: "scan",
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
  } as unknown as ScanGateReport;
  console.log(JSON.stringify(report));
  console.error(`[verify:scan] FAIL: ${message}`);
  if (artifactDir) console.error(`Artifacts: ${artifactDir}`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Comparison helpers
// -----------------------------------------------------------------------------

interface FieldMismatch {
  readonly fieldPath: string;
  readonly ocrValue: unknown;
  readonly piValue: unknown;
  readonly message: string;
}

function compareScan(opts: {
  readonly id: string;
  readonly ocrCaptures: readonly CapturedHttp[];
  readonly piCaptures: readonly CapturedHttp[];
  readonly ocrStdout: string;
  readonly piStdout: string;
  readonly ocrExit: number | null;
  readonly piExit: number | null;
  readonly expectedCommentCount?: number;
  readonly expectedStatus?: string;
  readonly expectedExit?: number;
  readonly mutateField?: string;
}): { equal: boolean; mismatches: FieldMismatch[]; notObservable: string[] } {
  const mismatches: FieldMismatch[] = [];
  const notObservable: string[] = [];
  const push = (fp: string, ov: unknown, pv: unknown, msg: string) => mismatches.push({ fieldPath: fp, ocrValue: ov, piValue: pv, message: msg });

  const expectedExit = opts.expectedExit ?? 0;
  if (opts.ocrExit !== expectedExit) push("exit.ocr", expectedExit, opts.ocrExit, `OCR exit ${opts.ocrExit} expected ${expectedExit}`);
  if (opts.piExit !== expectedExit) push("exit.pi", expectedExit, opts.piExit, `Pi exit ${opts.piExit} expected ${expectedExit}`);
  if (opts.ocrExit !== opts.piExit) push("exit", opts.ocrExit, opts.piExit, "exit codes differ");

  if (opts.ocrCaptures.length === 0) push("provider_request.count.ocr", 1, 0, "OCR made no provider requests");
  if (opts.piCaptures.length === 0) push("provider_request.count.pi", 1, 0, "Pi made no provider requests");

  if (opts.ocrCaptures.length !== opts.piCaptures.length) {
    push("provider_request.count", opts.ocrCaptures.length, opts.piCaptures.length, "provider request count differs");
  } else if (opts.ocrCaptures.length > 0) {
    for (let i = 0; i < opts.ocrCaptures.length; i++) {
      const o = opts.ocrCaptures[i]!;
      const p = opts.piCaptures[i]!;
      const oTools = extractCapturedToolsDeep(o);
      const pTools = extractCapturedToolsDeep(p);
      if (stableStringify(oTools) !== stableStringify(pTools)) push(`provider_request[${i}].tools`, oTools, pTools, "tool schemas differ");
      const oMsgs = extractCapturedMessagesDeep(o);
      const pMsgs = extractCapturedMessagesDeep(p);
      if (stableStringify(oMsgs) !== stableStringify(pMsgs)) push(`provider_request[${i}].messages`, oMsgs, pMsgs, "provider messages differ");
    }
  }

  const oParsed = parseOcrJson(opts.ocrStdout);
  const pParsed = parsePiJson(opts.piStdout);

  const expectedStatus = opts.expectedStatus ?? "success";
  const oStatus = oParsed.status || "";
  const pStatus = pParsed.status || "";
  if (oStatus !== expectedStatus) push("status.ocr", expectedStatus, oStatus, `OCR status ${oStatus} expected ${expectedStatus}`);
  if (pStatus !== expectedStatus) push("status.pi", expectedStatus, pStatus, `Pi status ${pStatus} expected ${expectedStatus}`);
  if (oStatus !== pStatus) push("status", oStatus, pStatus, "status differs");

  const expectedCount = opts.expectedCommentCount ?? 1;
  if (oParsed.comments.length !== expectedCount) push("comments.count.ocr", expectedCount, oParsed.comments.length, "OCR comment count mismatch");
  if ((pParsed.findings as unknown[]).length !== expectedCount) push("comments.count.pi", expectedCount, (pParsed.findings as unknown[]).length, "Pi comment count mismatch");

  for (let i = 0; i < Math.min(oParsed.comments.length, (pParsed.findings as unknown[]).length); i++) {
    const oC = oParsed.comments[i] as Record<string, unknown>;
    const pC = (pParsed.findings as unknown[])[i] as Record<string, unknown>;
    const fields = ["path", "content", "category", "severity", "existing_code"] as const;
    for (const f of fields) {
      const oV = (oC[f] ?? "") as string;
      const pV = (pC[f] ?? "") as string;
      if (oV !== pV) push(`comments[${i}].${f}`, oV, pV, `comment ${f} differs`);
    }
    const oStart = (typeof oC.start_line === "number" ? oC.start_line : typeof oC.startLine === "number" ? oC.startLine : 0) as number;
    const pStart = (typeof pC.start_line === "number" ? pC.start_line : typeof pC.startLine === "number" ? pC.startLine : 0) as number;
    const oEnd = (typeof oC.end_line === "number" ? oC.end_line : typeof oC.endLine === "number" ? oC.endLine : 0) as number;
    const pEnd = (typeof pC.end_line === "number" ? pC.end_line : typeof pC.endLine === "number" ? pC.endLine : 0) as number;
    if (oStart !== pStart) push(`comments[${i}].start_line`, oStart, pStart, "start line differs");
    if (oEnd !== pEnd) push(`comments[${i}].end_line`, oEnd, pEnd, "end line differs");
  }

  const oUsage = usageTotalTokensFromSummary(oParsed.summary);
  const pUsage = isRecord(pParsed.coverage["summary"]) ? usageTotalTokensFromSummary(pParsed.coverage["summary"] as Record<string, unknown>) : 0;
  if (oUsage !== pUsage) push("usage.total_tokens", oUsage, pUsage, "total token usage differs");
  if (oUsage === 0 && pUsage === 0) notObservable.push("usage.total_tokens");

  if (opts.mutateField === "comments[0].content") {
    const hasContentMismatch = mismatches.some((m) => m.fieldPath.includes("comments[0].content"));
    if (mismatches.length === 0) push("mutation", true, false, "mutated response did not produce a mismatch");
  }

  return { equal: mismatches.length === 0, mismatches, notObservable };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let artifactDir = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--artifacts" && i + 1 < args.length) artifactDir = resolve(args[i + 1]!);
  }

  const pre: string[] = [];
  for (const s of ["blackbox-integrity", "sdk-feasibility", "vertical", "core-review"]) {
    const r = spawnSync("bun", ["run", `verify:${s}`], { encoding: "utf-8", timeout: 120_000 });
    if (r.status !== 0) {
      console.error(`[verify:scan] prerequisite verify:${s} failed`);
      console.error(r.stderr || r.stdout || "");
      process.exit(1);
    }
    pre.push(s);
  }

  checkGitClean();

  if (!artifactDir) artifactDir = await mkdtemp(join(tmpdir(), "verify-scan-artifacts-"));
  await mkdir(artifactDir, { recursive: true });

  const ocrBinary = await getOcrBinary();
  const pack: PackResult = await runPackedInstallSmoke();

  const fixtures: string[] = [];
  const allNotObservable: string[] = [];
  let assertions = 0;

  const { dir: sourceRepo, cleanup: cleanupSource } = await createTempRepo();
  try {
    const ocrRepo = await mkdtemp(join(tmpdir(), "ocr-scan-repo-"));
    const piRepo = await mkdtemp(join(tmpdir(), "pi-scan-repo-"));
    await cloneRepo(sourceRepo, ocrRepo);
    await cloneRepo(sourceRepo, piRepo);

    // Positive fixture
    const id = "scan-one-file-one-comment";
    fixtures.push(id);
    const responses = makeOneCommentResponses("Consider nil", "func Add(a int, b int) int { return a + b }");

    const ocrServer = createCaptureServer({ responses });
    const piServer = createCaptureServer({ responses });

    const piAgentDir = await createPiAgentDir(piServer.url);

    const [ocrRes, piRes] = await Promise.all([
      runOcrSubprocess({ binaryPath: ocrBinary, repoDir: ocrRepo, serverUrl: ocrServer.url, serverPort: Number(new URL(ocrServer.url).port), subcommand: "scan", command: ["--format", "json", "--no-plan", "--no-dedup", "--no-summary"] }),
      runPiSubprocess({ repoDir: piRepo, serverUrl: piServer.url, consumerBinPath: resolve(pack.consumerDir, "node_modules/.bin/pi-review"), consumerDir: pack.consumerDir, agentDir: piAgentDir.dir, subcommand: "scan", command: ["--format", "json", "--no-plan", "--no-dedup", "--no-summary"] }),
    ]);

    const compared = compareScan({
      id,
      ocrCaptures: ocrServer.captures,
      piCaptures: piServer.captures,
      ocrStdout: ocrRes.stdout,
      piStdout: piRes.stdout,
      ocrExit: ocrRes.exitCode,
      piExit: piRes.exitCode,
    });

    // write artifacts
    await Promise.all([
      writeFile(join(artifactDir, `${id}-ocr-stdout.json`), ocrRes.stdout, "utf-8"),
      writeFile(join(artifactDir, `${id}-ocr-stderr.txt`), ocrRes.stderr, "utf-8"),
      writeFile(join(artifactDir, `${id}-ocr-captures.json`), JSON.stringify(ocrServer.captures, null, 2), "utf-8"),
      writeFile(join(artifactDir, `${id}-pi-stdout.json`), piRes.stdout, "utf-8"),
      writeFile(join(artifactDir, `${id}-pi-stderr.txt`), piRes.stderr, "utf-8"),
      writeFile(join(artifactDir, `${id}-pi-command.txt`), piRes.command.join(" "), "utf-8"),
      writeFile(join(artifactDir, `${id}-pi-captures.json`), JSON.stringify(piServer.captures, null, 2), "utf-8"),
      writeFile(join(artifactDir, `${id}-compare.json`), JSON.stringify(compared, null, 2), "utf-8"),
    ]);

    if (!compared.equal) failHere(`fixture ${id} mismatch: ${compared.mismatches.map((m) => m.message).join("; ")}`, artifactDir, { fixtures, mismatches: compared.mismatches });
    assertions += 8;

    ocrServer.stop();
    piServer.stop();

    // Mutation fixture
    const id2 = "scan-mismatch-comment";
    fixtures.push(id2);
    const base = makeOneCommentResponses("Consider nil", "func Add(a int, b int) int { return a + b }");
    const mutated = base.map((r) => {
      const c = JSON.parse(JSON.stringify(r));
      if (isRecord(c) && Array.isArray(c.choices) && isRecord(c.choices[0]) && isRecord(c.choices[0].message) && Array.isArray(c.choices[0].message.tool_calls)) {
        for (const tc of c.choices[0].message.tool_calls as Record<string, unknown>[]) {
          if (isRecord(tc) && isRecord(tc.function) && typeof tc.function.arguments === "string") {
            const args = JSON.parse(tc.function.arguments as string);
            if (isRecord(args) && Array.isArray(args.comments) && args.comments.length > 0) {
              const first = (args.comments as Record<string, unknown>[])[0];
              if (first) first.content = "Mutated comment";
              tc.function.arguments = JSON.stringify(args);
            }
          }
        }
      }
      return c;
    });

    const ocrServer2 = createCaptureServer({ responses: base });
    const piServer2 = createCaptureServer({ responses: mutated });
    const piAgentDir2 = await createPiAgentDir(piServer2.url);

    const [ocrRes2, piRes2] = await Promise.all([
      runOcrSubprocess({ binaryPath: ocrBinary, repoDir: ocrRepo, serverUrl: ocrServer2.url, serverPort: Number(new URL(ocrServer2.url).port), subcommand: "scan", command: ["--format", "json", "--no-plan", "--no-dedup", "--no-summary"] }),
      runPiSubprocess({ repoDir: piRepo, serverUrl: piServer2.url, consumerBinPath: resolve(pack.consumerDir, "node_modules/.bin/pi-review"), consumerDir: pack.consumerDir, agentDir: piAgentDir2.dir, subcommand: "scan", command: ["--format", "json", "--no-plan", "--no-dedup", "--no-summary"] }),
    ]);

    const compared2 = compareScan({
      id: id2,
      ocrCaptures: ocrServer2.captures,
      piCaptures: piServer2.captures,
      ocrStdout: ocrRes2.stdout,
      piStdout: piRes2.stdout,
      ocrExit: ocrRes2.exitCode,
      piExit: piRes2.exitCode,
      mutateField: "comments[0].content",
    });

    await Promise.all([
      writeFile(join(artifactDir, `${id2}-ocr-stdout.json`), ocrRes2.stdout, "utf-8"),
      writeFile(join(artifactDir, `${id2}-pi-stdout.json`), piRes2.stdout, "utf-8"),
      writeFile(join(artifactDir, `${id2}-compare.json`), JSON.stringify(compared2, null, 2), "utf-8"),
    ]);

    if (compared2.equal) failHere(`fixture ${id2} did not detect mutation`, artifactDir, { fixtures });
    const hasContent = compared2.mismatches.some((m) => m.fieldPath.includes("comments[0].content"));
    if (!hasContent) failHere(`fixture ${id2} mismatch field not content`, artifactDir, { fixtures, mismatches: compared2.mismatches });
    assertions += 3;

    ocrServer2.stop();
    piServer2.stop();

    await cleanupSource();
    await rm(ocrRepo, { recursive: true, force: true });
    await rm(piRepo, { recursive: true, force: true });
    await cleanupOcrBinary();

    const report: ScanGateReport = {
      gate: "scan",
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

#!/usr/bin/env bun
// Optional frozen-baseline audit. This is intentionally separate from the
// normal release gate and runs each OCR differential group exactly once.

import { execFileSync, spawnSync } from "node:child_process";

const OCR_TAG_OBJECT = "c95d3907d5448354d3f8a33f2ae5e4f23fdf1c94";
const OCR_COMMIT = "4b6874bd23106b5c68bea6d230bb60303b9f0961";

interface ChildReport {
  readonly gate: string;
  readonly commit: string;
  readonly packageArchiveHash: string | null;
  readonly assertions: number;
  readonly fixtures: readonly string[];
  readonly result: string;
  readonly ocrTagObject?: string;
  readonly ocrCommit?: string;
  readonly artifactDir?: string;
}

function isChildReport(value: unknown): value is ChildReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item["gate"] === "string"
    && typeof item["commit"] === "string"
    && (typeof item["packageArchiveHash"] === "string" || item["packageArchiveHash"] === null)
    && typeof item["assertions"] === "number"
    && Array.isArray(item["fixtures"])
    && typeof item["result"] === "string";
}

function parseReport(stdout: string, step: string): ChildReport {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isChildReport(parsed)) return parsed;
    } catch {
      // Human diagnostics may share stdout; only the final report is relevant.
    }
  }
  throw new Error(`${step} emitted no machine-readable report`);
}

function run(command: readonly string[], timeout: number): { stdout: string; stderr: string } {
  const result = spawnSync(command[0]!, [...command.slice(1)], {
    encoding: "utf8",
    timeout,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().slice(-6000);
    throw new Error(`${command.join(" ")} failed${detail === "" ? "" : `:\n${detail}`}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function main(): Promise<void> {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const reports: ChildReport[] = [];

  console.error("[verify:ocr-baseline] independent release gate...");
  const release = parseReport(run(["bun", "run", "verify:release"], 900_000).stdout, "verify:release");
  reports.push(release);
  console.error("[verify:ocr-baseline] independent release gate PASS");

  console.error("[verify:ocr-baseline] frozen inventory...");
  run(["bun", "run", "verify:ocr-test-port"], 300_000);
  console.error("[verify:ocr-baseline] frozen inventory PASS");

  const steps = [
    "verify:blackbox-integrity",
    "verify:sdk-feasibility",
    "verify:core-review",
    "verify:scan",
    "verify:sessions",
    "verify:outputs",
    "verify:cutover",
  ] as const;

  let archiveHash: string | null = release.packageArchiveHash;
  for (const step of steps) {
    console.error(`[verify:ocr-baseline] ${step}...`);
    const report = parseReport(run(["bun", "run", step], 900_000).stdout, step);
    if (report.result !== "pass") throw new Error(`${step} reported ${report.result}`);
    if (report.commit !== commit) throw new Error(`${step} verified ${report.commit}, expected ${commit}`);
    if (report.ocrTagObject !== OCR_TAG_OBJECT || report.ocrCommit !== OCR_COMMIT) {
      throw new Error(`${step} used the wrong frozen OCR reference`);
    }
    if (report.packageArchiveHash !== null) {
      if (archiveHash !== null && report.packageArchiveHash !== archiveHash) {
        throw new Error(`${step} package hash ${report.packageArchiveHash} differs from ${archiveHash}`);
      }
      archiveHash = report.packageArchiveHash;
    }
    reports.push(report);
    console.error(`[verify:ocr-baseline] ${step} PASS`);
  }

  const assertions = reports.reduce((sum, report) => sum + report.assertions, 0);
  const fixtures = reports.reduce((sum, report) => sum + report.fixtures.length, 0);
  console.log(JSON.stringify({
    gate: "ocr-baseline",
    commit,
    ocrTagObject: OCR_TAG_OBJECT,
    ocrCommit: OCR_COMMIT,
    packageArchiveHash: archiveHash,
    assertions,
    fixtures,
    groups: reports.map((report) => report.gate),
    result: "pass",
  }));
  console.error(`[verify:ocr-baseline] PASS: ${String(assertions)} assertions, ${String(fixtures)} fixtures, each group once`);
}

void main().catch((error: unknown) => {
  console.error(`[verify:ocr-baseline] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

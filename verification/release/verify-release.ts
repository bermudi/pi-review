#!/usr/bin/env bun
// Independent pi-reviewer release gate. No OCR checkout or differential
// reference is required; the frozen OCR baseline has its own optional gate.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkImports } from "../blackbox/import-guard.js";
import { runPackedInstallSmoke } from "../blackbox/package-installer.js";

interface ReleaseReport {
  readonly gate: "release";
  readonly commit: string;
  readonly packageArchiveHash: string | null;
  readonly assertions: number;
  readonly fixtures: readonly string[];
  readonly result: "pass" | "fail";
  readonly error?: string;
}

function commit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function fail(message: string, report: Omit<ReleaseReport, "result" | "error">): never {
  console.error(`[verify:release] FAIL: ${message}`);
  console.log(JSON.stringify({ ...report, result: "fail", error: message } satisfies ReleaseReport));
  process.exit(1);
}

function checkClean(report: Omit<ReleaseReport, "result" | "error">): void {
  const tracked = spawnSync("git", ["diff", "--quiet"], { stdio: "ignore" });
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { stdio: "ignore" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).trim();
  if (tracked.status !== 0 || staged.status !== 0 || untracked !== "") {
    fail(`release verification requires a clean exact commit${untracked === "" ? "" : `; untracked: ${untracked}`}`, report);
  }
}

function runProjectStep(name: string, args: readonly string[], report: Omit<ReleaseReport, "result" | "error">): void {
  console.error(`[verify:release] ${name}...`);
  const result = spawnSync("bun", [...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().slice(-4000);
    fail(`${name} failed${detail === "" ? "" : `:\n${detail}`}`, report);
  }
  console.error(`[verify:release] ${name} PASS`);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function main(): Promise<void> {
  const packageData = JSON.parse(readFileSync("package.json", "utf8")) as { version?: unknown };
  if (typeof packageData.version !== "string") throw new Error("package.json has no string version");
  const packageVersion = packageData.version;
  const base = {
    gate: "release" as const,
    commit: commit(),
    packageArchiveHash: null,
    assertions: 0,
    fixtures: [] as string[],
  };
  checkClean(base);

  const guard = checkImports(resolve("verification/blackbox"));
  if (guard.count !== 0) {
    fail(`forbidden verifier imports: ${guard.violations.map((item) => `${item.file}:${String(item.line)} ${item.reason}`).join("; ")}`, base);
  }

  runProjectStep("typecheck", ["run", "check"], base);
  runProjectStep("unit tests", ["test"], base);
  runProjectStep("build", ["run", "build"], base);

  const pack = await runPackedInstallSmoke().catch((error: unknown) => {
    fail(`packed install failed: ${error instanceof Error ? error.message : String(error)}`, base);
  });
  const reportBase = {
    ...base,
    packageArchiveHash: pack.archiveHash,
  };
  const fixtures = ["packed-help"];
  let assertions = 1;
  const repo = mkdtempSync(join(tmpdir(), "pi-review-release-"));

  try {
    const bin = join(pack.consumerDir, "node_modules", ".bin", "pi-review");
    if (!existsSync(bin)) fail("installed pi-review binary is missing", reportBase);

    const version = spawnSync(bin, ["version"], { cwd: pack.consumerDir, encoding: "utf8", timeout: 15_000 });
    if (version.status !== 0 || !version.stdout.includes(`pi-review ${packageVersion}`)) {
      fail(`installed version command failed: ${version.stderr || version.stdout}`, reportBase);
    }
    fixtures.push("installed-version");
    assertions += 2;

    const outsideGit = spawnSync(
      bin,
      ["review", "--from", "origin/main", "--to", "main"],
      { cwd: pack.consumerDir, encoding: "utf8", timeout: 15_000 },
    );
    if (
      outsideGit.status === 0 ||
      !outsideGit.stderr.includes("pass --repo /path/to/repository") ||
      outsideGit.stderr.includes("Review flags:")
    ) {
      fail(`non-Git diagnostic is not concise: ${outsideGit.stderr}`, reportBase);
    }
    fixtures.push("non-git-hint");
    assertions += 3;

    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "release@example.invalid"]);
    git(repo, ["config", "user.name", "Release Test"]);
    writeFileSync(join(repo, "main.ts"), "export const value = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "base"]);
    writeFileSync(join(repo, "main.ts"), "export const value = 2;\n");
    const preview = spawnSync(
      bin,
      ["review", "--repo", repo, "--preview", "--format", "json"],
      { cwd: pack.consumerDir, encoding: "utf8", timeout: 30_000 },
    );
    if (preview.status !== 0) fail(`installed preview failed: ${preview.stderr || preview.stdout}`, reportBase);
    let previewJson: unknown;
    try {
      previewJson = JSON.parse(preview.stdout);
    } catch {
      fail(`installed preview did not return JSON: ${preview.stdout}`, reportBase);
    }
    if (previewJson === null || typeof previewJson !== "object") fail("installed preview returned a non-object", reportBase);
    fixtures.push("installed-preview");
    assertions += 2;

    const smokeScript = join(pack.consumerDir, "library-smoke.mjs");
    writeFileSync(
      smokeScript,
      'import * as api from "pi-reviewer";\n' +
      'console.log(JSON.stringify({review:typeof api.review,createReviewer:typeof api.createReviewer,runOcrCli:typeof api.runOcrCli}));\n',
    );
    const library = spawnSync("bun", [smokeScript], { cwd: pack.consumerDir, encoding: "utf8", timeout: 15_000 });
    if (library.status !== 0) fail(`installed library import failed: ${library.stderr || library.stdout}`, reportBase);
    const api = JSON.parse(library.stdout) as Record<string, unknown>;
    if (api["review"] !== "function" || api["createReviewer"] !== "function" || api["runOcrCli"] !== "function") {
      fail(`installed library exports are incomplete: ${library.stdout}`, reportBase);
    }
    fixtures.push("installed-library");
    assertions += 3;

    const report: ReleaseReport = {
      ...reportBase,
      fixtures,
      assertions,
      result: "pass",
    };
    console.log(JSON.stringify(report));
    console.error(`[verify:release] PASS: ${String(assertions)} assertions, ${String(fixtures.length)} fixtures`);
  } finally {
    pack.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  const report: ReleaseReport = {
    gate: "release",
    commit: commit(),
    packageArchiveHash: null,
    assertions: 0,
    fixtures: [],
    result: "fail",
    error: error instanceof Error ? error.message : String(error),
  };
  console.error(`[verify:release] fatal: ${report.error}`);
  console.log(JSON.stringify(report));
  process.exit(1);
});

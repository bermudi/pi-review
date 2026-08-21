// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/scan_helpers_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { loadScanResumeState } from "../../../src/ocr-v193/cli/scan.js";
import { newResolver } from "../../../src/ocr-v193/rules/system_rules.js";

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-scan-helpers-"));
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  return dir;
}

function commitFile(dir: string, name: string, content: string, message: string): void {
  fs.writeFileSync(path.join(dir, name), content);
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", message], { cwd: dir });
}

function freshHome(): { home: string; restore: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
  const orig = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    restore: () => {
      if (orig === undefined) delete process.env.HOME;
      else process.env.HOME = orig;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function countSessions(repoDir: string): number {
  const { SessionsDir } = require("../../../src/ocr-v193/session/persist.js") as typeof import("../../../src/ocr-v193/session/persist.js");
  try {
    const dir = SessionsDir(repoDir);
    return fs.readdirSync(dir).filter((e) => e.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

// OCR v1.9.3: TestLoadScanResumeState
test("loadScanResumeState empty and missing", () => {
  const dir = initGitRepo();
  const h = freshHome();
  try {
    const s0 = loadScanResumeState(dir, { resume: "" } as never, []);
    expect(s0).toBeNull();
    expect(() => loadScanResumeState(dir, { resume: "nope" } as never, [])).toThrow();
  } finally {
    h.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunScanPreview
test("runScanPreview produces preview without error", async () => {
  const dir = initGitRepo();
  const h = freshHome();
  try {
    commitFile(dir, "y.go", "package y\n", "add y");
    const resolver = newResolver(dir, "");
    // Use scan provider preview helper: list files via scan provider
    const { previewScan } = await import("../../../src/ocr-v193/scan/preview.js");
    const preview = await previewScan({ repoDir: dir, paths: [] });
    expect(preview.totalFiles).toBeGreaterThanOrEqual(0);
  } finally {
    h.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunScanPreviewJSONFormat
test("runScanPreview JSON format includes y.go as scan", async () => {
  const dir = initGitRepo();
  const h = freshHome();
  try {
    commitFile(dir, "y.go", "package y\n", "add y");
    const { previewScan } = await import("../../../src/ocr-v193/scan/preview.js");
    const preview = await previewScan({ repoDir: dir, paths: [] });
    const found = preview.entries.find((e) => e.path === "y.go");
    expect(found).toBeDefined();
    expect(found!.status).toBe("scan");
    expect(found!.willReview).toBe(true);
  } finally {
    h.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunScanPreviewCreatesNoSession
test("runScanPreview creates no session", async () => {
  const { home, restore } = freshHome();
  const dir = initGitRepo();
  try {
    commitFile(dir, "y.go", "package y\n", "add y");
    const before = countSessions(dir);
    const { previewScan } = await import("../../../src/ocr-v193/scan/preview.js");
    await previewScan({ repoDir: dir, paths: [] });
    const after = countSessions(dir);
    expect(after).toBe(before);
    const sessionsRoot = path.join(home, ".opencodereview", "sessions");
    if (fs.existsSync(sessionsRoot)) {
      const entries = fs.readdirSync(sessionsRoot, { recursive: true } as never) as string[];
      expect(entries.filter((e) => String(e).endsWith(".jsonl")).length).toBe(0);
    }
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

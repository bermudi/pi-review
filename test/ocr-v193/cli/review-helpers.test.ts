// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/review_helpers_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { previewDiffs } from "../../../src/ocr-v193/agent/preview.js";
import { newResolver } from "../../../src/ocr-v193/rules/system_rules.js";
import { loadReviewResumeState, initMCPClients } from "../../../src/ocr-v193/cli/review.js";
import { Registry } from "../../../src/ocr-v193/tool/definitions.js";
import type { Preview } from "../../../src/ocr-v193/model/preview.js";

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-helpers-"));
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
    const entries = fs.readdirSync(dir);
    return entries.filter((e) => e.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

// OCR v1.9.3: TestRunPreview
test("runPreview produces preview without error", async () => {
  const dir = initGitRepo();
  const h = freshHome();
  try {
    commitFile(dir, "x.go", "package x\n", "add x");
    const preview = await previewDiffs({ repoDir: dir, commit: "HEAD" });
    expect(preview.totalFiles).toBeGreaterThanOrEqual(0);
  } finally {
    h.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunPreviewJSONFormat
test("runPreview JSON format filters by extension allowlist", async () => {
  const dir = initGitRepo();
  const h = freshHome();
  try {
    commitFile(dir, "main.go", "package main\n", "add main");
    commitFile(dir, "notes.md", "# notes\n", "add notes");
    const resolver = newResolver(dir, "");
    const filter = resolver.filter;
    const preview = await previewDiffs({ repoDir: dir, commit: "HEAD", fileFilter: filter as never });
    expect(preview.totalFiles).toBe(1);
    const entry = preview.entries[0]!;
    expect(entry.path).toBe("notes.md");
    expect(entry.willReview).toBe(false);
    // ExcludeExtension constant is "unsupported_ext" per model/preview.ts (Go "unsupported_ext")
    expect(entry.excludeReason as string).toBe("unsupported_ext");
  } finally {
    h.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestRunPreviewCreatesNoSession
test("runPreview creates no session", async () => {
  const { home, restore } = freshHome();
  const dir = initGitRepo();
  try {
    commitFile(dir, "x.go", "package x\n", "add x");
    const before = countSessions(dir);
    await previewDiffs({ repoDir: dir, commit: "HEAD" });
    const after = countSessions(dir);
    expect(after).toBe(before);
    // Also assert no session store file leaked under HOME
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

// OCR v1.9.3: TestLoadReviewResumeState
test("loadReviewResumeState empty, workspace rejected, missing session", () => {
  const dir = initGitRepo();
  const h = freshHome();
  try {
    // empty resume returns nil
    const s0 = loadReviewResumeState(dir, { resume: "" } as never);
    expect(s0).toBeNull();

    // workspace resume rejected
    expect(() => loadReviewResumeState(dir, { resume: "sess-1" } as never)).toThrow();

    // missing session load fails
    expect(() => loadReviewResumeState(dir, { resume: "does-not-exist", commit: "HEAD" } as never)).toThrow();
  } finally {
    h.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestInitMCPClients
test("initMCPClients nil, empty, remote without url, stdio without command", () => {
  const reg = new Registry();
  expect(initMCPClients(null as unknown as never, null, reg, "/tmp", "v")).toBeNull();
  expect(initMCPClients(null as unknown as never, { MCPServers: {} } as never, reg, "/tmp", "v")).toBeNull();

  const remoteNoUrl = { MCPServers: { r: { Type: "remote" } } } as never;
  const gotRemote = initMCPClients(null as unknown as never, remoteNoUrl, reg, "/tmp", "v");
  expect(Array.isArray(gotRemote) ? gotRemote.length : 0).toBe(0);

  const stdioNoCmd = { MCPServers: { s: { Type: "stdio" } } } as never;
  const gotStdio = initMCPClients(null as unknown as never, stdioNoCmd, reg, "/tmp", "v");
  expect(Array.isArray(gotStdio) ? gotStdio.length : 0).toBe(0);
});

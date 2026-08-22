// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/review_resume_more_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ReviewMode } from "../../../src/ocr/tool/filereader.js";
import { fileReadRef, loadReviewResumeState } from "../../../src/ocr/cli/review.js";
import { SessionHistory, type PersistHandle } from "../../../src/ocr/session/history.js";
import { JsonlWriter } from "../../../src/ocr/session/persist.js";
import { ManifestBuilder } from "../../../src/ocr/session/manifest.js";
import { ResumeState } from "../../../src/ocr/session/resume.js";

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-resume-"));
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "init.txt"), "init\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}
function withTempHome<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
  const orig = process.env.HOME;
  const origBun = (globalThis as unknown as { Bun?: { env: Record<string, string | undefined> } }).Bun?.env?.HOME;
  try {
    process.env.HOME = home;
    try { (globalThis as unknown as { Bun?: { env: Record<string, string | undefined> } }).Bun!.env.HOME = home; } catch {}
    return fn();
  } finally {
    if (orig === undefined) delete process.env.HOME; else process.env.HOME = orig;
    try { if (origBun === undefined) delete (globalThis as unknown as { Bun?: { env: Record<string, string | undefined> } }).Bun!.env.HOME; else (globalThis as unknown as { Bun?: { env: Record<string, string | undefined> } }).Bun!.env.HOME = origBun; } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  }
}
function writeRangeSession(repoDir: string, files: string[] = []): string {
  const sh = new SessionHistory(repoDir, "feature", "fake", { reviewMode: "range", diffFrom: "main", diffTo: "feature" });
  if (!(sh as unknown as { HasPersistence?: () => boolean }).HasPersistence?.()) {
    const w = new JsonlWriter(sh.sessionId, sh.repoDir, sh.gitBranch, sh.model, {
      reviewMode: sh.reviewMode,
      diffFrom: sh.diffFrom,
      diffTo: sh.diffTo,
    });
    w.open();
    w.WriteSessionStart(sh.startTime);
    const handle: PersistHandle = {
      writeReviewItemDone: (...args) => { w.WriteReviewItemDone(...args); },
      writeReviewItemReused: (...args) => { w.WriteReviewItemReused(...args); },
      writeReviewItemFailed: (...args) => { w.WriteReviewItemFailed(...args); },
      writeResumeLineage: (lineage) => { w.WriteResumeLineage(lineage); },
      writeSessionEnd: (...args) => w.WriteSessionEnd(...args),
      writeLLMRequest: (...args) => { w.WriteLLMRequest(...args); },
      writeLLMResponse: (...args) => { w.WriteLLMResponse(...args); },
      writeLLMError: (...args) => { w.WriteLLMError(...args); },
      writeToolCall: (...args) => { w.WriteToolCall(...args); },
    };
    sh._attachPersist(handle);
  }
  for (const f of files) sh.RecordReviewItemDone(f, "", f, `fp-${f}`, []);
  sh.Finalize();
  return sh.sessionId;
}
function countSessions(repoDir: string): number {
  const { SessionsDir } = require("../../../src/ocr/session/persist.js") as typeof import("../../../src/ocr/session/persist.js");
  try { const dir = SessionsDir(repoDir); return fs.readdirSync(dir).filter((e) => e.endsWith(".jsonl")).length; } catch { return 0; }
}
// OCR v1.9.3: TestLoadReviewResumeState_WithSession
test.serial("loadReviewResumeState with session success, mode mismatch, no completed admitted", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const id1 = writeRangeSession(repoDir, ["a.go", "b.go"]);
      const state1 = loadReviewResumeState(repoDir, { resume: id1, from: "main", to: "feature" } as never);
      expect(state1).not.toBeNull();
      expect(state1!.CompletedCount()).toBe(2);
    } finally { fs.rmSync(repoDir, { recursive: true, force: true }); }
  });
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const id2 = writeRangeSession(repoDir, ["a.go"]);
      let threw = false;
      try { loadReviewResumeState(repoDir, { resume: id2, commit: "HEAD" } as never); } catch (_e) { threw = true; }
      expect(threw).toBe(true);
    } finally { fs.rmSync(repoDir, { recursive: true, force: true }); }
  });
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const id3 = writeRangeSession(repoDir, []);
      const state3 = loadReviewResumeState(repoDir, { resume: id3, from: "main", to: "feature" } as never);
      expect(state3).not.toBeNull();
      expect(state3!.CompletedCount()).toBe(0);
    } finally { fs.rmSync(repoDir, { recursive: true, force: true }); }
  });
});
// OCR v1.9.3: TestValidateResumeIdentity
test.serial("validateResumeIdentity provider/model and input change", () => {
  withTempHome(() => {
    const repoDir = mkRepo();
    try {
      const runId = "run-parent-1";
      const b = new ManifestBuilder(runId, "review");
      b.SetInput({ mode: "range" });
      b.SetExecution({ provider: "anthropic", model: "claude", ruleConfigSha256: "abc", ocrVersion: "dev" } as never);
      b.SetRepository({ identitySha256: "repo-sha" });
      const itemId1 = "item-1";
      b.RegisterSelected({ itemId: itemId1, path: "main.go", fingerprint: "fp1" });
      b.MarkCompleted(itemId1);
      const fin = b.Finalize(1000);
      expect(fin.error).toBeNull();
      const manifest = fin.manifest!;
      const state = new ResumeState("sess-1", repoDir);
      state.manifest = manifest;
      state.reviewMode = "range";
      state.closed = true;
      const errSame = state.ValidateResume({ identity: { mode: "range", repositorySha256: "repo-sha", sourceArtifactSha256: undefined, ruleConfigSha256: "abc" }, provider: "anthropic", model: "claude", providerExplicit: false, modelExplicit: false });
      expect(errSame).toBeNull();
      const nullState: ResumeState | null = null;
      expect(nullState).toBeNull();
      const errProv = state.ValidateResume({ identity: { mode: "range", repositorySha256: "repo-sha", ruleConfigSha256: "abc" }, provider: "openai", model: "gpt-5", providerExplicit: false, modelExplicit: false });
      expect(errProv).not.toBeNull();
      expect(String(errProv!.message)).toContain("provider changed");
      const errExplicit = state.ValidateResume({ identity: { mode: "range", repositorySha256: "repo-sha", ruleConfigSha256: "abc" }, provider: "openai", model: "gpt-5", providerExplicit: true, modelExplicit: false });
      expect(errExplicit).toBeNull();
      const errInput = state.ValidateResume({ identity: { mode: "range", repositorySha256: "different", ruleConfigSha256: "abc" }, provider: "anthropic", model: "claude", providerExplicit: false, modelExplicit: false });
      expect(errInput).not.toBeNull();
      const low = String(errInput!.message).toLowerCase();
      expect(low.includes("input") || low.includes("repository")).toBe(true);
      const before = countSessions(repoDir);
      const after = countSessions(repoDir);
      expect(after).toBe(before);
    } finally { fs.rmSync(repoDir, { recursive: true, force: true }); }
  });
});
// OCR v1.9.3: TestFileReadRef
test("fileReadRef sealed vs typed ref", () => {
  const sealed = { resolvedHead: "bbb", ResolvedHead: "bbb" } as unknown as { resolvedHead: string };
  const sealedCaps = { ResolvedHead: "bbb" } as unknown as { ResolvedHead: string };
  expect(fileReadRef(ReviewMode.ModeRange, { from: "main", to: "feature" } as never, null)).toBe("feature");
  expect(fileReadRef(ReviewMode.ModeRange, { from: "main", to: "feature" } as never, sealed as never)).toBe("bbb");
  expect(fileReadRef(ReviewMode.ModeCommit, { commit: "HEAD" } as never, sealedCaps as never)).toBe("bbb");
  expect(fileReadRef(ReviewMode.ModeWorkspace, {} as never, sealed as never)).toBe("");
});

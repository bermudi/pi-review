// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/scan_resume_more_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionHistory } from "../../../src/ocr/session/history.js";
import { JsonlWriter } from "../../../src/ocr/session/persist.js";
import { loadScanResumeState } from "../../../src/ocr/cli/scan.js";

function withTempHome<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
  const orig = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete process.env.HOME;
    else process.env.HOME = orig;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeScanSession(repoDir: string, files: string[] = []): string {
  const sh = new SessionHistory(repoDir, "feature", "fake", {
    reviewMode: "full_scan",
  } as never);
  if (!(sh as unknown as { HasPersistence?: () => boolean }).HasPersistence?.()) {
    const w = new JsonlWriter(sh.sessionId, sh.repoDir, sh.gitBranch, sh.model, {
      reviewMode: (sh as unknown as { reviewMode: string }).reviewMode,
      scanPaths: (sh as unknown as { scanPaths: string[] }).scanPaths,
      resumedFrom: (sh as unknown as { resumedFrom: string }).resumedFrom,
    } as never);
    w.open();
    w.WriteSessionStart((sh as unknown as { startTime: Date }).startTime);
    const handle = {
      writeReviewItemDone: (...a: Parameters<JsonlWriter["WriteReviewItemDone"]>) => w.WriteReviewItemDone(...a),
      writeReviewItemReused: (...a: Parameters<JsonlWriter["WriteReviewItemReused"]>) => w.WriteReviewItemReused(...a),
      writeReviewItemFailed: (...a: Parameters<JsonlWriter["WriteReviewItemFailed"]>) => w.WriteReviewItemFailed(...a),
      writeResumeLineage: (l: never) => w.WriteResumeLineage(l),
      writeSessionEnd: (...a: Parameters<JsonlWriter["WriteSessionEnd"]>) => w.WriteSessionEnd(...a),
      writeLLMRequest: (...a: unknown[]) => (w as unknown as { WriteLLMRequest: (...a: unknown[]) => void }).WriteLLMRequest(...a),
      writeLLMResponse: (...a: unknown[]) => (w as unknown as { WriteLLMResponse: (...a: unknown[]) => void }).WriteLLMResponse(...a),
      writeLLMError: (...a: unknown[]) => (w as unknown as { WriteLLMError: (...a: unknown[]) => void }).WriteLLMError(...a),
      writeToolCall: (...a: unknown[]) => (w as unknown as { WriteToolCall: (...a: unknown[]) => void }).WriteToolCall(...a),
    } as unknown as never;
    (sh as unknown as { _attachPersist: (h: unknown) => void })._attachPersist(handle);
  }
  for (const f of files) sh.RecordReviewItemDone(f, "", f, `fp-${f}`, []);
  sh.Finalize();
  return sh.sessionId;
}

function writeRangeSession(repoDir: string, files: string[] = []): string {
  const sh = new SessionHistory(repoDir, "feature", "fake", {
    reviewMode: "range",
    diffFrom: "main",
    diffTo: "feature",
  } as never);
  if (!(sh as unknown as { HasPersistence?: () => boolean }).HasPersistence?.()) {
    const w = new JsonlWriter(sh.sessionId, sh.repoDir, sh.gitBranch, sh.model, {
      reviewMode: (sh as unknown as { reviewMode: string }).reviewMode,
      diffFrom: (sh as unknown as { diffFrom: string }).diffFrom,
      diffTo: (sh as unknown as { diffTo: string }).diffTo,
    } as never);
    w.open();
    w.WriteSessionStart((sh as unknown as { startTime: Date }).startTime);
    const handle = {
      writeReviewItemDone: (...a: Parameters<JsonlWriter["WriteReviewItemDone"]>) => w.WriteReviewItemDone(...a),
      writeReviewItemReused: (...a: Parameters<JsonlWriter["WriteReviewItemReused"]>) => w.WriteReviewItemReused(...a),
      writeReviewItemFailed: (...a: Parameters<JsonlWriter["WriteReviewItemFailed"]>) => w.WriteReviewItemFailed(...a),
      writeResumeLineage: (l: never) => w.WriteResumeLineage(l),
      writeSessionEnd: (...a: Parameters<JsonlWriter["WriteSessionEnd"]>) => w.WriteSessionEnd(...a),
      writeLLMRequest: (...a: unknown[]) => (w as unknown as { WriteLLMRequest: (...a: unknown[]) => void }).WriteLLMRequest(...a),
      writeLLMResponse: (...a: unknown[]) => (w as unknown as { WriteLLMResponse: (...a: unknown[]) => void }).WriteLLMResponse(...a),
      writeLLMError: (...a: unknown[]) => (w as unknown as { WriteLLMError: (...a: unknown[]) => void }).WriteLLMError(...a),
      writeToolCall: (...a: unknown[]) => (w as unknown as { WriteToolCall: (...a: unknown[]) => void }).WriteToolCall(...a),
    } as unknown as never;
    (sh as unknown as { _attachPersist: (h: unknown) => void })._attachPersist(handle);
  }
  for (const f of files) sh.RecordReviewItemDone(f, "", f, `fp-${f}`, []);
  sh.Finalize();
  return sh.sessionId;
}

// OCR v1.9.3: TestLoadScanResumeState_WithSession
test("loadScanResumeState with session success, non-scan rejected, no completed errors", () => {
  withTempHome(() => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-scan-resume-"));
    try {
      const id1 = writeScanSession(repoDir, ["a.go", "b.go"]);
      const s1 = loadScanResumeState(repoDir, { resume: id1 } as never, []);
      expect(s1).not.toBeNull();
      expect(s1!.CompletedCount()).toBe(2);

      const idRange = writeRangeSession(repoDir, ["a.go"]);
      expect(() => loadScanResumeState(repoDir, { resume: idRange } as never, [])).toThrow();

      const idEmpty = writeScanSession(repoDir, []);
      try {
        loadScanResumeState(repoDir, { resume: idEmpty } as never, []);
        expect(false, "expected error for no completed items").toBe(true);
      } catch (e) {
        expect(String((e as Error).message)).toContain("no completed scan items");
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

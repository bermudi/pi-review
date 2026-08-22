// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/list_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionHistory } from "../../../src/ocr/session/history.js";
import { JsonlWriter } from "../../../src/ocr/session/persist.js";
import { ListSessions, LoadDetail, LoadSummary } from "../../../src/ocr/session/resume.js";
import {
  InputModeWorkspace,
  FailureProvider,
  StatePartial,
  StateComplete,
  MANIFEST_SCHEMA_VERSION,
} from "../../../src/ocr/session/manifest.js";
import type { LlmComment } from "../../../src/ocr/model/review.js";
import type { CoverageItem } from "../../../src/ocr/session/manifest.js";

function attachWriter(sh: SessionHistory): JsonlWriter {
  const w = new JsonlWriter(sh.sessionId, sh.repoDir, sh.gitBranch, sh.model, {
    reviewMode: sh.reviewMode,
    diffFrom: sh.diffFrom,
    diffTo: sh.diffTo,
    diffCommit: sh.diffCommit,
    scanPaths: sh.scanPaths,
    resumedFrom: sh.resumedFrom,
  });
  w.open();
  w.WriteSessionStart(sh.startTime);
  const handle = {
    writeReviewItemDone: (...a: Parameters<JsonlWriter["WriteReviewItemDone"]>) => { w.WriteReviewItemDone(...a); },
    writeReviewItemReused: (...a: Parameters<JsonlWriter["WriteReviewItemReused"]>) => { w.WriteReviewItemReused(...a); },
    writeReviewItemFailed: (...a: Parameters<JsonlWriter["WriteReviewItemFailed"]>) => { w.WriteReviewItemFailed(...a); },
    writeResumeLineage: (l: import("../../../src/ocr/session/resume.js").ResumeLineage) => { w.WriteResumeLineage(l); },
    writeSessionEnd: (...a: Parameters<JsonlWriter["WriteSessionEnd"]>) => w.WriteSessionEnd(...a),
    writeLLMRequest: () => {},
    writeLLMResponse: () => {},
    writeLLMError: () => {},
    writeToolCall: () => {},
  } as unknown as import("../../../src/ocr/session/history.js").PersistHandle;
  (sh as unknown as { _attachPersist: (h: unknown) => void })._attachPersist(handle);
  return w;
}

function writeTestSession(
  repoDir: string,
  from: string,
  to: string,
  comments: LlmComment[],
  doneCount: number,
  failedCount: number,
  finalize: boolean,
): string {
  const sh = new SessionHistory(repoDir, "main", "test-model", {
    reviewMode: "range",
    diffFrom: from,
    diffTo: to,
  });
  const w = attachWriter(sh);
  for (let i = 0; i < doneCount; i++) {
    const filePath = path.basename(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-file-"))) + ".go";
    const perFile: LlmComment[] = i < comments.length && comments[i] !== undefined ? [comments[i]!] : [];
    sh.RecordReviewItemDone(filePath, filePath, filePath, "fp-" + filePath, perFile);
  }
  for (let i = 0; i < failedCount; i++) {
    const filePath = "failed-" + path.basename(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-file-"))) + ".go";
    sh.RecordReviewItemFailed(filePath, filePath, filePath, "fp-fail-" + filePath, "test error");
  }
  if (finalize) {
    const err = sh.Finalize();
    if (err !== null) throw err;
  } else {
    // Simulate aborted run: flush and close without session_end
    try { w.close(); } catch {}
    (sh as unknown as { persist: unknown }).persist = null;
  }
  return sh.sessionId;
}

describe("ocr session list", () => {
  // OCR v1.9.3: TestListSessions_EmptyRepoReturnsNil
  test("ListSessions empty repo returns nil", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const got = ListSessions(repoDir);
      expect(got.length).toBe(0);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestListSessions_SortsAndAggregates
  test("ListSessions sorts and aggregates", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const older = writeTestSession(repoDir, "feature-a", "commit-x", [{ path: "a.go", content: "one" } as LlmComment], 1, 0, true);
      await new Promise((r) => setTimeout(r, 1100));
      const newer = writeTestSession(repoDir, "feature-a", "commit-y", [
        { path: "b.go", content: "one" } as LlmComment,
        { path: "b.go", content: "two" } as LlmComment,
      ], 2, 1, false);

      const got = ListSessions(repoDir);
      expect(got.length).toBe(2);
      expect(got[0]!.sessionId).toBe(newer);
      expect(got[1]!.sessionId).toBe(older);

      expect(got[0]!.aborted).toBe(true);
      expect(got[1]!.aborted).toBe(false);
      expect(got[0]!.totalComments).toBe(2);
      expect(got[0]!.failedFiles).toBe(1);
      expect(got[0]!.completedFiles).toBe(2);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestLoadDetail_ReturnsItems
  test("LoadDetail returns items", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "commit",
        diffCommit: "abc123",
      });
      attachWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [{ path: "a.go", content: "note" } as LlmComment]);
      sh.RecordReviewItemReused("b.go", "b.go", "b.go", "fp-b", "prior-session", [{ path: "b.go", content: "cached" } as LlmComment]);
      sh.RecordReviewItemFailed("c.go", "c.go", "c.go", "fp-c", "boom");
      const finErr = sh.Finalize();
      expect(finErr).toBeNull();

      const { summary, items } = LoadDetail(repoDir, sh.sessionId);
      expect(summary.completedFiles).toBe(1);
      expect(summary.reusedFiles).toBe(1);
      expect(summary.failedFiles).toBe(1);
      expect(summary.totalComments).toBe(2);
      expect(summary.aborted).toBe(false);
      expect(items.length).toBe(3);
      const byType = new Map<string, import("../../../src/ocr/session/resume.js").ItemDetail>();
      for (const it of items) byType.set(it.type, it);
      expect(byType.get("reused")!.sourceSessionId).toBe("prior-session");
      expect(byType.get("failed")!.error).toBe("boom");
      expect(byType.get("done")!.comments).toBe(1);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestLoadSummary_FallsBackToSessionEndFilesReviewed
  test("LoadSummary falls back to session_end files_reviewed", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "workspace",
      });
      attachWriter(sh);
      sh.GetOrCreateFileSession("legacy-a.go");
      sh.GetOrCreateFileSession("legacy-b.go");
      const finErr = sh.Finalize();
      expect(finErr).toBeNull();

      const { summary, items } = LoadDetail(repoDir, sh.sessionId);
      expect(summary.completedFiles).toBe(2);
      expect(summary.reusedFiles).toBe(0);
      expect(summary.failedFiles).toBe(0);
      expect(items.length).toBe(0);
      expect(summary.legacy).toBe(true);
      expect(summary.runManifest).toBeNull();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestLoadSummaryPrefersV1RunManifest
  test("LoadSummary prefers v1 run manifest", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "workspace",
        operation: "review",
      });
      attachWriter(sh);
      const b = sh.Manifest();
      expect(b).not.toBeNull();
      b!.SetInput({ mode: InputModeWorkspace });
      const items: CoverageItem[] = [
        { itemId: "a", path: "a.go" },
        { itemId: "b", path: "b.go" },
        { itemId: "c", path: "c.go" },
        { itemId: "d", path: "d.go" },
      ];
      for (const item of items) {
        const err = b!.RegisterSelected(item);
        expect(err).toBeNull();
      }
      expect(b!.SealSelected()).toBeNull();
      expect(b!.MarkCompleted("a")).toBeNull();
      expect(b!.MarkReused("b")).toBeNull();
      expect(b!.MarkFailed("c", FailureProvider, "provider request failed")).toBeNull();
      expect(b!.MarkWaived("d", "accepted by user")).toBeNull();
      const { manifest, error } = b!.Finalize(1000);
      expect(error).toBeNull();
      expect(manifest).not.toBeNull();
      sh.SetFinalManifest(manifest);
      const finErr = sh.Finalize();
      expect(finErr).toBeNull();

      const summary = LoadSummary(repoDir, sh.sessionId);
      expect(summary.legacy).toBe(false);
      expect(summary.aborted).toBe(false);
      expect(summary.runManifest).not.toBeNull();
      expect(summary.runManifest!.terminalState).toBe(StatePartial);
      expect(summary.selectedFiles).toBe(4);
      expect(summary.completedFiles).toBe(1);
      expect(summary.reusedFiles).toBe(1);
      expect(summary.failedFiles).toBe(1);
      expect(summary.waivedFiles).toBe(1);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestLoadSummaryIgnoresUnknownManifestVersion
  test("LoadSummary ignores unknown manifest version", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", {
        reviewMode: "workspace",
      });
      attachWriter(sh);
      sh.SetFinalManifest({
        schemaVersion: "ocr.run-manifest/v999",
        terminalState: StateComplete,
      } as unknown as import("../../../src/ocr/session/manifest.js").RunManifest);
      const finErr = sh.Finalize();
      expect(finErr).toBeNull();
      const summary = LoadSummary(repoDir, sh.sessionId);
      expect(summary.legacy).toBe(true);
      expect(summary.runManifest).toBeNull();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestLoadSummary_MissingFile
  test("LoadSummary missing file", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      expect(() => LoadSummary(repoDir, "nonexistent")).toThrow();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

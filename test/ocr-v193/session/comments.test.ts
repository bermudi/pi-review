// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/comments_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { JsonlWriter } from "../../../src/ocr-v193/session/persist.js";
import { LoadComments } from "../../../src/ocr-v193/session/resume.js";

function attachWriter(sh: SessionHistory): void {
  if (sh.HasPersistence()) return;
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
    writeResumeLineage: (l: import("../../../src/ocr-v193/session/resume.js").ResumeLineage) => { w.WriteResumeLineage(l); },
    writeSessionEnd: (...a: Parameters<JsonlWriter["WriteSessionEnd"]>) => w.WriteSessionEnd(...a),
    writeLLMRequest: () => {},
    writeLLMResponse: () => {},
    writeLLMError: () => {},
    writeToolCall: () => {},
  } as unknown as import("../../../src/ocr-v193/session/history.js").PersistHandle;
  (sh as unknown as { _attachPersist: (h: unknown) => void })._attachPersist(handle);
}

describe("ocr-v193 session comments", () => {
  // OCR v1.9.3: TestLoadComments_ReturnsCommentsInOrder
  test("LoadComments returns comments in order", () => {
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
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [
        { path: "a.go", content: "first", severity: "high", category: "bug" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
        { path: "", content: "second, no path", severity: "low" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
      ]);
      sh.RecordReviewItemReused("b.go", "b.go", "b.go", "fp-b", "prior-session", [
        { path: "b.go", content: "cached", severity: "medium" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
      ]);
      sh.RecordReviewItemFailed("c.go", "c.go", "c.go", "fp-c", "boom");
      const finErr = sh.Finalize();
      expect(finErr).toBeNull();

      const got = LoadComments(repoDir, sh.sessionId);
      expect(got.length).toBe(3);
      expect(got[0]!.content).toBe("first");
      expect(got[1]!.content).toBe("second, no path");
      expect(got[2]!.content).toBe("cached");
      expect(got[1]!.path).toBe("a.go");
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestLoadComments_LaterCheckpointSupersedes
  test("LoadComments later checkpoint supersedes", () => {
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
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [
        { path: "a.go", content: "stale" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
      ]);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [
        { path: "a.go", content: "fresh" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
      ]);
      sh.RecordReviewItemDone("b.go", "b.go", "b.go", "fp-b", [
        { path: "b.go", content: "kept" } as unknown as import("../../../src/ocr-v193/model/review.js").LlmComment,
      ]);
      sh.RecordReviewItemFailed("b.go", "b.go", "b.go", "fp-b", "boom");
      const finErr = sh.Finalize();
      expect(finErr).toBeNull();

      const got = LoadComments(repoDir, sh.sessionId);
      expect(got.length).toBe(1);
      expect(got[0]!.content).toBe("fresh");
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestLoadComments_MissingSession
  test("LoadComments missing session", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      expect(() => LoadComments(repoDir, "nonexistent")).toThrow();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

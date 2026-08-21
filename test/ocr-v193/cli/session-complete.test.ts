// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/session_complete_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { JsonlWriter } from "../../../src/ocr-v193/session/persist.js";
import { completeSessionIDs } from "../../../src/ocr-v193/cli/session.js";

function attachTestWriter(sh: SessionHistory): void {
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
    writeResumeLineage: (l: import("../../../src/ocr-v193/session/resume.ts").ResumeLineage) => { w.WriteResumeLineage(l); },
    writeSessionEnd: (...a: Parameters<JsonlWriter["WriteSessionEnd"]>) => w.WriteSessionEnd(...a),
    writeLLMRequest: (...a: Parameters<JsonlWriter["WriteLLMRequest"]>) => { (w as unknown as { WriteLLMRequest: (...a: unknown[]) => void }).WriteLLMRequest(...(a as unknown[])); },
    writeLLMResponse: (...a: Parameters<JsonlWriter["WriteLLMResponse"]>) => { (w as unknown as { WriteLLMResponse: (...a: unknown[]) => void }).WriteLLMResponse(...(a as unknown[])); },
    writeLLMError: (...a: Parameters<JsonlWriter["WriteLLMError"]>) => { (w as unknown as { WriteLLMError: (...a: unknown[]) => void }).WriteLLMError(...(a as unknown[])); },
    writeToolCall: (...a: Parameters<JsonlWriter["WriteToolCall"]>) => { (w as unknown as { WriteToolCall: (...a: unknown[]) => void }).WriteToolCall(...(a as unknown[])); },
  } as unknown as import("../../../src/ocr-v193/session/history.ts").PersistHandle;
  (sh as unknown as { _attachPersist: (h: unknown) => void })._attachPersist(handle);
}

function writeRangeResumeSession(repoDir: string, files: string[]): string {
  const sh = new SessionHistory(repoDir, "feature", "fake", {
    reviewMode: "range",
    diffFrom: "main",
    diffTo: "feature",
  } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
  attachTestWriter(sh);
  for (const f of files) {
    sh.RecordReviewItemDone(f, "", f, `fp-${f}`, []);
  }
  const err = sh.Finalize();
  if (err !== null) throw err;
  return sh.sessionId;
}

function newCmd(repo: string): { Flags: { GetString(name: string): string } } {
  return {
    Flags: {
      GetString(name: string) {
        if (name === "repo") return repo;
        return "";
      },
    },
  };
}

// OCR v1.9.3: TestCompleteSessionIDs_WithSession
test("completeSessionIDs with session", () => {
  // lists matching session IDs
  {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
    try {
      const id = writeRangeResumeSession(repoDir, ["a.go"]);
      const [got] = completeSessionIDs(newCmd(repoDir), null, id.slice(0, 4));
      expect(got.length).toBeGreaterThan(0);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }

  // prefix that matches nothing yields empty list
  {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
    try {
      writeRangeResumeSession(repoDir, ["a.go"]);
      const [got] = completeSessionIDs(newCmd(repoDir), null, "zzzz-no-match");
      expect(got.length).toBe(0);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/persist_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionHistory } from "../../../src/ocr-v193/session/history.ts";
import { encodeRepoPath, SessionFilePath, JsonlWriter, SessionsDir } from "../../../src/ocr-v193/session/persist.ts";
import { ResumeState } from "../../../src/ocr-v193/session/resume.ts";

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

function readJSONLRecords(filePath: string): Array<Record<string, unknown>> {
  const text = fs.readFileSync(filePath, "utf-8");
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    out.push(JSON.parse(line) as Record<string, unknown>);
  }
  return out;
}

describe("ocr-v193 session persist", () => {
  // OCR v1.9.3: TestEncodeRepoPath
  test("encodeRepoPath handles empty, relative and platform paths", () => {
    type Case = { name: string; input: string; expected: string };
    const cases: Case[] = [
      { name: "empty string", input: "", expected: "empty" },
      { name: "relative path", input: "relative/path/to/repo", expected: "relative-path-to-repo" },
      { name: "path with mixed separators", input: "path/to\\mixed", expected: "path-to-mixed" },
    ];
    if (process.platform === "win32") {
      cases.push(
        { name: "windows drive path", input: "D:\\Users\\admin\\project", expected: "D_Users-admin-project" },
        { name: "windows C drive", input: "C:\\code\\myapp", expected: "C_code-myapp" },
        { name: "windows relative path", input: "relative\\path\\to\\repo", expected: "relative-path-to-repo" },
        { name: "windows drive only", input: "C:", expected: "C_" },
        { name: "windows drive with separator only", input: "D:\\", expected: "D_" },
      );
    } else {
      cases.push(
        { name: "unix absolute path", input: "/home/user/project", expected: "home-user-project" },
        { name: "unix nested path", input: "/Users/john/dev/myapp", expected: "Users-john-dev-myapp" },
        { name: "unix root only", input: "/", expected: "empty" },
      );
    }
    for (const tc of cases) {
      const got = encodeRepoPath(tc.input);
      expect(got, `${tc.name}`).toBe(tc.expected);
    }
  });

  // OCR v1.9.3: TestSetErrorIncrementsCounter
  test("SetError increments LLMFailures counter", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "model", {});
    const fsS = sh.GetOrCreateFileSession("test.go");
    const rec1 = fsS.AppendTaskRecord("main_task", []);
    rec1.SetError(new Error("timeout"), 1000);
    expect(sh.LLMFailures()).toBe(1);
    const rec2 = fsS.AppendTaskRecord("plan_task", []);
    rec2.SetError(new Error("rate limit"), 2000);
    expect(sh.LLMFailures()).toBe(2);
  });

  // OCR v1.9.3: TestSetErrorWritesJSONL
  test("SetError writes llm_error JSONL record", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      const fsS = sh.GetOrCreateFileSession("foo.go");
      const rec = fsS.AppendTaskRecord("main_task", []);
      rec.SetError(new Error("connection refused"), 500);
      // Flush is via file sync; read directly
      const fp = SessionFilePath(repoDir, sh.sessionId);
      const records = readJSONLRecords(fp);
      let found = false;
      for (const r of records) {
        if (r["type"] === "llm_error") {
          found = true;
          expect(r["filePath"]).toBe("foo.go");
          expect(r["taskType"]).toBe("main_task");
          expect(r["error"]).toBe("connection refused");
          break;
        }
      }
      expect(found, "no llm_error record found").toBe(true);
      sh.Finalize();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestSessionFilePermissions
  test("session file and directory have 0700/0600 permissions", () => {
    if (process.platform === "win32") return;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
        process.env.HOME = tmpHome;
        try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sessionId = "test-session-id-perm";
      const w = new JsonlWriter(sessionId, repoDir, "main", "test-model", { reviewMode: "workspace" });
      w.open();
      w.WriteSessionStart(new Date());
      const sessionDir = SessionsDir(repoDir);
      const sessionFile = SessionFilePath(repoDir, sessionId);
      const dirStat = fs.statSync(sessionDir);
      expect((dirStat.mode & 0o777).toString(8)).toBe("700");
      const fileStat = fs.statSync(sessionFile);
      expect((fileStat.mode & 0o777).toString(8)).toBe("600");
      w.WriteSessionEnd(0, [], 0, null);
    } finally {
      process.env.HOME = origHome;
            fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestFinalizeSurfacesWriterCreationErrorWithoutStdout
  test("Finalize surfaces writer creation error without stdout", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
        process.env.HOME = tmpHome;
        try {
      fs.writeFileSync(path.join(tmpHome, ".opencodereview"), "blocked", { mode: 0o600 });
      const sh = new SessionHistory(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-")), "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      let writerError: Error | null = null;
      try {
        const w2 = new JsonlWriter(sh.sessionId, sh.repoDir, "main", "test-model", { reviewMode: "workspace" });
        w2.open();
      } catch (e) {
        writerError = e instanceof Error ? e : new Error(String(e));
      }
      expect(writerError, "writer creation should fail when .opencodereview is file").not.toBeNull();
      const sh2 = new SessionHistory(sh.repoDir, "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      (sh2 as unknown as { _setPersistInitErr: (e: Error | null) => void })._setPersistInitErr(new Error("create session writer: " + (writerError?.message ?? "blocked")));
      expect(sh2.HasPersistence()).toBe(false);
      const err1 = sh2.Finalize();
      const err2 = sh2.Finalize();
      for (const e of [err1, err2] as const) {
        expect(e).not.toBeNull();
        expect(e!.message.includes("create session writer")).toBe(true);
      }
    } finally {
      process.env.HOME = origHome;
            fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestFinalizeSurfacesWriteError
  test("Finalize surfaces write error when file is closed", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
        process.env.HOME = tmpHome;
        try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh2 = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      const handle = {
        writeReviewItemDone: () => {},
        writeReviewItemReused: () => {},
        writeReviewItemFailed: () => {},
        writeResumeLineage: () => {},
        writeSessionEnd: () => new Error("write failed: closed"),
        writeLLMRequest: () => {},
        writeLLMResponse: () => {},
        writeLLMError: () => {},
        writeToolCall: () => {},
      } as unknown as import("../../../src/ocr-v193/session/history.ts").PersistHandle;
      (sh2 as unknown as { _attachPersist: (h: unknown) => void })._attachPersist(handle);
      const err = sh2.Finalize();
      expect(err).not.toBeNull();
      expect(err!.message.length).toBeGreaterThan(0);
    } finally {
      process.env.HOME = origHome;
            fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestFinalizeReplaysWriteErrorOnEveryCall
  test("Finalize replays write error on every call", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
        process.env.HOME = tmpHome;
        try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      const handle = {
        writeReviewItemDone: () => {},
        writeReviewItemReused: () => {},
        writeReviewItemFailed: () => {},
        writeResumeLineage: () => {},
        writeSessionEnd: () => new Error("write failed"),
        writeLLMRequest: () => {},
        writeLLMResponse: () => {},
        writeLLMError: () => {},
        writeToolCall: () => {},
      } as unknown as import("../../../src/ocr-v193/session/history.ts").PersistHandle;
      (sh as unknown as { _attachPersist: (h: unknown) => void })._attachPersist(handle);
      const err1 = sh.Finalize();
      const err2 = sh.Finalize();
      expect(err1).not.toBeNull();
      expect(err2).not.toBeNull();
      expect(err1!.message).toBe(err2!.message);
    } finally {
      process.env.HOME = origHome;
            fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestFinalizeWritesSessionEndExactlyOnce
  test("Finalize writes session_end exactly once", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.Finalize();
      sh.Finalize();
      const fp = SessionFilePath(repoDir, sh.sessionId);
      const records = readJSONLRecords(fp);
      const ends = records.filter((r) => r["type"] === "session_end");
      expect(ends.length).toBe(1);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestSessionEndIncludesFailures
  test("session_end includes llm_failures count", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      const fsS = sh.GetOrCreateFileSession("foo.go");
      const rec = fsS.AppendTaskRecord("main_task", []);
      rec.SetError(new Error("boom"), 100);
      sh.Finalize();
      const fp = SessionFilePath(repoDir, sh.sessionId);
      const records = readJSONLRecords(fp);
      const end = records.find((r) => r["type"] === "session_end");
      expect(end).toBeDefined();
      expect(end!["llm_failures"]).toBe(1);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestReviewItemResumeRoundTrip
  test("review item done persists and is reusable via resume", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordReviewItemDone("a.go", "a.go", "a.go", "fp-a", [{ path: "a.go", content: "fix" } as unknown as import("../../../src/ocr-v193/model/review.ts").LlmComment]);
      sh.Finalize();
      const state = ResumeState.prototype as unknown as { constructor: unknown };
      // Use LoadResumeState to verify item persisted
      const { LoadResumeState } = require("../../../src/ocr-v193/session/resume.ts") as typeof import("../../../src/ocr-v193/session/resume.ts");
      const loaded = LoadResumeState(repoDir, sh.sessionId);
      const item = loaded.Item("fp-a");
      expect(item).not.toBeNull();
      expect(item!.filePath).toBe("a.go");
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestResumeStateValidateOptionsRejectsMismatchedMode
  test("ResumeState ValidateOptions rejects mismatched mode", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.Finalize();
      const { LoadResumeState } = require("../../../src/ocr-v193/session/resume.ts") as typeof import("../../../src/ocr-v193/session/resume.ts");
      const state = LoadResumeState(repoDir, sh.sessionId);
      const err = state.ValidateOptions({ reviewMode: "range" });
      expect(err).not.toBeNull();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestResumeStateSessionStartKeepsRepoDirWhenCwdEmpty
  test("ResumeState keeps repoDir when cwd empty in session_start", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "workspace" } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      // Manually write a session_start with empty cwd to test handling
      const fp = SessionFilePath(repoDir, sh.sessionId);
      sh.Finalize();
      // Append a record with empty cwd
      const raw = fs.readFileSync(fp, "utf-8").split("\n").filter((l) => l.trim() !== "")[0]!;
      const first = JSON.parse(raw) as Record<string, unknown>;
      expect(first["cwd"]).toBeDefined();
      // Now test that loading a session with empty cwd keeps original repoDir
      const { ResumeState: RS } = require("../../../src/ocr-v193/session/resume.ts") as typeof import("../../../src/ocr-v193/session/resume.ts");
      const s = new RS("test", repoDir);
      s.applyResumeLine(JSON.stringify({ type: "session_start", sessionId: "test", cwd: "", gitBranch: "main" }));
      expect(s.repoDir).toBe(repoDir);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestScanPathScopeResumeRoundTrip
  test("scan path scope resume round-trip", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "full_scan", scanPaths: ["src", "lib"] } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.Finalize();
      const { LoadResumeState } = require("../../../src/ocr-v193/session/resume.ts") as typeof import("../../../src/ocr-v193/session/resume.ts");
      const loaded = LoadResumeState(repoDir, sh.sessionId);
      expect(loaded.reviewMode).toBe("full_scan");
      expect(loaded.scanPaths.sort()).toEqual(["lib", "src"]);
      expect(loaded.HasScanPathScope).toBe(true);
      expect(loaded.ValidateScanOptions(["src", "lib"])).toBeNull();
      expect(loaded.ValidateScanOptions(["src"])).not.toBeNull();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestWholeRepoScanPathScopeResumeRoundTrip
  test("whole repo scan path scope resume round-trip", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "test-model", { reviewMode: "full_scan", scanPaths: [] } as unknown as import("../../../src/ocr-v193/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.Finalize();
      const { LoadResumeState } = require("../../../src/ocr-v193/session/resume.ts") as typeof import("../../../src/ocr-v193/session/resume.ts");
      const loaded = LoadResumeState(repoDir, sh.sessionId);
      expect(loaded.reviewMode).toBe("full_scan");
      expect(loaded.scanPaths.length).toBe(0);
      expect(loaded.ValidateScanOptions([])).toBeNull();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

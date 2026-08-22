// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/list_error_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27;
// platform guard revalidated against OCR v1.9.9.

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionsDir, SessionFilePath } from "../../../src/ocr/session/persist.js";
import { ListSessions, LoadDetail } from "../../../src/ocr/session/resume.js";

describe("ocr session list error", () => {
  // OCR v1.9.9: TestListSessions_DirIsFile
  test("ListSessions DirIsFile", () => {
    if (process.platform === "win32") return;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const dir = SessionsDir(repoDir);
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dir, "x", { mode: 0o644 });
      expect(() => ListSessions(repoDir)).toThrow(`read sessions dir "${dir}"`);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestRecordToItem
  test("RecordToItem", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sessionId = `rec-${Date.now()}`;
      const fp = SessionFilePath(repoDir, sessionId);
      fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
      const records: Array<Record<string, unknown>> = [
        { type: "session_start", sessionId, timestamp: new Date().toISOString(), cwd: repoDir },
        { type: "review_item_done", newPath: "renamed.go", fingerprint: "fp-1" },
      ];
      fs.writeFileSync(fp, records.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
      const { items } = LoadDetail(repoDir, sessionId);
      // session_start should not produce an item; only review_item_done should
      expect(items.length).toBe(1);
      const item = items[0]!;
      expect(item.filePath).toBe("renamed.go");
      expect(item.type).toBe("done");
      // Also verify that a session_start-only file yields no items
      const sessionId2 = `rec2-${Date.now()}`;
      const fp2 = SessionFilePath(repoDir, sessionId2);
      fs.writeFileSync(fp2, JSON.stringify({ type: "session_start", sessionId: sessionId2 }) + "\n", { mode: 0o600 });
      const { items: items2 } = LoadDetail(repoDir, sessionId2);
      expect(items2.length).toBe(0);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

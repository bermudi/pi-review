// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/list_error_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionsDir } from "../../../src/ocr-v193/session/persist.js";
import { ListSessions, recordToItem } from "../../../src/ocr-v193/session/resume.js";

describe("ocr-v193 session list error", () => {
  // OCR v1.9.3: TestListSessions_DirIsFile
  test("ListSessions DirIsFile", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const dir = SessionsDir(repoDir);
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dir, "x", { mode: 0o644 });
      expect(() => ListSessions(repoDir)).toThrow();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestRecordToItem
  test("RecordToItem", () => {
    const notItem = recordToItem({ type: "session_start" } as unknown as Record<string, unknown>);
    expect(notItem).toBeNull();

    const item = recordToItem({ type: "review_item_done", newPath: "renamed.go" } as unknown as Record<string, unknown>);
    expect(item).not.toBeNull();
    expect(item!.filePath).toBe("renamed.go");
    expect(item!.type).toBe("done");
  });
});

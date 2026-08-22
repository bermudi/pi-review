// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/resume_orphan_request_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ResumeState, LoadResumeState } from "../../../src/ocr/session/resume.ts";
import { SessionFilePath } from "../../../src/ocr/session/persist.ts";

// orphanLLMRequestLine is the shape WriteLLMRequest emits, with no llm_response
// after it. Since the task record is now created before the HTTP call rather
// than after it, a run killed mid-request leaves exactly this in the JSONL.
const orphanLLMRequestLine =
  `{"uuid":"u2","parentUuid":"u1","type":"llm_request","sessionId":"orphan-session",` +
  `"timestamp":"2026-08-07T02:00:00Z","filePath":"b.go","taskType":"main_task","request_no":1,` +
  `"messages":[{"role":"user","content":"review b.go"}]}`;

describe("ocr session resume orphan request", () => {
  // OCR v1.9.3: TestLoadResumeState_IgnoresOrphanLLMRequest
  test("LoadResumeState ignores orphan llm_request without error or counting b.go as completed", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = "/test/orphan";
      const sessionID = "orphan-session";
      const filePath = SessionFilePath(repoDir, sessionID);
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

      // a.go finished before the kill; b.go only got as far as its request.
      const content =
        `{"type":"session_start","sessionId":"orphan-session","cwd":"/test/orphan","reviewMode":"range"}` +
        "\n" +
        `{"type":"review_item_done","filePath":"a.go","fingerprint":"fp-a","comments":[{"content":"comment-a"}]}` +
        "\n" +
        orphanLLMRequestLine +
        "\n";
      fs.writeFileSync(filePath, content, { mode: 0o600 });

      const state = LoadResumeState(repoDir, sessionID);
      expect(state.CompletedCount()).toBe(1);

      const itemA = state.Item("fp-a");
      expect(itemA).not.toBeNull();
      expect(itemA!.fingerprint).toBe("fp-a");

      for (const item of state.Items.values()) {
        if (item.filePath === "b.go") {
          throw new Error(`b.go was resumed as completed from an orphan llm_request: ${JSON.stringify(item)}`);
        }
        expect(item.filePath).not.toBe("b.go");
      }
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestApplyResumeLine_OrphanLLMRequestIsNoOp
  test("applyResumeLine is no-op for orphan llm_request", () => {
    const s = new ResumeState("", "");
    const err = s.applyResumeLine(orphanLLMRequestLine);
    expect(err).toBeNull();
    expect(s.Items.size).toBe(0);
    expect(s.SessionID).toBe("");
    expect(s.ReviewMode).toBe("");
  });
});

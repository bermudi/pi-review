// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/list_more_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { SessionsDir } from "../../../src/ocr-v193/session/persist.js";
import { LoadDetail, LoadSummary, parseRecordTime } from "../../../src/ocr-v193/session/resume.js";
import type { LlmComment } from "../../../src/ocr-v193/model/review.js";

describe("ocr-v193 session list more", () => {
  // OCR v1.9.3: TestParseRecordTime
  test("parseRecordTime covers empty, valid RFC3339 and garbage", () => {
    expect(parseRecordTime("")).toBeNull();
    const want = new Date(Date.UTC(2026, 7, 5, 10, 30, 0, 0));
    const got = parseRecordTime("2026-08-05T10:30:00Z");
    expect(got).not.toBeNull();
    expect(got!.getTime()).toBe(want.getTime());
    expect(parseRecordTime("not-a-timestamp")).toBeNull();
  });

  // OCR v1.9.3: TestSessionsDir_HomeUnset
  test("SessionsDir HomeUnset", () => {
    if (process.platform === "win32") return;
    const origHome = process.env.HOME;
    process.env.HOME = "";
    try {
      expect(() => SessionsDir(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-")))).toThrow();
    } finally {
      process.env.HOME = origHome;
    }
  });

  // OCR v1.9.3: TestLoadSummary_HomeUnset
  test("LoadSummary HomeUnset", () => {
    if (process.platform === "win32") return;
    const origHome = process.env.HOME;
    process.env.HOME = "";
    try {
      expect(() => LoadSummary(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-")), "sess-1")).toThrow();
      expect(() => LoadDetail(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-")), "sess-1")).toThrow();
    } finally {
      process.env.HOME = origHome;
    }
  });

  // OCR v1.9.3: TestManifest_NilReceiver
  test("Manifest nil receiver", () => {
    const sh: SessionHistory | null = null;
    const got = (SessionHistory.prototype.Manifest as unknown as (this: SessionHistory | null) => unknown).call(sh as unknown as SessionHistory);
    expect(got).toBeNull();
  });

  // OCR v1.9.3: TestRecordReviewItem_NilReceiver
  test("RecordReviewItem nil receiver", () => {
    const sh: SessionHistory | null = null;
    expect(() => {
      (SessionHistory.prototype.RecordReviewItemDone as unknown as (this: SessionHistory | null, ...a: unknown[]) => void).call(
        sh as unknown as SessionHistory,
        "a.go",
        "",
        "",
        "fp",
        null,
      );
    }).not.toThrow();
    expect(() => {
      (SessionHistory.prototype.RecordReviewItemReused as unknown as (this: SessionHistory | null, ...a: unknown[]) => void).call(
        sh as unknown as SessionHistory,
        "a.go",
        "",
        "",
        "fp",
        "src",
        null,
      );
    }).not.toThrow();
    expect(() => {
      (SessionHistory.prototype.RecordReviewItemFailed as unknown as (this: SessionHistory | null, ...a: unknown[]) => void).call(
        sh as unknown as SessionHistory,
        "a.go",
        "",
        "",
        "fp",
        "boom",
      );
    }).not.toThrow();
  });

  // OCR v1.9.3: TestRecordReviewItem_EmptyFilePathUsesNewPath
  test("RecordReviewItem EmptyFilePathUsesNewPath", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const sh = new SessionHistory(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-")), "main", "test-model", {});
      sh.RecordReviewItemDone("", "old.go", "done.go", "fp1", null as unknown as LlmComment[]);
      expect(sh.fileSessions.has("done.go")).toBe(true);

      sh.RecordReviewItemReused("", "old.go", "reused.go", "fp2", "src", [{ content: "x" } as LlmComment] as LlmComment[]);
      expect(sh.fileSessions.has("reused.go")).toBe(true);

      sh.RecordReviewItemFailed("", "old.go", "failed.go", "fp3", "boom");
      expect(sh.fileSessions.has("failed.go")).toBe(true);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

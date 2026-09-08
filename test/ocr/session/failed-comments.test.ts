// pi-reviewer extension tests: failed review items preserve partial findings.
// Motivated by a review where the failed file showed 4 findings in the CLI
// but saved 0 in the session record. Owned contract, not OCR parity.

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionHistory } from "../../../src/ocr/session/history.ts";
import { JsonlWriter, SessionFilePath } from "../../../src/ocr/session/persist.ts";
import type { LlmComment } from "../../../src/ocr/model/review.ts";

function readRecords(fp: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(fp, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function sampleComment(): LlmComment {
  return {
    path: "a.ts",
    content: "partial finding",
    existingCode: "const x = 1;",
    category: "bug",
    severity: "high",
  } as unknown as LlmComment;
}

describe("failed item partial comments", () => {
  test("WriteReviewItemFailed persists comments when provided", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const w = new JsonlWriter("sess-1", repoDir, "main", "m", { reviewMode: "workspace" });
      w.open();
      w.WriteSessionStart(new Date());
      w.WriteReviewItemFailed("a.ts", "a.ts", "a.ts", "fp1", "budget exhausted", [sampleComment()]);
      w.WriteSessionEnd(1, ["a.ts"], 0, null);
      const recs = readRecords(SessionFilePath(repoDir, "sess-1"));
      const failed = recs.find((r) => r["type"] === "review_item_failed");
      expect(failed).toBeDefined();
      expect(failed?.["error"]).toBe("budget exhausted");
      const comments = failed?.["comments"] as unknown[];
      expect(Array.isArray(comments)).toBe(true);
      expect(comments).toHaveLength(1);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("WriteReviewItemFailed without comments omits the field (back-compat)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const w = new JsonlWriter("sess-2", repoDir, "main", "m", {});
      w.open();
      w.WriteSessionStart(new Date());
      w.WriteReviewItemFailed("b.ts", "b.ts", "b.ts", "fp2", "boom");
      w.WriteSessionEnd(1, [], 0, null);
      const recs = readRecords(SessionFilePath(repoDir, "sess-2"));
      const failed = recs.find((r) => r["type"] === "review_item_failed");
      expect(failed).toBeDefined();
      expect("comments" in (failed ?? {})).toBe(false);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("SessionHistory.RecordReviewItemFailed forwards partial comments", () => {
    const sh = new SessionHistory("/tmp/repo", "main", "m", {});
    let seen: unknown[] | undefined;
    sh._attachPersist({
      writeReviewItemDone: () => {},
      writeReviewItemReused: () => {},
      writeReviewItemFailed: (_fp: string, _o: string, _n: string, _f: string, _e: string, c?: unknown[]) => {
        seen = c as unknown[];
      },
      writeResumeLineage: () => {},
      writeSessionEnd: () => null,
      writeLLMRequest: () => {},
      writeLLMResponse: () => {},
      writeLLMError: () => {},
      writeToolCall: () => {},
    });
    sh.RecordReviewItemFailed("a.ts", "a.ts", "a.ts", "fp1", "budget", [sampleComment()]);
    expect(seen).toHaveLength(1);
  });
});

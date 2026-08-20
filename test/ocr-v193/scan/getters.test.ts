// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/scan/getters_test.go and getters_more_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// localPath test/ocr-v193/scan/getters.test.ts -> internal/scan/getters_test.go

import { describe, test, expect } from "bun:test";
import { Agent } from "../../../src/ocr-v193/scan/scan.js";
import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanItemFingerprint, resumedFromSession } from "../../../src/ocr-v193/scan/scan.js";
import type { ScanItem } from "../../../src/ocr-v193/model/scan.js";
import { ResumeState } from "../../../src/ocr-v193/session/resume.js";

describe("ocr-v193 scan getters (ported)", () => {
  // OCR v1.9.3: TestScanGettersOnEmptyAgent
  test("TestScanGettersOnEmptyAgent", () => {
    const a = new Agent({ template: { MainTask: { messages: [] }, MemoryCompressionTask: { messages: [] }, MaxTokens: 0, MaxToolRequestTimes: 0, PlanModeLineThreshold: 0 } as unknown as never } as unknown as never);
    // Use empty agent via direct construction with empty args
    const empty = new (Agent as unknown as new (args: unknown) => Agent)({ template: { MainTask: { messages: [] }, MemoryCompressionTask: { messages: [] }, MaxTokens: 0, MaxToolRequestTimes: 0 } } as unknown as never);
    // SessionID on empty should be ""
    expect(empty.SessionID()).toBe("");
    expect(empty.RunManifest()).toBeNull();
    expect(empty.BudgetExceeded()).toBe(false);
    // nil receiver equivalent: call on undefined should not throw; we simulate by checking empty
    expect(empty.SessionID()).toBe("");
  });

  // OCR v1.9.3: TestScanAgent_SessionID_Persistent
  test("TestScanAgent_SessionID_Persistent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sess-"));
    const sess = new SessionHistory(dir, "", "model-x", { reviewMode: "full_scan" });
    const a = new Agent({ template: { MainTask: { messages: [{ role: "user", content: "hi" }] }, MemoryCompressionTask: { messages: [] }, MaxTokens: 1000, MaxToolRequestTimes: 1 } as unknown as never, session: sess as unknown as never } as unknown as never);
    expect(a.SessionID()).toBe(sess.sessionId ?? "");
  });

  // OCR v1.9.3: TestScanAgent_ResumeInfo
  test("TestScanAgent_ResumeInfo", () => {
    const a = new Agent({ template: { MainTask: { messages: [{ role: "user", content: "hi" }] }, MemoryCompressionTask: { messages: [] }, MaxTokens: 1000, MaxToolRequestTimes: 1 } as unknown as never } as unknown as never);
    expect(a.ResumeInfo()).toBeNull();
    (a as unknown as { resumeInfo: unknown }).resumeInfo = { resumedFrom: "sess-1", reusedFiles: 3, rerunFiles: 0 };
    const got = a.ResumeInfo() as unknown as { resumedFrom: string; reusedFiles: number };
    expect(got).not.toBeNull();
    expect(got.resumedFrom).toBe("sess-1");
    expect(got.reusedFiles).toBe(3);
    // Must be copy not same pointer
    expect(got).not.toBe((a as unknown as { resumeInfo: unknown }).resumeInfo);
  });

  // OCR v1.9.3: TestScanAgent_Fingerprints
  test("TestScanAgent_Fingerprints", () => {
    const a = new Agent({ template: { MainTask: { messages: [] }, MemoryCompressionTask: { messages: [] }, MaxTokens: 0, MaxToolRequestTimes: 0 } as unknown as never } as unknown as never);
    const items: ScanItem[] = [
      { path: "a.go", content: "package a\n", lineCount: 1 },
      { path: "b.go", content: "package b\n", lineCount: 1 },
    ];
    (a as unknown as { initScanFingerprints: (items: ScanItem[]) => void }).initScanFingerprints(items);
    const map = (a as unknown as { scanFingerprints: Map<string, string> }).scanFingerprints;
    expect(map.size).toBe(2);
    const fp = (a as unknown as { scanItemFingerprint: (it: ScanItem) => string }).scanItemFingerprint(items[0]!);
    expect(fp).toBe(map.get("a.go") as string);
    const other: ScanItem = { path: "c.go", content: "package c\n", lineCount: 1 };
    const got = (a as unknown as { scanItemFingerprint: (it: ScanItem) => string }).scanItemFingerprint(other);
    expect(got).toBe(scanItemFingerprint(other));
    const empty = new Agent({ template: { MainTask: { messages: [] }, MemoryCompressionTask: { messages: [] }, MaxTokens: 0, MaxToolRequestTimes: 0 } as unknown as never } as unknown as never);
    (empty as unknown as { initScanFingerprints: (items: ScanItem[] | null) => void }).initScanFingerprints(null);
    expect((empty as unknown as { scanFingerprints: Map<string, string> | null }).scanFingerprints === null || (empty as unknown as { scanFingerprints: Map<string, string> }).scanFingerprints.size === 0).toBe(true);
  });

  // OCR v1.9.3: TestResumedFromSession
  test("TestResumedFromSession", () => {
    expect(resumedFromSession(null)).toBe("");
    const rs = new ResumeState("prev-123", "/tmp");
    expect(resumedFromSession(rs as unknown as never)).toBe("prev-123");
  });
});

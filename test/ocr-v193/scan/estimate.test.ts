// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/scan/estimate_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// localPath test/ocr-v193/scan/estimate.test.ts -> internal/scan/estimate_test.go

import { describe, test, expect } from "bun:test";
import type { ScanItem } from "../../../src/ocr-v193/model/scan.js";
import {
  estimateCost,
  estimateFileTokens,
  humanTokens,
  estimateToString,
} from "../../../src/ocr-v193/scan/estimate.js";
import type { ScanTemplate } from "../../../src/ocr-v193/template/template.js";
import { Agent, NewAgent } from "../../../src/ocr-v193/scan/scan.js";
import { SessionHistory } from "../../../src/ocr-v193/session/history.js";
import { CommentCollector } from "../../../src/ocr-v193/tool/collector.js";

function makeTemplate(): ScanTemplate {
  return {
    MaxTokens: 1000,
    MaxToolRequestTimes: 5,
    MainTask: { messages: [{ role: "system", content: "sys" }, { role: "user", content: "user" }] },
    MemoryCompressionTask: { messages: [{ role: "system", content: "compress" }] },
  } as unknown as ScanTemplate;
}

describe("ocr-v193 scan estimate (ported from internal/scan/estimate_test.go)", () => {
  // OCR v1.9.3: TestHumanTokens
  test("TestHumanTokens", () => {
    const cases: Array<[number, string]> = [
      [0, "0"],
      [420, "420"],
      [999, "999"],
      [1000, "1K"],
      [1500, "2K"],
      [850000, "850K"],
      [1000000, "1.0M"],
      [2400000, "2.4M"],
    ];
    for (const [input, want] of cases) {
      expect(humanTokens(input)).toBe(want);
    }
  });

  // OCR v1.9.3: TestEstimateCost_ScalesWithContentAndPhases
  test("TestEstimateCost_ScalesWithContentAndPhases", () => {
    const items: ScanItem[] = [
      { path: "a.go", content: "token ".repeat(500), lineCount: 1 },
      { path: "b.go", content: "x ".repeat(300), lineCount: 1 },
      { path: "bin.dat", isBinary: true, content: "", lineCount: 0 },
      { path: "empty.go", content: "", lineCount: 0 },
    ];
    const base = estimateCost(items, false, false, false);
    expect(base.files).toBe(2);
    expect(base.totalTokens).toBeGreaterThan(0);

    const withPlan = estimateCost(items, true, false, false);
    expect(withPlan.totalTokens).toBeGreaterThan(base.totalTokens);

    const full = estimateCost(items, true, true, true);
    expect(full.totalTokens).toBeGreaterThan(withPlan.totalTokens);

    expect(full.totalTokens).toBe(full.inputTokens + full.outputTokens);
  });

  // OCR v1.9.3: TestEstimateFileTokens
  test("TestEstimateFileTokens", () => {
    expect(estimateFileTokens({ path: "x", isBinary: true, content: "hi", lineCount: 1 } as ScanItem, true)).toBe(0);
    expect(estimateFileTokens({ path: "x", content: "", lineCount: 0 } as ScanItem, true)).toBe(0);

    const it: ScanItem = { path: "a.go", content: "token ".repeat(400), lineCount: 1 };
    const withPlan = estimateFileTokens(it, true);
    const noPlan = estimateFileTokens(it, false);
    expect(withPlan).toBeGreaterThan(0);
    expect(noPlan).toBeGreaterThan(0);
    expect(withPlan).toBeGreaterThan(noPlan);

    const agg = estimateCost([it], true, false, false);
    expect(agg.totalTokens).toBe(withPlan);
  });

  // OCR v1.9.3: TestEstimateCost_EmptyItems
  test("TestEstimateCost_EmptyItems", () => {
    const est = estimateCost(null as unknown as ScanItem[], true, true, true);
    expect(est.files).toBe(0);
    expect(est.totalTokens).toBe(0);
  });

  // OCR v1.9.3: TestEstimate_StringMentionsTokens
  test("TestEstimate_StringMentionsTokens", () => {
    const est = { files: 3, inputTokens: 1200000, outputTokens: 90000, totalTokens: 1290000 };
    const s = estimateToString(est as unknown as Parameters<typeof estimateToString>[0]);
    for (const want of ["3 file", "1.2M", "90K", "1.3M"]) {
      expect(s.includes(want)).toBe(true);
    }
  });

  // OCR v1.9.3: TestPhaseEnabled_GatedByTemplateAndFlag
  test("TestPhaseEnabled_GatedByTemplateAndFlag", () => {
    const tpl = makeTemplate() as unknown as ScanTemplate;
    (tpl as unknown as { PlanTask?: unknown }).PlanTask = { messages: [{ role: "user", content: "plan {{file_content}}" }] };
    (tpl as unknown as { DedupTask?: unknown }).DedupTask = { messages: [{ role: "user", content: "dedup {{batch_comments}}" }] };
    (tpl as unknown as { ProjectSummaryTask?: unknown }).ProjectSummaryTask = { messages: [{ role: "user", content: "summary {{all_comments}}" }] };

    const a = NewAgent({
      template: tpl,
      commentCollector: new CommentCollector() as unknown as never,
      tools: { get: () => undefined, freeze: () => {} } as unknown as never,
      session: new SessionHistory("/tmp", "main", "test-model", { reviewMode: "full_scan" }) as unknown as never,
    } as unknown as never);
    expect((a as unknown as { planEnabled: () => boolean }).planEnabled()).toBe(true);
    expect((a as unknown as { dedupEnabled: () => boolean }).dedupEnabled()).toBe(true);
    expect((a as unknown as { summaryEnabled: () => boolean }).summaryEnabled()).toBe(true);

    (a as unknown as { args: { skipPlan: boolean; skipDedup: boolean; skipSummary: boolean } }).args.skipPlan = true;
    (a as unknown as { args: { skipPlan: boolean; skipDedup: boolean; skipSummary: boolean } }).args.skipDedup = true;
    (a as unknown as { args: { skipPlan: boolean; skipDedup: boolean; skipSummary: boolean } }).args.skipSummary = true;
    expect((a as unknown as { planEnabled: () => boolean }).planEnabled()).toBe(false);
    expect((a as unknown as { dedupEnabled: () => boolean }).dedupEnabled()).toBe(false);
    expect((a as unknown as { summaryEnabled: () => boolean }).summaryEnabled()).toBe(false);

    const a2 = NewAgent({
      template: makeTemplate(),
      commentCollector: new CommentCollector() as unknown as never,
      tools: { get: () => undefined, freeze: () => {} } as unknown as never,
      session: new SessionHistory("/tmp", "main", "test-model", { reviewMode: "full_scan" }) as unknown as never,
    } as unknown as never);
    (a2 as unknown as { args: { template: ScanTemplate } }).args.template = { ...makeTemplate(), DedupTask: undefined } as unknown as ScanTemplate;
    expect((a2 as unknown as { dedupEnabled: () => boolean }).dedupEnabled()).toBe(false);
  });
});

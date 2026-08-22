// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/sarif_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import {
  buildSarifReport,
  outputSarifText,
  sarifRules,
  sarifSeverityLevel,
  sarifResults,
  sarifResultFromComment,
  sarifFingerprints,
  sarifInvocationFromRun,
  SARIF_SCHEMA,
  SARIF_VERSION,
  SARIF_TOOL_NAME,
  SARIF_INFORMATION_URI,
  SARIF_FINGERPRINT_KEY,
} from "../../../src/ocr/cli/sarif.js";
import { newQuietHandle, addOutputFlags } from "../../../src/ocr/cli/shared.js";
import { outputPreview } from "../../../src/ocr/cli/output.js";
import type { LlmComment } from "../../../src/ocr/model/review.js";
import type { RunManifest } from "../../../src/ocr/session/manifest.js";

function mockManifest(state: RunManifest["terminalState"]): RunManifest {
  return {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-1",
    operation: "review",
    terminalState: state,
    repository: {},
    input: { mode: "workspace" },
    execution: {},
    coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
    elapsedMs: 0,
  };
}

// OCR v1.9.3: TestOutputSARIF_BasicStructure
test("sarif basic structure", () => {
  const comments: LlmComment[] = [{ path: "a.go", content: "fix", startLine: 1, endLine: 1, category: "bug", severity: "high" }];
  const out = outputSarifText(comments, "test-version", [], null);
  const doc = JSON.parse(out);
  expect(doc.$schema).toBe(SARIF_SCHEMA);
  expect(doc.version).toBe(SARIF_VERSION);
  expect(doc.runs).toHaveLength(1);
  const run = doc.runs[0];
  expect(run.tool.driver.name).toBe(SARIF_TOOL_NAME);
  expect(run.tool.driver.version).toBe("test-version");
  expect(run.tool.driver.informationUri).toBe(SARIF_INFORMATION_URI);
  expect(run.tool.driver.rules).toHaveLength(8);
  expect(run.results).toHaveLength(1);
});

// OCR v1.9.3: TestOutputSARIF_EmptyComments
test("sarif empty comments empty results", () => {
  const out = outputSarifText([], "test-version", [], null);
  const doc = JSON.parse(out);
  const run = doc.runs[0];
  expect(Array.isArray(run.results)).toBe(true);
  expect(run.results).toHaveLength(0);
  expect(run.tool.driver.rules).toHaveLength(8);
});

// OCR v1.9.3: TestEmitRunResult_SarifNoFiles
test("sarif no files via buildSarifReport", () => {
  const report = buildSarifReport([], "test-version", [], null);
  expect(report.runs[0]!.results).toHaveLength(0);
});

// OCR v1.9.3: TestOutputSARIF_FullFieldMapping
test("sarif full field mapping", () => {
  const comment: LlmComment = {
    path: "internal/agent/agent.go",
    content: "Potential nil pointer dereference",
    suggestionCode: "if err != nil { return err }",
    existingCode: "return err",
    startLine: 42,
    endLine: 42,
    category: "bug",
    severity: "high",
  };
  const out = outputSarifText([comment], "v1", [], null);
  const doc = JSON.parse(out);
  const result = doc.runs[0].results[0];
  expect(result.ruleId).toBe("bug");
  expect(result.level).toBe("error");
  expect(result.message.text).toBe("Potential nil pointer dereference");
  expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe("internal/agent/agent.go");
  expect(result.locations[0].physicalLocation.region.startLine).toBe(42);
  expect(result.locations[0].physicalLocation.region.endLine).toBe(42);
  expect(result.fixes[0].artifactChanges[0].artifactLocation.uri).toBe("internal/agent/agent.go");
  expect(result.fixes[0].artifactChanges[0].replacements[0].deletedRegion.startLine).toBe(42);
  expect(result.fixes[0].artifactChanges[0].replacements[0].insertedContent.text).toBe("if err != nil { return err }");
  expect(result.partialFingerprints[SARIF_FINGERPRINT_KEY]).toBeDefined();
});

// OCR v1.9.3: TestSarifSeverityLevel
test("sarifSeverityLevel mapping", () => {
  expect(sarifSeverityLevel("critical")).toBe("error");
  expect(sarifSeverityLevel("high")).toBe("error");
  expect(sarifSeverityLevel("medium")).toBe("warning");
  expect(sarifSeverityLevel("low")).toBe("note");
  expect(sarifSeverityLevel("")).toBe("note");
  expect(sarifSeverityLevel("unknown")).toBe("note");
  expect(sarifSeverityLevel("CRITICAL")).toBe("note");
});

// OCR v1.9.3: TestOutputSARIF_EmptyCategory
test("sarif empty category defaults to other", () => {
  const out = outputSarifText([{ path: "a.go", content: "test", startLine: 1, endLine: 1, category: "", severity: "medium" }], "v1", [], null);
  const doc = JSON.parse(out);
  expect(doc.runs[0].results[0].ruleId).toBe("other");
});

// OCR v1.9.3: TestOutputSARIF_ZeroLineNumbers
test("sarif zero line numbers omit region and fixes", () => {
  const out = outputSarifText([{ path: "a.go", content: "test", suggestionCode: "new code", existingCode: "old code", startLine: 0, endLine: 0, category: "bug", severity: "high" }], "v1", [], null);
  const doc = JSON.parse(out);
  const result = doc.runs[0].results[0];
  expect(result.locations[0].physicalLocation.region).toBeUndefined();
  expect(result.fixes).toBeUndefined();
});

// OCR v1.9.3: TestOutputSARIF_NoFixes
test("sarif no fixes when suggestion or existing empty", () => {
  for (const tc of [
    { suggest: "", existing: "" },
    { suggest: "", existing: "old code" },
    { suggest: "new code", existing: "" },
  ] as const) {
    const out = outputSarifText([{ path: "a.go", content: "test", suggestionCode: tc.suggest, existingCode: tc.existing, startLine: 1, endLine: 1, category: "bug", severity: "high" }], "v1", [], null);
    const doc = JSON.parse(out);
    expect(doc.runs[0].results[0].fixes).toBeUndefined();
  }
});

// OCR v1.9.3: TestSarifRules
test("sarifRules completeness", () => {
  const rules = sarifRules();
  expect(rules).toHaveLength(8);
  const ids = new Set(rules.map(r => r.id));
  for (const id of ["bug", "security", "performance", "maintainability", "test", "style", "documentation", "other"]) {
    expect(ids.has(id)).toBe(true);
  }
  for (const r of rules) {
    expect(r.id).not.toBe("");
    expect(r.name).not.toBe("");
    expect(r.shortDescription.text).not.toBe("");
  }
});

// OCR v1.9.3: TestAddOutputFlags_IncludesSarif
test("addOutputFlags includes sarif", () => {
  const flags = addOutputFlags();
  const format = flags.find(f => f.name === "format");
  expect(format).toBeDefined();
  expect(format!.usage).toContain("sarif");
});

// OCR v1.9.3: TestEmitRunResult_Sarif
test("emitRunResult sarif via buildSarifReport", () => {
  const comments: LlmComment[] = [{ path: "main.go", content: "nil deref", startLine: 10, endLine: 10, category: "bug", severity: "critical" }];
  const manifest = mockManifest("complete");
  const report = buildSarifReport(comments, "v1", [], manifest);
  expect(report.version).toBe(SARIF_VERSION);
  expect(report.runs[0]!.results).toHaveLength(1);
});

// OCR v1.9.3: TestOutputSARIF_SchemaCompliance
test("sarif schema compliance", () => {
  const out = outputSarifText([{ path: "a.go", content: "test", startLine: 5, endLine: 10, category: "security", severity: "medium" }], "v1", [], null);
  const doc = JSON.parse(out);
  expect(typeof doc.version).toBe("string");
  const result = doc.runs[0].results[0];
  expect(typeof result.ruleId).toBe("string");
  expect(typeof result.level).toBe("string");
  expect(Array.isArray(result.locations)).toBe(true);
  expect(typeof result.locations[0].physicalLocation.region.startLine).toBe("number");
  expect(typeof result.locations[0].physicalLocation.region.endLine).toBe("number");
  for (const f of result.fixes ?? []) {
    for (const ac of f.artifactChanges) for (const r of ac.replacements) expect(r.deletedRegion).toBeDefined();
  }
});

// OCR v1.9.3: TestOutputSARIF_JSONFormatting
test("sarif json formatting trailing newline and indent", () => {
  const out = outputSarifText([], "v1", [], null);
  expect(out.endsWith("\n")).toBe(true);
  expect(out).toContain("\n  \"");
  JSON.parse(out);
});

// OCR v1.9.3: TestOutputSARIF_MultipleComments
test("sarif multiple comments", () => {
  const comments: LlmComment[] = [
    { path: "a.go", content: "bug here", startLine: 1, endLine: 1, category: "bug", severity: "critical" },
    { path: "b.go", content: "slow query", startLine: 10, endLine: 20, category: "performance", severity: "medium" },
    { path: "c.go", content: "bad naming", startLine: 5, endLine: 5, category: "style", severity: "low" },
  ];
  const out = outputSarifText(comments, "v1", [], null);
  const doc = JSON.parse(out);
  expect(doc.runs[0].results).toHaveLength(3);
  expect(doc.runs[0].results[0].ruleId).toBe("bug");
  expect(doc.runs[0].results[0].level).toBe("error");
  expect(doc.runs[0].results[1].ruleId).toBe("performance");
  expect(doc.runs[0].results[1].level).toBe("warning");
  expect(doc.runs[0].results[2].ruleId).toBe("style");
  expect(doc.runs[0].results[2].level).toBe("note");
});

// OCR v1.9.3: TestNewQuietHandle_Sarif
test("newQuietHandle sarif human keeps stderr routing active", () => {
  const h = newQuietHandle("sarif", "human");
  expect(h.fn).toBeNull();
  h.Restore();
});

// OCR v1.9.3: TestSarifResultFromComment_EmptyPath
test("sarifResultFromComment empty path omits locations and fixes", () => {
  const r = sarifResultFromComment({ path: "", content: "test", category: "bug", severity: "high" });
  expect(r.locations).toBeUndefined();
  expect(r.fixes).toBeUndefined();
});

// OCR v1.9.3: TestSarifResultFromComment_InvertedLineNumbers
test("sarifResultFromComment inverted line numbers", () => {
  const r = sarifResultFromComment({ path: "a.go", content: "test", suggestionCode: "new code", existingCode: "old code", startLine: 10, endLine: 5, category: "bug", severity: "high" });
  expect(r.locations).toBeDefined();
  expect(r.locations![0]!.physicalLocation.region).toBeUndefined();
  expect(r.fixes).toBeUndefined();
});

// OCR v1.9.3: TestSarifResultFromComment_FixesWithEmptyPath
test("sarifResultFromComment fixes with empty path", () => {
  const r = sarifResultFromComment({ path: "", content: "test", suggestionCode: "new code", existingCode: "old code", startLine: 1, endLine: 1, category: "bug", severity: "high" });
  expect(r.locations).toBeUndefined();
  expect(r.fixes).toBeUndefined();
});

// OCR v1.9.3: TestSarifFingerprints_Stable
test("sarifFingerprints stable", () => {
  const c1: LlmComment = { path: "a.go", content: "", category: "bug", existingCode: "old code" };
  const c2: LlmComment = { path: "a.go", content: "", category: "bug", existingCode: "old code" };
  const c3: LlmComment = { path: "a.go", content: "different message", category: "bug", existingCode: "old code" };
  const fp1 = sarifFingerprints(c1, "bug");
  const fp2 = sarifFingerprints(c2, "bug");
  const fp3 = sarifFingerprints(c3, "bug");
  expect(fp1[SARIF_FINGERPRINT_KEY]).toBe(fp2[SARIF_FINGERPRINT_KEY]);
  expect(fp1[SARIF_FINGERPRINT_KEY]).toBe(fp3[SARIF_FINGERPRINT_KEY]);
});

// OCR v1.9.3: TestSarifFingerprints_EmptyExistingCodeFallback
test("sarifFingerprints empty existing fallback to startLine", () => {
  const c1: LlmComment = { path: "a.go", content: "", category: "bug", existingCode: "", startLine: 10 };
  const c2: LlmComment = { path: "a.go", content: "", category: "bug", existingCode: "", startLine: 20 };
  const fp1 = sarifFingerprints(c1, "bug");
  const fp2 = sarifFingerprints(c2, "bug");
  expect(fp1[SARIF_FINGERPRINT_KEY]).not.toBe(fp2[SARIF_FINGERPRINT_KEY]);
  const c3: LlmComment = { path: "a.go", content: "", category: "bug", existingCode: "", startLine: 10 };
  expect(fp1[SARIF_FINGERPRINT_KEY]).toBe(sarifFingerprints(c3, "bug")[SARIF_FINGERPRINT_KEY]);
});

// OCR v1.9.3: TestSarifInvocation_ExecutionSuccessful
test("sarifInvocation executionSuccessful", () => {
  expect(sarifInvocationFromRun([], null, 0).executionSuccessful).toBe(true);
  expect(sarifInvocationFromRun([], mockManifest("complete"), 0).executionSuccessful).toBe(true);
  expect(sarifInvocationFromRun([], mockManifest("skipped"), 0).executionSuccessful).toBe(true);
  expect(sarifInvocationFromRun([], mockManifest("partial"), 0).executionSuccessful).toBe(true);
  expect(sarifInvocationFromRun([], mockManifest("failed"), 0).executionSuccessful).toBe(false);
});

// OCR v1.9.3: TestSarifInvocation_WarningsAsNotifications
test("sarifInvocation warnings as notifications", () => {
  const warnings = [{ type: "warning", file: "x.go", message: "slow" }, { type: "subtask_error", file: "y.go", message: "failed" }];
  const invWithManifest = sarifInvocationFromRun(warnings, mockManifest("complete"), 0);
  expect(invWithManifest.toolExecutionNotifications).toHaveLength(1);
  expect(invWithManifest.toolExecutionNotifications![0]!.message.text).toBe("slow");
  expect(invWithManifest.toolExecutionNotifications![0]!.level).toBe("warning");
  const invNoManifest = sarifInvocationFromRun(warnings, null, 0);
  expect(invNoManifest.toolExecutionNotifications).toHaveLength(2);
});

// OCR v1.9.3: TestSarifInvocation_NonCompleteAddsManifestNotification
test("sarifInvocation non-complete adds manifest notification", () => {
  expect(sarifInvocationFromRun([], mockManifest("partial"), 3).toolExecutionNotifications).toHaveLength(1);
  expect(sarifInvocationFromRun([], mockManifest("skipped"), 0).toolExecutionNotifications).toHaveLength(1);
  expect(sarifInvocationFromRun([], mockManifest("complete"), 5).toolExecutionNotifications).toBeUndefined();
});

// OCR v1.9.3: TestSarifResults_DuplicateFingerprints
test("sarifResults duplicate fingerprints get suffix", () => {
  const comments: LlmComment[] = [
    { path: "a.go", content: "SQL injection 1", category: "security", existingCode: "query('SELECT * FROM users WHERE id=' + id)", startLine: 10, endLine: 10 },
    { path: "a.go", content: "SQL injection 2", category: "security", existingCode: "query('SELECT * FROM users WHERE id=' + id)", startLine: 20, endLine: 20 },
  ];
  const out = outputSarifText(comments, "v1", [], null);
  const doc = JSON.parse(out);
  const fp0 = doc.runs[0].results[0].partialFingerprints[SARIF_FINGERPRINT_KEY];
  const fp1 = doc.runs[0].results[1].partialFingerprints[SARIF_FINGERPRINT_KEY];
  expect(fp0).not.toBe(fp1);
  expect(fp1.endsWith("#1")).toBe(true);
});

// OCR v1.9.3: TestOutputPreview_SarifRejects
test("outputPreview sarif rejects", () => {
  const p = { entries: [], totalInsertions: 0, totalDeletions: 0, totalFiles: 0, reviewableCount: 0, excludedCount: 0 };
  const { error } = outputPreview(p as unknown as Parameters<typeof outputPreview>[0], "sarif");
  expect(error).toBeDefined();
});

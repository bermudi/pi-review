// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/sarif.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import type { LlmComment } from "../model/review.js";
import type { RunManifest, TerminalState } from "../session/manifest.js";

// ---------------------------------------------------------------------------
// Constants — mirrors Go sarif.go
// ---------------------------------------------------------------------------

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
export const SARIF_VERSION = "2.1.0";
export const SARIF_TOOL_NAME = "OpenCodeReview";
export const SARIF_INFORMATION_URI = "https://github.com/alibaba/open-code-review";
export const SARIF_FINGERPRINT_KEY = "ocrFinding/v1";

// ---------------------------------------------------------------------------
// SARIF types — mirrors Go structs with json tags
// ---------------------------------------------------------------------------

export interface SarifReport {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

export interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
  invocations?: SarifInvocation[];
}

export interface SarifTool {
  driver: SarifDriver;
}

export interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: SarifMessage;
}

export interface SarifResult {
  ruleId: string;
  level: string;
  message: SarifMessage;
  locations?: SarifLocation[];
  partialFingerprints?: Record<string, string>;
  fixes?: SarifFix[];
}

export interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

export interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region?: SarifRegion;
}

export interface SarifArtifactLocation {
  uri: string;
}

export interface SarifRegion {
  startLine: number;
  endLine: number;
}

export interface SarifFix {
  artifactChanges: SarifArtifactChange[];
}

export interface SarifArtifactChange {
  artifactLocation: SarifArtifactLocation;
  replacements: SarifReplacement[];
}

export interface SarifReplacement {
  deletedRegion: SarifRegion;
  insertedContent?: SarifInsertedContent;
}

export interface SarifInsertedContent {
  text: string;
}

export interface SarifMessage {
  text: string;
}

export interface SarifInvocation {
  executionSuccessful: boolean;
  toolExecutionNotifications?: SarifNotification[];
}

export interface SarifNotification {
  level: string;
  message: SarifMessage;
}

export interface SarifWarning {
  type: string;
  file: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Rules — 8 built-in categories, mirrors Go sarifRules()
// ---------------------------------------------------------------------------

export function sarifRules(): SarifRule[] {
  return [
    { id: "bug", name: "Bug", shortDescription: { text: "Defect or logic error" } },
    { id: "security", name: "Security", shortDescription: { text: "Security vulnerability" } },
    { id: "performance", name: "Performance", shortDescription: { text: "Performance issue" } },
    { id: "maintainability", name: "Maintainability", shortDescription: { text: "Maintainability concern" } },
    { id: "test", name: "Test", shortDescription: { text: "Test coverage or quality issue" } },
    { id: "style", name: "Style", shortDescription: { text: "Code style issue" } },
    { id: "documentation", name: "Documentation", shortDescription: { text: "Documentation issue" } },
    { id: "other", name: "Other", shortDescription: { text: "Other review finding" } },
  ];
}

// ---------------------------------------------------------------------------
// Severity → level — mirrors Go sarifSeverityLevel
// ---------------------------------------------------------------------------

export function sarifSeverityLevel(severity: string | undefined): string {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "note";
    default:
      return "note";
  }
}

// ---------------------------------------------------------------------------
// Fingerprint — mirrors Go sarifFingerprints
// ---------------------------------------------------------------------------

function sarifFingerprints(comment: LlmComment, category: string): Record<string, string> {
  const trimmed = (comment.existingCode ?? "").trim();
  let source: string;
  if (trimmed !== "") {
    source = `${comment.path}|${category}|${trimmed}`;
  } else {
    const sl = comment.startLine ?? 0;
    source = `${comment.path}|${category}|${String(sl)}`;
  }
  const h = createHash("sha256").update(source, "utf-8").digest("hex");
  return { [SARIF_FINGERPRINT_KEY]: h };
}

// ---------------------------------------------------------------------------
// Result conversion — mirrors Go sarifResultFromComment / sarifResults
// ---------------------------------------------------------------------------

function sarifResultFromComment(comment: LlmComment): SarifResult {
  const category = comment.category !== undefined && comment.category !== "" ? comment.category : "other";
  const hasRegion = (comment.startLine ?? 0) > 0 && (comment.endLine ?? 0) >= (comment.startLine ?? 0);

  const result: SarifResult = {
    ruleId: category,
    level: sarifSeverityLevel(comment.severity),
    message: { text: comment.content },
    partialFingerprints: sarifFingerprints(comment, category),
  };

  if (comment.path !== "") {
    const loc: SarifLocation = {
      physicalLocation: {
        artifactLocation: { uri: comment.path },
      },
    };
    if (hasRegion) {
      loc.physicalLocation.region = {
        startLine: comment.startLine ?? 0,
        endLine: comment.endLine ?? 0,
      };
    }
    result.locations = [loc];
  }

  if (
    (comment.suggestionCode ?? "") !== "" &&
    (comment.existingCode ?? "") !== "" &&
    comment.path !== "" &&
    hasRegion
  ) {
    const rep: SarifReplacement = {
      deletedRegion: {
        startLine: comment.startLine ?? 0,
        endLine: comment.endLine ?? 0,
      },
      insertedContent: { text: comment.suggestionCode ?? "" },
    };
    result.fixes = [
      {
        artifactChanges: [
          {
            artifactLocation: { uri: comment.path },
            replacements: [rep],
          },
        ],
      },
    ];
  }

  return result;
}

export function sarifResults(comments: readonly LlmComment[]): SarifResult[] {
  const results: SarifResult[] = [];
  const seen = new Map<string, number>();
  for (const c of comments) {
    const r = sarifResultFromComment(c);
    const baseFp = r.partialFingerprints?.[SARIF_FINGERPRINT_KEY] ?? "";
    const count = seen.get(baseFp) ?? 0;
    seen.set(baseFp, count + 1);
    if (count > 0 && r.partialFingerprints !== undefined) {
      r.partialFingerprints[SARIF_FINGERPRINT_KEY] = `${baseFp}#${String(count)}`;
    }
    results.push(r);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Invocation — mirrors Go sarifInvocationFromRun
// ---------------------------------------------------------------------------

function isSubtaskErrorType(t: string): boolean {
  return t === "subtask_error" || t === "scan_subtask_error";
}

function manifestMessage(manifest: RunManifest | null | undefined, findings: number): string {
  if (!manifest) return "";
  const selected = manifest.coverage.selected.length;
  const failed = manifest.coverage.failed.length;
  const waived = manifest.coverage.waived.length;
  switch (manifest.terminalState as TerminalState) {
    case "complete":
      if (waived > 0) return `Review complete: ${findings} finding(s) across ${selected} selected item(s), including ${waived} waived.`;
      return `Review complete: ${findings} finding(s) across ${selected} selected item(s).`;
    case "partial":
      return `Review partially complete: ${findings} finding(s); ${failed} of ${selected} selected item(s) failed.`;
    case "failed":
      if (manifest.runFailure?.classification) {
        return `Review failed (${manifest.runFailure.classification}): ${findings} finding(s); ${failed} of ${selected} selected item(s) failed.`;
      }
      return `Review failed: ${findings} finding(s); ${failed} of ${selected} selected item(s) failed.`;
    case "skipped":
      return "Review skipped: no items were selected.";
    default:
      return `Review finished with unknown manifest state "${String(manifest.terminalState)}".`;
  }
}

export function sarifInvocationFromRun(
  warnings: readonly SarifWarning[],
  manifest: RunManifest | null | undefined,
  findings: number,
): SarifInvocation {
  let successful = true;
  if (manifest) {
    successful = manifest.terminalState !== "failed";
  }
  const inv: SarifInvocation = { executionSuccessful: successful };

  if (manifest && manifest.terminalState !== "complete") {
    inv.toolExecutionNotifications = inv.toolExecutionNotifications ?? [];
    inv.toolExecutionNotifications.push({
      level: "warning",
      message: { text: manifestMessage(manifest, findings) },
    });
  }

  for (const w of warnings) {
    if (manifest && isSubtaskErrorType(w.type)) continue;
    inv.toolExecutionNotifications = inv.toolExecutionNotifications ?? [];
    inv.toolExecutionNotifications.push({
      level: "warning",
      message: { text: w.message },
    });
  }

  return inv;
}

// ---------------------------------------------------------------------------
// Public builder — mirrors Go outputSARIF
// ---------------------------------------------------------------------------

export function buildSarifReport(
  comments: readonly LlmComment[],
  version: string,
  warnings: readonly SarifWarning[],
  manifest: RunManifest | null | undefined,
): SarifReport {
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            version,
            informationUri: SARIF_INFORMATION_URI,
            rules: sarifRules(),
          },
        },
        results: sarifResults(comments),
        invocations: [sarifInvocationFromRun(warnings, manifest, comments.length)],
      },
    ],
  };
}

export function outputSarifText(
  comments: readonly LlmComment[],
  version: string,
  warnings: readonly SarifWarning[],
  manifest: RunManifest | null | undefined,
): string {
  const report = buildSarifReport(comments, version, warnings, manifest);
  return `${JSON.stringify(report, null, 2)}\n`;
}

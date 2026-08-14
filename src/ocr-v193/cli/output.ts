// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/output.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { LlmComment } from "../model/review.js";
import type { RunManifest } from "../session/manifest.js";
import type { Preview } from "../model/preview.js";

// ---------------------------------------------------------------------------
// Warning helpers — mirrors Go hasSubtaskErrors / warningsForOutput
// ---------------------------------------------------------------------------

export interface AgentWarning {
  readonly type: string;
  readonly file: string;
  readonly message: string;
}

export function isSubtaskErrorType(t: string): boolean {
  return t === "subtask_error" || t === "scan_subtask_error";
}

export function hasSubtaskErrors(warnings: readonly AgentWarning[]): boolean {
  for (const w of warnings) if (isSubtaskErrorType(w.type)) return true;
  return false;
}

export function warningsForOutput(
  warnings: readonly AgentWarning[],
  manifest: RunManifest | null | undefined,
): AgentWarning[] {
  if (!manifest || warnings.length === 0) return [...warnings];
  const filtered: AgentWarning[] = [];
  for (const w of warnings) if (!isSubtaskErrorType(w.type)) filtered.push(w);
  return filtered.length === 0 ? [] : filtered;
}

// ---------------------------------------------------------------------------
// Manifest message — mirrors Go manifestMessage
// ---------------------------------------------------------------------------

export function manifestMessage(manifest: RunManifest | null | undefined, findings: number): string {
  if (!manifest) return "";
  const selected = manifest.coverage.selected.length;
  const failed = manifest.coverage.failed.length;
  const waived = manifest.coverage.waived.length;
  switch (manifest.terminalState) {
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

// ---------------------------------------------------------------------------
// Terminal sanitization — mirrors Go sanitizeTerminal
// ---------------------------------------------------------------------------

export function sanitizeTerminal(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\t" || ch === "\n") {
      out += ch;
      continue;
    }
    // Drop other control chars (0x00-0x1F, 0x7F)
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wrapping — mirrors Go wrapByRunes / wrapSingleRuneLine / runeWrapCut
// ---------------------------------------------------------------------------

function visibleRunesLen(runes: string[]): number {
  let n = 0;
  for (const r of runes) {
    const code = r.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) n++;
  }
  return n;
}

function runeWrapCut(runes: string[], maxW: number): number {
  if (visibleRunesLen(runes) <= maxW) return runes.length;
  let best = maxW;
  if (best >= runes.length) return runes.length;
  for (let i = best; i > 0; i--) {
    if (runes[i] === " " || runes[i] === "\t") return i;
  }
  return best;
}

function wrapSingleRuneLine(line: string, maxW: number): string[] {
  const runes = [...line];
  if (visibleRunesLen(runes) <= maxW) return [line];
  const result: string[] = [];
  let rest = runes;
  while (rest.length > 0) {
    const cut = runeWrapCut(rest, maxW);
    result.push(rest.slice(0, cut).join(""));
    rest = rest.slice(cut);
    while (rest.length > 0 && rest[0] === " ") rest = rest.slice(1);
  }
  return result;
}

export function wrapByRunes(text: string, maxW: number): string[] {
  if (text === "") return [];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    out.push(...wrapSingleRuneLine(para, maxW));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff suggest — mirrors Go buildDiffLines / splitToLines / suggestdiff
// ---------------------------------------------------------------------------

function splitToLines(s: string): string[] {
  const lines = s.replaceAll("\r\n", "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export type DiffLineType = 0 | 1 | 2;
export const DiffContext: DiffLineType = 0;
export const DiffAdded: DiffLineType = 1;
export const DiffDeleted: DiffLineType = 2;

export interface DiffLine {
  readonly type: DiffLineType;
  readonly content: string;
}

function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0 && n === 0) return [];
  const lcs: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const a = (oldLines[i - 1] ?? "").trim().toLowerCase();
      const b = (newLines[j - 1] ?? "").trim().toLowerCase();
      if (a === b) {
        lcs[i]![j] = (lcs[i - 1]?.[j - 1] ?? 0) + 1;
      } else {
        lcs[i]![j] = Math.max(lcs[i - 1]?.[j] ?? 0, lcs[i]?.[j - 1] ?? 0);
      }
    }
  }
  const back: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && (oldLines[i - 1] ?? "").trim().toLowerCase() === (newLines[j - 1] ?? "").trim().toLowerCase()) {
      back.push({ type: DiffContext, content: oldLines[i - 1] ?? "" });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (lcs[i]?.[j - 1] ?? 0) >= (lcs[i - 1]?.[j] ?? 0))) {
      back.push({ type: DiffAdded, content: newLines[j - 1] ?? "" });
      j--;
    } else {
      back.push({ type: DiffDeleted, content: oldLines[i - 1] ?? "" });
      i--;
    }
  }
  back.reverse();
  return back;
}

export function buildDiffLines(comment: LlmComment): DiffLine[] {
  if (!comment.suggestionCode || !comment.existingCode) return [];
  const oldLines = splitToLines(comment.existingCode);
  const newLines = splitToLines(comment.suggestionCode);
  return computeLineDiff(oldLines, newLines);
}

// ---------------------------------------------------------------------------
// Badge + color — mirrors Go buildBadge / severityColor
// ---------------------------------------------------------------------------

export function buildBadge(comment: LlmComment): string {
  const category = sanitizeTerminal(comment.category ?? "");
  const severity = sanitizeTerminal(comment.severity ?? "");
  if (category !== "" && severity !== "") return `[${category} · ${severity}]`;
  if (category !== "") return `[${category}]`;
  if (severity !== "") return `[${severity}]`;
  return "";
}

export function severityColor(severity: string | undefined): string {
  switch (severity) {
    case "critical":
      return "\u001b[1;91m";
    case "high":
      return "\u001b[91m";
    case "medium":
      return "\u001b[93m";
    case "low":
      return "\u001b[94m";
    default:
      return "\u001b[2m";
  }
}

function printDiffLine(prefix: string, content: string, fgColor: string, bgColor: string): string {
  return `${fgColor}${bgColor}${prefix}\u001b[0m${bgColor} ${content}\u001b[0m\n`;
}

// ---------------------------------------------------------------------------
// Comment rendering — mirrors Go renderComment; returns string
// ---------------------------------------------------------------------------

export function renderComment(comment: LlmComment): string {
  const lines = buildDiffLines(comment);
  if (lines.length === 0 && (comment.content ?? "") === "") return "";
  let out = "";
  out += `\n\u001b[2m─── ${sanitizeTerminal(comment.path)}:${String(comment.startLine ?? 0)}-${String(comment.endLine ?? 0)} ───\u001b[0m\n`;
  if (comment.content !== "") {
    const badge = buildBadge(comment);
    let content = sanitizeTerminal(comment.content);
    if (badge !== "") content = `${badge} ${content}`;
    const wrapped = wrapByRunes(content, 100);
    for (let idx = 0; idx < wrapped.length; idx++) {
      let ln = wrapped[idx] ?? "";
      if (idx === 0 && badge !== "" && ln.startsWith(badge)) {
        const color = severityColor(comment.severity);
        ln = `${color}${badge}\u001b[0m${ln.slice(badge.length)}`;
      }
      out += `${ln}\n`;
    }
    out += "\n";
  }
  if (lines.length > 0) {
    for (const dl of lines) {
      switch (dl.type) {
        case DiffAdded:
          out += printDiffLine("+", sanitizeTerminal(dl.content), "\u001b[92m", "\u001b[48;2;0;60;0m");
          break;
        case DiffDeleted:
          out += printDiffLine("-", sanitizeTerminal(dl.content), "\u001b[91m", "\u001b[48;2;70;0;0m");
          break;
        case DiffContext:
          out += printDiffLine(" ", sanitizeTerminal(dl.content), "\u001b[2m", "\u001b[48;2;38;38;38m");
          break;
      }
    }
  }
  out += "\n";
  return out;
}

// ---------------------------------------------------------------------------
// Text output — mirrors Go outputText / outputTextWithWarnings
// ---------------------------------------------------------------------------

export function outputText(comments: readonly LlmComment[]): string {
  if (comments.length === 0) return "No comments generated. Looks good to me.\n";
  let out = "";
  for (const c of comments) out += renderComment(c);
  return out;
}

export function outputTextWithWarnings(
  comments: readonly LlmComment[],
  warnings: readonly AgentWarning[],
  manifest: RunManifest | null | undefined,
): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";

  if (manifest) {
    stdout += `${manifestMessage(manifest, comments.length)}\n`;
    for (const c of comments) stdout += renderComment(c);
  } else if (comments.length === 0) {
    if (hasSubtaskErrors(warnings)) {
      stdout += "Some files could not be reviewed due to errors (see warnings below).\n";
    } else {
      stdout += "No comments generated. Looks good to me.\n";
    }
  } else {
    for (const c of comments) stdout += renderComment(c);
  }

  for (const w of warnings) {
    if (isSubtaskErrorType(w.type)) continue;
    stderr += `[ocr] WARNING [${w.type}] ${sanitizeTerminal(w.file)}: ${sanitizeTerminal(w.message)}\n`;
  }
  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// JSON types — mirrors Go jsonOutput etc. (field names stay Go-compatible)
// ---------------------------------------------------------------------------

export interface JsonSummary {
  files_reviewed: number;
  comments: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  elapsed: string;
  budget_exceeded?: boolean;
}

export interface JsonToolCalls {
  total: number;
  by_tool: Record<string, number>;
}

export interface JsonLlmIdentity {
  provider?: string;
  model: string;
}

export interface JsonOutput {
  status: string;
  llm?: JsonLlmIdentity;
  trace_id?: string;
  message?: string;
  summary?: JsonSummary;
  tool_calls?: JsonToolCalls;
  comments: LlmComment[];
  warnings?: AgentWarning[];
  project_summary?: string;
  resume?: unknown;
  session_id?: string;
  manifest?: RunManifest;
  retry_report?: unknown;
}

function formatDurationMs(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (rem === 0) return `${String(mins)}m0s`;
  return `${String(mins)}m${String(rem)}s`;
}

export function outputJsonNoFiles(traceId: string, llmIdentity: JsonLlmIdentity | undefined): string {
  const out: JsonOutput = {
    status: "skipped",
    llm: llmIdentity,
    trace_id: traceId,
    message: "No supported files changed.",
    comments: [],
    tool_calls: { total: 0, by_tool: {} },
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function outputJsonWithWarnings(opts: {
  comments: readonly LlmComment[];
  warnings: readonly AgentWarning[];
  filesReviewed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  projectSummary: string;
  toolCalls: Record<string, number>;
  traceId: string;
  resumeInfo: unknown;
  sessionId: string;
  manifest: RunManifest | null | undefined;
  budgetExceeded: boolean;
  llmIdentity: JsonLlmIdentity | undefined;
  retryReport: unknown;
}): string {
  const publishedWarnings = warningsForOutput(opts.warnings, opts.manifest);
  const elapsed = formatDurationMs(opts.durationMs);
  const summary: JsonSummary = {
    files_reviewed: opts.filesReviewed,
    comments: opts.comments.length,
    total_tokens: opts.totalTokens,
    input_tokens: opts.inputTokens,
    output_tokens: opts.outputTokens,
    cache_read_tokens: opts.cacheReadTokens,
    cache_write_tokens: opts.cacheWriteTokens,
    elapsed,
    budget_exceeded: opts.budgetExceeded ? true : undefined,
  };
  if (summary.cache_read_tokens === 0) delete (summary as unknown as Record<string, unknown>)["cache_read_tokens"];
  if (summary.cache_write_tokens === 0) delete (summary as unknown as Record<string, unknown>)["cache_write_tokens"];
  if (!summary.budget_exceeded) delete (summary as unknown as Record<string, unknown>)["budget_exceeded"];

  const byTool = opts.toolCalls ?? {};
  let total = 0;
  for (const v of Object.values(byTool)) total += v;

  const out: JsonOutput = {
    status: "success",
    llm: opts.llmIdentity,
    trace_id: opts.traceId,
    comments: [...opts.comments] as LlmComment[],
    summary,
    project_summary: opts.projectSummary !== "" ? opts.projectSummary : undefined,
    resume: opts.resumeInfo ?? undefined,
    session_id: opts.sessionId !== "" ? opts.sessionId : undefined,
    manifest: opts.manifest ?? undefined,
    retry_report: opts.retryReport ?? undefined,
    tool_calls: { total, by_tool: byTool },
  };

  if (opts.manifest) {
    out.status = opts.manifest.terminalState;
    out.message = manifestMessage(opts.manifest, opts.comments.length);
  } else if (opts.comments.length === 0) {
    if (hasSubtaskErrors(opts.warnings)) {
      out.message = "Some files could not be reviewed due to errors.";
    } else {
      out.message = "No comments generated. Looks good to me.";
    }
  }

  if (publishedWarnings.length > 0) {
    out.warnings = publishedWarnings as AgentWarning[];
    if (!opts.manifest && hasSubtaskErrors(publishedWarnings)) {
      out.status = "completed_with_errors";
    } else if (!opts.manifest) {
      out.status = "completed_with_warnings";
    }
  }

  // Clean empty optionals for parity where Go omits empty strings
  if (!out.trace_id) delete out.trace_id;
  if (!out.llm) delete out.llm;
  if (!out.project_summary) delete out.project_summary;
  if (!out.resume) delete out.resume;
  if (!out.session_id) delete out.session_id;
  if (!out.manifest) delete out.manifest;
  if (!out.retry_report) delete out.retry_report;

  return `${JSON.stringify(out, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Retry report — mirrors Go outputRetryReportText / retryAttemptChain
// ---------------------------------------------------------------------------

export interface RetryAttempt {
  outcome: string;
  errorClass?: string;
  statusCode?: number;
}

export interface RetryRequestReport {
  filePath: string;
  taskType: string;
  requestNo: number;
  attempts: readonly RetryAttempt[];
  outcome: string;
}

export interface RetryReport {
  totalRequests: number;
  retriedRequests: number;
  totalRetries: number;
  recoveredRequests: number;
  failedRequests: number;
  cancelledRequests: number;
  requests: readonly RetryRequestReport[];
}

export function retryAttemptChain(r: RetryRequestReport): string {
  const parts: string[] = [];
  for (const a of r.attempts) {
    if (a.outcome === "success") {
      parts.push("success");
    } else if ((a.statusCode ?? 0) > 0) {
      parts.push(`${String(a.errorClass ?? "")}(${String(a.statusCode)})`);
    } else {
      parts.push(String(a.errorClass ?? a.outcome));
    }
  }
  if (r.outcome === "failed" || (r.outcome === "cancelled" && (parts.length === 0 || parts[parts.length - 1] !== "cancelled"))) {
    parts.push(r.outcome);
  }
  return parts.join(" -> ");
}

export function outputRetryReportText(report: RetryReport | null | undefined): string {
  if (!report) return "";
  let out = "";
  const retryWord = report.totalRetries === 1 ? "retry" : "retries";
  out += `\nLLM retry report: ${String(report.retriedRequests)}/${String(report.totalRequests)} requests retried, ${String(report.totalRetries)} ${retryWord}, ${String(report.recoveredRequests)} recovered, ${String(report.failedRequests)} failed, ${String(report.cancelledRequests)} cancelled\n`;
  for (const r of report.requests) {
    out += `- ${sanitizeTerminal(r.filePath)} / ${sanitizeTerminal(r.taskType)} #${String(r.requestNo)}: ${retryAttemptChain(r)}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failure usage — mirrors Go emitFailureUsage diagnostics
// ---------------------------------------------------------------------------

export function emitFailureUsageText(
  filesReviewed: number,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  toolCalls: Record<string, number>,
  elapsedMs: number,
  budgetExceeded: boolean,
  sessionId: string,
  retryReport: RetryReport | null | undefined,
  outputFormat: string,
  llmIdentity: JsonLlmIdentity | undefined,
): { stdout: string; stderr: string } {
  if (outputFormat === "json") {
    let total = 0;
    for (const v of Object.values(toolCalls)) total += v;
    const summary: JsonSummary = {
      files_reviewed: filesReviewed,
      comments: 0,
      total_tokens: totalTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      elapsed: formatDurationMs(elapsedMs),
      budget_exceeded: budgetExceeded ? true : undefined,
    };
    if (!summary.budget_exceeded) delete (summary as unknown as Record<string, unknown>)["budget_exceeded"];
    const out: JsonOutput = {
      status: "failed",
      llm: llmIdentity,
      summary,
      tool_calls: { total, by_tool: toolCalls },
      comments: [],
      session_id: sessionId !== "" ? sessionId : undefined,
      retry_report: retryReport ?? undefined,
    };
    if (!out.session_id) delete out.session_id;
    if (!out.retry_report) delete out.retry_report;
    return { stdout: "", stderr: `${JSON.stringify(out, null, 2)}\n` };
  }
  let line = `[ocr] usage on failure: ${String(filesReviewed)} file(s), ${String(inputTokens)} input + ${String(outputTokens)} output = ${String(totalTokens)} total tokens, ${String(Object.values(toolCalls).reduce((a, b) => a + b, 0))} tool calls, elapsed ${formatDurationMs(elapsedMs)}, budget_exceeded=${String(budgetExceeded)}`;
  if (sessionId !== "") line += `, session ${sessionId}`;
  let stderr = `${line}\n`;
  stderr += outputRetryReportText(retryReport);
  return { stdout: "", stderr };
}

// ---------------------------------------------------------------------------
// Preview text — mirrors Go outputPreview / outputPreviewText / outputPreviewJSON
// ---------------------------------------------------------------------------

function previewStatusBadge(status: string): string {
  switch (status) {
    case "added":
      return "\u001b[32m[A]\u001b[0m";
    case "modified":
      return "\u001b[33m[M]\u001b[0m";
    case "deleted":
      return "\u001b[31m[D]\u001b[0m";
    case "renamed":
      return "\u001b[36m[R]\u001b[0m";
    case "binary":
      return "\u001b[35m[B]\u001b[0m";
    case "scan":
      return "\u001b[34m[S]\u001b[0m";
    default:
      return "[?]";
  }
}

export function outputPreviewText(p: Preview): string {
  if (p.totalFiles === 0) return "No files changed.\n";
  let maxPathLen = 20;
  for (const e of p.entries) {
    const n = sanitizeTerminal(e.path).length;
    if (n > maxPathLen) maxPathLen = n;
  }
  let out = `\nPreview: ${String(p.totalFiles)} file(s) changed  |  \u001b[32m+${String(p.totalInsertions)}\u001b[0m  \u001b[31m-${String(p.totalDeletions)}\u001b[0m\n`;
  if (p.reviewableCount > 0) {
    out += `\n\u001b[1mWill review (${String(p.reviewableCount)}):\u001b[0m\n`;
    for (const e of p.entries) {
      if (!e.willReview) continue;
      const pathPadded = sanitizeTerminal(e.path).padEnd(maxPathLen, " ");
      out += `  ${previewStatusBadge(e.status)}  ${pathPadded} \u001b[32m+${String(e.insertions).padEnd(4, " ")}\u001b[0m \u001b[31m-${String(e.deletions).padEnd(4, " ")}\u001b[0m\n`;
    }
  }
  if (p.excludedCount > 0) {
    out += `\n\u001b[1mExcluded from review (${String(p.excludedCount)}):\u001b[0m\n`;
    for (const e of p.entries) {
      if (e.willReview) continue;
      const pathPadded = sanitizeTerminal(e.path).padEnd(maxPathLen, " ");
      const reason = sanitizeTerminal(String(e.excludeReason ?? ""));
      out += `  ${previewStatusBadge(e.status)}  ${pathPadded} \u001b[2m(${reason})\u001b[0m\n`;
    }
  }
  out += "\n";
  return out;
}

export function outputPreviewJson(p: Preview): string {
  // Use model/Preview json mapping (files etc.)
  const j = {
    files: p.entries.map((e) => ({
      path: e.path,
      status: e.status,
      insertions: e.insertions,
      deletions: e.deletions,
      will_review: e.willReview,
      ...(e.excludeReason ? { exclude_reason: e.excludeReason } : {}),
    })),
    total_insertions: p.totalInsertions,
    total_deletions: p.totalDeletions,
    total_files: p.totalFiles,
    reviewable_count: p.reviewableCount,
    excluded_count: p.excludedCount,
  };
  return `${JSON.stringify(j, null, 2)}\n`;
}

export function outputPreview(
  p: Preview,
  outputFormat: string,
): { stdout: string; error?: string } {
  if (outputFormat === "sarif") {
    return { stdout: "", error: "--format sarif is not supported with --preview: SARIF output requires completed review findings" };
  }
  if (outputFormat === "json") return { stdout: outputPreviewJson(p) };
  return { stdout: outputPreviewText(p) };
}

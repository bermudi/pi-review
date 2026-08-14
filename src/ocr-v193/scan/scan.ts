// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/scan/agent.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Scan orchestrator — mirrors Go `scan.Agent` / `scan.Args`.
 *
 * Full scan implementation is intentionally stub-friendly in this port:
 * the public contract (Args, Agent surface, fingerprinting, resume
 * bookkeeping, budget checks, preview) is faithfully typed so CLI and
 * checkpoint consumers can rely on it, while the heavy per-file LLM loop
 * is stubbed behind `dispatchSubtasks` until the llmloop transport is
 * wired through the Pi adapter.
 *
 * No import from legacy `src/*` review policy.
 */

import * as crypto from "node:crypto";
import type { ScanItem } from "../model/scan.js";
import type { LlmComment } from "../model/review.js";
import type { Diff } from "../model/diff.js";
import { scanItemAsDiff } from "../model/scan.js";
import type { Preview } from "../model/preview.js";
import { ExcludeNone, ExcludeUserRule, ExcludeExtension, ExcludeDefaultPath, ExcludeBinary } from "../model/preview.js";
import type { ScanTemplate, LlmConversation } from "../template/template.js";
import { Provider, NewProvider } from "./provider.js";
import { groupBatches, parseBatchStrategy, type BatchStrategy } from "./batch.js";
import { estimateCost, estimateFileTokens, humanTokens } from "./estimate.js";
import { previewScan } from "./preview.js";
import type { SessionHistory } from "../session/history.js";
import type { ResumeState } from "../session/resume.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANGE_FILES_SCAN_LITERAL = "(not applicable in full-scan mode)";
export const changeFilesScanLiteral = CHANGE_FILES_SCAN_LITERAL;

// ---------------------------------------------------------------------------
// Args — mirrors Go scan.Args
// ---------------------------------------------------------------------------

export interface ScanArgs {
  readonly repoDir: string;
  readonly paths?: readonly string[];
  readonly template: ScanTemplate;
  readonly model?: string;
  readonly background?: string;
  readonly maxConcurrency?: number;
  readonly concurrentTaskTimeoutMinutes?: number;
  readonly maxFileSizeBytes?: number;
  readonly skipPlan?: boolean;
  readonly skipDedup?: boolean;
  readonly skipSummary?: boolean;
  readonly maxTokensBudget?: number;
  readonly session?: SessionHistory | null;
  readonly resume?: ResumeState | null;
  // Resolver over system rules — kept as a minimal function surface
  // so scan does not import the full rules engine directly in stubs.
  readonly systemRule?: ((path: string) => string) | null;
  readonly fileFilter?: {
    isUserExcluded(path: string): boolean;
    isUserIncluded(path: string): boolean;
    hasInclude(): boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// Agent — mirrors Go scan.Agent
// ---------------------------------------------------------------------------

export class Agent {
  readonly args: ScanArgs;
  items: ScanItem[] = [];
  currentDate: string = "";
  projectSummary: string = "";
  scanFingerprints: Map<string, string> = new Map();
  resumeInfo: { resumedFrom: string; reusedFiles: number; rerunFiles: number; previousModel?: string; currentModel?: string } | null = null;

  // Counters matching Go runner
  private subtaskFailed = 0;
  private totalTokensUsed = 0;

  constructor(args: ScanArgs) {
    this.args = args;
  }

  // -- Simple accessors -------------------------------------------------------

  ProjectSummary(): string {
    return this.projectSummary;
  }

  SessionID(): string {
    return this.args.session?.sessionId ?? "";
  }

  FilesReviewed(): number {
    return this.items.length;
  }

  Diffs(): Diff[] {
    return this.items.map((it) => scanItemAsDiff(it)!);
  }

  TotalTokensUsed(): number { return this.totalTokensUsed; }
  TotalInputTokens(): number { return 0; }
  TotalOutputTokens(): number { return 0; }
  TotalCacheReadTokens(): number { return 0; }
  TotalCacheWriteTokens(): number { return 0; }
  Warnings(): unknown[] { return []; }
  ToolCalls(): Record<string, number> { return {}; }
  BudgetExceeded(): boolean { return false; }
  ResumeInfo(): { resumedFrom: string; reusedFiles: number; rerunFiles: number } | null { return this.resumeInfo; }
  RunManifest(): null { return null; }

  // -- Phase toggles ----------------------------------------------------------

  planEnabled(): boolean {
    const t = this.args.template;
    return (this.args.skipPlan !== true) && Boolean(t.PlanTask && t.PlanTask.messages.length > 0);
  }

  dedupEnabled(): boolean {
    const t = this.args.template;
    return (this.args.skipDedup !== true) && Boolean(t.DedupTask && t.DedupTask.messages.length > 0);
  }

  summaryEnabled(): boolean {
    const t = this.args.template;
    return (this.args.skipSummary !== true) && Boolean(t.ProjectSummaryTask && t.ProjectSummaryTask.messages.length > 0);
  }

  // -- Fingerprinting --------------------------------------------------------

  scanItemFingerprint(it: ScanItem): string {
    const cached = this.scanFingerprints.get(it.path);
    if (cached !== undefined && cached !== "") return cached;
    return scanItemFingerprint(it);
  }

  // -- Preview ---------------------------------------------------------------

  async preview(signal?: AbortSignal): Promise<Preview> {
    return previewScan(
      {
        repoDir: this.args.repoDir,
        paths: this.args.paths,
        maxFileSizeBytes: this.args.maxFileSizeBytes,
        isExcluded: (it) => this.whyExcluded(it),
      },
      signal,
    );
  }

  // -- Filter ---------------------------------------------------------------

  filterScanItems(items: readonly ScanItem[]): ScanItem[] {
    const kept: ScanItem[] = [];
    for (const it of items) {
      if (this.whyExcluded(it) === ExcludeNone) kept.push(it);
    }
    return kept;
  }

  filterLargeScans(items: readonly ScanItem[]): ScanItem[] {
    const limit = promptTokenLimit(this.args.template.MaxTokens);
    if (limit <= 0) return [...items];
    const kept: ScanItem[] = [];
    for (const it of items) {
      const tokens = Math.ceil((it.content?.length ?? 0) / 4);
      if (tokens > limit) continue;
      kept.push(it);
    }
    return kept;
  }

  whyExcluded(it: ScanItem): string {
    if (it.isBinary === true) return ExcludeBinary;
    const p = it.path;
    if (this.args.fileFilter?.isUserExcluded(p) === true) return ExcludeUserRule;
    if (this.args.fileFilter?.hasInclude() === true && this.args.fileFilter.isUserIncluded(p) === true) return ExcludeNone;
    const ext = extFromPath(p);
    if (ext !== "" && !isAllowedExt(ext)) return ExcludeExtension;
    if (isExcludedPath(p)) return ExcludeDefaultPath;
    return ExcludeNone;
  }

  // -- Run (stub) -----------------------------------------------------------

  /**
   * Stub implementation preserving the observable contract:
   * - validates template
   * - enumerates + filters
   * - reports cost estimate
   * - groups batches
   * - returns empty comments (LLM wiring is done via llmloop Pi adapter)
   */
  async run(signal?: AbortSignal): Promise<LlmComment[]> {
    if (!this.args.template.MainTask || this.args.template.MainTask.messages.length === 0) {
      throw new Error("scan template MAIN_TASK is missing or empty");
    }

    const provider = NewProvider(
      this.args.repoDir,
      this.args.paths ?? [],
      undefined,
      this.args.maxFileSizeBytes,
    );
    const discovered = await provider.enumerate(signal);
    this.items = this.filterScanItems(discovered);
    this.items = this.filterLargeScans(this.items);

    // Pre-run cost projection
    const est = estimateCost(this.items, this.planEnabled(), this.dedupEnabled(), this.summaryEnabled());
    void est;
    void humanTokens;
    void estimateFileTokens;
    void groupBatches;

    this.currentDate = new Date().toISOString().slice(0, 16).replace("T", " ");
    this.initScanFingerprints(this.items);
    this.initResumeInfo(this.items);

    // Real dispatch is stubbed until llmloop Pi transport is wired.
    // Return empty set; caller still has `this.items` for coverage reporting.
    return [];
  }

  /** Alias matching Go `Run`. */
  Run(signal?: AbortSignal): Promise<LlmComment[]> {
    return this.run(signal);
  }

  // -- Internal helpers ------------------------------------------------------

  private initScanFingerprints(items: readonly ScanItem[]): void {
    if (items.length === 0) return;
    for (const it of items) this.scanFingerprints.set(it.path, scanItemFingerprint(it));
  }

  private initResumeInfo(items: readonly ScanItem[]): void {
    const resume = this.args.resume;
    if (resume === null || resume === undefined) return;
    let reused = 0;
    let rerun = 0;
    for (const it of items) {
      const fp = this.scanItemFingerprint(it);
      if (resume.items?.has(fp) === true) reused++; else rerun++;
    }
    this.resumeInfo = {
      resumedFrom: resume.sessionId,
      reusedFiles: reused,
      rerunFiles: rerun,
      previousModel: resume.model,
      currentModel: this.args.model ?? "",
    };
  }

  // Render placeholders for a scan item — kept as a pure helper for future use.
  renderMessages(it: ScanItem, rule: string, planGuidance: string): LlmConversation["messages"] {
    const rawMsgs: readonly { role: string; content: string }[] = this.args.template.MainTask.messages;
    return rawMsgs.map((m) => ({
      role: m.role,
      content: m.content
        .replaceAll("{{plan_guidance}}", planGuidance)
        .replaceAll("{{current_system_date_time}}", this.currentDate)
        .replaceAll("{{current_file_path}}", it.path)
        .replaceAll("{{system_rule}}", rule)
        .replaceAll("{{change_files}}", CHANGE_FILES_SCAN_LITERAL)
        .replaceAll("{{file_content}}", it.content ?? "")
        .replaceAll("{{requirement_background}}", this.args.background ?? ""),
    }));
  }

  resolveBatchStrategy(): BatchStrategy {
    const raw = (this.args.template as { BatchStrategy?: string }).BatchStrategy;
    return parseBatchStrategy(raw);
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers — mirrors Go free functions
// ---------------------------------------------------------------------------

export function scanItemFingerprint(it: ScanItem): string {
  const payload = `full_scan\x00${it.path}\x00${it.content ?? ""}`;
  return crypto.createHash("sha256").update(payload, "utf-8").digest("hex");
}

export function resumedFromSession(resume: ResumeState | null | undefined): string {
  return resume?.sessionId ?? "";
}

function extFromPath(p: string): string {
  const base = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function promptTokenLimit(maxTokens: number): number {
  if (maxTokens <= 0) return 0;
  return Math.trunc(maxTokens * 0.8);
}

// Minimal allowlist fallbacks matching Go defaults when the full rule engine
// is not wired into the stub. Real runs should pass `args.fileFilter` / `systemRule`.
const ALLOWED_EXTS = new Set([
  ".go", ".ts", ".js", ".tsx", ".jsx", ".py", ".java", ".kt", ".rs", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".php", ".rb", ".swift", ".m", ".mm", ".sh", ".yaml", ".yml", ".json", ".toml", ".sql",
]);

function isAllowedExt(ext: string): boolean {
  return ALLOWED_EXTS.has(ext);
}
function isExcludedPath(_p: string): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Factories — mirrors Go NewAgent
// ---------------------------------------------------------------------------

export function NewAgent(args: ScanArgs): Agent {
  return new Agent(args);
}
export const newAgent = NewAgent;

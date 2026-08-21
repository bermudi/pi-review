// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/session/resume.go, resume_identity.go, list.go and
// comments.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Resume / resume identity / listing / comment replay — mirrors Go
 * `session.ResumeState` / `ResumeRequest` / `SessionsDir` listing and
 * `LoadComments`.
 *
 * Preserves the observable checkpoint guarantees:
 * - replay of JSONL records keyed by diff fingerprint (done/reused/failed)
 * - manifest-gated reuse (`ReusableItem` consults completed/reused fingerprints)
 * - rejected resumes when input identity or rule/provider identity mismatches
 * - stable per-run lineage (`ResumeLineage`)
 *
 * No import from legacy `src/*` checkpoint code; only parity `model` and
 * `manifest` types. File I/O uses Node `fs` and remains deterministic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LlmComment } from "../model/review.js";
import type { RunManifest, CoverageItem } from "./manifest.js";
import { ManifestSchemaVersion, OperationReview } from "./manifest.js";
import { SessionsDir, SessionFilePath } from "./persist.js";

// ---------------------------------------------------------------------------
// Constants / lineage schema
// ---------------------------------------------------------------------------

export const ResumeLineageSchemaVersion = "ocr.resume-lineage/v1";
export const resumeHint = "start a new review instead of resuming";

// ---------------------------------------------------------------------------
// ResumeState / ResumeItem
// ---------------------------------------------------------------------------

export interface ResumeItem {
  filePath: string;
  oldPath: string;
  newPath: string;
  fingerprint: string;
  comments: LlmComment[];
}

export class ResumeState {
  sessionId: string;
  repoDir: string;
  gitBranch = "";
  model = "";
  reviewMode = "";
  diffFrom = "";
  diffTo = "";
  diffCommit = "";
  scanPaths: string[] = [];
  hasScanPathScope = false;
  items: Map<string, ResumeItem> = new Map();
  manifest: RunManifest | null = null;
  closed = false;
  private reusable: Map<string, boolean> | null = null;

  constructor(sessionId: string, repoDir: string) {
    this.sessionId = sessionId;
    this.repoDir = repoDir;
  }

  get SessionID(): string { return this.sessionId; }
  get RepoDir(): string { return this.repoDir; }
  get GitBranch(): string { return this.gitBranch; }
  get Model(): string { return this.model; }
  get ReviewMode(): string { return this.reviewMode; }
  get DiffFrom(): string { return this.diffFrom; }
  get DiffTo(): string { return this.diffTo; }
  get DiffCommit(): string { return this.diffCommit; }
  get ScanPaths(): string[] { return [...this.scanPaths]; }
  get HasScanPathScope(): boolean { return this.hasScanPathScope; }
  get Manifest(): RunManifest | null { return this.manifest; }
  get Closed(): boolean { return this.closed; }
  get Items(): Map<string, ResumeItem> { return this.items; }

  CompletedCount(): number {
    if ((this as unknown) === null || (this as unknown) === undefined) return 0;
    return this.items.size;
  }

  Item(fingerprint: string): ResumeItem | null {
    if ((this as unknown) === null || (this as unknown) === undefined) return null;
    const it = this.items.get(fingerprint);
    if (it === undefined) return null;
    const clonedComments = copyLlmComments(it.comments);
    return { ...it, comments: clonedComments ?? [] };
  }

  ReusableItem(fingerprint: string): ResumeItem | null {
    if ((this as unknown) === null || (this as unknown) === undefined) return null;
    if (this.manifest === null) return null;
    if (this.reusable === null) this.reusable = manifestReusableFingerprints(this.manifest);
    if (this.reusable.get(fingerprint) !== true) return null;
    return this.Item(fingerprint);
  }

  // -- Validation ------------------------------------------------------------

  ValidateOptions(opts: { reviewMode?: string }): Error | null {
    if ((this as unknown) === null || (this as unknown) === undefined) return null;
    if (opts.reviewMode === undefined || opts.reviewMode === "" || opts.reviewMode === "workspace") {
      return new Error("resume requires --from/--to or --commit; workspace resume is not supported");
    }
    if (this.reviewMode === "") return new Error(`resume session "${this.sessionId}" is missing review mode metadata`);
    if (this.reviewMode !== opts.reviewMode) return new Error(`resume session review mode "${this.reviewMode}" does not match current mode "${opts.reviewMode}"`);
    if (opts.reviewMode !== "range" && opts.reviewMode !== "commit") return new Error(`resume mode "${opts.reviewMode}" is not supported`);
    return null;
  }

  ValidateScanOptions(scanPaths: string[]): Error | null {
    if ((this as unknown) === null || (this as unknown) === undefined) return null;
    if (this.reviewMode === "") return new Error(`resume session "${this.sessionId}" is missing review mode metadata`);
    if (this.reviewMode !== "full_scan") return new Error(`resume session review mode "${this.reviewMode}" does not match current mode "full_scan"`);
    const cur = normalizeScanPaths(scanPaths);
    if (this.hasScanPathScope && !equalStringSlices(this.scanPaths, cur)) {
      return new Error(`resume session scan path scope "${formatScanScope(this.scanPaths)}" does not match current scope "${formatScanScope(cur)}"`);
    }
    return null;
  }

  ValidateResume(req: ResumeRequest): Error | null {
    const err = this.validateInputIdentity(req.identity);
    if (err !== null) return err;
    const m = this.manifest!;
    const providerChanged = (m.execution.provider ?? "") !== req.provider;
    if (providerChanged && !req.providerExplicit) {
      return new Error(`resume rejected: provider changed from "${m.execution.provider ?? ""}" to "${req.provider}" without being asked for; ${explicitFlagHint("--provider", req.provider)} to resume across providers on purpose`);
    }
    if (!providerChanged && (m.execution.model ?? "") !== req.model && !req.modelExplicit) {
      return new Error(`resume rejected: model changed from "${m.execution.model ?? ""}" to "${req.model}" without being asked for; ${explicitFlagHint("--model", req.model)} to resume across models on purpose`);
    }
    return null;
  }

  private validateInputIdentity(id: RunIdentity): Error | null {
    const m = this.manifest;
    if (m === null && !this.closed) return new Error(`resume session "${this.sessionId}" was interrupted before it closed, so it never recorded a run manifest and its input identity cannot be verified; ${resumeHint}`);
    if (m === null) return new Error(`resume session "${this.sessionId}" closed without a run manifest, so its input identity cannot be verified — it either predates run manifests or failed before recording one; ${resumeHint}`);
    if (m.schemaVersion !== ManifestSchemaVersion) return new Error(`resume session "${this.sessionId}" carries manifest schema "${m.schemaVersion}", but this build can only verify "${ManifestSchemaVersion}"; ${resumeHint}`);
    if (m.operation !== OperationReview) return new Error(`resume session "${this.sessionId}" recorded operation "${m.operation}", not "${OperationReview}"; ${resumeHint}`);
    if (m.coverage.selected.length === 0) return new Error(`resume session "${this.sessionId}" selected no input, so it has nothing to resume; ${resumeHint}`);
    if (m.input.mode !== id.mode) return new Error(`resume rejected: input mode changed from "${m.input.mode}" to "${id.mode}"; ${resumeHint}`);
    if ((m.repository.identitySha256 ?? "") !== (id.repositorySha256 ?? "")) return new Error(`resume rejected: repository identity changed, so this is not the repository the parent run reviewed; ${resumeHint}`);
    if ((m.input.sourceArtifactSha256 ?? "") !== (id.sourceArtifactSha256 ?? "")) return new Error(`resume rejected: the reviewed input changed since session "${this.sessionId}" — a ref may now point at a different commit, or the selected file set changed; ${resumeHint}`);
    if ((m.execution.ruleConfigSha256 ?? "") === "") return new Error(`resume session "${this.sessionId}" recorded no rule identity, so it cannot be verified against the current rules; ${resumeHint}`);
    if (m.execution.ruleConfigSha256 !== id.ruleConfigSha256) return new Error(`resume rejected: review rule identity changed — either a rule text layer (custom, project, global or system) or the include/exclude file filter differs from session "${this.sessionId}"; ${resumeHint}`);
    return null;
  }

  // -- Record replay ---------------------------------------------------------

  ApplyResumeLine(line: string): Error | null {
    return this.applyResumeLine(line);
  }

  applyResumeLine(line: string): Error | null {
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
    const type = String(rec["type"] ?? "");
    switch (type) {
      case "session_start": this.applySessionStart(rec); break;
      case "review_item_done":
      case "review_item_reused": {
        const fp = String(rec["fingerprint"] ?? "");
        if (fp === "") return null;
        const filePath = (String(rec["filePath"] ?? "") !== "" ? String(rec["filePath"]) : String(rec["newPath"] ?? ""));
        const rawComments = rec["comments"];
        const comments: LlmComment[] = Array.isArray(rawComments) ? (rawComments as LlmComment[]) : [];
        const storedComments = copyLlmComments(comments) ?? [];
        this.items.set(fp, { filePath, oldPath: String(rec["oldPath"] ?? ""), newPath: String(rec["newPath"] ?? ""), fingerprint: fp, comments: storedComments });
        break;
      }
      case "review_item_failed": {
        const fp = String(rec["fingerprint"] ?? "");
        if (fp !== "") this.items.delete(fp);
        break;
      }
      case "session_end": {
        this.closed = true;
        const mf = rec["run_manifest"] as RunManifest | undefined | null;
        if (mf !== null && mf !== undefined) this.manifest = mf;
        break;
      }
      default: break;
    }
    return null;
  }

  applySessionStart(rec: Record<string, unknown>): void {
    if (typeof rec["sessionId"] === "string" && rec["sessionId"] !== "") this.sessionId = rec["sessionId"] as string;
    if (typeof rec["cwd"] === "string" && rec["cwd"] !== "") this.repoDir = rec["cwd"] as string;
    if (typeof rec["gitBranch"] === "string") this.gitBranch = rec["gitBranch"] as string;
    if (typeof rec["model"] === "string") this.model = rec["model"] as string;
    if (typeof rec["reviewMode"] === "string") this.reviewMode = rec["reviewMode"] as string;
    if (typeof rec["diffFrom"] === "string") this.diffFrom = rec["diffFrom"] as string;
    if (typeof rec["diffTo"] === "string") this.diffTo = rec["diffTo"] as string;
    if (typeof rec["diffCommit"] === "string") this.diffCommit = rec["diffCommit"] as string;
    if (rec["scanPaths"] !== undefined) {
      this.scanPaths = normalizeScanPaths(rec["scanPaths"] as unknown as string[]);
      this.hasScanPathScope = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Run identity / resume request — mirrors Go resume_identity.go
// ---------------------------------------------------------------------------

export interface RunIdentity {
  mode: string;
  sourceArtifactSha256?: string;
  ruleConfigSha256?: string;
  repositorySha256?: string;
}

export interface ResumeRequest {
  identity: RunIdentity;
  provider: string;
  model: string;
  providerExplicit: boolean;
  modelExplicit: boolean;
}

export function explicitFlagHint(flag: string, value: string): string {
  if (value === "") return `pass ${flag} <name> explicitly`;
  return `pass ${flag} ${value}`;
}

// ---------------------------------------------------------------------------
// ResumeLineage — mirrors Go session.ResumeLineage
// ---------------------------------------------------------------------------

export interface ResumeLineage {
  type: string;
  schemaVersion: string;
  runId: string;
  parentRunId: string;
  sourceProvider: string;
  sourceModel: string;
  targetProvider: string;
  targetModel: string;
}

export function NewResumeLineage(
  parent: ResumeState | null | undefined,
  runId: string,
  targetProvider: string,
  targetModel: string,
): ResumeLineage | null {
  if (parent === null || parent === undefined || parent.manifest === null) return null;
  return {
    type: "resume_lineage",
    schemaVersion: ResumeLineageSchemaVersion,
    runId,
    parentRunId: parent.manifest.runId,
    sourceProvider: parent.manifest.execution.provider ?? "",
    sourceModel: parent.manifest.execution.model ?? "",
    targetProvider,
    targetModel,
  };
}

export function isResumeTransition(l: ResumeLineage | null | undefined): boolean {
  if (l === null || l === undefined) return false;
  return l.sourceProvider !== l.targetProvider || l.sourceModel !== l.targetModel;
}

// ---------------------------------------------------------------------------
// Loading — mirrors Go LoadResumeState / LoadReviewResumeState
// ---------------------------------------------------------------------------

export function LoadResumeState(repoDir: string, sessionId: string, skipUnparseable = false): ResumeState {
  const fp = SessionFilePath(repoDir, sessionId);
  const text = fs.readFileSync(fp, "utf-8");
  const state = new ResumeState(sessionId, repoDir);
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const err = state.applyResumeLine(line);
    if (err !== null && !skipUnparseable) throw err;
  }
  return state;
}

export function LoadReviewResumeState(repoDir: string, sessionId: string): ResumeState {
  return LoadResumeState(repoDir, sessionId, true);
}

// ---------------------------------------------------------------------------
// Listing — mirrors Go ListSessions / LoadSummary / LoadDetail
// ---------------------------------------------------------------------------

export interface Summary {
  sessionId: string;
  filePath: string;
  repoDir: string;
  gitBranch?: string;
  model?: string;
  reviewMode?: string;
  diffFrom?: string;
  diffTo?: string;
  diffCommit?: string;
  resumedFrom?: string;
  startTime: Date | null;
  endTime: Date | null;
  durationMs: number | null;
  selectedFiles: number;
  completedFiles: number;
  failedFiles: number;
  reusedFiles: number;
  waivedFiles: number;
  totalComments: number;
  llmFailures: number;
  aborted: boolean;
  legacy: boolean;
  runManifest: RunManifest | null;
  resumeLineage: ResumeLineage | null;
}

export interface ItemDetail {
  type: string;
  timestamp: Date | null;
  filePath: string;
  oldPath?: string;
  newPath?: string;
  fingerprint?: string;
  comments: number;
  sourceSessionId?: string;
  error?: string;
}

export function ListSessions(repoDir: string): Summary[] {
  const dir = SessionsDir(repoDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err !== null && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") return [];
    throw new Error(`read sessions dir "${dir}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const out: Summary[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue;
    const sessionId = entry.name.slice(0, -".jsonl".length);
    const fp = path.join(dir, entry.name);
    const s = loadSummaryFromFile(fp, sessionId, repoDir);
    if (s !== null) out.push(s);
  }
  out.sort((a, b) => {
    const ta = a.startTime?.getTime() ?? 0;
    const tb = b.startTime?.getTime() ?? 0;
    return tb - ta;
  });
  return out;
}

export function LoadSummary(repoDir: string, sessionId: string): Summary {
  const fp = SessionFilePath(repoDir, sessionId);
  const s = loadSummaryFromFile(fp, sessionId, repoDir);
  if (s === null) throw new Error(`open session "${fp}": not found`);
  return s;
}

export function LoadDetail(repoDir: string, sessionId: string): { summary: Summary; items: ItemDetail[] } {
  const fp = SessionFilePath(repoDir, sessionId);
  const text = fs.readFileSync(fp, "utf-8");
  const summary: Summary = emptySummary(sessionId, fp, repoDir);
  const items: ItemDetail[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    applyRecordToSummary(summary, rec);
    const item = recordToItem(rec);
    if (item !== null) items.push(item);
  }
  return { summary, items };
}

// ---------------------------------------------------------------------------
// Comments — mirrors Go session.LoadComments
// ---------------------------------------------------------------------------

export function LoadComments(repoDir: string, sessionId: string): LlmComment[] {
  const fp = SessionFilePath(repoDir, sessionId);
  let text: string;
  try { text = fs.readFileSync(fp, "utf-8"); } catch { throw new Error(`open session "${fp}": not found`); }
  type Group = { comments: LlmComment[] };
  const order: Group[] = [];
  const byFingerprint = new Map<string, Group>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = String(rec["type"] ?? "");
    if (type === "review_item_done" || type === "review_item_reused") {
      const raw = rec["comments"];
      const comments: LlmComment[] = Array.isArray(raw) ? (raw as LlmComment[]).map((c) => ({ ...(c as object) } as LlmComment)) : [];
      const filePath = String(rec["filePath"] ?? rec["newPath"] ?? "");
      for (const c of comments) if ((c as { path?: string }).path === undefined || (String((c as { path?: string }).path) === "")) (c as { path: string }).path = filePath;
      const fp2 = String(rec["fingerprint"] ?? "");
      if (fp2 !== "" && byFingerprint.has(fp2)) {
        byFingerprint.get(fp2)!.comments = comments;
        continue;
      }
      const g: Group = { comments };
      order.push(g);
      if (fp2 !== "") byFingerprint.set(fp2, g);
    } else if (type === "review_item_failed") {
      const fp2 = String(rec["fingerprint"] ?? "");
      const g = byFingerprint.get(fp2);
      if (g !== undefined) g.comments = [];
    }
  }
  return order.flatMap((g) => g.comments);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadSummaryFromFile(fp: string, sessionId: string, repoDir: string): Summary | null {
  let text: string;
  try { text = fs.readFileSync(fp, "utf-8"); } catch { return null; }
  const s = emptySummary(sessionId, fp, repoDir);
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    applyRecordToSummary(s, rec);
  }
  return s;
}

function emptySummary(sessionId: string, filePath: string, repoDir: string): Summary {
  return {
    sessionId,
    filePath,
    repoDir,
    startTime: null,
    endTime: null,
    durationMs: null,
    selectedFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    reusedFiles: 0,
    waivedFiles: 0,
    totalComments: 0,
    llmFailures: 0,
    aborted: true,
    legacy: false,
    runManifest: null,
    resumeLineage: null,
  };
}

function applyRecordToSummary(s: Summary, rec: Record<string, unknown>): void {
  const type = String(rec["type"] ?? "");
  const tsRaw = String(rec["timestamp"] ?? "");
  const ts = parseTime(tsRaw);
  switch (type) {
    case "session_start": {
      if (typeof rec["sessionId"] === "string" && rec["sessionId"] !== "") s.sessionId = rec["sessionId"] as string;
      if (typeof rec["cwd"] === "string" && rec["cwd"] !== "") s.repoDir = rec["cwd"] as string;
      if (typeof rec["gitBranch"] === "string") s.gitBranch = rec["gitBranch"] as string;
      if (typeof rec["model"] === "string") s.model = rec["model"] as string;
      if (typeof rec["reviewMode"] === "string") s.reviewMode = rec["reviewMode"] as string;
      if (typeof rec["diffFrom"] === "string") s.diffFrom = rec["diffFrom"] as string;
      if (typeof rec["diffTo"] === "string") s.diffTo = rec["diffTo"] as string;
      if (typeof rec["diffCommit"] === "string") s.diffCommit = rec["diffCommit"] as string;
      if (typeof rec["resumedFrom"] === "string") s.resumedFrom = rec["resumedFrom"] as string;
      if (ts !== null) s.startTime = ts;
      break;
    }
    case "resume_lineage": {
      const sv = String(rec["schema_version"] ?? "");
      if (sv !== ResumeLineageSchemaVersion) return;
      s.resumeLineage = {
        type,
        schemaVersion: sv,
        runId: String(rec["run_id"] ?? ""),
        parentRunId: String(rec["parent_run_id"] ?? ""),
        sourceProvider: String(rec["source_provider"] ?? ""),
        sourceModel: String(rec["source_model"] ?? ""),
        targetProvider: String(rec["target_provider"] ?? ""),
        targetModel: String(rec["target_model"] ?? ""),
      };
      break;
    }
    case "review_item_done": s.completedFiles++; s.totalComments += countComments(rec["comments"]); break;
    case "review_item_reused": s.reusedFiles++; s.totalComments += countComments(rec["comments"]); break;
    case "review_item_failed": s.failedFiles++; break;
    case "session_end": {
      s.aborted = false;
      const mf = rec["run_manifest"] as RunManifest | undefined | null;
      if (mf !== null && mf !== undefined && mf.schemaVersion === ManifestSchemaVersion) {
        s.runManifest = mf;
        s.selectedFiles = mf.coverage.selected.length;
        s.completedFiles = mf.coverage.completed.length;
        s.reusedFiles = mf.coverage.reused.length;
        s.failedFiles = mf.coverage.failed.length;
        s.waivedFiles = mf.coverage.waived.length;
      } else {
        s.legacy = true;
        const filesReviewed = rec["files_reviewed"] as unknown;
        if (s.completedFiles === 0 && s.reusedFiles === 0 && s.failedFiles === 0 && Array.isArray(filesReviewed) && filesReviewed.length > 0) s.completedFiles = filesReviewed.length;
        s.selectedFiles = s.completedFiles + s.reusedFiles + s.failedFiles;
      }
      if (ts !== null) s.endTime = ts;
      const dur = typeof rec["duration_seconds"] === "number" ? (rec["duration_seconds"] as number) : null;
      if (dur !== null && dur > 0) s.durationMs = Math.round(dur * 1000);
      else if (s.endTime !== null && s.startTime !== null) s.durationMs = s.endTime.getTime() - s.startTime.getTime();
      if (typeof rec["llm_failures"] === "number") s.llmFailures = rec["llm_failures"] as number;
      break;
    }
    default: break;
  }
}

function recordToItem(rec: Record<string, unknown>): ItemDetail | null {
  const type = String(rec["type"] ?? "");
  if (type !== "review_item_done" && type !== "review_item_reused" && type !== "review_item_failed") return null;
  const kind = type.replace("review_item_", "");
  const filePath = String(rec["filePath"] ?? rec["newPath"] ?? "");
  const tsRaw = String(rec["timestamp"] ?? "");
  return {
    type: kind,
    timestamp: parseTime(tsRaw),
    filePath,
    oldPath: typeof rec["oldPath"] === "string" ? (rec["oldPath"] as string) : undefined,
    newPath: typeof rec["newPath"] === "string" ? (rec["newPath"] as string) : undefined,
    fingerprint: typeof rec["fingerprint"] === "string" ? (rec["fingerprint"] as string) : undefined,
    comments: countComments(rec["comments"]),
    sourceSessionId: typeof rec["sourceSessionId"] === "string" ? (rec["sourceSessionId"] as string) : undefined,
    error: typeof rec["error"] === "string" ? (rec["error"] as string) : undefined,
  };
}

function countComments(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}

function parseTime(s: string): Date | null {
  if (s === "") return null;
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? null : t;
}

function parseRecordTime(s: string): Date | null {
  return parseTime(s);
}

function manifestReusableFingerprints(m: RunManifest): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const group of [m.coverage.completed, m.coverage.reused] as CoverageItem[][]) {
    for (const item of group) if (item.fingerprint !== undefined && item.fingerprint !== "") out.set(item.fingerprint, true);
  }
  return out;
}

function normalizeScanPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let p of paths as unknown[]) {
    p = String(p).trim();
    if (String(p).startsWith("./")) p = String(p).slice(2);
    p = String(p).replaceAll("\\", "/").replace(/\/*$/g, "");
    if (p === "") continue;
    if (seen.has(String(p))) continue;
    seen.add(String(p));
    out.push(String(p));
  }
  out.sort();
  return out;
}

function equalStringSlices(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function formatScanScope(paths: string[]): string {
  if (paths.length === 0) return "<whole repo>";
  return paths.join(",");
}

export function copyLlmComments(comments: LlmComment[] | null | undefined): LlmComment[] | null {
  if (comments === null || comments === undefined || comments.length === 0) return null;
  return comments.map((c) => ({ ...c }));
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/session/history.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Session history — mirrors Go `session.SessionHistory` / `FileSession` / `TaskRecord`.
 *
 * Preserves the observable checkpoint guarantees (per-file sessions, task
 * records, token usage, LLM failure counting, finalize semantics) while
 * stubbing the actual JSONL persistence behind an in-memory seam. The real
 * writer lives in `persist.ts`; this file owns only the domain types and
 * the in-memory coordination so unit tests can run without filesystem I/O.
 */

import type { LlmComment } from "../model/review.js";
import type { ManifestBuilder, RunManifest } from "./manifest.js";

// ---------------------------------------------------------------------------
// TaskType — mirrors Go constants
// ---------------------------------------------------------------------------

export type TaskType =
  | "plan_task"
  | "main_task"
  | "memory_compression_task"
  | "re_location_task"
  | "review_filter_task";

export const PlanTask: TaskType = "plan_task";
export const MainTask: TaskType = "main_task";
export const MemoryCompressionTask: TaskType = "memory_compression_task";
export const ReLocationTask: TaskType = "re_location_task";
export const ReviewFilterTask: TaskType = "review_filter_task";

// ---------------------------------------------------------------------------
// Review modes — mirrors Go constants
// ---------------------------------------------------------------------------

export const ReviewModeWorkspace = "workspace";
export const ReviewModeRange = "range";
export const ReviewModeCommit = "commit";
export const ReviewModeFullScan = "full_scan";

// ---------------------------------------------------------------------------
// Sub-records
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ResponseRecord {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  model: string;
  usage?: TokenUsage;
}

export interface ToolResultRecord {
  toolName: string;
  arguments: string;
  result: string;
}

export interface Message {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolCalls?: unknown[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SessionOptions {
  reviewMode?: string;
  diffFrom?: string;
  diffTo?: string;
  diffCommit?: string;
  scanPaths?: string[];
  resumedFrom?: string;
  operation?: string;
}

export interface ResumeInfo {
  resumedFrom: string;
  reusedFiles: number;
  rerunFiles: number;
  previousModel?: string;
  currentModel?: string;
}

// ---------------------------------------------------------------------------
// SessionHistory
// ---------------------------------------------------------------------------

export class SessionHistory {
  readonly sessionId: string;
  readonly repoDir: string;
  gitBranch: string;
  model: string;
  reviewMode: string;
  diffFrom: string;
  diffTo: string;
  diffCommit: string;
  scanPaths: string[];
  resumedFrom: string;
  startTime: Date;
  endTime: Date | null = null;

  fileSessions: Map<string, FileSession> = new Map();
  llmFailures = 0;

  manifest: ManifestBuilder | null = null;
  finalManifest: RunManifest | null = null;
  persistInitErr: Error | null = null;
  private finalizeOnce = false;
  private finalizeErr: Error | null = null;
  persist: PersistHandle | null = null;

  constructor(
    repoDir: string,
    gitBranch: string,
    model: string,
    opts: SessionOptions = {},
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? generateUUID();
    this.repoDir = repoDir;
    this.gitBranch = gitBranch;
    this.model = model;
    this.reviewMode = opts.reviewMode ?? "";
    this.diffFrom = opts.diffFrom ?? "";
    this.diffTo = opts.diffTo ?? "";
    this.diffCommit = opts.diffCommit ?? "";
    this.scanPaths = [...(opts.scanPaths ?? [])];
    this.resumedFrom = opts.resumedFrom ?? "";
    this.startTime = new Date();
  }

  get SessionID(): string { return this.sessionId; }
  get RepoDir(): string { return this.repoDir; }
  get GitBranch(): string { return this.gitBranch; }
  get Model(): string { return this.model; }
  get ReviewMode(): string { return this.reviewMode; }
  get StartTime(): Date { return this.startTime; }
  get EndTime(): Date | null { return this.endTime; }

  Manifest(): ManifestBuilder | null { return this.manifest; }

  SetFinalManifest(m: RunManifest | null): void {
    if (m === null || m === undefined) return;
    this.finalManifest = m;
  }

  FinalManifest(): RunManifest | null {
    return this.finalManifest ? { ...this.finalManifest } : null;
  }

  HasPersistence(): boolean {
    return this.persist !== null;
  }

  GetOrCreateFileSession(filePath: string): FileSession {
    let fs = this.fileSessions.get(filePath);
    if (fs === undefined) {
      fs = new FileSession(filePath, this);
      this.fileSessions.set(filePath, fs);
    }
    return fs;
  }

  RecordReviewItemDone(
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    comments: LlmComment[],
  ): void {
    if (filePath === "" ) filePath = newPath;
    if (filePath !== "") this.GetOrCreateFileSession(filePath);
    this.persist?.writeReviewItemDone(filePath, oldPath, newPath, fingerprint, comments);
  }

  RecordReviewItemReused(
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    sourceSessionId: string,
    comments: LlmComment[],
  ): void {
    if (filePath === "") filePath = newPath;
    if (filePath !== "") this.GetOrCreateFileSession(filePath);
    this.persist?.writeReviewItemReused(filePath, oldPath, newPath, fingerprint, sourceSessionId, comments);
  }

  RecordResumeLineage(l: import("./resume.js").ResumeLineage | null | undefined): void {
    if (l === null || l === undefined) return;
    this.persist?.writeResumeLineage(l);
  }

  RecordReviewItemFailed(
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    errorMsg: string,
  ): void {
    if (filePath === "") filePath = newPath;
    if (filePath !== "") this.GetOrCreateFileSession(filePath);
    this.persist?.writeReviewItemFailed(filePath, oldPath, newPath, fingerprint, errorMsg);
  }

  LLMFailures(): number { return this.llmFailures; }

  Finalize(): Error | null {
    if (this.finalizeOnce) return this.finalizeErr;
    this.finalizeOnce = true;
    this.endTime = new Date();
    if (this.persistInitErr !== null) {
      this.finalizeErr = this.persistInitErr;
      return this.finalizeErr;
    }
    if (this.persist !== null) {
      const filesReviewed = [...this.fileSessions.keys()];
      const durationMs = this.endTime.getTime() - this.startTime.getTime();
      const err = this.persist.writeSessionEnd(durationMs, filesReviewed, this.llmFailures, this.finalManifest);
      this.finalizeErr = err;
      return err;
    }
    return null;
  }

  // Test seam — attach an in-memory persist handle
  _attachPersist(handle: PersistHandle | null): void {
    this.persist = handle;
  }
  _setPersistInitErr(err: Error | null): void {
    this.persistInitErr = err;
  }
}

export type PersistHandle = {
  writeReviewItemDone(filePath: string, oldPath: string, newPath: string, fingerprint: string, comments: LlmComment[]): void;
  writeReviewItemReused(filePath: string, oldPath: string, newPath: string, fingerprint: string, sourceSessionId: string, comments: LlmComment[]): void;
  writeReviewItemFailed(filePath: string, oldPath: string, newPath: string, fingerprint: string, errorMsg: string): void;
  writeResumeLineage(l: import("./resume.js").ResumeLineage): void;
  writeSessionEnd(durationMs: number, filesReviewed: string[], llmFailures: number, manifest: RunManifest | null): Error | null;
  writeLLMRequest(filePath: string, taskType: TaskType, requestNo: number, messages: unknown): void;
  writeLLMResponse(filePath: string, taskType: TaskType, content: string, toolCalls: Array<Record<string, unknown>>, model: string, usage: TokenUsage, durationMs: number): void;
  writeLLMError(filePath: string, taskType: TaskType, requestNo: number, errorMsg: string, durationMs: number): void;
  writeToolCall(filePath: string, taskType: TaskType, toolName: string, args: string, result: string, ok: boolean, durationMs: number): void;
};

export function New(
  repoDir: string,
  gitBranch: string,
  model: string,
  opts: SessionOptions = {},
): SessionHistory {
  return new SessionHistory(repoDir, gitBranch, model, opts);
}
export const NewSessionHistory = New;

// ---------------------------------------------------------------------------
// FileSession
// ---------------------------------------------------------------------------

export class FileSession {
  readonly filePath: string;
  taskRecords: Map<TaskType, TaskRecord[]> = new Map();
  session: SessionHistory;

  constructor(filePath: string, session: SessionHistory) {
    this.filePath = filePath;
    this.session = session;
  }

  get FilePath(): string { return this.filePath; }

  AppendTaskRecord(taskType: TaskType, messages: Message[]): TaskRecord {
    const existing = this.taskRecords.get(taskType) ?? [];
    const rec = new TaskRecord(taskType, existing.length + 1, [...messages], this);
    existing.push(rec);
    this.taskRecords.set(taskType, existing);
    // Mirror Go: write llm_request immediately so a killed run leaves an orphan request that resume can ignore
    (this.session as unknown as { persist: PersistHandle | null }).persist?.writeLLMRequest(this.filePath, taskType, rec.requestNo, messages.map((m) => ({ ...m })));
    return rec;
  }
}

// ---------------------------------------------------------------------------
// TaskRecord
// ---------------------------------------------------------------------------

export class TaskRecord {
  readonly type: TaskType;
  readonly requestNo: number;
  requestMessages: Message[];
  response: ResponseRecord | null = null;
  toolResults: ToolResultRecord[] = [];
  durationMs = 0;
  error: string | null = null;
  fileSession: FileSession;

  constructor(type: TaskType, requestNo: number, messages: Message[], fileSession: FileSession) {
    this.type = type;
    this.requestNo = requestNo;
    this.requestMessages = messages.map((m) => ({ ...m }));
    this.fileSession = fileSession;
  }

  SetResponse(resp: { content?: string; toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>; model?: string; usage?: TokenUsage } | null, durationMs: number): void {
    if (resp === null || resp === undefined) {
      this.SetError(new Error("empty response"), durationMs);
      return;
    }
    const toolCalls = (resp.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
    this.response = {
      content: resp.content ?? "",
      toolCalls,
      model: resp.model ?? "",
      usage: resp.usage,
    };
    this.durationMs = durationMs;
    // Persist llm_response (mirror Go: WriteLLMResponse after setting response)
    const sess = this.fileSession?.session as unknown as { persist: PersistHandle | null } | undefined;
    sess?.persist?.writeLLMResponse(this.fileSession.filePath, this.type, resp.content ?? "", toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })), resp.model ?? "", resp.usage ?? { promptTokens: 0, completionTokens: 0 }, durationMs);
  }

  SetError(err: Error | string, durationMs: number): void {
    this.error = typeof err === "string" ? err : err.message;
    this.durationMs = durationMs;
    const sess2 = this.fileSession?.session as unknown as { persist: PersistHandle | null; llmFailures: number } | undefined;
    sess2?.persist?.writeLLMError(this.fileSession.filePath, this.type, this.requestNo, this.error, durationMs);
    if (this.fileSession?.session) this.fileSession.session.llmFailures++;
  }

  AddToolResult(toolName: string, args: string, result: string): void {
    this.toolResults.push({ toolName, arguments: args, result });
    const sess3 = this.fileSession?.session as unknown as { persist: PersistHandle | null } | undefined;
    sess3?.persist?.writeToolCall(this.fileSession.filePath, this.type, toolName, args, result, true, 0);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateUUID(): string {
  const b = cryptoRandomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function cryptoRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // Best-effort without Node crypto: Math.random fallback for test environments
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cryptoNode = globalThis.crypto as Crypto | undefined;
    if (cryptoNode?.getRandomValues !== undefined) {
      cryptoNode.getRandomValues(out);
      return out;
    }
  } catch {}
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

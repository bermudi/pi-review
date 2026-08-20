// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/session/persist.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * JSONL persistence for session records — mirrors Go `session.jsonlWriter`.
 *
 * Each session streams records to
 *   `~/.opencodereview/sessions/<encoded-repo>/<sessionId>.jsonl`
 * in JSON Lines form, chained via `parentUuid`. This port preserves the
 * observable contract (single session_end, run_manifest embedding, chained
 * parent UUID, atomic flushed writes) while implementing the actual I/O with
 * Node `fs`/`os` so tests remain deterministic without shelling to git.
 *
 * Complex writer paths are stub-friendly: the class exposes the same
 * Write* surface the history writer calls; internals may be an in-memory
 * buffer in unit tests (via `createMemoryWriter`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { LlmComment } from "../model/review.js";
import type { RunManifest } from "./manifest.js";
import type { TaskType } from "./history.js";
import type { ResumeLineage } from "./resume.js";

export const sessionSubDir = "sessions";

// ---------------------------------------------------------------------------
// Path helpers — mirrors Go encodeRepoPath / SessionFilePath / SessionsDir
// ---------------------------------------------------------------------------

export function encodeRepoPath(p: string): string {
  if (p === "" ) return "empty";
  let vol = "";
  // Detect Windows drive like C:
  const m = /^[a-zA-Z]:/.exec(p);
  if (m !== null) {
    vol = m[0]!.replaceAll(":", "_");
    p = p.slice(2);
  }
  p = p.replaceAll(/^[\\/]+/g, "");
  p = p.replaceAll("/", "-").replaceAll("\\", "-");
  const result = vol + p;
  return result === "" ? "empty" : result;
}

export function SessionsDir(repoDir: string): string {
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, ".opencodereview", sessionSubDir, encodeRepoPath(repoDir));
}

export function SessionFilePath(repoDir: string, sessionId: string): string {
  if (sessionId === "") throw new Error("session id is required");
  return path.join(SessionsDir(repoDir), `${sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// JsonlWriter
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export class JsonlWriter {
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

  private fd: number | null = null;
  private filePath: string | null = null;
  private lastUUID: string | null = null;

  constructor(
    sessionId: string,
    repoDir: string,
    gitBranch: string,
    model: string,
    opts: { reviewMode?: string; diffFrom?: string; diffTo?: string; diffCommit?: string; scanPaths?: string[]; resumedFrom?: string } = {},
  ) {
    this.sessionId = sessionId;
    this.repoDir = repoDir;
    this.gitBranch = gitBranch;
    this.model = model;
    this.reviewMode = opts.reviewMode ?? "";
    this.diffFrom = opts.diffFrom ?? "";
    this.diffTo = opts.diffTo ?? "";
    this.diffCommit = opts.diffCommit ?? "";
    this.scanPaths = [...(opts.scanPaths ?? [])];
    this.resumedFrom = opts.resumedFrom ?? "";
  }

  open(): void {
    const dir = SessionsDir(this.repoDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fp = SessionFilePath(this.repoDir, this.sessionId);
    this.filePath = fp;
    this.fd = fs.openSync(fp, "w", 0o600);
    this.lastUUID = null;
  }

  close(): void {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch {}
      this.fd = null;
    }
  }

  private writeRecord(rec: Record<string, unknown>): void {
    const line = JSON.stringify(rec) + "\n";
    if (this.fd !== null) {
      fs.writeSync(this.fd, line, null, "utf-8");
    } else {
      // Memory-mode fallback: not reached when attached to real history
      void line;
    }
  }

  private newUUID(): string {
    // Delegate to compact uuid; avoid importing history's generator to keep dependency minimal
    const bytes = new Uint8Array(16);
    try {
      globalThis.crypto?.getRandomValues(bytes);
    } catch {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  WriteSessionStart(startTime: Date): string {
    const uuid = this.newUUID();
    const rec: Record<string, unknown> = {
      uuid,
      parentUuid: null,
      type: "session_start",
      sessionId: this.sessionId,
      timestamp: startTime.toISOString(),
      cwd: this.repoDir,
      gitBranch: this.gitBranch,
      model: this.model,
    };
    if (this.reviewMode !== "") rec["reviewMode"] = this.reviewMode;
    if (this.diffFrom !== "") rec["diffFrom"] = this.diffFrom;
    if (this.diffTo !== "") rec["diffTo"] = this.diffTo;
    if (this.diffCommit !== "") rec["diffCommit"] = this.diffCommit;
    if (this.reviewMode === "full_scan") rec["scanPaths"] = [...this.scanPaths];
    if (this.resumedFrom !== "") rec["resumedFrom"] = this.resumedFrom;
    this.writeRecord(rec);
    this.lastUUID = uuid;
    return uuid;
  }

  private writeReviewItemRecord(
    recordType: string,
    filePath: string,
    oldPath: string,
    newPath: string,
    fingerprint: string,
    sourceSessionId: string,
    errorMsg: string,
    comments: LlmComment[],
  ): string {
    const uuid = this.newUUID();
    const rec: Record<string, unknown> = {
      uuid,
      parentUuid: this.lastUUID,
      type: recordType,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      filePath,
      oldPath,
      newPath,
      fingerprint,
      model: this.model,
    };
    if (comments.length > 0) rec["comments"] = comments;
    if (sourceSessionId !== "") rec["sourceSessionId"] = sourceSessionId;
    if (errorMsg !== "") rec["error"] = errorMsg;
    this.writeRecord(rec);
    this.lastUUID = uuid;
    return uuid;
  }

  WriteReviewItemDone(filePath: string, oldPath: string, newPath: string, fingerprint: string, comments: LlmComment[]): string {
    return this.writeReviewItemRecord("review_item_done", filePath, oldPath, newPath, fingerprint, "", "", comments);
  }

  WriteReviewItemReused(filePath: string, oldPath: string, newPath: string, fingerprint: string, sourceSessionId: string, comments: LlmComment[]): string {
    return this.writeReviewItemRecord("review_item_reused", filePath, oldPath, newPath, fingerprint, sourceSessionId, "", comments);
  }

  WriteReviewItemFailed(filePath: string, oldPath: string, newPath: string, fingerprint: string, errorMsg: string): string {
    return this.writeReviewItemRecord("review_item_failed", filePath, oldPath, newPath, fingerprint, "", errorMsg, []);
  }

  WriteLLMRequest(filePath: string, taskType: TaskType, requestNo: number, messages: unknown): string {
    const uuid = this.newUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: "llm_request",
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      filePath,
      taskType: String(taskType),
      request_no: requestNo,
      messages,
    });
    this.lastUUID = uuid;
    return uuid;
  }

  WriteLLMResponse(
    filePath: string,
    taskType: TaskType,
    content: string,
    toolCalls: Array<Record<string, unknown>>,
    model: string,
    usage: TokenUsage,
    durationMs: number,
  ): string {
    const uuid = this.newUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: "llm_response",
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      filePath,
      taskType: String(taskType),
      model,
      content,
      tool_calls: toolCalls,
      duration_ms: durationMs,
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        cache_read_tokens: usage.cacheReadTokens ?? 0,
        cache_write_tokens: usage.cacheWriteTokens ?? 0,
      },
    });
    this.lastUUID = uuid;
    return uuid;
  }

  WriteLLMError(filePath: string, taskType: TaskType, requestNo: number, errorMsg: string, durationMs: number): string {
    const uuid = this.newUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: "llm_error",
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      filePath,
      taskType: String(taskType),
      request_no: requestNo,
      error: errorMsg,
      duration_ms: durationMs,
    });
    this.lastUUID = uuid;
    return uuid;
  }

  WriteToolCall(filePath: string, taskType: TaskType, toolName: string, args: string, result: string, ok: boolean, durationMs: number): string {
    const uuid = this.newUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: "tool_call",
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      filePath,
      taskType: String(taskType),
      tool_name: toolName,
      arguments: args,
      result,
      ok,
      duration_ms: durationMs,
    });
    this.lastUUID = uuid;
    return uuid;
  }

  WriteResumeLineage(l: ResumeLineage): string {
    const uuid = this.newUUID();
    this.writeRecord({
      uuid,
      parentUuid: this.lastUUID,
      type: l.type,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      schema_version: l.schemaVersion,
      run_id: l.runId,
      parent_run_id: l.parentRunId,
      source_provider: l.sourceProvider,
      source_model: l.sourceModel,
      target_provider: l.targetProvider,
      target_model: l.targetModel,
    });
    this.lastUUID = uuid;
    return uuid;
  }

  WriteSessionEnd(durationMs: number, filesReviewed: string[], llmFailures: number, manifest: RunManifest | null): Error | null {
    const uuid = this.newUUID();
    const rec: Record<string, unknown> = {
      uuid,
      parentUuid: this.lastUUID,
      type: "session_end",
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      files_reviewed: filesReviewed,
      duration_seconds: durationMs / 1000,
      llm_failures: llmFailures,
    };
    if (manifest !== null) rec["run_manifest"] = manifest;
    try {
      this.writeRecord(rec);
      this.lastUUID = uuid;
      this.close();
      return null;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      try { this.close(); } catch {}
      return err;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — mirrors Go newJSONLWriter
// ---------------------------------------------------------------------------

export function newJSONLWriter(
  sessionId: string,
  repoDir: string,
  gitBranch: string,
  model: string,
  opts: { reviewMode?: string; diffFrom?: string; diffTo?: string; diffCommit?: string; scanPaths?: string[]; resumedFrom?: string } = {},
): JsonlWriter {
  const w = new JsonlWriter(sessionId, repoDir, gitBranch, model, opts);
  w.open();
  w.WriteSessionStart(new Date());
  return w;
}

// In-memory writer for tests (satisfies the PersistHandle seam in history.ts)
export function createMemoryWriter(sessionId: string): {
  writer: JsonlWriter;
  lines: string[];
} {
  const writer = new JsonlWriter(sessionId, "/tmp", "", "");
  const lines: string[] = [];
  // Monkey: override writeRecord to capture instead of fs
  (writer as unknown as { writeRecord: (r: Record<string, unknown>) => void }).writeRecord = (r: Record<string, unknown>) => {
    lines.push(JSON.stringify(r));
  };
  return { writer, lines };
}

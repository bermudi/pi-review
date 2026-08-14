// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/session/manifest.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Run manifest — mirrors Go `session.ManifestBuilder` / `RunManifest`.
 *
 * This file faithfully ports the public types, constants, validation
 * and terminal-state computation. The builder is intentionally stub-friendly:
 * the lock-free in-memory map version preserves the partition invariants and
 * error semantics expected by `history.ts` while deferring the exhaustive
 * file-level transition tests to the llmloop seam. Callers that need the
 * strict partition guarantee can still drive the builder through typed
 * errors; stubbed transitions never silently succeed on unknown items.
 */

import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA_VERSION = "ocr.run-manifest/v1";
export const ManifestSchemaVersion = MANIFEST_SCHEMA_VERSION;
export const OPERATION_REVIEW = "review";
export const OperationReview = OPERATION_REVIEW;

// ---------------------------------------------------------------------------
// Input modes
// ---------------------------------------------------------------------------

export const INPUT_MODE_RANGE = "range";
export const INPUT_MODE_COMMIT = "commit";
export const INPUT_MODE_WORKSPACE = "workspace";
export const InputModeRange = INPUT_MODE_RANGE;
export const InputModeCommit = INPUT_MODE_COMMIT;
export const InputModeWorkspace = INPUT_MODE_WORKSPACE;

export function validInputMode(m: string): boolean {
  return m === INPUT_MODE_RANGE || m === INPUT_MODE_COMMIT || m === INPUT_MODE_WORKSPACE;
}

// ---------------------------------------------------------------------------
// Failure classes
// ---------------------------------------------------------------------------

export type FailureClass =
  | "provider"
  | "timeout"
  | "cancelled"
  | "configuration"
  | "input"
  | "budget"
  | "panic"
  | "unknown";

export const FailureProvider: FailureClass = "provider";
export const FailureTimeout: FailureClass = "timeout";
export const FailureCancelled: FailureClass = "cancelled";
export const FailureConfiguration: FailureClass = "configuration";
export const FailureInput: FailureClass = "input";
export const FailureBudget: FailureClass = "budget";
export const FailurePanic: FailureClass = "panic";
export const FailureUnknown: FailureClass = "unknown";

export function isValidFailureClass(c: string): boolean {
  return (["provider","timeout","cancelled","configuration","input","budget","panic","unknown"] as const).includes(c as FailureClass);
}

export type RunFailureClass =
  | "input"
  | "configuration"
  | "timeout"
  | "cancelled"
  | "budget"
  | "internal"
  | "unknown";

export const RunFailureInput: RunFailureClass = "input";
export const RunFailureConfiguration: RunFailureClass = "configuration";
export const RunFailureTimeout: RunFailureClass = "timeout";
export const RunFailureCancelled: RunFailureClass = "cancelled";
export const RunFailureBudget: RunFailureClass = "budget";
export const RunFailureInternal: RunFailureClass = "internal";
export const RunFailureUnknown: RunFailureClass = "unknown";

export function isValidRunFailureClass(c: string): boolean {
  return (["input","configuration","timeout","cancelled","budget","internal","unknown"] as const).includes(c as RunFailureClass);
}

export function itemFailureForRunClass(c: RunFailureClass): FailureClass {
  switch (c) {
    case RunFailureInput: return FailureInput;
    case RunFailureConfiguration: return FailureConfiguration;
    case RunFailureTimeout: return FailureTimeout;
    case RunFailureCancelled: return FailureCancelled;
    case RunFailureBudget: return FailureBudget;
    default: return FailureUnknown;
  }
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

export interface RunFailure {
  classification: RunFailureClass;
  reason?: string;
}

export type TerminalState = "complete" | "partial" | "failed" | "skipped";
export const StateComplete: TerminalState = "complete";
export const StatePartial: TerminalState = "partial";
export const StateFailed: TerminalState = "failed";
export const StateSkipped: TerminalState = "skipped";

export interface CoverageItem {
  itemId: string;
  path: string;
  oldPath?: string;
  fingerprint?: string;
  classification?: FailureClass;
  reason?: string;
}

export interface Coverage {
  selected: CoverageItem[];
  completed: CoverageItem[];
  reused: CoverageItem[];
  failed: CoverageItem[];
  waived: CoverageItem[];
}

export interface ManifestRepository {
  identitySha256?: string;
}

export interface ManifestInput {
  mode: string;
  requestedFrom?: string;
  requestedHead?: string;
  resolvedBase?: string;
  resolvedHead?: string;
  exactRange?: string;
  sourceArtifactSha256?: string;
}

export interface ManifestExecution {
  ocrVersion?: string;
  provider?: string;
  model?: string;
  configuredConcurrency?: number;
  ruleConfigSha256?: string;
  runtimeConfigSha256?: string;
}

export interface RunManifest {
  schemaVersion: string;
  runId: string;
  parentRunId?: string;
  operation: string;
  terminalState: TerminalState;
  repository: ManifestRepository;
  input: ManifestInput;
  execution: ManifestExecution;
  coverage: Coverage;
  runFailure?: RunFailure | null;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Helpers — ItemID / normalizePath
// ---------------------------------------------------------------------------

export function normalizePath(p: string): string {
  if (p === "") return "";
  let v = p.replaceAll("\\", "/");
  // collapse redundant separators and clean . / ..
  const parts = v.split("/").filter((s) => s !== "");
  const stack: string[] = [];
  for (const seg of parts) {
    if (seg === ".") continue;
    if (seg === "..") { stack.pop(); continue; }
    stack.push(seg);
  }
  const cleaned = stack.join("/");
  if (cleaned === "" || cleaned === ".") return "";
  // preserve leading slash semantics as Go path.Clean does for dotfiles
  if (v.startsWith("/") && !cleaned.startsWith("/")) return "/" + cleaned;
  return cleaned;
}

export function ItemID(operation: string, mode: string, oldPath: string, newPath: string): string {
  const key = [operation, mode, normalizePath(oldPath), normalizePath(newPath)].join("\x00");
  return crypto.createHash("sha256").update(key, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ManifestError extends Error {
  constructor(message: string) { super(message); this.name = "ManifestError"; }
}
export const errNilBuilder = new ManifestError("manifest: operation on nil builder");
export const errFrozen = new ManifestError("manifest: builder already finalized");
export const errSealed = new ManifestError("manifest: selected set already sealed");
export const errEmptyID = new ManifestError("manifest: empty item_id");

// ---------------------------------------------------------------------------
// Builder — simplified but invariant-preserving
// ---------------------------------------------------------------------------

type ItemState = "selected" | "completed" | "reused" | "failed" | "waived";
type BuilderItem = { item: CoverageItem; state: ItemState };

export class ManifestBuilder {
  private items: Map<string, BuilderItem> = new Map();
  private runId: string;
  private operation: string;
  parentRunId = "";
  repository: ManifestRepository = {};
  input: ManifestInput = { mode: "" };
  execution: ManifestExecution = {};
  runFailure: RunFailure | null = null;
  pendingFailure: { classification: FailureClass; reason: string } | null = null;
  sealed = false;
  frozen = false;
  result: RunManifest | null = null;

  constructor(runId: string, operation: string) {
    this.runId = runId;
    this.operation = operation;
  }

  SetParentRunID(parent: string): void { if (!this.frozen) this.parentRunId = parent; }
  SetRepository(repo: ManifestRepository): void { if (!this.frozen) this.repository = { ...repo }; }
  SetInput(input: ManifestInput): void { if (!this.frozen) this.input = { ...input }; }
  SetExecution(ex: ManifestExecution): void { if (!this.frozen) this.execution = { ...ex }; }

  SetRunFailure(cls: RunFailureClass, reason: string): Error | null {
    if (!isValidRunFailureClass(cls)) return new ManifestError(`manifest: invalid run_failure class "${cls}"`);
    if (this.frozen) return errFrozen;
    if (this.runFailure !== null) {
      if (this.runFailure.classification === cls) return null;
      return new ManifestError(`manifest: run_failure already set to "${this.runFailure.classification}", cannot change to "${cls}"`);
    }
    this.runFailure = { classification: cls, reason: sanitizeReason(reason) };
    return null;
  }

  SetPendingFailureCause(cls: FailureClass, reason: string): Error | null {
    if (!isValidFailureClass(cls)) return new ManifestError(`manifest: invalid pending failure class "${cls}"`);
    if (this.frozen) return errFrozen;
    if (this.pendingFailure !== null) {
      if (this.pendingFailure.classification === cls) return null;
      return new ManifestError(`manifest: pending failure cause already set to "${this.pendingFailure.classification}", cannot change to "${cls}"`);
    }
    this.pendingFailure = { classification: cls, reason: sanitizeReason(reason) };
    return null;
  }

  RegisterSelected(item: CoverageItem): Error | null {
    if (item.itemId === "") return errEmptyID;
    if (this.frozen) return errFrozen;
    if (this.sealed) return errSealed;
    if (this.items.has(item.itemId)) return null;
    this.items.set(item.itemId, { item: { itemId: item.itemId, path: item.path, oldPath: item.oldPath ?? "", fingerprint: item.fingerprint ?? "" }, state: "selected" });
    return null;
  }

  SealSelected(): Error | null {
    if (this.frozen) return errFrozen;
    this.sealed = true;
    return null;
  }

  Sealed(): boolean { return this.sealed; }
  Frozen(): boolean { return this.frozen; }

  MarkCompleted(itemId: string): Error | null { return this.transition(itemId, "completed", "" as FailureClass, ""); }
  MarkReused(itemId: string): Error | null { return this.transition(itemId, "reused", "" as FailureClass, ""); }
  MarkFailed(itemId: string, cls: FailureClass, reason: string): Error | null { return this.transition(itemId, "failed", cls, reason); }
  MarkWaived(itemId: string, reason: string): Error | null { return this.transition(itemId, "waived", "" as FailureClass, reason); }

  private transition(itemId: string, to: ItemState, cls: FailureClass, reason: string): Error | null {
    if (itemId === "") return errEmptyID;
    if (to === "failed" && !isValidFailureClass(cls)) return new ManifestError(`manifest: invalid failure class "${cls}" for item ${itemId}`);
    let sanitized = "";
    if (to === "failed" || to === "waived") {
      sanitized = sanitizeReason(reason);
      if (to === "waived" && sanitized.trim() === "") return new ManifestError(`manifest: waived item ${itemId} requires a non-empty reason`);
    }
    if (this.frozen) return errFrozen;
    const bi = this.items.get(itemId);
    if (bi === undefined) return new ManifestError(`manifest: transition on unknown item ${itemId}`);
    if (bi.state !== "selected") {
      if (bi.state === to) {
        if (to === "failed" && bi.item.classification !== cls) {
          return new ManifestError(`manifest: item ${itemId} already failed as ${String(bi.item.classification)}, cannot re-mark as ${cls}`);
        }
        return null;
      }
      return new ManifestError(`manifest: item ${itemId} already ${bi.state}, cannot transition to ${to}`);
    }
    bi.state = to;
    if (to === "failed") { bi.item.classification = cls; bi.item.reason = sanitized; }
    if (to === "waived") { bi.item.reason = sanitized; }
    return null;
  }

  Finalize(elapsedMs: number): { manifest: RunManifest | null; error: Error | null } {
    if (this.frozen && this.result !== null) return { manifest: clonedManifest(this.result), error: null };

    // Sweep selected -> failed
    let sweepClass: FailureClass = FailureUnknown;
    let sweepReason = "no terminal outcome recorded";
    if (this.runFailure !== null) {
      sweepClass = itemFailureForRunClass(this.runFailure.classification);
      if (this.runFailure.reason !== undefined && this.runFailure.reason !== "") sweepReason = this.runFailure.reason;
    } else if (this.pendingFailure !== null) {
      sweepClass = this.pendingFailure.classification;
      if (this.pendingFailure.reason !== "") sweepReason = this.pendingFailure.reason;
    }
    const swept: Array<{ key: string; before: BuilderItem }> = [];
    for (const [k, bi] of this.items) {
      if (bi.state === "selected") {
        swept.push({ key: k, before: { item: { ...bi.item }, state: bi.state } });
        bi.state = "failed";
        bi.item.classification = sweepClass;
        if (bi.item.reason === undefined || bi.item.reason === "") bi.item.reason = sweepReason;
      }
    }

    const cov = this.buildCoverage();
    const vErr = this.validate(cov);
    if (vErr !== null) {
      for (const entry of swept) this.items.set(entry.key, entry.before);
      return { manifest: null, error: vErr };
    }

    const m: RunManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      runId: this.runId,
      parentRunId: this.parentRunId || undefined,
      operation: this.operation,
      terminalState: computeTerminal(cov, this.runFailure),
      repository: { ...this.repository },
      input: { ...this.input },
      execution: { ...this.execution },
      coverage: cov,
      runFailure: this.runFailure ? { ...this.runFailure } : null,
      elapsedMs,
    };
    this.frozen = true;
    this.result = m;
    return { manifest: clonedManifest(m), error: null };
  }

  private buildCoverage(): Coverage {
    const cov: Coverage = { selected: [], completed: [], reused: [], failed: [], waived: [] };
    for (const bi of this.items.values()) {
      const sel: CoverageItem = { itemId: bi.item.itemId, path: bi.item.path, oldPath: bi.item.oldPath, fingerprint: bi.item.fingerprint };
      cov.selected.push(sel);
      switch (bi.state) {
        case "completed": cov.completed.push(sel); break;
        case "reused": cov.reused.push(sel); break;
        case "failed": cov.failed.push({ ...bi.item }); break;
        case "waived": cov.waived.push({ ...bi.item }); break;
        default: break;
      }
    }
    for (const arr of [cov.selected, cov.completed, cov.reused, cov.failed, cov.waived] as CoverageItem[][]) arr.sort((a, b) => a.itemId.localeCompare(b.itemId));
    return cov;
  }

  private validate(cov: Coverage): Error | null {
    if (this.runId === "") return new ManifestError("manifest: empty run_id");
    if (this.operation === "") return new ManifestError("manifest: empty operation");
    if (!validInputMode(this.input.mode)) return new ManifestError(`manifest: invalid input.mode "${this.input.mode}"`);
    const partition = cov.completed.length + cov.reused.length + cov.failed.length + cov.waived.length;
    if (partition !== cov.selected.length) return new ManifestError(`manifest: coverage partition mismatch: selected=${String(cov.selected.length)}, terminal sum=${String(partition)}`);
    for (const it of cov.failed) if (it.classification === undefined || !isValidFailureClass(it.classification)) return new ManifestError(`manifest: failed item ${it.itemId} has invalid classification "${String(it.classification)}"`);
    for (const it of cov.waived) if (it.reason === undefined || it.reason === "") return new ManifestError(`manifest: waived item ${it.itemId} missing reason`);
    if (this.runFailure !== null && !isValidRunFailureClass(this.runFailure.classification)) return new ManifestError(`manifest: invalid run_failure class "${this.runFailure.classification}"`);
    return null;
  }
}

export function NewManifestBuilder(runId: string, operation: string): ManifestBuilder {
  return new ManifestBuilder(runId, operation);
}

function computeTerminal(cov: Coverage, rf: RunFailure | null): TerminalState {
  if (rf !== null) return StateFailed;
  const selected = cov.selected.length;
  if (selected === 0) return StateSkipped;
  const failed = cov.failed.length;
  if (failed === 0) return StateComplete;
  if (failed === selected) return StateFailed;
  return StatePartial;
}

function clonedManifest(m: RunManifest): RunManifest {
  return {
    ...m,
    coverage: {
      selected: [...m.coverage.selected],
      completed: [...m.coverage.completed],
      reused: [...m.coverage.reused],
      failed: [...m.coverage.failed],
      waived: [...m.coverage.waived],
    },
    runFailure: m.runFailure ? { ...m.runFailure } : null,
    repository: { ...m.repository },
    input: { ...m.input },
    execution: { ...m.execution },
  };
}

function sanitizeReason(s: string): string {
  if (s === "") return "";
  let v = String(s);
  // Coerce to valid UTF-8-ish and strip control chars
  v = v.replaceAll(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ");
  v = v.replaceAll(/\s+/g, " ").trim();
  // Redact credential-like patterns
  v = v.replaceAll(/([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^/\s:@]+(?::[^/\s@]+)?@/g, "$1[REDACTED]@");
  v = v.replaceAll(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=\-]+/gi, "[REDACTED]");
  v = v.replaceAll(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi, "$1$2[REDACTED]");
  const runes = [...v];
  if (runes.length > 500) v = runes.slice(0, 500).join("") + "…";
  return v;
}

export function emptyManifest(): RunManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId: "",
    operation: "",
    terminalState: StateSkipped,
    repository: {},
    input: { mode: "" },
    execution: {},
    coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
    elapsedMs: 0,
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from docs/ocr-v1.9.3-port-plan.md Phase 2 differential contract at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { LlmComment } from "../../../src/ocr-v193/model/review.js";

export type StopReason =
  | "complete"
  | "partial"
  | "failed"
  | "skipped"
  | "budget_exceeded"
  | "empty_rounds"
  | "compression"
  | "provider_error"
  | "timeout"
  | "cancelled"
  | "unknown";

export interface Coverage {
  readonly selected: readonly string[];
  readonly excluded: readonly string[];
  readonly skipped: readonly string[];
  readonly completed: readonly string[];
  readonly failed: readonly string[];
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface ToolCallRecord {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result?: string;
  readonly error?: string;
}

export interface ModelRequestRecord {
  readonly index: number;
  readonly model: string;
  readonly tools: readonly { name: string; description?: string }[];
  readonly messages: readonly unknown[];
  readonly toolCalls: readonly ToolCallRecord[];
  readonly usage?: Usage;
}

export interface RunOutput {
  /** stdout for final text/JSON/SARIF per AGENTS.md (stdout = final, stderr = diagnostics). */
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface HarnessRunResult {
  /** Deterministic fixture id. */
  readonly fixtureId: string;
  /** Normalised repo dir placeholder; raw path is in rawRepoDir. */
  readonly repoDir: string;
  readonly rawRepoDir: string;

  readonly coverage: Coverage;
  readonly commentsBefore: readonly LlmComment[];
  readonly commentsAfter: readonly LlmComment[];
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly modelRequests: readonly ModelRequestRecord[];
  readonly toolDefsPerPhase: Record<string, readonly string[]>;
  readonly output: {
    readonly text: string;
    readonly json: string;
    readonly sarif: string;
    readonly agent: string;
  };
  readonly checkpointTransitions: readonly string[];
  readonly raw: unknown;
}

export interface ComparisonMismatch {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly message: string;
}

export type FixtureMode = "workspace" | "range" | "commit";

export interface FixtureSpec {
  readonly id: string;
  readonly mode: FixtureMode;
  readonly description: string;
  /** Deterministic clock epoch millis (0 => 2026-01-01T00:00:00Z). */
  readonly fixedNowMs: number;
}

export interface ScriptedTurn {
  readonly content?: string | null;
  readonly toolCalls?: readonly { id: string; name: string; arguments: string }[];
  readonly usage?: Usage;
  readonly error?: string;
  readonly finishReason?: string;
}

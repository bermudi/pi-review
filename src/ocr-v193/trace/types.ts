// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from docs/ocr-v1.9.3-port-plan.md Phase 0 trace contract at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Typed trace format for the OCR vs Pi parity engine.
 *
 * This is the evidence plumbing required by Phase 0: one format, two
 * producers (OCR runner and Pi parity engine), captured at provider, tool,
 * and output boundaries — never reconstructed from fixtures.
 *
 * Each trace records:
 * - each outgoing model request: ordinal, model, messages, tool schema/name set
 * - each incoming model response: ordinal, text, tool calls, raw usage
 * - each tool execution: ordinal, name, parsed arguments, result or error
 * - final coverage, raw and processed comments, usage, stop reason, exit status
 */

export interface TraceRequest {
  readonly ordinal: number;
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly tools: readonly { readonly name: string; readonly schema: unknown }[];
}

export interface TraceToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly rawArguments: string;
}

export interface TraceResponse {
  readonly ordinal: number;
  readonly text: string;
  readonly reasoningContent?: string;
  readonly toolCalls: readonly TraceToolCall[];
  readonly rawUsage: unknown;
}

export interface TraceToolExecution {
  readonly ordinal: number;
  readonly name: string;
  readonly parsedArguments: unknown;
  readonly rawArguments: string;
  readonly result?: string;
  readonly error?: string;
}

export interface TraceFinal {
  readonly coverage: {
    readonly selected: readonly string[];
    readonly excluded: readonly string[];
    readonly skipped: readonly string[];
    readonly completed: readonly string[];
    readonly failed: readonly string[];
  };
  readonly rawComments: readonly unknown[];
  readonly processedComments: readonly unknown[];
  readonly usage: unknown;
  readonly stopReason: string;
  readonly exitCode: number;
}

export interface Trace {
  readonly version: 1;
  readonly engine: "ocr" | "pi";
  readonly fixtureId: string;
  readonly commit: string;
  readonly producedAt: string;
  readonly requests: readonly TraceRequest[];
  readonly responses: readonly TraceResponse[];
  readonly toolExecutions: readonly TraceToolExecution[];
  readonly final: TraceFinal;
}

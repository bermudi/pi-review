// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from docs/ocr-v1.9.3-port-plan.md Phase 0 trace contract at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { Trace, TraceRequest, TraceResponse, TraceToolExecution, TraceFinal } from "./types.js";

export class TraceRecorder {
  private requests: TraceRequest[] = [];
  private responses: TraceResponse[] = [];
  private toolExecutions: TraceToolExecution[] = [];

  private nextRequestOrdinal = 1;
  private nextResponseOrdinal = 1;
  private nextToolOrdinal = 1;

  constructor(
    private readonly engine: "ocr" | "pi",
    private readonly fixtureId: string,
    private readonly commit: string,
  ) {}

  recordRequest(model: string, messages: readonly unknown[], tools: readonly { name: string; schema: unknown }[]): void {
    this.requests.push({
      ordinal: this.nextRequestOrdinal++,
      model,
      messages: JSON.parse(JSON.stringify(messages)) as unknown[],
      tools: tools.map((t) => ({ name: t.name, schema: JSON.parse(JSON.stringify(t.schema)) as unknown })),
    });
  }

  recordResponse(text: string, toolCalls: readonly { id: string; name: string; arguments: string }[], rawUsage: unknown, reasoningContent?: string): void {
    this.responses.push({
      ordinal: this.nextResponseOrdinal++,
      text,
      reasoningContent,
      toolCalls: toolCalls.map((tc) => {
        let parsed: unknown = tc.arguments;
        try {
          parsed = JSON.parse(tc.arguments);
        } catch {
          parsed = tc.arguments;
        }
        return {
          id: tc.id,
          name: tc.name,
          arguments: parsed,
          rawArguments: tc.arguments,
        };
      }),
      rawUsage: rawUsage !== undefined ? JSON.parse(JSON.stringify(rawUsage)) : rawUsage,
    });
  }

  recordToolExecution(name: string, rawArgs: string, result?: string, error?: string): void {
    let parsed: unknown = rawArgs;
    try {
      parsed = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      parsed = rawArgs;
    }
    this.toolExecutions.push({
      ordinal: this.nextToolOrdinal++,
      name,
      parsedArguments: parsed,
      rawArguments: rawArgs,
      result,
      error,
    });
  }

  build(final: TraceFinal): Trace {
    return {
      version: 1,
      engine: this.engine,
      fixtureId: this.fixtureId,
      commit: this.commit,
      producedAt: new Date().toISOString(),
      requests: [...this.requests],
      responses: [...this.responses],
      toolExecutions: [...this.toolExecutions],
      final: JSON.parse(JSON.stringify(final)) as TraceFinal,
    };
  }

  toJSON(final: TraceFinal): string {
    return JSON.stringify(this.build(final), null, 2);
  }
}

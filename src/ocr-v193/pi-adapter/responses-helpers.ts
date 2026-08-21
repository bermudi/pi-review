// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/responses_client.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Only observable, transport-independent behaviors.

import { expandSessionKeyInBody, expandSessionKeyInHeaders } from "./session-key.js";
import { ErrorClassProvider, FailurePhaseResponseStatus } from "../retry/types.js";

export type ResponsesStatus = "completed" | "failed" | "cancelled" | "incomplete" | "queued" | "in_progress" | string;

export function classifyResponsesStatus(status: string): { errorClass: string; failurePhase: string } | null {
  if (status === "completed") return null;
  // All non-completed statuses are provider/response_status errors in OCR
  // Includes failed, cancelled, queued, in_progress etc.
  return { errorClass: ErrorClassProvider, failurePhase: FailurePhaseResponseStatus };
}

export function mapResponsesResponse(status: string): { ok: boolean; error?: string } {
  const cls = classifyResponsesStatus(status);
  if (cls === null) return { ok: true };
  return { ok: false, error: `responses status ${status} classified as ${cls.errorClass}/${cls.failurePhase}` };
}

export function buildResponsesToolDefs(tools: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }> | undefined) {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

export function prepareResponsesRequest(
  extraBody: Record<string, unknown> | null | undefined,
  extraHeaders: Record<string, string> | null | undefined,
  sessionKey: string,
): { headers: Record<string, string> | null; body: Record<string, unknown> | null } {
  let headers: Record<string, string> | null = null;
  if (extraHeaders) headers = expandSessionKeyInHeaders(extraHeaders, sessionKey) as Record<string, string> | null;
  let body: Record<string, unknown> | null = null;
  if (extraBody) {
    // Expand placeholder
    const expanded = expandSessionKeyInBody(extraBody as Record<string, unknown>, sessionKey) as Record<string, unknown> | null;
    if (expanded) {
      body = { ...expanded };
      // PromptCacheKey overrides session affinity: if prompt_cache_key present, it already expanded; no extra handling
      // Stream drop: non-streaming responses client drops stream field
      if ("stream" in body) delete body["stream"];
    }
  }
  return { headers, body };
}

export function shouldRetryTruncated(attemptIndex: number, err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const isEOF = msg.includes("unexpected EOF") || msg.includes("ErrUnexpectedEOF");
  if (!isEOF) return false;
  return attemptIndex === 0; // only retry first truncation, not second
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/agent.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { LlmComment } from "../model/review.js";
import { StripMarkdownFences, type ToolCall } from "../llmloop/compression.js";
import type { ToolDef } from "../llmloop/types.js";

// OCR v1.9.5 c8b6a390b8ad447faf46d4764347167edff0ada2. These are
// terminal review-filter decisions, not normal-review capabilities.
export const REVIEW_FILTER_TOOLS: readonly ToolDef[] = [
  {
    type: "function",
    function: {
      name: "report_incorrect_comments",
      description: "Report only comments the diff proves factually wrong.",
      parameters: {
        type: "object",
        properties: {
          analysis: { type: "array", items: { type: "string" } },
          comment_ids: { type: "array", items: { type: "string" } },
        },
        required: ["analysis", "comment_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "approve_all_comments",
      description: "Keep every review comment.",
      parameters: { type: "object", properties: {} },
    },
  },
];

/**
 * Extract removal indexes from the terminal filter tool calls. A missing or
 * malformed matching call returns null, allowing OCR's text fallback.
 */
export function parseFilterToolCalls(calls: readonly ToolCall[], total: number): Map<number, unknown> | null {
  let indices: Map<number, unknown> | null = null;
  for (const call of calls) {
    if (call.function.name === "approve_all_comments") {
      indices ??= new Map<number, unknown>();
      continue;
    }
    if (call.function.name !== "report_incorrect_comments") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(call.function.arguments);
    } catch (error) {
      console.error(`[pi-review] Review filter: failed to parse tool call arguments: ${String(error)}`);
      continue;
    }
    if (raw === null || typeof raw !== "object") continue;
    const ids = (raw as Record<string, unknown>)["comment_ids"];
    if (!Array.isArray(ids)) continue;
    indices ??= new Map<number, unknown>();
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const match = /^c-(\d+)$/.exec(id);
      if (match === null) continue;
      const index = Number(match[1]);
      if (Number.isInteger(index) && index >= 0 && index < total) indices.set(index, {});
    }
  }
  return indices;
}

/**
 * buildFilterCommentsJSON mirrors Go buildFilterCommentsJSON.
 * Pure helper — produces the JSON payload for the review_filter task.
 */
export function buildFilterCommentsJSON(comments: LlmComment[]): string {
  type FilterComment = { id: string; content: string; existing_code?: string };
  const items: FilterComment[] = comments.map((cm, i) => ({
    id: `c-${i}`,
    content: cm.content,
    ...(cm.existingCode ? { existing_code: cm.existingCode } : {}),
  }));
  return JSON.stringify(items);
}

/**
 * parseFilterResponse mirrors Go parseFilterResponse.
 * Parses the LLM's JSON array of kept comment IDs into a set of indices.
 * Returns null on invalid JSON (caller should keep all comments).
 */
export function parseFilterResponse(raw: string, total: number): Map<number, unknown> | null {
  const cleaned = StripMarkdownFences(raw);
  let ids: unknown;
  try {
    ids = JSON.parse(cleaned);
  } catch (err) {
    const preview = cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
    console.error(`[pi-review] Review filter: failed to parse LLM response: ${String((err as Error).message)}, raw: ${preview}`);
    return null;
  }
  if (!Array.isArray(ids)) {
    const preview = cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
    console.error(`[pi-review] Review filter: failed to parse LLM response: expected array, raw: ${preview}`);
    return null;
  }
  const indices = new Map<number, unknown>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const m = /^c-(\d+)$/.exec(id);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue;
    indices.set(idx, {});
  }
  return indices;
}

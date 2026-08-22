// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/agent.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27;
// review-filter tool contract updated from OCR v1.9.5
// c8b6a390b8ad447faf46d4764347167edff0ada2.
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
      description:
        "Report review comments that this diff proves to be factually wrong: either the code they target is absent from the diff, " +
        "or one diff line literally contradicts their central claim. For every id listed you must be able to name that line. " +
        "Do not use this for comments you merely find unconvincing, unverifiable, or low-value, nor for comments about memory safety, " +
        "concurrency, linkage consistency, unused parameters, or behavioral changes.",
      parameters: {
        type: "object",
        properties: {
          // Property order is load-bearing: OCR's Go map serialization sorts
          // analysis before comment_ids so the model reasons before committing.
          analysis: {
            type: "array",
            description:
              "Work through every candidate comment BEFORE deciding. One entry per candidate: its id, " +
              "whether its subject hits the protected-subject veto (Step 1) or the value veto (Step 2), " +
              "the exact diff line that refutes it if any, and your final call. " +
              "Only ids you conclude here as removable may appear in comment_ids.",
            items: { type: "string" },
          },
          comment_ids: {
            type: "array",
            description: "IDs concluded removable in analysis, e.g. [\"c-0\", \"c-2\"]. Must not be empty.",
            items: { type: "string" },
          },
        },
        required: ["analysis", "comment_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "approve_all_comments",
      description:
        "Keep every review comment. Call this whenever no comment clears the removal bar — including when comments look doubtful, " +
        "cannot be verified from the diff alone, or seem minor. This is the expected outcome for most files.",
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
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      console.error("[pi-review] Review filter: failed to parse tool call arguments: expected object");
      continue;
    }
    const ids = (raw as Record<string, unknown>)["comment_ids"];
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))) {
      console.error("[pi-review] Review filter: failed to parse tool call arguments: comment_ids must be strings");
      continue;
    }
    indices ??= new Map<number, unknown>();
    for (const id of ids ?? []) {
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

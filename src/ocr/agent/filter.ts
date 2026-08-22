// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/agent.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { LlmComment } from "../model/review.js";
import { StripMarkdownFences } from "../llmloop/compression.js";

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

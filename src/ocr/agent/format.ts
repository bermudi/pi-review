// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/agent.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { ToolDef } from "../llmloop/types.js";

/**
 * formatToolDefs mirrors Go formatToolDefs.
 * Renders the tool definitions into the plan-task system prompt.
 * Preserves raw JSON property order when RawDefinition is present;
 * otherwise sorts alphabetically (matches Go's slices.Sorted fallback).
 */
export function formatToolDefs(toolDefs: readonly ToolDef[]): string {
  if (toolDefs.length === 0) return "";
  let sb = "### Available Tools (reference only — do not call)\n";
  for (const td of toolDefs) {
    const fn = td.function as unknown as Record<string, unknown>;
    const name = typeof fn["name"] === "string" ? (fn["name"] as string) : "unknown";
    const desc = typeof fn["description"] === "string" ? (fn["description"] as string) : "";
    sb += `- **${name}**: ${desc}\n`;
    const rawDef = fn["RawDefinition"] as unknown;
    const params = fn["parameters"] as unknown;
    if (params !== null && params !== undefined && typeof params === "object") {
      const rec = params as Record<string, unknown>;
      const props = rec["properties"] as Record<string, unknown> | undefined;
      if (props !== undefined && Object.keys(props).length > 0) {
        const required = new Set<string>(
          Array.isArray(rec["required"]) ? (rec["required"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
        );
        sb += "  Parameters:\n";
        const keys = rawDef !== null && rawDef !== undefined ? Object.keys(props) : Object.keys(props).sort();
        for (const k of keys) {
          const meta = props[k] as Record<string, unknown> | undefined;
          const desc2 = meta !== undefined && typeof meta["description"] === "string" ? (meta["description"] as string) : "";
          const suffix = required.has(k) ? " (required)" : "";
          sb += `  - ${k}: ${desc2}${suffix}\n`;
        }
      }
    }
  }
  return sb;
}

// ---------------------------------------------------------------------------
// ToolConfigEntry — mirrors Go internal/config/toolsconfig.ToolConfigEntry
// Used by BuildToolDefs to filter plan vs main task tools.
// Keep single canonical PascalCase shape (matches Go struct field names).
// ---------------------------------------------------------------------------

export interface ToolConfigEntry {
  readonly Name: string;
  readonly PlanTask: boolean;
  readonly MainTask: boolean;
  readonly Definition: unknown;
}

/**
 * BuildToolDefs mirrors Go BuildToolDefs.
 * Filters entries by planOnly flag and parses Definition JSON.
 * Returns null when no entries match (mirrors Go's nil return).
 */
export function BuildToolDefs(entries: readonly ToolConfigEntry[] | null | undefined, planOnly: boolean): ToolDef[] | null {
  if (entries === null || entries === undefined || entries.length === 0) return null;
  const out: ToolDef[] = [];
  for (const e of entries) {
    const name = e.Name;
    const planTask = e.PlanTask;
    const mainTask = e.MainTask;
    const defRaw = e.Definition;
    const shouldInclude = planOnly ? planTask : mainTask;
    if (!shouldInclude) continue;
    let parsed: Record<string, unknown> | null = null;
    let rawStr: string | null = null;
    if (typeof defRaw === "string") {
      rawStr = defRaw;
      try {
        parsed = JSON.parse(defRaw) as Record<string, unknown>;
      } catch {
        console.error(`[ocr] WARNING: failed to parse tool definition "${name}": invalid JSON`);
        continue;
      }
    } else if (defRaw !== null && typeof defRaw === "object") {
      parsed = defRaw as Record<string, unknown>;
      try {
        rawStr = JSON.stringify(defRaw);
      } catch {
        rawStr = null;
      }
    } else {
      continue;
    }
    if (parsed === null) continue;
    const fnName = typeof parsed["name"] === "string" ? (parsed["name"] as string) : name;
    const fnDesc = typeof parsed["description"] === "string" ? (parsed["description"] as string) : "";
    const parameters = parsed["parameters"] as unknown;
    out.push({
      type: "function",
      function: {
        name: fnName,
        description: fnDesc,
        parameters: parameters as unknown,
        RawDefinition: rawStr ?? undefined,
      } as unknown as ToolDef["function"],
    });
  }
  return out.length === 0 ? null : out;
}

export const buildToolDefs = BuildToolDefs;

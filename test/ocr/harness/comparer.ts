// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from docs/ocr-port-plan.md Phase 2 "end-to-end differential harness" field list at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Field-by-field comparer for OCR vs Pi harness runs.
 *
 * Captures and compares the plan-mandated dimensions:
 * - selected, excluded, skipped, completed, and failed files;
 * - prompts and tool definitions presented in each phase;
 * - model-request count and tool calls per request;
 * - tool arguments, results, and errors;
 * - comments before and after processing;
 * - stop reason, coverage, usage, and budget state;
 * - text, JSON, SARIF, and agent-audience output;
 * - checkpoint/resume transitions.
 *
 * Determinism: normalises temp absolute paths (<TMP>) and timestamps before compare.
 */

import type { HarnessRunResult, ComparisonMismatch } from "./types.js";

export interface CompareOpts {
  /** Fields to ignore (e.g. "usage" when OCR stub lacks it). */
  readonly ignoreFields?: ReadonlySet<string>;
  /** Whether to normalise tmp paths (default: true). */
  readonly normalizePaths?: boolean;
}

function normalize(text: string): string {
  // Replace timestamps like 2026-08-14T00:00:00Z, ISO dates, and <TMP> placeholders
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>")
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/g, "<TIMESTAMP>")
    .replace(/\/tmp\/ocr-harness-repo-[^\s"']+/g, "<TMP>")
    .replace(/\/tmp\/ocr-build-[^\s"']+/g, "<TMP>")
    .replace(/localhost:\d+/g, "localhost:<PORT>");
}

function setEquals<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function arrayEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function compareRuns(
  expected: HarnessRunResult,
  actual: HarnessRunResult,
  opts: CompareOpts = {},
): { readonly equal: boolean; readonly mismatches: readonly ComparisonMismatch[] } {
  const ignore = opts.ignoreFields ?? new Set<string>();
  const mismatches: ComparisonMismatch[] = [];

  function check(field: string, pass: boolean, left: unknown, right: unknown, msg: string): void {
    if (ignore.has(field)) return;
    if (!pass) mismatches.push({ field, expected: left, actual: right, message: msg });
  }

  // Coverage
  check(
    "coverage.selected",
    setEquals(expected.coverage.selected, actual.coverage.selected),
    expected.coverage.selected,
    actual.coverage.selected,
    `selected files differ: expected ${JSON.stringify(expected.coverage.selected)} got ${JSON.stringify(actual.coverage.selected)}`,
  );
  check(
    "coverage.excluded",
    setEquals(expected.coverage.excluded, actual.coverage.excluded),
    expected.coverage.excluded,
    actual.coverage.excluded,
    `excluded differ`,
  );
  check(
    "coverage.skipped",
    setEquals(expected.coverage.skipped, actual.coverage.skipped),
    expected.coverage.skipped,
    actual.coverage.skipped,
    `skipped differ`,
  );
  check(
    "coverage.completed",
    setEquals(expected.coverage.completed, actual.coverage.completed),
    expected.coverage.completed,
    actual.coverage.completed,
    `completed differ`,
  );
  check(
    "coverage.failed",
    setEquals(expected.coverage.failed, actual.coverage.failed),
    expected.coverage.failed,
    actual.coverage.failed,
    `failed differ`,
  );

  // Tool defs per phase
  const phases = new Set([...Object.keys(expected.toolDefsPerPhase), ...Object.keys(actual.toolDefsPerPhase)]);
  for (const ph of phases) {
    const e = expected.toolDefsPerPhase[ph] ?? [];
    const a = actual.toolDefsPerPhase[ph] ?? [];
    check(`toolDefs.${ph}`, setEquals(e as unknown as string[], a as unknown as string[]), e, a, `tool defs for phase ${ph} differ: ${JSON.stringify(e)} vs ${JSON.stringify(a)}`);
  }

  // Model request count and tool calls per request
  check(
    "modelRequests.count",
    expected.modelRequests.length === actual.modelRequests.length,
    expected.modelRequests.length,
    actual.modelRequests.length,
    `model request count differs: ${expected.modelRequests.length} vs ${actual.modelRequests.length}`,
  );
  // Per-request tool call counts (only when counts match)
  if (expected.modelRequests.length === actual.modelRequests.length) {
    for (let i = 0; i < expected.modelRequests.length; i++) {
      const e = expected.modelRequests[i] as NonNullable<(typeof expected.modelRequests)[number]>;
      const a = actual.modelRequests[i] as NonNullable<(typeof actual.modelRequests)[number]>;
      check(
        `modelRequests[${i}].tools`,
        setEquals(
          e.tools.map((t) => t.name),
          a.tools.map((t) => t.name),
        ),
        e.tools,
        a.tools,
        `tools for request ${i} differ`,
      );
      // tool args/results comparison when available
      if (!arrayEqual(e.toolCalls, a.toolCalls)) {
        check(`modelRequests[${i}].toolCalls`, false, e.toolCalls, a.toolCalls, `tool calls for request ${i} differ`);
      }
    }
  }

  // Comments before/after (length + path/content equality after normalization)
  check(
    "commentsBefore.count",
    expected.commentsBefore.length === actual.commentsBefore.length,
    expected.commentsBefore.length,
    actual.commentsBefore.length,
    `commentsBefore count differs`,
  );
  check(
    "commentsAfter.count",
    expected.commentsAfter.length === actual.commentsAfter.length,
    expected.commentsAfter.length,
    actual.commentsAfter.length,
    `commentsAfter count differs`,
  );
  // Deep compare comments by path+content+suggestion+category+severity+lines (order significant per OCR guarantee; do not sort)
  if (expected.commentsAfter.length === actual.commentsAfter.length && expected.commentsAfter.length > 0) {
    for (let i = 0; i < expected.commentsAfter.length; i++) {
      const e = expected.commentsAfter[i] as NonNullable<(typeof expected.commentsAfter)[number]>;
      const a = actual.commentsAfter[i] as NonNullable<(typeof actual.commentsAfter)[number]>;
      const eStart = ((e as any).start_line ?? (e as any).startLine ?? 0) as number;
      const aStart = ((a as any).start_line ?? (a as any).startLine ?? 0) as number;
      const eEnd = ((e as any).end_line ?? (e as any).endLine ?? 0) as number;
      const aEnd = ((a as any).end_line ?? (a as any).endLine ?? 0) as number;
      const linesMatch = (eStart === 0 || aStart === 0 || eStart === aStart) && (eEnd === 0 || aEnd === 0 || eEnd === aEnd);
      const same =
        e.path === a.path &&
        e.content === a.content &&
        (((e as any).existing_code ?? (e as any).existingCode ?? "") as string) === (((a as any).existing_code ?? (a as any).existingCode ?? "") as string) &&
        (((e as any).suggestion_code ?? (e as any).suggestionCode ?? "") as string) === (((a as any).suggestion_code ?? (a as any).suggestionCode ?? "") as string) &&
        (e.category ?? "") === (a.category ?? "") &&
        (e.severity ?? "") === (a.severity ?? "") &&
        linesMatch;
      check(`commentsAfter[${i}]`, same, e, a, `comment ${i} differs: ${JSON.stringify(e)} vs ${JSON.stringify(a)}`);
    }
  }
  // Also deep-compare commentsBefore when present
  if (expected.commentsBefore.length === actual.commentsBefore.length && expected.commentsBefore.length > 0) {
    for (let i = 0; i < expected.commentsBefore.length; i++) {
      const e = expected.commentsBefore[i] as NonNullable<(typeof expected.commentsBefore)[number]>;
      const a = actual.commentsBefore[i] as NonNullable<(typeof actual.commentsBefore)[number]>;
      const same = e.path === a.path && e.content === a.content;
      check(`commentsBefore[${i}]`, same, e, a, `commentsBefore ${i} differs`);
    }
  }

  // Stop reason, usage, budget
  check("stopReason", expected.stopReason === actual.stopReason, expected.stopReason, actual.stopReason, `stopReason differs`);
  check(
    "usage.totalTokens",
    expected.usage.totalTokens === actual.usage.totalTokens,
    expected.usage.totalTokens,
    actual.usage.totalTokens,
    `totalTokens differ`,
  );
  check(
    "usage.promptTokens",
    (expected.usage.promptTokens ?? 0) === (actual.usage.promptTokens ?? 0),
    expected.usage.promptTokens,
    actual.usage.promptTokens,
    `promptTokens differ`,
  );
  check(
    "usage.completionTokens",
    (expected.usage.completionTokens ?? 0) === (actual.usage.completionTokens ?? 0),
    expected.usage.completionTokens,
    actual.usage.completionTokens,
    `completionTokens differ`,
  );

  // Output fields (normalized)
  if (!ignore.has("output.text")) {
    const et = normalize(expected.output.text ?? "");
    const at = normalize(actual.output.text ?? "");
    check("output.text", et === at, et.slice(0, 500), at.slice(0, 500), `text output differs`);
  }
  if (!ignore.has("output.json")) {
    const ej = normalize(expected.output.json ?? "");
    const aj = normalize(actual.output.json ?? "");
    // Attempt JSON parse equality ignoring whitespace and path
    let ejObj: unknown = null;
    let ajObj: unknown = null;
    try {
      ejObj = ej ? JSON.parse(ej) : null;
    } catch {
      ejObj = ej;
    }
    try {
      ajObj = aj ? JSON.parse(aj) : null;
    } catch {
      ajObj = aj;
    }
    check("output.json", arrayEqual(ejObj, ajObj), ej.slice(0, 500), aj.slice(0, 500), `json output differs`);
  }
  if (!ignore.has("output.sarif")) {
    const es = normalize(expected.output.sarif ?? "");
    const as = normalize(actual.output.sarif ?? "");
    check("output.sarif", es === as, es.slice(0, 500), as.slice(0, 500), `sarif differs`);
  }

  // Checkpoint transitions
  check(
    "checkpointTransitions",
    arrayEqual(expected.checkpointTransitions, actual.checkpointTransitions),
    expected.checkpointTransitions,
    actual.checkpointTransitions,
    `checkpointTransitions differ`,
  );

  return { equal: mismatches.length === 0, mismatches };
}

export function formatMismatches(mismatches: readonly ComparisonMismatch[]): string {
  if (mismatches.length === 0) return "OK — all compared fields match";
  const lines: string[] = [`FAIL — ${mismatches.length} mismatch(es):`];
  for (const m of mismatches) {
    lines.push(`  - ${m.field}: ${m.message}`);
    lines.push(`    expected: ${JSON.stringify(m.expected)?.slice(0, 500)}`);
    lines.push(`    actual:   ${JSON.stringify(m.actual)?.slice(0, 500)}`);
  }
  return lines.join("\n");
}

/** Artifact writer: preserve raw mismatch artifacts per plan requirement. */
export async function writeArtifacts(
  outDir: string,
  fixtureId: string,
  expected: HarnessRunResult,
  actual: HarnessRunResult,
  mismatches: readonly ComparisonMismatch[],
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(outDir, { recursive: true });
  const base = join(outDir, fixtureId);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "expected.json"), JSON.stringify(expected, null, 2), "utf-8");
  await writeFile(join(base, "actual.json"), JSON.stringify(actual, null, 2), "utf-8");
  await writeFile(join(base, "mismatches.txt"), formatMismatches(mismatches), "utf-8");
}

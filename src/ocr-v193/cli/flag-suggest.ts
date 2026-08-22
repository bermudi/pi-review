// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/flag_suggest.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Flag suggestion helper — mirrors OCR's flagErrorWithSuggestion / suggestFlag / levenshtein.
 * Used to turn "unknown flag: --forma" into "Did you mean --format?" via edit distance <3.
 */

export function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, Math.min(prev[j]! + 1, prev[j - 1]! + cost));
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb]!;
}

export function suggestFlag(available: readonly string[], unknown: string): string {
  let trimmed = unknown;
  // Trim leading dashes like Go's TrimLeft(unknown, "-")
  trimmed = trimmed.replace(/^-+/, "");
  if (trimmed === "") return "";
  let best = "";
  let bestDist = 3; // max edit distance to consider, mirrors Go
  for (const name of available) {
    const d = levenshtein(trimmed, name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  if (best !== "") {
    return `\n\nDid you mean this?\n\t--${best}`;
  }
  return "";
}

export function flagErrorWithSuggestion(available: readonly string[], err: Error): Error {
  const msg = err.message;
  let unknown = "";
  // Handle both "unknown flag: --foo" and "unknown flag --foo"
  const colonIdx = msg.indexOf("unknown flag:");
  if (colonIdx !== -1) {
    unknown = msg.slice(colonIdx + "unknown flag:".length).trim();
    unknown = unknown.replace(/^-+/, "");
  } else {
    const plainIdx = msg.indexOf("unknown flag");
    if (plainIdx !== -1) {
      const after = msg.slice(plainIdx + "unknown flag".length).trim();
      // after may be "--forma" or "--forma" with colon space
      unknown = after.replace(/^:\s*/, "").replace(/^-+/, "");
    }
  }
  if (unknown === "") return err;
  const suggestion = suggestFlag(available, unknown);
  if (suggestion !== "") {
    // Preserve original error as cause if supported
    const wrapped = new Error(`${msg}${suggestion}`, { cause: err });
    return wrapped;
  }
  return err;
}

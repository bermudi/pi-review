// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/hunk.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Hunk parser — mirrors Go `hunk.go`.
 * Parses raw unified diff text for a single file into a slice of Hunks.
 * Deterministic ordering is preserved (input order).
 */

// ---------------------------------------------------------------------------
// Types — mirrors Go constants/types
// ---------------------------------------------------------------------------

export const HunkContext = 0 as const;
export const HunkAdded = 1 as const;
export const HunkDeleted = 2 as const;

export type HunkLineType = typeof HunkContext | typeof HunkAdded | typeof HunkDeleted;

export interface HunkLine {
  readonly type: HunkLineType;
  readonly content: string;
}

export interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly HunkLine[];
}

// ---------------------------------------------------------------------------
// Internal regex — mirrors Go `hunkHeaderRe`.
// `^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * ParseHunks parses raw unified diff text for a single file into Hunks.
 * Lines before the first @@ header are ignored (file-level headers).
 * Mirrors Go `ParseHunks`.
 */
export function parseHunks(rawDiffText: string): Hunk[] {
  const lines = rawDiffText.split("\n");
  const hunks: Hunk[] = [];
  let current: {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: HunkLine[];
  } | null = null;

  for (const line of lines) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      if (current !== null) {
        hunks.push(freezeHunk(current));
      }
      const oldStart = parseInt(m[1]!, 10);
      const oldCount = m[2] !== undefined && m[2] !== "" ? parseInt(m[2], 10) : 1;
      const newStart = parseInt(m[3]!, 10);
      const newCount = m[4] !== undefined && m[4] !== "" ? parseInt(m[4], 10) : 1;
      current = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      continue;
    }

    if (current === null) continue; // skip preamble

    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("diff --git ")) break;

    if (line.startsWith("+")) {
      current.lines.push({ type: HunkAdded, content: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: HunkDeleted, content: line.slice(1) });
    } else {
      // Context line (' ' prefix) or other — treat as context; strip single leading space if present.
      let content = line;
      if (content.length > 0 && content[0] === " ") content = content.slice(1);
      current.lines.push({ type: HunkContext, content });
    }
  }

  if (current !== null) {
    hunks.push(freezeHunk(current));
  }

  return hunks;
}

function freezeHunk(c: {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}): Hunk {
  return {
    oldStart: c.oldStart,
    oldCount: c.oldCount,
    newStart: c.newStart,
    newCount: c.newCount,
    lines: [...c.lines],
  };
}

// ---------------------------------------------------------------------------
// Legacy aliases for potential call-site compatibility
// ---------------------------------------------------------------------------

export const ParseHunks = parseHunks;

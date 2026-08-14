// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/resolver.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Line-number resolver — mirrors Go `resolver.go`.
 * Populates StartLine/EndLine on LlmComment by matching ExistingCode against
 * diff hunks (primary) or full new-file content (fallback). Deterministic
 * ordering is preserved; first consecutive match wins.
 */

import type { Diff } from "../model/diff.js";
import type { LlmComment } from "../model/review.js";
import { parseHunks, HunkAdded, HunkContext, HunkDeleted } from "./hunk.js";
import type { Hunk } from "./hunk.js";

// ---------------------------------------------------------------------------
// Public API — mirrors Go `ResolveLineNumbers` / `ResolveComment`
// ---------------------------------------------------------------------------

/**
 * ResolveLineNumbers populates startLine/endLine on each comment.
 * Mirrors Go `ResolveLineNumbers`. Returns a shallow copy of comments.
 */
export function resolveLineNumbers(comments: LlmComment[], diffs: Diff[]): LlmComment[] {
  if (comments.length === 0 || diffs.length === 0) return comments;

  const diffByPath = new Map<string, Diff>();
  for (const d of diffs) {
    if (d.newPath !== "/dev/null" && d.newPath !== "") diffByPath.set(d.newPath, d);
    if (d.oldPath !== "/dev/null" && d.oldPath !== "") diffByPath.set(d.oldPath, d);
  }

  const result: LlmComment[] = comments.map((c) => ({ ...c }));

  for (const cm of result) {
    if ((cm.startLine ?? 0) > 0 || (cm.endLine ?? 0) > 0) continue;
    if (!cm.existingCode || cm.existingCode === "") continue;
    const d = diffByPath.get(cm.path);
    if (!d) continue;

    if (resolveFromHunk(d, cm)) continue;
    resolveFromFileContent(d, cm);
  }

  return result;
}

export const ResolveLineNumbers = resolveLineNumbers;

/**
 * ResolveComment attempts to resolve a single comment. Returns true on success.
 * Mirrors Go `ResolveComment` (mutates cm).
 */
export function resolveComment(cm: LlmComment, d: Diff): boolean {
  if ((cm.startLine ?? 0) > 0 || (cm.endLine ?? 0) > 0) return true;
  if (!cm.existingCode || cm.existingCode === "") return false;
  if (resolveFromHunk(d, cm)) return true;
  return resolveFromFileContent(d, cm);
}

export const ResolveComment = resolveComment;

// ---------------------------------------------------------------------------
// Internal helpers — mirrors Go helpers
// ---------------------------------------------------------------------------

interface IndexedLine {
  lineNum: number;
  content: string;
}

function resolveFromHunk(d: Diff, cm: LlmComment): boolean {
  const hunks = parseHunks(d.diff);
  if (hunks.length === 0) return false;

  const targetLines = splitAndNormalize(cm.existingCode ?? "");
  if (targetLines.length === 0) return false;

  for (const h of hunks) {
    const newSide = extractSideLines(h, true);
    const m = matchConsecutive(newSide, targetLines);
    if (m.found) {
      cm.startLine = m.startLine;
      cm.endLine = m.endLine;
      return true;
    }
  }

  for (const h of hunks) {
    const oldSide = extractSideLines(h, false);
    const m = matchConsecutive(oldSide, targetLines);
    if (m.found) {
      cm.startLine = m.startLine;
      cm.endLine = m.endLine;
      return true;
    }
  }

  return false;
}

export function extractSideLines(hunk: Hunk, newSide: boolean): IndexedLine[] {
  const result: IndexedLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  for (const l of hunk.lines) {
    switch (l.type) {
      case HunkContext:
        if (newSide) result.push({ lineNum: newLine, content: normalizeLine(l.content) });
        else result.push({ lineNum: oldLine, content: normalizeLine(l.content) });
        oldLine++;
        newLine++;
        break;
      case HunkAdded:
        if (newSide) result.push({ lineNum: newLine, content: normalizeLine(l.content) });
        newLine++;
        break;
      case HunkDeleted:
        if (!newSide) result.push({ lineNum: oldLine, content: normalizeLine(l.content) });
        oldLine++;
        break;
    }
  }
  return result;
}

export function matchConsecutive(
  sideLines: IndexedLine[],
  targetLines: string[],
): { startLine: number; endLine: number; found: boolean } {
  if (targetLines.length === 0 || sideLines.length < targetLines.length) {
    return { startLine: 0, endLine: 0, found: false };
  }
  for (let i = 0; i <= sideLines.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (sideLines[i + j]!.content !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return {
        startLine: sideLines[i]!.lineNum,
        endLine: sideLines[i + targetLines.length - 1]!.lineNum,
        found: true,
      };
    }
  }
  return { startLine: 0, endLine: 0, found: false };
}

function resolveFromFileContent(d: Diff, cm: LlmComment): boolean {
  if (!d.newFileContent || d.newFileContent === "") return false;

  const fileLines = d.newFileContent.split("\n");
  const targetLines = splitAndNormalize(cm.existingCode ?? "");
  if (targetLines.length === 0) return false;

  const normalizedFileLines: string[] = [];
  const fileLineNums: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    const raw = fileLines[i]!;
    const n = normalizeLine(raw.replace(/\r$/, ""));
    if (n === "") continue;
    normalizedFileLines.push(n);
    fileLineNums.push(i + 1);
  }

  if (normalizedFileLines.length < targetLines.length) return false;

  for (let i = 0; i <= normalizedFileLines.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (normalizedFileLines[i + j] !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      cm.startLine = fileLineNums[i]!;
      cm.endLine = fileLineNums[i + targetLines.length - 1]!;
      return true;
    }
  }

  return false;
}

export function splitAndNormalize(code: string): string[] {
  const raw = code.split("\n");
  const result: string[] = [];
  for (const line of raw) {
    const n = normalizeLine(line);
    if (n === "") continue;
    result.push(n);
  }
  return result;
}

export function normalizeLine(s: string): string {
  s = s.trim();
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) s = s.slice(1);
  return s.trim();
}

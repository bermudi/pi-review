// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Surgically adopted from OCR internal/tool/comment_args_repair.go at 41917e2
// (isolated adoption; frozen v1.9.9 baseline unchanged otherwise).
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Repair for serialized `code_comment` arguments.
 *
 * The schema declares `comments` as an array, but a model occasionally sends
 * it as a string needing one more escaping level. The dropped level is almost
 * always a prose quote, bare backslash, or control character. Without repair
 * the whole batch is lost.
 *
 * Mechanism (mirrors Go):
 * - A bare quote is a terminator only when followed by `,`, `}`, `]`, `:`
 *   or end-of-text; otherwise it is content and gets escaped.
 * - Backslashes opening no legal escape get escaped; controls <0x20 get
 *   short or \u00XX escapes.
 * - Accept only lossless repairs: parses, non-empty content, entry count
 *   covers `"content":` fields, only known fields, no odd-quote truncation
 *   signature in content/existing_code/suggestion_code/path (thinking excluded).
 * - Otherwise return null and keep the original parser error verbatim —
 *   its wording makes the model regenerate the batch.
 *
 * UTF-16 safety: only ASCII code units (`"`, `\`, <0x20, whitespace,
 * structural) drive decisions via charCodeAt; all other units (including
 * surrogates) copy through untouched, matching Go's byte-wise safety for
 * UTF-8 continuation bytes.
 */

const CONTENT_FIELD_PATTERN = /"content"\s*:/g;

// Known fields mirror upstream plus pi-reviewer line extensions (start/end
// line variants carried by LlmComment). Batches using only these may repair;
// anything else means prose was re-read as structure.
const KNOWN_COMMENT_FIELDS: ReadonlySet<string> = new Set([
  "content",
  "existing_code",
  "suggestion_code",
  "category",
  "severity",
  "path",
  "thinking",
  // pi-reviewer extensions (loop.ts carries these, not in upstream schema).
  "start_line",
  "end_line",
  "startLine",
  "endLine",
]);

const COMMENT_TEXT_FIELDS: readonly string[] = ["content", "existing_code", "suggestion_code", "path"];

export interface CommentRepair {
  escapedChars: number;
  message(): string;
}

function makeRepair(escapedChars: number): CommentRepair {
  return {
    escapedChars,
    message(): string {
      return (
        "comments arrived as a serialized string instead of an array; " +
        `repaired ${String(escapedChars)} unescaped character(s)`
      );
    },
  };
}

function escapeControl(code: number): string {
  switch (code) {
    case 10:
      return "\\n";
    case 13:
      return "\\r";
    case 9:
      return "\\t";
    case 8:
      return "\\b";
    case 12:
      return "\\f";
    default: {
      const hex = "0123456789abcdef";
      return `\\u00${hex[(code >> 4) & 0xf]!}${hex[code & 0xf]!}`;
    }
  }
}

function isHexDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
}

function isLegalEscape(s: string, i: number): boolean {
  if (i >= s.length) return false;
  const c = s.charCodeAt(i);
  // " \ / b f n r t
  if (c === 34 || c === 92 || c === 47 || c === 98 || c === 102 || c === 110 || c === 114 || c === 116) return true;
  if (c === 117) {
    // u + 4 hex
    if (i + 5 > s.length) return false;
    for (let k = i + 1; k < i + 5; k++) {
      if (!isHexDigit(s.charCodeAt(k))) return false;
    }
    return true;
  }
  return false;
}

function nextSignificantByte(s: string, i: number): number {
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 10) continue;
    return i;
  }
  return -1;
}

function isJSONStructural(code: number): boolean {
  return code === 44 || code === 125 || code === 93 || code === 58;
}

/**
 * repairSerializedComments escapes prose quotes, bare controls, and illegal
 * backslashes. Returns repaired text plus escaped count (0 = no repair).
 */
export function repairSerializedComments(s: string): { repaired: string; escaped: number } {
  let out = "";
  let escaped = 0;
  let inString = false;
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (!inString) {
      if (c === 34) inString = true;
      out += s[i]!;
      i++;
      continue;
    }
    if (c === 92) {
      // Backslash
      if (isLegalEscape(s, i + 1)) {
        out += s[i]!;
        i++;
        out += s[i]!;
        i++;
      } else {
        out += "\\\\";
        escaped++;
        i++;
      }
    } else if (c === 34) {
      const next = nextSignificantByte(s, i + 1);
      if (next < 0 || isJSONStructural(s.charCodeAt(next))) {
        inString = false;
        out += s[i]!;
      } else {
        out += '\\"';
        escaped++;
      }
      i++;
    } else if (c < 0x20) {
      out += escapeControl(c);
      escaped++;
      i++;
    } else {
      out += s[i]!;
      i++;
    }
  }
  return { repaired: out, escaped };
}

function countContentFields(original: string): number {
  CONTENT_FIELD_PATTERN.lastIndex = 0;
  let n = 0;
  while (CONTENT_FIELD_PATTERN.exec(original) !== null) n++;
  CONTENT_FIELD_PATTERN.lastIndex = 0;
  return n;
}

function repairedCommentsAcceptable(entries: unknown[], original: string): boolean {
  if (entries.length === 0) return false;
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const obj = raw as Record<string, unknown>;
    const content = typeof obj["content"] === "string" ? (obj["content"] as string) : "";
    if (content.trim() === "") return false;
    for (const field of Object.keys(obj)) {
      if (!KNOWN_COMMENT_FIELDS.has(field)) return false;
    }
  }
  return entries.length >= countContentFields(original);
}

function hasOddQuotes(v: string): boolean {
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    if (v.charCodeAt(i) === 34) n++;
  }
  return n % 2 === 1;
}

function hasSuspectTruncation(entries: unknown[]): boolean {
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    for (const field of COMMENT_TEXT_FIELDS) {
      const v = obj[field];
      if (typeof v === "string" && hasOddQuotes(v)) return true;
    }
  }
  return false;
}

/**
 * parseRepairedComments attempts deterministic repair. Returns null when text
 * needed no repair, still fails to parse, or fails acceptance — caller must
 * keep the original parser error verbatim.
 */
export function parseRepairedComments(s: string): { entries: unknown[]; repair: CommentRepair } | null {
  const { repaired, escaped } = repairSerializedComments(s);
  if (escaped === 0) return null;
  let entries: unknown;
  try {
    entries = JSON.parse(repaired) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  if (!repairedCommentsAcceptable(entries, s)) return null;
  if (hasSuspectTruncation(entries)) return null;
  return { entries, repair: makeRepair(escaped) };
}

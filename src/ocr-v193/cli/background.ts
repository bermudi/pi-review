// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from cmd/opencodereview/background_file.go, review_cmd.go (background handling)
// and cmd/opencodereview/git.go (getCommitMessage) at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later; see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import * as fs from "node:fs";
import * as path from "node:path";

export const BACKGROUND_SOFT_LIMIT = 2000;
export const BACKGROUND_HARD_LIMIT = 8000;
export const BACKGROUND_OPEN_TAG = "<ocr_user_background>";
export const BACKGROUND_CLOSE_TAG = "</ocr_user_background>";
export const MAX_BACKGROUND_FILE_BYTES = 1 << 20; // 1 MB

const MULTI_NEWLINE_RE = /\n{3,}/g;

/**
 * resolveBackgroundFilePath mirrors Go's resolveBackgroundFilePath.
 * Relative paths are anchored at the repo top-level; absolute or empty
 * paths are returned unchanged. An empty repoDir falls back to the
 * relative path itself (cleaned).
 */
export function resolveBackgroundFilePath(repoDir: string, inputPath: string): string {
  if (inputPath === "" || path.isAbsolute(inputPath)) {
    return inputPath;
  }
  // path.join cleans "./" prefix and normalizes separators.
  return path.join(repoDir, inputPath);
}

function isForbiddenChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  // C0 controls except \n \t handled earlier, but keep check for completeness.
  if (cp <= 0x1f) return true;
  if (cp >= 0x7f && cp <= 0x9f) return true;
  // Unicode Cf — format characters (includes explicit list but we use property).
  // Use property escape; if the runtime does not support it, fall back to explicit list.
  try {
    if (/^\p{Cf}$/u.test(ch)) return true;
  } catch {
    // Fallback explicit list when \p{Cf} not supported.
    switch (ch) {
      case "\u200B": // zero-width space
      case "\u200C": // zero-width non-joiner
      case "\u200D": // zero-width joiner
      case "\u200E": // left-to-right mark
      case "\u200F": // right-to-left mark
      case "\u2060": // word joiner
      case "\u00AD": // soft hyphen
      case "\uFEFF": // BOM / zero-width no-break space
        return true;
      default:
        break;
    }
    // Additional Cf ranges not covered by fallback are ignored;
    // fallback is conservative and matches most common invisibles.
  }
  return false;
}

/**
 * sanitizeMarkdown removes forbidden control/invisible characters,
 * normalizes CRLF to LF, collapses 3+ consecutive newlines to two,
 * and trims surrounding whitespace — exactly as Go's sanitizeMarkdown.
 */
export function sanitizeMarkdown(input: string): string {
  let out = "";
  // Reserve capacity roughly; not needed in JS but mirrors Grow.
  for (const ch of input) {
    if (ch === "\n" || ch === "\t") {
      out += ch;
      continue;
    }
    if (ch === "\r") {
      continue;
    }
    if (isForbiddenChar(ch)) {
      continue;
    }
    out += ch;
  }
  out = out.replace(MULTI_NEWLINE_RE, "\n\n");
  return out.trim();
}

/**
 * mergeBackground combines the inline --background value (or an auto-populated
 * commit message) with the wrapped file content produced by loadBackgroundFile.
 * The inline portion is sanitised; the file portion is already wrapped and
 * sanitised, so it is preserved verbatim.
 */
export function mergeBackground(inline: string, fromFile: string): string {
  const cleanedInline = sanitizeMarkdown(inline);
  if (cleanedInline === "") return fromFile;
  if (fromFile === "") return cleanedInline;
  return `${cleanedInline}\n\n${fromFile}`;
}

export interface LoadBackgroundFileOptions {
  readonly stderr?: (message: string) => void;
}

/**
 * processBackgroundContent validates raw background markdown through the
 * shared sanitisation/limits/wrapping pipeline. It is the single
 * sanitation boundary reused by both filesystem and injected-reader paths
 * so they cannot drift. Callers that need stat-before-read (filesystem)
 * must still enforce directory and byte-ceiling via stat before invoking
 * this function; this function also enforces the byte ceiling via
 * Buffer.byteLength for injected content that has no stat.
 */
export function processBackgroundContent(
  raw: string,
  filePath: string,
  options?: LoadBackgroundFileOptions,
): string {
  const stderr = options?.stderr ?? ((msg: string): void => {
    try {
      process.stderr.write(msg);
    } catch {
      // ignore
    }
  });

  const byteLen = Buffer.byteLength(raw, "utf8");
  if (byteLen > MAX_BACKGROUND_FILE_BYTES) {
    throw new Error(
      `background file "${filePath}" is ${byteLen} bytes, exceeding the maximum of ${MAX_BACKGROUND_FILE_BYTES} bytes; please provide a smaller file`,
    );
  }

  const cleaned = sanitizeMarkdown(raw);

  if (cleaned === "") {
    throw new Error(`background file "${filePath}" is empty after sanitisation`);
  }

  if (cleaned.includes(BACKGROUND_OPEN_TAG) || cleaned.includes(BACKGROUND_CLOSE_TAG)) {
    throw new Error(
      `background file "${filePath}" must not contain the reserved delimiters "${BACKGROUND_OPEN_TAG}" or "${BACKGROUND_CLOSE_TAG}"`,
    );
  }

  const runeCount = [...cleaned].length;
  if (runeCount > BACKGROUND_HARD_LIMIT) {
    throw new Error(
      `background content is ${runeCount} characters, exceeding the hard limit of ${BACKGROUND_HARD_LIMIT} (aborting)`,
    );
  } else if (runeCount > BACKGROUND_SOFT_LIMIT) {
    stderr(
      `[pi-review] --background-file content is ${runeCount} characters, exceeding the recommended ${BACKGROUND_SOFT_LIMIT} (continuing but review quality might be impacted)\n`,
    );
  }

  return `${BACKGROUND_OPEN_TAG}\n${cleaned}\n${BACKGROUND_CLOSE_TAG}`;
}

/**
 * loadBackgroundFile reads and validates a background file, mirroring Go's
 * loadBackgroundFile semantics: directory/oversize rejection before reading
 * (stat-before-read), sanitisation, empty/reserved-delimiter/hard-limit
 * rejection, soft-limit warning to stderr, and wrapping with delimiters.
 * Limits apply to cleaned rune count, not the wrapped length.
 */
export function loadBackgroundFile(
  filePath: string,
  options?: LoadBackgroundFileOptions,
): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`read background file "${filePath}": ${msg}`);
  }

  if (stat.isDirectory()) {
    throw new Error(`background file "${filePath}" is a directory, not a file`);
  }

  if (stat.size > MAX_BACKGROUND_FILE_BYTES) {
    throw new Error(
      `background file "${filePath}" is ${stat.size} bytes, exceeding the maximum of ${MAX_BACKGROUND_FILE_BYTES} bytes; please provide a smaller file`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`read background file "${filePath}": ${msg}`);
  }

  return processBackgroundContent(raw, filePath, options);
}

// getCommitMessage is the single Git source of truth; background re-exports it for
// backward compatibility so existing `from "./background.js"` imports keep working.
export { getCommitMessage } from "./git.js";

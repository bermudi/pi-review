// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/agent/util.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { spawnSync } from "node:child_process";
import { countTokens as countTokensImpl, extractText } from "../llmloop/compression.js";
import type { Message } from "../llmloop/compression.js";

// ---------------------------------------------------------------------------
// Plan block stripping — mirrors Go planBlockPattern / stripEmptyPlanBlock
// ---------------------------------------------------------------------------

/**
 * Pattern matching the optional "Review Plan" section in a MAIN_TASK template
 * user message: a header line beginning with "### " whose text contains
 * "Review Plan" (with an optional "(Optional)" suffix), the
 * `{{plan_guidance}}` placeholder on its own line, and one trailing blank line.
 *
 * Ported from Go:
 * ```go
 * var planBlockPattern = regexp.MustCompile(
 *   `(?m)^### [^\n]*Review Plan[^\n]*\n\{\{plan_guidance\}\}\n\n?`)
 * ```
 */
export const planBlockPattern: RegExp =
  /^### [^\n]*Review Plan[^\n]*\n\{\{plan_guidance\}\}\n\n?/m;

/**
 * Global version for replacement (Go's ReplaceAllString is global, and `(?m)`
 * is multiline). We emulate by adding `g` + `m`.
 */
const planBlockPatternGlobal = new RegExp(planBlockPattern.source, "gm");

/**
 * stripEmptyPlanBlock removes the "### Review Plan ...\n{{plan_guidance}}\n\n"
 * wrapper from a MAIN_TASK user message when the plan phase produced no
 * guidance. No-op when the wrapper is absent.
 */
export function stripEmptyPlanBlock(content: string): string {
  return content.replace(planBlockPatternGlobal, "");
}

// ---------------------------------------------------------------------------
// Markdown fence stripping — mirrors Go stripMarkdownFences
// ---------------------------------------------------------------------------

export function stripMarkdownFences(s: string): string {
  let out = s.trim();
  if (out.startsWith("```")) {
    const nl = out.indexOf("\n");
    if (nl >= 0) {
      out = out.slice(nl + 1);
    } else {
      if (out.startsWith("```json")) out = out.slice("```json".length);
      else if (out.startsWith("```")) out = out.slice("```".length);
    }
  }
  out = out.trim();
  if (out.endsWith("```")) {
    out = out.slice(0, -"```".length);
    out = out.trim();
  }
  return out;
}

export const StripMarkdownFences = stripMarkdownFences;

// ---------------------------------------------------------------------------
// Message helpers — mirrors Go buildMessageXML / copyMessages / countMessagesTokens
// ---------------------------------------------------------------------------

export function buildMessageXML(msgs: readonly Message[]): string {
  let sb = "";
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m === undefined) continue;
    sb += `<message id="${i}" role="${m.role}">\n`;
    sb += "    <content>\n";
    sb += `      ${extractText(m)}\n`;
    sb += "    </content>\n";
    sb += "</message>";
    if (i < msgs.length - 1) sb += "\n";
  }
  return sb;
}

export function copyMessages(msgs: readonly Message[]): Message[] {
  return msgs.map((m) => ({
    role: m.role,
    content: m.content,
    tool_call_id: m.tool_call_id,
    tool_calls: m.tool_calls !== undefined ? [...m.tool_calls] : undefined,
  }));
}

export function countMessagesTokens(msgs: readonly Message[]): number {
  let total = 0;
  for (const m of msgs) {
    total += countTokensImpl(extractText(m));
  }
  return total;
}

// Re-export CountMessagesTokens alias for callers that use Go naming.
export const CountMessagesTokens = countMessagesTokens;

// ---------------------------------------------------------------------------
// Review mode helpers — mirrors Go reviewModeString
// ---------------------------------------------------------------------------

export const ReviewModeWorkspace = "workspace" as const;
export const ReviewModeRange = "range" as const;
export const ReviewModeCommit = "commit" as const;

export type ReviewMode = typeof ReviewModeWorkspace | typeof ReviewModeRange | typeof ReviewModeCommit;

export function reviewModeString(from: string, to: string, commit: string): string {
  if (commit !== "") return ReviewModeCommit;
  if (from !== "" && to !== "") return ReviewModeRange;
  return ReviewModeWorkspace;
}

export const ReviewModeString = reviewModeString;

// ---------------------------------------------------------------------------
// Git branch detection — mirrors Go detectGitBranch
// ---------------------------------------------------------------------------

/**
 * detectGitBranch returns the current git branch name for the given repo,
 * or empty string on failure. Synchronous variant using spawnSync for
 * simplicity; the async Go version uses exec.CommandContext with a 5s timeout.
 */
export function detectGitBranch(repoDir: string): string {
  try {
    const result = spawnSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.error !== undefined && result.error !== null) return "";
    if (result.status !== 0) return "";
    const out: string = typeof result.stdout === "string" ? result.stdout : "";
    if (out.length === 0) return "";
    return out.trim();
  } catch {
    return "";
  }
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Independent pi-reviewer command — not ported from Open Code Review.
//
// `pi-review findings` replays the findings recorded by a previous local
// review or scan without any model or Git activity. Every run persists its
// final (post-filter) comments as JSONL session records under
// ~/.opencodereview/sessions/<encoded-repo>/<session-id>.jsonl; this command
// reads the most recent session for the resolved repository (or a named one)
// and re-renders it in the same text/JSON/SARIF shapes the review command
// emits. Reading is a pure local operation: no repository mutation, no
// model calls, no network.

import type { LlmComment, LlmCommentJson } from "../model/review.js";
import { llmCommentToJson } from "../model/review.js";
import type { Summary } from "../session/resume.js";
import { ListSessions, LoadComments } from "../session/resume.js";
import type { CliIo, FindingsOptions } from "./shared.js";
import { outputText, manifestMessage } from "./output.js";
import { outputSarifText } from "./sarif.js";
import { describeFiles, describeStart, displayMode } from "./session.js";
import { resolveColor } from "./color.js";

// ---------------------------------------------------------------------------
// Session selection
// ---------------------------------------------------------------------------

/**
 * Picks the session to replay. `ListSessions` returns summaries sorted
 * newest-first, so the default "previous review" is simply the first entry.
 * A named session must match a listed session exactly; resolving ids through
 * the listing (instead of building a path from raw input) keeps untrusted
 * ids from ever reaching path construction.
 */
export function selectFindingsSession(summaries: readonly Summary[], sessionId: string): Summary | null {
  if (sessionId !== "") {
    return summaries.find((s) => s.sessionId === sessionId) ?? null;
  }
  return summaries[0] ?? null;
}

// ---------------------------------------------------------------------------
// Status / range — one derivation shared by the text header and JSON envelope
// ---------------------------------------------------------------------------

/**
 * Terminal status of the recorded session. Mirrors the manifest terminal
 * states; sessions that never wrote a `session_end` record are "aborted",
 * pre-manifest sessions are "legacy". Partial runs still carry real findings,
 * so they are displayed — never hidden — but always labeled.
 */
export function findingsStatus(summary: Summary): string {
  if (summary.aborted) return "aborted";
  const manifest = summary.runManifest;
  if (manifest !== null && manifest !== undefined) {
    const state = manifest.terminalState;
    if (state === "complete" || state === "partial" || state === "failed" || state === "skipped") return state;
    return "unknown";
  }
  return "legacy";
}

/** What the run covered: "from..to", a commit hash, or null when not applicable. */
export function findingsRange(summary: Summary): string | null {
  switch (summary.reviewMode) {
    case "range": {
      const from = summary.diffFrom ?? "";
      const to = summary.diffTo ?? "";
      return from !== "" || to !== "" ? `${from}..${to}` : null;
    }
    case "commit":
      return summary.diffCommit !== undefined && summary.diffCommit !== "" ? summary.diffCommit : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Text header
// ---------------------------------------------------------------------------

export function findingsHeaderText(summary: Summary, commentCount: number): string {
  const like = summary as Summary & Record<string, unknown>;
  const lines: string[] = [`Findings from session ${summary.sessionId}`];
  lines.push(`  Mode:      ${displayMode(summary.reviewMode ?? "")}`);
  const range = findingsRange(summary);
  if (range !== null) lines.push(`  Range:     ${range}`);
  if (summary.model !== undefined && summary.model !== "") lines.push(`  Model:     ${summary.model}`);
  lines.push(`  Started:   ${describeStart(like)}`);
  lines.push(`  Status:    ${findingsStatus(summary)}`);
  lines.push(`  Files:     ${describeFiles(like)}`);
  lines.push(`  Findings:  ${String(commentCount)}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// JSON envelope — comments use the exact snake_case shape of `review --format json`
// ---------------------------------------------------------------------------

export interface FindingsJsonEnvelope {
  readonly status: string;
  readonly session_id: string;
  readonly review_mode: string | null;
  readonly range: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly message: string;
  readonly comments: LlmCommentJson[];
}

export function findingsMessage(summary: Summary, commentCount: number): string {
  const manifest = summary.runManifest;
  if (manifest !== null && manifest !== undefined) return manifestMessage(manifest, commentCount);
  if (commentCount === 0) return "No comments generated. Looks good to me.";
  return `${String(commentCount)} finding(s) recorded.`;
}

export function findingsJsonEnvelope(summary: Summary, comments: readonly LlmComment[]): FindingsJsonEnvelope {
  return {
    status: findingsStatus(summary),
    session_id: summary.sessionId,
    review_mode: summary.reviewMode ?? null,
    range: findingsRange(summary),
    started_at: summary.startTime !== null ? summary.startTime.toISOString() : null,
    ended_at: summary.endTime !== null ? summary.endTime.toISOString() : null,
    message: findingsMessage(summary, comments.length),
    comments: comments.map(llmCommentToJson),
  };
}

export function findingsJsonText(summary: Summary, comments: readonly LlmComment[]): string {
  return `${JSON.stringify(findingsJsonEnvelope(summary, comments), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export interface FindingsContext {
  readonly io: CliIo;
  readonly opts: FindingsOptions;
  readonly version: string;
}

export function runFindingsContext(ctx: FindingsContext): number {
  const { io, opts } = ctx;

  // The session store is keyed exactly like the review run path keys it
  // (createReviewRunnerFactory): the raw --repo value, or the absolute cwd
  // when absent. Mirroring that derivation means `findings` sees precisely
  // the sessions `--resume` would see from the same invocation context.
  // (Scan factories resolve relative --repo values before keying; that
  // upstream divergence is inherited, not normalized here.)
  const repoDir = opts.repoDir !== "" ? opts.repoDir : io.cwd();

  let summaries: Summary[];
  try {
    summaries = ListSessions(repoDir);
  } catch (err) {
    io.stderr(`Error: reading review sessions for ${repoDir}: ${String((err as Error).message)}\n`);
    return 1;
  }

  if (summaries.length === 0) {
    io.stderr(`No previous review or scan sessions found for ${repoDir}. Run 'pi-review review' or 'pi-review scan' first.\n`);
    return 1;
  }

  const selected = selectFindingsSession(summaries, opts.sessionId);
  if (selected === null) {
    io.stderr(`Error: unknown session "${opts.sessionId}" for repository ${repoDir}\n`);
    return 1;
  }

  let comments: LlmComment[];
  try {
    comments = LoadComments(repoDir, selected.sessionId);
  } catch (err) {
    io.stderr(`Error: reading session ${selected.sessionId}: ${String((err as Error).message)}\n`);
    return 1;
  }

  // Machine formats are exactly one ANSI-free document on stdout; the text
  // header honors the persistent --color flag like review does.
  if (opts.outputFormat === "json") {
    io.stdout(findingsJsonText(selected, comments));
    return 0;
  }
  if (opts.outputFormat === "sarif") {
    io.stdout(outputSarifText(comments, ctx.version, [], selected.runManifest));
    return 0;
  }

  const colorEnabled = resolveColor(opts.color, io.env()["TERM"], io.stdoutIsTTY?.() ?? false);
  io.stdout(`${findingsHeaderText(selected, comments.length)}\n${outputText(comments, colorEnabled)}`);
  return 0;
}

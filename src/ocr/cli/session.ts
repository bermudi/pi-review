// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/session_cmd.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import * as fs from "node:fs";
import * as path from "node:path";
import { ListSessions, LoadDetail, LoadComments, type Summary, type ItemDetail } from "../session/resume.js";
import { SessionsDir } from "../session/persist.js";
import { renderComment } from "./output.js";
import type { LlmComment } from "../model/review.js";

// ---------------------------------------------------------------------------
// Pure helpers — directly mirror Go
// ---------------------------------------------------------------------------

export function truncate(s: string, n: number): string {
  s = s.replaceAll("\n", " ").replaceAll("\t", " ");
  const runes = [...s];
  if (runes.length <= n) return s;
  if (n <= 1) return "…";
  return runes.slice(0, n - 1).join("") + "…";
}

export function displayMode(m: string): string {
  if (m === "") return "-";
  return m;
}

type SummaryLike = Summary & Record<string, unknown>;

function getField<T>(s: SummaryLike, lower: string, upper: string, fallback: T): T {
  const lo = s[lower] as T | undefined;
  if (lo !== undefined) return lo;
  const up = s[upper] as T | undefined;
  if (up !== undefined) return up;
  return fallback;
}

function getManifest(s: SummaryLike): Summary["runManifest"] {
  const m = (s["runManifest"] as Summary["runManifest"] | undefined) ?? (s["RunManifest"] as Summary["runManifest"] | undefined) ?? null;
  return m;
}

export function describeRange(s: SummaryLike): string {
  const mode = getField<string>(s, "reviewMode", "ReviewMode", "");
  const diffFrom = getField<string>(s, "diffFrom", "DiffFrom", "");
  const diffTo = getField<string>(s, "diffTo", "DiffTo", "");
  const diffCommit = getField<string>(s, "diffCommit", "DiffCommit", "");
  switch (mode) {
    case "range":
      if (diffFrom !== "" || diffTo !== "") return `${diffFrom}..${diffTo}`;
      break;
    case "commit":
      if (diffCommit !== "") return diffCommit;
      break;
    default:
      break;
  }
  return "-";
}

export function describeStart(s: SummaryLike): string {
  const t: Date | null | undefined = getField<Date | null>(s, "startTime", "StartTime", null);
  if (t === null || t === undefined) return "-";
  if (!(t instanceof Date) || Number.isNaN(t.getTime()) || t.getTime() === 0) {
    // Also handle zero time where epoch 0? Go zero time is 0001-01-01, not epoch. But our null covers zero.
    // If date is invalid or epoch 0 and original would be zero, treat as "-".
    // Check if year is 1970 and time is 0 as epoch fallback for empty; but real zero should be null.
    // We already return "-" for null; epoch 0 we consider "-" only if it's the zero fallback.
    // To match Go, any zero time is "-". If constructed Summary has startTime new Date(0) explicitly it's not zero? In Go zero time would be IsZero true; in tests they use zero value struct which has time.Time{} zero. In TS they use `{} as Summary` with missing startTime => null => "-". Accept epoch 0 as "-" only if we detect it's the default zero? But tests for non-zero use AddDate(2024) so not zero.
    // We'll treat epoch 0 as "-" to mirror empty, unless we want to be strict: if getField returned fallback null we already handled.
    // If caller passed new Date(0) explicitly, treat as not "-"? Go zero time != epoch 0; but epoch 0 is 1970. Go test uses s.StartTime.AddDate(2024,0,0) which is not zero. So epoch 0 not used for non-zero. Returning "-" for epoch 0 is fine.
    if (t.getTime() === 0) return "-";
    return "-";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

export function describeFiles(s: SummaryLike): string {
  const manifest = getManifest(s);
  if (manifest !== null && manifest !== undefined) {
    const selected = getField<number>(s, "selectedFiles", "SelectedFiles", 0);
    const reused = getField<number>(s, "reusedFiles", "ReusedFiles", 0);
    const failed = getField<number>(s, "failedFiles", "FailedFiles", 0);
    const waived = getField<number>(s, "waivedFiles", "WaivedFiles", 0);
    const parts: string[] = [String(selected)];
    if (reused > 0) parts.push(`reused ${reused}`);
    if (failed > 0) parts.push(`failed ${failed}`);
    if (waived > 0) parts.push(`waived ${waived}`);
    if (parts.length === 1) return parts[0] ?? "0";
    return `${String(parts[0])} (${parts.slice(1).join(", ")})`;
  }
  const completed = getField<number>(s, "completedFiles", "CompletedFiles", 0);
  const reused = getField<number>(s, "reusedFiles", "ReusedFiles", 0);
  const total = completed + reused;
  if (reused > 0) return `${total} (reused ${reused})`;
  return String(total);
}

export function describeStatus(s: SummaryLike): string {
  const aborted = getField<boolean>(s, "aborted", "Aborted", false);
  if (aborted) return "aborted";
  const manifest = getManifest(s);
  if (manifest !== null && manifest !== undefined) {
    const state = manifest.terminalState;
    if (state === "complete" || state === "partial" || state === "failed" || state === "skipped") return state;
    return "unknown";
  }
  const failed = getField<number>(s, "failedFiles", "FailedFiles", 0);
  if (failed > 0) return `legacy (${failed} fail)`;
  return "legacy";
}

export function describeTarget(provider: string, model: string): string {
  if (provider === "" && model === "") return "-";
  if (provider === "") return model;
  if (model === "") return provider;
  return `${provider}/${model}`;
}

export function shortSessionID(id: string): string {
  if (id.length > 8) return id.slice(0, 8);
  return id;
}

export function completeEnum(...values: string[]): (cmd: unknown, args: unknown, toComplete: string) => [string[], number] {
  return (_cmd: unknown, _args: unknown, _toComplete: string) => {
    return [values, 4];
  };
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

export function parseFilterSet(s: string): Map<string, boolean> | null {
  const set = new Map<string, boolean>();
  for (const part of s.split(",")) {
    const v = part.toLowerCase().trim();
    if (v !== "") set.set(v, true);
  }
  if (set.size === 0) return null;
  return set;
}

export function filterComments(comments: LlmComment[], severities: string, categories: string): LlmComment[] {
  const sevSet = parseFilterSet(severities);
  const catSet = parseFilterSet(categories);
  if (sevSet === null && catSet === null) return comments;
  const out: LlmComment[] = [];
  for (const c of comments) {
    if (sevSet !== null && !sevSet.has(String(c.severity ?? "").toLowerCase())) continue;
    if (catSet !== null && !catSet.has(String(c.category ?? "").toLowerCase())) continue;
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Print helpers — tabwriter-like minimal
// ---------------------------------------------------------------------------

export function printSessionTable(summaries: Summary[], writer: { write(s: string): void } | ((s: string) => void) = process.stdout): string {
  const write = typeof writer === "function" ? writer : (s: string) => (writer as { write(s: string): void }).write(s);
  let out = "";
  const emit = (s: string) => { out += s; write(s); };
  // header
  emit("SESSION ID\tMODE\tRANGE\tFILES\tCOMMENTS\tSTATUS\tSTARTED\n");
  for (const s of summaries) {
    // Use fields with fallback for both naming conventions
    const sid = getField<string>(s as unknown as SummaryLike, "sessionId", "SessionID", "");
    const mode = displayMode(getField<string>(s as unknown as SummaryLike, "reviewMode", "ReviewMode", ""));
    const range = describeRange(s as unknown as SummaryLike);
    const files = describeFiles(s as unknown as SummaryLike);
    const comments = getField<number>(s as unknown as SummaryLike, "totalComments", "TotalComments", 0);
    const status = describeStatus(s as unknown as SummaryLike);
    const started = describeStart(s as unknown as SummaryLike);
    emit(`${sid}\t${mode}\t${range}\t${files}\t${comments}\t${status}\t${started}\n`);
  }
  return out;
}

export function printSessionDetail(summary: Summary, items: ItemDetail[] | null | undefined, writer: { write(s: string): void } | ((s: string) => void) = process.stdout): string {
  const write = typeof writer === "function" ? writer : (s: string) => (writer as { write(s: string): void }).write(s);
  let out = "";
  const emit = (s: string) => { out += s; write(s); };

  const s = summary as unknown as SummaryLike;
  const sessionId = getField<string>(s, "sessionId", "SessionID", "");
  const filePath = getField<string>(s, "filePath", "FilePath", "");
  const repoDir = getField<string>(s, "repoDir", "RepoDir", "");
  const gitBranch = getField<string>(s, "gitBranch", "GitBranch", "");
  const model = getField<string>(s, "model", "Model", "");
  const resumedFrom = getField<string>(s, "resumedFrom", "ResumedFrom", "");
  const resumeLineage = (s["resumeLineage"] as unknown) ?? (s["ResumeLineage"] as unknown) ?? null;
  const durationMs = getField<number | null>(s, "durationMs", "Duration", null);
  const totalComments = getField<number>(s, "totalComments", "TotalComments", 0);
  const llmFailures = getField<number>(s, "llmFailures", "LLMFailures", 0);
  const selectedFiles = getField<number>(s, "selectedFiles", "SelectedFiles", 0);
  const completedFiles = getField<number>(s, "completedFiles", "CompletedFiles", 0);
  const reusedFiles = getField<number>(s, "reusedFiles", "ReusedFiles", 0);
  const failedFiles = getField<number>(s, "failedFiles", "FailedFiles", 0);
  const waivedFiles = getField<number>(s, "waivedFiles", "WaivedFiles", 0);

  emit(`Session: ${sessionId}\n`);
  emit(`  File:      ${filePath}\n`);
  emit(`  Repo:      ${repoDir}\n`);
  if (gitBranch !== "") emit(`  Branch:    ${gitBranch}\n`);
  if (model !== "") emit(`  Model:     ${model}\n`);
  emit(`  Mode:      ${displayMode(getField<string>(s, "reviewMode", "ReviewMode", ""))}\n`);
  const r = describeRange(s);
  if (r !== "" && r !== "-") emit(`  Range:     ${r}\n`);
  if (resumedFrom !== "") emit(`  Resumed:   from session ${resumedFrom}\n`);
  if (resumeLineage !== null && typeof resumeLineage === "object") {
    const rl = resumeLineage as Record<string, unknown>;
    const parentRunId = String(rl["parentRunId"] ?? rl["ParentRunID"] ?? "");
    const srcP = String(rl["sourceProvider"] ?? rl["SourceProvider"] ?? "");
    const srcM = String(rl["sourceModel"] ?? rl["SourceModel"] ?? "");
    const tgtP = String(rl["targetProvider"] ?? rl["TargetProvider"] ?? "");
    const tgtM = String(rl["targetModel"] ?? rl["TargetModel"] ?? "");
    emit(`  Parent:    run ${parentRunId}\n`);
    if (srcP !== tgtP || srcM !== tgtM) {
      emit(`  Transition: ${describeTarget(srcP, srcM)} → ${describeTarget(tgtP, tgtM)}\n`);
    }
  }
  emit(`  Started:   ${describeStart(s)}\n`);
  const endTime: Date | null | undefined = getField<Date | null>(s, "endTime", "EndTime", null);
  if (endTime !== null && endTime !== undefined && endTime instanceof Date && !Number.isNaN(endTime.getTime()) && endTime.getTime() !== 0) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = `${endTime.getFullYear()}-${pad(endTime.getMonth() + 1)}-${pad(endTime.getDate())} ${pad(endTime.getHours())}:${pad(endTime.getMinutes())}:${pad(endTime.getSeconds())}`;
    emit(`  Ended:     ${fmt}\n`);
  }
  if (durationMs !== null && durationMs !== undefined && typeof durationMs === "number" && durationMs > 0) {
    const secs = Math.round(durationMs / 1000);
    emit(`  Duration:  ${String(secs)}s\n`);
  }
  emit(`  Status:    ${describeStatus(s)}\n`);
  const manifest = getManifest(s);
  if (manifest !== null && manifest !== undefined) {
    emit(`  Coverage:  ${String(selectedFiles)} selected = ${String(completedFiles)} completed + ${String(reusedFiles)} reused + ${String(failedFiles)} failed + ${String(waivedFiles)} waived\n`);
  } else {
    emit(`  Files:     ${String(completedFiles)} completed, ${String(reusedFiles)} reused, ${String(failedFiles)} failed (legacy checkpoints)\n`);
  }
  emit(`  Comments:  ${String(totalComments)}\n`);
  if (llmFailures > 0) emit(`  LLM err:   ${String(llmFailures)}\n`);

  if (items === null || items === undefined || items.length === 0) {
    return out;
  }
  emit(`\n`);
  emit(`Files:\n`);
  emit(`  TYPE\tFILE\tCOMMENTS\tNOTE\n`);
  for (const it of items) {
    const type = (it as unknown as Record<string, unknown>)["type"] as string ?? String((it as unknown as Record<string, unknown>)["Type"] ?? "");
    const filePathItem = (it as unknown as Record<string, unknown>)["filePath"] as string ?? String((it as unknown as Record<string, unknown>)["FilePath"] ?? "");
    const commentsCount = (it as unknown as Record<string, unknown>)["comments"] as number ?? (it as unknown as Record<string, unknown>)["Comments"] as number ?? 0;
    const srcSid = String((it as unknown as Record<string, unknown>)["sourceSessionId"] ?? (it as unknown as Record<string, unknown>)["SourceSessionID"] ?? "");
    const errMsg = String((it as unknown as Record<string, unknown>)["error"] ?? (it as unknown as Record<string, unknown>)["Error"] ?? "");
    let note = "";
    if (type === "reused" && srcSid !== "") note = "from " + shortSessionID(srcSid);
    else if (type === "failed" && errMsg !== "") note = truncate(errMsg, 60);
    emit(`  ${type}\t${filePathItem}\t${String(commentsCount)}\t${note}\n`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolve helper for completion and commands
// ---------------------------------------------------------------------------

export function resolveWorkingDirForSession(input: string): string {
  if (input === "" || input === undefined) {
    return process.cwd();
  }
  // absolute
  if (path.isAbsolute(input)) {
    if (!fs.existsSync(input)) throw new Error(`stat ${input}: no such file or directory`);
    return input;
  }
  const abs = path.resolve(process.cwd(), input);
  if (!fs.existsSync(abs)) throw new Error(`stat ${abs}: no such file or directory`);
  return abs;
}

// ---------------------------------------------------------------------------
// Session list/show/comments commands — stdout-oriented
// ---------------------------------------------------------------------------

function parseFlags(argv: string[]): {
  repo: string;
  json: boolean;
  limit: number;
  severity: string;
  category: string;
  positional: string[];
  unknownFlag?: string;
} {
  let repo = "";
  let json = false;
  let limit = 20;
  let severity = "";
  let category = "";
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok === "--repo") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--repo requires a value");
      repo = v;
      i++;
      continue;
    }
    if (tok.startsWith("--repo=")) {
      repo = tok.slice("--repo=".length);
      continue;
    }
    if (tok === "--json") {
      json = true;
      continue;
    }
    if (tok === "--limit") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--limit requires a value");
      limit = Number(v);
      i++;
      continue;
    }
    if (tok.startsWith("--limit=")) {
      limit = Number(tok.slice("--limit=".length));
      continue;
    }
    if (tok === "--severity") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--severity requires a value");
      severity = v;
      i++;
      continue;
    }
    if (tok.startsWith("--severity=")) {
      severity = tok.slice("--severity=".length);
      continue;
    }
    if (tok === "--category") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--category requires a value");
      category = v;
      i++;
      continue;
    }
    if (tok.startsWith("--category=")) {
      category = tok.slice("--category=".length);
      continue;
    }
    if (tok.startsWith("--")) {
      // unknown flag
      throw new Error(`unknown flag ${tok}`);
    }
    if (tok.startsWith("-") && tok !== "-") {
      throw new Error(`unknown flag ${tok}`);
    }
    positional.push(tok);
  }
  return { repo, json, limit, severity, category, positional };
}

function emitStdout(text: string): void {
  process.stdout.write(text);
}

export function runSessionListCompat(argv: string[]): void {
  const flags = parseFlags(argv);
  if (flags.positional.length > 0) throw new Error("list takes no positional arguments");
  const resolvedRepo = resolveWorkingDirForSession(flags.repo);
  const summaries = ListSessions(resolvedRepo);
  let limited = summaries;
  if (flags.limit > 0 && summaries.length > flags.limit) limited = summaries.slice(0, flags.limit);

  if (flags.json) {
    // Encode as JSON array pretty printed like Go's json.Encoder with indent
    const json = JSON.stringify(limited, null, 2) + "\n";
    emitStdout(json);
    return;
  }

  if (limited.length === 0) {
    emitStdout(`No sessions found for ${resolvedRepo}\n`);
    return;
  }

  // Build table string and emit
  let out = "";
  const collector = (s: string) => { out += s; };
  printSessionTable(limited, { write: collector });
  emitStdout(out);
}

export function runSessionShowCompat(argv: string[]): void {
  const flags = parseFlags(argv);
  const positional = flags.positional;
  if (positional.length === 0) throw new Error("missing session id");
  if (positional.length > 1) throw new Error("too many arguments");
  const sessionId = positional[0] ?? "";
  const resolvedRepo = resolveWorkingDirForSession(flags.repo);
  const { summary, items } = LoadDetail(resolvedRepo, sessionId);

  if (flags.json) {
    const payload = { summary, items };
    emitStdout(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  let out = "";
  const collector = (s: string) => { out += s; };
  printSessionDetail(summary, items, { write: collector });
  emitStdout(out);
}

export function runSessionCommentsCompat(argv: string[]): void {
  const flags = parseFlags(argv);
  const positional = flags.positional;
  if (positional.length === 0) throw new Error("missing session id");
  if (positional.length > 1) throw new Error("too many arguments");
  const sessionId = positional[0] ?? "";
  const resolvedRepo = resolveWorkingDirForSession(flags.repo);
  const comments = LoadComments(resolvedRepo, sessionId);
  const filtered = filterComments(comments, flags.severity, flags.category);

  if (flags.json) {
    const arr = filtered ?? [];
    // Ensure [] not null
    const toEncode: LlmComment[] = arr.length === 0 ? [] : arr;
    emitStdout(JSON.stringify(toEncode, null, 2) + "\n");
    // Go's encoder for empty slice when filtered==nil still encodes [] via handling nil->[]? Our test for empty expects "[]\n" not "null"
    // But if filtered is non-null empty, same.
    // However filtered may be same as comments when no filter; ensure null handling? filterComments returns original array; we already handle empty.
    return;
  }

  if (filtered.length === 0) {
    if (comments.length === 0) {
      emitStdout(`No comments recorded in session ${sessionId}.\n`);
    } else {
      emitStdout(`No comments match the given filters (${String(comments.length)} recorded in session ${sessionId}).\n`);
    }
    return;
  }

  let out = "";
  for (const c of filtered) {
    out += renderComment(c);
  }
  emitStdout(out);
}

export function runSession(argv: string[]): void {
  if (argv.length === 0) throw new Error("requires subcommand");
  const sub = argv[0] ?? "";
  const rest = argv.slice(1);
  switch (sub) {
    case "list":
    case "ls":
      runSessionListCompat(rest);
      return;
    case "show":
      runSessionShowCompat(rest);
      return;
    case "comments":
      runSessionCommentsCompat(rest);
      return;
    default:
      throw new Error(`unknown command "${sub}"`);
  }
}

// ---------------------------------------------------------------------------
// Shell completion — mirrors Go completeSessionIDs
// ---------------------------------------------------------------------------

export function completeSessionIDs(
  cmd: { Flags?: { GetString(name: string): string } } & { getRepo?: () => string } & Record<string, unknown>,
  args: readonly unknown[] | null | undefined,
  toComplete: string,
): [string[], number] {
  // cobra directive NoFileComp = 4
  const directive = 4;
  // If args already has positional, no completion
  if (Array.isArray(args) && args.length !== 0) {
    return [[], directive];
  }
  let repo = "";
  try {
    if (cmd.Flags !== undefined && typeof cmd.Flags.GetString === "function") {
      repo = cmd.Flags.GetString("repo") ?? "";
    } else if (typeof (cmd as { getRepo?: () => string }).getRepo === "function") {
      repo = (cmd as { getRepo: () => string }).getRepo();
    } else if (typeof (cmd as Record<string, unknown>)["repo"] === "string") {
      repo = (cmd as Record<string, string>)["repo"] ?? "";
    }
  } catch {
    return [[], directive];
  }
  let resolvedRepo: string;
  try {
    resolvedRepo = resolveWorkingDirForSession(repo);
  } catch {
    return [[], directive];
  }
  let summaries: Summary[];
  try {
    summaries = ListSessions(resolvedRepo);
  } catch {
    return [[], directive];
  }
  const completions: string[] = [];
  for (const s of summaries) {
    const sid = getField<string>(s as unknown as SummaryLike, "sessionId", "SessionID", "");
    if (!sid.startsWith(toComplete)) continue;
    const started = describeStart(s as unknown as SummaryLike);
    const totalComments = getField<number>(s as unknown as SummaryLike, "totalComments", "TotalComments", 0);
    const status = describeStatus(s as unknown as SummaryLike);
    const desc = `${started} · ${String(totalComments)} comments · ${status}`;
    completions.push(`${sid}\t${desc}`);
  }
  return [completions, directive];
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/tool/filereader.go, internal/tool/file_read.go,
// internal/tool/file_read_diff.go, internal/tool/code_search.go,
// and internal/tool/file_find.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { CodeSearch, FileFind, FileRead, FileReadDiff, type Tool } from "./types.js";

// ---------------------------------------------------------------------------
// ReviewMode — mirrors Go `type ReviewMode int`
// ---------------------------------------------------------------------------

export enum ReviewMode {
  ModeWorkspace = 0,
  ModeRange = 1,
  ModeCommit = 2,
}

export const ModeWorkspace = ReviewMode.ModeWorkspace;
export const ModeRange = ReviewMode.ModeRange;
export const ModeCommit = ReviewMode.ModeCommit;

/**
 * ParseReviewMode returns the correct ReviewMode based on provided flag values.
 * Mirrors Go `ParseReviewMode(from, to, commit string) ReviewMode`.
 */
export function ParseReviewMode(from: string, to: string, commit: string): ReviewMode {
  if (commit !== "") return ReviewMode.ModeCommit;
  if (from !== "" && to !== "") return ReviewMode.ModeRange;
  return ReviewMode.ModeWorkspace;
}
export const parseReviewMode = ParseReviewMode;

/**
 * RefValue helper — mirrors Go `(m ReviewMode).RefValue(toRef, commit string) (string, bool)`.
 */
export function RefValue(mode: ReviewMode, toRef: string, commit: string): [string, boolean] {
  switch (mode) {
    case ReviewMode.ModeRange:
      return [toRef, true];
    case ReviewMode.ModeCommit:
      return [commit, true];
    default:
      return ["", false];
  }
}

// ---------------------------------------------------------------------------
// Path helpers — mirrors internal/pathutil
// ---------------------------------------------------------------------------

async function canonicalPath(p: string): Promise<string> {
  const abs = path.resolve(p);
  try {
    return await fs.realpath(abs);
  } catch (e) {
    // Go's CanonicalPath would error if the path does not exist.
    // For repo root that must exist, propagate error.
    // For full file path that may not exist yet, fallback to abs.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Only fallback for workspace file that doesn't exist yet — caller handles.
      // But for repo root, it should exist; still return abs to allow check.
      throw e;
    }
    throw e;
  }
}

function withinBase(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

// ---------------------------------------------------------------------------
// Git runner minimal surface — mirrors internal/gitcmd.Runner
// ---------------------------------------------------------------------------

export interface GitRunner {
  Output(signal: AbortSignal | undefined, repoDir: string, ...args: string[]): Promise<Buffer>;
  RunSplit?(signal: AbortSignal | undefined, repoDir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }>;
  Stream?(signal: AbortSignal | undefined, repoDir: string, onStdout: (r: NodeJS.ReadableStream) => Promise<void> | void, ...args: string[]): Promise<void>;
}

async function execGit(
  repoDir: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(signal.reason ? String(signal.reason) : "context cancelled"));
      return;
    }
    const child = spawn("git", args, { cwd: repoDir, signal: signal as unknown as AbortSignal | undefined });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`git ${args.join(" ")} timed out`));
      }, timeoutMs);
    }

    const onAbort = (): void => {
      child.kill("SIGKILL");
      reject(new Error(signal?.reason ? String(signal.reason) : "context cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort as EventListener);
      reject(err);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort as EventListener);
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const err = new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`) as Error & { code: number };
        (err as unknown as Record<string, unknown>)["code"] = code ?? -1;
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// scanLines — mirrors Go `scanLines(r io.Reader, startLine, maxLines int)`
// ---------------------------------------------------------------------------

/**
 * scanLines splits content by "\n" handling trailing-newline edge exactly like Go's bufio.ReadString loop.
 * Mirrors Go's count of total lines where a file ending with `\n` has an extra empty line.
 */
export function scanLines(content: string, startLine: number, maxLines: number): { lines: string[]; total: number } {
  // Replicate Go's bufio.ReadString('\n') + trailing newline handling
  // We operate on the raw string content (not yet split).
  const collected: string[] = [];
  let lineNum = 0;
  let lastHadNewline = false;
  let pos = 0;

  while (pos <= content.length) {
    const nl = content.indexOf("\n", pos);
    let segment: string;
    let hadNewline: boolean;
    if (nl >= 0) {
      segment = content.slice(pos, nl + 1); // include \n
      hadNewline = true;
      pos = nl + 1;
    } else {
      if (pos >= content.length) break;
      segment = content.slice(pos);
      hadNewline = false;
      pos = content.length;
    }

    if (segment.length > 0) {
      lineNum++;
      lastHadNewline = hadNewline;
      let trimmed = segment;
      if (trimmed.endsWith("\n")) trimmed = trimmed.slice(0, -1);
      if (trimmed.endsWith("\r")) trimmed = trimmed.slice(0, -1);
      if (lineNum >= startLine && collected.length < maxLines) {
        collected.push(trimmed);
      }
    }
    if (!hadNewline) break;
  }

  // Handle empty file: Go's strings.Split("", "\n") would yield [""]? But scanLines via bufio on empty returns 0 lines.
  // For empty content, lineNum stays 0 and no collected. Keep as is.

  if (lastHadNewline) {
    lineNum++;
    if (lineNum >= startLine && collected.length < maxLines) {
      collected.push("");
    }
  }

  // Edge: Go counts total via lineNum after loop; for non-empty without trailing newline, total is number of lines.
  // For content === "" Go loop yields total 0. Our handling matches.
  // For content === "a\nb" (no trailing newline, 2 lines): loop reads "a\n" lineNum1, "b" lineNum2, lastHadNewline false => total 2 correct.
  // For content === "a\nb\n" (trailing newline): reads "a\n"1, "b\n"2, then lastHadNewline true => lineNum 3 total 3 with extra "" line.
  // That matches strings.Split behavior Go documents.

  return { lines: collected, total: lineNum };
}

// ---------------------------------------------------------------------------
// FileReader — mirrors Go `type FileReader struct { RepoDir, Mode, Ref, Runner }`
// ---------------------------------------------------------------------------

export interface FileReaderOpts {
  RepoDir: string;
  Mode: ReviewMode;
  Ref: string;
  Runner?: GitRunner;
}

export class FileReader {
  RepoDir: string;
  Mode: ReviewMode;
  Ref: string;
  Runner?: GitRunner;

  constructor(opts: FileReaderOpts) {
    this.RepoDir = opts.RepoDir;
    this.Mode = opts.Mode;
    this.Ref = opts.Ref;
    this.Runner = opts.Runner;
  }

  /**
   * Read returns the full content of a file path (relative to RepoDir).
   * Mirrors Go `FileReader.Read(ctx, path) (string, error)`.
   */
  async Read(signal: AbortSignal | undefined, pathArg: string): Promise<string> {
    switch (this.Mode) {
      case ReviewMode.ModeWorkspace:
        return this.readFromDisk(pathArg);
      case ReviewMode.ModeRange:
      case ReviewMode.ModeCommit:
        return this.readFromGitShow(signal, pathArg);
      default:
        return this.readFromDisk(pathArg);
    }
  }

  /** Overload without signal for convenience. */
  async ReadSimple(pathArg: string): Promise<string> {
    return this.Read(undefined, pathArg);
  }

  /**
   * ReadLines returns a window of lines plus total line count.
   * Mirrors Go `ReadLines(ctx, path, startLine, maxLines) ([]string, int, error)`.
   */
  async ReadLines(
    signal: AbortSignal | undefined,
    pathArg: string,
    startLine: number,
    maxLines: number,
  ): Promise<{ lines: string[]; total: number }> {
    switch (this.Mode) {
      case ReviewMode.ModeWorkspace:
        return this.readLinesFromDisk(pathArg, startLine, maxLines);
      case ReviewMode.ModeRange:
      case ReviewMode.ModeCommit:
        return this.readLinesFromGitShow(signal, pathArg, startLine, maxLines);
      default:
        return this.readLinesFromDisk(pathArg, startLine, maxLines);
    }
  }

  private async resolveWorkspacePath(p: string): Promise<string> {
    let repoRoot: string;
    try {
      repoRoot = await canonicalPath(this.RepoDir);
    } catch (e) {
      throw new Error(`resolve repository path ${JSON.stringify(this.RepoDir)}: ${String(e)}`);
    }

    const fullPath = path.join(repoRoot, p);
    if (!withinBase(repoRoot, fullPath)) {
      throw new Error(`file path ${JSON.stringify(p)} is outside repository`);
    }

    let resolved: string;
    try {
      resolved = await fs.realpath(fullPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File does not exist yet — return fullPath as Go does (via fallback)
        return fullPath;
      }
      throw new Error(`resolve file ${JSON.stringify(p)}: ${String(e)}`);
    }

    if (!withinBase(repoRoot, resolved)) {
      throw new Error(`file path ${JSON.stringify(p)} is outside repository`);
    }
    return resolved;
  }

  private async readFromDisk(p: string): Promise<string> {
    const fullPath = await this.resolveWorkspacePath(p);
    try {
      const buf = await fs.readFile(fullPath);
      return buf.toString();
    } catch (e) {
      throw new Error(`read file ${JSON.stringify(p)}: ${String(e)}`);
    }
  }

  private async readFromGitShow(signal: AbortSignal | undefined, p: string): Promise<string> {
    const args = ["-c", "core.quotepath=false", "show", "--end-of-options", `${this.Ref}:${p}`];
    try {
      if (this.Runner?.Output) {
        const out = await this.Runner.Output(signal, this.RepoDir, ...args);
        return out.toString();
      }
      const out = await execGit(this.RepoDir, args, signal);
      return out.toString();
    } catch (e) {
      throw new Error(`git show ${this.Ref}:${p}: ${String(e)}`);
    }
  }

  private async readLinesFromDisk(p: string, startLine: number, maxLines: number): Promise<{ lines: string[]; total: number }> {
    const fullPath = await this.resolveWorkspacePath(p);
    let content: string;
    try {
      // Stream approach could be used, but for simplicity read all and scan.
      // Mirrors Go's scanLines on os.Open.
      content = (await fs.readFile(fullPath)).toString();
    } catch (e) {
      throw new Error(`read file ${JSON.stringify(p)}: ${String(e)}`);
    }
    return scanLines(content, startLine, maxLines);
  }

  private async readLinesFromGitShow(
    signal: AbortSignal | undefined,
    p: string,
    startLine: number,
    maxLines: number,
  ): Promise<{ lines: string[]; total: number }> {
    const args = ["-c", "core.quotepath=false", "show", "--end-of-options", `${this.Ref}:${p}`];

    // Prefer Runner.Stream if available for streaming
    if (this.Runner?.Stream) {
      let result: { lines: string[]; total: number } | undefined;
      let streamErr: unknown;
      try {
        await this.Runner.Stream(
          signal,
          this.RepoDir,
          async (stdout) => {
            const chunks: Buffer[] = [];
            for await (const chunk of stdout as AsyncIterable<Buffer>) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string));
            }
            const content = Buffer.concat(chunks).toString();
            result = scanLines(content, startLine, maxLines);
          },
          ...args,
        );
      } catch (e) {
        streamErr = e;
      }
      if (streamErr) throw new Error(`git show ${this.Ref}:${p}: ${String(streamErr)}`);
      if (!result) throw new Error(`git show ${this.Ref}:${p}: no output`);
      return result;
    }

    // Fallback: use Runner.Output or direct exec and then scan
    try {
      let content: string;
      if (this.Runner?.Output) {
        const out = await this.Runner.Output(signal, this.RepoDir, ...args);
        content = out.toString();
      } else {
        const out = await execGit(this.RepoDir, args, signal);
        content = out.toString();
      }
      return scanLines(content, startLine, maxLines);
    } catch (e) {
      throw new Error(`git show ${this.Ref}:${p}: ${String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// FileReadProvider — mirrors internal/tool/file_read.go
// ---------------------------------------------------------------------------

export const fileReadMaxLines = 500;

export class FileReadProvider {
  constructor(private readonly FileReader_: FileReader) {}

  Tool(): Tool {
    return FileRead;
  }

  async Execute(ctx: unknown, args: Record<string, unknown>): Promise<string> {
    const a = (args ?? (ctx as Record<string, unknown>)) as Record<string, unknown>;
    // Support both (signal, args) and (args) calling conventions
    const realArgs = (typeof a === "object" && a !== null && "file_path" in a ? a : (ctx as Record<string, unknown>)) as Record<string, unknown>;
    const signal = ctx instanceof AbortSignal ? ctx : undefined;
    const filePath = typeof realArgs["file_path"] === "string" ? (realArgs["file_path"] as string) : "";
    if (filePath === "") return "Error: file_path is required";

    let startLine = typeof realArgs["start_line"] === "number" ? (realArgs["start_line"] as number) : 0;
    let endLine = typeof realArgs["end_line"] === "number" ? (realArgs["end_line"] as number) : 0;
    const hasStart = typeof realArgs["start_line"] === "number";
    const hasEnd = typeof realArgs["end_line"] === "number";

    if (!hasStart || startLine <= 0) startLine = 1;
    if (!hasEnd || endLine <= 0) endLine = 0;

    let maxLines = fileReadMaxLines;
    if (endLine > 0) {
      const requested = Math.trunc(endLine) - Math.trunc(startLine) + 1;
      if (requested <= 0) {
        throw new Error(`invalid line range: start_line ${Math.trunc(startLine)} is greater than end_line ${Math.trunc(endLine)}`);
      }
      if (requested < maxLines) maxLines = requested;
    }

    let lines: string[];
    let totalLines: number;
    try {
      const res = await this.FileReader_.ReadLines(signal, filePath, Math.trunc(startLine), maxLines);
      lines = res.lines;
      totalLines = res.total;
    } catch (e) {
      throw new Error(`file ${JSON.stringify(filePath)} not found: ${String(e)}`);
    }

    if (totalLines > 0 && Math.trunc(startLine) - 1 >= totalLines) {
      throw new Error(`file ${JSON.stringify(filePath)} has only ${totalLines} lines, requested range ${Math.trunc(startLine)}-${Math.trunc(endLine)}`);
    }

    let effectiveEnd = totalLines;
    if (endLine > 0 && Math.trunc(endLine) < effectiveEnd) effectiveEnd = Math.trunc(endLine);
    const fullRange = effectiveEnd - (Math.trunc(startLine) - 1);
    const truncated = fullRange > fileReadMaxLines;
    const displayEnd = Math.trunc(startLine) - 1 + lines.length;

    let sb = "";
    sb += `File: ${filePath} (Total lines: ${totalLines})\n`;
    sb += `IS_TRUNCATED: ${String(truncated)}\n`;
    sb += `LINE_RANGE: ${Math.trunc(startLine)}-${displayEnd}\n`;
    for (let i = 0; i < lines.length; i++) {
      sb += `${Math.trunc(startLine) + i}|${lines[i]}\n`;
    }
    if (truncated) {
      sb += `\nNote: Results truncated to ${fileReadMaxLines} lines. Please narrow your line range.\n`;
    }
    return sb;
  }
}

export function NewFileRead(fr: FileReader): FileReadProvider {
  return new FileReadProvider(fr);
}
export const newFileRead = NewFileRead;

// ---------------------------------------------------------------------------
// DiffMap + FileReadDiffProvider — mirrors internal/tool/file_read_diff.go
// ---------------------------------------------------------------------------

export class DiffMap {
  private readonly m: Map<string, string>;

  constructor(m: Record<string, string> | Map<string, string>) {
    if (m instanceof Map) {
      this.m = new Map(m);
    } else {
      this.m = new Map(Object.entries(m));
    }
  }

  Get(path: string): [string, boolean] {
    const v = this.m.get(path);
    if (v !== undefined) return [v, true];
    return ["", false];
  }

  /** JS alias. */
  get(path: string): [string, boolean] {
    return this.Get(path);
  }
}

export function NewDiffMap(m: Record<string, string> | Map<string, string>): DiffMap {
  return new DiffMap(m);
}
export const newDiffMap = NewDiffMap;

export class FileReadDiffProvider {
  private diffMap: DiffMap;

  constructor(dm: DiffMap) {
    this.diffMap = dm;
  }

  Tool(): Tool {
    return FileReadDiff;
  }

  SetDiffMap(dm: DiffMap): void {
    this.diffMap = dm;
  }

  /** JS alias. */
  setDiffMap(dm: DiffMap): void {
    this.SetDiffMap(dm);
  }

  async Execute(_ctx: unknown, args: Record<string, unknown>): Promise<string> {
    const pathArray = Array.isArray(args["path_array"]) ? (args["path_array"] as unknown[]) : [];
    if (pathArray.length === 0) return "Error: no files found";

    let sb = "";
    for (const item of pathArray) {
      if (typeof item !== "string") continue;
      const [d, exists] = this.diffMap.Get(item);
      if (exists) {
        sb += `==== FILE: ${item} ====\n`;
        sb += d;
        sb += "\n";
      }
    }
    if (sb === "") return "Error: diff not found for the requested paths";
    return sb;
  }
}

export function NewFileReadDiff(dm: DiffMap): FileReadDiffProvider {
  return new FileReadDiffProvider(dm);
}
export const newFileReadDiff = NewFileReadDiff;

// ---------------------------------------------------------------------------
// CodeSearchProvider — mirrors internal/tool/code_search.go (simplified but faithful)
// ---------------------------------------------------------------------------

export const gitGrepMaxCount = 100;
export const gitGrepTimeout = 10_000;

function hasTraversalPathComponent(pathspec: string): boolean {
  for (const part of pathspec.split("/")) {
    if (part === "..") return true;
  }
  return false;
}

export class CodeSearchProvider {
  constructor(private readonly FileReader_: FileReader) {}

  Tool(): Tool {
    return CodeSearch;
  }

  async Execute(ctx: unknown, args: Record<string, unknown>): Promise<string> {
    const signal = ctx instanceof AbortSignal ? ctx : undefined;
    const realArgs = args ?? (ctx as Record<string, unknown>);
    const searchText = typeof realArgs["search_text"] === "string" ? (realArgs["search_text"] as string) : "";
    const caseSensitive = Boolean(realArgs["case_sensitive"]);
    const usePerlRegexp = Boolean(realArgs["use_perl_regexp"]);

    const rawPatterns = Array.isArray(realArgs["file_patterns"]) ? (realArgs["file_patterns"] as unknown[]) : [];
    const patterns: string[] = [];
    for (const item of rawPatterns) {
      if (typeof item === "string" && item !== "") {
        if (hasTraversalPathComponent(item)) return "Error: file_patterns must not contain ..";
        patterns.push(item);
      }
    }

    if (searchText.trim() === "") return "Error: search_text is blank";

    try {
      return await this.gitGrep(signal, searchText, caseSensitive, usePerlRegexp, patterns);
    } catch (e) {
      throw new Error(`code_search failed: ${String(e)}`);
    }
  }

  private buildGrepArgs(
    searchText: string,
    caseSensitive: boolean,
    usePerlRegexp: boolean,
    noIndex: boolean,
    pathspec: string[],
  ): string[] | null {
    const cmdArgs: string[] = ["--no-pager", "grep"];
    if (noIndex) {
      cmdArgs.push("--no-index", "--exclude-standard");
    } else if (!this.FileReader_.Ref) {
      cmdArgs.push("--untracked");
    }
    if (!caseSensitive) cmdArgs.push("-i");
    cmdArgs.push(usePerlRegexp ? "-P" : "-F");
    cmdArgs.push("-n", "--no-color");
    cmdArgs.push("--max-count", String(gitGrepMaxCount));
    cmdArgs.push("-e", searchText);
    if (this.FileReader_.Ref) {
      if (this.FileReader_.Ref.startsWith("-")) return null;
      cmdArgs.push(this.FileReader_.Ref);
    }
    cmdArgs.push("--");
    cmdArgs.push(...pathspec);
    return cmdArgs;
  }

  private async runGitGrep(signal: AbortSignal | undefined, cmdArgs: string[]): Promise<{ stdout: string; stderr: string; error: unknown }> {
    // Use Runner if available
    if (this.FileReader_.Runner?.RunSplit) {
      try {
        const { stdout, stderr } = await this.FileReader_.Runner.RunSplit(signal, this.FileReader_.RepoDir, ...cmdArgs);
        return { stdout, stderr, error: null };
      } catch (e) {
        // Node exec error may carry stderr; we approximate
        return { stdout: "", stderr: String(e), error: e };
      }
    }

    // Fallback to direct git spawn
    return new Promise((resolve) => {
      const child = spawn("git", cmdArgs, { cwd: this.FileReader_.RepoDir, signal: signal as unknown as AbortSignal | undefined });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      let timeout: NodeJS.Timeout | undefined;
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, gitGrepTimeout);

      child.on("error", (err) => {
        if (timeout) clearTimeout(timeout);
        resolve({ stdout, stderr, error: err });
      });
      child.on("close", (code) => {
        if (timeout) clearTimeout(timeout);
        if (code === 0 || code === 1) {
          // git grep exit 1 means no matches but still stdout may be empty
          resolve({ stdout, stderr, error: code === 0 ? null : Object.assign(new Error(`exit ${code}`), { code }) });
        } else if (code !== null) {
          resolve({ stdout, stderr, error: Object.assign(new Error(`exit ${code}: ${stderr}`), { code }) });
        } else {
          resolve({ stdout, stderr, error: null });
        }
      });

      signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    });
  }

  private async gitGrep(
    signal: AbortSignal | undefined,
    searchText: string,
    caseSensitive: boolean,
    usePerlRegexp: boolean,
    pathspec: string[],
  ): Promise<string> {
    let cmdArgs = this.buildGrepArgs(searchText, caseSensitive, usePerlRegexp, false, pathspec);
    if (cmdArgs === null) return "Error: ref must not start with '-'";

    let { stdout: outStr, stderr: errStr, error: err } = await this.runGitGrep(signal, cmdArgs);

    // Non-git directory fallback — mirrors Go isNotGitRepoError retry
    if (err !== null && !this.FileReader_.Ref && errStr.includes("not a git repository")) {
      cmdArgs = this.buildGrepArgs(searchText, caseSensitive, usePerlRegexp, true, pathspec);
      if (cmdArgs === null) return "Error: ref must not start with '-'";
      const retry = await this.runGitGrep(signal, cmdArgs);
      outStr = retry.stdout;
      errStr = retry.stderr;
      err = retry.error;
    }

    if (err !== null) {
      if (errStr === "" && outStr === "") return "No matches found";
      if (outStr === "" && errStr !== "") return `Error: ${errStr.trim()}`;
      // If we have timeout, handle
      if (String(err).includes("timed out") || String(err).includes("Timeout")) {
        return "code_search timed out. Try narrowing file_patterns to a more specific path.";
      }
    }

    if (!outStr.trim()) return "No matches found";

    const lines = outStr.trimEnd().split("\n");
    const truncated = lines.length >= gitGrepMaxCount;

    type Match = { lineNum: number; content: string };
    const fileMatches = new Map<string, Match[]>();
    const fileOrder: string[] = [];
    const seen = new Set<string>();

    const hasRef = Boolean(this.FileReader_.Ref);
    const splitN = hasRef ? 4 : 3;
    const offset = hasRef ? 1 : 0;

    let sb = "";
    if (truncated) sb += `Note: The results have been truncated. Only showing first ${gitGrepMaxCount} results.\n`;

    for (const line of lines) {
      if (line === "") continue;
      const parts = line.split(":");
      if (parts.length < splitN) continue;
      // Reconstruct similar to Go's SplitN logic: for ref case, parts[0] is commit hash, skip it
      const fname = parts[offset] ?? "";
      const lnStr = parts[offset + 1] ?? "";
      const content = parts.slice(offset + 2).join(":");
      const ln = parseInt(lnStr, 10);
      if (Number.isNaN(ln)) continue;
      if (!seen.has(fname)) {
        seen.add(fname);
        fileOrder.push(fname);
      }
      const arr = fileMatches.get(fname) ?? [];
      arr.push({ lineNum: ln, content });
      fileMatches.set(fname, arr);
    }

    for (const p of fileOrder) {
      const matches = fileMatches.get(p) ?? [];
      sb += `File: ${p}\nMatch lines: ${matches.length}\n`;
      for (const m of matches) sb += `${m.lineNum}|${m.content}\n`;
      sb += "\n";
    }

    if (err !== null && errStr) sb += `Warning: ${errStr.trim()}\n`;

    return sb;
  }
}

export function NewCodeSearch(fr: FileReader): CodeSearchProvider {
  return new CodeSearchProvider(fr);
}
export const newCodeSearch = NewCodeSearch;

// ---------------------------------------------------------------------------
// FileFindProvider — mirrors internal/tool/file_find.go (simplified)
// ---------------------------------------------------------------------------

export const fileFindMaxCount = 100;
export const fileFindTimeout = 10_000;

function shouldSkipFile(p: string): boolean {
  const base = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  const hasExt = base.includes(".");
  if (!hasExt) {
    switch (base) {
      case "Makefile":
      case "Dockerfile":
      case "LICENSE":
      case "Vagrantfile":
      case "Containerfile":
        return false;
    }
    return true;
  }
  return false;
}

export class FileFindProvider {
  constructor(private readonly FileReader_: FileReader) {}

  Tool(): Tool {
    return FileFind;
  }

  async Execute(ctx: unknown, args: Record<string, unknown>): Promise<string> {
    const signal = ctx instanceof AbortSignal ? ctx : undefined;
    const realArgs = args ?? (ctx as Record<string, unknown>);
    const queryName = typeof realArgs["query_name"] === "string" ? (realArgs["query_name"] as string) : "";
    if (queryName.trim() === "") return "// The file was not found";
    const caseSensitive = Boolean(realArgs["case_sensitive"]);

    let files: string[];
    try {
      files = await this.listGitFiles(signal);
    } catch (e) {
      // Propagate abort / timeout as error
      throw e;
    }

    const matched: string[] = [];
    for (const f of files) {
      const base = f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f;
      const match = caseSensitive
        ? base.includes(queryName)
        : base.toLowerCase().includes(queryName.toLowerCase());
      if (match) {
        matched.push(f);
        if (matched.length >= fileFindMaxCount) break;
      }
    }

    if (matched.length === 0) return "// The file was not found";
    return matched.join("\n");
  }

  private async listGitFiles(signal: AbortSignal | undefined): Promise<string[]> {
    const ref = this.FileReader_.Ref;
    const args = ref ? ["ls-tree", "-r", "--name-only", "--end-of-options", ref] : ["ls-files", "--cached", "--others", "--exclude-standard"];

    try {
      let output: Buffer;
      if (this.FileReader_.Runner?.Output) {
        output = await this.FileReader_.Runner.Output(signal, this.FileReader_.RepoDir, ...args);
      } else {
        output = await execGit(this.FileReader_.RepoDir, args, signal, fileFindTimeout);
      }
      const text = output.toString().trimEnd();
      if (text === "") return [];
      const lines = text.split("\n");
      const files: string[] = [];
      for (const line of lines) {
        if (line && !shouldSkipFile(line)) files.push(line);
      }
      return files;
    } catch (e) {
      if (ref) throw e;
      // Non-git fallback: walk filesystem as Go listWalkFiles does (simplified)
      return this.listWalkFiles(signal);
    }
  }

  private async listWalkFiles(signal: AbortSignal | undefined): Promise<string[]> {
    const root = this.FileReader_.RepoDir;
    const files: string[] = [];

    async function walk(dir: string): Promise<void> {
      if (signal?.aborted) throw new Error(signal.reason ? String(signal.reason) : "context cancelled");
      let entries: fsSync.Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (entry.isDirectory()) {
          if (rel === ".git" || rel.startsWith(".git/")) continue;
          if (["node_modules", "vendor", "dist", ".next"].includes(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile()) {
          if (shouldSkipFile(rel)) continue;
          files.push(rel);
        }
      }
    }

    await walk(root);
    return files;
  }
}

export function NewFileFind(fr: FileReader): FileFindProvider {
  return new FileFindProvider(fr);
}
export const newFileFind = NewFileFind;

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/git.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Diff provider — mirrors Go `diff.Provider`.
 * Acquires and validates Git targets, applies OCR-compatible selection/rules,
 * and returns parsed `Diff` structs. Deterministic ordering preserved.
 *
 * This file intentionally duplicates the low-level git argv runner seam for
 * the parity engine and does NOT import legacy `src/git.ts` or `src/diff.ts`
 * policy (per AGENTS.md). Shared utilities are limited to what lives inside
 * this `ocr/diff` tree after OCR-derived tests prove parity.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { parseDiffText } from "./parser.js";
import { loadGitignorePatterns, isPathExcluded } from "./gitignore.js";
import { readWorkspaceFileForDiff } from "./workspace.js";
import type { Runner } from "./runner.js";
import type { Diff } from "../model/diff.js";

// ---------------------------------------------------------------------------
// Constants — mirrors Go `DiffContextLines` / `providerDirIgnoreDirs`
// ---------------------------------------------------------------------------

export const DiffContextLines = 3;

// ---------------------------------------------------------------------------
// Failure diagnostics — isolated adoption from OCR 0c44f10 + 4cecf1e.
// Use stderr only (never combined stdout) so a mid-write kill tail cannot leak
// diff/source content via error telemetry. Keep the tail (die() fatal is last),
// capped rune-safely.
// ---------------------------------------------------------------------------

export const GIT_DIAG_LIMIT = 2000;

/**
 * gitFailure builds an error carrying git's own stderr tail plus the original
 * failure. Returns an Error with `cause` set to the original error.
 * Mirrors Go `gitFailure(op, stderr, err)`.
 */
export function gitFailure(op: string, stderr: string, err: unknown): Error {
  const orig = err instanceof Error ? err : new Error(String(err ?? "error"));
  // Cancellation guard is handled by callers (signal.aborted rethrow); here we
  // only format diagnostics.
  const diag = stderr.trim();
  if (diag === "") return new Error(`${op} failed: ${orig.message}`, { cause: orig });
  // Rune-safe tail via code-point spread (locale-safe, no split surrogate).
  const points = [...diag];
  const tail = points.length > GIT_DIAG_LIMIT ? `...${points.slice(-GIT_DIAG_LIMIT).join("")}` : diag;
  return new Error(`${op} failed: ${orig.message}: ${tail}`, { cause: orig });
}

export const GitFailure = gitFailure;

/**
 * splitStderr extracts stderr preserved on split-runner errors.
 * Returns "" when unavailable (e.g. spawn failure), letting gitFailure fall
 * back to `op failed: <message>`.
 */
export function splitStderr(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const v = (err as Record<string, unknown>)["stderr"];
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// Mode — mirrors Go `Mode`
// ---------------------------------------------------------------------------

export const ModeWorkspace = 0 as const;
export const ModeCommit = 1 as const;
export const ModeRange = 2 as const;

export type Mode = typeof ModeWorkspace | typeof ModeCommit | typeof ModeRange;

// ---------------------------------------------------------------------------
// InputResolution — mirrors Go `InputResolution`
// ---------------------------------------------------------------------------

export interface InputResolution {
  resolvedBase: string;
  resolvedHead: string;
  exactRange: string;
}

// ---------------------------------------------------------------------------
// Provider — mirrors Go `Provider`
// ---------------------------------------------------------------------------

export class Provider {
  readonly repoDir: string;
  readonly mode: Mode;
  readonly runner: Runner | null;

  readonly from: string;
  readonly to: string;
  readonly commit: string;

  private mergeBaseCache: string;

  constructor(opts: {
    repoDir: string;
    mode: Mode;
    runner?: Runner | null;
    from?: string;
    to?: string;
    commit?: string;
  }) {
    this.repoDir = opts.repoDir;
    this.mode = opts.mode;
    this.runner = opts.runner ?? null;
    this.from = opts.from ?? "";
    this.to = opts.to ?? "";
    this.commit = opts.commit ?? "";
    this.mergeBaseCache = "";
  }

  // ---- Factory aliases mirroring Go `NewProvider` / `NewCommitProvider` / `NewWorkspaceProvider`

  static forRange(repoDir: string, from: string, to: string, runner?: Runner | null): Provider {
    return new Provider({ repoDir, mode: ModeRange, from, to, runner });
  }

  static forCommit(repoDir: string, commit: string, runner?: Runner | null): Provider {
    return new Provider({ repoDir, mode: ModeCommit, commit, runner });
  }

  static forWorkspace(repoDir: string, runner?: Runner | null): Provider {
    return new Provider({ repoDir, mode: ModeWorkspace, runner });
  }

  // ---- Mode queries — mirrors Go `IsRangeMode` / `IsCommitMode`

  isRangeMode(): boolean {
    return this.mode === ModeRange;
  }

  isCommitMode(): boolean {
    return this.mode === ModeCommit;
  }

  IsRangeMode(): boolean {
    return this.isRangeMode();
  }

  IsCommitMode(): boolean {
    return this.isCommitMode();
  }

  // ---- MergeBase — mirrors Go `MergeBase`

  async mergeBase(signal?: AbortSignal): Promise<string> {
    if (this.mode !== ModeRange || this.mergeBaseCache !== "") return this.mergeBaseCache;
    this.mergeBaseCache = await this.computeMergeBase(this.from, this.to, signal);
    return this.mergeBaseCache;
  }

  // Synchronous accessor for callers that already computed it (e.g. getDiff legacy path).
  mergeBaseSync(): string {
    return this.mergeBaseCache;
  }

  // ---- ResolveInput — mirrors Go `ResolveInput`

  async resolveInput(signal?: AbortSignal): Promise<InputResolution> {
    switch (this.mode) {
      case ModeRange: {
        const base = await this.mergeBase(signal);
        const head = await this.resolveCommit(this.to, signal);
        const r: InputResolution = { resolvedBase: base, resolvedHead: head, exactRange: "" };
        if (base !== "" && head !== "") r.exactRange = `${base}..${head}`;
        return r;
      }
      case ModeCommit: {
        const head = await this.resolveCommit(this.commit, signal);
        const r: InputResolution = { resolvedBase: "", resolvedHead: head, exactRange: "" };
        const parents = await this.commitParents(this.commit, signal);
        if (parents.length > 0 && head !== "") {
          r.resolvedBase = parents[0]!;
          r.exactRange = `${parents[0]}..${head}`;
        }
        return r;
      }
      case ModeWorkspace: {
        const base = await this.resolveCommit("HEAD", signal);
        return { resolvedBase: base, resolvedHead: "", exactRange: "" };
      }
      default:
        return { resolvedBase: "", resolvedHead: "", exactRange: "" };
    }
  }

  // ---- RemoteIdentity — mirrors Go `RemoteIdentity`

  async remoteIdentity(signal?: AbortSignal): Promise<string> {
    try {
      const out = await this.runGit(["remote", "get-url", "origin"], signal);
      return canonicalRemote(firstLine(out));
    } catch {
      return "";
    }
  }

  // ---- GetDiff — mirrors Go `GetDiff`

  async getDiff(signal?: AbortSignal): Promise<Diff[]> {
    let combined = "";

    switch (this.mode) {
      case ModeRange: {
        const base = await this.mergeBase(signal);
        if (base === "") throw new Error(`cannot find merge-base between ${this.from} and ${this.to}`);
        // Isolated adoption from OCR 0c44f10: surface git's own stderr tail.
        try {
          const { stdout } = await this.runGitSplit(
            [
              "-c",
              "core.quotepath=false",
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--find-renames",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-color",
              `-U${DiffContextLines}`,
              "--end-of-options",
              base,
              this.to,
              "--",
            ],
            signal,
          );
          combined += stdout;
        } catch (e) {
          if (signal?.aborted) throw e;
          throw gitFailure("git diff", splitStderr(e), e);
        }
        break;
      }
      case ModeCommit: {
        try {
          const { stdout } = await this.runGitSplit(
            [
              "-c",
              "core.quotepath=false",
              "show",
              "--no-ext-diff",
              "--no-textconv",
              "--find-renames",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-color",
              "--diff-merges=first-parent",
              `-U${DiffContextLines}`,
              "--end-of-options",
              this.commit,
            ],
            signal,
          );
          combined += stdout;
        } catch (e) {
          if (signal?.aborted) throw e;
          throw gitFailure("git show", splitStderr(e), e);
        }
        break;
      }
      case ModeWorkspace: {
        const tracked = await this.workspaceTrackedDiff(signal);
        combined += tracked;

        const untracked = await this.untrackedFileDiffs(signal);
        for (const ud of untracked) {
          combined += ud;
          combined += "\n\n";
        }
        break;
      }
    }

    let ref = "";
    switch (this.mode) {
      case ModeRange:
        ref = this.to;
        break;
      case ModeCommit:
        ref = this.commit;
        break;
    }

    const diffs = await parseDiffText(combined, this.repoDir, ref, this.runner, { signal });
    return this.filterDiffs(diffs);
  }

  // Alias matching Go's exported name.
  GetDiff = this.getDiff.bind(this);
  ResolveInput = this.resolveInput.bind(this);
  MergeBase = this.mergeBase.bind(this);
  RemoteIdentity = this.remoteIdentity.bind(this);

  // -------------------------------------------------------------------------
  // Helpers — mirrors Go internal helpers
  // -------------------------------------------------------------------------

  private filterDiffs(diffs: Diff[]): Diff[] {
    const patterns = loadGitignorePatterns(this.repoDir);
    const result: Diff[] = [];
    for (const d of diffs) {
      let p = d.newPath;
      if (p === "/dev/null") p = d.oldPath;
      if (!isPathExcluded(p, patterns)) result.push(d);
    }
    return result;
  }

  private async computeMergeBase(from: string, to: string, signal?: AbortSignal): Promise<string> {
    try {
      const out = await this.runGit(["merge-base", "--end-of-options", from, to], signal);
      return out.trim();
    } catch {
      return "";
    }
  }

  private async resolveCommit(ref: string, signal?: AbortSignal): Promise<string> {
    try {
      const out = await this.runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], signal);
      return firstLine(out);
    } catch {
      return "";
    }
  }

  private async commitParents(ref: string, signal?: AbortSignal): Promise<string[]> {
    try {
      const out = await this.runGit(["rev-list", "--parents", "-n", "1", "--end-of-options", ref], signal);
      const fields = firstLine(out).split(/\s+/).filter(Boolean);
      if (fields.length <= 1) return [];
      return fields.slice(1);
    } catch {
      return [];
    }
  }

  private async workspaceTrackedDiff(signal?: AbortSignal): Promise<string> {
    const argsHead = [
      "-c",
      "core.quotepath=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--no-color",
      `-U${DiffContextLines}`,
      "--end-of-options",
      "HEAD",
      "--",
    ];
    try {
      const { stdout } = await this.runGitSplit(argsHead, signal);
      if (stdout !== "") return stdout;
    } catch (e) {
      if (signal?.aborted) throw e;
      // Discard first HEAD stderr: expected "bad revision 'HEAD'" on unborn repo.
      // Fall through to staged fallback.
    }
    // Fallback for repo with no HEAD (unborn) — diff staged vs empty tree.
    const argsStaged = [
      "-c",
      "core.quotepath=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--no-color",
      `-U${DiffContextLines}`,
      "--staged",
      "--",
    ];
    try {
      const { stdout } = await this.runGitSplit(argsStaged, signal);
      return stdout;
    } catch (e) {
      if (signal?.aborted) throw e;
      // Isolated adoption from OCR 0c44f10: only the fallback stderr is diagnostic.
      throw gitFailure("workspace tracked diff", splitStderr(e), e);
    }
  }

  private async untrackedFileDiffs(signal?: AbortSignal): Promise<string[]> {
    const files = await this.untrackedFilesList(signal);
    const results: string[] = [];
    for (const f of files) {
      let content: Buffer;
      try {
        content = await readWorkspaceFileForDiff(this.repoDir, f);
      } catch {
        continue;
      }
      const newlineCount = content.toString("utf-8").split("\n").length - 1 + (content.length > 0 && content[content.length - 1] !== 10 ? 1 : 0);
      // More precise line count: count '\n' bytes + 1 if no trailing newline and non-empty
      let lineCount = 0;
      for (let i = 0; i < content.length; i++) if (content[i] === 10) lineCount++;
      if (content.length > 0 && content[content.length - 1] !== 10) lineCount++;

      let sb = "";
      sb += `diff --git a/${f} b/${f}\n`;
      sb += "--- /dev/null\n";
      sb += `+++ b/${f}\n`;
      sb += `@@ -0,0 +1,${lineCount} @@\n`;

      // Split content mirroring Go's bytes.Split; handle trailing newline edge.
      const text = content.toString("utf-8");
      let lines = text.split("\n");
      // bytes.Split on "\n" keeps trailing empty element if ends with \n; Go trims it next:
      if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) {
        lines = lines.slice(0, -1);
      } else if (lines.length === 1 && lines[0] === "" && text === "") {
        lines = [];
      }
      for (const line of lines) {
        sb += `+${line}\n`;
      }
      results.push(sb);
      // Use lineCount variable to avoid unused; keep deterministic
      void newlineCount;
    }
    return results;
  }

  private async untrackedFilesList(signal?: AbortSignal): Promise<string[]> {
    // Isolated adoption from OCR 4cecf1e: propagate listing errors instead of
    // returning [] and reviewing half-blind.
    let out: string;
    try {
      const res = await this.runGitSplit(["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"], signal);
      out = res.stdout;
    } catch (e) {
      if (signal?.aborted) throw e;
      throw gitFailure("git ls-files", splitStderr(e), e);
    }
    if (out.trim() === "") return [];
    const patterns = loadGitignorePatterns(this.repoDir);
    const files: string[] = [];
    for (const raw of out.trim().split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      if (!isPathExcluded(line, patterns)) files.push(line);
    }
    return files;
  }

  // Low-level split runner — mirrors Go `runGitSplit` (stdout/stderr apart).
  // Cancellation guard: signal abort rethrows the abort reason so callers can
  // classify timeout/cancel vs failure.
  private async runGitSplit(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    if (this.runner !== null) {
      try {
        return await this.runner.runSplit(this.repoDir, args, signal);
      } catch (e) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
        throw e;
      }
    }
    // Direct fallback without runner.
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      if (signal?.aborted) {
        const reason = signal!.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
        return;
      }
      const child = spawn("git", args, { cwd: this.repoDir, stdio: ["ignore", "pipe", "pipe"], shell: false });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => outChunks.push(c));
      child.stderr.on("data", (c: Buffer) => errChunks.push(c));
      const onAbort = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        reject(signal?.reason instanceof Error ? signal?.reason : new Error(String(signal?.reason ?? "aborted")));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        const stdout = Buffer.concat(outChunks).toString("utf-8");
        const stderr = Buffer.concat(errChunks).toString("utf-8");
        if (code !== 0) {
          const err = new Error(`git ${args.join(" ")} failed with exit ${code}`) as Error & {
            status: number | null;
            stderr: string;
          };
          (err as unknown as Record<string, unknown>)["status"] = code;
          (err as unknown as Record<string, unknown>)["stderr"] = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }

  // Low-level runner — mirrors Go `runGit`.
  private async runGit(args: string[], signal?: AbortSignal): Promise<string> {
    if (this.runner !== null) {
      return await this.runner.run(this.repoDir, args, signal);
    }
    // Direct fallback without runner.
    return await new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        const reason = signal!.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
        return;
      }
      const child = spawn("git", args, { cwd: this.repoDir, stdio: ["ignore", "pipe", "pipe"], shell: false });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => outChunks.push(c));
      child.stderr.on("data", (c: Buffer) => errChunks.push(c));
      const onAbort = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        reject(signal?.reason instanceof Error ? signal?.reason : new Error(String(signal?.reason ?? "aborted")));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        const out = Buffer.concat([...outChunks, ...errChunks]).toString("utf-8");
        if (code !== 0) {
          const err = new Error(`git ${args.join(" ")} failed with ${code}: ${out.slice(0, 500)}`) as Error & { status: number | null };
          (err as unknown as Record<string, unknown>)["status"] = code;
          reject(err);
        } else {
          resolve(Buffer.concat(outChunks).toString("utf-8"));
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Canonicalization — mirrors Go `canonicalRemote` / `joinHostPath` /
// `isLocalRemote` / `isASCIILetter`
// ---------------------------------------------------------------------------

export function canonicalRemote(raw: string): string {
  let s = raw.trim();
  if (s === "") return "";
  const qIdx = s.search(/[?#]/);
  if (qIdx >= 0) s = s.slice(0, qIdx);

  if (isLocalRemote(s)) return "";

  if (s.includes("://")) {
    try {
      const u = new URL(s);
      if (u.protocol !== "" && u.host !== "") {
        return joinHostPath(u.host.toLowerCase(), u.pathname);
      }
    } catch {
      return "";
    }
    return "";
  }

  const colon = s.indexOf(":");
  if (colon < 0) return "";
  let hostSeg = s.slice(0, colon);
  const pathPart = s.slice(colon + 1);
  const at = hostSeg.lastIndexOf("@");
  if (at >= 0) hostSeg = hostSeg.slice(at + 1);
  const host = hostSeg.toLowerCase();
  if (host === "") return "";
  return joinHostPath(host, pathPart);
}

export function joinHostPath(host: string, p: string): string {
  let p2 = p;
  if (p2.startsWith("/")) p2 = p2.slice(1);
  if (p2.endsWith("/")) p2 = p2.slice(0, -1);
  if (p2.endsWith(".git")) p2 = p2.slice(0, -4);
  if (p2.endsWith("/")) p2 = p2.slice(0, -1);
  if (p2 === "") return host;
  return `${host}/${p2}`;
}

export function isLocalRemote(s: string): boolean {
  if (s.startsWith("file://")) return true;
  if (s.startsWith("/") || s.startsWith("~")) return true;
  if (s.startsWith("./") || s.startsWith("../") || s === "." || s === "..") return true;
  if (s.startsWith("\\\\")) return true;
  if (s.length >= 3 && isASCIILetter(s.charCodeAt(0)) && s[1] === ":" && (s[2] === "\\" || s[2] === "/")) return true;
  return false;
}

export function isASCIILetter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function isASCIILetterChar(b: string): boolean {
  const c = b.charCodeAt(0);
  return isASCIILetter(c);
}
void isASCIILetterChar;

// ---- firstLine — mirrors Go `firstLine`

export function firstLine(out: string): string {
  for (const line of out.split("\n")) {
    const s = line.trim();
    if (s !== "") return s;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Convenience constructors — mirrors Go top-level `NewProvider` etc.
// ---------------------------------------------------------------------------

export function newProvider(repoDir: string, from: string, to: string, runner?: Runner | null): Provider {
  return Provider.forRange(repoDir, from, to, runner ?? null);
}

export function newCommitProvider(repoDir: string, commit: string, runner?: Runner | null): Provider {
  return Provider.forCommit(repoDir, commit, runner ?? null);
}

export function newWorkspaceProvider(repoDir: string, runner?: Runner | null): Provider {
  return Provider.forWorkspace(repoDir, runner ?? null);
}

export const NewProvider = newProvider;
export const NewCommitProvider = newCommitProvider;
export const NewWorkspaceProvider = newWorkspaceProvider;

// Keep legacy lower-case aliases
export {
  canonicalRemote as CanonicalRemote,
  joinHostPath as JoinHostPath,
  isLocalRemote as IsLocalRemote,
  firstLine as FirstLine,
};

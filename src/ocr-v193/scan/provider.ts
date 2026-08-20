// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/scan/provider.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * File enumeration for `ocr scan` — mirrors Go `scan.Provider`.
 *
 * Provider enumerates source files via `git ls-files` when inside a git
 * repository (with fallback to `filepath.WalkDir` semantics when no git) and
 * produces `ScanItem` entries with full file content for reviewable files
 * and placeholder entries for binaries.
 *
 * Complexity is intentionally stub-friendly: the `Enumerate` contract
 * is preserved (inputs, binary sniff, size cap, path filtering), while the
 * actual I/O is implemented with Node `fs`/`child_process` so the port
 * compiles without live Git fixtures. Sorting and dedup semantics match Go.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ScanItem } from "../model/scan.js";

// ---------------------------------------------------------------------------
// Constants — mirrors Go
// ---------------------------------------------------------------------------

export const BINARY_SNIFF_WINDOW = 8000;
export const DEFAULT_MAX_FILE_SIZE_BYTES: number = 2 * 1024 * 1024; // 2 MiB

export const binarySniffWindow = BINARY_SNIFF_WINDOW;
export const DefaultMaxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ProviderOptions {
  readonly repoDir: string;
  readonly paths?: readonly string[];
  readonly maxFileSizeBytes?: number;
}

export class Provider {
  readonly repoDir: string;
  readonly paths: string[];
  readonly maxFileSizeBytes: number;

  constructor(repoDir: string, paths: readonly string[] | null | undefined = [], maxFileSizeBytes?: number) {
    this.repoDir = repoDir;
    const cleaned: string[] = [];
    for (const p of (paths ?? [])) {
      let v = String(p).trim();
      if (v === "") continue;
      if (v.startsWith("./")) v = v.slice(2);
      if (v.endsWith("/")) v = v.slice(0, -1);
      cleaned.push(v.replaceAll("\\", "/"));
    }
    this.paths = cleaned;
    this.maxFileSizeBytes =
      typeof maxFileSizeBytes === "number" && maxFileSizeBytes > 0
        ? maxFileSizeBytes
        : DEFAULT_MAX_FILE_SIZE_BYTES;
  }

  /**
   * Enumerate returns one ScanItem per reviewable file.
   * Mirrors Go `Provider.Enumerate(ctx)`.
   *
   * Binary files are emitted with empty content and isBinary=true so
   * previews can surface them without spending memory on their bytes.
   */
  async enumerate(signal?: AbortSignal): Promise<ScanItem[]> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const files = await this.listFiles(signal);
    const filtered = this.paths.length > 0 ? filterByPaths(files, this.paths) : files;
    const out: ScanItem[] = [];

    for (const rel of filtered) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (rel === "") continue;

      const full = path.join(this.repoDir, rel);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > this.maxFileSizeBytes) continue;

      let binary: boolean;
      try {
        binary = await isBinaryFile(full);
      } catch {
        continue;
      }
      if (binary) {
        out.push({ path: rel, content: "", isBinary: true, lineCount: 0 });
        continue;
      }
      let content: string;
      try {
        content = await fs.promises.readFile(full, "utf-8");
      } catch {
        continue;
      }
      out.push({ path: rel, content, isBinary: false, lineCount: countLines(content) });
    }
    return out;
  }

  /** Alias matching Go method name. */
  Enumerate(signal?: AbortSignal): Promise<ScanItem[]> {
    return this.enumerate(signal);
  }

  private async listFiles(signal?: AbortSignal): Promise<string[]> {
    const insideGit = await isGitRepo(this.repoDir, signal);
    if (insideGit) {
      try {
        return await this.listFilesViaGit(signal);
      } catch {
        // fall back to walk if git is unavailable
      }
    }
    return this.listFilesViaWalk(signal);
  }

  private async listFilesViaGit(signal?: AbortSignal): Promise<string[]> {
    const tracked = await gitLs(this.repoDir, ["-z"], signal);
    const untracked = await gitLs(this.repoDir, ["-z", "--others", "--exclude-standard"], signal);
    const seen = new Set<string>();
    const all: string[] = [];
    for (const f of [...tracked, ...untracked]) {
      if (f === "" || seen.has(f)) continue;
      seen.add(f);
      all.push(f);
    }
    return all;
  }

  private async listFilesViaWalk(signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    // Load root .gitignore for non-git fallback to mirror Go's walk filtering
    const ignorePatterns = await loadGitignorePatterns(this.repoDir);
    const excludedDirs = new Set(["node_modules", ".git"]);
    await walkDir(this.repoDir, "", out, signal, ignorePatterns, excludedDirs);
    return out;
  }
}

/** Factory — mirrors Go `NewProvider`. */
export function NewProvider(
  repoDir: string,
  paths: readonly string[] | null | undefined = [],
  _runner?: unknown,
  maxFileSizeBytes?: number,
): Provider {
  return new Provider(repoDir, paths, maxFileSizeBytes);
}
export const newProvider = NewProvider;

// ---------------------------------------------------------------------------
// Helpers — mirrors Go helpers
// ---------------------------------------------------------------------------

function filterByPaths(all: readonly string[], paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of all) {
    for (const want of paths) {
      if (f === want || f.startsWith(want + "/")) {
        out.push(f);
        break;
      }
    }
  }
  return out;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") n++;
  if (content[content.length - 1] !== "\n") n++;
  return n;
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_WINDOW);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_WINDOW, 0);
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
    return false;
  } finally {
    await fh.close();
  }
}

async function isGitRepo(repoDir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit(repoDir, ["rev-parse", "--git-dir"], signal);
    return true;
  } catch {
    return false;
  }
}

async function gitLs(repoDir: string, args: string[], signal?: AbortSignal): Promise<string[]> {
  const out = await runGit(repoDir, ["-c", "core.quotepath=false", "ls-files", ...args], signal);
  // NUL-delimited
  const raw = out.split("\x00");
  const files: string[] = [];
  for (let f of raw) {
    f = f.trim();
    if (f !== "") files.push(f);
  }
  return files;
}

function runGit(repoDir: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const child = spawn("git", args, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf-8"));
      else reject(new Error(`git ${args.join(" ")} exited with ${String(code)}`));
    });
    signal?.addEventListener("abort", () => {
      try {
        child.kill();
      } catch {}
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

async function walkDir(repoDir: string, rel: string, out: string[], signal?: AbortSignal, ignorePatterns: string[] = [], excludedDirs: Set<string> = new Set([".git"])): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const full = rel === "" ? repoDir : path.join(repoDir, rel);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(full, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const nextRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (excludedDirs.has(nextRel) || [...excludedDirs].some((d) => nextRel.startsWith(d + "/"))) continue;
      if (isIgnored(nextRel + "/", ignorePatterns)) continue;
      await walkDir(repoDir, nextRel, out, signal, ignorePatterns, excludedDirs);
    } else if (entry.isFile()) {
      if (isIgnored(nextRel, ignorePatterns)) continue;
      out.push(nextRel);
    }
  }
}

async function loadGitignorePatterns(repoDir: string): Promise<string[]> {
  try {
    const raw = await fs.promises.readFile(path.join(repoDir, ".gitignore"), "utf-8");
    return raw.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  } catch { return []; }
}
function isIgnored(rel: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    // Simple handling for test patterns like "ignored.txt" and directory ignores
    const clean = pat.replace(/^\//, "").replace(/\/$/, "");
    if (clean === "") continue;
    if (!clean.includes("*") && !clean.includes("?")) {
      if (rel === clean || rel.endsWith("/" + clean) || rel.startsWith(clean + "/")) return true;
    } else {
      // minimal glob: treat * as any substring
      const regex = new RegExp("^" + clean.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      if (regex.test(rel)) return true;
    }
  }
  return false;
}

// Exposed for tests
export const __test = { filterByPaths, countLines };

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/parser.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Unified diff parser — mirrors Go `parser.go`.
 * Splits combined diff text into per-file `Diff` structs, counting
 * insertions/deletions, handling binary/rename/delete/new markers,
 * and finalizing new-file content via git show or workspace read.
 */

import type { Diff } from "../model/diff.js";
import { createDiff } from "../model/diff.js";
import { readWorkspaceFileForDiff } from "./workspace.js";
import type { Runner } from "./runner.js";

// ---------------------------------------------------------------------------
// Regexes — mirrors Go `diffHeaderRe` / `binaryRe`
// ---------------------------------------------------------------------------

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
// Anchored per Go comment: "Binary files a/x and b/y differ"
const BINARY_RE = /^Binary files /;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseDiffOptions {
  /** AbortSignal propagated to git runner calls (mirrors Go context). */
  signal?: AbortSignal;
}

/**
 * ParseDiffText splits unified diff text into per-file Diff structs.
 * When `ref` is non-empty, new file content is read via `git show ref:path`
 * (through runner if provided); otherwise from the working tree.
 * Mirrors Go `ParseDiffText`. Deterministic ordering is preserved.
 */
export async function parseDiffText(
  diffText: string,
  repoDir: string,
  ref: string,
  runner: Runner | null,
  opts: ParseDiffOptions = {},
): Promise<Diff[]> {
  const lines = diffText.split("\n");
  const diffs: Diff[] = [];
  let current: Diff | null = null;
  let buf = "";
  let inHunk = false;

  // Mirror Go's 2-minute timeout via AbortSignal composition.
  const timeoutSignal = AbortSignal.timeout(2 * 60 * 1000);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  for (const line of lines) {
    const m = DIFF_HEADER_RE.exec(line);
    if (m) {
      if (current !== null) {
        current.diff = buf.endsWith("\n") ? buf.slice(0, -1) : buf;
        await finalizeDiff(current, repoDir, ref, runner, signal);
        diffs.push(current);
        buf = "";
      }
      current = createDiff({
        oldPath: m[1]!,
        newPath: m[2]!,
      });
      inHunk = false;
    }

    if (current === null) continue;

    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (!inHunk && line.startsWith("index ")) {
      continue;
    } else if (!inHunk && BINARY_RE.test(line)) {
      current.isBinary = true;
    } else if (line.startsWith("new file mode ")) {
      current.isNew = true;
    } else if (line.startsWith("deleted file mode ")) {
      current.isDeleted = true;
    } else if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
      current.isRenamed = true;
    } else if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length);
      current.isRenamed = true;
    } else if (!inHunk && line === "--- /dev/null") {
      current.isNew = true;
    } else if (!inHunk && line === "+++ /dev/null") {
      current.isDeleted = true;
    } else if (inHunk && line.startsWith("+")) {
      current.insertions++;
    } else if (inHunk && line.startsWith("-")) {
      current.deletions++;
    }

    buf += line + "\n";
  }

  if (current !== null) {
    current.diff = buf.endsWith("\n") ? buf.slice(0, -1) : buf;
    await finalizeDiff(current, repoDir, ref, runner, signal);
    diffs.push(current);
  }

  return diffs;
}

export const ParseDiffText = parseDiffText;

// ---------------------------------------------------------------------------
// Finalization — mirrors Go `finalizeDiff`
// ---------------------------------------------------------------------------

async function finalizeDiff(
  d: Diff,
  repoDir: string,
  ref: string,
  runner: Runner | null,
  signal: AbortSignal,
): Promise<void> {
  if (d.isDeleted || d.newPath === "/dev/null") {
    d.newPath = "/dev/null";
    return;
  }

  if (ref !== "") {
    const args = ["-c", "core.quotepath=false", "show", "--end-of-options", `${ref}:${d.newPath}`];
    try {
      let output: Buffer;
      if (runner !== null) {
        output = await runner.output(repoDir, args, signal);
      } else {
        // Direct fallback — spawn without runner semaphore.
        const { spawn } = await import("node:child_process");
        output = await new Promise<Buffer>((resolve, reject) => {
          const child = spawn("git", args, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], shell: false });
          const chunks: Buffer[] = [];
          const errChunks: Buffer[] = [];
          child.stdout.on("data", (c: Buffer) => chunks.push(c));
          child.stderr.on("data", (c: Buffer) => errChunks.push(c));
          child.on("error", reject);
          child.on("close", (code) => {
            if (code !== 0) reject(new Error(`git show failed with ${code}: ${Buffer.concat(errChunks).toString("utf-8")}`));
            else resolve(Buffer.concat(chunks));
          });
        });
      }
      d.newFileContent = output.toString("utf-8");
    } catch (err) {
      // Mirror Go's fmt.Fprintf(os.Stderr, "[pi-review] WARNING: ...")
      console.error(`[pi-review] WARNING: cannot read file ${d.newPath} at ref ${ref}: ${String((err as Error).message)}`);
    }
    return;
  }

  try {
    const content = await readWorkspaceFileForDiff(repoDir, d.newPath);
    d.newFileContent = content.toString("utf-8");
  } catch (err) {
    console.error(`[pi-review] WARNING: cannot read file ${d.newPath} for review: ${String((err as Error).message)}`);
  }
}

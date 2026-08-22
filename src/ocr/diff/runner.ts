// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/gitcmd/runner.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Runner limits concurrent git subprocesses via an internal semaphore.
 * Mirrors Go's `gitcmd.Runner`. Every git invocation in the parity engine
 * must go through a shared Runner so concurrent model loops do not exhaust
 * file descriptors.
 *
 * Uses argv arrays (spawn), never shell interpolation. Treats refs and
 * repository-relative paths as hostile input.
 */

import { spawn } from "node:child_process";

const DEFAULT_MAX_CONCURRENT = 16;

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

/**
 * Simple counting semaphore with FIFO queue and AbortSignal support.
 * Mirrors Go's `chan struct{}` + `select` on ctx.Done().
 */
class Semaphore {
  private readonly capacity: number;
  private current = 0;
  private readonly queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(capacity: number) {
    this.capacity = capacity > 0 ? capacity : DEFAULT_MAX_CONCURRENT;
  }

  get cap(): number {
    return this.capacity;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
    }
    if (this.current < this.capacity) {
      this.current++;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const idx = this.queue.findIndex((e) => e.resolve === resolveWrapper);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason ?? "aborted")));
      };

      const resolveWrapper = (): void => {
        // Detach abort listener if it was attached.
        if (signal) signal.removeEventListener("abort", onAbort);
        this.current++;
        resolve();
      };

      const entry = { resolve: resolveWrapper, reject, signal, onAbort };
      this.queue.push(entry);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    // Decrement current count; hand off to next waiter if queued.
    if (this.current > 0) this.current--;
    const next = this.queue.shift();
    if (next) {
      // Remove abort listener before resolving to avoid double-reject races.
      if (next.signal) next.signal.removeEventListener("abort", next.onAbort);
      next.resolve();
    }
  }
}

// ---------------------------------------------------------------------------
// Child execution helpers
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  signal: NodeJS.Signals | null;
}

function execGit(
  repoDir: string,
  args: string[],
  signal?: AbortSignal,
  opts?: { combine?: boolean },
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted")));
      return;
    }

    const child = spawn("git", args, {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      // Do NOT use shell: argv array semantics required.
      shell: false,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      reject(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason ?? "aborted")));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code, sig) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        status: code,
        signal: sig,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Runner — public API mirrors Go
// ---------------------------------------------------------------------------

export class Runner {
  private readonly sem: Semaphore;

  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    this.sem = new Semaphore(maxConcurrent);
  }

  /** Expose capacity for diagnostics — mirrors Go `cap(r.sem)`. */
  get capacity(): number {
    return this.sem.cap;
  }

  // Internal acquire/release mirroring Go's acquire/release helpers.
  private async acquire(signal?: AbortSignal): Promise<void> {
    await this.sem.acquire(signal);
  }

  private release(): void {
    this.sem.release();
  }

  /**
   * Run executes `git <args>` in repoDir and returns combined stdout+stderr
   * as a string. Mirrors Go `Runner.Run`.
   */
  async run(repoDir: string, args: string[], signal?: AbortSignal): Promise<string> {
    await this.acquire(signal);
    try {
      const res = await execGit(repoDir, args, signal);
      const combined = Buffer.concat([res.stdout, res.stderr]).toString("utf-8");
      if (res.status !== 0) {
        // Go returns CombinedOutput + err (non-zero exit is an error).
        // We surface combined text and throw so callers can inspect it.
        const err = new Error(`git ${args.join(" ")} failed with exit ${res.status}: ${combined.slice(0, 500)}`) as Error & { combined: string; status: number | null };
        (err as unknown as Record<string, unknown>)["combined"] = combined;
        (err as unknown as Record<string, unknown>)["status"] = res.status;
        throw err;
      }
      return combined;
    } finally {
      this.release();
    }
  }

  /**
   * Output executes `git <args>` and returns stdout only. Mirrors Go `Runner.Output`.
   */
  async output(repoDir: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
    await this.acquire(signal);
    try {
      const res = await execGit(repoDir, args, signal);
      if (res.status !== 0) {
        const combined = res.stderr.toString("utf-8");
        const err = new Error(`git ${args.join(" ")} failed with exit ${res.status}: ${combined.slice(0, 500)}`) as Error & { status: number | null };
        (err as unknown as Record<string, unknown>)["status"] = res.status;
        throw err;
      }
      return res.stdout;
    } finally {
      this.release();
    }
  }

  /**
   * RunSplit executes `git <args>` and returns stdout and stderr separately.
   * Mirrors Go `Runner.RunSplit`.
   */
  async runSplit(
    repoDir: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    await this.acquire(signal);
    try {
      const res = await execGit(repoDir, args, signal);
      if (res.status !== 0) {
        const err = new Error(`git ${args.join(" ")} failed with exit ${res.status}`) as Error & { status: number | null };
        (err as unknown as Record<string, unknown>)["status"] = res.status;
        throw err;
      }
      return { stdout: res.stdout.toString("utf-8"), stderr: res.stderr.toString("utf-8") };
    } finally {
      this.release();
    }
  }

  /**
   * Stream acquires the semaphore, starts git, and passes stdout as a
   * readable stream to consume(). The semaphore is held for the full
   * duration. consume MUST drain stdout before returning.
   * Mirrors Go `Runner.Stream`.
   */
  async stream(
    repoDir: string,
    consume: (stdout: NodeJS.ReadableStream) => Promise<void> | void,
    args: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.acquire(signal);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));

      child = spawn("git", args, {
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      const stderrChunks: Buffer[] = [];
      child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

      const onAbort = (): void => {
        try {
          child?.kill("SIGTERM");
        } catch {
          // ignore
        }
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      let consumeErr: unknown = undefined;
      try {
        if (child.stdout === null) throw new Error("git child stdout is null");
        await consume(child.stdout);
      } catch (e) {
        consumeErr = e;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }

      const closePromise = new Promise<{ code: number | null; errStderr: string }>((resolve, reject) => {
        child!.on("error", reject);
        child!.on("close", (code) => {
          resolve({ code, errStderr: Buffer.concat(stderrChunks).toString("utf-8") });
        });
      });

      const { code, errStderr } = await closePromise;
      if (signal) signal.removeEventListener("abort", onAbort);

      if (consumeErr !== undefined) throw consumeErr;
      if (code !== 0) {
        if (errStderr.length > 0) throw new Error(`git ${args.join(" ")} failed: ${errStderr}`);
        throw new Error(`git ${args.join(" ")} failed with exit ${code}`);
      }
    } finally {
      this.release();
    }
  }
}

/** Alias matching Go's `gitcmd.New`. */
export function newRunner(maxConcurrent = DEFAULT_MAX_CONCURRENT): Runner {
  return new Runner(maxConcurrent);
}

export const defaultMaxConcurrent = DEFAULT_MAX_CONCURRENT;

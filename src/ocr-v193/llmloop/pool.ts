// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/llmloop/pool.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Behavioral port of OCR v1.9.3's CommentWorkerPool (internal/llmloop/pool.go).
 *
 * Maps Go concurrency to JS:
 * - chan struct{} semaphore -> counting semaphore with waiter queue
 * - sync.WaitGroup (global + per-key) -> Set<Promise<void>> snapshots + Promise.all
 * - panic recovery via recover() -> try/catch + console.warn
 * - sync.Mutex on results -> single-threaded push (JS is cooperative; no mutex needed)
 *
 * Concurrency contracts mirror Go:
 * - Await must not run concurrently with Submit (caller ensures every Submit has
 *   returned before calling Await). Submit racing Await would miss the new work
 *   in the snapshot; Go would panic on WaitGroup misuse.
 * - SubmitFor/AwaitKey per-key isolation is safe to interleave across keys:
 *   AwaitKey only snapshots its own key's promises.
 * - For a given key, all SubmitFor calls must happen-before the matching
 *   AwaitKey call (same as Go).
 *
 * No legacy imports; file is isolated under src/ocr-v193/llmloop.
 */

import type { LlmComment } from "../model/types.js";

export type { LlmComment };

/** Unit of work: mirrors `func() ([]model.LlmComment, error)` in Go. */
export type CommentTask = () => Promisable<LlmComment[] | null | undefined>;

type Promisable<T> = T | Promise<T>;

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

/**
 * Counting semaphore with FIFO waiter queue.
 * `permits` tracks available slots; waiters are resolvers queued when no
 * permit is available. Release hands the permit directly to the next waiter
 * without bumping `permits` (avoids double-count).
 */
class Semaphore {
  private permits: number;
  private readonly capacity_: number;
  private readonly queue: Array<() => void> = [];

  constructor(capacity: number) {
    this.permits = capacity;
    this.capacity_ = capacity;
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next !== undefined) {
      // Pass the permit directly to the waiter; permits stays at 0.
      next();
    } else {
      this.permits += 1;
    }
  }

  get capacity(): number {
    return this.capacity_;
  }
}

// ---------------------------------------------------------------------------
// CommentWorkerPool
// ---------------------------------------------------------------------------

export class CommentWorkerPool {
  private readonly semaphore: Semaphore;
  private readonly capacity: number;
  private results: LlmComment[] = [];
  /** Global pending promises – equivalent to sync.WaitGroup wg. */
  private readonly globalPending = new Set<Promise<void>>();
  /** Per-key pending promises – equivalent to map[string]*sync.WaitGroup. */
  private readonly keys = new Map<string, Set<Promise<void>>>();

  constructor(workerCount?: number) {
    let n = workerCount ?? 0;
    if (!n || n <= 0) n = 8;
    this.capacity = n;
    this.semaphore = new Semaphore(n);
  }

  /**
   * Expose configured concurrency (mirrors cap(p.semaphore) in Go tests).
   */
  get workerCount(): number {
    return this.capacity;
  }

  // -- core ---------------------------------------------------------------

  /**
   * Submit runs f in the background bounded by the semaphore.
   * Return value is collected internally; errors/panics are logged and
   * contribute no comments, matching Go's recover + error log behavior.
   */
  Submit(task: CommentTask): void {
    this.submitInternal(task, null);
  }

  /**
   * SubmitFor is Submit plus registration under `key`, so AwaitKey can wait
   * for exactly the units submitted under that key without waiting for
   * other keys. Mirrors Go's SubmitFor contract.
   */
  SubmitFor(key: string, task: CommentTask): void {
    let set = this.keys.get(key);
    if (set === undefined) {
      set = new Set<Promise<void>>();
      this.keys.set(key, set);
    }
    this.submitInternal(task, set);
  }

  /**
   * Await blocks until all submitted work has completed and returns
   * aggregated results. Snapshots the current global pending set (like
   * wg.Wait). Caller must not race Submit with Await.
   */
  async Await(): Promise<LlmComment[]> {
    const snapshot = [...this.globalPending];
    if (snapshot.length > 0) {
      await Promise.all(snapshot);
    }
    // Return the accumulated slice, mirroring Go's return of p.results
    // (nil when no submissions -> translate to empty array in JS).
    return this.results;
  }

  /**
   * AwaitKey blocks until every unit submitted under key so far has
   * completed. Safe to call while other keys still have submissions
   * in flight (unlike Await). Waiting on an unknown key returns immediately.
   */
  async AwaitKey(key: string): Promise<void> {
    const set = this.keys.get(key);
    if (set === undefined || set.size === 0) return;
    const snapshot = [...set];
    if (snapshot.length > 0) {
      await Promise.all(snapshot);
    }
  }

  // -- idiomatic aliases (camelCase) --------------------------------------

  /** Alias for {@link Submit}. */
  submit(task: CommentTask): void {
    this.Submit(task);
  }

  /** Alias for {@link SubmitFor}. */
  submitFor(key: string, task: CommentTask): void {
    this.SubmitFor(key, task);
  }

  /** Alias for {@link Await}. */
  awaitAll(): Promise<LlmComment[]> {
    return this.Await();
  }

  /** Alias for {@link AwaitKey}. */
  awaitKey(key: string): Promise<void> {
    return this.AwaitKey(key);
  }

  // -- internal -----------------------------------------------------------

  private submitInternal(task: CommentTask, keySet: Set<Promise<void>> | null): void {
    const p = this.run(task);
    // Register synchronously before the async work starts, mirroring
    // WaitGroup.Add(1) happening synchronously inside wg.Go.
    this.globalPending.add(p);
    if (keySet !== null) {
      keySet.add(p);
    }
    // Prevent unhandled rejection from surfacing; task panics/errors are
    // already recovered inside run(). This catch is a safety net for
    // semaphore or bookkeeping failures.
    void p.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? (err.stack ?? "") : "";
      console.warn(`[ocr] CommentWorkerPool panic: ${msg}\n${stack}`);
    });
  }

  private async run(task: CommentTask): Promise<void> {
    await this.semaphore.acquire();
    try {
      let comments: LlmComment[] | null | undefined;
      try {
        const r = await task();
        comments = r;
      } catch (err: unknown) {
        // Contain panic/error so one bad unit cannot crash the process,
        // matching Go's defer recover() block.
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? (err.stack ?? "") : "";
        console.warn(`[ocr] CommentWorkerPool panic: ${msg}\n${stack}`);
        comments = undefined;
      }

      // Go logs `CommentWorkerPool error: %v` when err != nil but still
      // appends any returned comments. In TS, a thrown error is treated as
      // panic above (no comments). If the task returns an array alongside
      // an error signal, the task should instead return the array and handle
      // its own logging. We simply aggregate whatever array was produced.
      if (comments && comments.length > 0) {
        // Single-threaded push is safe; no mutex needed in JS.
        this.results.push(...comments);
      }
    } finally {
      this.semaphore.release();
    }
  }
}

/**
 * Factory mirroring Go's `NewCommentWorkerPool`.
 * workerCount <= 0 (or omitted) defaults to 8.
 */
export function newCommentWorkerPool(workerCount?: number): CommentWorkerPool {
  return new CommentWorkerPool(workerCount);
}

// Default export for convenience; named export is preferred.
export default CommentWorkerPool;

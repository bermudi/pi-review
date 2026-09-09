// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 pi-reviewer Contributors
//
// pi-reviewer extension (not OCR behavior): provider rate-limit backoff.
//
// OCR v1.9.9 fails a file the moment its model round errors. Providers under
// load answer 429 (rate_limited) or 529 (overloaded) long before the account
// is out of quota, and an eight-way review burst can trip those limits even
// while single requests succeed. Treating "slow down" as fatal turns one
// rejected request into a fully failed run.
//
// This module retries a failed model round — same request, same logical
// request id — after a growing backoff, bounded by a fixed schedule. The
// transport's retry collector sees every attempt (the collector reopens
// finalized entries for retried requests), so the retry report keeps telling
// the truth: retried, recovered, or failed after exhausting the schedule.
//
// Deliberate boundaries:
// - Only `rate_limited` (429) and `overloaded` (529) retry. Authentication,
//   context, cancellation, and unknown failures surface immediately.
// - The schedule is per round, not global: concurrent files each back off
//   independently; no cross-file damper (yet).
// - Backoff waits are abort-aware: run cancellation and the per-file deadline
//   interrupt the wait, never mask it, and keep their cancellation semantics.

import { httpStatusFromError } from "../retry/boundary.js";
import {
  classifyAttempt,
  ErrorClassOverloaded,
  ErrorClassRateLimited,
} from "../retry/types.js";

/**
 * Default backoff schedule: one retry after 5s, another after 15s, a last
 * after 45s (total worst-case added latency 65s per affected round). Kept
 * well under the default per-file idle timeout (5 min) so a wait cannot look
 * like a hung file. Empty array disables retries.
 */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000];

/**
 * True when the error classifies as rate_limited or overloaded — the two
 * provider conditions where waiting is the documented remedy. Classification
 * uses the same status table as the retry report (distilled `httpStatus` or
 * SDK status fields on the cause chain), so what retries is exactly what the
 * report labels.
 */
export function isRetryableProviderError(err: unknown): boolean {
  const { errorClass } = classifyAttempt({ statusCode: httpStatusFromError(err) ?? 0, err });
  return errorClass === ErrorClassRateLimited || errorClass === ErrorClassOverloaded;
}

/**
 * Build the error thrown when `signal` aborts during a backoff wait. Mirrors
 * the pi-transport abort mapping: the abort reason (per-file deadline
 * "file task timeout", run cancellation "review was cancelled") keeps its
 * message so downstream classification stays honest; a bare abort stays a
 * generic AbortError.
 */
export function abortErrorForSignal(signal: AbortSignal): Error {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) {
    if (reason.name === "AbortError") return reason;
    if (reason.message !== "") return new Error(reason.message, { cause: reason });
  }
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/** Abort-aware sleep: resolves after `ms`, rejects immediately if `signal` aborts. */
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortErrorForSignal(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortErrorForSignal(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ProviderBackoffOptions {
  /** Millisecond delays before each retry; length bounds the retry count. */
  readonly schedule: readonly number[];
  /** Injectable sleep for deterministic tests. Defaults to `sleepWithAbort`. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Emitted before each wait with the 1-based retry number, the delay, and
   * the failure that triggered it. Hosts surface this as a human-channel
   * milestone; it must stay rare by construction.
   */
  readonly onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Run `call`, retrying rate-limited/overloaded failures on the given
 * schedule. The same request is re-issued unchanged, so the retry collector
 * records every attempt under one logical request. Non-retryable failures and
 * aborts rethrow immediately; exhausting the schedule rethrows the last
 * failure.
 */
export async function completeWithProviderBackoff<T>(
  call: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  options: ProviderBackoffOptions,
): Promise<T> {
  const sleep = options.sleep ?? sleepWithAbort;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call(signal);
    } catch (err) {
      if (signal.aborted) throw err;
      const delay = options.schedule[attempt];
      if (delay === undefined || !isRetryableProviderError(err)) {
        throw err;
      }
      options.onRetry?.({ attempt: attempt + 1, delayMs: delay, error: err });
      await sleep(delay, signal);
    }
  }
}

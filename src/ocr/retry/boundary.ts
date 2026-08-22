// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/retry_boundary.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import {
  ErrorClassCancelled,
  ErrorClassNetwork,
  ErrorClassProvider,
  ErrorClassTimeout,
  ErrorClassUnknown,
  FailurePhaseContext,
  FailurePhaseResponseDecode,
  FailurePhaseStream,
  isAbortError,
  isTimeoutError,
  isUnexpectedEOF,
  type ErrorClass,
  type FailurePhase,
} from "./types.js";
import { requestMetaFromContext } from "./meta.js";
import type { RetryCollector } from "./collector.js";

export const errRequestPanicked = new Error("llm request panicked");

export class StreamIntegrityError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`OpenAI streaming response ${reason}`);
    this.name = "StreamIntegrityError";
    this.reason = reason;
  }
}

export class StreamError extends Error {
  constructor(message = "stream error") {
    super(message);
    this.name = "StreamError";
  }
}

function isSyntaxError(err: unknown): boolean {
  return err instanceof SyntaxError;
}

function isUnmarshalTypeError(err: unknown): boolean {
  // In JS, type errors are TypeError; we treat as unmarshal type error if message contains
  return err instanceof TypeError;
}

export function classifyBoundaryError(err: unknown): {
  errorClass: ErrorClass;
  failurePhase: FailurePhase;
  recognized: boolean;
} {
  if (err === null || err === undefined) return { errorClass: "" as ErrorClass, failurePhase: "" as FailurePhase, recognized: false };
  if (isAbortError(err)) return { errorClass: ErrorClassCancelled, failurePhase: FailurePhaseContext, recognized: true };
  if (isTimeoutError(err)) return { errorClass: ErrorClassTimeout, failurePhase: FailurePhaseContext, recognized: true };
  if (isUnexpectedEOF(err)) return { errorClass: ErrorClassNetwork, failurePhase: FailurePhaseResponseDecode, recognized: true };
  // Unwrap cause for syntax/type errors
  let cur: unknown = err;
  for (let i = 0; i < 5; i++) {
    if (isSyntaxError(cur) || isUnmarshalTypeError(cur)) {
      return { errorClass: ErrorClassUnknown, failurePhase: FailurePhaseResponseDecode, recognized: true };
    }
    const cause = (cur as Record<string, unknown>)?.["cause"];
    if (cause === undefined) break;
    cur = cause;
  }
  // Also check message wrapping for Go's "error parsing response json: ..."
  if (typeof err === "object" && err !== null) {
    const msg = String((err as Record<string, unknown>)["message"] ?? "");
    if (msg.includes("error parsing response json")) {
      // Need to inspect cause for SyntaxError
      const cause = (err as Record<string, unknown>)["cause"];
      if (isSyntaxError(cause) || isUnmarshalTypeError(cause)) {
        return { errorClass: ErrorClassUnknown, failurePhase: FailurePhaseResponseDecode, recognized: true };
      }
    }
  }
  return { errorClass: "" as ErrorClass, failurePhase: "" as FailurePhase, recognized: false };
}

export function classifyStreamError(err: unknown): { errorClass: ErrorClass; failurePhase: FailurePhase } {
  if (err instanceof StreamIntegrityError || err instanceof StreamError) {
    return { errorClass: ErrorClassProvider, failurePhase: FailurePhaseStream };
  }
  // Check wrapped
  if (hasCauseInstance(err, StreamIntegrityError) || hasCauseInstance(err, StreamError)) {
    return { errorClass: ErrorClassProvider, failurePhase: FailurePhaseStream };
  }
  if (isAbortError(err)) return { errorClass: ErrorClassCancelled, failurePhase: FailurePhaseContext };
  if (isTimeoutError(err)) return { errorClass: ErrorClassTimeout, failurePhase: FailurePhaseContext };
  return { errorClass: ErrorClassUnknown, failurePhase: FailurePhaseStream };
}

function hasCauseInstance(err: unknown, cls: new (...args: never[]) => Error): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5; i++) {
    if (cur instanceof cls) return true;
    const cause = (cur as Record<string, unknown>)?.["cause"];
    if (cause === undefined) break;
    cur = cause;
  }
  return false;
}

export function reviseAttempt(
  ctx: unknown,
  collector: RetryCollector | null | undefined,
  errorClass: ErrorClass,
  failurePhase: FailurePhase,
): void {
  if (collector === null || collector === undefined) return;
  const { meta, ok } = requestMetaFromContext(ctx);
  if (!ok) return;
  collector.reviseLastAttempt(meta, errorClass, failurePhase);
}

export function finalizeRequest(
  ctx: unknown,
  collector: RetryCollector | null | undefined,
  reqErr: unknown,
): void {
  if (collector === null || collector === undefined) return;
  const { meta, ok } = requestMetaFromContext(ctx);
  if (!ok) return;
  const { errorClass, failurePhase, recognized } = classifyBoundaryError(reqErr);
  if (recognized) {
    collector.reviseLastAttempt(meta, errorClass, failurePhase);
  }
  // parentCancelled only for AbortError, not timeout
  const parentCancelled = isAbortError((ctx as Record<string, unknown>)?.["__signalErr"] ?? (ctx as Record<string, unknown>)?.["signalReason"] ?? null) ? true : false;
  // Better: check if ctx has signal aborted - we need signal from context object
  // For TS port, we check if ctx is an object with aborted signal via custom field or AbortSignal
  let cancelled = false;
  if (typeof ctx === "object" && ctx !== null) {
    const maybeSignal = (ctx as Record<string, unknown>)["signal"];
    if (maybeSignal instanceof AbortSignal && maybeSignal.aborted) {
      const reason = (maybeSignal as unknown as Record<string, unknown>)["reason"];
      if (reason instanceof DOMException && reason.name === "AbortError") cancelled = true;
      else if (reason !== undefined && isAbortError(reason)) cancelled = true;
      else if (maybeSignal.aborted) {
        // If signal aborted but reason not AbortError, treat as cancelled only if AbortError
        cancelled = reason === undefined ? true : isAbortError(reason);
      }
    }
    // Alternative: ctx itself is AbortSignal
    if (ctx instanceof AbortSignal && ctx.aborted) {
      const r = (ctx as unknown as Record<string, unknown>)["reason"];
      cancelled = r === undefined ? true : isAbortError(r);
    }
  }
  // For tests, we pass parentCancelled via explicit ctx err check: if ctx has cause AbortError
  // Safer: detect if root cause is AbortError not Timeout
  const ctxErr = (ctx as Record<string, unknown>)?.["ctxErr"];
  if (ctxErr !== undefined && isAbortError(ctxErr)) cancelled = true;
  // Fallback: if ctx object has _cancelled flag
  if ((ctx as Record<string, unknown>)?.["_cancelled"] === true) cancelled = true;

  // Use helper that checks ctx's signal if available
  collector.finalize(meta, reqErr, cancelled);
}

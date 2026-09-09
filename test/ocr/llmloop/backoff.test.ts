// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 pi-reviewer Contributors
//
// Contracts for the pi-reviewer rate-limit backoff extension: a model round
// that fails as rate_limited (429) or overloaded (529) is retried on a fixed,
// injectable schedule instead of failing the file. Only those two classes
// retry; everything else (auth, context, cancellation, unknown) surfaces
// immediately. Waits are abort-aware and each retry emits one human-channel
// milestone notice.

import { describe, test, expect } from "bun:test";
import {
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  isRetryableProviderError,
  sleepWithAbort,
  abortErrorForSignal,
  completeWithProviderBackoff,
} from "../../../src/ocr/llmloop/backoff.js";
import { Runner } from "../../../src/ocr/llmloop/loop.js";
import { ScriptedTransport } from "../../../src/ocr/llmloop/transcript.js";
import type { ToolDef } from "../../../src/ocr/llmloop/types.js";
import { newTextMessage } from "../../../src/ocr/llmloop/compression.js";

function rateLimitedError(status = 429): Error {
  return Object.assign(new Error(`Pi assistant turn ended with stop reason error (HTTP ${status})`), { httpStatus: status });
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("provider backoff classification", () => {
  test("429 and 529 are retryable", () => {
    expect(isRetryableProviderError(rateLimitedError(429))).toBe(true);
    expect(isRetryableProviderError(rateLimitedError(529))).toBe(true);
  });

  test("other statuses, plain errors, and aborts are not retryable", () => {
    expect(isRetryableProviderError(Object.assign(new Error("auth"), { httpStatus: 401 }))).toBe(false);
    expect(isRetryableProviderError(Object.assign(new Error("gone"), { httpStatus: 500 }))).toBe(false);
    expect(isRetryableProviderError(new Error("plain failure"))).toBe(false);
    const abort = new DOMException("Aborted", "AbortError");
    expect(isRetryableProviderError(abort)).toBe(false);
  });

  test("default schedule is bounded and non-empty", () => {
    expect(DEFAULT_RATE_LIMIT_BACKOFF_MS.length).toBeGreaterThan(0);
    for (const ms of DEFAULT_RATE_LIMIT_BACKOFF_MS) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThan(60_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Abort-aware sleep
// ---------------------------------------------------------------------------

describe("sleepWithAbort", () => {
  test("resolves after the delay", async () => {
    const started = Date.now();
    await sleepWithAbort(5, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });

  test("rejects immediately when the signal is already aborted, preserving the reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("review was cancelled"));
    try {
      await sleepWithAbort(60_000, controller.signal);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("review was cancelled");
    }
  });

  test("rejects when aborted mid-wait", async () => {
    const controller = new AbortController();
    const pending = sleepWithAbort(60_000, controller.signal);
    setTimeout(() => controller.abort(new Error("file task timeout")), 5);
    try {
      await pending;
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("file task timeout");
    }
  });

  test("abortErrorForSignal keeps a bare abort an AbortError", () => {
    const controller = new AbortController();
    controller.abort();
    const err = abortErrorForSignal(controller.signal);
    expect(err.name).toBe("AbortError");
  });
});

// ---------------------------------------------------------------------------
// completeWithProviderBackoff
// ---------------------------------------------------------------------------

describe("completeWithProviderBackoff", () => {
  test("retries rate-limited calls on the schedule and succeeds", async () => {
    const delays: number[] = [];
    const notices: string[] = [];
    let calls = 0;
    const result = await completeWithProviderBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw rateLimitedError();
        return "ok";
      },
      new AbortController().signal,
      {
        schedule: [10, 20],
        sleep: async (ms) => {
          delays.push(ms);
        },
        onRetry: ({ attempt, delayMs, error }) => {
          notices.push(`${attempt}:${delayMs}:${(error as Error).message}`);
        },
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
    expect(notices).toEqual([
      `1:10:${rateLimitedError().message}`,
      `2:20:${rateLimitedError().message}`,
    ]);
  });

  test("exhausting the schedule rethrows the last failure", async () => {
    const delays: number[] = [];
    let calls = 0;
    try {
      await completeWithProviderBackoff(
        async () => {
          calls += 1;
          throw rateLimitedError();
        },
        new AbortController().signal,
        { schedule: [1, 1, 1], sleep: async (ms) => { delays.push(ms); } },
      );
      expect.unreachable();
    } catch (err) {
      expect((err as { httpStatus?: number }).httpStatus).toBe(429);
    }
    expect(calls).toBe(4);
    expect(delays).toEqual([1, 1, 1]);
  });

  test("non-retryable failures surface immediately without sleeping", async () => {
    let calls = 0;
    let slept = 0;
    try {
      await completeWithProviderBackoff(
        async () => {
          calls += 1;
          throw new Error("authentication failed");
        },
        new AbortController().signal,
        { schedule: [10, 10], sleep: async () => { slept += 1; } },
      );
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("authentication failed");
    }
    expect(calls).toBe(1);
    expect(slept).toBe(0);
  });

  test("an abort between attempts stops the retry loop without sleeping", async () => {
    const controller = new AbortController();
    let calls = 0;
    try {
      await completeWithProviderBackoff(
        async () => {
          calls += 1;
          controller.abort(new Error("review was cancelled"));
          throw rateLimitedError();
        },
        controller.signal,
        { schedule: [10], sleep: async () => { expect.unreachable(); } },
      );
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("HTTP 429");
    }
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Runner integration — main round retries
// ---------------------------------------------------------------------------

function makeRunnerWithBackoff(
  responses: ConstructorParameters<typeof ScriptedTransport>[0],
  schedule: readonly number[],
): {
  runner: Runner;
  transport: ScriptedTransport;
  delays: number[];
  notices: string[];
} {
  const transport = new ScriptedTransport(responses);
  const delays: number[] = [];
  const notices: string[] = [];
  const runner = new Runner({
    model: "fake",
    template: { MaxTokens: 4000, MaxToolRequestTimes: 30, MaxCompletionTokens: 1000 },
    llmClient: {
      complete: (signal: AbortSignal, req: unknown) =>
        (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(req, signal),
    },
    mainToolDefs: [
      { type: "function", function: { name: "task_done" } },
    ] as readonly ToolDef[],
    rateLimitBackoffMs: schedule,
    backoffSleep: async (ms: number) => {
      delays.push(ms);
    },
    emitBackoffNotice: (line: string) => {
      notices.push(line);
    },
  } as unknown as ConstructorParameters<typeof Runner>[0]);
  return { runner, transport, delays, notices };
}

describe("Runner rate-limit backoff", () => {
  test("a rate-limited main round retries and completes the file", async () => {
    const { runner, transport, delays, notices } = makeRunnerWithBackoff(
      [
        { error: "Pi assistant turn ended with stop reason error (HTTP 429)", errorHttpStatus: 429 },
        { toolCalls: [{ id: "c1", name: "task_done", arguments: "{\"state\":\"DONE\"}" }] },
      ],
      [5],
    );

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review a.ts")],
      "a.ts",
    );

    expect(result.completed).toBe(true);
    expect(result.error).toBeUndefined();
    // The failed round was re-issued unchanged: two transport calls.
    expect(transport.requests.length).toBe(2);
    expect(delays).toEqual([5]);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("Rate limited on a.ts");
    expect(notices[0]).toContain("(HTTP 429)");
    expect(notices[0]).toContain("retry 1/1");
  });

  test("exhausting the backoff schedule fails the file with the provider error", async () => {
    const { runner, transport, delays } = makeRunnerWithBackoff(
      [
        { error: "Pi assistant turn ended with stop reason error (HTTP 429)", errorHttpStatus: 429 },
      ],
      [5, 5],
    );

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review a.ts")],
      "a.ts",
    );

    expect(result.completed).toBe(false);
    expect(result.error?.message).toContain("HTTP 429");
    // ScriptedTransport clamps at the last entry, so every retry fails again.
    expect(transport.requests.length).toBe(3);
    expect(delays).toEqual([5, 5]);
  });

  test("non-rate-limit round failures never retry", async () => {
    const { runner, transport, delays, notices } = makeRunnerWithBackoff(
      [{ error: "Pi session prompt failed before an assistant response" }],
      [5, 5],
    );

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review a.ts")],
      "a.ts",
    );

    expect(result.completed).toBe(false);
    expect(transport.requests.length).toBe(1);
    expect(delays).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("an empty schedule disables retries", async () => {
    const { runner, transport, delays } = makeRunnerWithBackoff(
      [
        { error: "Pi assistant turn ended with stop reason error (HTTP 429)", errorHttpStatus: 429 },
      ],
      [],
    );

    const result = await runner.RunPerFile(
      new AbortController().signal,
      [newTextMessage("user", "review a.ts")],
      "a.ts",
    );

    expect(result.completed).toBe(false);
    expect(transport.requests.length).toBe(1);
    expect(delays).toEqual([]);
  });

  test("cancellation during the backoff wait aborts as cancellation", async () => {
    const controller = new AbortController();
    const transport = new ScriptedTransport([
      { error: "Pi assistant turn ended with stop reason error (HTTP 429)", errorHttpStatus: 429 },
    ]);
    const delays: number[] = [];
    const runner = new Runner({
      model: "fake",
      template: { MaxTokens: 4000, MaxToolRequestTimes: 30, MaxCompletionTokens: 1000 },
      llmClient: {
        complete: (signal: AbortSignal, req: unknown) =>
          (transport as unknown as { complete: (a: unknown, b: unknown) => Promise<unknown> }).complete(req, signal),
      },
      mainToolDefs: [{ type: "function", function: { name: "task_done" } }] as readonly ToolDef[],
      rateLimitBackoffMs: [60_000],
      backoffSleep: async (ms: number, signal: AbortSignal) => {
        delays.push(ms);
        controller.abort(new Error("review was cancelled"));
        await sleepWithAbort(ms, signal);
      },
    } as unknown as ConstructorParameters<typeof Runner>[0]);

    const result = await runner.RunPerFile(
      controller.signal,
      [newTextMessage("user", "review a.ts")],
      "a.ts",
    );

    expect(result.completed).toBe(false);
    expect(result.error?.message).toBe("LLM completion error: review was cancelled");
    expect(delays).toEqual([60_000]);
    expect(transport.requests.length).toBe(1);
  });
});

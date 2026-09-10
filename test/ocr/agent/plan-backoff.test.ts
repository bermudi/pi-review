// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 pi-review Contributors
//
// Plan-phase contract for the rate-limit backoff extension: a rate-limited
// plan request retries on the schedule (with a human-channel notice) instead
// of silently dropping the plan, and still gives up cleanly when the
// schedule is exhausted.

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../../../src/ocr/agent/agent.js";
import type { Template } from "../../../src/ocr/llmloop/types.js";

class FlakyPlanClient {
  public calls = 0;
  public readonly requests: unknown[] = [];
  public constructor(
    private readonly failures: number,
    private readonly status = 429,
  ) {}
  async complete(signal: AbortSignal, req: unknown): Promise<unknown> {
    return this.CompletionsWithCtx(signal, req);
  }
  async CompletionsWithCtx(_ctx: unknown, req: unknown): Promise<unknown> {
    this.requests.push(req);
    this.calls += 1;
    if (this.calls <= this.failures) {
      throw Object.assign(new Error(`Pi assistant turn ended with stop reason error (HTTP ${this.status})`), {
        httpStatus: this.status,
      });
    }
    return { content: "recovered plan", usage: { input: 5, output: 5 } };
  }
}

function planTemplate(): Template {
  return {
    MaxTokens: 10000,
    MaxToolRequestTimes: 5,
    MainTask: { messages: [{ role: "user", content: "t" }] },
    MemoryCompressionTask: { messages: [{ role: "system", content: "c" }] },
    PlanTask: { messages: [{ role: "user", content: "{{diff}}" }] },
  } as unknown as Template;
}

function makeAgent(
  client: FlakyPlanClient,
  extras: { rateLimitBackoffMs?: readonly number[]; backoffSleep?: (ms: number, signal: AbortSignal) => Promise<void> },
): Agent {
  return new Agent({
    repoDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-backoff-")),
    model: "test",
    llmClient: client as unknown as never,
    template: planTemplate(),
    mainToolDefs: [],
    ...extras,
  } as unknown as never);
}

test("plan phase retries a rate-limited request and returns the plan", async () => {
  const client = new FlakyPlanClient(1);
  const delays: number[] = [];
  const agent = makeAgent(client, {
    rateLimitBackoffMs: [7],
    backoffSleep: async (ms) => {
      delays.push(ms);
    },
  });

  const result = await (
    agent as unknown as {
      executePlanPhase: (s: AbortSignal, a: string, b: string, c: string, d: string) => Promise<string>;
    }
  ).executePlanPhase(new AbortController().signal, "main.go", "+x", "", "rule");

  expect(result).toBe("recovered plan");
  expect(client.calls).toBe(2);
  expect(delays).toEqual([7]);
});

test("plan phase gives up after exhausting the schedule", async () => {
  const client = new FlakyPlanClient(99);
  const delays: number[] = [];
  const agent = makeAgent(client, {
    rateLimitBackoffMs: [3, 3],
    backoffSleep: async (ms) => {
      delays.push(ms);
    },
  });

  await expect(
    (
      agent as unknown as {
        executePlanPhase: (s: AbortSignal, a: string, b: string, c: string, d: string) => Promise<string>;
      }
    ).executePlanPhase(new AbortController().signal, "main.go", "+x", "", "rule"),
  ).rejects.toThrow("HTTP 429");

  expect(delays).toEqual([3, 3]);
  expect(client.calls).toBe(3);
});

test("plan phase does not retry non-rate-limit failures", async () => {
  const client = new FlakyPlanClient(99, 401);
  const delays: number[] = [];
  const agent = makeAgent(client, {
    rateLimitBackoffMs: [3],
    backoffSleep: async (ms) => {
      delays.push(ms);
    },
  });

  await expect(
    (
      agent as unknown as {
        executePlanPhase: (s: AbortSignal, a: string, b: string, c: string, d: string) => Promise<string>;
      }
    ).executePlanPhase(new AbortController().signal, "main.go", "+x", "", "rule"),
  ).rejects.toThrow("HTTP 401");

  expect(delays).toEqual([]);
  expect(client.calls).toBe(1);
});

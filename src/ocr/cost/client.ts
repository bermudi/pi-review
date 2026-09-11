// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Client wrapper for the stage-cost seam. Wraps the injected LLM client so
// every physical request attempt is observed with its RequestMeta identity —
// one record per attempt, so rate-limit retries surface as multiple attempts
// under one logical request. The wrapped client exposes exactly the method
// shapes the inner client exposes (`complete`, `CompletionsWithCtx`), passes
// requests and signals through untouched, and rethrows original errors
// unchanged so retry classification and abort semantics stay honest.

import type { AnyLlmClient, ChatRequest } from "../llmloop/types.js";
import {
  UNATTRIBUTED_STAGE,
  type CostCollector,
  type CostRequestIdentity,
  type CostTokenUsage,
} from "./types.js";

const UNATTRIBUTED_IDENTITY: CostRequestIdentity = {
  provider: "",
  model: "",
  filePath: "",
  stage: UNATTRIBUTED_STAGE,
  requestNo: 0,
};

/**
 * Narrow the request's RequestMeta at the boundary. Mirrors the retry
 * collector's validity rule: stage and file must be non-empty and requestNo
 * a positive integer; provider/model may legitimately be empty. Anything
 * unusable falls into the `unattributed` bucket so counts stay honest.
 */
function requestIdentity(req: unknown): CostRequestIdentity {
  if (typeof req !== "object" || req === null) return UNATTRIBUTED_IDENTITY;
  const raw = (req as Record<string, unknown>)["requestMeta"];
  if (typeof raw !== "object" || raw === null) return UNATTRIBUTED_IDENTITY;
  const m = raw as Record<string, unknown>;
  const provider = m["provider"];
  const model = m["model"];
  const filePath = m["filePath"];
  const stage = m["taskType"];
  const requestNo = m["requestNo"];
  if (
    typeof filePath !== "string" || filePath === "" ||
    typeof stage !== "string" || stage === "" ||
    typeof requestNo !== "number" || !Number.isInteger(requestNo) || requestNo <= 0
  ) {
    return UNATTRIBUTED_IDENTITY;
  }
  return {
    provider: typeof provider === "string" ? provider : "",
    model: typeof model === "string" ? model : "",
    filePath,
    stage,
    requestNo,
  };
}

function optionalToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Extract response token usage when the response carried it. */
function usageFromResponse(resp: unknown): CostTokenUsage | undefined {
  if (typeof resp !== "object" || resp === null) return undefined;
  const root = resp as Record<string, unknown>;
  const raw = root["usage"] ?? root["Usage"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const usage: CostTokenUsage = {
    promptTokens: optionalToken(u["promptTokens"] ?? u["PromptTokens"]),
    completionTokens: optionalToken(u["completionTokens"] ?? u["CompletionTokens"]),
    cacheReadTokens: optionalToken(u["cacheReadTokens"] ?? u["CacheReadTokens"]),
    cacheWriteTokens: optionalToken(u["cacheWriteTokens"] ?? u["CacheWriteTokens"]),
  };
  return usage;
}

type ClientMethod = (signal: AbortSignal, req: ChatRequest) => Promise<unknown>;

/**
 * Wrap `client` so each attempt is reported to `collector`. Requests without
 * a usable RequestMeta identity are recorded under the `unattributed` stage.
 * Collector errors propagate (fail loud, never silently drop cost evidence);
 * everything else passes through untouched.
 */
export function createCostCollectingClient(client: AnyLlmClient, collector: CostCollector): AnyLlmClient {
  const inner = client as unknown as Record<string, unknown>;
  const wrapped: Record<string, unknown> = {};

  const bind = (name: "complete" | "CompletionsWithCtx"): void => {
    const fn = inner[name];
    if (typeof fn !== "function") return;
    const method = fn as ClientMethod;
    wrapped[name] = async (signal: AbortSignal, req: ChatRequest): Promise<unknown> => {
      const identity = requestIdentity(req);
      const startedAtMs = Date.now();
      try {
        const resp = await method.call(client, signal, req);
        // A throwing collector fails the request loudly: silently dropped
        // cost evidence would fabricate a zero-cost report.
        collector.recordAttempt({
          ...identity,
          ok: true,
          durationMs: Math.max(0, Date.now() - startedAtMs),
          ...usageFromResponse(resp),
        });
        return resp;
      } catch (err) {
        try {
          collector.recordAttempt({
            ...identity,
            ok: false,
            durationMs: Math.max(0, Date.now() - startedAtMs),
          });
        } catch {
          // The request's own failure stays primary — masking it with a
          // collector error would corrupt retry classification.
        }
        throw err;
      }
    };
  };

  bind("CompletionsWithCtx");
  bind("complete");

  if (typeof wrapped["CompletionsWithCtx"] !== "function" && typeof wrapped["complete"] !== "function") {
    throw new Error(
      "createCostCollectingClient: llmClient must provide complete(signal, req) or CompletionsWithCtx(signal, req)",
    );
  }
  return wrapped as unknown as AnyLlmClient;
}

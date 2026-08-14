// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/diff/relocation.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

/**
 * Re-location support — mirrors Go `relocation.go`.
 * Builds the re-location prompt and optionally calls the LLM to regenerate
 * a precise `existing_code` snippet when text-based matching fails.
 */

import type { Diff } from "../model/diff.js";
import type { LlmComment } from "../model/review.js";
import { resolveComment } from "./resolver.js";

// ---------------------------------------------------------------------------
// Minimal interfaces — parity with Go's llm.Message / template.LlmConversation
// ---------------------------------------------------------------------------

export interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

export interface LlmConversation {
  readonly messages: readonly ChatMessage[];
}

/** Mirrors Go `llm.Message` with ExtractText helper. */
export interface LlmMessage {
  readonly role: string;
  extractText(): string;
}

function newTextMessage(role: string, content: string): LlmMessage {
  return {
    role,
    extractText: () => content,
  };
}

/** Mirrors Go `llm.ChatRequest` / `llm.ChatResponse` minimal surface. */
export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly maxTokens: number;
}

export interface ChatChoice {
  readonly message: { readonly role: string; readonly content?: string };
}

export interface ChatUsage {
  readonly totalTokens: number;
}

export interface ChatResponse {
  readonly choices: readonly ChatChoice[];
  readonly usage?: ChatUsage;
  /** Helper matching Go's `resp.Content()` — joins choice contents. */
  content(): string;
}

export function createChatResponse(choices: ChatChoice[], usage?: ChatUsage): ChatResponse {
  return {
    choices,
    usage,
    content() {
      return choices.map((c) => c.message.content ?? "").join("\n");
    },
  };
}

export interface LLMClient {
  completionsWithCtx(signal: AbortSignal | undefined, req: ChatRequest): Promise<ChatResponse>;
  // Legacy alias matching Go `CompletionsWithCtx(ctx, req)` without explicit signal name.
  completions?(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// Public API — mirrors Go `BuildReLocationMessages` / `ReLocateComment`
// ---------------------------------------------------------------------------

/**
 * BuildReLocationMessages renders the re-location prompt for cm against d.
 * Returns null when the task template is absent or empty (caller treats as
 * "no re-location attempt").
 * Mirrors Go `BuildReLocationMessages`.
 */
export function buildReLocationMessages(
  cm: LlmComment,
  d: Diff,
  task: LlmConversation | null | undefined,
): LlmMessage[] | null {
  if (!task || task.messages.length === 0) return null;

  const messages: LlmMessage[] = [];
  for (const m of task.messages) {
    let content = m.content;
    content = content.replaceAll("{diff}", d.diff);
    content = content.replaceAll("{existing_code}", cm.existingCode ?? "");
    content = content.replaceAll("{suggestion_content}", cm.content);
    messages.push(newTextMessage(m.role, content));
  }
  return messages;
}

export const BuildReLocationMessages = buildReLocationMessages;

/**
 * ReLocateComment calls the LLM to regenerate a precise existing_code snippet.
 * Mirrors Go `ReLocateComment`. `messages` comes from BuildReLocationMessages.
 * Returns [success, response] where response is null on failure.
 */
export async function reLocateComment(
  cm: LlmComment,
  d: Diff,
  client: LLMClient,
  messages: readonly LlmMessage[] | null | undefined,
  modelName: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<[boolean, ChatResponse | null]> {
  if (!messages || messages.length === 0) return [false, null];

  let resp: ChatResponse;
  try {
    // Prefer the explicit signal-bearing method; fall back to legacy.
    if (typeof (client as unknown as Record<string, unknown>)["completionsWithCtx"] === "function") {
      resp = await client.completionsWithCtx(signal, {
        model: modelName,
        messages,
        maxTokens,
      });
    } else if (client.completions) {
      resp = await client.completions({ model: modelName, messages, maxTokens }, signal);
    } else {
      throw new Error("LLM client missing completions method");
    }
  } catch (err) {
    // Mirrors Go's telemetry + stdout Writer logging. Use stderr in TS.
    console.error(`[ocr] Re-location LLM call failed for ${cm.path}: ${String((err as Error).message)}`);
    return [false, null];
  }

  const code = extractCodeBlock(resp.content());
  if (code === "") return [false, resp];

  const original = cm.existingCode ?? "";
  cm.existingCode = code;
  if (resolveComment(cm, d)) {
    return [true, resp];
  }
  cm.existingCode = original;
  return [false, resp];
}

export const ReLocateComment = reLocateComment;

// ---------------------------------------------------------------------------
// Helpers — mirrors Go `extractCodeBlock`
// ---------------------------------------------------------------------------

export function extractCodeBlock(text: string): string {
  const trimmed = text.trim();
  const start = trimmed.indexOf("```");
  if (start < 0) return "";
  let afterOpen = start + 3;
  const nl = trimmed.indexOf("\n", afterOpen);
  if (nl < 0) return "";
  afterOpen = nl + 1;
  const end = trimmed.indexOf("```", afterOpen);
  if (end < 0) return "";
  return trimmed.slice(afterOpen, end).trim();
}

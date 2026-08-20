// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/llmloop/loop.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// Modifications are distributed as part of pi-reviewer under
// GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import type { Message, ToolCall } from "./compression.js";
import type { CommentWorkerPool } from "./pool.js";
import type { LlmComment } from "../model/types.js";
import type { SessionHistory } from "../session/history.js";
import type { TaskType } from "../session/history.js";

// ---------------------------------------------------------------------------
// Stop classification — mirrors Go MainLoopStop
// ---------------------------------------------------------------------------

export enum MainLoopStop {
  StopNone = 0,
  StopMaxRounds = 1,
  StopEmptyRounds = 2,
  StopCompression = 3,
}

export const StopNone = MainLoopStop.StopNone;
export const StopMaxRounds = MainLoopStop.StopMaxRounds;
export const StopEmptyRounds = MainLoopStop.StopEmptyRounds;
export const StopCompression = MainLoopStop.StopCompression;

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export interface AgentWarning {
  file: string;
  message: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Tool definitions — mirrors llm.ToolDef minimal surface
// ---------------------------------------------------------------------------

export interface ToolDef {
  readonly type: string;
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Usage — mirrors llm.UsageInfo
// ---------------------------------------------------------------------------

export interface UsageInfo {
  readonly PromptTokens: number;
  readonly CompletionTokens: number;
  readonly CacheReadTokens: number;
  readonly CacheWriteTokens: number;
  readonly TotalTokens?: number;
}

// ---------------------------------------------------------------------------
// Chat transport — mirrors llm.LLMClient / ChatRequest / ChatResponse
// ---------------------------------------------------------------------------

export interface RequestMeta {
  readonly provider: string;
  readonly model: string;
  readonly filePath: string;
  readonly taskType: string;
  readonly requestNo: number;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDef[];
  readonly maxTokens?: number;
  readonly sessionId?: string;
  readonly requestMeta?: RequestMeta;
}

export interface ChatResponse {
  /** Assistant text content (may be empty when tool calls present). */
  readonly content: string;
  /** Optional reasoning channel. */
  readonly reasoningContent?: string;
  /** Tool calls in the choice; empty array when none. */
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: UsageInfo;
}

// Transport interface used by Runner. Named `LlmTransport` in spec
// ("transport.complete") and `LLMClient` in Go. Both `complete` and
// `completionsWithCtx` are accepted via adapter.
export interface LlmTransport {
  complete(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse>;
}

// Alternative Go-style client shape — Runner accepts either.
export interface LlmClientGoStyle {
  CompletionsWithCtx(signal: AbortSignal, req: ChatRequest): Promise<ChatResponse>;
}

export type AnyLlmClient = LlmTransport | LlmClientGoStyle;

// ---------------------------------------------------------------------------
// Template — mirrors config/template.Template minimal surface needed by loop
// ---------------------------------------------------------------------------

export interface Template {
  readonly MaxTokens: number;
  readonly MaxToolRequestTimes: number;
  readonly MaxCompletionTokens?: number;
  readonly MemoryCompressionTask?: {
    readonly Messages: readonly Message[];
    readonly messages?: readonly { readonly role: string; readonly content: string }[];
  };
  readonly ReLocationTask?: {
    readonly Messages?: readonly Message[];
    readonly messages?: readonly { readonly role: string; readonly content: string }[];
  } | null;
}

// ---------------------------------------------------------------------------
// Comment collector — mirrors tool.CommentCollector minimal surface
// ---------------------------------------------------------------------------

export interface CommentCollectorLike {
  add(comment: LlmComment): void;
  comments(): LlmComment[];
  // optional legacy name
  Add?(comment: LlmComment): void;
  Comments?(): LlmComment[];
}

// ---------------------------------------------------------------------------
// Tool provider registry — mirrors tool.Registry minimal surface
// ---------------------------------------------------------------------------

export interface ToolProvider {
  readonly name: string;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> | string;
}

export interface ToolRegistryLike {
  get(name: string): ToolProvider | undefined;
  Get?(name: string): ToolProvider | undefined;
}

// Normalize registry access (supports Map, plain object, or Go-style Get)
export function lookupRegistry(reg: ToolRegistryLike | Map<string, ToolProvider> | undefined, name: string): ToolProvider | undefined {
  if (!reg) return undefined;
  if (reg instanceof Map) return reg.get(name);
  if (typeof (reg as ToolRegistryLike).get === "function") return (reg as ToolRegistryLike).get(name);
  if (typeof (reg as ToolRegistryLike).Get === "function") return (reg as ToolRegistryLike).Get?.(name);
  return undefined;
}

// ---------------------------------------------------------------------------
// Diff lookup — mirrors Deps.DiffLookup func(path string) *model.Diff
// ---------------------------------------------------------------------------

export interface DiffLike {
  readonly newPath?: string;
  readonly oldPath?: string;
  readonly diff?: string;
  readonly NewPath?: string;
  readonly OldPath?: string;
  readonly Diff?: string;
  readonly newFileContent?: string;
  readonly NewFileContent?: string;
}

export type DiffLookup = (path: string) => DiffLike | null | undefined;

// ---------------------------------------------------------------------------
// RunnerDeps — mirrors Go llmloop.Deps minimal surface
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  readonly model: string;
  /** OCR session identity used to derive per-task prompt-cache keys. */
  readonly sessionId?: string;
  readonly template: Template;
  /** LLM transport — accepts either `complete` or `CompletionsWithCtx` shape. */
  readonly llmClient: AnyLlmClient;
  /** Tool definitions advertised to the model. */
  readonly mainToolDefs: readonly ToolDef[];
  /** Optional incremental collector for code_comment. */
  readonly commentCollector?: CommentCollectorLike;
  /** Optional async worker pool for comment post-processing. */
  readonly commentWorkerPool?: CommentWorkerPool;
  /** Optional dynamic tool registry (non built-ins). */
  readonly toolRegistry?: ToolRegistryLike | Map<string, ToolProvider>;
  /** Legacy alias for toolRegistry. */
  readonly tools?: ToolRegistryLike | Map<string, ToolProvider>;
  /** Diff lookup for code_comment relocation (mirrors Deps.DiffLookup). */
  readonly diffLookup?: DiffLookup;
  /** Legacy alias for diffLookup (Go field name). */
  readonly DiffLookup?: DiffLookup;
  /** Session history for TaskRecord creation (mirrors Go Deps.Session). */
  readonly session?: SessionHistory;
  /** Legacy alias for session (Go field name Session). */
  readonly Session?: SessionHistory;
  /** Identity factory for retry-report / request lineage (mirrors Go Deps.NewRequestMeta). */
  readonly newRequestMeta?: (filePath: string, taskType: TaskType, requestNo: number) => RequestMeta;
  /** Legacy alias (Go field name). */
  readonly NewRequestMeta?: (filePath: string, taskType: TaskType, requestNo: number) => RequestMeta;
}

// ---------------------------------------------------------------------------
// ToolCallResult — mirrors tool.ToolCallResult
// ---------------------------------------------------------------------------

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly result: string;
}

// Checkpoint returned by executeToolCall — mirrors tool.TaskCheckpoint
export interface TaskCheckpoint {
  readonly data: string;
  readonly completed: boolean;
  readonly failed: boolean;
}

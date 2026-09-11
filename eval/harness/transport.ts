// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors

/**
 * Scripted model transports for eval runs (evolution Phase 0 item 2).
 *
 * Eval runs must make zero paid or network model calls: the model is always
 * injected. This module provides the injection in the same shape existing
 * engine tests use — a fake `llmClient` answering per `requestMeta`
 * (`taskType`/`filePath`/`requestNo`) with `code_comment` / `task_done`
 * tool calls and terminal filter text — packaged as a
 * `RuntimeTransportFactory` matching the engine's per-file transport pool.
 * Each created transport stands in for one file's Pi session, so per-file
 * session isolation remains observable in eval evidence.
 */

import type { RuntimeTransport, RuntimeTransportFactory } from "../../src/ocr/cli/factory.js";
import type { ChatRequest, ChatResponse } from "../../src/ocr/llmloop/types.js";

export type { RuntimeTransport, RuntimeTransportFactory };

/** Pinned identity recorded in eval results; enforced against every transport. */
export interface ModelIdentity {
	readonly provider: string;
	readonly model: string;
}

export type ScriptedResponder = (request: ChatRequest) => ChatResponse | Promise<ChatResponse>;

export interface ScriptedPoolStats {
	readonly created: number;
	readonly disposed: number;
	/** Model requests observed at the transport boundary (retries included). */
	readonly requests: number;
}

export interface ScriptedModelPool {
	/** Inject into `runCase`/`runCorpus` as the transport factory. */
	readonly factory: RuntimeTransportFactory;
	/** All requests seen so far, in arrival order. */
	requests(): readonly ChatRequest[];
	stats(): ScriptedPoolStats;
}

/**
 * One pool per eval run (or per case): every factory call returns a fresh
 * transport delegating to the shared responder, mirroring the engine's
 * one-session-per-file-affinity rule.
 */
export function createScriptedModelPool(options: {
	readonly identity: ModelIdentity;
	readonly respond: ScriptedResponder;
}): ScriptedModelPool {
	const requests: ChatRequest[] = [];
	let created = 0;
	let disposed = 0;

	const poolFactory: RuntimeTransportFactory = async () => {
		created += 1;
		const transport: RuntimeTransport = {
			async dispose(): Promise<void> {
				disposed += 1;
			},
			modelIdentity: () => ({ provider: options.identity.provider, model: options.identity.model }),
			complete: async (_signal: AbortSignal, request: ChatRequest): Promise<ChatResponse> => {
				requests.push(request);
				return options.respond(request);
			},
			CompletionsWithCtx: async (_signal: AbortSignal, request: ChatRequest): Promise<ChatResponse> => {
				requests.push(request);
				return options.respond(request);
			},
		};
		return transport;
	};

	return {
		factory: poolFactory,
		requests: () => requests,
		stats: () => ({ created, disposed, requests: requests.length }),
	};
}

// ---------------------------------------------------------------------------
// Canned review responder — a competent-enough scripted reviewer for mock
// runs: one code_comment round, then task_done; keeps or removes filter
// candidates from configuration; answers plan requests with text.
// ---------------------------------------------------------------------------

export interface CannedFinding {
	readonly content: string;
	/** Added-line excerpt used by the engine to relocate the finding. */
	readonly existingCode: string;
	readonly category?: string;
	readonly severity?: string;
	readonly suggestionCode?: string;
}

export interface CannedReviewModel {
	readonly findingsForFile?: (filePath: string) => readonly CannedFinding[];
	/** Filter-stage removal decision, as `c-<index>` ids. Default: keep all. */
	readonly filterRemovalsForFile?: (filePath: string) => readonly string[];
	readonly planForFile?: (filePath: string) => string;
	readonly usage?: {
		readonly promptTokens?: number;
		readonly completionTokens?: number;
	};
}

interface ScriptToolCall {
	readonly id: string;
	readonly type: "function";
	readonly function: { readonly name: string; readonly arguments: string };
}

function toolCalls(id: string, name: string, args: unknown): readonly ScriptToolCall[] {
	return [
		{
			id,
			type: "function",
			function: { name, arguments: JSON.stringify(args) },
		},
	];
}

export function cannedReviewResponder(model: CannedReviewModel): ScriptedResponder {
	let callCounter = 0;
	const nextId = (prefix: string): string => {
		callCounter += 1;
		return `${prefix}-${String(callCounter)}`;
	};
	const usage = {
		PromptTokens: model.usage?.promptTokens ?? 10,
		CompletionTokens: model.usage?.completionTokens ?? 5,
		CacheReadTokens: 0,
		CacheWriteTokens: 0,
	};

	return (request: ChatRequest): ChatResponse => {
		const meta = request.requestMeta;
		if (meta === undefined) {
			throw new Error(`canned review responder: request without requestMeta (session ${request.sessionId ?? "?"})`);
		}
		switch (meta.taskType) {
			case "plan_task":
				return {
					content: model.planForFile?.(meta.filePath) ?? `plan: ${meta.filePath}`,
					toolCalls: [],
					usage,
				};
			case "review_filter_task":
				return {
					content: JSON.stringify(model.filterRemovalsForFile?.(meta.filePath) ?? []),
					toolCalls: [],
					usage,
				};
			case "main_task": {
				if (meta.requestNo > 1) {
					return { content: "", toolCalls: toolCalls(nextId("done"), "task_done", {}), usage };
				}
				const findings = model.findingsForFile?.(meta.filePath) ?? [];
				if (findings.length === 0) {
					return { content: "", toolCalls: toolCalls(nextId("done"), "task_done", {}), usage };
				}
				return {
					content: "",
					toolCalls: toolCalls(
						nextId("cc"),
						"code_comment",
						{
							comments: findings.map((finding) => ({
								content: finding.content,
								existing_code: finding.existingCode,
								...(finding.suggestionCode === undefined ? {} : { suggestion_code: finding.suggestionCode }),
								...(finding.category === undefined ? {} : { category: finding.category }),
								...(finding.severity === undefined ? {} : { severity: finding.severity }),
							})),
						},
					),
					usage,
				};
			}
			default:
				throw new Error(`canned review responder: unexpected task type "${meta.taskType}" for ${meta.filePath}`);
		}
	};
}

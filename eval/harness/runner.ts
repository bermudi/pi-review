// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors

/**
 * Eval runner (evolution Phase 0 item 2).
 *
 * Drives one corpus case through the same review path the public library API
 * uses (`review` in src/index.ts is implemented by src/ocr/reviewer.ts):
 * `buildOcrReviewOptions` builds the engine options exactly as the public
 * facade does, and `createReviewRunnerFactory` runs the full pipeline — git
 * target validation, range diff, selection/rules/limits, plan/main model
 * rounds, incremental `code_comment`, relocation/validation, and the
 * terminal review filter. The model is never reached for: a scripted
 * transport is always injected through the engine's documented
 * deterministic-transport seam (`ReviewFactoryDeps.createTransport`), so a
 * run is a real end-to-end review with zero paid/network calls. Injecting a
 * transport into the public `review()` signature itself would be an src/**
 * change and is deliberately out of this partition.
 *
 * Domain outcome: a {@link CaseRunRecord} shaped like the public
 * `ReviewResult` plus eval-specific evidence (pinned model identity,
 * transport/request counts). Engine failures are eval evidence and are
 * reported as `status: "failed"` records, not thrown; harness misuse
 * (`EvalContractError`) throws.
 */

import { createReviewRunnerFactory } from "../../src/ocr/cli/factory.js";
import { manifestMessage } from "../../src/ocr/cli/output.js";
import type { LlmComment } from "../../src/ocr/model/review.js";
import type { RunManifest } from "../../src/ocr/session/manifest.js";
import { buildOcrReviewOptions } from "../../src/ocr/reviewer.js";
import {
	EMPTY_USAGE,
	type ExcludedFile,
	type FailedFile,
	type Finding,
	type FindingCategory,
	type FindingSeverity,
	type ReviewCoverage,
	type ReviewInput,
	type ReviewOptions,
	type ReviewStatus,
	type ReviewUsage,
	type SkippedFile,
} from "../../src/types.js";

import { EvalContractError } from "./errors.js";
import type { CorpusCase, CorpusExpectation } from "./corpus.js";
import type { ModelIdentity, RuntimeTransportFactory } from "./transport.js";

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
	"bug",
	"security",
	"performance",
	"maintainability",
	"test",
	"style",
	"documentation",
	"other",
]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"]);

/** A local, disposable instantiation of one corpus case's repository. */
export interface CaseWorkspace {
	readonly root: string;
}

/**
 * Materializes a case's pinned repository locally. The production provider
 * (clone/fetch the pinned commits from `repo.url`) arrives with the Phase 1
 * corpus; tests inject a temporary-git-repo provider, so the runner never
 * clones and never touches the network.
 */
export interface CaseWorkspaceProvider {
	provide(caseDef: CorpusCase): Promise<CaseWorkspace>;
	dispose(workspace: CaseWorkspace): Promise<void>;
}

export interface CaseRunOptions {
	readonly caseDef: CorpusCase;
	readonly workspace: CaseWorkspace;
	/** Pinned identity of the injected model; enforced on every transport. */
	readonly model: ModelIdentity;
	/** Scripted transport factory — always injected, never production Pi. */
	readonly createTransport: RuntimeTransportFactory;
	readonly concurrency?: number;
	readonly maxToolRounds?: number;
	readonly exclude?: readonly string[];
	/** Commit-message background evidence (public review contract surface). */
	readonly background?: string;
	readonly rules?: string;
	readonly agentDir?: string;
	readonly signal?: AbortSignal;
}

export interface CaseRunTarget {
	readonly mode: "range";
	readonly baseCommit: string;
	readonly headCommit: string;
}

export interface CaseRunRecord {
	readonly caseId: string;
	readonly expectationKind: CorpusExpectation["kind"];
	readonly target: CaseRunTarget;
	readonly model: ModelIdentity;
	readonly status: ReviewStatus;
	readonly message: string;
	readonly findings: readonly Finding[];
	readonly coverage: ReviewCoverage;
	readonly usage: ReviewUsage;
	readonly warnings: readonly string[];
	readonly sessionId: string | null;
	/** Model requests observed at the transport boundary (retries included). */
	readonly modelRequests: number;
	/** Transports created — one per file affinity, evidencing session isolation. */
	readonly transports: number;
	readonly elapsedMs: number;
}

function normalizeCategory(value: unknown): FindingCategory {
	if (typeof value === "string" && VALID_CATEGORIES.has(value)) return value as FindingCategory;
	return "other";
}

function normalizeSeverity(value: unknown): FindingSeverity {
	if (typeof value === "string" && VALID_SEVERITIES.has(value)) return value as FindingSeverity;
	return "low";
}

/** Mirrors the public facade's LlmComment → Finding mapping. */
function llmCommentToFinding(comment: LlmComment): Finding {
	return {
		path: comment.path,
		content: comment.content,
		...(comment.suggestionCode === undefined ? {} : { suggestionCode: comment.suggestionCode }),
		existingCode: comment.existingCode ?? "",
		startLine: comment.startLine ?? 0,
		endLine: comment.endLine ?? 0,
		category: normalizeCategory(comment.category),
		severity: normalizeSeverity(comment.severity),
	};
}

/** Mirrors the public facade's manifest → coverage mapping. */
function coverageFromManifest(manifest: RunManifest | null | undefined): ReviewCoverage {
	const selected: string[] = [];
	const completed: string[] = [];
	const failed: FailedFile[] = [];
	const skipped: SkippedFile[] = [];
	const excluded: ExcludedFile[] = [];
	if (manifest !== null && manifest !== undefined) {
		for (const item of manifest.coverage.selected) selected.push(item.path);
		for (const item of manifest.coverage.completed) completed.push(item.path);
		for (const item of manifest.coverage.reused) completed.push(item.path);
		for (const item of manifest.coverage.failed) {
			failed.push({ path: item.path, reason: item.reason ?? "failed" });
		}
		for (const item of manifest.coverage.waived) {
			excluded.push({ path: item.path, reason: item.reason ?? "waived" });
		}
	}
	return { selected, completed, failed, skipped, excluded };
}

interface TransportMeter {
	readonly requests: { value: number };
	readonly transports: { value: number };
}

type RuntimeCall = (signal: AbortSignal, request: unknown) => Promise<unknown>;

function callOf(transport: unknown, name: "complete" | "CompletionsWithCtx"): RuntimeCall | null {
	const candidate = (transport as Record<string, unknown>)[name];
	return typeof candidate === "function" ? (candidate as RuntimeCall) : null;
}

/**
 * Wrap the injected factory so eval records carry evidence instead of trust:
 * every transport must report exactly the pinned model identity, and every
 * request/transport crossing the boundary is counted.
 */
function meteredFactory(
	factory: RuntimeTransportFactory,
	model: ModelIdentity,
	meter: TransportMeter,
): RuntimeTransportFactory {
	return async (options) => {
		const transport = await factory(options);
		const identity = transport.modelIdentity?.();
		if (identity === undefined) {
			throw new EvalContractError(
				`eval transport for "${model.provider}/${model.model}" reported no model identity; eval runs require a pinned identity`,
			);
		}
		if (identity.provider !== model.provider || identity.model !== model.model) {
			throw new EvalContractError(
				`pinned eval model is ${model.provider}/${model.model} but a created transport reported ${identity.provider}/${identity.model}`,
			);
		}
		meter.transports.value += 1;

		const goStyle = callOf(transport, "CompletionsWithCtx");
		const complete = callOf(transport, "complete");
		if (goStyle === null && complete === null) {
			throw new EvalContractError("eval transport provides neither complete nor CompletionsWithCtx");
		}
		const countAndCall = (call: RuntimeCall, signal: AbortSignal, request: unknown): Promise<unknown> => {
			meter.requests.value += 1;
			return call.call(transport, signal, request);
		};
		return {
			dispose: (): Promise<void> => transport.dispose(),
			modelIdentity: (): ModelIdentity => ({ provider: identity.provider, model: identity.model }),
			...(goStyle === null
				? {}
				: {
						CompletionsWithCtx: (signal: AbortSignal, request: unknown): Promise<unknown> =>
							countAndCall(goStyle, signal, request),
				  }),
			...(complete === null
				? {}
				: {
						complete: (signal: AbortSignal, request: unknown): Promise<unknown> =>
							countAndCall(complete, signal, request),
				  }),
		} as unknown as Awaited<ReturnType<RuntimeTransportFactory>>;
	};
}

/**
 * Run one corpus case as a full engine review with a scripted model.
 * Never throws for engine failures — those become `status: "failed"` records.
 */
export async function runCase(options: CaseRunOptions): Promise<CaseRunRecord> {
	const { caseDef, workspace } = options;
	const startedAt = Date.now();
	const meter: TransportMeter = { requests: { value: 0 }, transports: { value: 0 } };

	const input: ReviewInput = {
		repository: workspace.root,
		mode: { kind: "range", base: caseDef.baseCommit, head: caseDef.headCommit },
		...(options.background === undefined ? {} : { background: options.background }),
		...(options.rules === undefined ? {} : { rules: options.rules }),
	};
	// The model selector stays empty on the public option surface: eval model
	// identity comes from the injected transport's modelIdentity(), and a
	// non-empty selector would resolve against Pi configuration that eval
	// runs deliberately do not read.
	const libOptions: ReviewOptions = {
		model: "",
		...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
		...(options.maxToolRounds === undefined ? {} : { maxToolRounds: options.maxToolRounds }),
		...(options.exclude === undefined ? {} : { exclude: options.exclude }),
		...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	};
	const engineOptions = buildOcrReviewOptions(input, libOptions, "");

	const env = process.env as Record<string, string | undefined>;
	const originalAgentDir = env.PI_CODING_AGENT_DIR;
	if (options.agentDir !== undefined && options.agentDir !== "") {
		env.PI_CODING_AGENT_DIR = options.agentDir;
	}

	let record: CaseRunRecord;
	try {
		record = await runEngine(engineOptions, options, meter, startedAt);
	} finally {
		if (options.agentDir !== undefined && options.agentDir !== "") {
			if (originalAgentDir === undefined) delete env.PI_CODING_AGENT_DIR;
			else env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
	}
	return record;
}

/**
 * Run a whole corpus sequentially: one workspace per case (created through
 * the injected provider, always disposed), one scripted transport factory
 * per case when `createTransportForCase` is given (fresh model state per
 * case), else the shared factory. Case order follows manifest order;
 * provider and harness misuse throw, engine failures become failed records.
 *
 * Deliberately sequential: per-file concurrency lives inside the engine;
 * cross-case parallelism is left to future phases so early eval evidence
 * stays easy to reason about.
 */
export async function runCorpus(options: {
	readonly manifest: { readonly cases: readonly CorpusCase[] };
	readonly provider: CaseWorkspaceProvider;
	readonly model: ModelIdentity;
	/** Shared factory for all cases; ignored when createTransportForCase is given. */
	readonly createTransport?: RuntimeTransportFactory;
	readonly createTransportForCase?: (caseDef: CorpusCase) => RuntimeTransportFactory;
	readonly concurrency?: number;
	readonly maxToolRounds?: number;
	readonly exclude?: readonly string[];
	readonly background?: string;
	readonly rules?: string;
	readonly agentDir?: string;
	readonly signal?: AbortSignal;
}): Promise<CaseRunRecord[]> {
	const records: CaseRunRecord[] = [];
	if (options.createTransport === undefined && options.createTransportForCase === undefined) {
		throw new EvalContractError("runCorpus requires createTransport or createTransportForCase");
	}
	for (const caseDef of options.manifest.cases) {
		const workspace = await options.provider.provide(caseDef);
		try {
			records.push(
				await runCase({
					caseDef,
					workspace,
					model: options.model,
					createTransport:
						options.createTransportForCase?.(caseDef) ?? (options.createTransport as RuntimeTransportFactory),
					...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
					...(options.maxToolRounds === undefined ? {} : { maxToolRounds: options.maxToolRounds }),
					...(options.exclude === undefined ? {} : { exclude: options.exclude }),
					...(options.background === undefined ? {} : { background: options.background }),
					...(options.rules === undefined ? {} : { rules: options.rules }),
					...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
					...(options.signal === undefined ? {} : { signal: options.signal }),
				}),
			);
		} finally {
			await options.provider.dispose(workspace);
		}
	}
	return records;
}

async function runEngine(
	engineOptions: ReturnType<typeof buildOcrReviewOptions>,
	options: CaseRunOptions,
	meter: TransportMeter,
	startedAt: number,
): Promise<CaseRunRecord> {
	const { caseDef, model, signal } = options;
	const baseRecord = {
		caseId: caseDef.id,
		expectationKind: caseDef.expectation.kind,
		target: { mode: "range" as const, baseCommit: caseDef.baseCommit, headCommit: caseDef.headCommit },
		model,
		modelRequests: meter.requests.value,
		transports: meter.transports.value,
		elapsedMs: Math.max(0, Date.now() - startedAt),
	};

	try {
		const createTransport = meteredFactory(options.createTransport, model, meter);
		const factory = createReviewRunnerFactory(engineOptions, options.workspace.root, { createTransport });
		const runner = await factory(signal);
		const comments = await runner.run(signal);
		const findings = comments.map(llmCommentToFinding);
		const manifest = runner.manifest ?? null;
		const status: ReviewStatus = manifest?.terminalState ?? (comments.length > 0 ? "complete" : "skipped");
		const usage: ReviewUsage = {
			inputTokens: runner.inputTokens,
			outputTokens: runner.outputTokens,
			cacheReadTokens: runner.cacheReadTokens,
			cacheWriteTokens: runner.cacheWriteTokens,
			totalTokens: runner.totalTokens,
		};
		return {
			...baseRecord,
			status,
			message: manifestMessage(manifest, findings.length),
			findings,
			coverage: coverageFromManifest(manifest),
			usage,
			warnings: runner.warnings.map((w) =>
				w.file ? `[${w.type}] ${w.file}: ${w.message}` : `[${w.type}]: ${w.message}`,
			),
			sessionId: runner.sessionId,
			modelRequests: meter.requests.value,
			transports: meter.transports.value,
			elapsedMs: Math.max(0, Date.now() - startedAt),
		};
	} catch (error) {
		// Harness misuse (identity mismatch, contract violations) is a crash,
		// not evidence; everything else is a failed review run.
		if (error instanceof EvalContractError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		return {
			...baseRecord,
			status: "failed",
			message,
			findings: [],
			coverage: { selected: [], completed: [], failed: [], skipped: [], excluded: [] },
			usage: { ...EMPTY_USAGE },
			warnings: [message],
			sessionId: null,
			modelRequests: meter.requests.value,
			transports: meter.transports.value,
			elapsedMs: Math.max(0, Date.now() - startedAt),
		};
	}
}

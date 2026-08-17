import { createReviewTarget } from "./git.js";
import { buildChangeMap, renderChangeMapSlice, type ChangeMap } from "./change-map.js";
import { createPlanToolkit, type PlanToolkit } from "./phase-tools.js";
import {
	buildFileReviewPrompt,
	buildRiskPlanPrompt,
	buildVerificationPrompt,
	type BuiltPrompt,
} from "./prompts.js";
import {
	PiTaskRunner,
	type PiTask,
	type PiTaskRunnerOptions,
	type RunTaskOptions,
	type TaskEvent,
	type TaskOutcome,
} from "./pi-runner.js";
import { resolveFinding } from "./resolver.js";
import { changedLineCount, selectFiles, SELECTION_REASON, type SelectionDecision } from "./selection.js";
import {
	DEFAULT_MAX_TOOL_CALLS,
	DEFAULT_VERIFICATION_MAX_TOOL_CALLS,
	MAX_DIFF_OUTPUT_BYTES,
	REVIEW_RECOVERY_STARTS,
	createReviewToolkit,
	createVerificationToolkit,
	type ReviewToolkit,
	type VerificationToolkit,
	type VerificationSubmission,
} from "./tools.js";
import {
	EMPTY_USAGE,
	type ChangedFile,
	type ExcludedFile,
	type Finding,
	type ReviewEvent,
	type ReviewInput,
	type ReviewOptions,
	type ReviewResult,
	type ReviewStatus,
	type ReviewTarget,
	type ReviewUsage,
	type FailedFile,
	type SkippedFile,
} from "./types.js";

/** The default upper bound keeps an accidental giant diff out of a model prompt. */
export const DEFAULT_MAX_CHANGED_LINES = 2_000;
/** The target diff is also the prompt input, so keep it within the evidence cap. */
export const MAX_REVIEW_DIFF_BYTES = MAX_DIFF_OUTPUT_BYTES;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_PLAN_CHANGED_LINE_THRESHOLD = 50;

export type ReviewTargetFactory = (input: ReviewInput) => Promise<ReviewTarget> | ReviewTarget;

/**
 * The small executor seam used by Reviewer. PiTaskRunner satisfies this
 * structurally; tests can provide an executor that invokes the supplied
 * structured tools without loading Pi or a model provider.
 */
export interface TaskExecutor {
	run(task: PiTask, options?: RunTaskOptions): Promise<TaskOutcome>;
	abortAll(): Promise<void>;
}

export type ReviewTaskExecutor = TaskExecutor;

export type TaskExecutorFactory = (
	options: PiTaskRunnerOptions,
) => TaskExecutor | Promise<TaskExecutor>;

/** Dependencies at the orchestration seam. Every member is optional in order
 * to preserve a useful production default while making each external side
 * effect replaceable in tests. */
export interface ReviewerDependencies {
	readonly targetFactory?: ReviewTargetFactory;
	readonly taskExecutor?: TaskExecutor;
	readonly taskExecutorFactory?: TaskExecutorFactory;
}

interface NormalizedReviewOptions {
	readonly model: string;
	readonly modelSpec: string;
	readonly thinking: ReviewOptions["thinking"];
	readonly concurrency: number;
	readonly include: readonly string[];
	readonly exclude: readonly string[];
	readonly maxToolRounds: number | undefined;
	readonly planChangedLineThreshold: number;
	readonly agentDir: string | undefined;
	readonly sessionDir: string | undefined;
	readonly resumeSessionFile: string | undefined;
	readonly onEvent: ((event: ReviewEvent) => void) | undefined;
	readonly signal: AbortSignal | undefined;
}

interface SelectedReviewFile {
	readonly file: ChangedFile;
	readonly path: string;
	readonly target: ReviewTarget;
}

interface ReviewContext {
	readonly background?: string;
	readonly rules?: string;
	readonly hostEvidence?: string;
	readonly changeMap?: string;
}

interface WorkflowResult {
	readonly success: boolean;
	readonly findings: Finding[];
	readonly usage: ReviewUsage;
	readonly reason?: string;
	readonly sessionFile?: string;
}

interface IndexedWorkflowResult {
	readonly kind: "completed" | "failed" | "skipped";
	readonly path: string;
	readonly findings: Finding[];
	readonly usage: ReviewUsage;
	readonly reason?: string;
	readonly sessionFile?: string;
}

interface CoverageState {
	readonly selected: string[];
	readonly completed: string[];
	readonly failed: FailedFile[];
	readonly skipped: SkippedFile[];
	readonly excluded: ExcludedFile[];
}

const THINKING_LEVELS = new Set<NonNullable<ReviewOptions["thinking"]>>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.length > 0) return error.message;
	if (typeof error === "string" && error.length > 0) return error;
	return fallback;
}

function zeroUsage(): ReviewUsage {
	return { ...EMPTY_USAGE };
}

function finiteCounter(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addUsage(left: ReviewUsage, right: unknown): ReviewUsage {
	if (!isRecord(right)) return left;
	return {
		inputTokens: left.inputTokens + finiteCounter(right.inputTokens),
		outputTokens: left.outputTokens + finiteCounter(right.outputTokens),
		cacheReadTokens: left.cacheReadTokens + finiteCounter(right.cacheReadTokens),
		cacheWriteTokens: left.cacheWriteTokens + finiteCounter(right.cacheWriteTokens),
		totalTokens: left.totalTokens + finiteCounter(right.totalTokens),
	};
}

function modelSpecWithThinking(model: string, thinking: NormalizedReviewOptions["thinking"]): string {
	if (thinking === undefined) return model;

	const slash = model.indexOf("/");
	const colon = model.lastIndexOf(":");
	const suffix = colon > slash ? model.slice(colon + 1) : undefined;
	const base = suffix !== undefined && THINKING_LEVELS.has(suffix as NonNullable<ReviewOptions["thinking"]>)
		? model.slice(0, colon)
		: model;
	return `${base}:${thinking}`;
}

function requirePositiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
		throw new TypeError(`${field} must be a positive safe integer no greater than ${maximum}`);
	}
	return value as number;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new TypeError(`${field} must be a non-negative safe integer`);
	}
	return value as number;
}

function stringArray(value: unknown, field: string): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new TypeError(`${field} must contain only strings`);
	}
	return value.map((entry) => entry as string);
}

function normalizeReviewOptions(options: ReviewOptions): NormalizedReviewOptions {
	if (!isRecord(options)) throw new TypeError("Review options must be an object");
	const model = options.model;
	if (typeof model !== "string" || model.trim().length === 0) {
		throw new TypeError("Review options.model must be a non-empty string");
	}
	if (options.thinking !== undefined && !THINKING_LEVELS.has(options.thinking)) {
		throw new TypeError(`Unsupported thinking level: ${String(options.thinking)}`);
	}
	if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
		throw new TypeError("Review options.onEvent must be a function");
	}
	if (options.agentDir !== undefined && typeof options.agentDir !== "string") {
		throw new TypeError("Review options.agentDir must be a string");
	}
	if (options.sessionDir !== undefined && typeof options.sessionDir !== "string") {
		throw new TypeError("Review options.sessionDir must be a string");
	}
	if (options.resumeSessionFile !== undefined && (typeof options.resumeSessionFile !== "string" || options.resumeSessionFile.length === 0)) {
		throw new TypeError("Review options.resumeSessionFile must be a non-empty string");
	}
	if (options.resumeSessionFile !== undefined && options.sessionDir !== undefined) {
		throw new TypeError("resumeSessionFile and sessionDir cannot be combined");
	}
	if (options.resumeSessionFile !== undefined && options.concurrency !== undefined && options.concurrency !== 1) {
		throw new TypeError("resumeSessionFile requires concurrency 1");
	}
	if (options.signal !== undefined && (options.signal === null || typeof options.signal !== "object")) {
		throw new TypeError("Review options.signal must be an AbortSignal");
	}

	const concurrency = options.concurrency === undefined
		? DEFAULT_CONCURRENCY
		: requirePositiveInteger(options.concurrency, "concurrency");
	const maxToolRounds = options.maxToolRounds === undefined
		? undefined
		: requirePositiveInteger(options.maxToolRounds, "maxToolRounds", Number.MAX_SAFE_INTEGER - 1);
	const planChangedLineThreshold = options.planChangedLineThreshold === undefined
		? DEFAULT_PLAN_CHANGED_LINE_THRESHOLD
		: requireNonNegativeInteger(options.planChangedLineThreshold, "planChangedLineThreshold");

	return {
		model: model.trim(),
		modelSpec: modelSpecWithThinking(model.trim(), options.thinking),
		thinking: options.thinking,
		concurrency,
		include: stringArray(options.include, "include"),
		exclude: stringArray(options.exclude, "exclude"),
		maxToolRounds,
		planChangedLineThreshold,
		agentDir: options.agentDir,
		sessionDir: options.sessionDir,
		resumeSessionFile: options.resumeSessionFile,
		onEvent: options.onEvent,
		signal: options.signal,
	};
}

function pathForFile(file: Pick<ChangedFile, "oldPath" | "newPath">): string {
	const raw = file.newPath !== "" && file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
	return raw.replace(/\\/g, "/").replace(/^\.\//u, "");
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function compareFiles(left: ChangedFile, right: ChangedFile): number {
	const pathOrder = compareText(pathForFile(left), pathForFile(right));
	if (pathOrder !== 0) return pathOrder;
	return compareText(left.oldPath, right.oldPath);
}

function compareSkipped(left: SkippedFile, right: SkippedFile): number {
	const pathOrder = compareText(left.path, right.path);
	return pathOrder !== 0 ? pathOrder : compareText(left.reason, right.reason);
}

function compareFailed(left: FailedFile, right: FailedFile): number {
	const pathOrder = compareText(left.path, right.path);
	return pathOrder !== 0 ? pathOrder : compareText(left.reason, right.reason);
}

const severityRank: Record<Finding["severity"], number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

function compareFindings(left: Finding, right: Finding): number {
	const pathOrder = compareText(left.path, right.path);
	if (pathOrder !== 0) return pathOrder;
	if (left.startLine !== right.startLine) return left.startLine - right.startLine;
	if (left.endLine !== right.endLine) return left.endLine - right.endLine;
	const severityOrder = severityRank[left.severity] - severityRank[right.severity];
	if (severityOrder !== 0) return severityOrder;
	const categoryOrder = compareText(left.category, right.category);
	if (categoryOrder !== 0) return categoryOrder;
	const contentOrder = compareText(left.content, right.content);
	if (contentOrder !== 0) return contentOrder;
	const existingCodeOrder = compareText(left.existingCode, right.existingCode);
	if (existingCodeOrder !== 0) return existingCodeOrder;
	return compareText(left.suggestionCode ?? "", right.suggestionCode ?? "");
}

function taskReason(outcome: TaskOutcome, fallback: string): string {
	if (typeof outcome.error === "string" && outcome.error.length > 0) return outcome.error;
	if (outcome.stopReason !== undefined) return `${fallback} (stop reason: ${outcome.stopReason})`;
	return fallback;
}

function endedWithSuccessfulTool(outcome: TaskOutcome, toolName: string): boolean {
	const last = outcome.toolResults.at(-1);
	return last?.toolName === toolName && last.isError === false;
}

function toolNames(tools: readonly { readonly name: string }[]): string[] {
	return tools.map((tool) => tool.name);
}

/** Planning has only submit_plan. 3 = one bad + one recovered + buffer. */
export const MAX_PLAN_TOOL_STARTS = 3;

interface TaskBudgetOptions {
	readonly maxToolRounds: number | undefined;
	readonly signal: AbortSignal | undefined;
}

export function buildTask(
	phase: "plan" | "review" | "verification",
	prompt: { readonly system: string; readonly user: string },
	tools: readonly { readonly name: string }[],
	options: TaskBudgetOptions,
	onEvent: (event: TaskEvent) => void,
	sessionId?: string,
): PiTask {
	// Evidence phases get one runner start above their nominal toolkit budget;
	// planning has only its terminal tool and uses a small fixed recovery cap.
	const maxToolStarts = phase === "plan"
		? MAX_PLAN_TOOL_STARTS
		: phase === "verification"
			? DEFAULT_VERIFICATION_MAX_TOOL_CALLS + 1
			: (options.maxToolRounds ?? DEFAULT_MAX_TOOL_CALLS) + 1;
	return {
		prompt,
		customTools: tools,
		allowedTools: toolNames(tools),
		maxToolStarts,
		sessionId,
		signal: options.signal,
		onEvent,
	};
}

/** Stable per-task session id used to name persisted transcripts for debugging. */
function taskSessionId(path: string, phase: "plan" | "review" | "verification"): string {
	const safe = path.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return `review-${safe === "" ? "file" : safe}-${phase}`;
}

function resumedPhase(sessionFile: string | undefined, selected: readonly SelectedReviewFile[], options: NormalizedReviewOptions): "plan" | "review" | undefined {
	if (sessionFile === undefined) return undefined;
	if (selected.length !== 1) {
		throw new TypeError("resumeSessionFile requires exactly one selected review file; narrow the review with --include");
	}
	const path = selected[0]?.path ?? "";
	for (const phase of ["plan", "review"] as const) {
		if (sessionFile.endsWith(`_${taskSessionId(path, phase)}.jsonl`)) {
			if (phase === "plan" && changedLineCount(selected[0]!.file) < options.planChangedLineThreshold) {
				throw new TypeError("The resumed planning session no longer meets the planning threshold");
			}
			return phase;
		}
	}
	if (sessionFile.endsWith(`_${taskSessionId(path, "verification")}.jsonl`)) {
		throw new TypeError("Verification sessions cannot be resumed because their evidence ledger is host-only");
	}
	throw new TypeError("Resume session does not match the selected file's planning or review task");
}

function abortedTaskOutcome(signal: AbortSignal): TaskOutcome {
	const reason = signal.reason;
	return {
		status: "aborted",
		stopReason: "aborted",
		text: "",
		error: reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Task aborted",
		usage: zeroUsage(),
		toolResults: [],
	};
}

function invokeTask(
	executor: TaskExecutor,
	task: PiTask,
	signal: AbortSignal | undefined,
	onEvent: (event: TaskEvent) => void,
): Promise<TaskOutcome> {
	const runOptions: RunTaskOptions = {
		signal,
		onEvent,
	};
	if (signal === undefined) return executor.run(task, runOptions);
	if (signal.aborted) return Promise.resolve(abortedTaskOutcome(signal));

	return new Promise<TaskOutcome>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => resolve(abortedTaskOutcome(signal)));
		signal.addEventListener("abort", onAbort, { once: true });
		let taskPromise: Promise<TaskOutcome>;
		try {
			taskPromise = executor.run(task, runOptions);
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		taskPromise.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

function gateReason(file: ChangedFile): string | undefined {
	if (typeof file.rawDiff !== "string" || file.rawDiff.trim().length === 0) return "empty_diff";
	if (new TextEncoder().encode(file.rawDiff).byteLength > MAX_REVIEW_DIFF_BYTES) {
		return "diff_size_limit";
	}
	if (changedLineCount(file) <= 0) return "no_changed_lines";
	return undefined;
}

function makeCoverage(
	selected: readonly string[],
	excluded: readonly ExcludedFile[] = [],
): CoverageState {
	return {
		selected: [...selected],
		completed: [],
		failed: [],
		skipped: [],
		excluded: [...excluded],
	};
}

function statusForCoverage(coverage: CoverageState, aborted: boolean): { status: ReviewStatus; warning?: string } {
	const selected = coverage.selected.length;
	if (selected === 0) return { status: "skipped" };
	if (coverage.completed.length === selected && coverage.failed.length === 0 && coverage.skipped.length === 0) {
		return {
			status: "complete",
			warning: aborted
				? "Review completed for all selected files, but an abort signal was also received; the result is informational."
				: undefined,
		};
	}
	if (coverage.completed.length > 0) return { status: "partial" };
	return { status: "failed" };
}

function messageForResult(
	status: ReviewStatus,
	coverage: CoverageState,
	findings: readonly Finding[],
): string {
	switch (status) {
		case "complete": {
			const excluded = coverage.excluded.length > 0 ? ` ${coverage.excluded.length} file(s) were excluded before review.` : "";
			return findings.length === 0
				? `Review complete: no findings across ${coverage.completed.length} file(s).${excluded}`
				: `Review complete: ${findings.length} finding(s) across ${coverage.completed.length} file(s).${excluded}`;
		}
		case "partial": {
			const selectedLabel = (count: number): string => count === 1 ? "selected file" : "selected files";
			const failed = coverage.failed.length === 0
				? ""
				: ` ${coverage.failed.length} ${selectedLabel(coverage.failed.length)} failed.`;
			const skipped = coverage.skipped.length === 0
				? ""
				: ` ${coverage.skipped.length} ${selectedLabel(coverage.skipped.length)} ${coverage.skipped.length === 1 ? "was" : "were"} skipped after cancellation.`;
			const excluded = coverage.excluded.length === 0
				? ""
				: ` ${coverage.excluded.length} file${coverage.excluded.length === 1 ? "" : "s"} ${coverage.excluded.length === 1 ? "was" : "were"} excluded before review.`;
			return `Review partial: ${coverage.completed.length} of ${coverage.selected.length} ${selectedLabel(coverage.selected.length)} completed;${failed}${skipped}${excluded} Findings are incomplete.`;
		}
		case "failed": {
			const selectedLabel = (count: number): string => count === 1 ? "selected file" : "selected files";
			const failed = coverage.failed.length === 0
				? ""
				: ` ${coverage.failed.length} ${selectedLabel(coverage.failed.length)} failed.`;
			const skipped = coverage.skipped.length === 0
				? ""
				: ` ${coverage.skipped.length} ${selectedLabel(coverage.skipped.length)} ${coverage.skipped.length === 1 ? "was" : "were"} skipped after cancellation.`;
			const excluded = coverage.excluded.length === 0
				? ""
				: ` ${coverage.excluded.length} file${coverage.excluded.length === 1 ? "" : "s"} ${coverage.excluded.length === 1 ? "was" : "were"} excluded before review.`;
			return `Review failed: ${coverage.completed.length} of ${coverage.selected.length} ${selectedLabel(coverage.selected.length)} completed;${failed}${skipped}${excluded}`;
		}
		case "skipped": {
			const excluded = coverage.excluded.length;
			return `Review skipped: no reviewable files were selected.${excluded > 0 ? ` ${excluded} file${excluded === 1 ? " was" : "s were"} excluded before review.` : ""}`;
		}
	}
}

function buildResult(
	startedAt: number,
	model: string,
	coverage: CoverageState,
	findings: readonly Finding[],
	warnings: readonly string[],
	usage: ReviewUsage,
	aborted: boolean,
	emit?: (event: ReviewEvent) => void,
): ReviewResult {
	const sortedCoverage: CoverageState = {
		selected: [...coverage.selected].sort(compareText),
		completed: [...coverage.completed].sort(compareText),
		failed: [...coverage.failed].sort(compareFailed),
		skipped: [...coverage.skipped].sort(compareSkipped),
		excluded: [...coverage.excluded].sort(compareSkipped),
	};
	const sortedFindings = [...findings].sort(compareFindings);
	const { status, warning } = statusForCoverage(sortedCoverage, aborted);
	const resultWarnings = (warning === undefined ? [...warnings] : [...warnings, warning]).sort(compareText);
	if (warning !== undefined) emit?.({ type: "warning", message: warning });
	return {
		status,
		message: messageForResult(status, sortedCoverage, sortedFindings),
		model,
		findings: sortedFindings,
		coverage: sortedCoverage,
		warnings: resultWarnings,
		usage: { ...usage },
		elapsedMs: Math.max(0, Date.now() - startedAt),
	};
}

function makeEarlyFailure(
	startedAt: number,
	model: string,
	message: string,
	warnings: readonly string[],
	onEvent: ((event: ReviewEvent) => void) | undefined,
): ReviewResult {
	const warningList = [...warnings, message];
	onEvent?.({ type: "warning", message });
	return {
		status: "failed",
		message,
		model,
		findings: [],
		coverage: { selected: [], completed: [], failed: [], skipped: [], excluded: [] },
		warnings: warningList,
		usage: zeroUsage(),
		elapsedMs: Math.max(0, Date.now() - startedAt),
	};
}

function isTaskOutcome(value: unknown): value is TaskOutcome {
	if (!isRecord(value)) return false;
	return value.status === "complete" || value.status === "failed" || value.status === "aborted";
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

interface RunPhaseResult<T = unknown> {
	readonly value?: T;
	readonly outcome: TaskOutcome;
	readonly usage: ReviewUsage;
}

class RunPhaseError extends Error {
	readonly outcome: TaskOutcome | undefined;
	readonly usage: ReviewUsage;
	constructor(message: string, outcome: TaskOutcome | undefined, usage: ReviewUsage) {
		super(message);
		this.outcome = outcome;
		this.usage = usage;
	}
}

function phaseForTerminalTool(terminalTool: string): "plan" | "review" | "verification" {
	if (terminalTool === "submit_plan") return "plan";
	if (terminalTool === "submit_review") return "review";
	if (terminalTool === "submit_verification") return "verification";
	throw new Error(`Unknown terminal tool: ${terminalTool}`);
}

function phaseFailedMessage(terminalTool: string): string {
	switch (terminalTool) {
		case "submit_plan":
			return "planner task failed";
		case "submit_review":
			return "main review task failed";
		case "submit_verification":
			return "verification task failed";
		default:
			return `${terminalTool} task failed`;
	}
}

function phaseDidNotCompleteMessage(terminalTool: string): string {
	switch (terminalTool) {
		case "submit_plan":
			return "planner did not submit a plan";
		case "submit_review":
			return "main review did not complete";
		case "submit_verification":
			return "verification did not submit a result";
		default:
			return `${terminalTool} did not complete successfully`;
	}
}

/**
 * Domain-level review orchestration. Pi objects, target acquisition, and task
 * execution live behind this small seam; the result contains only review
 * domain contracts from src/types.ts.
 */
export class Reviewer {
	private readonly dependencies: ReviewerDependencies;

	constructor();
	constructor(dependencies: ReviewerDependencies);
	constructor(targetFactory: ReviewTargetFactory, taskExecutor?: TaskExecutor | TaskExecutorFactory);
	constructor(
		dependenciesOrTargetFactory: ReviewerDependencies | ReviewTargetFactory = {},
		positionalTaskExecutor?: TaskExecutor | TaskExecutorFactory,
	) {
		// Boundary-visible marker: the cutover verifier asserts that the default
		// command path does not construct the legacy Reviewer.
		const globalMarker = globalThis as unknown as Record<string, unknown>;
		if (!globalMarker.LEGACY_CONSTRUCTOR_INVOKED) {
			process.stderr.write("LEGACY_CONSTRUCTOR_INVOKED\n");
			globalMarker.LEGACY_CONSTRUCTOR_INVOKED = true;
		}

		if (typeof dependenciesOrTargetFactory === "function") {
			this.dependencies = {
				targetFactory: dependenciesOrTargetFactory,
				...(typeof positionalTaskExecutor === "function"
					? { taskExecutorFactory: positionalTaskExecutor }
					: { taskExecutor: positionalTaskExecutor }),
			};
		} else {
			this.dependencies = dependenciesOrTargetFactory;
		}
	}

	async review(input: ReviewInput, options: ReviewOptions): Promise<ReviewResult> {
		const startedAt = Date.now();
		const eventHandler = isRecord(options) && typeof options.onEvent === "function"
			? options.onEvent
			: undefined;
		let normalized: NormalizedReviewOptions;
		try {
			normalized = normalizeReviewOptions(options);
		} catch (error) {
			return makeEarlyFailure(
				startedAt,
				typeof options?.model === "string" ? options.model : "",
				errorMessage(error, "Invalid review options"),
				[],
				eventHandler,
			);
		}

		const warnings: string[] = [];
		const emit = (event: ReviewEvent): void => {
			normalized.onEvent?.(event);
		};
		const warn = (message: string): void => {
			warnings.push(message);
			emit({ type: "warning", message });
		};

		let target: ReviewTarget;
		try {
			const targetFactory = this.dependencies.targetFactory ?? createReviewTarget;
			target = await targetFactory(input);
			if (!isRecord(target) || !Array.isArray(target.files)) {
				throw new Error("Review target did not provide a changed-file list");
			}
		} catch (error) {
			const message = `Unable to acquire review target: ${errorMessage(error, "target acquisition failed")}`;
			return makeEarlyFailure(startedAt, normalized.model, message, warnings, normalized.onEvent);
		}

		let selection: ReturnType<typeof selectFiles>;
		try {
			const orderedFiles = [...target.files].sort(compareFiles);
			selection = selectFiles(orderedFiles, {
				include: normalized.include,
				exclude: normalized.exclude,
				maxChangedLines: DEFAULT_MAX_CHANGED_LINES,
			});
		} catch (error) {
			const message = `Unable to select review files: ${errorMessage(error, "file selection failed")}`;
			return makeEarlyFailure(startedAt, normalized.model, message, warnings, normalized.onEvent);
		}

		const selected: SelectedReviewFile[] = [];
		const gatedSkipped: SkippedFile[] = [];
		try {
			for (const file of selection.selected) {
				const path = pathForFile(file);
				const reason = gateReason(file);
				if (reason !== undefined) {
					gatedSkipped.push({ path, reason });
					continue;
				}
				selected.push({ file, path, target });
			}
		} catch (error) {
			const message = `Unable to validate selected review files: ${errorMessage(error, "review file validation failed")}`;
			return makeEarlyFailure(startedAt, normalized.model, message, warnings, normalized.onEvent);
		}

		const excluded: ExcludedFile[] = [
			...selection.skipped,
			...gatedSkipped,
		];
		const coverage = makeCoverage(
			selected.map((entry) => entry.path),
			excluded,
		);

		// Build the cross-file change map once, after deterministic selection
		// decisions exist and before any worker is dispatched. It is passive
		// orientation evidence: a failure here warns and continues without the
		// map rather than failing the review.
		const sizeLimitedPaths = new Set(
			gatedSkipped
				.filter((skipped) => skipped.reason === "diff_size_limit")
				.map((skipped) => skipped.path),
		);
		const changeMapDecisions: SelectionDecision[] = selection.decisions.map((decision) =>
			sizeLimitedPaths.has(decision.path)
				? { ...decision, selected: false, reason: SELECTION_REASON.sizeLimit }
				: decision,
		);

		let changeMap: ChangeMap | undefined;
		const changeMapSlices = new Map<string, string>();
		try {
			changeMap = buildChangeMap(changeMapDecisions, { exclude: normalized.exclude });
			if (changeMap !== undefined) {
				for (const entry of selected) {
					changeMapSlices.set(entry.path, renderChangeMapSlice(changeMap, entry.path));
				}
			}
		} catch (error) {
			warn(`Unable to build or render cross-file change map: ${errorMessage(error, "change map construction or rendering failed")}`);
		}
		let resumePhase: "plan" | "review" | undefined;
		try {
			resumePhase = resumedPhase(normalized.resumeSessionFile, selected, normalized);
		} catch (error) {
			const message = `Unable to resume review: ${errorMessage(error, "invalid resume session")}`;
			return makeEarlyFailure(startedAt, normalized.model, message, warnings, normalized.onEvent);
		}

		const findings: Finding[] = [];
		let usage = zeroUsage();
		let aborted = normalized.signal?.aborted === true;

		// This is intentionally before any executor call. A caller observing the
		// first event can rely on coverage.selected already being fixed for the run.
		emit({ type: "review_started", files: selected.length });

		if (selected.length === 0) {
			return buildResult(startedAt, normalized.model, coverage, findings, warnings, usage, aborted, emit);
		}

		if (normalized.signal?.aborted === true) {
			for (const entry of selected) coverage.skipped.push({ path: entry.path, reason: "aborted" });
			aborted = true;
			return buildResult(startedAt, normalized.model, coverage, findings, warnings, usage, aborted, emit);
		}

		let executor: TaskExecutor;
		try {
			executor = await this.makeExecutor(normalized, target.repositoryRoot);
		} catch (error) {
			const reason = `Unable to create task executor: ${errorMessage(error, "executor initialization failed")}`;
			warn(reason);
			for (const entry of selected) coverage.failed.push({ path: entry.path, reason });
			return buildResult(startedAt, normalized.model, coverage, findings, warnings, usage, aborted, emit);
		}

		let abortAllPromise: Promise<void> | undefined;
		const requestAbortAll = (): void => {
			if (abortAllPromise !== undefined) return;
			abortAllPromise = Promise.resolve()
				.then(() => executor.abortAll())
				.catch((error: unknown) => {
					warn(`Unable to abort active review tasks: ${errorMessage(error, "abortAll failed")}`);
				});
		};
		const signal = normalized.signal;
		const abortListener = (): void => {
			aborted = true;
			requestAbortAll();
		};
		if (signal !== undefined) {
			signal.addEventListener("abort", abortListener, { once: true });
			if (signal.aborted) abortListener();
		}

		const results: Array<IndexedWorkflowResult | undefined> = Array.from({ length: selected.length });
		let nextIndex = 0;
		const worker = async (): Promise<void> => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				const entry = selected[index];
				if (entry === undefined) return;

				if (signal?.aborted === true) {
					aborted = true;
					results[index] = {
						kind: "skipped",
						path: entry.path,
						findings: [],
						usage: zeroUsage(),
						reason: "aborted",
					};
					continue;
				}

				emit({ type: "file_started", path: entry.path });
				let workflow: WorkflowResult;
				try {
					workflow = await this.reviewFile(
						entry,
						selected,
						{
							background: input.background,
							rules: input.rules,
							hostEvidence: input.hostEvidence,
							changeMap: changeMapSlices.get(entry.path),
						},
						normalized,
						resumePhase,
						executor,
						warn,
						(event) => emit(event),
					);
				} catch (error) {
					const reason = `Review task failed for ${entry.path}: ${errorMessage(error, "unexpected file failure")}`;
					warn(reason);
					workflow = { success: false, findings: [], usage: zeroUsage(), reason };
				}

				usage = addUsage(usage, workflow.usage);
				if (workflow.success) {
					results[index] = {
						kind: "completed",
						path: entry.path,
						findings: workflow.findings,
						usage: workflow.usage,
					};
					findings.push(...workflow.findings);
					emit({ type: "file_completed", path: entry.path, findings: workflow.findings.length });
				} else {
					const reason = workflow.reason ?? `Review task failed for ${entry.path}`;
					if (signalIsAborted(signal)) {
						aborted = true;
						results[index] = {
							kind: "skipped",
							path: entry.path,
							findings: workflow.findings,
							usage: workflow.usage,
							reason: "aborted",
						};
						continue;
					}
					results[index] = {
						kind: "failed",
						path: entry.path,
						findings: workflow.findings,
						usage: workflow.usage,
						reason,
						sessionFile: workflow.sessionFile,
					};
					emit({ type: "file_failed", path: entry.path, reason, sessionFile: workflow.sessionFile });
				}
			}
		};

		const workerCount = Math.min(normalized.concurrency, selected.length);
		try {
			await Promise.all(Array.from({ length: workerCount }, () => worker()));
		} finally {
			if (abortAllPromise !== undefined) await abortAllPromise;
			if (signal !== undefined) signal.removeEventListener("abort", abortListener);
		}

		for (let index = 0; index < selected.length; index += 1) {
			const entry = selected[index];
			if (entry === undefined || results[index] !== undefined) continue;
			coverage.skipped.push({ path: entry.path, reason: "not_dispatched" });
		}
		for (const result of results) {
			if (result === undefined) continue;
			if (result.kind === "completed") {
				coverage.completed.push(result.path);
			} else if (result.kind === "failed") {
				coverage.failed.push({
					path: result.path,
					reason: result.reason ?? "file review failed",
					...(result.sessionFile === undefined ? {} : { sessionFile: result.sessionFile }),
				});
			} else {
				coverage.skipped.push({ path: result.path, reason: result.reason ?? "skipped" });
			}
		}

		return buildResult(startedAt, normalized.model, coverage, findings, warnings, usage, aborted, emit);
	}

	private async makeExecutor(options: NormalizedReviewOptions, repositoryRoot: string): Promise<TaskExecutor> {
		const injected = this.dependencies.taskExecutor;
		if (injected !== undefined) return injected;

		const factory = this.dependencies.taskExecutorFactory;
		const runnerOptions: PiTaskRunnerOptions = {
			model: options.modelSpec,
			cwd: repositoryRoot,
			agentDir: options.agentDir,
			sessionDir: options.sessionDir,
		};
		if (factory !== undefined) return factory(runnerOptions);
		return new PiTaskRunner(runnerOptions);
	}

	private async runPhase<T = unknown>(
		prompt: BuiltPrompt,
		tools: readonly { readonly name: string }[],
		terminalTool: string,
		{ failOpen }: { failOpen: boolean },
		executor: TaskExecutor,
		options: NormalizedReviewOptions,
		onEvent: (event: TaskEvent) => void,
		sessionId: string,
		extractValue?: (outcome: TaskOutcome) => T,
		resumeSessionFile?: string,
	): Promise<RunPhaseResult<T>> {
		const task = this.makeTask(
			phaseForTerminalTool(terminalTool),
			prompt,
			tools,
			options,
			onEvent,
			sessionId,
			resumeSessionFile,
		);
		let raw: unknown;
		try {
			raw = await invokeTask(executor, task, options.signal, onEvent);
		} catch (error) {
			const observed = zeroUsage();
			if (failOpen) {
				return {
					value: undefined,
					outcome: {
						status: "failed",
						stopReason: "error",
						error: errorMessage(error, phaseFailedMessage(terminalTool)),
						text: "",
						usage: observed,
						toolResults: [],
					},
					usage: observed,
				};
			}
			throw new RunPhaseError(errorMessage(error, phaseFailedMessage(terminalTool)), undefined, observed);
		}
		if (!isTaskOutcome(raw)) {
			const observed = addUsage(
				zeroUsage(),
				isRecord(raw) && Object.hasOwn(raw, "usage") ? (raw as { usage: unknown }).usage : undefined,
			);
			if (failOpen) {
				return {
					value: undefined,
					outcome: {
						status: "failed",
						stopReason: "error",
						error: "Task executor returned an invalid outcome",
						text: "",
						usage: observed,
						toolResults: [],
					},
					usage: observed,
				};
			}
			throw new RunPhaseError("Task executor returned an invalid outcome", undefined, observed);
		}
		const outcome = raw;
		const usage = addUsage(zeroUsage(), outcome.usage);
		if (outcome.status === "complete" && endedWithSuccessfulTool(outcome, terminalTool)) {
			const value = extractValue === undefined ? undefined : extractValue(outcome);
			return { value, outcome, usage };
		}
		if (failOpen) {
			return { value: undefined, outcome, usage };
		}
		throw new RunPhaseError(phaseDidNotCompleteMessage(terminalTool), outcome, usage);
	}

	private async reviewFile(
		entry: SelectedReviewFile,
		selected: readonly SelectedReviewFile[],
		context: ReviewContext,
		options: NormalizedReviewOptions,
		resumePhase: "plan" | "review" | undefined,
		executor: TaskExecutor,
		warn: (message: string) => void,
		emit: (event: ReviewEvent) => void,
	): Promise<WorkflowResult> {
		let usage = zeroUsage();
		let riskPlan: string | undefined;
		const otherChangedFiles = selected
			.map((candidate) => candidate.path)
			.filter((path) => path !== entry.path);
		const taskEvent = (path: string) => (event: TaskEvent): void => {
			if (event.type === "tool_started") {
				emit({ type: "tool_started", path, tool: event.toolName });
			} else {
				warn(`${path}: ${event.message}`);
			}
		};

		if (changedLineCount(entry.file) >= options.planChangedLineThreshold && resumePhase !== "review") {
			const planToolkit: PlanToolkit = createPlanToolkit();
			const prompt = buildRiskPlanPrompt({
				currentFilePath: entry.path,
				currentFileDiff: entry.file.rawDiff,
				otherChangedFiles,
				changeMap: context.changeMap,
				background: context.background,
				rules: context.rules,
				hostEvidence: context.hostEvidence,
			});
			const plan = await this.runPhase(
				prompt,
				planToolkit.tools,
				"submit_plan",
				{ failOpen: true },
				executor,
				options,
				taskEvent(entry.path),
				taskSessionId(entry.path, "plan"),
				() => planToolkit.value,
				resumePhase === "plan" ? options.resumeSessionFile : undefined,
			);
			usage = addUsage(usage, plan.usage);
			if (plan.value !== undefined) {
				riskPlan = JSON.stringify(plan.value);
			} else {
				warn(`Risk planner failed or returned no usable plan for ${entry.path}: ${taskReason(plan.outcome, "planner did not submit a plan")}`);
			}
		}

		if (signalIsAborted(options.signal)) {
			return {
				success: false,
				findings: [],
				usage,
				reason: `Review aborted before main review for ${entry.path}`,
			};
		}

		const reviewMaxToolCalls = options.maxToolRounds ?? DEFAULT_MAX_TOOL_CALLS;
		let toolkit: ReviewToolkit;
		try {
			toolkit = createReviewToolkit(entry.target, entry.path, {
				maxToolCalls: reviewMaxToolCalls,
			});
		} catch (error) {
			const reason = `Unable to create review tools for ${entry.path}: ${errorMessage(error, "review toolkit initialization failed")}`;
			warn(reason);
			return { success: false, findings: [], usage, reason };
		}
		const prompt = buildFileReviewPrompt({
			currentFilePath: entry.path,
			currentFileDiff: entry.file.rawDiff,
			otherChangedFiles,
			changeMap: context.changeMap,
			background: context.background,
			rules: context.rules,
			hostEvidence: context.hostEvidence,
			riskPlan,
			maxToolCalls: reviewMaxToolCalls,
		});
		let review: RunPhaseResult;
		try {
			review = await this.runPhase(
				prompt,
				toolkit.tools,
				"submit_review",
				{ failOpen: false },
				executor,
				options,
				taskEvent(entry.path),
				taskSessionId(entry.path, "review"),
				undefined,
				resumePhase === "review" ? options.resumeSessionFile : undefined,
			);
		} catch (error) {
			if (error instanceof RunPhaseError) {
				let reason: string;
				if (error.outcome?.status === "complete" && !endedWithSuccessfulTool(error.outcome, "submit_review")) {
					reason = `Review task failed for ${entry.path}: submit_review DONE was not the final successful tool result (state: ${toolkit.completion})`;
				} else if (error.outcome !== undefined) {
					reason = `Review task failed for ${entry.path}: ${taskReason(error.outcome, error.message)}`;
				} else {
					reason = `Review task failed for ${entry.path}: ${error.message}`;
				}
				warn(reason);
				return { success: false, findings: [], usage: addUsage(usage, error.usage), reason, sessionFile: error.outcome?.sessionFile };
			}
			throw error;
		}
		usage = addUsage(usage, review.usage);

		if (toolkit.completion !== "DONE") {
			const reason = `Review task failed for ${entry.path}: submit_review DONE was not the final successful tool result (state: ${toolkit.completion})`;
			warn(reason);
			return { success: false, findings: [], usage, reason, sessionFile: review.outcome.sessionFile };
		}
		if (signalIsAborted(options.signal)) {
			return {
				success: false,
				findings: [],
				usage,
				reason: `Review aborted after main review for ${entry.path}`,
				sessionFile: review.outcome.sessionFile,
			};
		}

		const resolved: Finding[] = [];
		for (const [index, candidate] of toolkit.candidates.entries()) {
			let finding: Finding | undefined;
			try {
				finding = resolveFinding(entry.file, candidate);
			} catch (error) {
				warn(`Discarded unanchored finding for ${entry.path} (candidate ${index + 1}): ${errorMessage(error, "invalid anchor")}`);
				continue;
			}
			if (finding === undefined) {
				warn(`Discarded unanchored finding for ${entry.path} (candidate ${index + 1}).`);
				continue;
			}
			resolved.push(finding);
		}

		if (resolved.length === 0) return { success: true, findings: [], usage };

		const candidateIds = resolved.map((_finding, index) => `c-${index}`);
		let verificationToolkit: VerificationToolkit;
		try {
			verificationToolkit = createVerificationToolkit(
				entry.target,
				entry.path,
				entry.file.rawDiff,
				candidateIds,
			);
		} catch (error) {
			const reason = `Unable to create verification tools for ${entry.path}: ${errorMessage(error, "verification toolkit initialization failed")}`;
			warn(reason);
			return { success: false, findings: [], usage, reason };
		}
		const verificationPrompt = buildVerificationPrompt({
			currentFilePath: entry.path,
			currentFileDiff: entry.file.rawDiff,
			maxEvidenceCalls: Math.max(0, DEFAULT_VERIFICATION_MAX_TOOL_CALLS - REVIEW_RECOVERY_STARTS),
			comments: resolved.map((finding, index) => ({
				id: candidateIds[index] ?? `c-${index}`,
				content: finding.content,
				existingCode: finding.existingCode,
				suggestionCode: finding.suggestionCode,
				startLine: finding.startLine,
				endLine: finding.endLine,
				category: finding.category,
				severity: finding.severity,
			})),
		});
		let verification: RunPhaseResult<VerificationSubmission>;
		try {
			verification = await this.runPhase(
				verificationPrompt,
				verificationToolkit.tools,
				"submit_verification",
				{ failOpen: false },
				executor,
				options,
				taskEvent(entry.path),
				taskSessionId(entry.path, "verification"),
				() => {
					const value = verificationToolkit.value;
					if (value === undefined) throw new Error("submit_verification completed without a captured value");
					return value;
				},
			);
		} catch (error) {
			if (error instanceof RunPhaseError) {
				usage = addUsage(usage, error.usage);
				const reason = `Verification task failed for ${entry.path}: ${error.outcome === undefined ? error.message : taskReason(error.outcome, error.message)}`;
				warn(reason);
				return { success: false, findings: [], usage, reason, sessionFile: error.outcome?.sessionFile };
			}
			throw error;
		}
		usage = addUsage(usage, verification.usage);

		if (signalIsAborted(options.signal)) {
			return {
				success: false,
				findings: [],
				usage,
				reason: `Review aborted during verification for ${entry.path}`,
				sessionFile: verification.outcome.sessionFile,
			};
		}
		if (verification.value === undefined || !verificationToolkit.completed) {
			const reason = `Verification task failed for ${entry.path}: no usable exhaustive verification result`;
			warn(reason);
			return { success: false, findings: [], usage, reason, sessionFile: verification.outcome.sessionFile };
		}

		const verifiedIds = new Set(
			verification.value.decisions
				.filter((decision) => decision.verdict === "verified")
				.map((decision) => decision.candidateId),
		);
		return {
			success: true,
			findings: resolved.filter((_finding, index) => verifiedIds.has(candidateIds[index] ?? "")),
			usage,
		};
	}

	private makeTask(
		phase: "plan" | "review" | "verification",
		prompt: { readonly system: string; readonly user: string },
		tools: readonly { readonly name: string }[],
		options: NormalizedReviewOptions,
		onEvent: (event: TaskEvent) => void,
		sessionId?: string,
		resumeSessionFile?: string,
	): PiTask {
		return {
			...buildTask(phase, prompt, tools, options, onEvent, sessionId),
			...(resumeSessionFile === undefined ? {} : { resumeSessionFile }),
		};
	}
}

/** Run one review with production defaults, without requiring a Reviewer object. */
export function review(
	input: ReviewInput,
	options: ReviewOptions,
	dependencies?: ReviewerDependencies,
): Promise<ReviewResult>;
export function review(
	input: ReviewInput,
	options: ReviewOptions,
	targetFactory?: ReviewTargetFactory,
	taskExecutor?: TaskExecutor | TaskExecutorFactory,
): Promise<ReviewResult>;
export function review(
	input: ReviewInput,
	options: ReviewOptions,
	dependenciesOrTargetFactory: ReviewerDependencies | ReviewTargetFactory = {},
	taskExecutor?: TaskExecutor | TaskExecutorFactory,
): Promise<ReviewResult> {
	const reviewer = typeof dependenciesOrTargetFactory === "function"
		? new Reviewer(dependenciesOrTargetFactory, taskExecutor)
		: new Reviewer(dependenciesOrTargetFactory);
	return reviewer.review(input, options);
}

/** Explicit factory for hosts that want to retain a configured seam. */
export function createReviewer(dependencies?: ReviewerDependencies): Reviewer {
	return new Reviewer(dependencies ?? {});
}


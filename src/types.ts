export type ReviewMode =
	| { kind: "workspace" }
	| { kind: "range"; base: string; head: string }
	| { kind: "commit"; ref: string };

export interface ReviewInput {
	repository: string;
	mode: ReviewMode;
	background?: string;
	rules?: string;
	readonly hostEvidence?: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Review configuration. The model, concurrency, filters, and thresholds are
 * tunable. Fixed guardrails (`DEFAULT_MAX_CHANGED_LINES`, `MAX_REVIEW_DIFF_BYTES`)
 * are policy in `reviewer.ts` and are not exposed as tuning knobs.
 */
export interface ReviewOptions {
	model: string;
	thinking?: ThinkingLevel;
	concurrency?: number;
	include?: readonly string[];
	exclude?: readonly string[];
	maxToolRounds?: number;
	planChangedLineThreshold?: number;
	agentDir?: string;
	/** When set, persist each per-task Pi session transcript (.jsonl) under this directory. */
	sessionDir?: string;
	onEvent?: (event: ReviewEvent) => void;
	signal?: AbortSignal;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingCategory =
	| "bug"
	| "security"
	| "performance"
	| "maintainability"
	| "test"
	| "style"
	| "documentation"
	| "other";

export interface CandidateFinding {
	content: string;
	existingCode: string;
	suggestionCode?: string;
	category: FindingCategory;
	severity: FindingSeverity;
}

export interface Finding extends CandidateFinding {
	path: string;
	startLine: number;
	endLine: number;
}

export interface SkippedFile {
	path: string;
	reason: string;
}

export interface FailedFile {
	path: string;
	reason: string;
	/** Path of the Pi session transcript (.jsonl) for the failed task, when sessions are persisted. */
	sessionFile?: string;
}

export interface ReviewCoverage {
	selected: readonly string[];
	completed: readonly string[];
	failed: readonly FailedFile[];
	skipped: readonly SkippedFile[];
}

export type ReviewStatus = "complete" | "partial" | "failed" | "skipped";

export interface ReviewUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

export interface ReviewResult {
	status: ReviewStatus;
	message: string;
	model: string;
	findings: readonly Finding[];
	coverage: ReviewCoverage;
	warnings: readonly string[];
	usage: ReviewUsage;
	elapsedMs: number;
}

export type ReviewEvent =
	| { type: "review_started"; files: number }
	| { type: "file_started"; path: string }
	| { type: "tool_started"; path: string; tool: string }
	| { type: "file_completed"; path: string; findings: number }
	| { type: "file_failed"; path: string; reason: string; sessionFile?: string }
	| { type: "warning"; message: string };

export interface DiffLine {
	kind: "context" | "addition" | "deletion";
	text: string;
	oldLine?: number;
	newLine?: number;
}

export interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: readonly DiffLine[];
}

export interface ChangedFile {
	oldPath: string;
	newPath: string;
	rawDiff: string;
	newContent: string | undefined;
	isBinary: boolean;
	isDeleted: boolean;
	isNew: boolean;
	isRenamed: boolean;
	insertions: number;
	deletions: number;
	hunks: readonly DiffHunk[];
}

export interface ReviewTarget {
	repositoryRoot: string;
	mode: ReviewMode;
	targetRef?: string;
	files: readonly ChangedFile[];
	readFile(path: string): Promise<string>;
	listFiles(): Promise<readonly string[]>;
}

export const EMPTY_USAGE: ReviewUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

export type ReviewMode =
	| { kind: "workspace" }
	| { kind: "range"; base: string; head: string }
	| { kind: "commit"; ref: string };

export interface ReviewInput {
	repository: string;
	mode: ReviewMode;
	background?: string;
	rules?: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ReviewOptions {
	model: string;
	thinking?: ThinkingLevel;
	concurrency?: number;
	include?: string[];
	exclude?: string[];
	maxToolRounds?: number;
	planChangedLineThreshold?: number;
	agentDir?: string;
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
}

export interface ReviewCoverage {
	selected: string[];
	completed: string[];
	failed: FailedFile[];
	skipped: SkippedFile[];
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
	findings: Finding[];
	coverage: ReviewCoverage;
	warnings: string[];
	usage: ReviewUsage;
	elapsedMs: number;
}

export type ReviewEvent =
	| { type: "review_started"; files: number }
	| { type: "file_started"; path: string }
	| { type: "tool_started"; path: string; tool: string }
	| { type: "file_completed"; path: string; findings: number }
	| { type: "file_failed"; path: string; reason: string }
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
	lines: DiffLine[];
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
	hunks: DiffHunk[];
}

export interface ReviewTarget {
	repositoryRoot: string;
	mode: ReviewMode;
	targetRef?: string;
	files: ChangedFile[];
	readFile(path: string): Promise<string>;
	listFiles(): Promise<string[]>;
}

export interface FileReviewResult {
	findings: Finding[];
	warnings: string[];
	usage: ReviewUsage;
}

export const EMPTY_USAGE: ReviewUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

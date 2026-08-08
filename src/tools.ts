import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import { type Static, Type } from "typebox";

import { assertSafeDiffPath } from "./diff.js";
import type {
	CandidateFinding,
	ChangedFile,
	FindingCategory,
	FindingSeverity,
	ReviewTarget,
} from "./types.js";

const DEV_NULL = "/dev/null";

export const MAX_FILE_READ_LINES = 500;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_FIND_RESULTS = 100;
export const MAX_CANDIDATES_PER_REVIEW = 20;
export const MAX_SEARCH_PATTERN_LENGTH = 256;
export const MAX_FIND_PATTERN_LENGTH = 256;
export const MAX_PATH_LENGTH = 4096;
export const MAX_SEARCH_FILE_BYTES = 1_000_000;
export const MAX_SEARCH_LINE_BYTES = 4_000;
export const MAX_SEARCH_OUTPUT_BYTES = 50_000;
/** Host-side scan ceiling for code_search: bounds total files and bytes scanned across the target tree, not just output. */
export const MAX_SCAN_FILES = 500;
export const MAX_SCAN_BYTES = 2_000_000;
export const MAX_READ_OUTPUT_BYTES = 100_000;
export const MAX_DIFF_OUTPUT_BYTES = 100_000;
/** The default per-file evidence budget. The model sees this number in its system prompt and must reserve one call for submit_review. */
export const DEFAULT_MAX_TOOL_CALLS = 32;

const MAX_COMMENT_CONTENT_LENGTH = 10_000;
const MAX_COMMENT_CODE_LENGTH = 5_000;

const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
const FINDING_CATEGORIES = [
	"bug",
	"security",
	"performance",
	"maintainability",
	"test",
	"style",
	"documentation",
	"other",
] as const;

function stringEnum<const T extends readonly [string, ...string[]]>(values: T) {
	return Type.Union(values.map((value) => Type.Literal(value)));
}

const fileReadParameters = Type.Object({
	path: Type.String({
		minLength: 1,
		maxLength: MAX_PATH_LENGTH,
		description: "Repository-relative target path",
	}),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return (1-indexed)" })),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_FILE_READ_LINES,
			description: `Maximum number of numbered lines (at most ${MAX_FILE_READ_LINES})`,
		}),
	),
});

type FileReadParameters = Static<typeof fileReadParameters>;

const codeSearchParameters = Type.Object({
	pattern: Type.String({
		minLength: 1,
		maxLength: MAX_SEARCH_PATTERN_LENGTH,
		description: `Literal text to search for (at most ${MAX_SEARCH_PATTERN_LENGTH} characters)`,
	}),
	path: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: MAX_PATH_LENGTH,
			description: "Optional repository-relative file or directory scope",
		}),
	),
});

type CodeSearchParameters = Static<typeof codeSearchParameters>;

const fileFindParameters = Type.Object({
	pattern: Type.String({
		minLength: 1,
		maxLength: MAX_FIND_PATTERN_LENGTH,
		description: "Glob pattern for repository-relative target paths",
	}),
	path: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: MAX_PATH_LENGTH,
			description: "Optional repository-relative directory scope",
		}),
	),
});

type FileFindParameters = Static<typeof fileFindParameters>;

const fileReadDiffParameters = Type.Object({
	path: Type.String({
		minLength: 1,
		maxLength: MAX_PATH_LENGTH,
		description: "Repository-relative path of a known changed file",
	}),
});

type FileReadDiffParameters = Static<typeof fileReadDiffParameters>;

const candidateFindingParameters = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: MAX_COMMENT_CONTENT_LENGTH }),
		existingCode: Type.String({ minLength: 1, maxLength: MAX_COMMENT_CODE_LENGTH }),
		suggestionCode: Type.Optional(Type.String({ maxLength: MAX_COMMENT_CODE_LENGTH })),
		category: stringEnum(FINDING_CATEGORIES),
		severity: stringEnum(FINDING_SEVERITIES),
	},
	{ additionalProperties: false },
);

const submitReviewParameters = Type.Object(
	{
		state: stringEnum(["DONE", "FAILED"] as const),
		comments: Type.Array(candidateFindingParameters, {
			maxItems: MAX_CANDIDATES_PER_REVIEW,
			description: `Confirmed findings for the current file (at most ${MAX_CANDIDATES_PER_REVIEW})`,
		}),
	},
	{ additionalProperties: false },
);

type SubmitReviewParameters = Static<typeof submitReviewParameters>;

export type CompletionState = "pending" | "DONE" | "FAILED";

export interface ReviewToolkitOptions {
	/** Maximum number of accepted evidence calls plus the final submit_review call. */
	readonly maxToolCalls?: number;
}

export interface ReviewToolkit {
	readonly tools: ToolDefinition[];
	readonly candidates: readonly CandidateFinding[];
	readonly completion: CompletionState;
	readonly completed: boolean;
	readonly toolCallCount: number;
	readonly maxToolCalls: number;
}

export interface FileReadDetails {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly totalLines: number;
	readonly truncated: boolean;
}

export interface CodeSearchDetails {
	readonly pattern: string;
	readonly matchCount: number;
	readonly resultLimitReached: boolean;
	readonly skippedLargeFiles: number;
	readonly skippedBinaryFiles: number;
	readonly truncatedLines: boolean;
	readonly truncatedOutput: boolean;
	readonly scanCapped: boolean;
}

export interface FileFindDetails {
	readonly pattern: string;
	readonly resultCount: number;
	readonly resultLimitReached: boolean;
	readonly truncatedOutput: boolean;
}

export interface FileReadDiffDetails {
	readonly path: string;
	readonly truncated: boolean;
}

export interface SubmitReviewDetails {
	readonly state: "DONE" | "FAILED";
	readonly recorded: number;
}

interface MutableToolkitState {
	calls: number;
	completion: CompletionState;
	candidates: CandidateFinding[];
	maxToolCalls: number;
}

interface KnownChangedFile {
	readonly file: ChangedFile;
	readonly paths: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (byteLength(value) <= maxBytes) return value;

	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (byteLength(value.slice(0, middle)) <= maxBytes) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}

	// Do not return a string split between a UTF-16 surrogate pair.
	if (low > 0 && low < value.length) {
		const previous = value.charCodeAt(low - 1);
		if (previous >= 0xd800 && previous <= 0xdbff) low -= 1;
	}
	return value.slice(0, low);
}

function appendNotices(value: string, notices: readonly string[], maxBytes: number): string {
	if (notices.length === 0) return truncateUtf8(value, maxBytes);
	const suffix = `\n\n[${notices.join("; ")}]`;
	const budget = Math.max(0, maxBytes - byteLength(suffix));
	const prefix = truncateUtf8(value, budget);
	return `${prefix}${suffix}`;
}

function abortError(): Error {
	return new Error("Operation aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

/** Race a ReviewTarget operation with cancellation; ReviewTarget has no signal parameter of its own. */
async function withAbort<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
	throwIfAborted(signal);
	if (signal === undefined) return operation();

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const settle = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => settle(() => reject(abortError()));

		signal.addEventListener("abort", onAbort, { once: true });
		try {
			operation().then(
				(value) => settle(() => resolve(value)),
				(error: unknown) => settle(() => reject(error)),
			);
		} catch (error) {
			settle(() => reject(error));
		}
	});
}

function normalizeRequestedPath(rawPath: string, label = "path"): string {
	if (typeof rawPath !== "string") throw new Error(`${label} must be a string`);
	let path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
		throw new Error(`${label} is outside the permitted path length`);
	}
	try {
		return assertSafeDiffPath(path);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unsafe repository ${label} rejected: ${detail}`);
	}
}

function normalizeScopePath(rawPath: string | undefined): string | undefined {
	if (rawPath === undefined) return undefined;
	if (typeof rawPath !== "string") throw new Error("path must be a string");
	let path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (path === ".") return undefined;
	if (path.startsWith("./")) path = path.slice(2);
	return normalizeRequestedPath(path, "path");
}

function validateTargetPath(rawPath: unknown): string {
	if (typeof rawPath !== "string") throw new Error("ReviewTarget returned a non-string path");
	if (rawPath.length === 0 || rawPath.length > MAX_PATH_LENGTH) {
		throw new Error("ReviewTarget returned a path outside the permitted path length");
	}
	try {
		return assertSafeDiffPath(rawPath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`ReviewTarget returned an unsafe path: ${detail}`);
	}
}

function changedPaths(file: ChangedFile): Set<string> {
	const paths = new Set<string>();
	for (const candidate of [file.oldPath, file.newPath]) {
		if (candidate === "" || candidate === DEV_NULL) continue;
		paths.add(validateTargetPath(candidate));
	}
	if (paths.size === 0) throw new Error("Changed file has no safe repository path");
	return paths;
}

function knownChangedFiles(target: ReviewTarget): KnownChangedFile[] {
	return target.files.map((file) => ({ file, paths: changedPaths(file) }));
}

async function listTargetFiles(target: ReviewTarget, signal: AbortSignal | undefined): Promise<string[]> {
	const rawPaths = await withAbort(signal, () => target.listFiles());
	if (!Array.isArray(rawPaths)) throw new Error("ReviewTarget returned an invalid file list");

	const paths = new Set<string>();
	for (const rawPath of rawPaths) paths.add(validateTargetPath(rawPath));
	return [...paths].sort();
}

async function readTargetFile(
	target: ReviewTarget,
	path: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const safePath = normalizeRequestedPath(path);
	const content = await withAbort(signal, () => target.readFile(safePath));
	if (typeof content !== "string") throw new Error(`ReviewTarget returned non-text content for ${safePath}`);
	throwIfAborted(signal);
	return content;
}

function filesInScope(files: readonly string[], scope: string | undefined): string[] {
	if (scope === undefined) return [...files];
	const prefix = `${scope}/`;
	const scoped = files.filter((path) => path === scope || path.startsWith(prefix));
	if (scoped.length === 0) throw new Error(`Path is not present in the target tree: ${scope}`);
	return scoped;
}

function splitLines(content: string): string[] {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (normalized.length === 0) return [];
	const lines = normalized.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function isFindingSeverity(value: unknown): value is FindingSeverity {
	return typeof value === "string" && FINDING_SEVERITIES.some((candidate) => candidate === value);
}

function isFindingCategory(value: unknown): value is FindingCategory {
	return typeof value === "string" && FINDING_CATEGORIES.some((candidate) => candidate === value);
}

const CANDIDATE_KEYS = new Set([
	"content",
	"existingCode",
	"suggestionCode",
	"category",
	"severity",
]);

function validateCandidate(value: unknown): CandidateFinding {
	if (!isRecord(value)) throw new Error("submit_review.comments must contain finding objects");
	for (const key of Object.keys(value)) {
		if (!CANDIDATE_KEYS.has(key)) {
			throw new Error(`submit_review does not accept finding field ${JSON.stringify(key)}`);
		}
	}
	const content = value.content;
	const existingCode = value.existingCode;
	const suggestionCode = value.suggestionCode;
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new Error("submit_review content must be a non-empty string");
	}
	if (content.length > MAX_COMMENT_CONTENT_LENGTH) {
		throw new Error(`submit_review content exceeds ${MAX_COMMENT_CONTENT_LENGTH} characters`);
	}
	if (typeof existingCode !== "string" || existingCode.trim().length === 0) {
		throw new Error("submit_review existingCode must be a non-empty string");
	}
	if (existingCode.length > MAX_COMMENT_CODE_LENGTH) {
		throw new Error(`submit_review existingCode exceeds ${MAX_COMMENT_CODE_LENGTH} characters`);
	}
	if (suggestionCode !== undefined) {
		if (typeof suggestionCode !== "string") {
			throw new Error("submit_review suggestionCode must be a string when provided");
		}
		if (suggestionCode.length > MAX_COMMENT_CODE_LENGTH) {
			throw new Error(`submit_review suggestionCode exceeds ${MAX_COMMENT_CODE_LENGTH} characters`);
		}
	}
	if (!isFindingCategory(value.category)) throw new Error("submit_review category is invalid");
	if (!isFindingSeverity(value.severity)) throw new Error("submit_review severity is invalid");

	const result: CandidateFinding = {
		content,
		existingCode,
		category: value.category,
		severity: value.severity,
	};
	if (suggestionCode !== undefined) result.suggestionCode = suggestionCode;
	return result;
}

function parseSubmittedReview(value: unknown): {
	state: "DONE" | "FAILED";
	comments: CandidateFinding[];
} {
	if (!isRecord(value)) throw new Error("submit_review expects an object");
	if (Object.keys(value).some((key) => key !== "state" && key !== "comments")) {
		throw new Error("submit_review accepts only state and comments");
	}
	if (value.state !== "DONE" && value.state !== "FAILED") {
		throw new Error("submit_review.state must be DONE or FAILED");
	}
	if (!Array.isArray(value.comments) || value.comments.length > MAX_CANDIDATES_PER_REVIEW) {
		throw new Error(`submit_review.comments must contain at most ${MAX_CANDIDATES_PER_REVIEW} findings`);
	}
	if (value.state === "FAILED" && value.comments.length > 0) {
		throw new Error("submit_review FAILED cannot include findings");
	}
	return { state: value.state, comments: value.comments.map(validateCandidate) };
}

function validateMaxToolCalls(options: ReviewToolkitOptions | undefined): number {
	const value = options?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error("maxToolCalls must be a positive safe integer");
	}
	return value;
}

function beginCall(
	state: MutableToolkitState,
	signal: AbortSignal | undefined,
	terminating = false,
): void {
	throwIfAborted(signal);
	if (state.completion !== "pending") {
		throw new Error(`Review task already terminated with ${state.completion}`);
	}
	// Reserve the final slot for the terminating submit_review call. The
	// configured maxToolCalls is the total budget; exploration may use at most
	// maxToolCalls - 1 so that the runner's maxToolStarts cap is not exceeded.
	if (!terminating && state.calls >= state.maxToolCalls - 1) {
		throw new Error(
			`Exploration budget exhausted (${state.calls} of ${state.maxToolCalls} used); only submit_review remains.`,
		);
	}
	state.calls += 1;
}

async function withCallBudget<T>(
	state: MutableToolkitState,
	signal: AbortSignal | undefined,
	operation: () => Promise<T>,
	terminating = false,
): Promise<T> {
	beginCall(state, signal, terminating);
	throwIfAborted(signal);
	return operation();
}

function matchesGlob(path: string, pattern: string): boolean {
	const options = { dot: true, nocase: false };
	if (minimatch(path, pattern, options)) return true;
	if (!pattern.includes("/")) {
		const basename = path.slice(path.lastIndexOf("/") + 1);
		return minimatch(basename, pattern, options);
	}
	return false;
}

function matchesFindPattern(path: string, pattern: string): boolean {
	if (matchesGlob(path, pattern)) return true;
	if (/[\\*?\[\]{}!]/.test(pattern)) return false;
	const basename = path.slice(path.lastIndexOf("/") + 1);
	return basename.toLowerCase().includes(pattern.toLowerCase());
}

function findChangedFile(
	changedFiles: readonly KnownChangedFile[],
	rawPath: string,
): { path: string; file: ChangedFile } {
	const path = normalizeRequestedPath(rawPath);
	const match = changedFiles.find((candidate) => candidate.paths.has(path));
	if (match === undefined) {
		throw new Error(`file_read_diff only accepts a known changed file: ${path}`);
	}
	return { path, file: match.file };
}

function makeFileReadTool(target: ReviewTarget, state: MutableToolkitState): ToolDefinition {
	return defineTool({
		name: "file_read",
		label: "file_read",
		description: `Read up to ${MAX_FILE_READ_LINES} numbered lines from a repository-relative target tree (live in workspace mode).`,
		promptSnippet: `Read bounded target file lines (maximum ${MAX_FILE_READ_LINES})`,
		parameters: fileReadParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params: FileReadParameters, signal) {
			return withCallBudget(state, signal, async () => {
				throwIfAborted(signal);
				const path = normalizeRequestedPath(params.path);
				const offset = params.offset ?? 1;
				const limit = params.limit ?? MAX_FILE_READ_LINES;
				if (!Number.isSafeInteger(offset) || offset < 1) {
					throw new Error("file_read.offset must be a positive safe integer");
				}
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILE_READ_LINES) {
					throw new Error(`file_read.limit must be between 1 and ${MAX_FILE_READ_LINES}`);
				}

				const content = await readTargetFile(target, path, signal);
				const lines = splitLines(content);
				if (lines.length > 0 && offset > lines.length) {
					throw new Error(`file_read.offset ${offset} is beyond the end of ${path} (${lines.length} lines)`);
				}
				if (lines.length === 0 && offset > 1) {
					throw new Error(`file_read.offset ${offset} is beyond the end of empty file ${path}`);
				}

				const start = Math.max(0, offset - 1);
				const selected = lines.slice(start, start + limit);
				const numbered = selected.map((line, index) => `${start + index + 1}|${line}`).join("\n");
				const notices: string[] = [];
				if (start + selected.length < lines.length) {
					notices.push(`more lines are available; continue at offset ${start + selected.length + 1}`);
				}
				const outputWasLarge = byteLength(numbered) > MAX_READ_OUTPUT_BYTES;
				if (outputWasLarge) notices.push(`output capped at ${MAX_READ_OUTPUT_BYTES} bytes`);
				const text = appendNotices(numbered, notices, MAX_READ_OUTPUT_BYTES);
				return {
					content: [{ type: "text", text }],
					details: {
						path,
						startLine: selected.length > 0 ? start + 1 : offset,
						endLine: selected.length > 0 ? start + selected.length : start,
						totalLines: lines.length,
						truncated: notices.length > 0,
					} satisfies FileReadDetails,
				};
			});
		},
	});
}

function makeCodeSearchTool(target: ReviewTarget, state: MutableToolkitState): ToolDefinition {
	return defineTool({
		name: "code_search",
		label: "code_search",
		description: `Search target tree text literally (live in workspace mode), returning at most ${MAX_SEARCH_RESULTS} bounded results. Oversized and binary files are skipped.`,
		promptSnippet: `Search target files for literal text (maximum ${MAX_SEARCH_RESULTS} results)`,
		parameters: codeSearchParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params: CodeSearchParameters, signal) {
			return withCallBudget(state, signal, async () => {
				throwIfAborted(signal);
				if (typeof params.pattern !== "string" || params.pattern.length === 0) {
					throw new Error("code_search.pattern must be non-empty");
				}
				if (params.pattern.length > MAX_SEARCH_PATTERN_LENGTH || params.pattern.includes("\0")) {
					throw new Error(`code_search.pattern is invalid or exceeds ${MAX_SEARCH_PATTERN_LENGTH} characters`);
				}
				const scope = normalizeScopePath(params.path);
				const files = filesInScope(await listTargetFiles(target, signal), scope);
				const outputLines: string[] = [];
				let outputBytes = 0;
				let resultLimitReached = false;
				let skippedLargeFiles = 0;
				let skippedBinaryFiles = 0;
				let truncatedLines = false;
				let truncatedOutput = false;
				let scanCapped = false;
				let scannedFiles = 0;
				let scannedBytes = 0;

				outer: for (const path of files) {
					throwIfAborted(signal);
					if (scannedFiles >= MAX_SCAN_FILES || scannedBytes >= MAX_SCAN_BYTES) {
						scanCapped = true;
						break;
					}
					const content = await readTargetFile(target, path, signal);
					const contentBytes = byteLength(content);
					scannedFiles += 1;
					scannedBytes += contentBytes;
					if (contentBytes > MAX_SEARCH_FILE_BYTES) {
						skippedLargeFiles += 1;
						if (scannedFiles >= MAX_SCAN_FILES || scannedBytes >= MAX_SCAN_BYTES) {
							scanCapped = true;
							break;
						}
						continue;
					}
					if (content.includes("\0")) {
						skippedBinaryFiles += 1;
						if (scannedFiles >= MAX_SCAN_FILES || scannedBytes >= MAX_SCAN_BYTES) {
							scanCapped = true;
							break;
						}
						continue;
					}
					const lines = splitLines(content);
					for (let index = 0; index < lines.length; index += 1) {
						if (index % 64 === 0) throwIfAborted(signal);
						const line = lines[index] ?? "";
						if (!line.includes(params.pattern)) continue;
						if (outputLines.length >= MAX_SEARCH_RESULTS) {
							resultLimitReached = true;
							break outer;
						}

						let displayLine = line;
						if (byteLength(displayLine) > MAX_SEARCH_LINE_BYTES) {
							displayLine = `${truncateUtf8(displayLine, MAX_SEARCH_LINE_BYTES)}…`;
							truncatedLines = true;
						}
						const result = `${path}:${index + 1}: ${displayLine}`;
						const resultBytes = byteLength(result);
						const separatorBytes = outputLines.length === 0 ? 0 : 1;
						if (outputBytes + separatorBytes + resultBytes > MAX_SEARCH_OUTPUT_BYTES) {
							truncatedOutput = true;
							break outer;
						}
						outputLines.push(result);
						outputBytes += separatorBytes + resultBytes;
						if (outputLines.length === MAX_SEARCH_RESULTS) {
							resultLimitReached = true;
							break outer;
						}
					}
					if (scannedFiles >= MAX_SCAN_FILES || scannedBytes >= MAX_SCAN_BYTES) {
						scanCapped = true;
						break;
					}
				}

				const notices: string[] = [];
				if (resultLimitReached) notices.push(`${MAX_SEARCH_RESULTS} result limit reached`);
				if (skippedLargeFiles > 0) notices.push(`${skippedLargeFiles} oversized file(s) skipped`);
				if (skippedBinaryFiles > 0) notices.push(`${skippedBinaryFiles} binary file(s) skipped`);
				if (truncatedLines) notices.push(`long matching lines capped at ${MAX_SEARCH_LINE_BYTES} bytes`);
				if (truncatedOutput) notices.push(`output capped at ${MAX_SEARCH_OUTPUT_BYTES} bytes`);
				if (scanCapped) notices.push(`scan capped: ${scannedFiles} files / ${scannedBytes} bytes`);
				const base = outputLines.length > 0 ? outputLines.join("\n") : "No literal matches found.";
				const text = appendNotices(base, notices, MAX_SEARCH_OUTPUT_BYTES);
				return {
					content: [{ type: "text", text }],
					details: {
						pattern: params.pattern,
						matchCount: outputLines.length,
						resultLimitReached,
						skippedLargeFiles,
						skippedBinaryFiles,
						truncatedLines,
						truncatedOutput,
						scanCapped,
					} satisfies CodeSearchDetails,
				};
			});
		},
	});
}

function makeFileFindTool(target: ReviewTarget, state: MutableToolkitState): ToolDefinition {
	return defineTool({
		name: "file_find",
		label: "file_find",
		description: `Find target tree paths by glob (live in workspace mode), returning at most ${MAX_FIND_RESULTS} safe repository-relative results.`,
		promptSnippet: `Find target files by glob (maximum ${MAX_FIND_RESULTS} results)`,
		parameters: fileFindParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params: FileFindParameters, signal) {
			return withCallBudget(state, signal, async () => {
				throwIfAborted(signal);
				if (typeof params.pattern !== "string" || params.pattern.length === 0) {
					throw new Error("file_find.pattern must be non-empty");
				}
				if (params.pattern.length > MAX_FIND_PATTERN_LENGTH || params.pattern.includes("\0")) {
					throw new Error(`file_find.pattern is invalid or exceeds ${MAX_FIND_PATTERN_LENGTH} characters`);
				}
				const scope = normalizeScopePath(params.path);
				const files = filesInScope(await listTargetFiles(target, signal), scope);
				const matches: string[] = [];
				let resultLimitReached = false;
				for (const path of files) {
					throwIfAborted(signal);
					const relativePath =
						scope === undefined
							? path
							: path === scope
								? path
								: path.slice(scope.length + 1);
					if (!matchesFindPattern(relativePath, params.pattern) && !matchesFindPattern(path, params.pattern)) continue;
					matches.push(path);
					if (matches.length === MAX_FIND_RESULTS) {
						resultLimitReached = true;
						break;
					}
				}

				const rawOutput = matches.length > 0 ? matches.join("\n") : "No files found.";
				const truncatedOutput = byteLength(rawOutput) > MAX_SEARCH_OUTPUT_BYTES;
				const notices: string[] = [];
				if (resultLimitReached) notices.push(`${MAX_FIND_RESULTS} result limit reached`);
				if (truncatedOutput) notices.push(`output capped at ${MAX_SEARCH_OUTPUT_BYTES} bytes`);
				const text = appendNotices(rawOutput, notices, MAX_SEARCH_OUTPUT_BYTES);
				return {
					content: [{ type: "text", text }],
					details: {
						pattern: params.pattern,
						resultCount: matches.length,
						resultLimitReached,
						truncatedOutput,
					} satisfies FileFindDetails,
				};
			});
		},
	});
}

function makeFileReadDiffTool(
	state: MutableToolkitState,
	changedFiles: readonly KnownChangedFile[],
): ToolDefinition {
	return defineTool({
		name: "file_read_diff",
		label: "file_read_diff",
		description: `Read the capped unified diff for a known changed file only (maximum ${MAX_DIFF_OUTPUT_BYTES} bytes).`,
		promptSnippet: "Read the diff for a known changed file",
		parameters: fileReadDiffParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params: FileReadDiffParameters, signal) {
			return withCallBudget(state, signal, async () => {
				throwIfAborted(signal);
				const { path, file } = findChangedFile(changedFiles, params.path);
				if (typeof file.rawDiff !== "string") throw new Error(`Changed file has no usable diff: ${path}`);
				const notices: string[] = [];
				if (byteLength(file.rawDiff) > MAX_DIFF_OUTPUT_BYTES) {
					notices.push(`diff capped at ${MAX_DIFF_OUTPUT_BYTES} bytes`);
				}
				const text = appendNotices(file.rawDiff, notices, MAX_DIFF_OUTPUT_BYTES);
				return {
					content: [{ type: "text", text }],
					details: { path, truncated: notices.length > 0 } satisfies FileReadDiffDetails,
				};
			});
		},
	});
}

function makeSubmitReviewTool(state: MutableToolkitState): ToolDefinition {
	return defineTool({
		name: "submit_review",
		label: "submit_review",
		description:
			"Atomically submit all confirmed findings for the current file and terminate. The current path is fixed and must not be supplied.",
		promptSnippet: "Submit the final structured review and terminate",
		promptGuidelines: [
			"Call submit_review exactly once as the final action.",
			"Use DONE with all confirmed findings, including an empty comments array when clean.",
			"Use FAILED with an empty comments array only when the file could not be reviewed.",
		],
		parameters: submitReviewParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params: SubmitReviewParameters, signal) {
			return withCallBudget(state, signal, async () => {
				throwIfAborted(signal);
				const submission = parseSubmittedReview(params);
				state.candidates = submission.comments;
				state.completion = submission.state;
				return {
					content: [{ type: "text", text: `Review ${submission.state} with ${submission.comments.length} finding(s).` }],
					details: {
						state: submission.state,
						recorded: submission.comments.length,
					} satisfies SubmitReviewDetails,
					terminate: true,
				};
			}, true);
		},
	});
}

export function createReviewToolkit(
	target: ReviewTarget,
	currentPath: string,
	options?: ReviewToolkitOptions,
): ReviewToolkit {
	const maxToolCalls = validateMaxToolCalls(options);
	const changedFiles = knownChangedFiles(target);
	const safeCurrentPath = normalizeRequestedPath(currentPath, "current file path");
	if (!changedFiles.some((candidate) => candidate.paths.has(safeCurrentPath))) {
		throw new Error(`Current file is not a known changed file: ${safeCurrentPath}`);
	}

	const state: MutableToolkitState = {
		calls: 0,
		completion: "pending",
		candidates: [],
		maxToolCalls,
	};
	const tools: ToolDefinition[] = [
		makeFileReadTool(target, state),
		makeCodeSearchTool(target, state),
		makeFileFindTool(target, state),
		makeFileReadDiffTool(state, changedFiles),
		makeSubmitReviewTool(state),
	];

	return {
		tools,
		get candidates() {
			return state.candidates.slice();
		},
		get completion() {
			return state.completion;
		},
		get completed() {
			return state.completion !== "pending";
		},
		get toolCallCount() {
			return state.calls;
		},
		maxToolCalls,
	};
}

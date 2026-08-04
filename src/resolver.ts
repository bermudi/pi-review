import type {
	CandidateFinding,
	ChangedFile,
	DiffHunk,
	Finding,
} from "./types.js";

/** The only location a candidate finding is allowed to acquire from a diff. */
export interface FindingAnchor {
	startLine: number;
	endLine: number;
}

interface IndexedLine {
	lineNumber: number;
	content: string;
}

interface ParsedDiffLines {
	lines: IndexedLine[];
	addedLines: Set<number>;
}

interface TargetVariant {
	lines: IndexedLine[];
	allowBlankGaps: boolean;
}

interface TargetSnapshot {
	variants: TargetVariant[];
	addedLines: Set<number>;
}

const DEV_NULL = "/dev/null";

/**
 * Resolve a candidate's existing-code snippet to a target-side line range.
 *
 * The overload accepting the candidate first is useful at call sites that
 * already have a finding in hand. Both forms deliberately return a complete
 * Finding: the separate `resolveFindingAnchor` function is the smaller seam
 * for callers that only need a location.
 */
export function resolveFinding(
	file: ChangedFile,
	candidate: CandidateFinding,
): Finding | undefined;
export function resolveFinding(
	candidate: CandidateFinding,
	file: ChangedFile,
): Finding | undefined;
export function resolveFinding(
	first: ChangedFile | CandidateFinding,
	second: ChangedFile | CandidateFinding,
): Finding | undefined {
	let file: ChangedFile;
	let candidate: CandidateFinding;
	if (isChangedFile(first) && isCandidateFinding(second)) {
		file = first;
		candidate = second;
	} else if (isCandidateFinding(first) && isChangedFile(second)) {
		file = second;
		candidate = first;
	} else {
		return undefined;
	}

	const anchor = resolveFindingAnchor(file, candidate);
	if (anchor === undefined) {
		return undefined;
	}

	return {
		...candidate,
		path: effectivePath(file),
		startLine: anchor.startLine,
		endLine: anchor.endLine,
	};
}

/** Resolve a candidate finding and return only its target-side line range. */
export function resolveFindingAnchor(
	file: ChangedFile,
	candidate: Pick<CandidateFinding, "existingCode">,
): FindingAnchor | undefined;
export function resolveFindingAnchor(
	candidate: Pick<CandidateFinding, "existingCode">,
	file: ChangedFile,
): FindingAnchor | undefined;
export function resolveFindingAnchor(
	first: ChangedFile | Pick<CandidateFinding, "existingCode">,
	second: ChangedFile | Pick<CandidateFinding, "existingCode">,
): FindingAnchor | undefined {
	let file: ChangedFile;
	let candidate: Pick<CandidateFinding, "existingCode">;
	if (isChangedFile(first) && isCandidateSnippet(second)) {
		file = first;
		candidate = second;
	} else if (isCandidateSnippet(first) && isChangedFile(second)) {
		file = second;
		candidate = first;
	} else {
		return undefined;
	}

	const snapshot = buildTargetSnapshot(file);
	if (snapshot.addedLines.size === 0 || snapshot.variants.length === 0) {
		return undefined;
	}

	const patterns = normalizeCandidateCode(candidate.existingCode);
	if (patterns.length === 0) {
		return undefined;
	}

	// Plain text is preferred over a diff-marked interpretation. The latter is
	// a fallback for models that copy `+`/`-` prefixes from a patch. Searching
	// every occurrence before returning is important: the first duplicate may
	// be context while a later duplicate is the actual addition.
	for (const variant of snapshot.variants) {
		for (const pattern of patterns) {
			const comparablePattern = variant.allowBlankGaps
				? trimBlankPattern(pattern)
				: pattern;
			const match = findAddedMatch(
				variant.lines,
				comparablePattern,
				snapshot.addedLines,
				variant.allowBlankGaps,
			);
			if (match !== undefined) {
				return match;
			}
		}
	}

	return undefined;
}

/** Alias with an explicit name for orchestration code. */
export const resolveCandidateFinding = resolveFinding;

/** Return the target path used when constructing a resolved finding. */
export function effectivePath(file: Pick<ChangedFile, "oldPath" | "newPath">): string {
	if (file.newPath !== "" && file.newPath !== DEV_NULL) {
		return file.newPath;
	}
	return file.oldPath;
}

function isChangedFile(value: unknown): value is ChangedFile {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	return "newPath" in value && "rawDiff" in value && "hunks" in value;
}

function isCandidateSnippet(value: unknown): value is Pick<CandidateFinding, "existingCode"> {
	return (
		typeof value === "object" &&
		value !== null &&
		"existingCode" in value &&
		typeof value.existingCode === "string"
	);
}

function isCandidateFinding(value: unknown): value is CandidateFinding {
	return (
		isCandidateSnippet(value) &&
		"content" in value &&
		typeof value.content === "string" &&
		"category" in value &&
		typeof value.category === "string" &&
		"severity" in value &&
		typeof value.severity === "string"
	);
}

function buildTargetSnapshot(file: ChangedFile): TargetSnapshot {
	if (file.isBinary || file.isDeleted) {
		return { variants: [], addedLines: new Set<number>() };
	}

	const addedLines = new Set<number>();
	let hunkLines: IndexedLine[] = [];
	let markedHunkLines: IndexedLine[] = [];

	if (file.hunks.length > 0) {
		hunkLines = buildHunkLines(file.hunks, false, addedLines);
		markedHunkLines = buildHunkLines(file.hunks, true, addedLines);
	}

	// A malformed or hand-built ChangedFile may have hunks omitted. The raw
	// unified diff is a safe fallback, and also supplies addition coordinates if
	// a caller populated only the target snapshot.
	const raw = parseRawDiff(file.rawDiff);
	for (const line of raw.addedLines) {
		addedLines.add(line);
	}

	if (file.newContent !== undefined) {
		const fullLines = contentLines(file.newContent);
		const variants: TargetVariant[] = [{ lines: fullLines, allowBlankGaps: false }];
		const nonBlankLines = fullLines.filter((line) => line.content !== "");
		if (!sameLines(fullLines, nonBlankLines)) {
			// Some model snippets omit blank lines while still identifying a
			// contiguous source region. Keep the physical line numbers so the
			// returned range remains honest.
			variants.push({ lines: nonBlankLines, allowBlankGaps: true });
		}
		return { variants, addedLines };
	}

	const variants: TargetVariant[] = [];
	if (hunkLines.length > 0) {
		variants.push({ lines: hunkLines, allowBlankGaps: false });
		if (!sameLines(hunkLines, markedHunkLines)) {
			variants.push({ lines: markedHunkLines, allowBlankGaps: false });
		}
	} else if (raw.lines.length > 0) {
		variants.push({ lines: raw.lines, allowBlankGaps: false });
	}

	return { variants, addedLines };
}

function contentLines(content: string): IndexedLine[] {
	const normalized = normalizeNewlines(content);
	if (normalized === "") {
		return [];
	}

	const lines = normalized.split("\n");
	// A terminal newline terminates the preceding line; it does not create a
	// second, reportable line in a Git target snapshot.
	if (lines.at(-1) === "") {
		lines.pop();
	}

	return lines.map((line, index) => ({
		lineNumber: index + 1,
		content: normalizeLine(line),
	}));
}

function buildHunkLines(
	hunks: readonly DiffHunk[],
	stripMarkers: boolean,
	addedLines: Set<number>,
): IndexedLine[] {
	const byLine = new Map<number, string>();

	for (const hunk of hunks) {
		let nextNewLine = hunk.newStart;

		for (const line of hunk.lines) {
			if (line.kind === "deletion") {
				continue;
			}

			const lineNumber = positiveLine(line.newLine) ? line.newLine : nextNewLine;
			if (positiveLine(lineNumber)) {
				if (!byLine.has(lineNumber)) {
					byLine.set(
						lineNumber,
						normalizeLine(
							stripMarkers
								? stripHunkMarker(line.text, line.kind)
								: line.text,
						),
					);
				}
				if (line.kind === "addition") {
					addedLines.add(lineNumber);
				}
			}

			nextNewLine = positiveLine(lineNumber) ? lineNumber + 1 : nextNewLine + 1;
		}
	}

	return [...byLine.entries()]
		.sort(([left], [right]) => left - right)
		.map(([lineNumber, content]) => ({ lineNumber, content }));
}

function stripHunkMarker(
	text: string,
	kind: "context" | "addition" | "deletion",
): string {
	const normalized = normalizeNewlines(text);
	if (kind === "addition" && normalized.startsWith("+")) {
		return normalized.slice(1);
	}
	if (kind === "deletion" && normalized.startsWith("-")) {
		return normalized.slice(1);
	}
	if (kind === "context" && normalized.startsWith(" ")) {
		return normalized.slice(1);
	}
	return normalized;
}

function parseRawDiff(rawDiff: string): ParsedDiffLines {
	const linesByNumber = new Map<number, string>();
	const addedLines = new Set<number>();
	let nextNewLine: number | undefined;

	for (const rawLine of normalizeNewlines(rawDiff).split("\n")) {
		const hunk = parseHunkHeader(rawLine);
		if (hunk !== undefined) {
			nextNewLine = hunk.newStart;
			continue;
		}

		if (rawLine.startsWith("diff --git ")) {
			nextNewLine = undefined;
			continue;
		}
		if (nextNewLine === undefined || rawLine.startsWith("\\")) {
			continue;
		}

		const marker = rawLine[0];
		if (marker === "+" || marker === " ") {
			if (positiveLine(nextNewLine)) {
				linesByNumber.set(nextNewLine, normalizeLine(rawLine.slice(1)));
				if (marker === "+") {
					addedLines.add(nextNewLine);
				}
			}
			nextNewLine += 1;
		} else if (marker === "-") {
			// Deletions consume only the old side, so the target line cursor does
			// not move.
			continue;
		}
	}

	return {
		lines: [...linesByNumber.entries()]
			.sort(([left], [right]) => left - right)
			.map(([lineNumber, content]) => ({ lineNumber, content })),
		addedLines,
	};
}

function parseHunkHeader(
	line: string,
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | undefined {
	const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
	if (match === null) {
		return undefined;
	}

	const oldStart = Number(match[1]);
	const oldCount = Number(match[2] ?? "1");
	const newStart = Number(match[3]);
	const newCount = Number(match[4] ?? "1");
	if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) {
		return undefined;
	}

	return { oldStart, oldCount, newStart, newCount };
}

function normalizeCandidateCode(code: string): string[][] {
	const lines = trimOuterBlankLines(
		normalizeNewlines(code).split("\n").map((line) => normalizeLine(line)),
	);
	if (lines.length === 0 || lines.every((line) => line === "")) {
		return [];
	}

	const plain = lines;
	const marked = lines.map(stripCandidateMarker);
	if (sameStringLines(plain, marked)) {
		return [plain];
	}
	return [plain, marked];
}

function stripCandidateMarker(line: string): string {
	if (line.startsWith("+") || line.startsWith("-")) {
		return normalizeLine(line.slice(1));
	}
	return line;
}

function trimOuterBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start] === "") {
		start += 1;
	}
	while (end > start && lines[end - 1] === "") {
		end -= 1;
	}
	return lines.slice(start, end);
}

function trimBlankPattern(pattern: readonly string[]): string[] {
	return pattern.filter((line) => line !== "");
}

function findAddedMatch(
	lines: readonly IndexedLine[],
	pattern: readonly string[],
	addedLines: ReadonlySet<number>,
	allowBlankGaps: boolean,
): FindingAnchor | undefined {
	if (pattern.length === 0 || lines.length < pattern.length) {
		return undefined;
	}

	for (let start = 0; start <= lines.length - pattern.length; start += 1) {
		const first = lines[start];
		if (first === undefined) {
			continue;
		}

		let matches = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			const actual = lines[start + offset];
			if (
				actual === undefined ||
				(!allowBlankGaps && actual.lineNumber !== first.lineNumber + offset) ||
				actual.content !== pattern[offset]
			) {
				matches = false;
				break;
			}
		}
		if (!matches) {
			continue;
		}

		const last = lines[start + pattern.length - 1];
		if (last === undefined) {
			continue;
		}
		const endLine = last.lineNumber;
		if (rangeIntersectsAddedLine(first.lineNumber, endLine, addedLines)) {
			return { startLine: first.lineNumber, endLine };
		}
	}

	return undefined;
}

function rangeIntersectsAddedLine(
	startLine: number,
	endLine: number,
	addedLines: ReadonlySet<number>,
): boolean {
	for (let line = startLine; line <= endLine; line += 1) {
		if (addedLines.has(line)) {
			return true;
		}
	}
	return false;
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

/** Trim edges and collapse horizontal whitespace without erasing line breaks. */
function normalizeLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function positiveLine(value: number | undefined): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function sameLines(left: readonly IndexedLine[], right: readonly IndexedLine[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every(
		(line, index) =>
			line.lineNumber === right[index]?.lineNumber &&
			line.content === right[index]?.content,
	);
}

function sameStringLines(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

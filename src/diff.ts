import type { ChangedFile, DiffHunk, DiffLine } from "./types.js";

const NULL_PATH = "/dev/null";

export class DiffParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DiffParseError";
	}
}

interface DiffRecord {
	content: string;
	start: number;
	end: number;
}

interface ParsedToken {
	value: string;
	end: number;
}

function splitRecords(input: string): DiffRecord[] {
	const records: DiffRecord[] = [];
	let start = 0;
	const firstNewline = input.indexOf("\n");
	const usesCrLf = firstNewline > 0 && input[firstNewline - 1] === "\r";

	while (start < input.length) {
		const newline = input.indexOf("\n", start);
		if (newline === -1) {
			records.push({ content: input.slice(start), start, end: input.length });
			break;
		}

		const end = newline + 1;
		const rawContent = input.slice(start, newline);
		records.push({
			content: usesCrLf && rawContent.endsWith("\r") ? rawContent.slice(0, -1) : rawContent,
			start,
			end,
		});
		start = end;
	}

	return records;
}

function parseQuotedToken(input: string, start: number): ParsedToken {
	if (input[start] !== '"') {
		throw new DiffParseError("Expected a quoted Git path");
	}

	const bytes: number[] = [];
	const appendText = (text: string): void => {
		for (const byte of new TextEncoder().encode(text)) bytes.push(byte);
	};
	let index = start + 1;
	while (index < input.length) {
		const character = input[index] ?? "";
		if (character === '"') {
			return { value: new TextDecoder("utf-8").decode(new Uint8Array(bytes)), end: index + 1 };
		}
		if (character !== "\\") {
			appendText(character);
			index += 1;
			continue;
		}

		index += 1;
		if (index >= input.length) {
			throw new DiffParseError("Unterminated escape in quoted Git path");
		}

		const escape = input[index] ?? "";
		switch (escape) {
			case "a":
				bytes.push(0x07);
				index += 1;
				break;
			case "b":
				bytes.push(0x08);
				index += 1;
				break;
			case "t":
				bytes.push(0x09);
				index += 1;
				break;
			case "n":
				bytes.push(0x0a);
				index += 1;
				break;
			case "v":
				bytes.push(0x0b);
				index += 1;
				break;
			case "f":
				bytes.push(0x0c);
				index += 1;
				break;
			case "r":
				bytes.push(0x0d);
				index += 1;
				break;
			case "e":
				bytes.push(0x1b);
				index += 1;
				break;
			case "\\":
				bytes.push(0x5c);
				index += 1;
				break;
			case '"':
				bytes.push(0x22);
				index += 1;
				break;
			case "?":
				bytes.push(0x3f);
				index += 1;
				break;
			case "x": {
				const hex = input.slice(index + 1, index + 3);
				if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
					throw new DiffParseError("Invalid hexadecimal escape in quoted Git path");
				}
				bytes.push(Number.parseInt(hex, 16));
				index += 3;
				break;
			}
			default: {
				if (!/[0-7]/.test(escape)) {
					throw new DiffParseError(`Unknown escape sequence \\${escape} in quoted Git path`);
				}
				let octal = escape;
				index += 1;
				while (octal.length < 3 && index < input.length) {
					const next = input[index] ?? "";
					if (!/[0-7]/.test(next)) break;
					octal += next;
					index += 1;
				}
				bytes.push(Number.parseInt(octal, 8));
				break;
			}
		}
	}

	throw new DiffParseError("Unterminated quoted Git path");
}

function tokenizeGitHeader(input: string): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < input.length) {
		while (index < input.length && /\s/.test(input[index] ?? "")) {
			index += 1;
		}
		if (index >= input.length) break;

		if (input[index] === '"') {
			const parsed = parseQuotedToken(input, index);
			tokens.push(parsed.value);
			index = parsed.end;
			continue;
		}

		const start = index;
		while (index < input.length && !/\s/.test(input[index] ?? "")) {
			index += 1;
		}
		tokens.push(input.slice(start, index));
	}
	return tokens;
}

function decodePathValue(value: string): string {
	if (value.startsWith('"')) {
		const parsed = parseQuotedToken(value, 0);
		if (value.slice(parsed.end).trim() !== "") {
			throw new DiffParseError(`Unexpected data after quoted path ${JSON.stringify(value)}`);
		}
		return parsed.value;
	}
	return value;
}

function validateRelativePath(path: string): string {
	if (path.length === 0) {
		throw new DiffParseError("Git diff contains an empty path");
	}
	if (path.includes("\0")) {
		throw new DiffParseError("Git diff contains a NUL in a path");
	}
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
		throw new DiffParseError(`Git diff contains an absolute path: ${JSON.stringify(path)}`);
	}
	if (path.includes("\\")) {
		throw new DiffParseError(`Git diff contains a backslash path: ${JSON.stringify(path)}`);
	}

	const segments = path.split("/");
	if (
		segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
		segments.includes(".git")
	) {
		throw new DiffParseError(`Git diff contains an unsafe path: ${JSON.stringify(path)}`);
	}
	return path;
}

function stripDiffPrefix(value: string, expectedPrefix: "a" | "b" | undefined): string {
	if (value === NULL_PATH) return value;
	if (expectedPrefix !== undefined && value.startsWith(`${expectedPrefix}/`)) {
		return value.slice(2);
	}
	if (expectedPrefix === undefined && (value.startsWith("a/") || value.startsWith("b/"))) {
		return value.slice(2);
	}
	return value;
}

function parseFileHeaderPath(line: string, marker: "---" | "+++"): string {
	const prefix = `${marker} `;
	if (!line.startsWith(prefix)) {
		throw new DiffParseError(`Expected a ${marker} file header`);
	}
	const value = line.slice(prefix.length);
	if (value.startsWith('"')) {
		return decodePathValue(value);
	}
	const timestampSeparator = value.indexOf("\t");
	return timestampSeparator === -1 ? value : value.slice(0, timestampSeparator);
}

function parseRenamePath(line: string, marker: "rename from" | "rename to"): string {
	const prefix = `${marker} `;
	if (!line.startsWith(prefix)) {
		throw new DiffParseError(`Expected a ${marker} header`);
	}
	return decodePathValue(line.slice(prefix.length));
}

function parseDiffHeaderPaths(line: string): [string, string] | undefined {
	const header = "diff --git ";
	if (!line.startsWith(header)) return undefined;
	const tokens = tokenizeGitHeader(line.slice(header.length));
	if (tokens.length === 2) {
		return [tokens[0] ?? "", tokens[1] ?? ""];
	}

	// Git leaves ordinary spaces unquoted in this header.  This makes the
	// header ambiguous for filenames containing spaces, so only use a
	// conservative boundary-based fallback; file headers are preferred below.
	const rest = line.slice(header.length);
	const boundary = rest.indexOf(" b/");
	if (rest.startsWith("a/") && boundary > 0) {
		return [rest.slice(0, boundary), rest.slice(boundary + 1)];
	}
	return undefined;
}

function parseHunkHeader(line: string): DiffHunk | undefined {
	const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
	if (!match) return undefined;

	const oldStart = Number.parseInt(match[1] ?? "", 10);
	const oldCount = Number.parseInt(match[2] ?? "1", 10);
	const newStart = Number.parseInt(match[3] ?? "", 10);
	const newCount = Number.parseInt(match[4] ?? "1", 10);
	if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) {
		throw new DiffParseError(`Hunk coordinates exceed the safe integer range: ${line}`);
	}
	return { oldStart, oldCount, newStart, newCount, lines: [] };
}

function parseSection(input: string, records: DiffRecord[]): ChangedFile {
	const first = records[0];
	if (first === undefined) {
		throw new DiffParseError("Cannot parse an empty diff section");
	}

	let headerPaths: [string, string] | undefined;
	let oldHeaderPath: string | undefined;
	let newHeaderPath: string | undefined;
	let renameFrom: string | undefined;
	let renameTo: string | undefined;
	let sawNewFileMode = false;
	let sawDeletedFileMode = false;
	let isBinary = false;
	const hunks: DiffHunk[] = [];
	let currentHunk: DiffHunk | undefined;
	let oldCursor = 0;
	let newCursor = 0;
	let sawHunk = false;

	for (let index = 0; index < records.length; index += 1) {
		const line = records[index]?.content ?? "";
		if (index === 0) {
			headerPaths = parseDiffHeaderPaths(line);
			continue;
		}

		if (line === "new file mode 100644" || line === "new file mode 100755") {
			sawNewFileMode = true;
			continue;
		}
		if (line.startsWith("new file mode ")) {
			sawNewFileMode = true;
			continue;
		}
		if (line.startsWith("deleted file mode ")) {
			sawDeletedFileMode = true;
			continue;
		}
		if (line.startsWith("rename from ")) {
			renameFrom = parseRenamePath(line, "rename from");
			continue;
		}
		if (line.startsWith("rename to ")) {
			renameTo = parseRenamePath(line, "rename to");
			continue;
		}
		if (line.startsWith("Binary files ") || line === "GIT binary patch") {
			isBinary = true;
			continue;
		}

		if (!sawHunk && line.startsWith("--- ")) {
			oldHeaderPath = parseFileHeaderPath(line, "---");
			continue;
		}
		if (!sawHunk && line.startsWith("+++ ")) {
			newHeaderPath = parseFileHeaderPath(line, "+++");
			continue;
		}

		const parsedHunk = parseHunkHeader(line);
		if (parsedHunk !== undefined) {
			sawHunk = true;
			currentHunk = parsedHunk;
			hunks.push(parsedHunk);
			oldCursor = parsedHunk.oldStart;
			newCursor = parsedHunk.newStart;
			continue;
		}

		if (currentHunk === undefined) continue;
		if (line === "\\ No newline at end of file") continue;

		const indicator = line[0];
		if (indicator === " ") {
			currentHunk.lines.push({
				kind: "context",
				text: line.slice(1),
				oldLine: oldCursor,
				newLine: newCursor,
			});
			oldCursor += 1;
			newCursor += 1;
			continue;
		}
		if (indicator === "+") {
			currentHunk.lines.push({ kind: "addition", text: line.slice(1), newLine: newCursor });
			newCursor += 1;
			continue;
		}
		if (indicator === "-") {
			currentHunk.lines.push({ kind: "deletion", text: line.slice(1), oldLine: oldCursor });
			oldCursor += 1;
			continue;
		}

		// A malformed body should not turn metadata into a fake changed line.
		// There cannot be another meaningful hunk after an invalid body line.
		currentHunk = undefined;
	}

	let oldPathRaw: string | undefined;
	let newPathRaw: string | undefined;
	if (renameFrom !== undefined || renameTo !== undefined) {
		if (renameFrom === undefined || renameTo === undefined) {
			throw new DiffParseError("Rename diff is missing one of its paths");
		}
		oldPathRaw = renameFrom;
		newPathRaw = renameTo;
	} else if (oldHeaderPath !== undefined || newHeaderPath !== undefined) {
		if (oldHeaderPath === undefined || newHeaderPath === undefined) {
			throw new DiffParseError("Unified diff is missing one of its file headers");
		}
		oldPathRaw = stripDiffPrefix(oldHeaderPath, "a");
		newPathRaw = stripDiffPrefix(newHeaderPath, "b");
	} else if (headerPaths !== undefined) {
		oldPathRaw = stripDiffPrefix(headerPaths[0], "a");
		newPathRaw = stripDiffPrefix(headerPaths[1], "b");
	}

	if (oldPathRaw === undefined || newPathRaw === undefined) {
		throw new DiffParseError("Diff section does not identify both file paths");
	}

	const isNew = sawNewFileMode || oldPathRaw === NULL_PATH;
	const isDeleted = sawDeletedFileMode || newPathRaw === NULL_PATH;
	if (isNew && isDeleted) {
		throw new DiffParseError("Diff section cannot be both new and deleted");
	}

	const oldPath = oldPathRaw === NULL_PATH ? newPathRaw : oldPathRaw;
	const newPath = newPathRaw === NULL_PATH ? oldPathRaw : newPathRaw;
	if (oldPath === NULL_PATH || newPath === NULL_PATH) {
		throw new DiffParseError("Diff section has no repository path");
	}

	const normalizedOldPath = validateRelativePath(oldPath);
	const normalizedNewPath = validateRelativePath(newPath);
	const insertions = hunks.reduce(
		(total, hunk) => total + hunk.lines.filter((line) => line.kind === "addition").length,
		0,
	);
	const deletions = hunks.reduce(
		(total, hunk) => total + hunk.lines.filter((line) => line.kind === "deletion").length,
		0,
	);

	return {
		oldPath: normalizedOldPath,
		newPath: normalizedNewPath,
		rawDiff: input.slice(first.start, records[records.length - 1]?.end ?? first.end),
		newContent: undefined,
		isBinary,
		isDeleted,
		isNew,
		isRenamed: !isNew && !isDeleted && (renameFrom !== undefined || normalizedOldPath !== normalizedNewPath),
		insertions,
		deletions,
		hunks,
	};
}

/** Parse one or more Git unified-diff sections into deterministic file records. */
export function parseUnifiedDiff(input: string): ChangedFile[] {
	if (typeof input !== "string") {
		throw new DiffParseError("Unified diff must be a string");
	}
	if (input.length === 0) return [];

	const records = splitRecords(input);
	const sectionIndexes = records
		.map((record, index) => (record.content.startsWith("diff --git ") ? index : -1))
		.filter((index) => index >= 0);

	if (sectionIndexes.length === 0) {
		// Accept a standalone unified patch as a convenience for callers and
		// tests. Git's own diff output always has a diff --git header.
		const hasFileHeader = records.some(
			(record) => record.content.startsWith("--- ") || record.content.startsWith("+++ "),
		);
		if (!hasFileHeader) return [];
		return [parseSection(input, records)];
	}

	const files: ChangedFile[] = [];
	for (let section = 0; section < sectionIndexes.length; section += 1) {
		const start = sectionIndexes[section];
		if (start === undefined) continue;
		const end = sectionIndexes[section + 1] ?? records.length;
		files.push(parseSection(input, records.slice(start, end)));
	}
	return files;
}

/** Backwards-compatible short name for callers that already have Git output. */
export const parseDiff = parseUnifiedDiff;

/** Another explicit alias used by integrations that distinguish Git diffs. */
export const parseGitDiff = parseUnifiedDiff;

function quoteGitPath(path: string): string {
	if (/^[A-Za-z0-9._+@%-]+(?:\/[A-Za-z0-9._+@%-]+)*$/.test(path)) return path;

	let quoted = '"';
	for (const character of path) {
		switch (character) {
			case "\\":
				quoted += "\\\\";
				break;
			case '"':
				quoted += '\\"';
				break;
			case "\a":
				quoted += "\\a";
				break;
			case "\b":
				quoted += "\\b";
				break;
			case "\t":
				quoted += "\\t";
				break;
			case "\n":
				quoted += "\\n";
				break;
			case "\v":
				quoted += "\\v";
				break;
			case "\f":
				quoted += "\\f";
				break;
			case "\r":
				quoted += "\\r";
				break;
			default: {
				const code = character.charCodeAt(0);
				if (code < 0x20 || code === 0x7f) {
					quoted += `\\${code.toString(8).padStart(3, "0")}`;
				} else {
					quoted += character;
				}
			}
		}
	}
	return `${quoted}"`;
}

/** Build the synthetic patch used for a safe, untracked workspace file. */
export function makeUntrackedDiff(
	path: string,
	content: string,
	options: { binary?: boolean; executable?: boolean } = {},
): string {
	const normalizedPath = validateRelativePath(path);
	const quotedOldPath = quoteGitPath(`a/${normalizedPath}`);
	const quotedNewPath = quoteGitPath(`b/${normalizedPath}`);
	const lines = [
		`diff --git ${quotedOldPath} ${quotedNewPath}`,
		`new file mode ${options.executable === true ? "100755" : "100644"}`,
		"index 0000000..0000000",
		"--- /dev/null",
		`+++ ${quotedNewPath}`,
	];

	if (options.binary === true) {
		lines.push(`Binary files /dev/null and ${quotedNewPath} differ`);
		return `${lines.join("\n")}\n`;
	}

	if (content.length > 0) {
		const contentLines = content.split("\n");
		const hasFinalNewline = content.endsWith("\n");
		if (hasFinalNewline) contentLines.pop();
		if (contentLines.length > 0) {
			lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
			for (const contentLine of contentLines) lines.push(`+${contentLine}`);
			if (!hasFinalNewline) lines.push("\\ No newline at end of file");
		}
	}

	return `${lines.join("\n")}\n`;
}

export function containsBinaryByte(bytes: Uint8Array): boolean {
	return bytes.includes(0);
}

export function decodeDiffText(bytes: Uint8Array): string {
	return new TextDecoder("utf-8").decode(bytes);
}

export function assertSafeDiffPath(path: string): string {
	return validateRelativePath(path);
}

export type { ChangedFile, DiffHunk, DiffLine };

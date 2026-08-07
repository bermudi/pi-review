import { describe, expect, test } from "bun:test";

import type { ChangedFile, ReviewMode, ReviewTarget } from "../src/types.ts";
import {
	MAX_FILE_READ_LINES,
	MAX_DIFF_OUTPUT_BYTES,
	MAX_FIND_RESULTS,
	MAX_SCAN_BYTES,
	MAX_SCAN_FILES,
	MAX_SEARCH_FILE_BYTES,
	MAX_SEARCH_RESULTS,
	createReviewToolkit,
} from "../src/tools.ts";

interface FakeTargetData {
	readonly files: Record<string, string>;
	readonly changed: ChangedFile[];
	readonly readPaths: string[];
	listCount?: number;
}

function changedFile(path: string, rawDiff = `diff for ${path}\n`): ChangedFile {
	return {
		oldPath: path,
		newPath: path,
		rawDiff,
		newContent: undefined,
		isBinary: false,
		isDeleted: false,
		isNew: false,
		isRenamed: false,
		insertions: 1,
		deletions: 0,
		hunks: [],
	};
}

function fakeTarget(data: FakeTargetData): ReviewTarget {
	const mode: ReviewMode = { kind: "workspace" };
	return {
		repositoryRoot: "/fake/repository",
		mode,
		files: data.changed,
		readFile: async (path) => {
			data.readPaths.push(path);
			const content = data.files[path];
			if (content === undefined) throw new Error(`unknown fake path: ${path}`);
			return content;
		},
		listFiles: async () => {
			data.listCount = (data.listCount ?? 0) + 1;
			return Object.keys(data.files).sort();
		},
	};
}

function tool(toolkit: ReturnType<typeof createReviewToolkit>, name: string) {
	const definition = toolkit.tools.find((candidate) => candidate.name === name);
	if (definition === undefined) throw new Error(`Missing tool ${name}`);
	return definition;
}

async function execute(
	toolkit: ReturnType<typeof createReviewToolkit>,
	name: string,
	params: unknown,
	signal?: AbortSignal,
) {
	return tool(toolkit, name).execute("test-call", params, signal, undefined, undefined as never);
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

describe("review tool kit", () => {
	test("exposes only bounded read-only tools and numbers file reads", async () => {
		const lines = Array.from({ length: MAX_FILE_READ_LINES + 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const data: FakeTargetData = {
			files: { "src/current.ts": lines, "src/other.ts": "const other = true;\n" },
			changed: [changedFile("src/current.ts")],
			readPaths: [],
		};
		const toolkit = createReviewToolkit(fakeTarget(data), "src/current.ts");

		expect(toolkit.tools.map((candidate) => candidate.name)).toEqual([
			"file_read",
			"code_search",
			"file_find",
			"file_read_diff",
			"submit_review",
		]);
		expect(toolkit.tools.some((candidate) => ["bash", "edit", "write", "shell"].includes(candidate.name))).toBe(
			false,
		);

		const result = await execute(toolkit, "file_read", {
			path: "src/current.ts",
			limit: MAX_FILE_READ_LINES,
		});
		const output = text(result);
		expect(output).toContain("1|line 1");
		expect(output).toContain(`${MAX_FILE_READ_LINES}|line ${MAX_FILE_READ_LINES}`);
		expect(output).not.toContain(`${MAX_FILE_READ_LINES + 1}|line ${MAX_FILE_READ_LINES + 1}`);
		expect(result.details).toMatchObject({
			path: "src/current.ts",
		totalLines: MAX_FILE_READ_LINES + 20,
			truncated: true,
		});
		expect(data.readPaths).toEqual(["src/current.ts"]);
	});

	test("searches literally, skips oversized files, and caps results", async () => {
		const matchingLines = Array.from({ length: MAX_SEARCH_RESULTS + 5 }, (_, index) =>
			`literal .* match ${index + 1}`,
		).join("\n");
		const data: FakeTargetData = {
			files: {
				"src/current.ts": matchingLines,
				"src/large.ts": "oversized-marker\n" + "x".repeat(MAX_SEARCH_FILE_BYTES + 1),
				"src/no-match.ts": "regular expression text only\n",
			},
			changed: [changedFile("src/current.ts")],
			readPaths: [],
		};
		const toolkit = createReviewToolkit(fakeTarget(data), "src/current.ts");

		const result = await execute(toolkit, "code_search", {
			pattern: ".*",
		});
		const output = text(result);
		expect(output).toContain("src/current.ts:1: literal .* match 1");
		expect(output).not.toContain("src/no-match.ts:");
		expect(result.details).toMatchObject({
			matchCount: MAX_SEARCH_RESULTS,
			resultLimitReached: true,
			skippedLargeFiles: 0,
		});

		const skipped = await execute(toolkit, "code_search", { pattern: "oversized-marker" });
		expect(skipped.details).toMatchObject({ matchCount: 0, skippedLargeFiles: 1 });
	});

	test("finds only target snapshot paths and reads diffs only for changed files", async () => {
		const files: Record<string, string> = { "src/current.ts": "current\n" };
		for (let index = 0; index < MAX_FIND_RESULTS + 5; index += 1) {
			files[`src/file-${index}.ts`] = "file\n";
		}
		const data: FakeTargetData = {
			files,
			changed: [changedFile("src/current.ts", "@@ diff current @@\n+current\n")],
			readPaths: [],
		};
		const toolkit = createReviewToolkit(fakeTarget(data), "src/current.ts");

		const findResult = await execute(toolkit, "file_find", { pattern: "*.ts" });
		expect(findResult.details).toMatchObject({
			resultCount: MAX_FIND_RESULTS,
			resultLimitReached: true,
		});
		expect(text(findResult).split("\n").filter((line) => line.endsWith(".ts")).length).toBe(MAX_FIND_RESULTS);

		const diffResult = await execute(toolkit, "file_read_diff", { path: "src/current.ts" });
		expect(text(diffResult)).toBe("@@ diff current @@\n+current\n");
		expect(new TextEncoder().encode(text(diffResult)).byteLength).toBeLessThanOrEqual(MAX_DIFF_OUTPUT_BYTES);

		const cappedData: FakeTargetData = {
			files: { "src/current.ts": "current\n" },
			changed: [changedFile("src/current.ts", "d".repeat(MAX_DIFF_OUTPUT_BYTES + 1))],
			readPaths: [],
		};
		const cappedToolkit = createReviewToolkit(fakeTarget(cappedData), "src/current.ts");
		const cappedDiff = await execute(cappedToolkit, "file_read_diff", { path: "src/current.ts" });
		expect(cappedDiff.details).toMatchObject({ truncated: true });
		expect(new TextEncoder().encode(text(cappedDiff)).byteLength).toBeLessThanOrEqual(MAX_DIFF_OUTPUT_BYTES);

		await expect(execute(toolkit, "file_read_diff", { path: "src/file-1.ts" })).rejects.toThrow(
			/known changed file/,
		);
		await expect(execute(toolkit, "file_find", { pattern: "*", path: "../" })).rejects.toThrow(/unsafe/i);
	});

	test("atomically captures strict candidates and terminates", async () => {
		const data: FakeTargetData = {
			files: { "src/current.ts": "return value;\n" },
			changed: [changedFile("src/current.ts")],
			readPaths: [],
		};
		const toolkit = createReviewToolkit(fakeTarget(data), "src/current.ts");
		const comments = [
			{
				content: "This can return an invalid value.",
				existingCode: "return value;",
				category: "bug" as const,
				severity: "high" as const,
			},
			{
				content: "A second confirmed issue.",
				existingCode: "return value;",
				category: "security" as const,
				severity: "medium" as const,
			},
		];

		const done = await execute(toolkit, "submit_review", { state: "DONE", comments });
		expect(done).toMatchObject({ terminate: true, details: { state: "DONE", recorded: 2 } });
		expect(toolkit.candidates).toEqual(comments);
		expect(toolkit.completion).toBe("DONE");
		expect(toolkit.completed).toBe(true);
		expect(toolkit.toolCallCount).toBe(1);
		await expect(execute(toolkit, "submit_review", { state: "DONE", comments: [] })).rejects.toThrow(/terminated/);

		const invalid = createReviewToolkit(fakeTarget(data), "src/current.ts");
		await expect(execute(invalid, "submit_review", {
			state: "DONE",
			comments: [{ ...comments[0], path: "other.ts" }],
		})).rejects.toThrow(/field.*path/);
		await expect(execute(invalid, "submit_review", {
			state: "DONE",
			comments: [{ ...comments[0], severity: "urgent" }],
		})).rejects.toThrow(/severity/);
		await expect(execute(invalid, "submit_review", {
			state: "FAILED",
			comments: [comments[0]],
		})).rejects.toThrow(/FAILED/);
	});

	test("honors cancellation and the configured call budget", async () => {
		const data: FakeTargetData = {
			files: { "src/current.ts": "current\n" },
			changed: [changedFile("src/current.ts")],
			readPaths: [],
		};
		const toolkit = createReviewToolkit(fakeTarget(data), "src/current.ts", { maxToolCalls: 2 });
		await execute(toolkit, "file_find", { pattern: "*.ts" });
		await expect(execute(toolkit, "file_find", { pattern: "*.ts" })).rejects.toThrow(/Exploration budget exhausted/);
		expect(toolkit.toolCallCount).toBe(1);

		const cancelled = createReviewToolkit(fakeTarget(data), "src/current.ts");
		const controller = new AbortController();
		controller.abort();
		await expect(execute(cancelled, "file_read", { path: "src/current.ts" }, controller.signal)).rejects.toThrow(
			/aborted/i,
		);
		expect(data.readPaths).toEqual([]);
	});

	test("reserves the final slot for submit_review", async () => {
		const data: FakeTargetData = {
			files: { "src/current.ts": "current\n" },
			changed: [changedFile("src/current.ts")],
			readPaths: [],
		};
		const toolkit = createReviewToolkit(fakeTarget(data), "src/current.ts", { maxToolCalls: 3 });

		await execute(toolkit, "file_find", { pattern: "*.ts" });
		await execute(toolkit, "file_find", { pattern: "*.ts" });
		expect(toolkit.toolCallCount).toBe(2);
		await expect(execute(toolkit, "file_find", { pattern: "*.ts" })).rejects.toThrow(/Exploration budget exhausted/);
		expect(toolkit.toolCallCount).toBe(2);

		const done = await execute(toolkit, "submit_review", { state: "DONE", comments: [] });
		expect(done).toMatchObject({ terminate: true, details: { state: "DONE", recorded: 0 } });
		expect(toolkit.toolCallCount).toBe(3);
		expect(toolkit.completed).toBe(true);

		await expect(execute(toolkit, "file_find", { pattern: "*.ts" })).rejects.toThrow(/already terminated/);

		const onlySubmit = createReviewToolkit(fakeTarget(data), "src/current.ts", { maxToolCalls: 1 });
		await expect(execute(onlySubmit, "file_find", { pattern: "*.ts" })).rejects.toThrow(/Exploration budget exhausted/);
		const submit = await execute(onlySubmit, "submit_review", { state: "DONE", comments: [] });
		expect(submit).toMatchObject({ terminate: true, details: { state: "DONE", recorded: 0 } });
		expect(onlySubmit.toolCallCount).toBe(1);
	});

	test("resolves the file list once per search and respects scan ceilings", async () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < MAX_SCAN_FILES + 5; index += 1) {
			files[`src/file-${index}.ts`] = index < 50 ? `code search marker file ${index}\n` : `other content ${index}\n`;
		}
		const data: FakeTargetData = {
			files,
			changed: [changedFile("src/file-0.ts")],
			readPaths: [],
			listCount: 0,
		};
		const toolkit = createReviewToolkit(fakeTarget(data), "src/file-0.ts");

		const result = await execute(toolkit, "code_search", { pattern: "marker" });
		expect(data.listCount).toBe(1);
		expect(data.readPaths.length).toBe(MAX_SCAN_FILES);
		expect(result.details).toMatchObject({
			matchCount: 50,
			resultLimitReached: false,
			scanCapped: true,
		});
		expect(text(result)).toContain("[scan capped:");
		expect(text(result)).toMatch(/\d+ files \/ \d+ bytes/);

		const second = await execute(toolkit, "code_search", { pattern: "marker" });
		expect(data.listCount).toBe(2);
		expect(second.details).toMatchObject({ scanCapped: true });
	});

	test("caps code_search by total bytes read", async () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 30; index += 1) {
			files[`src/file-${index}.ts`] = `code search marker file ${index}\n${"x".repeat(80_000)}\n`;
		}
		const data: FakeTargetData = {
			files,
			changed: [changedFile("src/file-0.ts")],
			readPaths: [],
			listCount: 0,
		};
		const toolkit = createReviewToolkit(fakeTarget(data), "src/file-0.ts");

		const result = await execute(toolkit, "code_search", { pattern: "marker" });
		expect(data.listCount).toBe(1);
		expect(data.readPaths.length).toBeLessThan(30);
		expect(result.details).toMatchObject({ scanCapped: true });
		expect(text(result)).toContain("[scan capped:");
		expect(text(result)).toMatch(/\d+ files \/ \d+ bytes/);
	});

	test("rejects a code_search pattern containing a null byte", async () => {
		const data: FakeTargetData = {
			files: { "src/current.ts": "current\n" },
			changed: [changedFile("src/current.ts")],
			readPaths: [],
		};
		const toolkit = createReviewToolkit(fakeTarget(data), "src/current.ts");

		await expect(execute(toolkit, "code_search", { pattern: "foo\u0000bar" })).rejects.toThrow(
			/invalid/,
		);
		expect(data.readPaths).toEqual([]);
	});
});

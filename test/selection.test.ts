import { describe, expect, test } from "bun:test";

import type { ChangedFile } from "../src/types.ts";
import {
	SELECTION_REASON,
	decideFileSelection,
	isSafeReviewPath,
	selectFiles,
} from "../src/selection.ts";

function changedFile(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
	return {
		oldPath: path,
		newPath: path,
		rawDiff: "",
		newContent: "const value = 1;\n",
		isBinary: false,
		isDeleted: false,
		isNew: false,
		isRenamed: false,
		insertions: 1,
		deletions: 0,
		hunks: [],
		...overrides,
	};
}

describe("selectFiles", () => {
	test("applies hard exclusions before include and user patterns", () => {
		const binary = changedFile("src/image.ts", { isBinary: true });
		const deleted = changedFile("src/deleted.ts", { isDeleted: true });
		const userExcluded = changedFile("src/generated/api.ts");

		const result = selectFiles([binary, deleted, userExcluded], {
			include: ["src/**/*.ts"],
			exclude: ["src/generated/**"],
		});

		expect(result.selected).toEqual([]);
		expect(result.skipped.map((entry) => entry.reason)).toEqual([
			SELECTION_REASON.binary,
			SELECTION_REASON.deleted,
			SELECTION_REASON.userExclude,
		]);
	});

	test("an include bypasses only default extension and path exclusions", () => {
		const unsupported = changedFile("src/notes.md");
		const defaultPath = changedFile("src/handler_test.go");
		const regular = changedFile("lib/main.ts");

		const result = selectFiles([unsupported, defaultPath, regular], {
			include: ["src/**/*.md", "src/**/*_test.go"],
		});

		expect(result.selected).toEqual([unsupported, defaultPath, regular]);
		expect(result.decisions.every((entry) => entry.reason === SELECTION_REASON.selected)).toBe(
			true,
		);
	});

	test("include patterns are additive rather than an accidental whitelist", () => {
		const result = selectFiles(
			[changedFile("src/selected.ts"), changedFile("lib/also-reviewed.ts")],
			{ include: ["src/**"] },
		);

		expect(result.selected.map((file) => file.newPath)).toEqual([
			"src/selected.ts",
			"lib/also-reviewed.ts",
		]);
	});

	test("returns deterministic extension and default-path reasons", () => {
		const files = [
			changedFile("README.md"),
			changedFile("script-without-extension"),
			changedFile("foo_test.go"),
			changedFile(".env"),
			changedFile("Makefile"),
			changedFile("main.go"),
		];
		const first = selectFiles(files);
		const second = selectFiles(files);

		expect(first.decisions.map((entry) => entry.reason)).toEqual([
			SELECTION_REASON.unsupportedExtension,
			SELECTION_REASON.unsupportedExtension,
			SELECTION_REASON.defaultPath,
			SELECTION_REASON.selected,
			SELECTION_REASON.selected,
			SELECTION_REASON.selected,
		]);
		expect(second).toEqual(first);
	});

	test("enforces changed-line and UTF-8 byte limits, including for includes", () => {
		const tooManyLines = changedFile("src/large.md", {
			insertions: 3,
			deletions: 2,
		});
		const tooManyBytes = changedFile("src/emoji.md", { newContent: "😀" });
		const exact = changedFile("src/exact.ts", {
			insertions: 2,
			deletions: 1,
			newContent: "x",
		});

		const result = selectFiles([tooManyLines, tooManyBytes, exact], {
			include: ["src/**/*.md"],
			maxChangedLines: 3,
			maxFileBytes: 3,
		});

		expect(result.selected).toEqual([exact]);
		expect(result.skipped.map((entry) => entry.reason)).toEqual([
			SELECTION_REASON.changedLinesLimit,
			SELECTION_REASON.sizeLimit,
		]);
	});

	test("fails closed for unsafe paths and repository-aware symlink checks", () => {
		expect(isSafeReviewPath("src/file.ts")).toBe(true);
		expect(isSafeReviewPath("../outside.ts")).toBe(false);
		expect(isSafeReviewPath("src/../outside.ts")).toBe(false);
		expect(isSafeReviewPath("/absolute/file.ts")).toBe(false);
		expect(isSafeReviewPath("C:/absolute/file.ts")).toBe(false);
		expect(isSafeReviewPath("src/file\0.ts")).toBe(false);

		const file = changedFile("src/file.ts");
		expect(decideFileSelection(file, { isSafePath: () => false }).reason).toBe(
			SELECTION_REASON.unsafePath,
		);
	});
});

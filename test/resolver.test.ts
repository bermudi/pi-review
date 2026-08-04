import { describe, expect, test } from "bun:test";

import type { CandidateFinding, ChangedFile, DiffHunk } from "../src/types.ts";
import { resolveFinding, resolveFindingAnchor } from "../src/resolver.ts";

function candidate(existingCode: string): CandidateFinding {
	return {
		content: "There is a confirmed defect.",
		existingCode,
		category: "bug",
		severity: "high",
	};
}

function changedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
	return {
		oldPath: "src/example.ts",
		newPath: "src/example.ts",
		rawDiff: "",
		newContent: "before\nchanged\nafter\n",
		isBinary: false,
		isDeleted: false,
		isNew: false,
		isRenamed: false,
		insertions: 1,
		deletions: 1,
		hunks: [],
		...overrides,
	};
}

function hunk(lines: DiffHunk["lines"], newStart = 1): DiffHunk {
	return {
		oldStart: newStart,
		oldCount: lines.length,
		newStart,
		newCount: lines.filter((line) => line.kind !== "deletion").length,
		lines,
	};
}

describe("resolveFindingAnchor", () => {
	test("normalizes CRLF and whitespace and returns a multiline added range", () => {
		const file = changedFile({
			newContent: "if (ok) {\r\n\t  return value;\r\n}\r\n",
			hunks: [
				hunk([
					{ kind: "context", text: "if (ok) {", newLine: 1 },
					{ kind: "addition", text: "\t  return value;", newLine: 2 },
					{ kind: "context", text: "}", newLine: 3 },
				]),
			],
		});

		expect(
			resolveFindingAnchor(
				file,
				{ existingCode: " if (ok) {\n return   value;\n }\r\n" },
			),
		).toEqual({ startLine: 1, endLine: 3 });
	});

	test("can match a multiline snippet when the target has extra blank lines", () => {
		const file = changedFile({
			newContent: "first();\n\nadded();\n",
			hunks: [
				hunk([
					{ kind: "context", text: "first();", newLine: 1 },
					{ kind: "context", text: "", newLine: 2 },
					{ kind: "addition", text: "added();", newLine: 3 },
				]),
			],
		});

		expect(resolveFindingAnchor(file, { existingCode: "first();\nadded();" })).toEqual({
			startLine: 1,
			endLine: 3,
		});
	});

	test("chooses the duplicate occurrence that intersects an addition", () => {
		const file = changedFile({
			newContent: "same();\nsame();\n",
			hunks: [
				hunk([
					{ kind: "context", text: "same();", newLine: 1 },
					{ kind: "addition", text: "same();", newLine: 2 },
				]),
			],
		});

		expect(resolveFindingAnchor(file, { existingCode: "same();" })).toEqual({
			startLine: 2,
			endLine: 2,
		});
	});

	test("accepts diff-marked candidate snippets without treating markers as code", () => {
		const file = changedFile({
			newContent: "const value = 2;\n",
			hunks: [
				hunk([{ kind: "addition", text: "const value = 2;", newLine: 1 }], 1),
			],
		});

		expect(resolveFindingAnchor(file, { existingCode: "+ const value = 2;" })).toEqual({
			startLine: 1,
			endLine: 1,
		});
	});

	test("uses raw unified-diff coordinates when parsed hunks are absent", () => {
		const file = changedFile({
			newContent: "old();\nnew();\n",
			hunks: [],
			rawDiff: [
				"diff --git a/src/example.ts b/src/example.ts",
				"@@ -1,2 +1,2 @@",
				" old();",
				"+new();",
			].join("\n"),
		});

		expect(resolveFindingAnchor(file, { existingCode: "new();" })).toEqual({
			startLine: 2,
			endLine: 2,
		});
	});

	test("rejects context-only, deletion-only, and unmatched snippets", () => {
		const contextFile = changedFile({
			newContent: "context();\nadded();\n",
			hunks: [
				hunk([
					{ kind: "context", text: "context();", newLine: 1 },
					{ kind: "addition", text: "added();", newLine: 2 },
				]),
			],
		});
		expect(resolveFindingAnchor(contextFile, { existingCode: "context();" })).toBeUndefined();
		expect(resolveFindingAnchor(contextFile, { existingCode: "not present" })).toBeUndefined();

		const deletedFile = changedFile({
			newContent: undefined,
			isDeleted: true,
			hunks: [hunk([{ kind: "deletion", text: "deleted();", oldLine: 1 }])],
		});
		expect(resolveFindingAnchor(deletedFile, { existingCode: "deleted();" })).toBeUndefined();
	});

	test("returns the complete finding only after an added-line anchor exists", () => {
		const file = changedFile({
			newContent: "return value;\n",
			hunks: [hunk([{ kind: "addition", text: "return value;", newLine: 1 }])],
		});

		expect(resolveFinding(file, candidate("return value;"))).toMatchObject({
			path: "src/example.ts",
			startLine: 1,
			endLine: 1,
			content: "There is a confirmed defect.",
		});
		expect(resolveFinding(file, candidate("missing;"))).toBeUndefined();
	});
});

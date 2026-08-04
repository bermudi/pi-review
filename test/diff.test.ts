import { describe, expect, it } from "bun:test";

import { makeUntrackedDiff, parseUnifiedDiff } from "../src/diff.ts";

describe("parseUnifiedDiff", () => {
	it("maps hunk coordinates and +/- lines, including zero-sized ranges", () => {
		const patch = [
			"diff --git a/src/example.ts b/src/example.ts",
			"index 1111111..2222222 100644",
			"--- a/src/example.ts",
			"+++ b/src/example.ts",
			"@@ -2,3 +2,4 @@ function example()",
			" context",
			"-removed",
			"+added",
			" context-after",
			"+last",
			"@@ -8,0 +9,2 @@", // an insertion-only hunk
			"+one",
			"+two",
			"",
		].join("\n");

		const [file] = parseUnifiedDiff(patch);
		expect(file).toMatchObject({
			oldPath: "src/example.ts",
			newPath: "src/example.ts",
			insertions: 4,
			deletions: 1,
			isBinary: false,
		});
		expect(file?.hunks).toEqual([
			{
				oldStart: 2,
				oldCount: 3,
				newStart: 2,
				newCount: 4,
				lines: [
					{ kind: "context", text: "context", oldLine: 2, newLine: 2 },
					{ kind: "deletion", text: "removed", oldLine: 3 },
					{ kind: "addition", text: "added", newLine: 3 },
					{ kind: "context", text: "context-after", oldLine: 4, newLine: 4 },
					{ kind: "addition", text: "last", newLine: 5 },
				],
			},
			{
				oldStart: 8,
				oldCount: 0,
				newStart: 9,
				newCount: 2,
				lines: [
					{ kind: "addition", text: "one", newLine: 9 },
					{ kind: "addition", text: "two", newLine: 10 },
				],
			},
		]);
	});

	it("handles new, deleted, binary, and pure rename sections", () => {
		const patch = [
			"diff --git a/new file.txt b/new file.txt",
			"new file mode 100644",
			"index 0000000..1111111",
			"--- /dev/null",
			"+++ b/new file.txt",
			"@@ -0,0 +1 @@",
			"+new content",
			"\\ No newline at end of file",
			"diff --git a/removed.txt b/removed.txt",
			"deleted file mode 100644",
			"index 1111111..0000000",
			"--- a/removed.txt",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-gone",
			"diff --git a/assets/old.bin b/assets/new.bin",
			"similarity index 100%",
			"rename from assets/old.bin",
			"rename to assets/new.bin",
			"Binary files a/assets/old.bin and b/assets/new.bin differ",
		].join("\n");

		const files = parseUnifiedDiff(patch);
		expect(files).toHaveLength(3);
		expect(files[0]).toMatchObject({
			oldPath: "new file.txt",
			newPath: "new file.txt",
			isNew: true,
			isDeleted: false,
			insertions: 1,
		});
		expect(files[1]).toMatchObject({
			oldPath: "removed.txt",
			newPath: "removed.txt",
			isDeleted: true,
			isNew: false,
			deletions: 1,
		});
		expect(files[2]).toMatchObject({
			oldPath: "assets/old.bin",
			newPath: "assets/new.bin",
			isRenamed: true,
			isBinary: true,
		});
	});

	it("decodes Git-quoted paths and synthesizes an untracked patch", () => {
		const quoted = [
			"diff --git \"a/src/a\\tb.txt\" \"b/src/a\\tb.txt\"",
			"index 1111111..2222222 100644",
			"--- \"a/src/a\\tb.txt\"",
			"+++ \"b/src/a\\tb.txt\"",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");
		const [quotedFile] = parseUnifiedDiff(quoted);
		expect(quotedFile?.newPath).toBe("src/a\tb.txt");

		const generated = makeUntrackedDiff("new file.txt", "first\nsecond");
		const [newFile] = parseUnifiedDiff(generated);
		expect(newFile).toMatchObject({
			oldPath: "new file.txt",
			newPath: "new file.txt",
			isNew: true,
			insertions: 2,
		});
	});

	it("rejects traversal and absolute paths instead of normalizing them", () => {
		expect(() =>
			parseUnifiedDiff(
				[
					"diff --git a/../outside b/../outside",
					"--- a/../outside",
					"+++ b/../outside",
					"@@ -1 +1 @@",
					"-a",
					"+b",
				].join("\n"),
			),
		).toThrow();
	});
});

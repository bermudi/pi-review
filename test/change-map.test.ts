import { describe, expect, test } from "bun:test";

import {
	buildChangeMap,
	renderChangeMapSlice,
	type ChangeFact,
	type ChangeMap,
} from "../src/change-map.ts";
import { SELECTION_REASON, type SelectionDecision } from "../src/selection.ts";
import type { ChangedFile, DiffHunk, DiffLine } from "../src/types.ts";

function line(
	kind: DiffLine["kind"],
	text: string,
	numbers: { oldLine?: number; newLine?: number } = {},
): DiffLine {
	return { kind, text, ...numbers };
}

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
	return {
		oldPath: path,
		newPath: path,
		rawDiff: "",
		newContent: "",
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

function decision(
	path: string,
	reason: keyof typeof SELECTION_REASON,
	fileOverrides: Partial<ChangedFile> = {},
): SelectionDecision {
	return { path, file: file(path, fileOverrides), selected: false, reason: SELECTION_REASON[reason] };
}

function hunk(lines: readonly DiffLine[]): DiffHunk {
	return { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines };
}

function declarationNames(map: ChangeMap): string[] {
	return map.facts
		.filter((fact): fact is Extract<ChangeFact, { kind: "declaration" }> => fact.kind === "declaration")
		.map((fact) => fact.name);
}

describe("buildChangeMap", () => {
	test("builds rename, new-file, and deleted-file metadata facts", () => {
		const map = buildChangeMap([
			decision("src/foo2.ts", "selected", { oldPath: "src/foo.ts", newPath: "src/foo2.ts", isRenamed: true }),
			decision("src/bar.ts", "selected", { isNew: true }),
			decision("src/gone.ts", "deleted", { isDeleted: true }),
		]);

		expect(map.facts).toEqual([
			{ kind: "new_file", path: "src/bar.ts" },
			{ kind: "rename", from: "src/foo.ts", to: "src/foo2.ts" },
			{ kind: "deleted_file", path: "src/gone.ts" },
		]);
		expect(map.droppedFacts).toBe(0);
		expect(map.truncated).toBe(false);
	});

	test("keeps unsafe, binary, and explicitly user-excluded files out of the map", () => {
		const map = buildChangeMap([
			decision("src/unsafe.ts", "unsafePath", { isNew: true }),
			decision("src/blob.bin", "binary", { isRenamed: true, oldPath: "src/blob-old.bin", newPath: "src/blob.bin" }),
			decision("src/secret.ts", "userExclude", { isNew: true }),
		]);

		expect(map.facts).toEqual([]);
		expect(map.truncated).toBe(false);
	});

	test("honors explicit exclude patterns even when a deleted file reports reason deleted", () => {
		const deletedHunks = [
			hunk([line("deletion", "export function secretHelper() {}", { oldLine: 3 })]),
		];
		const withoutExclude = buildChangeMap([
			decision("src/generated/api.ts", "deleted", { isDeleted: true, hunks: deletedHunks }),
		]);
		const withExclude = buildChangeMap(
			[decision("src/generated/api.ts", "deleted", { isDeleted: true, hunks: deletedHunks })],
			{ exclude: ["src/generated/**"] },
		);

		expect(withoutExclude.facts).toEqual([
			{ kind: "deleted_file", path: "src/generated/api.ts" },
			{
				kind: "declaration",
				path: "src/generated/api.ts",
				name: "secretHelper",
				category: "function",
				line: 3,
				change: "removed",
			},
		]);
		expect(withExclude.facts).toEqual([]);
	});

	test("gives deleted files metadata and removed declarations", () => {
		const map = buildChangeMap([
			decision("src/gone.ts", "deleted", {
				isDeleted: true,
				hunks: [
					hunk([
						line("deletion", "export function connect() {}", { oldLine: 10 }),
						line("deletion", "export class Service {}", { oldLine: 20 }),
					]),
				],
			}),
		]);

		expect(map.facts).toEqual([
			{ kind: "deleted_file", path: "src/gone.ts" },
			{
				kind: "declaration",
				path: "src/gone.ts",
				name: "connect",
				category: "function",
				line: 10,
				change: "removed",
			},
			{
				kind: "declaration",
				path: "src/gone.ts",
				name: "Service",
				category: "class",
				line: 20,
				change: "removed",
			},
		]);
	});

	test("treats default policy skips as metadata only, never content", () => {
		const map = buildChangeMap([
			decision("README.md", "unsupportedExtension", {
				isNew: true,
				hunks: [hunk([line("addition", "# Title", { newLine: 1 })])],
			}),
			decision("src/handler_test.go", "defaultPath", {
				isRenamed: true,
				oldPath: "src/old_test.go",
				newPath: "src/handler_test.go",
				hunks: [hunk([line("addition", "func TestHandler() {}", { newLine: 2 })])],
			}),
			decision("src/huge.ts", "changedLinesLimit", {
				isNew: true,
				hunks: [hunk([line("addition", "export function big() {}", { newLine: 1 })])],
			}),
		]);

		expect(map.facts).toEqual([
			{ kind: "new_file", path: "README.md" },
			{ kind: "rename", from: "src/old_test.go", to: "src/handler_test.go" },
			{ kind: "new_file", path: "src/huge.ts" },
		]);
		expect(declarationNames(map)).toEqual([]);
	});

	test("extracts conservative TypeScript declarations from added lines", () => {
		const map = buildChangeMap([
			decision("src/api.ts", "selected", {
				hunks: [
					hunk([
						line("addition", "export function validate(input: string) {", { newLine: 3 }),
						line("addition", "export default class Service {", { newLine: 4 }),
						line("addition", "export interface Options {", { newLine: 5 }),
						line("addition", "export type Maybe<T> = T | null;", { newLine: 6 }),
						line("addition", "export const API_URL = '/api';", { newLine: 7 }),
						line("addition", "export { render };", { newLine: 8 }),
						line("addition", "export async function load() {}", { newLine: 9 }),
						// Not exported: not cross-file orientation.
						line("addition", "function local() {}", { newLine: 10 }),
						line("addition", "const hidden = 1;", { newLine: 11 }),
						// Hostile or non-declaration lines must not match.
						line("addition", "export default someIdentifier;", { newLine: 12 }),
						line("addition", "const text = 'export function fake() {}';", { newLine: 13 }),
					]),
				],
			}),
		]);

		expect(declarationNames(map)).toEqual([
			"validate",
			"Service",
			"Options",
			"Maybe",
			"API_URL",
			"render",
			"load",
		]);
		const validate = map.facts.find(
			(fact): fact is Extract<ChangeFact, { kind: "declaration" }> =>
				fact.kind === "declaration" && fact.name === "validate",
		);
		expect(validate).toMatchObject({ path: "src/api.ts", category: "function", line: 3, change: "added" });
	});

	test("extracts brace re-exports including type and alias forms", () => {
		const map = buildChangeMap([
			decision("src/re-exports.ts", "selected", {
				hunks: [
					hunk([
						line("addition", "export { Bar }", { newLine: 1 }),
						line("addition", "export { Baz as Qux }", { newLine: 2 }),
						line("addition", "export type { Foo }", { newLine: 3 }),
					]),
				],
			}),
			decision("src/removed.ts", "deleted", {
				isDeleted: true,
				hunks: [hunk([line("deletion", "export type { Foo }", { oldLine: 5 })])],
			}),
		]);

		const byName = new Map(
			map.facts
				.filter((fact): fact is Extract<ChangeFact, { kind: "declaration" }> => fact.kind === "declaration")
				.map((fact) => [`${fact.path}:${fact.name}`, fact]),
		);

		expect(byName.get("src/re-exports.ts:Bar")).toMatchObject({
			category: "export",
			line: 1,
			change: "added",
		});
		expect(byName.get("src/re-exports.ts:Baz")).toMatchObject({
			category: "export",
			line: 2,
			change: "added",
		});
		expect(byName.get("src/re-exports.ts:Foo")).toMatchObject({
			category: "export",
			line: 3,
			change: "added",
		});
		expect(byName.get("src/removed.ts:Foo")).toMatchObject({
			category: "export",
			line: 5,
			change: "removed",
		});
	});

	test("extracts Python, Go, and Rust declarations with conservative patterns", () => {
		const map = buildChangeMap([
			decision("src/parser.py", "selected", {
				hunks: [
					hunk([
						line("addition", "def parse(raw: str):", { newLine: 2 }),
						line("addition", "async def fetch():", { newLine: 3 }),
						line("addition", "class Parser:", { newLine: 4 }),
						line("addition", "    def helper(self):", { newLine: 5 }),
						line("addition", "VALUE = 1", { newLine: 6 }),
					]),
				],
			}),
			decision("src/runner.go", "selected", {
				hunks: [
					hunk([
						line("addition", "func Parse(input string) error {", { newLine: 2 }),
						line("addition", "func (r *Receiver) Run() {", { newLine: 3 }),
						line("addition", "type Config struct {", { newLine: 4 }),
						line("addition", "var ErrNotFound = errors.New(\"missing\")", { newLine: 5 }),
					]),
				],
			}),
			decision("src/lib.rs", "selected", {
				hunks: [
					hunk([
						line("addition", "pub fn parse(input: &str) -> Result<()> {", { newLine: 2 }),
						line("addition", "fn main() {}", { newLine: 3 }),
						line("addition", "pub struct Config {", { newLine: 4 }),
						line("addition", "pub(crate) fn internal() {}", { newLine: 5 }),
						line("addition", "impl Config {", { newLine: 6 }),
					]),
				],
			}),
		]);

		const byName = new Map(
			map.facts
				.filter((fact): fact is Extract<ChangeFact, { kind: "declaration" }> => fact.kind === "declaration")
				.map((fact) => [`${fact.path}:${fact.name}`, fact]),
		);
		expect(byName.get("src/parser.py:parse")).toMatchObject({ category: "function", line: 2 });
		expect(byName.get("src/parser.py:fetch")).toMatchObject({ category: "function", line: 3 });
		expect(byName.get("src/parser.py:Parser")).toMatchObject({ category: "class", line: 4 });
		expect(byName.get("src/runner.go:Parse")).toMatchObject({ category: "function", line: 2 });
		expect(byName.get("src/runner.go:Run")).toMatchObject({ category: "function", line: 3 });
		expect(byName.get("src/runner.go:Config")).toMatchObject({ category: "type", line: 4 });
		expect(byName.get("src/lib.rs:parse")).toMatchObject({ category: "function", line: 2 });
		expect(byName.get("src/lib.rs:main")).toMatchObject({ category: "function", line: 3 });
		expect(byName.get("src/lib.rs:Config")).toMatchObject({ category: "type", line: 4 });
		expect(byName.get("src/lib.rs:internal")).toMatchObject({ category: "function", line: 5 });
		// Indented (nested) defs, var/impl blocks, and module assignments are not
		// module-level declarations and are skipped.
		expect(byName.has("src/parser.py:helper")).toBe(false);
		expect(byName.has("src/runner.go:ErrNotFound")).toBe(false);
		expect(byName.has("src/parser.py:VALUE")).toBe(false);
	});

	test("does not extract declarations for languages outside the small pattern table", () => {
		const map = buildChangeMap([
			decision("src/script.rb", "selected", {
				hunks: [hunk([line("addition", "def helper", { newLine: 1 })])],
			}),
		]);
		expect(map.facts).toEqual([]);
	});

	test("is deterministic and stably ordered regardless of decision order", () => {
		const decisions = [
			decision("src/b.ts", "selected", {
				hunks: [hunk([line("addition", "export function beta() {}", { newLine: 7 })])],
			}),
			decision("src/a.ts", "selected", {
				hunks: [hunk([line("addition", "export function alpha() {}", { newLine: 5 })])],
			}),
		];
		const first = buildChangeMap(decisions);
		const second = buildChangeMap([...decisions].reverse());

		expect(first.facts).toEqual(second.facts);
		expect(first.facts.map((fact) => factPathOf(fact))).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("caps declarations per file and counts exact drops", () => {
		const many = Array.from({ length: 5 }, (_, index) =>
			line("addition", `export function fn${index + 1}() {}`, { newLine: index + 1 }),
		);
		const map = buildChangeMap([decision("src/many.ts", "selected", { hunks: [hunk(many)] })], {
			maxFactsPerFile: 3,
		});

		expect(declarationNames(map)).toEqual(["fn1", "fn2", "fn3"]);
		expect(map.droppedFacts).toBe(2);
		expect(map.truncated).toBe(true);
	});

	test("caps total facts across files and counts exact drops", () => {
		const decls = (prefix: string) =>
			Array.from({ length: 3 }, (_, index) =>
				line("addition", `export function ${prefix}${index + 1}() {}`, { newLine: index + 1 }),
			);
		const map = buildChangeMap(
			[
				decision("src/a.ts", "selected", { hunks: [hunk(decls("a"))] }),
				decision("src/b.ts", "selected", { hunks: [hunk(decls("b"))] }),
			],
			{ maxFacts: 4 },
		);

		expect(declarationNames(map)).toEqual(["a1", "a2", "a3", "b1"]);
		expect(map.droppedFacts).toBe(2);
		expect(map.truncated).toBe(true);
	});

	test("skips malformed decisions without throwing", () => {
		const map = buildChangeMap([
			decision("src/ok.ts", "selected", {
				hunks: [hunk([line("addition", "export function fine() {}", { newLine: 1 })])],
			}),
			{ path: "", file: file("bad.ts"), selected: false, reason: "selected" },
		] as SelectionDecision[]);

		expect(declarationNames(map)).toEqual(["fine"]);
	});

	test("total over non-finite line numbers and malformed hunks", () => {
		const map = buildChangeMap([
			decision("src/weird.ts", "selected", {
				hunks: [
					{
						oldStart: 1,
						oldCount: 1,
						newStart: 1,
						newCount: 1,
						lines: [
							{ kind: "addition", text: "export function odd() {}", newLine: Number.NaN },
							{ kind: "addition", text: "export function ok() {}", newLine: 2 },
							null,
						],
					} as unknown as DiffHunk,
					null as unknown as DiffHunk,
				],
			}),
		]);

		expect(declarationNames(map)).toEqual(["ok"]);
	});
});

describe("renderChangeMapSlice", () => {
	const map = buildChangeMap([
		decision("src/a.ts", "selected", {
			hunks: [hunk([line("addition", "export function alpha() {}", { newLine: 5 })])],
		}),
		decision("src/b.ts", "selected", {
			hunks: [hunk([line("addition", "export function beta() {}", { newLine: 7 })])],
		}),
		decision("src/gone.ts", "deleted", {
			isDeleted: true,
			hunks: [hunk([line("deletion", "export function omega() {}", { oldLine: 2 })])],
		}),
		decision("src/c.ts", "selected", { isNew: true }),
		decision("src/d.ts", "selected", { isRenamed: true, oldPath: "src/d-old.ts", newPath: "src/d.ts" }),
	]);

	test("renders a current-file slice with its own facts grouped first", () => {
		const slice = renderChangeMapSlice(map, "src/a.ts");

		expect(slice).toContain("This file (src/a.ts):");
		expect(slice).toContain("LEXICAL  src/a.ts: function alpha added (line 5)");
		expect(slice).toContain("Deleted files:");
		expect(slice).toContain("FACT  deleted: src/gone.ts");
		expect(slice).toContain("Renamed files:");
		expect(slice).toContain("FACT  renamed: src/d-old.ts -> src/d.ts");
		expect(slice).toContain("New files:");
		expect(slice).toContain("FACT  new file: src/c.ts");
		expect(slice).toContain("Other changed declarations:");
		expect(slice).toContain("LEXICAL  src/b.ts: function beta added (line 7)");
		expect(slice).toContain("FACT");
		expect(slice).toContain("LEXICAL");
	});

	test("per-file slices differ and never duplicate another file's own section", () => {
		const sliceA = renderChangeMapSlice(map, "src/a.ts");
		const sliceB = renderChangeMapSlice(map, "src/b.ts");

		expect(sliceA).toContain("This file (src/a.ts):");
		expect(sliceA).not.toContain("This file (src/b.ts):");
		expect(sliceB).toContain("This file (src/b.ts):");
		expect(sliceB).not.toContain("This file (src/a.ts):");
		expect(sliceB).toContain("LEXICAL  src/a.ts: function alpha added (line 5)");
	});

	test("renders deleted-file declarations inside the Deleted files section", () => {
		const slice = renderChangeMapSlice(map, "src/a.ts");

		const deletedSection = slice.slice(slice.indexOf("Deleted files:"), slice.indexOf("Renamed files:"));
		expect(deletedSection).toContain("FACT  deleted: src/gone.ts");
		expect(deletedSection).toContain("LEXICAL  src/gone.ts: function omega removed (line 2)");
	});

	test("renders an empty slice for an empty map", () => {
		const empty: ChangeMap = { facts: [], droppedFacts: 0, truncated: false };
		expect(renderChangeMapSlice(empty, "src/a.ts")).toBe("");
	});

	test("renders nothing extra for a current file without facts", () => {
		const slice = renderChangeMapSlice(map, "src/unknown.ts");
		expect(slice).not.toContain("This file (src/unknown.ts):");
		expect(slice).toContain("Deleted files:");
	});

	test("keeps the current-file section when the byte budget forces truncation", () => {
		const busy = buildChangeMap([
			decision("src/current.ts", "selected", {
				hunks: [hunk([line("addition", "export function own() {}", { newLine: 1 })])],
			}),
			...Array.from({ length: 40 }, (_, index) =>
				decision(`src/other${index}.ts`, "selected", {
					hunks: [hunk([line("addition", "export function helper() {}", { newLine: 1 })])],
				}),
			),
		]);
		const slice = renderChangeMapSlice(busy, "src/current.ts", { maxBytes: 300 });

		expect(slice).toContain("This file (src/current.ts):");
		expect(slice).toContain("own added");
		expect(slice).not.toContain("Other changed declarations:");
		expect(slice).toMatch(/\(truncated: \d+ facts? omitted\)/);
		expect(new TextEncoder().encode(slice).byteLength).toBeLessThanOrEqual(300);
	});

	test("emits a truncation notice when construction caps dropped facts", () => {
		const many = Array.from({ length: 10 }, (_, index) =>
			line("addition", `export function fn${index + 1}() {}`, { newLine: index + 1 }),
		);
		const capped = buildChangeMap([decision("src/many.ts", "selected", { hunks: [hunk(many)] })], {
			maxFactsPerFile: 4,
		});
		const slice = renderChangeMapSlice(capped, "src/many.ts", { maxBytes: 4_000 });

		expect(slice).toContain("(truncated: 6 facts omitted)");
		expect(new TextEncoder().encode(slice).byteLength).toBeLessThanOrEqual(4_000);
	});

	test("never exceeds the byte budget even with long Unicode content", () => {
		const unicodePath = `src/${"😀".repeat(300)}.ts`;
		const unicodeMap = buildChangeMap([
			decision(unicodePath, "selected", { isNew: true }),
			decision("src/other.ts", "selected", { isRenamed: true, oldPath: "src/old.ts", newPath: "src/other.ts" }),
		]);
		const slice = renderChangeMapSlice(unicodeMap, unicodePath, { maxBytes: 200 });

		expect(new TextEncoder().encode(slice).byteLength).toBeLessThanOrEqual(200);
		// The truncation must never split a surrogate pair.
		const last = slice.charCodeAt(slice.length - 1);
		expect(last < 0xd800 || last > 0xdbff).toBe(true);
		expect(slice).toMatch(/\(truncated: \d+ facts? omitted\)/);
	});

	test("keeps hostile map text raw inside the delimited block when framed by prompts", async () => {
		const hostile = buildChangeMap([
			decision("src/evil.ts", "selected", {
				hunks: [hunk([line("addition", "export function pwn() {}", { newLine: 1 })])],
			}),
		]);
		const slice = renderChangeMapSlice(hostile, "src/evil.ts");
		expect(slice).toContain("pwn");
		expect(slice).not.toContain("<untrusted-data>");
	});

	test("is total over malformed facts and does not throw", () => {
		const wellFormed = buildChangeMap([
			decision("src/ok.ts", "selected", {
				hunks: [hunk([line("addition", "export function ok() {}", { newLine: 1 })])],
			}),
		]);
		const malformed: ChangeMap = {
			...wellFormed,
			facts: [
				...wellFormed.facts,
				{ kind: "bogus", path: "src/weird.ts" } as unknown as ChangeFact,
				{ kind: "declaration", path: "src/weird.ts", name: undefined, category: "function", line: Number.NaN, change: "added" } as unknown as ChangeFact,
			],
		};
		expect(() => renderChangeMapSlice(malformed, "src/ok.ts")).not.toThrow();
	});
});

function factPathOf(fact: ChangeFact): string {
	switch (fact.kind) {
		case "rename":
			return fact.to;
		case "new_file":
		case "deleted_file":
		case "declaration":
			return fact.path;
	}
}

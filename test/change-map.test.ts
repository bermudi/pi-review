import { describe, expect, test } from "bun:test";

import {
	buildChangeMap,
	renderChangeMapSlice,
	type ChangeEdge,
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

function edgeNames(edges: readonly ChangeEdge[]): string[] {
	return edges.map((edge) => {
		switch (edge.kind) {
			case "moved_declaration":
				return `moved:${edge.name}`;
			case "stale_reference":
				return `stale:${edge.name}`;
			case "renamed_path_reference":
				return `path:${edge.from}`;
		}
	});
}

describe("buildChangeMap edges", () => {
	test("joins a removed declaration with a reference in another file's context", () => {
		const map = buildChangeMap([
			decision("src/old.ts", "selected", {
				hunks: [hunk([line("deletion", "export function validateToken() {}", { oldLine: 10 })])],
			}),
			decision("src/caller.ts", "selected", {
				hunks: [
					hunk([
						line("context", "  const result = validateToken(input);", { oldLine: 5, newLine: 5 }),
						line("addition", "  return result;", { newLine: 6 }),
					]),
				],
			}),
		]);

		expect(map.edges).toEqual([
			{
				kind: "stale_reference",
				name: "validateToken",
				removedIn: "src/old.ts",
				removedLine: 10,
				referencedIn: "src/caller.ts",
				referenceLine: 5,
				referenceSide: "existing",
			},
		]);
	});

	test("joins a removed declaration with a reference on an added line", () => {
		const map = buildChangeMap([
			decision("src/old.ts", "selected", {
				hunks: [hunk([line("deletion", "export class TokenValidator {}", { oldLine: 8 })])],
			}),
			decision("src/caller.ts", "selected", {
				hunks: [
					hunk([line("addition", "  const v = new TokenValidator();", { newLine: 12 })]),
				],
			}),
		]);

		expect(map.edges).toEqual([
			{
				kind: "stale_reference",
				name: "TokenValidator",
				removedIn: "src/old.ts",
				removedLine: 8,
				referencedIn: "src/caller.ts",
				referenceLine: 12,
				referenceSide: "added",
			},
		]);
	});

	test("joins a removed declaration with a re-declaration in another file as moved", () => {
		const map = buildChangeMap([
			decision("src/old.ts", "selected", {
				hunks: [hunk([line("deletion", "export function parseConfig() {}", { oldLine: 3 })])],
			}),
			decision("src/new.ts", "selected", {
				hunks: [hunk([line("addition", "export function parseConfig() {}", { newLine: 7 })])],
			}),
		]);

		expect(map.edges).toEqual([
			{
				kind: "moved_declaration",
				name: "parseConfig",
				from: "src/old.ts",
				fromLine: 3,
				to: "src/new.ts",
				toLine: 7,
			},
		]);
	});

	test("joins a renamed file with a stale path reference in another file", () => {
		const map = buildChangeMap([
			decision("src/auth-module.ts", "selected", {
				isRenamed: true,
				oldPath: "src/auth.ts",
				newPath: "src/auth-module.ts",
			}),
			decision("src/app.ts", "selected", {
				hunks: [
					hunk([
						line("context", 'import { login } from "./auth";', { oldLine: 1, newLine: 1 }),
					]),
				],
			}),
		]);

		expect(map.edges).toEqual([
			{
				kind: "renamed_path_reference",
				from: "src/auth.ts",
				to: "src/auth-module.ts",
				referencedIn: "src/app.ts",
				referenceLine: 1,
				referenceSide: "existing",
			},
		]);
	});

	test("does not produce an edge when the same file removes and re-adds a name", () => {
		const map = buildChangeMap([
			decision("src/edit.ts", "selected", {
				hunks: [
					hunk([
						line("deletion", "export function parseConfig() {}", { oldLine: 3 }),
						line("addition", "export function parseConfig(opts: Opts) {}", { newLine: 3 }),
					]),
				],
			}),
		]);

		expect(map.edges).toEqual([]);
	});

	test("does not produce a stale_reference edge when both files remove the name", () => {
		const map = buildChangeMap([
			decision("src/a.ts", "selected", {
				hunks: [hunk([line("deletion", "export function parseConfig() {}", { oldLine: 3 })])],
			}),
			decision("src/b.ts", "selected", {
				hunks: [
					hunk([
						line("deletion", "export function parseConfig() {}", { oldLine: 8 }),
						line("context", "  parseConfig();", { oldLine: 9, newLine: 9 }),
					]),
				],
			}),
		]);

		// b also removes the declaration, so its context-line mention is not a
		// stale reference — b is retiring the symbol too.
		expect(map.edges).toEqual([]);
	});

	test("does not produce edges for non-distinctive short names", () => {
		const map = buildChangeMap([
			decision("src/old.ts", "selected", {
				hunks: [hunk([line("deletion", "export function load() {}", { oldLine: 1 })])],
			}),
			decision("src/caller.ts", "selected", {
				hunks: [
					hunk([line("context", "  load(data);", { oldLine: 2, newLine: 2 })]),
				],
			}),
		]);

		expect(map.edges).toEqual([]);
	});

	test("does not treat deleted lines as references", () => {
		const map = buildChangeMap([
			decision("src/old.ts", "selected", {
				hunks: [hunk([line("deletion", "export function validateToken() {}", { oldLine: 1 })])],
			}),
			decision("src/caller.ts", "selected", {
				hunks: [
					hunk([
						line("deletion", "  validateToken();", { oldLine: 2 }),
						line("addition", "  validateTokenSafe();", { newLine: 2 }),
					]),
				],
			}),
		]);

		// The deleted line in caller.ts is not a reference — the change is
		// removing it. Only context or added lines can be stale references.
		expect(map.edges).toEqual([]);
	});

	test("does not index references from deleted or metadata-only files", () => {
		const map = buildChangeMap([
			decision("src/old.ts", "selected", {
				hunks: [hunk([line("deletion", "export function validateToken() {}", { oldLine: 1 })])],
			}),
			decision("src/gone.ts", "deleted", {
				isDeleted: true,
				hunks: [
					hunk([line("deletion", "  validateToken();", { oldLine: 5 })]),
				],
			}),
		]);

		expect(map.edges).toEqual([]);
	});

	test("does not match a renamed file against its own remaining old-path mentions", () => {
		const map = buildChangeMap([
			decision("src/auth-module.ts", "selected", {
				isRenamed: true,
				oldPath: "src/auth.ts",
				newPath: "src/auth-module.ts",
				hunks: [
					hunk([
						line("context", '// was in auth.ts', { oldLine: 1, newLine: 1 }),
					]),
				],
			}),
		]);

		expect(map.edges).toEqual([]);
	});

	test("skips ambient path stems like index", () => {
		const map = buildChangeMap([
			decision("src/index-v2.ts", "selected", {
				isRenamed: true,
				oldPath: "src/index.ts",
				newPath: "src/index-v2.ts",
			}),
			decision("src/app.ts", "selected", {
				hunks: [
					hunk([
						line("context", 'import { x } from "./index";', { oldLine: 1, newLine: 1 }),
					]),
				],
			}),
		]);

		expect(map.edges).toEqual([]);
	});

	test("does not match a rename stem that is a substring of a longer identifier", () => {
		const map = buildChangeMap([
			decision("src/auth-module.ts", "selected", {
				isRenamed: true,
				oldPath: "src/auth.ts",
				newPath: "src/auth-module.ts",
			}),
			decision("src/app.ts", "selected", {
				hunks: [
					hunk([
						// "auth" appears inside "authenticate" — this is NOT a
						// stale path reference.
						line("context", "  authenticate(user);", { oldLine: 1, newLine: 1 }),
					]),
				],
			}),
		]);

		expect(map.edges).toEqual([]);
	});

	test("does match a rename stem followed by a path delimiter or extension", () => {
		const map = buildChangeMap([
			decision("src/auth-module.ts", "selected", {
				isRenamed: true,
				oldPath: "src/auth.ts",
				newPath: "src/auth-module.ts",
			}),
			decision("src/app.ts", "selected", {
				hunks: [
					hunk([
						line("context", 'import { login } from "./auth";', { oldLine: 1, newLine: 1 }),
						line("context", 'import type { User } from "../auth.ts";', { oldLine: 2, newLine: 2 }),
					]),
				],
			}),
		]);

		// Both lines reference the old stem as a path component, not as a
		// substring of a longer word. The earliest line wins.
		expect(map.edges).toEqual([
			{
				kind: "renamed_path_reference",
				from: "src/auth.ts",
				to: "src/auth-module.ts",
				referencedIn: "src/app.ts",
				referenceLine: 1,
				referenceSide: "existing",
			},
		]);
	});

	test("does not produce a moved_declaration edge when the target also removes the name", () => {
		const map = buildChangeMap([
			decision("src/a.ts", "selected", {
				hunks: [hunk([line("deletion", "export function parseConfig() {}", { oldLine: 3 })])],
			}),
			// b.ts is editing parseConfig in place: it removes and re-adds it.
			// That is not a move from a.ts.
			decision("src/b.ts", "selected", {
				hunks: [
					hunk([
						line("deletion", "export function parseConfig() {}", { oldLine: 8 }),
						line("addition", "export function parseConfig(opts: Opts) {}", { newLine: 8 }),
					]),
				],
			}),
		]);

		expect(map.edges).toEqual([]);
	});

	test("produces deterministic edge ordering regardless of decision order", () => {
		const decisions = [
			decision("src/a.ts", "selected", {
				hunks: [hunk([line("deletion", "export function validateToken() {}", { oldLine: 3 })])],
			}),
			decision("src/b.ts", "selected", {
				hunks: [hunk([line("context", "  validateToken();", { oldLine: 1, newLine: 1 })])],
			}),
			decision("src/c.ts", "selected", {
				hunks: [hunk([line("deletion", "export class TokenValidator {}", { oldLine: 5 })])],
			}),
			decision("src/d.ts", "selected", {
				hunks: [hunk([line("addition", "  new TokenValidator();", { newLine: 2 })])],
			}),
		];
		const first = buildChangeMap(decisions);
		const second = buildChangeMap([...decisions].reverse());

		expect(first.edges).toEqual(second.edges);
		// stale_reference edges sort before moved_declaration edges.
		expect(edgeNames(first.edges)).toEqual(["stale:TokenValidator", "stale:validateToken"]);
	});

	test("caps total edges and counts exact drops", () => {
		const decisions = Array.from({ length: 5 }, (_, index) => [
			decision(`src/old${index}.ts`, "selected", {
				hunks: [hunk([line("deletion", `export function validateToken${index}() {}`, { oldLine: 1 })])],
			}),
			decision(`src/caller${index}.ts`, "selected", {
				hunks: [hunk([line("context", `  validateToken${index}();`, { oldLine: 1, newLine: 1 })])],
			}),
		]).flat();
		const map = buildChangeMap(decisions, { maxEdges: 3 });

		expect(map.edges.length).toBe(3);
		expect(map.droppedEdges).toBe(2);
		expect(map.truncated).toBe(true);
	});
});

describe("renderChangeMapSlice", () => {
	function staleRefMap(): ChangeMap {
		return buildChangeMap([
			decision("src/old.ts", "selected", {
				hunks: [hunk([line("deletion", "export function validateToken() {}", { oldLine: 10 })])],
			}),
			decision("src/caller.ts", "selected", {
				hunks: [
					hunk([
						line("context", "  const r = validateToken(input);", { oldLine: 5, newLine: 5 }),
					]),
				],
			}),
		]);
	}

	test("renders an empty string for a map with no edges", () => {
		const noEdges = buildChangeMap([
			decision("src/a.ts", "selected", {
				hunks: [hunk([line("addition", "export function alpha() {}", { newLine: 5 })])],
			}),
			decision("src/b.ts", "selected", { isNew: true }),
		]);
		expect(renderChangeMapSlice(noEdges, "src/a.ts")).toBe("");
	});

	test("renders an empty string for an empty map", () => {
		const empty: ChangeMap = { facts: [], edges: [], droppedFacts: 0, droppedEdges: 0, truncated: false };
		expect(renderChangeMapSlice(empty, "src/a.ts")).toBe("");
	});

	test("renders an empty string for a file not involved in any edge", () => {
		expect(renderChangeMapSlice(staleRefMap(), "src/unrelated.ts")).toBe("");
	});

	test("renders the referencer side of a stale_reference edge", () => {
		const slice = renderChangeMapSlice(staleRefMap(), "src/caller.ts");

		expect(slice).toContain("Symbols this file references that another changed file removed:");
		expect(slice).toContain("LEXICAL  validateToken: removed in src/old.ts (line 10); referenced here on existing line 5");
		expect(slice).toContain("LEXICAL");
	});

	test("renders the remover side of a stale_reference edge", () => {
		const slice = renderChangeMapSlice(staleRefMap(), "src/old.ts");

		expect(slice).toContain("Declarations this file removed that another changed file still references:");
		expect(slice).toContain("LEXICAL  validateToken: removed here (line 10); referenced in src/caller.ts on existing line 5");
	});

	test("renders a renamed_path_reference edge for the referencing file only", () => {
		const map = buildChangeMap([
			decision("src/auth-module.ts", "selected", {
				isRenamed: true,
				oldPath: "src/auth.ts",
				newPath: "src/auth-module.ts",
			}),
			decision("src/app.ts", "selected", {
				hunks: [
					hunk([line("context", 'import { login } from "./auth";', { oldLine: 1, newLine: 1 })]),
				],
			}),
		]);

		const appSlice = renderChangeMapSlice(map, "src/app.ts");
		expect(appSlice).toContain("Renamed files whose old name still appears in this file:");
		expect(appSlice).toContain("LEXICAL  src/auth.ts was renamed to src/auth-module.ts; the old name still appears here on existing line 1");

		// The renamed file itself gets no slice — its own diff shows the rename.
		expect(renderChangeMapSlice(map, "src/auth-module.ts")).toBe("");
	});

	test("renders a moved_declaration edge from both sides", () => {
		const map = buildChangeMap([
			decision("src/old.ts", "selected", {
				hunks: [hunk([line("deletion", "export function parseConfig() {}", { oldLine: 3 })])],
			}),
			decision("src/new.ts", "selected", {
				hunks: [hunk([line("addition", "export function parseConfig() {}", { newLine: 7 })])],
			}),
		]);

		const oldSlice = renderChangeMapSlice(map, "src/old.ts");
		expect(oldSlice).toContain("Declarations that may have moved between changed files:");
		expect(oldSlice).toContain("LEXICAL  parseConfig: removed here (line 3), added in src/new.ts (line 7)");

		const newSlice = renderChangeMapSlice(map, "src/new.ts");
		expect(newSlice).toContain("LEXICAL  parseConfig: added here (line 7), removed in src/old.ts (line 3)");
	});

	test("keeps the highest-priority section when the byte budget forces truncation", () => {
		const removedDecls = [
			line("deletion", "export function validateToken() {}", { oldLine: 10 }),
			line("deletion", "export class TokenValidator {}", { oldLine: 20 }),
			line("deletion", "export function parseConfig() {}", { oldLine: 30 }),
			line("deletion", "export class ConfigBuilder {}", { oldLine: 40 }),
		];
		const refs = [
			line("context", "  validateToken();", { oldLine: 1, newLine: 1 }),
			line("context", "  TokenValidator.check();", { oldLine: 2, newLine: 2 }),
			line("context", "  parseConfig();", { oldLine: 3, newLine: 3 }),
			line("context", "  new ConfigBuilder();", { oldLine: 4, newLine: 4 }),
		];
		const map = buildChangeMap([
			decision("src/current.ts", "selected", { hunks: [hunk(refs)] }),
			decision("src/removed.ts", "selected", { hunks: [hunk(removedDecls)] }),
		]);
		const slice = renderChangeMapSlice(map, "src/current.ts", { maxBytes: 500 });

		expect(slice).toContain("Symbols this file references that another changed file removed:");
		expect(new TextEncoder().encode(slice).byteLength).toBeLessThanOrEqual(500);
		expect(slice).toMatch(/\(truncated: \d+ edges? omitted\)/);
	});

	test("emits a truncation notice when construction caps dropped edges", () => {
		const decisions = Array.from({ length: 10 }, (_, index) => [
			decision(`src/old${index}.ts`, "selected", {
				hunks: [hunk([line("deletion", `export function validateToken${index}() {}`, { oldLine: 1 })])],
			}),
			decision(`src/caller${index}.ts`, "selected", {
				hunks: [hunk([line("context", `  validateToken${index}();`, { oldLine: 1, newLine: 1 })])],
			}),
		]).flat();
		const capped = buildChangeMap(decisions, { maxEdges: 4 });
		const slice = renderChangeMapSlice(capped, "src/caller0.ts", { maxBytes: 4_000 });

		expect(slice).toContain("(truncated: 6 edges omitted)");
		expect(new TextEncoder().encode(slice).byteLength).toBeLessThanOrEqual(4_000);
	});

	test("never exceeds the byte budget even with long Unicode content", () => {
		const unicodePath = `src/${"😀".repeat(300)}.ts`;
		const unicodeMap = buildChangeMap([
			decision(unicodePath, "selected", {
				hunks: [hunk([line("deletion", "export function validateToken() {}", { oldLine: 1 })])],
			}),
			decision("src/caller.ts", "selected", {
				hunks: [hunk([line("context", "  validateToken();", { oldLine: 1, newLine: 1 })])],
			}),
		]);
		const slice = renderChangeMapSlice(unicodeMap, "src/caller.ts", { maxBytes: 200 });

		expect(new TextEncoder().encode(slice).byteLength).toBeLessThanOrEqual(200);
		const last = slice.charCodeAt(slice.length - 1);
		expect(last < 0xd800 || last > 0xdbff).toBe(true);
	});

	test("keeps hostile map text raw without synthesizing untrusted-data tags", () => {
		const hostile = buildChangeMap([
			decision("src/evil.ts", "selected", {
				hunks: [hunk([line("deletion", "export function pwnAttack() {}", { oldLine: 1 })])],
			}),
			decision("src/caller.ts", "selected", {
				hunks: [hunk([line("context", "  pwnAttack();", { oldLine: 1, newLine: 1 })])],
			}),
		]);
		const slice = renderChangeMapSlice(hostile, "src/caller.ts");
		expect(slice).toContain("pwnAttack");
		expect(slice).not.toContain("<untrusted-data>");
	});

	test("is total over malformed edges and does not throw", () => {
		const wellFormed = buildChangeMap([
			decision("src/old.ts", "selected", {
				hunks: [hunk([line("deletion", "export function validateToken() {}", { oldLine: 1 })])],
			}),
			decision("src/caller.ts", "selected", {
				hunks: [hunk([line("context", "  validateToken();", { oldLine: 1, newLine: 1 })])],
			}),
		]);
		const malformed: ChangeMap = {
			...wellFormed,
			edges: [
				...wellFormed.edges,
				{ kind: "bogus" } as unknown as ChangeEdge,
			],
		};
		expect(() => renderChangeMapSlice(malformed, "src/caller.ts")).not.toThrow();
	});
});

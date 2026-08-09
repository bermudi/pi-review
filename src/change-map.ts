import {
	SELECTION_REASON,
	matchesUserExclude,
	type SelectionDecision,
	type SelectionReason,
} from "./selection.js";
import type { ChangedFile, DiffLine } from "./types.js";

/**
 * Deterministic, host-side cross-file change map.
 *
 * The map is built once from selection decisions — never from raw target
 * files — so the same policy that decides what is reviewable also decides what
 * is eligible for cross-file orientation. It is passive evidence only. It is
 * never a verified semantic fact, never a finding, and it must not change
 * review scope, anchoring, or coverage.
 *
 * There are two layers:
 *
 * - Facts: per-file signals (renames, new/deleted files, and conservative
 *   lexical declaration changes). These are the substrate, exposed for
 *   library consumers and tests.
 * - Edges: the join across facts — a declaration removed in one file and
 *   referenced or re-declared in another, or a renamed path still referenced
 *   elsewhere. Only edges are rendered into prompts, because an unjoined list
 *   of another file's declarations is something a reviewer can already obtain
 *   on demand via `file_read_diff`, at no cost when it is irrelevant.
 *
 * Rendered lines are labeled LEXICAL: the join is a token-level approximation
 * with no type or import resolution behind it.
 */

export type DeclarationCategory = "function" | "class" | "type" | "value" | "export";

export type ChangeFact =
	| { readonly kind: "rename"; readonly from: string; readonly to: string }
	| { readonly kind: "new_file"; readonly path: string }
	| { readonly kind: "deleted_file"; readonly path: string }
	| {
		readonly kind: "declaration";
		readonly path: string;
		readonly name: string;
		readonly category: DeclarationCategory;
		readonly line: number;
		readonly change: "added" | "removed";
	};

/** Which side of the target a reference sits on. Deleted lines are never
 *  references: a reference the change removes cannot be left dangling. */
export type ReferenceSide = "added" | "existing";

/**
 * A joined cross-file relationship. Every edge names two distinct files, which
 * is what makes it worth pushing into a prompt: it is information neither
 * file's own diff contains.
 */
export type ChangeEdge =
	| {
		/** `name` was removed as a declaration in `from` and added as one in `to`. */
		readonly kind: "moved_declaration";
		readonly name: string;
		readonly from: string;
		readonly fromLine: number;
		readonly to: string;
		readonly toLine: number;
	}
	| {
		/** `name` was removed as a declaration in `removedIn` and is still
		 *  referenced in `referencedIn`, which does not declare it. */
		readonly kind: "stale_reference";
		readonly name: string;
		readonly removedIn: string;
		readonly removedLine: number;
		readonly referencedIn: string;
		readonly referenceLine: number;
		readonly referenceSide: ReferenceSide;
	}
	| {
		/** `from` was renamed to `to`, and the old path's stem still appears in
		 *  `referencedIn` (a stale import specifier or path literal). */
		readonly kind: "renamed_path_reference";
		readonly from: string;
		readonly to: string;
		readonly referencedIn: string;
		readonly referenceLine: number;
		readonly referenceSide: ReferenceSide;
	};

export interface ChangeMapOptions {
	/** Caller's explicit exclude patterns. A deleted file matching them stays
	 *  out of the map even though selection reports it as `deleted`. */
	readonly exclude?: readonly string[];
	/** Global ceiling on facts kept in the artifact. */
	readonly maxFacts?: number;
	/** Per-file ceiling on declaration facts kept for one file. */
	readonly maxFactsPerFile?: number;
	/** Global ceiling on joined edges kept in the artifact. */
	readonly maxEdges?: number;
}

export interface ChangeMap {
	/** Deterministically ordered facts (path, kind, line, name, change). */
	readonly facts: readonly ChangeFact[];
	/** Deterministically ordered cross-file edges. This is what prompts see. */
	readonly edges: readonly ChangeEdge[];
	/** Facts excluded by the per-file or global caps. */
	readonly droppedFacts: number;
	/** Edges excluded by the global cap. */
	readonly droppedEdges: number;
	/** True when any fact or edge was dropped by the caps. */
	readonly truncated: boolean;
}

export interface ChangeMapRenderOptions {
	/** UTF-8 byte ceiling for one rendered per-file slice. */
	readonly maxBytes?: number;
}

/** The change map gets its own evidence ceiling; it does not reuse the host-evidence prompt budget. */
export const DEFAULT_CHANGE_MAP_BYTES = 4_000;
export const DEFAULT_MAX_CHANGE_MAP_FACTS = 200;
export const DEFAULT_MAX_CHANGE_MAP_FACTS_PER_FILE = 20;
export const DEFAULT_MAX_CHANGE_MAP_EDGES = 60;

/**
 * Join-side ceilings. These bound work and memory on pathological diffs; they
 * are deliberately far above the fact caps, because dropping a declaration
 * from the rendered fact list is cosmetic while dropping one from the join
 * index silently loses an edge.
 */
const MAX_INDEXED_DECLARATIONS_PER_FILE = 2_000;
const MAX_INDEXED_REFERENCES_PER_FILE = 20_000;
const MAX_RENAME_STEMS = 50;

const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** True when `charCode` would continue an identifier ([A-Za-z0-9_$]). NaN (end of string) returns false. */
function isIdentifierContinue(charCode: number): boolean {
	return (
		(charCode >= 48 && charCode <= 57) || // 0-9
		(charCode >= 65 && charCode <= 90) || // A-Z
		(charCode >= 97 && charCode <= 122) || // a-z
		charCode === 95 || // _
		charCode === 36 // $
	);
}

/**
 * Language built-ins and ambient globals. A token match on one of these is
 * essentially guaranteed to be a coincidence rather than a reference to the
 * removed declaration, so they never produce an edge. This list is
 * deliberately restricted to universal names — domain words like `Config` or
 * `parse` are handled by the shape heuristic below, not by a curated denylist
 * that would have to grow forever.
 */
const AMBIENT_IDENTIFIERS: ReadonlySet<string> = new Set([
	"Array", "Boolean", "Buffer", "Date", "Error", "Function", "JSON", "Map", "Math",
	"Number", "Object", "Promise", "Proxy", "Reflect", "RegExp", "Set", "String",
	"Symbol", "WeakMap", "WeakSet", "console", "document", "globalThis", "process",
	"require", "self", "super", "this", "window",
]);

/**
 * Conventional filenames that repeat across directories, so a path-stem match
 * carries no information about which file was meant.
 */
const AMBIENT_PATH_STEMS: ReadonlySet<string> = new Set([
	"constants", "helpers", "index", "init", "main", "mod", "test", "tests",
	"types", "util", "utils",
]);

/**
 * Is an identifier distinctive enough that a bare token match is worth
 * reporting?
 *
 * The declaration side of the join is precise (it matched an export/def
 * pattern); the reference side is a bare token match and is where false
 * positives come from. Short, all-lowercase, single-word names (`parse`,
 * `load`, `config`) collide with unrelated locals constantly, so they are
 * rejected. Names carrying a case boundary, an underscore, or real length are
 * specific enough that a collision is unlikely.
 *
 * This trades recall for precision on purpose: a rename of `parse` will not
 * produce an edge. That is the correct direction for a reviewer whose entire
 * thesis is that silence beats a plausible false positive.
 */
function isDistinctiveIdentifier(name: string): boolean {
	if (name.length < 4 || AMBIENT_IDENTIFIERS.has(name)) return false;
	if (name.includes("_") || name.includes("$")) return true;
	// A case boundary (camelCase) or a leading capital (PascalCase, so
	// type-like) both mark a composed, domain-specific name.
	if (/[a-z][A-Z]/.test(name) || /^[A-Z]/.test(name)) return true;
	return name.length >= 10;
}

type FactVisibility = "full" | "deleted" | "metadata" | "none";

/**
 * Eligibility is a property of the selection decision, so a caller's include
 * and exclude policy, safety checks, and size/line limits all apply before a
 * single byte of a file becomes map evidence.
 *
 * - `selected`: file facts plus lexical declarations (added and removed).
 * - `deleted`: the deletion fact plus removed declarations from the diff.
 *   Deleted files cannot be reviewed, but their safe metadata and diff-derived
 *   removed declarations are useful, bounded orientation for callers.
 * - `metadata`: default-policy skips (unsupported extension, default path,
 *   size/line limits) contribute rename/new/deleted metadata only, never
 *   content-derived declarations.
 * - `none`: unsafe paths, binary files, explicit user excludes, and
 *   size-unknown files are invisible to the map.
 */
function visibilityForReason(reason: SelectionReason): FactVisibility {
	switch (reason) {
		case SELECTION_REASON.selected:
			return "full";
		case SELECTION_REASON.deleted:
			return "deleted";
		case SELECTION_REASON.unsupportedExtension:
		case SELECTION_REASON.defaultPath:
		case SELECTION_REASON.sizeLimit:
		case SELECTION_REASON.changedLinesLimit:
			return "metadata";
		case SELECTION_REASON.unsafePath:
		case SELECTION_REASON.binary:
		case SELECTION_REASON.userExclude:
		case SELECTION_REASON.sizeUnknown:
			return "none";
		default:
			return "none";
	}
}

/**
 * Conservative, extension-scoped declaration patterns. Each pattern returns
 * exactly one identifier (capture group 1). The table is deliberately small:
 * it proves a handful of high-confidence languages instead of advertising
 * broad language support. Extraction is lexical; nested or quoted matches are
 * possible, which is why facts render as LEXICAL.
 */
interface DeclarationPattern {
	readonly extensions: readonly string[];
	readonly category: DeclarationCategory;
	readonly pattern: RegExp;
}

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

const DECLARATION_PATTERNS: readonly DeclarationPattern[] = [
	// TypeScript/JavaScript: exported declarations only. A non-exported symbol
	// cannot be imported, so it is not cross-file orientation; the current
	// file's diff already shows its own local changes.
	{
		extensions: TYPESCRIPT_EXTENSIONS,
		category: "function",
		pattern: /^export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
	},
	{
		extensions: TYPESCRIPT_EXTENSIONS,
		category: "class",
		pattern: /^export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
	},
	{
		extensions: TYPESCRIPT_EXTENSIONS,
		category: "type",
		pattern: /^export\s+(?:default\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
	},
	{
		extensions: TYPESCRIPT_EXTENSIONS,
		category: "value",
		pattern: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
	},
	{
		extensions: TYPESCRIPT_EXTENSIONS,
		category: "export",
		pattern: /^export\s*(?:type\s+)?\{\s*([A-Za-z_$][\w$]*)/,
	},
	// Python: module-level def/class. Patterns are anchored at line start, so
	// indented (nested or closure-local) defs are deliberately skipped; only
	// module-level definitions are importable cross-file.
	{
		extensions: [".py", ".pyi"],
		category: "function",
		pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
	},
	{
		extensions: [".py", ".pyi"],
		category: "class",
		pattern: /^class\s+([A-Za-z_]\w*)/,
	},
	// Go: func (including methods) and type declarations. var/const are
	// skipped because block-scoped assignments are common inside functions.
	{
		extensions: [".go"],
		category: "function",
		pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
	},
	{
		extensions: [".go"],
		category: "type",
		pattern: /^type\s+([A-Za-z_]\w*)/,
	},
	// Rust: fn (pub/async/unsafe variants included) and struct/enum/trait.
	// impl blocks are not symbols and are intentionally not matched.
	{
		extensions: [".rs"],
		category: "function",
		pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
	},
	{
		extensions: [".rs"],
		category: "type",
		pattern: /^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
	},
];

/**
 * Build the deterministic change map from selection decisions. Total over
 * well-typed input: malformed records are skipped, never thrown on. The
 * artifact is capped at `maxFacts` facts total and `maxFactsPerFile`
 * declarations per file, with an exact count of what was dropped so renderers
 * can surface an honest truncation notice.
 */
export function buildChangeMap(
	decisions: readonly SelectionDecision[],
	options: ChangeMapOptions = {},
): ChangeMap {
	const maxFacts = finiteNonNegative(options.maxFacts, DEFAULT_MAX_CHANGE_MAP_FACTS);
	const maxFactsPerFile = finiteNonNegative(options.maxFactsPerFile, DEFAULT_MAX_CHANGE_MAP_FACTS_PER_FILE);
	const maxEdges = finiteNonNegative(options.maxEdges, DEFAULT_MAX_CHANGE_MAP_EDGES);
	const exclude = Array.isArray(options.exclude) ? options.exclude : [];

	const eligible: Array<{ path: string; file: ChangedFile; visibility: FactVisibility }> = [];
	for (const decision of decisions) {
		if (!isUsableDecision(decision)) continue;
		let visibility = visibilityForReason(decision.reason);
		// A deleted file that also matches the caller's exclude patterns is
		// reported as `deleted` by selection (deletion is checked before user
		// patterns). Its diff-derived declarations are still excluded-file
		// content, so honor the explicit boundary here as well.
		if (visibility === "deleted" && matchesUserExclude(decision.path, exclude)) {
			visibility = "none";
		}
		if (visibility === "none") continue;
		eligible.push({ path: decision.path, file: decision.file, visibility });
	}

	// Rename stems must be known before the content pass so a single walk over
	// each file's lines can look for both identifiers and stale path literals.
	const renameStems = collectRenameStems(eligible);

	const collected: ChangeFact[] = [];
	const indexes: FileIndex[] = [];
	let dropped = 0;

	for (const { path, file, visibility } of eligible) {
		const fileFacts: ChangeFact[] = [];
		if (file.isRenamed === true) {
			fileFacts.push({ kind: "rename", from: normalizePath(file.oldPath), to: path });
		}
		if (file.isNew === true) {
			fileFacts.push({ kind: "new_file", path });
		}
		if (file.isDeleted === true) {
			fileFacts.push({ kind: "deleted_file", path });
		}

		if (visibility === "full" || visibility === "deleted") {
			const index = indexFile(path, file, visibility, renameStems);
			indexes.push(index);
			let declarations = 0;
			for (const fact of index.declarationFacts) {
				if (declarations < maxFactsPerFile) {
					declarations += 1;
					fileFacts.push(fact);
				} else {
					dropped += 1;
				}
			}
		}

		collected.push(...fileFacts);
	}

	const sorted = [...collected].sort(compareFacts);
	const kept = maxFacts >= sorted.length ? sorted : sorted.slice(0, maxFacts);
	dropped += sorted.length - kept.length;

	const joined = joinEdges(indexes, renameStems);
	const keptEdges = maxEdges >= joined.length ? joined : joined.slice(0, maxEdges);
	const droppedEdges = joined.length - keptEdges.length;

	return {
		facts: kept,
		edges: keptEdges,
		droppedFacts: dropped,
		droppedEdges,
		truncated: dropped > 0 || droppedEdges > 0,
	};
}

/**
 * Per-file join index. Declarations come from the precise pattern table;
 * references are bare identifier tokens, which is why only distinctive names
 * are indexed on the reference side.
 */
interface FileIndex {
	readonly path: string;
	readonly declarationFacts: readonly Extract<ChangeFact, { kind: "declaration" }>[];
	/** name -> target-side line of the added declaration. */
	readonly added: ReadonlyMap<string, number>;
	/** name -> source-side line of the removed declaration. */
	readonly removed: ReadonlyMap<string, number>;
	/** name -> where the identifier appears outside deleted lines. */
	readonly references: ReadonlyMap<string, { side: ReferenceSide; line: number }>;
	/** old-path stem -> where that stem still appears in this file. */
	readonly pathReferences: ReadonlyMap<string, { side: ReferenceSide; line: number }>;
}

interface RenameStem {
	readonly stem: string;
	readonly from: string;
	readonly to: string;
}

/**
 * Renames are matched on the basename stem rather than the full repository
 * path, because a stale reference almost always appears as a module specifier
 * (`./old-name.js`) that shares no prefix with the repository-relative path.
 */
function collectRenameStems(
	eligible: readonly { path: string; file: ChangedFile }[],
): readonly RenameStem[] {
	const stems: RenameStem[] = [];
	const seen = new Set<string>();
	for (const { path, file } of eligible) {
		if (file.isRenamed !== true || stems.length >= MAX_RENAME_STEMS) continue;
		const from = normalizePath(file.oldPath);
		const stem = pathStem(from);
		// A pure directory move keeps the stem, so the stem cannot distinguish
		// old from new and would match the file's own updated imports.
		if (stem.length < 4 || AMBIENT_PATH_STEMS.has(stem) || stem === pathStem(path)) continue;
		if (seen.has(stem)) continue;
		seen.add(stem);
		stems.push({ stem, from, to: path });
	}
	return stems;
}

function indexFile(
	path: string,
	file: ChangedFile,
	visibility: FactVisibility,
	renameStems: readonly RenameStem[],
): FileIndex {
	const declarationFacts: Array<Extract<ChangeFact, { kind: "declaration" }>> = [];
	const added = new Map<string, number>();
	const removed = new Map<string, number>();
	const references = new Map<string, { side: ReferenceSide; line: number }>();
	const pathReferences = new Map<string, { side: ReferenceSide; line: number }>();

	for (const hunk of hunksOf(file)) {
		for (const line of linesOf(hunk)) {
			const fact = extractDeclaration(path, line);
			if (fact !== undefined && declarationFacts.length < MAX_INDEXED_DECLARATIONS_PER_FILE) {
				declarationFacts.push(fact);
				const target = fact.change === "added" ? added : removed;
				if (!target.has(fact.name)) target.set(fact.name, fact.line);
			}

			// A deleted line is not a reference: the change is removing it, so
			// it cannot be left dangling. Only a deleted file's own removed
			// declarations matter, and those come from the pattern table above.
			if (line.kind === "deletion" || visibility !== "full") continue;
			if (typeof line.text !== "string") continue;
			const lineNumber = line.newLine;
			if (typeof lineNumber !== "number" || !Number.isFinite(lineNumber) || lineNumber <= 0) continue;
			const side: ReferenceSide = line.kind === "addition" ? "added" : "existing";

			if (references.size < MAX_INDEXED_REFERENCES_PER_FILE) {
				IDENTIFIER_PATTERN.lastIndex = 0;
				let match = IDENTIFIER_PATTERN.exec(line.text);
				while (match !== null) {
					const name = match[0];
					if (isDistinctiveIdentifier(name)) recordReference(references, name, side, lineNumber);
					match = IDENTIFIER_PATTERN.exec(line.text);
				}
			}
			if (renameStems.length > 0) {
				// Stems are lowercased so the comparison survives case-insensitive
				// filesystems and import specifiers that differ only in case.
				// A bare `includes` would match `auth` inside `authenticate`, so
				// require the character after the hit to be a path/quote boundary
				// rather than an identifier continuation.
				const lowered = line.text.toLowerCase();
				for (const { stem } of renameStems) {
					const at = lowered.indexOf(stem);
					if (at < 0) continue;
					const after = lowered.charCodeAt(at + stem.length);
					// Allow end-of-string (NaN), path delimiters, extensions,
					// quotes, whitespace — anything that is not an identifier
					// continuation character.
					if (isIdentifierContinue(after)) continue;
					recordReference(pathReferences, stem, side, lineNumber);
				}
			}
		}
	}

	return { path, declarationFacts, added, removed, references, pathReferences };
}

/** Keep the strongest evidence: an added reference outranks an existing one, and the earliest line wins within a side. */
function recordReference(
	into: Map<string, { side: ReferenceSide; line: number }>,
	name: string,
	side: ReferenceSide,
	line: number,
): void {
	const current = into.get(name);
	if (current === undefined) {
		into.set(name, { side, line });
		return;
	}
	if (current.side === side) {
		if (line < current.line) into.set(name, { side, line });
		return;
	}
	if (side === "added") into.set(name, { side, line });
}

/**
 * The join. For every declaration a file removes, look for the same name in
 * every other file's index; for every rename, look for the old stem.
 *
 * Both sides are hash lookups, so this is linear in (removed declarations x
 * files) rather than in diff size.
 */
function joinEdges(
	indexes: readonly FileIndex[],
	renameStems: readonly RenameStem[],
): readonly ChangeEdge[] {
	const edges: ChangeEdge[] = [];

	for (const source of indexes) {
		for (const [name, removedLine] of source.removed) {
			// The same file re-declaring the name means the declaration was
			// edited in place, not removed. That is not a cross-file signal.
			if (source.added.has(name)) continue;
			if (!isDistinctiveIdentifier(name)) continue;

			for (const other of indexes) {
				if (other.path === source.path) continue;
				// A file that also removes the name is editing or retiring it
				// itself. If it adds it back, that is an in-place edit, not a
				// move from `source`; if it doesn't, its remaining mentions are
				// stale because of its own removal, not `source`'s. Either way
				// the cross-file edge to this file would be misleading.
				if (other.removed.has(name)) continue;
				const movedTo = other.added.get(name);
				if (movedTo !== undefined) {
					edges.push({
						kind: "moved_declaration",
						name,
						from: source.path,
						fromLine: removedLine,
						to: other.path,
						toLine: movedTo,
					});
					continue;
				}
				const reference = other.references.get(name);
				if (reference === undefined) continue;
				edges.push({
					kind: "stale_reference",
					name,
					removedIn: source.path,
					removedLine,
					referencedIn: other.path,
					referenceLine: reference.line,
					referenceSide: reference.side,
				});
			}
		}
	}

	for (const { stem, from, to } of renameStems) {
		for (const other of indexes) {
			// The renamed file's own remaining mentions of its old stem are its
			// own business and already visible in its diff.
			if (other.path === to) continue;
			const reference = other.pathReferences.get(stem);
			if (reference === undefined) continue;
			edges.push({
				kind: "renamed_path_reference",
				from,
				to,
				referencedIn: other.path,
				referenceLine: reference.line,
				referenceSide: reference.side,
			});
		}
	}

	return edges.sort(compareEdges);
}

/**
 * Render the slice for one review file: only the edges that touch it.
 *
 * Everything else in the map is deliberately withheld. A reviewer that wants
 * to know what changed in another file can call `file_read_diff` and get a
 * verified answer, so pushing an unjoined declaration list into every prompt
 * costs tokens on every file to deliver something weaker than what the model
 * can already fetch on the rare occasion it matters. An edge is different: it
 * is a relationship neither file's own diff contains.
 *
 * The consequence, and the point, is that this returns "" for most files.
 *
 * The output is plain text; prompt framing (fencing, labels) is owned by
 * prompts.ts.
 */
export function renderChangeMapSlice(
	map: ChangeMap,
	currentFilePath: string,
	options: ChangeMapRenderOptions = {},
): string {
	if (!Array.isArray(map.edges) || map.edges.length === 0) return "";
	const maxBytes = finiteNonNegative(options.maxBytes, DEFAULT_CHANGE_MAP_BYTES);
	const current = typeof currentFilePath === "string" ? currentFilePath : "";

	// Sections are ordered by how directly they bear on the current file's own
	// added lines, which is also the truncation priority.
	const referencesRemovedElsewhere: string[] = [];
	const removedHereStillReferenced: string[] = [];
	const stalePaths: string[] = [];
	const moved: string[] = [];

	for (const edge of map.edges) {
		if (edge.kind === "stale_reference") {
			if (edge.referencedIn === current) {
				referencesRemovedElsewhere.push(
					`LEXICAL  ${edge.name}: removed in ${edge.removedIn} (line ${edge.removedLine}); referenced here on ${edge.referenceSide} line ${edge.referenceLine}`,
				);
			} else if (edge.removedIn === current) {
				removedHereStillReferenced.push(
					`LEXICAL  ${edge.name}: removed here (line ${edge.removedLine}); referenced in ${edge.referencedIn} on ${edge.referenceSide} line ${edge.referenceLine}`,
				);
			}
			continue;
		}
		if (edge.kind === "renamed_path_reference") {
			if (edge.referencedIn === current) {
				stalePaths.push(
					`LEXICAL  ${edge.from} was renamed to ${edge.to}; the old name still appears here on ${edge.referenceSide} line ${edge.referenceLine}`,
				);
			}
			continue;
		}
		if (edge.from === current) {
			moved.push(`LEXICAL  ${edge.name}: removed here (line ${edge.fromLine}), added in ${edge.to} (line ${edge.toLine})`);
		} else if (edge.to === current) {
			moved.push(`LEXICAL  ${edge.name}: added here (line ${edge.toLine}), removed in ${edge.from} (line ${edge.fromLine})`);
		}
	}

	const sections: Array<{ header: string; body: readonly string[] }> = [
		{ header: "Symbols this file references that another changed file removed:", body: referencesRemovedElsewhere },
		{ header: "Renamed files whose old name still appears in this file:", body: stalePaths },
		{ header: "Declarations this file removed that another changed file still references:", body: removedHereStillReferenced },
		{ header: "Declarations that may have moved between changed files:", body: moved },
	];
	if (sections.every((section) => section.body.length === 0)) return "";

	const lines = [
		"Cross-file change map (LEXICAL: token-level signals across the change, with no type or import resolution behind them; confirm with file_read_diff or code_search before relying on any line here):",
	];
	for (const { header, body } of sections) {
		if (body.length === 0) continue;
		lines.push(header);
		for (const line of body) lines.push(`  ${line}`);
	}

	const baseText = lines.join("\n");

	// Fast path: everything fits and nothing was dropped at construction.
	if (byteLength(baseText) <= maxBytes && map.droppedEdges === 0) return baseText;

	// Truncation path. Reserve room for a worst-case notice so the final text
	// plus notice is guaranteed to fit in one pass; the notice itself is then
	// built from the exact number of edges that are no longer fully present.
	const MAX_NOTICE_BYTES = 48; // "(truncated: <N> edges omitted)" for N < 10^20
	const budget = maxBytes - MAX_NOTICE_BYTES;
	if (budget <= 0) return truncateUtf8(baseText, maxBytes);

	const fitted = fitLines(lines, budget);
	const total = map.droppedEdges + omittedEdgeLineCount(lines, fitted);
	const notice = `(truncated: ${total} edge${total === 1 ? "" : "s"} omitted)`;
	return `${fitted}\n${notice}`;
}

/**
 * Number of edge lines no longer fully present in `text`. The map renders
 * exactly one line per edge, so an edge line either appears verbatim in the
 * final text or it was dropped or byte-cut.
 */
function omittedEdgeLineCount(lines: readonly string[], text: string): number {
	let omitted = 0;
	for (const line of lines) {
		if (line.startsWith("  LEXICAL") && !text.includes(line)) omitted += 1;
	}
	return omitted;
}

/** Drop trailing lines until the joined text fits `maxBytes`; keep the header. */
function fitLines(lines: readonly string[], maxBytes: number): string {
	let keep = lines.length;
	let bytes = byteLength(lines.join("\n"));
	while (keep > 1 && bytes > maxBytes) {
		keep -= 1;
		bytes -= byteLength(lines[keep] ?? "") + 1;
	}
	// A section header whose facts were all dropped is empty noise; drop it
	// too (never the map header itself).
	while (keep > 1 && isSectionHeader(lines[keep - 1] ?? "")) {
		keep -= 1;
	}
	let text = lines.slice(0, keep).join("\n");
	if (byteLength(text) > maxBytes) {
		text = truncateUtf8(text, maxBytes);
	}
	return text;
}

function isSectionHeader(line: string): boolean {
	return !line.startsWith("  ") && line.endsWith(":");
}

function factPath(fact: ChangeFact): string {
	switch (fact.kind) {
		case "rename":
			return fact.to;
		case "new_file":
		case "deleted_file":
		case "declaration":
			return fact.path;
	}
}

function factKindRank(fact: ChangeFact): number {
	switch (fact.kind) {
		case "rename":
			return 0;
		case "new_file":
			return 1;
		case "deleted_file":
			return 2;
		case "declaration":
			return 3;
	}
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function compareFacts(left: ChangeFact, right: ChangeFact): number {
	const pathOrder = compareText(factPath(left), factPath(right));
	if (pathOrder !== 0) return pathOrder;
	const kindOrder = factKindRank(left) - factKindRank(right);
	if (kindOrder !== 0) return kindOrder;
	if (left.kind === "declaration" && right.kind === "declaration") {
		if (left.line !== right.line) return left.line - right.line;
		const nameOrder = compareText(left.name, right.name);
		if (nameOrder !== 0) return nameOrder;
		if (left.change !== right.change) return left.change === "added" ? -1 : 1;
		const categoryOrder = compareText(left.category, right.category);
		if (categoryOrder !== 0) return categoryOrder;
	}
	return 0;
}

/**
 * Edge ordering is total and content-derived, so the artifact is identical
 * regardless of the order selection hands files over.
 */
function compareEdges(left: ChangeEdge, right: ChangeEdge): number {
	const kindOrder = edgeKindRank(left) - edgeKindRank(right);
	if (kindOrder !== 0) return kindOrder;
	for (const key of ["name", "from", "to", "removedIn", "referencedIn"] as const) {
		const order = compareText(edgeField(left, key), edgeField(right, key));
		if (order !== 0) return order;
	}
	return edgeLine(left) - edgeLine(right);
}

function edgeKindRank(edge: ChangeEdge): number {
	switch (edge.kind) {
		case "stale_reference":
			return 0;
		case "renamed_path_reference":
			return 1;
		case "moved_declaration":
			return 2;
	}
}

function edgeField(edge: ChangeEdge, key: "name" | "from" | "to" | "removedIn" | "referencedIn"): string {
	const value: unknown = (edge as unknown as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

function edgeLine(edge: ChangeEdge): number {
	switch (edge.kind) {
		case "stale_reference":
		case "renamed_path_reference":
			return edge.referenceLine;
		case "moved_declaration":
			return edge.fromLine;
	}
}

/** Basename without its extension, lowercased for case-insensitive filesystems. */
function pathStem(path: string): string {
	const normalized = normalizePath(path);
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	const dot = basename.lastIndexOf(".");
	return (dot <= 0 ? basename : basename.slice(0, dot)).toLowerCase();
}

function extractDeclaration(
	path: string,
	line: DiffLine | undefined,
): Extract<ChangeFact, { kind: "declaration" }> | undefined {
	if (line === undefined || (line.kind !== "addition" && line.kind !== "deletion")) return undefined;
	const lineNumber = line.kind === "addition" ? line.newLine : line.oldLine;
	if (typeof lineNumber !== "number" || !Number.isFinite(lineNumber) || lineNumber <= 0) {
		return undefined;
	}
	if (typeof line.text !== "string") return undefined;
	for (const pattern of patternsForPath(path)) {
		const match = pattern.pattern.exec(line.text);
		const name = match?.[1];
		if (name === undefined || name.length === 0) continue;
		return {
			kind: "declaration",
			path,
			name,
			category: pattern.category,
			line: lineNumber,
			change: line.kind === "addition" ? "added" : "removed",
		};
	}
	return undefined;
}

function patternsForPath(path: string): DeclarationPattern[] {
	const basename = path.slice(path.lastIndexOf("/") + 1);
	const dot = basename.lastIndexOf(".");
	if (dot <= 0) return [];
	const extension = basename.slice(dot).toLowerCase();
	return DECLARATION_PATTERNS.filter((entry) => entry.extensions.includes(extension));
}

function isUsableDecision(decision: SelectionDecision): boolean {
	if (typeof decision !== "object" || decision === null) return false;
	if (typeof decision.path !== "string" || decision.path.length === 0) return false;
	if (typeof decision.reason !== "string") return false;
	const file = decision.file;
	if (typeof file !== "object" || file === null) return false;
	return typeof file.oldPath === "string" && typeof file.newPath === "string";
}

function hunksOf(file: { hunks?: unknown }): ReadonlyArray<{ lines?: unknown }> {
	if (!Array.isArray(file.hunks)) return [];
	const result: Array<{ lines?: unknown }> = [];
	for (const hunk of file.hunks) {
		if (typeof hunk === "object" && hunk !== null) result.push(hunk as { lines?: unknown });
	}
	return result;
}

function linesOf(hunk: { lines?: unknown }): DiffLine[] {
	if (!Array.isArray(hunk.lines)) return [];
	return hunk.lines.filter(
		(line): line is DiffLine => typeof line === "object" && line !== null,
	);
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//u, "");
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/** UTF-8-safe truncation that never splits a surrogate pair. */
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

	if (low > 0 && low < value.length) {
		const previous = value.charCodeAt(low - 1);
		if (previous >= 0xd800 && previous <= 0xdbff) low -= 1;
	}
	return value.slice(0, low);
}

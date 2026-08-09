import {
	SELECTION_REASON,
	matchesUserExclude,
	type SelectionDecision,
	type SelectionReason,
} from "./selection.js";
import type { DiffLine } from "./types.js";

/**
 * Deterministic, host-side cross-file change map.
 *
 * The map is built once from selection decisions — never from raw target
 * files — so the same policy that decides what is reviewable also decides what
 * is eligible for cross-file orientation. It is passive evidence only:
 * renames, new/deleted files, and conservative lexical declaration changes.
 * It is never a verified semantic fact, never a finding, and it must not
 * change review scope, anchoring, or coverage.
 *
 * Facts are intentionally labeled at render time: FACT for host metadata and
 * LEXICAL for approximate pattern matches.
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

export interface ChangeMapOptions {
	/** Caller's explicit exclude patterns. A deleted file matching them stays
	 *  out of the map even though selection reports it as `deleted`. */
	readonly exclude?: readonly string[];
	/** Global ceiling on facts kept in the artifact. */
	readonly maxFacts?: number;
	/** Per-file ceiling on declaration facts kept for one file. */
	readonly maxFactsPerFile?: number;
}

export interface ChangeMap {
	/** Deterministically ordered facts (path, kind, line, name, change). */
	readonly facts: readonly ChangeFact[];
	/** Facts excluded by the per-file or global caps. */
	readonly droppedFacts: number;
	/** True when any fact was dropped by the caps. */
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
	const exclude = Array.isArray(options.exclude) ? options.exclude : [];

	const collected: ChangeFact[] = [];
	let dropped = 0;

	for (const decision of decisions) {
		if (!isUsableDecision(decision)) continue;
		const path = decision.path;

		let visibility = visibilityForReason(decision.reason);
		// A deleted file that also matches the caller's exclude patterns is
		// reported as `deleted` by selection (deletion is checked before user
		// patterns). Its diff-derived declarations are still excluded-file
		// content, so honor the explicit boundary here as well.
		if (visibility === "deleted" && matchesUserExclude(path, exclude)) {
			visibility = "none";
		}
		if (visibility === "none") continue;

		const file = decision.file;
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
			let declarations = 0;
			for (const hunk of hunksOf(file)) {
				for (const line of linesOf(hunk)) {
					const fact = extractDeclaration(path, line);
					if (fact === undefined) continue;
					if (declarations < maxFactsPerFile) {
						declarations += 1;
						fileFacts.push(fact);
					} else {
						dropped += 1;
					}
				}
			}
		}

		collected.push(...fileFacts);
	}

	const sorted = [...collected].sort(compareFacts);
	const kept = maxFacts >= sorted.length ? sorted : sorted.slice(0, maxFacts);
	dropped += sorted.length - kept.length;
	return { facts: kept, droppedFacts: dropped, truncated: dropped > 0 };
}

/**
 * Render the slice for one review file: its own facts first, then other
 * files' facts grouped by category, deterministically. The output is plain
 * text; prompt framing (fencing, labels) is owned by prompts.ts. An empty map
 * renders as an empty string so prompts can show "(none supplied)".
 */
export function renderChangeMapSlice(
	map: ChangeMap,
	currentFilePath: string,
	options: ChangeMapRenderOptions = {},
): string {
	if (!Array.isArray(map.facts) || map.facts.length === 0) return "";
	const maxBytes = finiteNonNegative(options.maxBytes, DEFAULT_CHANGE_MAP_BYTES);
	const current = typeof currentFilePath === "string" ? currentFilePath : "";

	const deletedPaths = new Set(
		map.facts
			.filter((fact): fact is Extract<ChangeFact, { kind: "deleted_file" }> => fact.kind === "deleted_file")
			.map((fact) => fact.path),
	);

	const thisFile: string[] = [];
	const deleted: string[] = [];
	const renamed: string[] = [];
	const newFiles: string[] = [];
	const otherDeclarations: string[] = [];

	for (const fact of map.facts) {
		if (factPath(fact) === current) {
			thisFile.push(renderFactLine(fact));
		} else if (fact.kind === "deleted_file") {
			deleted.push(renderFactLine(fact));
		} else if (fact.kind === "rename") {
			renamed.push(renderFactLine(fact));
		} else if (fact.kind === "new_file") {
			newFiles.push(renderFactLine(fact));
		} else if (deletedPaths.has(fact.path)) {
			deleted.push(renderFactLine(fact));
		} else {
			otherDeclarations.push(renderFactLine(fact));
		}
	}

	// Section order is also truncation priority: the current file's own facts
	// survive first, then deletions, renames, other declarations, new files.
	const lines = [
		"Cross-file change map (FACT = host metadata, LEXICAL = approximate match; untrusted orientation, may be truncated):",
	];
	if (thisFile.length > 0) {
		lines.push(`This file (${current}):`);
		for (const line of thisFile) lines.push(`  ${line}`);
	}
	if (deleted.length > 0) {
		lines.push("Deleted files:");
		for (const line of deleted) lines.push(`  ${line}`);
	}
	if (renamed.length > 0) {
		lines.push("Renamed files:");
		for (const line of renamed) lines.push(`  ${line}`);
	}
	if (otherDeclarations.length > 0) {
		lines.push("Other changed declarations:");
		for (const line of otherDeclarations) lines.push(`  ${line}`);
	}
	if (newFiles.length > 0) {
		lines.push("New files:");
		for (const line of newFiles) lines.push(`  ${line}`);
	}

	const baseText = lines.join("\n");
	const baseBytes = byteLength(baseText);

	// Fast path: everything fits and nothing was dropped at construction.
	if (baseBytes <= maxBytes && map.droppedFacts === 0) return baseText;

	// Truncation path. Reserve room for a worst-case notice so the final text
	// plus notice is guaranteed to fit in one pass; the notice itself is then
	// built from the exact number of facts that are no longer fully present.
	const MAX_NOTICE_BYTES = 48; // "(truncated: <N> facts omitted)" for N < 10^20
	const budget = maxBytes - MAX_NOTICE_BYTES;
	if (budget <= 0) return truncateUtf8(baseText, maxBytes);

	const fitted = fitLines(lines, budget);
	const total = map.droppedFacts + omittedFactLineCount(lines, fitted);
	const notice = `(truncated: ${total} fact${total === 1 ? "" : "s"} omitted)`;
	return `${fitted}\n${notice}`;
}

/**
 * Number of fact lines no longer fully present in `text`. The map renders
 * exactly one unique line per fact, so a fact line either appears verbatim in
 * the final text or it was dropped or byte-cut.
 */
function omittedFactLineCount(lines: readonly string[], text: string): number {
	let omitted = 0;
	for (const line of lines) {
		if ((line.startsWith("  FACT") || line.startsWith("  LEXICAL")) && !text.includes(line)) {
			omitted += 1;
		}
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

function renderFactLine(fact: ChangeFact): string {
	switch (fact.kind) {
		case "rename":
			return `FACT  renamed: ${fact.from} -> ${fact.to}`;
		case "new_file":
			return `FACT  new file: ${fact.path}`;
		case "deleted_file":
			return `FACT  deleted: ${fact.path}`;
		case "declaration":
			return `LEXICAL  ${fact.path}: ${fact.category} ${fact.name} ${fact.change} (line ${fact.line})`;
	}
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

function extractDeclaration(path: string, line: DiffLine | undefined): ChangeFact | undefined {
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

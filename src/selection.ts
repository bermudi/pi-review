import { minimatch } from "minimatch";

import type { ChangedFile, SkippedFile } from "./types.js";

/** File types shipped in Open Code Review's precision-oriented allowlist. */
export const DEFAULT_EXTENSIONS = [
	".java",
	".kt",
	".kts",
	".scala",
	".groovy",
	".py",
	".pyi",
	".js",
	".jsx",
	".ts",
	".tsx",
	".mjs",
	".cjs",
	".c",
	".h",
	".cpp",
	".cc",
	".cxx",
	".hpp",
	".hxx",
	".cs",
	".vb",
	".fs",
	".go",
	".rs",
	".rb",
	".rake",
	".gemspec",
	".php",
	".phtml",
	".swift",
	".m",
	".mm",
	".sh",
	".bash",
	".zsh",
	".fish",
	".ps1",
	".sql",
	".css",
	".scss",
	".sass",
	".less",
	".html",
	".htm",
	".ftl",
	".ftlh",
	".ftlx",
	".astro",
	".vue",
	".svelte",
	".xml",
	".yaml",
	".yml",
	".json",
	".toml",
	".ini",
	".env",
	".gradle",
	".cmake",
	".r",
	".lua",
	".pl",
	".pm",
	".ex",
	".exs",
	".erl",
	".hrl",
	".ets",
	".json5",
	".dart",
	".tf",
	".graphql",
	".gql",
	".prisma",
	".jl",
	".hcl",
	".tfvars",
	".bicep",
	".proto",
] as const;

/** Generated/test paths omitted unless an explicit include admits them. */
export const DEFAULT_PATH_EXCLUDES = [
	"**/*_test.go",
	"**/src/test/java/**/*.java",
	"**/src/test/**/*.kt",
	"**/*.test.{js,jsx,ts,tsx}",
	"**/*.spec.{js,jsx,ts,tsx}",
	"**/__tests__/**",
	"**/test/**/*_test.py",
	"**/tests/**/*_test.py",
	"**/*_test.py",
	"**/*_spec.rb",
	"**/spec/**/*_spec.rb",
	"**/*Test.java",
	"**/*Tests.java",
	"**/*_test.rs",
	"**/oh_modules/**",
	"**/*.test.ets",
	"**/test/**/*.jl",
	"**/__snapshots__/**",
	"**/*.snap",
	"**/testdata/**",
	"**/fixtures/**",
	"**/*.generated.*",
	"**/*.gen.go",
	"**/*.pb.go",
	"**/*.pb.cc",
	"**/*.pb.h",
] as const;

export const DEFAULT_FILENAMES = ["Makefile"] as const;

/** Stable reason values used in selection decisions and pre-dispatch exclusion coverage. */
export const SELECTION_REASON = {
	selected: "selected",
	unsafePath: "unsafe_path",
	binary: "binary",
	deleted: "deleted",
	userExclude: "user_exclude",
	unsupportedExtension: "unsupported_ext",
	defaultPath: "default_path",
	changedLinesLimit: "changed_lines_limit",
	sizeLimit: "size_limit",
	sizeUnknown: "size_unknown",
} as const;

export type SelectionReason = (typeof SELECTION_REASON)[keyof typeof SELECTION_REASON];

/**
 * Policy inputs are intentionally independent from ReviewOptions. The
 * orchestration layer can pass its include/exclude values without coupling
 * this pure module to Pi or to the CLI.
 */
export interface SelectionOptions {
	include?: readonly string[];
	exclude?: readonly string[];
	defaultExtensions?: readonly string[];
	defaultPathExcludes?: readonly string[];
	defaultFilenames?: readonly string[];
	maxChangedLines?: number;
	maxFileBytes?: number;
	/** Optional repository-aware check for workspace symlinks and other policy. */
	isSafePath?: (path: string, file: ChangedFile) => boolean;
}

export interface SelectionDecision {
	path: string;
	file: ChangedFile;
	selected: boolean;
	reason: SelectionReason;
}

export interface SelectionResult {
	selected: ChangedFile[];
	skipped: SkippedFile[];
	decisions: SelectionDecision[];
}

/**
 * Select changed files without changing their order or mutating their data.
 *
 * Include patterns are additive overrides, matching the original review
 * policy: a match bypasses only the default extension/path filters. It does
 * not turn the list into a whitelist, and it never bypasses safety, binary,
 * deleted, user-exclude, or explicit size/line limits.
 */
export function selectFiles(
	files: readonly ChangedFile[],
	options: SelectionOptions = {},
): SelectionResult {
	const selected: ChangedFile[] = [];
	const skipped: SkippedFile[] = [];
	const decisions: SelectionDecision[] = [];

	for (const file of files) {
		const decision = decideFileSelection(file, options);
		decisions.push(decision);
		if (decision.selected) {
			selected.push(file);
		} else {
			skipped.push({ path: decision.path, reason: decision.reason });
		}
	}

	return { selected, skipped, decisions };
}

/** Alias that reads naturally at the review orchestration boundary. */
export const selectReviewFiles = selectFiles;

/** Evaluate one file, useful for table-driven policy tests and previews. */
export function decideFileSelection(
	file: ChangedFile,
	options: SelectionOptions = {},
): SelectionDecision {
	const path = effectivePath(file);
	const unsafe =
		!isSafeReviewPath(path) ||
		!isSafeChangedFilePath(file.oldPath) ||
		!isSafeChangedFilePath(file.newPath) ||
		isMarkedSymlink(file);
	if (unsafe || (options.isSafePath !== undefined && !options.isSafePath(path, file))) {
		return decision(file, path, SELECTION_REASON.unsafePath);
	}

	// These are hard exclusions. They are intentionally before all user
	// patterns, so an include cannot make a non-reviewable target reviewable.
	if (file.isBinary) {
		return decision(file, path, SELECTION_REASON.binary);
	}
	if (file.isDeleted) {
		return decision(file, path, SELECTION_REASON.deleted);
	}
	if (matchesAny(path, options.exclude ?? [])) {
		return decision(file, path, SELECTION_REASON.userExclude);
	}

	const explicitlyIncluded = matchesAny(path, options.include ?? []);
	if (!explicitlyIncluded) {
		if (
			!hasSupportedExtension(
				path,
				options.defaultExtensions ?? DEFAULT_EXTENSIONS,
				options.defaultFilenames ?? DEFAULT_FILENAMES,
			)
		) {
			return decision(file, path, SELECTION_REASON.unsupportedExtension);
		}
		if (matchesAny(path, options.defaultPathExcludes ?? DEFAULT_PATH_EXCLUDES)) {
			return decision(file, path, SELECTION_REASON.defaultPath);
		}
	}

	const changedLines = changedLineCount(file);
	if (exceedsLimit(changedLines, options.maxChangedLines)) {
		return decision(file, path, SELECTION_REASON.changedLinesLimit);
	}

	if (options.maxFileBytes !== undefined) {
		if (file.newContent === undefined) {
			return decision(file, path, SELECTION_REASON.sizeUnknown);
		}
		if (exceedsLimit(utf8ByteLength(file.newContent), options.maxFileBytes)) {
			return decision(file, path, SELECTION_REASON.sizeLimit);
		}
	}

	return {
		path,
		file,
		selected: true,
		reason: SELECTION_REASON.selected,
	};
}

/** Lexical safety check shared by selection callers and tests. */
export function isSafeReviewPath(path: string): boolean {
	if (path.length === 0 || path.includes("\0")) {
		return false;
	}
	if (path.startsWith("/") || path.startsWith("\\")) {
		return false;
	}
	// Reject both drive-absolute and drive-relative Windows paths. A Git path
	// is repository-relative regardless of the host operating system.
	if (/^[A-Za-z]:/.test(path)) {
		return false;
	}

	const segments = path.split(/[\\/]/u);
	return !segments.some(
		(segment) =>
			segment.length === 0 || segment === "." || segment === ".." || segment === ".git",
	);
}

function isSafeChangedFilePath(path: string): boolean {
	return path === "" || path === "/dev/null" || isSafeReviewPath(path);
}

/** Count the changed lines used by planning and size policies. */
export function changedLineCount(file: Pick<ChangedFile, "insertions" | "deletions">): number {
	const insertions = nonNegativeFinite(file.insertions) ? file.insertions : 0;
	const deletions = nonNegativeFinite(file.deletions) ? file.deletions : 0;
	return insertions + deletions;
}

function decision(
	file: ChangedFile,
	path: string,
	reason: Exclude<SelectionReason, "selected">,
): SelectionDecision {
	return { path, file, selected: false, reason };
}

function effectivePath(file: Pick<ChangedFile, "oldPath" | "newPath">): string {
	if (file.newPath !== "" && file.newPath !== "/dev/null") {
		return normalizePath(file.newPath);
	}
	return normalizePath(file.oldPath);
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//u, "");
}

function isMarkedSymlink(file: ChangedFile): boolean {
	// ChangedFile deliberately stays a small shared contract. Git acquisition
	// can nevertheless attach this marker at runtime, and the check is kept
	// here so a future repository-aware adapter cannot be bypassed by include.
	const metadata = file as unknown as { isSymlink?: unknown; workspaceSymlink?: unknown };
	return metadata.isSymlink === true || metadata.workspaceSymlink === true;
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
	return patterns.some((rawPattern) => {
		const pattern = normalizePath(rawPattern);
		if (pattern.length === 0) {
			return false;
		}
		return minimatch(path, pattern, {
			dot: true,
			nocase: true,
		});
	});
}

/**
 * Whether a repository-relative path matches any of the caller's explicit
 * exclude patterns. Used by other deterministic policy modules (the change
 * map) to honor the caller's exclusion boundary independently of the reason
 * selection assigned to a file.
 */
export function matchesUserExclude(path: string, patterns: readonly string[]): boolean {
	return matchesAny(path, patterns);
}

function hasSupportedExtension(
	path: string,
	extensions: readonly string[],
	filenames: readonly string[],
): boolean {
	const basename = path.slice(path.lastIndexOf("/") + 1);
	const dot = basename.lastIndexOf(".");
	if (dot < 0) {
		return filenames.some((filename) => filename.toLowerCase() === basename.toLowerCase());
	}

	const extension = dot === 0 ? basename.toLowerCase() : basename.slice(dot).toLowerCase();
	if (extensions.some((candidate) => normalizeExtension(candidate) === extension)) {
		return true;
	}

	return filenames.some((filename) => filename.toLowerCase() === basename.toLowerCase());
}

function normalizeExtension(extension: string): string {
	const trimmed = extension.trim().toLowerCase();
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function exceedsLimit(value: number, limit: number | undefined): boolean {
	return limit !== undefined && Number.isFinite(limit) && value > limit;
}

function nonNegativeFinite(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

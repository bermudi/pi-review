import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
	assertSafeDiffPath,
	containsBinaryByte,
	decodeDiffText,
	makeUntrackedDiff,
	parseUnifiedDiff,
} from "./diff.js";
import type { ChangedFile, ReviewInput, ReviewMode, ReviewTarget } from "./types.js";

const GIT_PREFIX = ["-c", "core.quotePath=true", "--no-pager"] as const;
export const MAX_GIT_STDOUT_BYTES = 64 * 1024 * 1024;
export const MAX_GIT_STDERR_BYTES = 2 * 1024 * 1024;
export const MAX_TARGET_FILE_BYTES = 16 * 1024 * 1024;

const PATCH_OPTIONS = [
	"--no-ext-diff",
	"--no-textconv",
	"--no-color",
	"--no-indent-heuristic",
	"--diff-algorithm=myers",
	"--find-renames=50%",
	"--full-index",
	"--binary",
	"--src-prefix=a/",
	"--dst-prefix=b/",
	"--line-prefix=",
	"-U3",
	"--inter-hunk-context=0",
] as const;

interface GitOutput {
	stdout: Uint8Array;
	stderr: string;
	exitCode: number;
}

interface TreeEntry {
	mode: string;
	type: string;
	object: string;
	path: string;
}

interface WorkspacePathInfo {
	exists: boolean;
	kind: "file" | "directory" | "other";
	size: number;
}

export class GitReviewError extends Error {
	readonly args: readonly string[];
	readonly exitCode: number | undefined;
	readonly stderr: string;

	constructor(message: string, args: readonly string[], exitCode?: number, stderr = "") {
		super(message);
		this.name = "GitReviewError";
		this.args = args;
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new GitReviewError(`${field} must be a non-empty string`, []);
	}
	return value;
}

function validateReviewInput(value: ReviewInput): ReviewInput {
	if (!isRecord(value)) {
		throw new GitReviewError("Review input must be an object", []);
	}
	const repository = requireString(value.repository, "repository");
	if (!isRecord(value.mode)) {
		throw new GitReviewError("Review mode must be an object", []);
	}

	const kind = value.mode.kind;
	let mode: ReviewMode;
	switch (kind) {
		case "workspace":
			mode = { kind: "workspace" };
			break;
		case "range": {
			const base = requireString(value.mode.base, "mode.base");
			const head = requireString(value.mode.head, "mode.head");
			validateRef(base);
			validateRef(head);
			mode = { kind: "range", base, head };
			break;
		}
		case "commit": {
			const ref = requireString(value.mode.ref, "mode.ref");
			validateRef(ref);
			mode = { kind: "commit", ref };
			break;
		}
		default:
			throw new GitReviewError(`Unknown review mode: ${String(kind)}`, []);
	}

	if (value.background !== undefined && typeof value.background !== "string") {
		throw new GitReviewError("background must be a string when provided", []);
	}
	if (value.rules !== undefined && typeof value.rules !== "string") {
		throw new GitReviewError("rules must be a string when provided", []);
	}
	return { repository, mode, background: value.background, rules: value.rules };
}

function isNotFound(error: unknown): boolean {
	if (!isRecord(error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

async function readStream(stream: unknown, maxBytes: number): Promise<Uint8Array> {
	if (!(stream instanceof ReadableStream)) return new Uint8Array();
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
			total += chunk.byteLength;
			if (total > maxBytes) {
				await reader.cancel("Git output limit exceeded");
				throw new Error(`Git output exceeded ${maxBytes} bytes`);
			}
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function gitEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) environment[key] = value;
	}
	environment.GIT_OPTIONAL_LOCKS = "0";
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GIT_PAGER = "cat";
	environment.PAGER = "cat";
	environment.LC_ALL = "C";
	environment.LANG = "C";
	return environment;
}

async function runGitRaw(repositoryRoot: string, args: readonly string[]): Promise<GitOutput> {
	const command = ["git", ...args];
	let child: Bun.Subprocess;
	try {
		child = Bun.spawn(command, {
			cwd: repositoryRoot,
			env: gitEnvironment(),
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new GitReviewError(`Unable to start git: ${detail}`, args);
	}

	try {
		const [stdout, stderrBytes, exitCode] = await Promise.all([
			readStream(child.stdout, MAX_GIT_STDOUT_BYTES),
			readStream(child.stderr, MAX_GIT_STDERR_BYTES),
			child.exited,
		]);
		return { stdout, stderr: decodeDiffText(stderrBytes), exitCode };
	} catch (error) {
		child.kill();
		await child.exited.catch(() => undefined);
		const detail = error instanceof Error ? error.message : String(error);
		throw new GitReviewError(`Unable to read git output: ${detail}`, args);
	}
}

async function runGit(repositoryRoot: string, args: readonly string[]): Promise<GitOutput> {
	const result = await runGitRaw(repositoryRoot, args);
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || `git exited with status ${result.exitCode}`;
		throw new GitReviewError(`git ${args.join(" ")} failed: ${detail}`, args, result.exitCode, result.stderr);
	}
	return result;
}

async function resolveRepositoryRoot(repository: string): Promise<string> {
	const requested = resolve(repository);
	let requestedInfo;
	try {
		requestedInfo = await lstat(requested);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new GitReviewError(`Repository cannot be inspected: ${detail}`, []);
	}
	if (!requestedInfo.isDirectory()) {
		throw new GitReviewError(`Repository is not a directory: ${requested}`, []);
	}

	const requestedRoot = await realpath(requested);
	const result = await runGit(requestedRoot, [...GIT_PREFIX, "rev-parse", "--show-toplevel"]);
	const reportedRoot = decodeDiffText(result.stdout).trim();
	if (reportedRoot.length === 0) {
		throw new GitReviewError("git did not report a repository root", []);
	}
	const repositoryRoot = await realpath(reportedRoot);
	const rootInfo = await lstat(repositoryRoot);
	if (!rootInfo.isDirectory()) {
		throw new GitReviewError(`Git root is not a directory: ${repositoryRoot}`, []);
	}
	return repositoryRoot;
}

function validateRef(ref: string): string {
	if (typeof ref !== "string" || ref.length === 0) {
		throw new GitReviewError("Git ref must be a non-empty string", []);
	}
	if (
		ref.startsWith("-") ||
		ref !== ref.trim() ||
		/[\0-\x20\x7f;|&$`<>\\]/.test(ref) ||
		ref.includes("..") ||
		ref.includes("@{") ||
		ref.startsWith("/") ||
		ref.endsWith("/") ||
		ref.includes("//") ||
		ref.endsWith(".") ||
		ref.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock")) ||
		!/^[A-Za-z0-9_./@%+#!,=~-]+(?:(?:~|\^)\d*)*$/.test(ref)
	) {
		throw new GitReviewError(`Unsafe Git ref rejected: ${JSON.stringify(ref)}`, []);
	}
	return ref;
}

export function isSafeRef(ref: string): boolean {
	try {
		validateRef(ref);
		return true;
	} catch {
		return false;
	}
}

export function assertSafeRef(ref: string): string {
	return validateRef(ref);
}

async function resolveCommit(repositoryRoot: string, ref: string): Promise<string> {
	const safeRef = validateRef(ref);
	const result = await runGit(repositoryRoot, [
		...GIT_PREFIX,
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${safeRef}^{commit}`,
	]);
	const commit = decodeDiffText(result.stdout).trim();
	if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
		throw new GitReviewError(`git returned an invalid commit for ref ${JSON.stringify(ref)}`, []);
	}
	return commit.toLowerCase();
}

async function resolveOptionalHead(repositoryRoot: string): Promise<string | undefined> {
	const result = await runGitRaw(repositoryRoot, [
		...GIT_PREFIX,
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		"HEAD^{commit}",
	]);
	if (result.exitCode !== 0) return undefined;
	const head = decodeDiffText(result.stdout).trim();
	if (!/^[0-9a-f]{40,64}$/i.test(head)) {
		throw new GitReviewError("git returned an invalid HEAD commit", []);
	}
	return head.toLowerCase();
}

function patchArgs(command: "diff" | "diff-tree"): string[] {
	return [...GIT_PREFIX, command, ...PATCH_OPTIONS];
}

async function mergeBase(repositoryRoot: string, base: string, head: string): Promise<string> {
	const result = await runGit(repositoryRoot, [
		...GIT_PREFIX,
		"merge-base",
		"--end-of-options",
		base,
		head,
	]);
	const resolved = decodeDiffText(result.stdout).trim();
	if (!/^[0-9a-f]{40,64}$/i.test(resolved)) {
		throw new GitReviewError("git returned an invalid merge-base commit", []);
	}
	return resolved.toLowerCase();
}

async function diffBetween(
	repositoryRoot: string,
	base: string,
	head: string,
): Promise<string> {
	const result = await runGit(repositoryRoot, [
		...patchArgs("diff"),
		"--end-of-options",
		base,
		head,
		"--",
	]);
	return decodeDiffText(result.stdout);
}

async function diffWorkspace(repositoryRoot: string, head: string): Promise<string> {
	const result = await runGit(repositoryRoot, [...patchArgs("diff"), "--end-of-options", head, "--"]);
	return decodeDiffText(result.stdout);
}

async function diffCommit(
	repositoryRoot: string,
	commit: string,
	parent: string | undefined,
): Promise<string> {
	if (parent !== undefined) return diffBetween(repositoryRoot, parent, commit);
	const result = await runGit(repositoryRoot, [
		...patchArgs("diff-tree"),
		"--root",
		"--no-commit-id",
		"-r",
		"--end-of-options",
		commit,
		"--",
	]);
	return decodeDiffText(result.stdout);
}

async function listNulPaths(repositoryRoot: string, args: readonly string[]): Promise<string[]> {
	const result = await runGit(repositoryRoot, args);
	const text = decodeDiffText(result.stdout);
	const paths: string[] = [];
	for (const path of text.split("\0")) {
		if (path.length === 0) continue;
		paths.push(assertSafeDiffPath(path));
	}
	return paths;
}

async function workspaceCandidates(repositoryRoot: string, includeTracked: boolean): Promise<string[]> {
	const args = includeTracked
		? [...GIT_PREFIX, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]
		: [...GIT_PREFIX, "ls-files", "--others", "--exclude-standard", "-z"];
	return listNulPaths(repositoryRoot, args);
}

async function inspectWorkspacePath(repositoryRoot: string, relativePath: string): Promise<WorkspacePathInfo> {
	const safePath = assertSafeDiffPath(relativePath);
	const parts = safePath.split("/");
	let current = repositoryRoot;

	for (let index = 0; index < parts.length; index += 1) {
		current = join(current, parts[index] ?? "");
		let info;
		try {
			info = await lstat(current);
		} catch (error) {
			if (isNotFound(error)) return { exists: false, kind: "other", size: 0 };
			throw error;
		}
		if (info.isSymbolicLink()) {
			throw new GitReviewError(`Workspace symlink rejected: ${safePath}`, []);
		}
		if (index < parts.length - 1 && !info.isDirectory()) {
			throw new GitReviewError(`Workspace path component is not a directory: ${safePath}`, []);
		}
		if (index === parts.length - 1) {
			if (info.isFile()) return { exists: true, kind: "file", size: info.size };
			if (info.isDirectory()) return { exists: true, kind: "directory", size: info.size };
			return { exists: true, kind: "other", size: info.size };
		}
	}

	return { exists: false, kind: "other", size: 0 };
}

async function readWorkspaceBytes(repositoryRoot: string, relativePath: string): Promise<Uint8Array> {
	const safePath = assertSafeDiffPath(relativePath);
	const info = await inspectWorkspacePath(repositoryRoot, safePath);
	if (!info.exists) throw new GitReviewError(`Workspace file does not exist: ${safePath}`, []);
	if (info.kind !== "file") throw new GitReviewError(`Workspace path is not a regular file: ${safePath}`, []);
	if (info.size > MAX_TARGET_FILE_BYTES) {
		throw new GitReviewError(`Workspace file exceeds ${MAX_TARGET_FILE_BYTES} bytes: ${safePath}`, []);
	}

	let handle: FileHandle | undefined;
	try {
		handle = await open(join(repositoryRoot, safePath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const openedInfo = await handle.stat();
		if (!openedInfo.isFile()) throw new GitReviewError(`Workspace path is not a regular file: ${safePath}`, []);
		if (openedInfo.size > MAX_TARGET_FILE_BYTES) {
			throw new GitReviewError(`Workspace file exceeds ${MAX_TARGET_FILE_BYTES} bytes: ${safePath}`, []);
		}

		const chunks: Uint8Array[] = [];
		let total = 0;
		while (true) {
			const remaining = MAX_TARGET_FILE_BYTES + 1 - total;
			if (remaining <= 0) {
				throw new GitReviewError(`Workspace file exceeds ${MAX_TARGET_FILE_BYTES} bytes: ${safePath}`, []);
			}
			const chunk = new Uint8Array(Math.min(64 * 1024, remaining));
			const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > MAX_TARGET_FILE_BYTES) {
				throw new GitReviewError(`Workspace file exceeds ${MAX_TARGET_FILE_BYTES} bytes: ${safePath}`, []);
			}
			chunks.push(chunk.subarray(0, bytesRead));
		}

		const output = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			output.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return output;
	} catch (error) {
		if (error instanceof GitReviewError) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new GitReviewError(`Unable to read workspace file ${safePath}: ${detail}`, []);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function parseTreeEntries(bytes: Uint8Array): TreeEntry[] {
	const text = decodeDiffText(bytes);
	const entries: TreeEntry[] = [];
	for (const record of text.split("\0")) {
		if (record.length === 0) continue;
		const separator = record.indexOf("\t");
		if (separator <= 0) {
			throw new GitReviewError("Malformed git ls-tree output", []);
		}
		const metadata = record.slice(0, separator).split(" ");
		if (metadata.length < 3) {
			throw new GitReviewError("Malformed git ls-tree metadata", []);
		}
		const mode = metadata[0] ?? "";
		const type = metadata[1] ?? "";
		const object = metadata[2] ?? "";
		const path = assertSafeDiffPath(record.slice(separator + 1));
		entries.push({ mode, type, object, path });
	}
	return entries;
}

async function treeEntry(
	repositoryRoot: string,
	commit: string,
	relativePath: string,
): Promise<TreeEntry | undefined> {
	const safePath = assertSafeDiffPath(relativePath);
	const result = await runGit(repositoryRoot, [
		...GIT_PREFIX,
		"ls-tree",
		"-r",
		"-z",
		"--full-tree",
		"--end-of-options",
		commit,
		"--",
		`:(literal)${safePath}`,
	]);
	return parseTreeEntries(result.stdout).find((entry) => entry.path === safePath);
}

async function snapshotEntries(repositoryRoot: string, commit: string): Promise<TreeEntry[]> {
	const result = await runGit(repositoryRoot, [
		...GIT_PREFIX,
		"ls-tree",
		"-r",
		"-z",
		"--full-tree",
		"--end-of-options",
		commit,
	]);
	return parseTreeEntries(result.stdout);
}

function assertTreeRegular(entry: TreeEntry | undefined, path: string, role: string): TreeEntry {
	if (entry === undefined) {
		throw new GitReviewError(`${role} snapshot does not contain ${path}`, []);
	}
	if (entry.mode === "120000") {
		throw new GitReviewError(`Git symlink rejected in ${role} snapshot: ${path}`, []);
	}
	if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
		throw new GitReviewError(`Unsupported Git entry in ${role} snapshot: ${path}`, []);
	}
	return entry;
}

async function readSnapshotBytes(
	repositoryRoot: string,
	commit: string,
	relativePath: string,
	role = "target",
): Promise<Uint8Array> {
	const safePath = assertSafeDiffPath(relativePath);
	assertTreeRegular(await treeEntry(repositoryRoot, commit, safePath), safePath, role);
	const object = `${commit}:${safePath}`;
	const sizeResult = await runGit(repositoryRoot, [
		...GIT_PREFIX,
		"cat-file",
		"-s",
		"--end-of-options",
		object,
	]);
	const size = Number(decodeDiffText(sizeResult.stdout).trim());
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new GitReviewError(`Git returned an invalid blob size for ${safePath}`, []);
	}
	if (size > MAX_TARGET_FILE_BYTES) {
		throw new GitReviewError(`Git blob exceeds ${MAX_TARGET_FILE_BYTES} bytes: ${safePath}`, []);
	}
	const result = await runGit(repositoryRoot, [
		...GIT_PREFIX,
		"cat-file",
		"blob",
		"--end-of-options",
		object,
	]);
	return result.stdout;
}

async function commitParents(repositoryRoot: string, commit: string): Promise<string[]> {
	const result = await runGit(repositoryRoot, [
		...GIT_PREFIX,
		"rev-list",
		"--parents",
		"-n",
		"1",
		"--end-of-options",
		commit,
	]);
	const values = decodeDiffText(result.stdout).trim().split(/\s+/).filter((value) => value.length > 0);
	if (values[0] !== commit) {
		throw new GitReviewError("git returned an unexpected commit parent record", []);
	}
	return values.slice(1);
}

async function enrichGitFiles(
	repositoryRoot: string,
	files: ChangedFile[],
	targetCommit: string,
	sourceCommit: string | undefined,
): Promise<ChangedFile[]> {
	const enriched: ChangedFile[] = [];
	for (const file of files) {
		if (!file.isNew && sourceCommit !== undefined) {
			assertTreeRegular(await treeEntry(repositoryRoot, sourceCommit, file.oldPath), file.oldPath, "source");
		}
		if (file.isDeleted) {
			if (sourceCommit === undefined) {
				throw new GitReviewError(`Deleted file has no source snapshot: ${file.oldPath}`, []);
			}
			enriched.push({ ...file, newContent: undefined });
			continue;
		}

		assertTreeRegular(
			await treeEntry(repositoryRoot, targetCommit, file.newPath),
			file.newPath,
			"target",
		);
		if (file.isBinary) {
			enriched.push({ ...file, newContent: undefined });
			continue;
		}
		const bytes = await readSnapshotBytes(repositoryRoot, targetCommit, file.newPath);
		if (containsBinaryByte(bytes)) {
			enriched.push({ ...file, isBinary: true, newContent: undefined });
		} else {
			enriched.push({ ...file, newContent: decodeDiffText(bytes) });
		}
	}
	return enriched;
}

async function enrichWorkspaceFiles(
	repositoryRoot: string,
	files: ChangedFile[],
	sourceCommit: string | undefined,
): Promise<ChangedFile[]> {
	const enriched: ChangedFile[] = [];
	for (const file of files) {
		if (!file.isNew && sourceCommit !== undefined) {
			assertTreeRegular(await treeEntry(repositoryRoot, sourceCommit, file.oldPath), file.oldPath, "source");
		}
		if (file.isDeleted) {
			enriched.push({ ...file, newContent: undefined });
			continue;
		}

		const bytes = await readWorkspaceBytes(repositoryRoot, file.newPath);
		if (file.isBinary || containsBinaryByte(bytes)) {
			enriched.push({ ...file, isBinary: true, newContent: undefined });
		} else {
			enriched.push({ ...file, newContent: decodeDiffText(bytes) });
		}
	}
	return enriched;
}

async function buildWorkspaceFiles(
	repositoryRoot: string,
	head: string | undefined,
): Promise<ChangedFile[]> {
	let files: ChangedFile[] = [];
	if (head === undefined) {
		const paths = await workspaceCandidates(repositoryRoot, true);
		const uniquePaths = [...new Set(paths)].sort();
		for (const path of uniquePaths) {
			const info = await inspectWorkspacePath(repositoryRoot, path);
			if (!info.exists) continue;
			const bytes = await readWorkspaceBytes(repositoryRoot, path);
			const patch = makeUntrackedDiff(path, decodeDiffText(bytes), {
				binary: containsBinaryByte(bytes),
				executable: ((await lstat(join(repositoryRoot, path))).mode & 0o111) !== 0,
			});
			const parsed = parseUnifiedDiff(patch);
			if (parsed.length !== 1) throw new GitReviewError(`Could not synthesize a diff for ${path}`, []);
			files.push(parsed[0] as ChangedFile);
		}
	} else {
		const patch = await diffWorkspace(repositoryRoot, head);
		files = parseUnifiedDiff(patch);
		const untracked = await workspaceCandidates(repositoryRoot, false);
		for (const path of [...new Set(untracked)].sort()) {
			const bytes = await readWorkspaceBytes(repositoryRoot, path);
			const info = await lstat(join(repositoryRoot, path));
			const patchForFile = makeUntrackedDiff(path, decodeDiffText(bytes), {
				binary: containsBinaryByte(bytes),
				executable: (info.mode & 0o111) !== 0,
			});
			const parsed = parseUnifiedDiff(patchForFile);
			if (parsed.length !== 1) throw new GitReviewError(`Could not synthesize a diff for ${path}`, []);
			files.push(parsed[0] as ChangedFile);
		}
	}
	files.sort(compareChangedFiles);
	return enrichWorkspaceFiles(repositoryRoot, files, head);
}

function compareChangedFiles(left: ChangedFile, right: ChangedFile): number {
	if (left.newPath < right.newPath) return -1;
	if (left.newPath > right.newPath) return 1;
	if (left.oldPath < right.oldPath) return -1;
	if (left.oldPath > right.oldPath) return 1;
	return 0;
}

async function buildSnapshotTarget(
	repositoryRoot: string,
	mode: ReviewMode,
	targetCommit: string,
	sourceCommit: string | undefined,
	patch: string,
): Promise<ReviewTarget> {
	const parsed = parseUnifiedDiff(patch).sort(compareChangedFiles);
	const files = await enrichGitFiles(repositoryRoot, parsed, targetCommit, sourceCommit);
	return makeTarget(repositoryRoot, mode, files, targetCommit);
}

function makeTarget(
	repositoryRoot: string,
	mode: ReviewMode,
	files: ChangedFile[],
	targetCommit: string | undefined,
): ReviewTarget {
	const target: ReviewTarget = {
		repositoryRoot,
		mode,
		files,
		readFile: async (path: string): Promise<string> => {
			const safePath = assertSafeDiffPath(path);
			if (mode.kind === "workspace") {
				return decodeDiffText(await readWorkspaceBytes(repositoryRoot, safePath));
			}
			if (targetCommit === undefined) {
				throw new GitReviewError("Target snapshot is missing its commit", []);
			}
			return decodeDiffText(await readSnapshotBytes(repositoryRoot, targetCommit, safePath));
		},
		listFiles: async (): Promise<string[]> => {
			if (mode.kind === "workspace") {
				const candidates = await workspaceCandidates(repositoryRoot, true);
				const safeFiles: string[] = [];
				for (const path of [...new Set(candidates)].sort()) {
					const info = await inspectWorkspacePath(repositoryRoot, path);
					if (info.exists && info.kind === "file") safeFiles.push(path);
				}
				return safeFiles;
			}
			if (targetCommit === undefined) throw new GitReviewError("Target snapshot is missing its commit", []);
			const entries = await snapshotEntries(repositoryRoot, targetCommit);
			const paths: string[] = [];
			for (const entry of entries) {
				assertTreeRegular(entry, entry.path, "target");
				paths.push(entry.path);
			}
			return [...new Set(paths)].sort();
		},
	};
	if (targetCommit !== undefined) target.targetRef = targetCommit;
	return target;
}

async function createReviewTargetInternal(input: ReviewInput): Promise<ReviewTarget> {
	const normalized = validateReviewInput(input);
	const repositoryRoot = await resolveRepositoryRoot(normalized.repository);

	switch (normalized.mode.kind) {
		case "workspace": {
			const head = await resolveOptionalHead(repositoryRoot);
			const files = await buildWorkspaceFiles(repositoryRoot, head);
			return makeTarget(repositoryRoot, normalized.mode, files, undefined);
		}
		case "range": {
			const requestedBase = await resolveCommit(repositoryRoot, normalized.mode.base);
			const head = await resolveCommit(repositoryRoot, normalized.mode.head);
			const base = await mergeBase(repositoryRoot, requestedBase, head);
			const patch = await diffBetween(repositoryRoot, base, head);
			return buildSnapshotTarget(repositoryRoot, normalized.mode, head, base, patch);
		}
		case "commit": {
			const target = await resolveCommit(repositoryRoot, normalized.mode.ref);
			const parents = await commitParents(repositoryRoot, target);
			const patch = await diffCommit(repositoryRoot, target, parents[0]);
			return buildSnapshotTarget(repositoryRoot, normalized.mode, target, parents[0], patch);
		}
	}
}

export async function createReviewTarget(input: ReviewInput): Promise<ReviewTarget> {
	return createReviewTargetInternal(input);
}

export async function buildReviewTarget(input: ReviewInput): Promise<ReviewTarget> {
	return createReviewTargetInternal(input);
}

export async function getReviewTarget(input: ReviewInput): Promise<ReviewTarget> {
	return createReviewTargetInternal(input);
}

export async function resolveReviewTarget(input: ReviewInput): Promise<ReviewTarget> {
	return createReviewTargetInternal(input);
}

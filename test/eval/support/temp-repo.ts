// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors

/**
 * Temporary git repositories for eval-harness tests — argv-array git only
 * (no shell interpolation), following the existing engine test patterns.
 * Tests never clone and never touch the network.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TempRepoSpec {
	/** File contents at the base commit; nested paths are created. */
	readonly baseFiles: Readonly<Record<string, string>>;
	/** File contents at the head commit (unchanged files may be omitted). */
	readonly headFiles?: Readonly<Record<string, string>>;
	readonly headMessage?: string;
}

export interface TempRepo {
	readonly root: string;
	readonly baseCommit: string;
	readonly headCommit: string;
	dispose(): void;
}

export function createTempRepo(spec: TempRepoSpec): TempRepo {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-repo-"));
	const git = (...args: string[]): string => {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
		if (result.status !== 0 || result.error !== undefined) {
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? String(result.error)}`);
		}
		return result.stdout;
	};
	try {
		git("init", "-q");
		git("config", "user.email", "eval@example.invalid");
		git("config", "user.name", "eval");
		writeAll(root, spec.baseFiles);
		git("add", ".");
		git("commit", "-q", "-m", "base");
		const baseCommit = git("rev-parse", "HEAD").trim();
		writeAll(root, spec.headFiles ?? {});
		git("add", ".");
		git("commit", "-q", "-m", spec.headMessage ?? "fix");
		const headCommit = git("rev-parse", "HEAD").trim();
		return { root, baseCommit, headCommit, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
	} catch (error) {
		fs.rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function writeAll(root: string, files: Readonly<Record<string, string>>): void {
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
}

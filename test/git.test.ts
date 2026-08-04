import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_TARGET_FILE_BYTES, createReviewTarget } from "../src/git.ts";

const repositories: string[] = [];

async function runGit(repository: string, args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
	const stdout = child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : Promise.resolve("");
	const stderr = child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : Promise.resolve("");
	const [out, error, exitCode] = await Promise.all([stdout, stderr, child.exited]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${error}`);
	return out.trim();
}

async function createRepository(): Promise<string> {
	const repository = await mkdtemp(join(tmpdir(), "pi-reviewer-git-test-"));
	repositories.push(repository);
	await runGit(repository, ["init", "-q", "--initial-branch=main"]);
	await runGit(repository, ["config", "user.name", "Review Test"]);
	await runGit(repository, ["config", "user.email", "review-test@example.invalid"]);
	return repository;
}

async function commitAll(repository: string, message: string): Promise<string> {
	await runGit(repository, ["add", "--all", "--"]);
	await runGit(repository, ["commit", "-q", "-m", message]);
	return runGit(repository, ["rev-parse", "HEAD"]);
}

afterEach(async () => {
	for (const repository of repositories.splice(0)) {
		await rm(repository, { recursive: true, force: true });
	}
});

describe("createReviewTarget", () => {
	it("reviews tracked and untracked workspace files against HEAD", async () => {
		const repository = await createRepository();
		await mkdir(join(repository, "src"), { recursive: true });
		await writeFile(join(repository, "src/app.ts"), "const value = 1;\n");
		await commitAll(repository, "initial");

		await writeFile(join(repository, "src/app.ts"), "const value = 2;\n");
		await writeFile(join(repository, "new file.ts"), "export const fresh = true;\n");

		const target = await createReviewTarget({ repository, mode: { kind: "workspace" } });
		expect(target.files.map((file) => file.newPath)).toEqual(["new file.ts", "src/app.ts"]);
		expect(target.files[0]?.newContent).toBe("export const fresh = true;\n");
		expect(target.files[1]?.hunks[0]?.lines).toEqual([
			{ kind: "deletion", text: "const value = 1;", oldLine: 1 },
			{ kind: "addition", text: "const value = 2;", newLine: 1 },
		]);
		expect(await target.readFile("src/app.ts")).toBe("const value = 2;\n");
		expect(await target.listFiles()).toEqual(["new file.ts", "src/app.ts"]);
	});

	it("reviews the current files in an unborn workspace", async () => {
		const repository = await createRepository();
		await writeFile(join(repository, "staged.ts"), "staged version\n");
		await runGit(repository, ["add", "--", "staged.ts"]);
		await writeFile(join(repository, "staged.ts"), "working-tree version\n");
		await writeFile(join(repository, "untracked.ts"), "untracked\n");

		const target = await createReviewTarget({ repository, mode: { kind: "workspace" } });
		expect(target.files.map((file) => file.newPath)).toEqual(["staged.ts", "untracked.ts"]);
		expect(target.files.every((file) => file.isNew)).toBe(true);
		expect(await target.readFile("staged.ts")).toBe("working-tree version\n");
		expect(await target.listFiles()).toEqual(["staged.ts", "untracked.ts"]);
	});

	it("keeps range and commit reads pinned to the target version", async () => {
		const repository = await createRepository();
		await writeFile(join(repository, "app.ts"), "version one\n");
		const base = await commitAll(repository, "one");
		await writeFile(join(repository, "app.ts"), "version two\n");
		const head = await commitAll(repository, "two");
		await writeFile(join(repository, "app.ts"), "dirty workspace\n");

		const range = await createReviewTarget({
			repository,
			mode: { kind: "range", base, head },
		});
		const commit = await createReviewTarget({ repository, mode: { kind: "commit", ref: head } });

		expect(range.targetRef).toBe(head);
		expect(await range.readFile("app.ts")).toBe("version two\n");
		expect(range.files[0]?.newContent).toBe("version two\n");
		expect(await commit.readFile("app.ts")).toBe("version two\n");
		expect(commit.files[0]?.newContent).toBe("version two\n");
		expect(await commit.listFiles()).toEqual(["app.ts"]);
	});

	it("handles a root commit, a deletion, and a rename", async () => {
		const repository = await createRepository();
		await writeFile(join(repository, "old.txt"), "keep\n");
		await writeFile(join(repository, "removed.txt"), "remove me\n");
		const root = await commitAll(repository, "root");
		const rootTarget = await createReviewTarget({ repository, mode: { kind: "commit", ref: root } });
		expect(rootTarget.files.map((file) => file.newPath)).toEqual(["old.txt", "removed.txt"]);

		await runGit(repository, ["mv", "old.txt", "renamed.txt"]);
		await runGit(repository, ["rm", "removed.txt"]);
		const renameAndDelete = await commitAll(repository, "rename and delete");
		const target = await createReviewTarget({
			repository,
			mode: { kind: "commit", ref: renameAndDelete },
		});

		expect(target.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					oldPath: "old.txt",
					newPath: "renamed.txt",
					isRenamed: true,
				}),
				expect.objectContaining({
					oldPath: "removed.txt",
					newPath: "removed.txt",
					isDeleted: true,
				}),
			]),
		);
	});

	it("rejects unsafe refs, traversal, and workspace symlinks", async () => {
		const repository = await createRepository();
		await writeFile(join(repository, "safe.txt"), "safe\n");
		const head = await commitAll(repository, "safe");
		const target = await createReviewTarget({ repository, mode: { kind: "workspace" } });

		await expect(
			createReviewTarget({ repository, mode: { kind: "commit", ref: "--upload-pack=evil" } }),
		).rejects.toThrow();
		await expect(target.readFile("../outside.txt")).rejects.toThrow();
		await expect(target.readFile("/etc/passwd")).rejects.toThrow();

		const outside = join(repository, "outside.txt");
		await writeFile(outside, "outside\n");
		await symlink(outside, join(repository, "link.txt"));
		await expect(createReviewTarget({ repository, mode: { kind: "workspace" } })).rejects.toThrow(
			/symlink/i,
		);
		expect(head).toMatch(/^[0-9a-f]{40,64}$/);
	});

	it("rejects target files that exceed the host-side acquisition cap", async () => {
		const repository = await createRepository();
		await writeFile(join(repository, "huge.ts"), new Uint8Array(MAX_TARGET_FILE_BYTES + 1));

		await expect(createReviewTarget({ repository, mode: { kind: "workspace" } })).rejects.toThrow(
			/exceeds .* bytes/,
		);
	});

	it("does not expose the repository metadata directory through readFile", async () => {
		const repository = await createRepository();
		await writeFile(join(repository, "safe.txt"), "safe\n");
		await commitAll(repository, "safe");
		const target = await createReviewTarget({ repository, mode: { kind: "workspace" } });

		await expect(target.readFile(".git/config")).rejects.toThrow();
		await expect(readFile(join(repository, ".git", "config"), "utf8")).resolves.toContain("[core]");
	});
});

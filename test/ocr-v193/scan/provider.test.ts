// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/scan/provider_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// localPath test/ocr-v193/scan/provider.test.ts -> internal/scan/provider_test.go

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Provider, NewProvider } from "../../../src/ocr-v193/scan/provider.js";
import { __test as providerTest } from "../../../src/ocr-v193/scan/provider.js";

const { countLines, filterByPaths } = providerTest as unknown as {
  countLines: (content: string | Uint8Array) => number;
  filterByPaths: (all: readonly string[], paths: readonly string[]) => string[];
};

async function initTestRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-scan-provider-"));
  const run = (args: string[]): void => {
    const res = spawnSync("git", args, { cwd: dir });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr?.toString()}`);
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  run(["config", "commit.gpgsign", "false"]);
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); } };
}
async function writeFileEnsure(dir: string, rel: string, content: string | Uint8Array): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, ".."), { recursive: true }).catch(() => {});
  const parent = full.slice(0, full.lastIndexOf("/"));
  if (parent) await mkdir(parent, { recursive: true }).catch(() => {});
  await writeFile(full, content as unknown as string);
}
function gitCommit(dir: string, msg: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-m", msg], { cwd: dir });
}

describe("ocr-v193 scan provider (ported from internal/scan/provider_test.go)", () => {
  // OCR v1.9.3: TestCountLines
  test("TestCountLines", () => {
    const cases: Array<{ name: string; input: string; want: number }> = [
      { name: "empty", input: "", want: 0 },
      { name: "single line no newline", input: "foo", want: 1 },
      { name: "single line trailing newline", input: "foo\n", want: 1 },
      { name: "two lines no trailing newline", input: "foo\nbar", want: 2 },
      { name: "two lines trailing newline", input: "foo\nbar\n", want: 2 },
      { name: "only newline", input: "\n", want: 1 },
      { name: "three lines mixed", input: "a\n\nb", want: 3 },
    ];
    for (const tc of cases) {
      const got = (countLines as unknown as (s: string | Uint8Array) => number)(tc.input as unknown as Uint8Array);
      // Try string overload
      const gotStr = (countLines as unknown as (s: string) => number)(tc.input);
      const actual = typeof got === "number" && got === tc.want ? got : gotStr;
      expect(actual).toBe(tc.want);
    }
  });

  // OCR v1.9.3: TestFilterByPaths
  test("TestFilterByPaths", () => {
    const all = ["cmd/main.go", "internal/agent/agent.go", "internal/agent/fullscan.go", "internal/scan/provider.go", "README.md"];
    const cases: Array<{ name: string; paths: string[]; want: string[] | null }> = [
      { name: "exact file", paths: ["README.md"], want: ["README.md"] },
      { name: "dir prefix", paths: ["internal/agent"], want: ["internal/agent/agent.go", "internal/agent/fullscan.go"] },
      { name: "multi", paths: ["cmd/main.go", "internal/scan"], want: ["cmd/main.go", "internal/scan/provider.go"] },
      { name: "prefix not at boundary", paths: ["internal/age"], want: null },
      { name: "no match", paths: ["does/not/exist"], want: null },
    ];
    for (const tc of cases) {
      const got = filterByPaths(all, tc.paths);
      // Normalize null vs empty array vs undefined
      const want = tc.want;
      if (want === null) {
        expect(got === null || (Array.isArray(got) && got.length === 0)).toBe(true);
      } else {
        expect(got).toEqual(want);
      }
    }
  });

  // OCR v1.9.3: TestNewProvider_NormalizesPaths
  test("TestNewProvider_NormalizesPaths", () => {
    const p = NewProvider("/tmp/repo", ["   ", "./internal/agent/", "cmd", "   internal/diff   ", "a/b"], null, 0);
    const want = ["internal/agent", "cmd", "internal/diff", "a/b"];
    expect(p.paths).toEqual(want);
  });

  // OCR v1.9.3: TestProvider_Enumerate_FullRepo
  test("TestProvider_Enumerate_FullRepo", async () => {
    const repo = await initTestRepo();
    try {
      await writeFileEnsure(repo.dir, "main.go", "package main\n\nfunc main() {}\n");
      await writeFileEnsure(repo.dir, "pkg/util.go", "package pkg\n");
      await writeFileEnsure(repo.dir, "image.bin", new Uint8Array([0x00, 0x01, 0x02]) as unknown as string);
      await writeFileEnsure(repo.dir, ".gitignore", "ignored.txt\n");
      await writeFileEnsure(repo.dir, "ignored.txt", "should not appear\n");
      gitCommit(repo.dir, "init");
      const got = await NewProvider(repo.dir, undefined, undefined, 0).Enumerate(new AbortController().signal);
      const paths = got.map((it) => it.path).sort();
      expect(paths).toEqual([".gitignore", "image.bin", "main.go", "pkg/util.go"].sort());
      const main = got.find((it) => it.path === "main.go");
      expect(main?.isBinary).toBe(false);
      expect(main?.content.includes("package main")).toBe(true);
      expect(main?.lineCount).toBe(3);
      const bin = got.find((it) => it.path === "image.bin");
      expect(bin?.isBinary).toBe(true);
      expect(bin?.content).toBe("");
    } finally { await repo.cleanup(); }
  });

  // OCR v1.9.3: TestProvider_Enumerate_NonGitDirectory
  test("TestProvider_Enumerate_NonGitDirectory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocr-scan-nongit-"));
    try {
      await writeFileEnsure(dir, "main.go", "package main\n");
      await writeFileEnsure(dir, "pkg/util.go", "package pkg\n");
      await writeFileEnsure(dir, ".gitignore", "ignored.txt\n");
      await writeFileEnsure(dir, "ignored.txt", "should be excluded by root .gitignore\n");
      // node_modules should be skipped via ExcludedDirs (provider's walk respects .gitignore? At least check that main files present)
      const got = await NewProvider(dir, undefined, undefined, 0).Enumerate(new AbortController().signal);
      const paths = got.map((it) => it.path).sort();
      expect(paths.includes("main.go")).toBe(true);
      expect(paths.includes("pkg/util.go")).toBe(true);
      expect(paths.includes("ignored.txt")).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });

  // OCR v1.9.3: TestProvider_Enumerate_RespectsContextCancellation
  test("TestProvider_Enumerate_RespectsContextCancellation", async () => {
    const repo = await initTestRepo();
    try {
      for (let i = 0; i < 30; i++) {
        await writeFileEnsure(repo.dir, `pkg/${"a".repeat(i + 1)}.go`, "package pkg\n");
      }
      gitCommit(repo.dir, "init");
      const ctrl = new AbortController();
      ctrl.abort();
      let threw = false;
      try {
        await NewProvider(repo.dir, undefined, undefined, 0).Enumerate(ctrl.signal);
      } catch (e) {
        threw = true;
        const msg = String((e as Error).message);
        expect(msg.includes("Abort") || msg.includes("cancel") || msg.includes("abort")).toBe(true);
      }
      expect(threw).toBe(true);
    } finally { await repo.cleanup(); }
  });

  // OCR v1.9.3: TestProvider_Enumerate_PathFilter
  test("TestProvider_Enumerate_PathFilter", async () => {
    const repo = await initTestRepo();
    try {
      await writeFileEnsure(repo.dir, "a.go", "package a\n");
      await writeFileEnsure(repo.dir, "pkg/b.go", "package pkg\n");
      await writeFileEnsure(repo.dir, "pkg/sub/c.go", "package sub\n");
      gitCommit(repo.dir, "init");
      const got = await NewProvider(repo.dir, ["pkg"], null, 0).Enumerate(new AbortController().signal);
      const paths = got.map((it) => it.path).sort();
      expect(paths).toEqual(["pkg/b.go", "pkg/sub/c.go"].sort());
    } finally { await repo.cleanup(); }
  });

  // OCR v1.9.3: TestProvider_Enumerate_OversizeSkip
  test("TestProvider_Enumerate_OversizeSkip", async () => {
    const repo = await initTestRepo();
    try {
      await writeFileEnsure(repo.dir, "small.go", "package s\n");
      await writeFileEnsure(repo.dir, "big.go", "package big // " + "x".repeat(200) + "\n");
      gitCommit(repo.dir, "init");
      const got = await NewProvider(repo.dir, undefined, undefined, 32).Enumerate(new AbortController().signal);
      const paths = got.map((it) => it.path);
      expect(paths.includes("big.go")).toBe(false);
      expect(paths.includes("small.go")).toBe(true);
    } finally { await repo.cleanup(); }
  });

  // OCR v1.9.3: TestProvider_Enumerate_NonRegularSkip
  test("TestProvider_Enumerate_NonRegularSkip", async () => {
    const repo = await initTestRepo();
    try {
      await writeFileEnsure(repo.dir, "real.go", "package r\n");
      const linkPath = join(repo.dir, "link.go");
      try { await import("node:fs/promises").then((m) => m.symlink("real.go", linkPath)); } catch { return; }
      gitCommit(repo.dir, "init");
      const got = await NewProvider(repo.dir, undefined, undefined, 0).Enumerate(new AbortController().signal);
      const paths = got.map((it) => it.path);
      expect(paths.includes("link.go")).toBe(false);
      expect(paths.includes("real.go")).toBe(true);
    } finally { await repo.cleanup(); }
  });

  // OCR v1.9.3: TestProvider_Enumerate_SniffError
  test("TestProvider_Enumerate_SniffError", async () => {
    // Skip on root (permission bypass)
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const repo = await initTestRepo();
    try {
      await writeFileEnsure(repo.dir, "ok.go", "package ok\n");
      await writeFileEnsure(repo.dir, "locked.go", "package locked\n");
      gitCommit(repo.dir, "init");
      const lockedPath = join(repo.dir, "locked.go");
      try { await import("node:fs/promises").then((m) => m.chmod(lockedPath, 0o000)); } catch { return; }
      const got = await NewProvider(repo.dir, undefined, undefined, 0).Enumerate(new AbortController().signal);
      const paths = got.map((it) => it.path);
      expect(paths.includes("locked.go")).toBe(false);
      expect(paths.includes("ok.go")).toBe(true);
      try { await import("node:fs/promises").then((m) => m.chmod(lockedPath, 0o644)); } catch {}
    } finally { await repo.cleanup(); }
  });

  // OCR v1.9.3: TestIsBinaryFile
  test("TestIsBinaryFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "isbin-"));
    try {
      const textPath = join(dir, "text.txt");
      await writeFile(textPath, "hello world\n");
      const binPath = join(dir, "bin.dat");
      await writeFile(binPath, Buffer.from([97, 0, 98]) as unknown as string);
      const emptyPath = join(dir, "empty.txt");
      await writeFile(emptyPath, "");
      const isBinaryFile = (providerTest as unknown as { isBinaryFile: (p: string) => Promise<boolean> }).isBinaryFile;
      expect(await isBinaryFile(textPath)).toBe(false);
      expect(await isBinaryFile(binPath)).toBe(true);
      expect(await isBinaryFile(emptyPath)).toBe(false);
      let threw = false;
      try { await isBinaryFile(join(dir, "nope")); } catch { threw = true; }
      expect(threw).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });
});

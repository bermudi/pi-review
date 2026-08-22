// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/pathutil/path_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalPath, withinBase } from "../../../src/ocr/pathutil.js";

// OCR v1.9.3: TestWithinBase
test("TestWithinBase", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pathutil-base-"));
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo, { recursive: true });

  const cases: Array<{ name: string; target: string; want: boolean }> = [
    { name: "base", target: repo, want: true },
    { name: "child", target: path.join(repo, "dir", "file.txt"), want: true },
    { name: "parent", target: path.dirname(repo), want: false },
    { name: "sibling with prefix", target: repo + "-other", want: false },
    { name: "cleaned traversal", target: path.join(repo, "..", path.basename(repo) + "-other"), want: false },
  ];

  for (const tc of cases) {
    const got = withinBase(repo, tc.target);
    if (got !== tc.want) {
      throw new Error(`WithinBase(${JSON.stringify(repo)}, ${JSON.stringify(tc.target)}) = ${got}, want ${tc.want} (${tc.name})`);
    }
  }

  fs.rmSync(base, { recursive: true, force: true });
});

// OCR v1.9.3: TestCanonicalPathResolvesSymlink
test("TestCanonicalPathResolvesSymlink", async () => {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-real-"));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-linkparent-"));
  const linkPath = path.join(linkParent, "repo-link");
  try {
    fs.symlinkSync(realDir, linkPath);
  } catch (e) {
    // symlink not supported — skip
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(linkParent, { recursive: true, force: true });
    return;
  }

  const got = await canonicalPath(linkPath);
  const want = fs.realpathSync(realDir);
  expect(got).toBe(want);

  fs.rmSync(realDir, { recursive: true, force: true });
  fs.rmSync(linkParent, { recursive: true, force: true });
});

// OCR v1.9.3: TestCanonicalPath_NonExistentPath
test("TestCanonicalPath_NonExistentPath", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nonexist-"));
  const target = path.join(dir, "does", "not", "exist");
  await expect(canonicalPath(target)).rejects.toThrow();
  fs.rmSync(dir, { recursive: true, force: true });
});

// OCR v1.9.3: TestCanonicalPath_RelativePath
test("TestCanonicalPath_RelativePath", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-relative-"));
  const file = path.join(dir, "test.txt");
  fs.writeFileSync(file, "x", { mode: 0o644 });

  const oldWd = process.cwd();
  try {
    process.chdir(dir);
    const got = await canonicalPath("test.txt");
    expect(path.isAbsolute(got)).toBe(true);
  } finally {
    process.chdir(oldWd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestCanonicalPath_NestedSymlink
test("TestCanonicalPath_NestedSymlink", async () => {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-real-"));
  const realFile = path.join(realDir, "file.txt");
  fs.writeFileSync(realFile, "hello", { mode: 0o644 });

  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-link-"));
  const link1 = path.join(linkDir, "link1");
  const link2 = path.join(linkDir, "link2");
  let skip = false;
  try {
    fs.symlinkSync(realDir, link1);
  } catch {
    skip = true;
  }
  if (!skip) {
    try {
      fs.symlinkSync(link1, link2);
    } catch {
      skip = true;
    }
  }
  if (skip) {
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(linkDir, { recursive: true, force: true });
    return;
  }

  const got = await canonicalPath(path.join(link2, "file.txt"));
  const want = fs.realpathSync(realFile);
  expect(got).toBe(want);

  fs.rmSync(realDir, { recursive: true, force: true });
  fs.rmSync(linkDir, { recursive: true, force: true });
});

// OCR v1.9.3: TestWithinBase_AdditionalCases
test("TestWithinBase_AdditionalCases", () => {
  type C = { name: string; base: string; target: string; want: boolean };
  const cases: C[] = [
    { name: "same path", base: "/a/b", target: "/a/b", want: true },
    { name: "deep child", base: "/a/b", target: "/a/b/c/d/e/f", want: true },
    { name: "double dotdot escape", base: "/a/b/c", target: "/a/b/c/../../x", want: false },
    { name: "dotdot only", base: "/a/b", target: "/a", want: false },
    { name: "root base with child", base: "/", target: "/anything", want: true },
    { name: "empty relative after clean", base: "/a/b", target: "/a/b/./c", want: true },
    { name: "rel error on mixed abs/rel", base: "relative", target: "/absolute", want: false },
  ];
  for (const tc of cases) {
    const got = withinBase(tc.base, tc.target);
    if (got !== tc.want) {
      throw new Error(`WithinBase(${JSON.stringify(tc.base)}, ${JSON.stringify(tc.target)}) = ${got}, want ${tc.want} (${tc.name})`);
    }
  }
});

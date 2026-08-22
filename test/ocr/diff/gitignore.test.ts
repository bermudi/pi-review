// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/diff/gitignore_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.
// Modifications are distributed as part of pi-reviewer under GPL-3.0-or-later;
// see LICENSES/Apache-2.0.txt and THIRD_PARTY_NOTICES.md.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  excludedDirs,
  isPathExcludedWithRepo,
  loadGitignorePatterns,
  matchGitignorePattern,
} from "../../../src/ocr/diff/gitignore.js";
import { ModeCommit, ModeRange, ModeWorkspace, Provider } from "../../../src/ocr/diff/git.js";

// OCR v1.9.3: TestExcludedDirs
test("TestExcludedDirs", () => {
  const dirs = excludedDirs();
  expect(dirs.length).toBeGreaterThan(0);
  expect(dirs).toContain(".git/");

  const dirs2 = excludedDirs();
  dirs[0] = "MUTATED";
  expect(dirs2[0]).not.toBe("MUTATED");
});

// OCR v1.9.3: TestLoadGitignorePatterns
test("TestLoadGitignorePatterns", () => {
  const validDir = mkdtempSync(join(tmpdir(), "pi-reviewer-gitignore-valid-"));
  const missingDir = mkdtempSync(join(tmpdir(), "pi-reviewer-gitignore-missing-"));
  try {
    const content = "*.log\n# comment\n\nnode_modules/\n*.tmp\n";
    writeFileSync(join(validDir, ".gitignore"), content, { mode: 0o644 });

    const patterns = loadGitignorePatterns(validDir);
    const want = ["*.log", "node_modules/", "*.tmp"];
    expect(patterns).toEqual(want);

    expect(loadGitignorePatterns(missingDir)).toBeNull();
  } finally {
    rmSync(validDir, { recursive: true, force: true });
    rmSync(missingDir, { recursive: true, force: true });
  }
});

// OCR v1.9.3: TestIsPathExcluded
test("TestIsPathExcluded", () => {
  const cases: readonly {
    name: string;
    relPath: string;
    patterns: string[] | null;
    want: boolean;
  }[] = [
    { name: "hardcoded dir .git", relPath: ".git", patterns: null, want: true },
    { name: "hardcoded dir prefix", relPath: ".git/config", patterns: null, want: true },
    { name: "node_modules dir pattern", relPath: "node_modules/foo.js", patterns: ["node_modules/"], want: true },
    { name: "gitignore pattern match", relPath: "debug.log", patterns: ["*.log"], want: true },
    { name: "no match", relPath: "main.go", patterns: ["*.log"], want: false },
    { name: "no patterns", relPath: "main.go", patterns: null, want: false },
  ];

  for (const { name, relPath, patterns, want } of cases) {
    expect(isPathExcludedWithRepo(".", relPath, patterns), name).toBe(want);
  }
});

// OCR v1.9.3: TestIsPathExcluded_DirectoryPatterns
test("TestIsPathExcluded_DirectoryPatterns", () => {
  const cases = [
    { name: "path pattern", relPath: "docs/generated/file.go", pattern: "docs/generated/", want: true },
    { name: "path pattern is root relative", relPath: "nested/docs/generated/file.go", pattern: "docs/generated/", want: false },
    { name: "globstar at root", relPath: "generated/file.go", pattern: "**/generated/", want: true },
    { name: "globstar nested", relPath: "src/generated/file.go", pattern: "**/generated/", want: true },
    { name: "component glob", relPath: "src/build-cache/file.go", pattern: "build*/", want: true },
    { name: "root anchored", relPath: "generated/file.go", pattern: "/generated/", want: true },
    { name: "root anchored does not match nested", relPath: "src/generated/file.go", pattern: "/generated/", want: false },
    { name: "file name is not a directory", relPath: "src/generated", pattern: "generated/", want: false },
  ] as const;

  for (const { name, relPath, pattern, want } of cases) {
    expect(isPathExcludedWithRepo(".", relPath, [pattern]), name).toBe(want);
  }
});

const allowListGitignore = [
  "*",
  "!/.github/**/*",
  "!/.gitignore",
  "!/.tool-versions",
  "!/.golangci.yml",
  "!Taskfile.yml",
  "!*.go",
  "!go.sum",
  "!go.mod",
  "!README.md",
  "!LICENSE",
  "!scripts/*",
  "!*/",
];

// OCR v1.9.3: TestIsPathExcluded_AllowListGitignore
test("TestIsPathExcluded_AllowListGitignore", () => {
  const cases = [
    { name: "go file at root", relPath: "main.go", want: false },
    { name: "go file nested", relPath: "internal/diff/git.go", want: false },
    { name: "go test file nested", relPath: "internal/diff/git_test.go", want: false },
    { name: "go.mod", relPath: "go.mod", want: false },
    { name: "go.sum", relPath: "go.sum", want: false },
    { name: "readme", relPath: "README.md", want: false },
    { name: "license", relPath: "LICENSE", want: false },
    { name: "root-anchored dotfile", relPath: ".golangci.yml", want: false },
    { name: "root-anchored tool-versions", relPath: ".tool-versions", want: false },
    { name: "doublestar workflow", relPath: ".github/workflows/ci.yml", want: false },
    { name: "script by dir glob", relPath: "scripts/build.sh", want: false },
    { name: "taskfile", relPath: "Taskfile.yml", want: false },
    { name: "build artifact at root", relPath: "coverage.out", want: true },
    { name: "build artifact nested", relPath: "internal/diff/coverage.out", want: true },
    { name: "binary at root", relPath: "ocr", want: true },
    { name: "unrelated yaml nested", relPath: "internal/testdata/fixture.yaml", want: true },
  ] as const;

  for (const { name, relPath, want } of cases) {
    expect(isPathExcludedWithRepo(".", relPath, allowListGitignore), name).toBe(want);
  }
});

// OCR v1.9.3: TestIsPathExcluded_LastMatchWins
test("TestIsPathExcluded_LastMatchWins", () => {
  const cases = [
    { name: "negation after exclusion re-includes", relPath: "important.log", patterns: ["*.log", "!important.log"], want: false },
    { name: "exclusion after negation re-excludes", relPath: "important.log", patterns: ["!important.log", "*.log"], want: true },
    { name: "negation of unmatched path is inert", relPath: "main.go", patterns: ["!important.log"], want: false },
    { name: "hardcoded dirs are not negatable", relPath: ".git/config", patterns: ["!.git/config"], want: true },
    { name: "blocklist still works", relPath: "debug.log", patterns: ["*.log"], want: true },
  ] as const;

  for (const { name, relPath, patterns, want } of cases) {
    expect(isPathExcludedWithRepo(".", relPath, [...patterns]), name).toBe(want);
  }
});

// OCR v1.9.3: TestMatchGitignorePattern
test("TestMatchGitignorePattern", () => {
  const cases = [
    { name: "basename glob match", relPath: "src/debug.log", pattern: "*.log", want: true },
    { name: "basename glob no match", relPath: "src/main.go", pattern: "*.log", want: false },
    { name: "directory pattern", relPath: "vendor/pkg/file.go", pattern: "vendor/", want: true },
    { name: "directory pattern nested", relPath: "a/vendor/b", pattern: "vendor/", want: true },
    { name: "directory pattern no match", relPath: "vendor_extra/file.go", pattern: "vendor/", want: false },
    { name: "full path glob", relPath: "docs/api.md", pattern: "docs/*.md", want: true },
    { name: "full path no match", relPath: "src/api.md", pattern: "docs/*.md", want: false },
    { name: "negation pattern", relPath: "important.log", pattern: "!important.log", want: false },
    { name: "path suffix match", relPath: "src/generated/api.go", pattern: "generated/api.go", want: true },
    { name: "path suffix respects component boundary", relPath: "othersrc/main.go", pattern: "src/main.go", want: false },
    { name: "path suffix at root is not a suffix match", relPath: "src/main.go", pattern: "rc/main.go", want: false },
  ] as const;

  for (const { name, relPath, pattern, want } of cases) {
    expect(matchGitignorePattern(relPath, pattern), name).toBe(want);
  }
});

// OCR v1.9.3: TestIsRangeMode
test("TestIsRangeMode", () => {
  expect(new Provider({ repoDir: ".", mode: ModeRange }).isRangeMode()).toBe(true);
  expect(new Provider({ repoDir: ".", mode: ModeCommit }).isRangeMode()).toBe(false);
});

// OCR v1.9.3: TestIsCommitMode
test("TestIsCommitMode", () => {
  expect(new Provider({ repoDir: ".", mode: ModeCommit }).isCommitMode()).toBe(true);
  expect(new Provider({ repoDir: ".", mode: ModeWorkspace }).isCommitMode()).toBe(false);
});

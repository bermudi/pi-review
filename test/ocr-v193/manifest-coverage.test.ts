// SPDX-License-Identifier: GPL-3.0-or-later
//
// The neighboring OCR checkout supplies only a Git object database. Every
// upstream source byte read here is addressed by the fixed v1.9.3 commit.

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const upstreamGitDir = resolve(repoRoot, "../open-code-review");
const manifestPath = resolve(repoRoot, "docs/ocr-v193-reference-manifest.md");
const pinnedTagObject = "4d796ae54cabdcf4e22b69ef502ed8871456a909";
const pinnedCommit = "c35ddd7223f2b5540ce03aa43c9a25ef643fca27";

interface CoverageRow {
  readonly localPath: string;
  readonly upstreamPaths: readonly string[];
}

const coverageRows: readonly CoverageRow[] = [
  { localPath: "test/ocr-v193/llmloop/loop.test.ts", upstreamPaths: ["internal/llmloop/loop_test.go"] },
  { localPath: "test/ocr-v193/llmloop/compression.test.ts", upstreamPaths: ["internal/llmloop/compression_test.go"] },
  { localPath: "test/ocr-v193/llmloop/pool.test.ts", upstreamPaths: ["internal/llmloop/pool_test.go"] },
  {
    localPath: "test/ocr-v193/llmloop/loop-phase5.test.ts",
    upstreamPaths: [
      "internal/llmloop/loop_test.go",
      "internal/llmloop/loop_execute_test.go",
      "internal/llmloop/loop_execute_more_test.go",
    ],
  },
  { localPath: "test/ocr-v193/diff/parser.test.ts", upstreamPaths: ["internal/diff/parser_test.go"] },
];

function git(...args: readonly string[]): string {
  return execFileSync("git", ["-C", upstreamGitDir, ...args], { encoding: "utf8" });
}

function sourceAtPin(path: string): string {
  return git("show", `${pinnedCommit}:${path}`);
}

function testNamesInSources(paths: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    for (const match of sourceAtPin(path).matchAll(/^func (Test[A-Za-z0-9_]+)\(t \*testing\.T\)/gm)) {
      names.add(match[1] as string);
    }
  }
  return names;
}

function manifestRow(manifest: string, localPath: string): { readonly names: readonly string[]; readonly mapped: number; readonly additional: number } {
  const escapedPath = localPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = manifest.match(new RegExp(`^\\| \`${escapedPath}\` \\| (.+) \\| (.+) \\|$`, "m"));
  const namesColumn = match?.[1];
  const status = match?.[2];
  if (namesColumn === undefined || status === undefined) throw new Error(`coverage manifest row missing for ${localPath}`);

  const counts = status.match(/^(\d+) pinned tests mapped; (\d+) additional local regressions?$/);
  if (counts === null) throw new Error(`coverage status must declare mapped/additional counts for ${localPath}: ${status}`);
  return {
    names: [...namesColumn.matchAll(/`(Test[A-Za-z0-9_]+)`/g)].map((entry) => entry[1] as string),
    mapped: Number(counts[1]),
    additional: Number(counts[2]),
  };
}

interface LocalAnnotations {
  readonly upstreamNames: readonly string[];
  readonly localRegressionTests: number;
}

function localAnnotations(localPath: string): LocalAnnotations {
  const source = readFileSync(resolve(repoRoot, localPath), "utf8");
  const upstreamNames: string[] = [];
  let localRegressionTests = 0;
  let pendingUpstream: string[] = [];
  let pendingLocal = false;

  for (const line of source.split("\n")) {
    const upstream = line.match(/^\s*\/\/ OCR v1\.9\.3: (Test[A-Za-z0-9_]+)\s*$/);
    if (upstream !== null) {
      pendingUpstream.push(upstream[1] as string);
      continue;
    }
    if (/^\s*\/\/ (?:Additional )?Local regression:/i.test(line)) {
      pendingLocal = true;
      continue;
    }
    if (/^\s*test\(/.test(line)) {
      if (pendingUpstream.length === 0 && !pendingLocal) {
        throw new Error(`unannotated local test in ${localPath}: ${line.trim()}`);
      }
      if (pendingUpstream.length > 0 && pendingLocal) {
        throw new Error(`test cannot be both OCR-mapped and local-only in ${localPath}: ${line.trim()}`);
      }
      upstreamNames.push(...pendingUpstream);
      if (pendingLocal) localRegressionTests++;
      pendingUpstream = [];
      pendingLocal = false;
    }
  }
  return { upstreamNames, localRegressionTests };
}

describe("OCR v1.9.3 coverage manifest", () => {
  test("addresses the signed tag object and peeled commit", () => {
    expect(git("rev-parse", "v1.9.3^{tag}").trim()).toBe(pinnedTagObject);
    expect(git("cat-file", "-t", pinnedTagObject).trim()).toBe("tag");
    expect(git("rev-parse", "v1.9.3^{commit}").trim()).toBe(pinnedCommit);
    expect(git("cat-file", "-t", pinnedCommit).trim()).toBe("commit");
    expect(git("cat-file", "tag", pinnedTagObject)).toContain("-----BEGIN SSH SIGNATURE-----");

    // The local trust policy may reject the signer principal even though Git
    // verified its signature. Require Git's cryptographic "Good" result, not
    // a machine-specific zero exit code.
    const verification = spawnSync("git", ["-C", upstreamGitDir, "verify-tag", "v1.9.3"], { encoding: "utf8" });
    expect(`${verification.stdout}${verification.stderr}`).toContain("Good");
  });

  test("uses exact pinned sources and structured local annotations", () => {
    const manifest = readFileSync(manifestPath, "utf8");
    const allPinnedTestPaths = git("ls-tree", "-r", "--name-only", pinnedCommit, "--", "internal")
      .split("\n")
      .filter((path) => path.endsWith("_test.go"));
    const allPinnedNames = testNamesInSources(allPinnedTestPaths);

    for (const name of [...manifest.matchAll(/\b(Test[A-Za-z0-9_]+)\b/g)].map((entry) => entry[1] as string)) {
      expect(allPinnedNames.has(name)).toBe(true);
    }

    for (const row of coverageRows) {
      const documented = manifestRow(manifest, row.localPath);
      const annotated = localAnnotations(row.localPath);
      const validForRow = testNamesInSources(row.upstreamPaths);

      expect(new Set(documented.names).size).toBe(documented.names.length);
      expect(documented.mapped).toBe(documented.names.length);
      expect(documented.additional).toBe(annotated.localRegressionTests);
      expect(new Set(annotated.upstreamNames)).toEqual(new Set(documented.names));
      for (const name of annotated.upstreamNames) expect(validForRow.has(name)).toBe(true);
    }
  });
});

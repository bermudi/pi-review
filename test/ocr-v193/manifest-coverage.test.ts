// SPDX-License-Identifier: GPL-3.0-or-later
//
// Keeps the human-readable upstream test ledger honest. OCR remains the
// source specification; this test extracts its pinned Go Test names rather
// than accepting hand-written approximations in the manifest.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const upstreamRoot = resolve(repoRoot, "../open-code-review");
const manifestPath = resolve(repoRoot, "docs/ocr-v193-reference-manifest.md");
const pinnedCommit = "c35ddd7223f2b5540ce03aa43c9a25ef643fca27";

interface CoverageRow {
  readonly localPath: string;
  readonly upstreamPaths: readonly string[];
  readonly mapped: number;
  readonly additional: number;
}

const coverageRows: readonly CoverageRow[] = [
  {
    localPath: "test/ocr-v193/llmloop/loop.test.ts",
    upstreamPaths: ["internal/llmloop/loop_test.go"],
    mapped: 18,
    additional: 2,
  },
  {
    localPath: "test/ocr-v193/llmloop/compression.test.ts",
    upstreamPaths: ["internal/llmloop/compression_test.go"],
    mapped: 11,
    additional: 1,
  },
  {
    localPath: "test/ocr-v193/llmloop/pool.test.ts",
    upstreamPaths: ["internal/llmloop/pool_test.go"],
    mapped: 10,
    additional: 0,
  },
  {
    localPath: "test/ocr-v193/llmloop/loop-phase5.test.ts",
    upstreamPaths: [
      "internal/llmloop/loop_test.go",
      "internal/llmloop/loop_execute_test.go",
      "internal/llmloop/loop_execute_more_test.go",
    ],
    mapped: 11,
    additional: 6,
  },
];

function manifestRow(manifest: string, localPath: string): { readonly names: readonly string[]; readonly status: string } {
  const escapedPath = localPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = manifest.match(new RegExp(`^\\| \`${escapedPath}\` \\| (.+) \\| (.+) \\|$`, "m"));
  const testColumn = match?.[1];
  const status = match?.[2];
  if (testColumn === undefined || status === undefined) {
    throw new Error(`coverage manifest row missing for ${localPath}`);
  }
  return {
    names: [...testColumn.matchAll(/`(Test[A-Za-z0-9_]+)`/g)].map((entry) => entry[1] as string),
    status,
  };
}

function upstreamTests(paths: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    const source = readFileSync(resolve(upstreamRoot, path), "utf8");
    for (const match of source.matchAll(/^func (Test[A-Za-z0-9_]+)\(t \*testing\.T\)/gm)) {
      names.add(match[1] as string);
    }
  }
  return names;
}

function allUpstreamTests(dir: string): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of allUpstreamTests(path)) names.add(name);
    } else if (entry.endsWith("_test.go")) {
      for (const name of upstreamTests([path.replace(`${upstreamRoot}/`, "")])) names.add(name);
    }
  }
  return names;
}

function localTestCount(localPath: string): number {
  const source = readFileSync(resolve(repoRoot, localPath), "utf8");
  return [...source.matchAll(/^\s*test\(/gm)].length;
}

describe("OCR v1.9.3 coverage manifest", () => {
  test("uses the pinned upstream checkout", () => {
    const actual = execFileSync("git", ["-C", upstreamRoot, "rev-parse", "v1.9.3^{commit}"], {
      encoding: "utf8",
    }).trim();
    expect(actual).toBe(pinnedCommit);
  });

  test("maps only exact upstream test names and honest local counts", () => {
    const manifest = readFileSync(manifestPath, "utf8");
    const allPinnedNames = allUpstreamTests(resolve(upstreamRoot, "internal"));
    const allManifestNames = [...manifest.matchAll(/\b(Test[A-Za-z0-9_]+)\b/g)].map((entry) => entry[1] as string);
    for (const name of allManifestNames) {
      expect(allPinnedNames.has(name)).toBe(true);
    }

    for (const row of coverageRows) {
      const documented = manifestRow(manifest, row.localPath);
      const upstream = upstreamTests(row.upstreamPaths);
      const declared = documented.status.match(/^(\d+) pinned tests mapped; (\d+) additional local regressions?$/);
      if (declared === null) {
        throw new Error(`coverage status must declare mapped/additional counts for ${row.localPath}: ${documented.status}`);
      }

      expect(new Set(documented.names).size).toBe(documented.names.length);
      expect(documented.names).toHaveLength(row.mapped);
      expect(Number(declared[1])).toBe(row.mapped);
      expect(Number(declared[2])).toBe(row.additional);
      expect(localTestCount(row.localPath)).toBe(row.mapped + row.additional);

      for (const name of documented.names) {
        expect(upstream.has(name)).toBe(true);
      }
    }
  });
});

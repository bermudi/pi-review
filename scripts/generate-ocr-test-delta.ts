// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates the committed upstream test delta between the shipped OCR v1.9.3
// baseline and the active OCR v1.9.9 upgrade target. Both trees are read only
// through pinned Git objects; the neighboring checkout's working tree is never
// consulted.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractGoTestFunctions } from "../test/ocr/support/go-test-declarations.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRepo = resolve(repoRoot, "../open-code-review");
export const deltaPath = resolve(repoRoot, "docs/ocr-upstream-test-delta.json");

export const previousReference = {
  tag: "v1.9.3",
  tagObject: "4d796ae54cabdcf4e22b69ef502ed8871456a909",
  commit: "c35ddd7223f2b5540ce03aa43c9a25ef643fca27",
} as const;

export const activeReference = {
  tag: "v1.9.9",
  tagObject: "c95d3907d5448354d3f8a33f2ae5e4f23fdf1c94",
  commit: "4b6874bd23106b5c68bea6d230bb60303b9f0961",
} as const;

export type DeltaKind = "added" | "removed" | "changed_body" | "byte_identical";

export interface TestDelta {
  readonly path: string;
  readonly name: string;
  readonly kind: DeltaKind;
  readonly from?: { readonly blob: string; readonly bodySha256: string };
  readonly to?: { readonly blob: string; readonly bodySha256: string };
}

export interface OcrTestDelta {
  readonly schemaVersion: 1;
  readonly previousReference: typeof previousReference;
  readonly activeReference: typeof activeReference;
  readonly signatureVerification: {
    readonly result: "good_signature_no_matching_principal";
    readonly fingerprint: "SHA256:h1896zwqn7Qf5kfn0IaeVPOD6d8PVAfiyFqgcL3d9qU";
    readonly detail: "Git verified a good SSH signature, but local allowed-signers matched no principal; signer identity trust is not verified.";
  };
  readonly tests: readonly TestDelta[];
  readonly totals: Readonly<Record<DeltaKind, number>>;
}

export interface TestAtReference {
  readonly blob: string;
  readonly bodySha256: string;
}

function git(...args: readonly string[]): string {
  return execFileSync("git", ["-C", upstreamRepo, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function validateReference(reference: typeof previousReference | typeof activeReference): void {
  const tagObject = git("rev-parse", `${reference.tag}^{tag}`).trim();
  const commit = git("rev-parse", `${reference.tag}^{commit}`).trim();
  if (tagObject !== reference.tagObject || commit !== reference.commit) {
    throw new Error(`OCR reference mismatch for ${reference.tag}: tag=${tagObject} commit=${commit}`);
  }
}

function verifyActiveTag(): void {
  const result = spawnSync("git", ["-C", upstreamRepo, "verify-tag", activeReference.tag], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (
    !output.includes(`Good "git" signature with RSA key SHA256:h1896zwqn7Qf5kfn0IaeVPOD6d8PVAfiyFqgcL3d9qU`)
    || !output.includes("No principal matched.")
  ) {
    throw new Error(`OCR v1.9.9 signature verification did not have the expected untrusted-identity result: ${output}`);
  }
}

export function sourceSha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function testsAtReference(reference: typeof previousReference | typeof activeReference): ReadonlyMap<string, TestAtReference> {
  const entries = new Map<string, TestAtReference>();
  const treeLines = git("ls-tree", "-r", reference.commit)
    .trim()
    .split("\n")
    .filter((line) => line.endsWith("_test.go"));

  for (const line of treeLines) {
    const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+_test\.go)$/);
    if (match === null) throw new Error(`unexpected git ls-tree line: ${line}`);
    const [, blob, path] = match;
    if (blob === undefined || path === undefined) throw new Error(`incomplete git ls-tree line: ${line}`);
    const source = git("show", `${reference.commit}:${path}`);
    for (const test of extractGoTestFunctions(source)) {
      const key = `${path}::${test.name}`;
      if (entries.has(key)) throw new Error(`duplicate top-level test ${key}`);
      entries.set(key, {
        blob,
        bodySha256: sourceSha256(test.source),
      });
    }
  }
  return entries;
}

export function compareTestEntries(
  previous: ReadonlyMap<string, TestAtReference>,
  active: ReadonlyMap<string, TestAtReference>,
): readonly TestDelta[] {
  const keys = [...new Set([...previous.keys(), ...active.keys()])].sort((left, right) => left.localeCompare(right));
  return keys.map((key) => {
    const from = previous.get(key);
    const to = active.get(key);
    const separator = key.lastIndexOf("::");
    const path = key.slice(0, separator);
    const name = key.slice(separator + 2);
    if (from === undefined && to !== undefined) return { path, name, kind: "added", to };
    if (from !== undefined && to === undefined) return { path, name, kind: "removed", from };
    if (from === undefined || to === undefined) throw new Error(`incomplete delta for ${key}`);
    return {
      path,
      name,
      kind: from.bodySha256 === to.bodySha256 ? "byte_identical" : "changed_body",
      from,
      to,
    };
  });
}

export function generateOcrTestDelta(): OcrTestDelta {
  validateReference(previousReference);
  validateReference(activeReference);
  verifyActiveTag();

  const tests = compareTestEntries(testsAtReference(previousReference), testsAtReference(activeReference));
  const totals: Record<DeltaKind, number> = {
    added: 0,
    removed: 0,
    changed_body: 0,
    byte_identical: 0,
  };
  for (const test of tests) totals[test.kind]++;

  return {
    schemaVersion: 1,
    previousReference,
    activeReference,
    signatureVerification: {
      result: "good_signature_no_matching_principal",
      fingerprint: "SHA256:h1896zwqn7Qf5kfn0IaeVPOD6d8PVAfiyFqgcL3d9qU",
      detail: "Git verified a good SSH signature, but local allowed-signers matched no principal; signer identity trust is not verified.",
    },
    tests,
    totals,
  };
}

export function deltaByActiveTestId(delta: OcrTestDelta): ReadonlyMap<string, DeltaKind> {
  const result = new Map<string, DeltaKind>();
  for (const test of delta.tests) {
    if (test.to !== undefined) result.set(`${test.path}::${test.name}`, test.kind);
  }
  return result;
}

function serializedDelta(): string {
  return `${JSON.stringify(generateOcrTestDelta(), null, 2)}\n`;
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const generated = serializedDelta();
  if (args.has("--check")) {
    if (!existsSync(deltaPath) || readFileSync(deltaPath, "utf8") !== generated) {
      console.error("OCR v1.9.3..v1.9.9 test delta is stale; run bun run scripts/generate-ocr-test-delta.ts");
      process.exit(1);
    }
  } else {
    writeFileSync(deltaPath, generated);
  }
  const delta = JSON.parse(generated) as OcrTestDelta;
  console.error(`[ocr-test-delta] ${Object.entries(delta.totals).map(([kind, count]) => `${kind}=${count}`).join(" ")}`);
}

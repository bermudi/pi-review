// SPDX-License-Identifier: Apache-2.0
// Gate 0 import guard — static check that verifier runtime files stay independent.
// Only Node/Bun stdlib + local types.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Why we guard imports:
 * If the verifier accidentally imports src/** or test/ocr/harness,
 * it's no longer black-box — it's testing a different path than the
 * installed product. This guard fails the gate if any verifier file
 * pulls in forbidden code, even indirectly via a shell-out to a bad script.
 */

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /^\s*import\s+.*from\s+["'][^"']*\/src\//, message: "imports src/**" },
  { pattern: /^\s*import\s+.*from\s+["']\.\.\/\.\.\/src\//, message: "imports src/** via relative" },
  { pattern: /^\s*import\s+.*from\s+["'][^"']*src\/ocr/, message: "imports src/ocr" },
  { pattern: /import\s*\(\s*["'][^"']*src\//, message: "dynamic import of src/**" },
  { pattern: /^\s*import\s+.*from\s+["'][^"']*dist\//, message: "imports dist/** by relative path" },
  { pattern: /^\s*import\s+.*from\s+["'][^"']*test\/ocr\/harness/, message: "imports test/ocr/harness" },
  { pattern: /^\s*import\s+.*from\s+["'].*pi-agent-core/, message: "imports private pi-agent-core" },
  { pattern: /^\s*import\s+.*from\s+["'].*pi-ai/, message: "imports private pi-ai" },
  { pattern: /require\s*\(\s*["'][^"']*src\//, message: "requires src/**" },
  { pattern: /^\s*import\s+.*open-code-review/, message: "imports OCR Go module" },
];

const FORBIDDEN_SHELL_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /verify-phase/, message: "shells out to invalidated verify:phase* script" },
  { pattern: /scripts\/verify-/, message: "shells out to scripts/verify-*" },
  { pattern: /test\/ocr\/harness/, message: "shells out to harness that imports forbidden code" },
];

export interface ImportViolation {
  readonly file: string;
  readonly line: number;
  readonly content: string;
  readonly reason: string;
}

export function collectVerifierFiles(rootDir: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
        out.push(full);
      }
    }
  }
  walk(rootDir);
  return out;
}

export function checkImports(verifierRoot: string): { count: number; violations: ImportViolation[] } {
  const files = collectVerifierFiles(verifierRoot);
  const violations: ImportViolation[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // Skip comments that just mention the pattern in docs
      const trimmed = line.trim();
      if (trimmed.startsWith("//") && trimmed.includes("FORBIDDEN")) continue;
      if (trimmed.startsWith("*")) continue;

      for (const { pattern, message } of FORBIDDEN_PATTERNS) {
        if (pattern.test(line)) {
          // Allow comments mentioning the forbidden string? We already skip * and // FORBIDDEN
          // But if it's inside a string literal that is part of the guard itself, allow.
          if (line.includes("FORBIDDEN_PATTERNS") || line.includes("pattern:")) continue;
          // The anti-8 test writes a forbidden import into a temp file via string literal;
          // that line is not a real import of this verifier, so ignore lines that are test scaffolding.
          if (line.includes("writeFileSync") && line.includes("src/")) continue;
          if (line.includes("sampleFile") && line.includes("src/")) continue;
          violations.push({ file: relative(process.cwd(), file), line: i + 1, content: line.trim().slice(0, 200), reason: message });
        }
      }
      for (const { pattern, message } of FORBIDDEN_SHELL_PATTERNS) {
        // Only flag actual spawn/exec calls, not comments
        if (/(spawn|exec|spawnSync|execSync|Bun\.spawn)/.test(line) && pattern.test(line)) {
          violations.push({ file: relative(process.cwd(), file), line: i + 1, content: line.trim().slice(0, 200), reason: message });
        }
      }
    }
  }

  return { count: violations.length, violations };
}

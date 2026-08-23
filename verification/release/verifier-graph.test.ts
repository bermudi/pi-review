import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const focusedGates = [
  "verify-sdk-feasibility.ts",
  "verify-vertical.ts",
  "verify-core-review.ts",
  "verify-scan.ts",
  "verify-sessions.ts",
  "verify-outputs.ts",
  "verify-cutover.ts",
] as const;

test("focused verification gates never invoke other gates recursively", () => {
  for (const file of focusedGates) {
    const source = readFileSync(resolve("verification/blackbox", file), "utf8");
    expect(source).not.toMatch(/spawnSync\(\s*["']bun["']\s*,\s*\[\s*["']run["']\s*,\s*[`"'][^`"']*verify:/u);
    expect(source).not.toContain("running prerequisite verify:");
  }
});

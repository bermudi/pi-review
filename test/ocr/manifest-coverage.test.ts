// SPDX-License-Identifier: GPL-3.0-or-later
//
// Exhaustive inventory guard for the active OCR v1.9.9 test tree. Unlike the
// former five-row Markdown check, this compares every upstream test file,
// blob, and top-level Test name through the generator's --check mode.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface InventoryTest {
  readonly name: string;
  readonly delta: "added" | "changed_body" | "byte_identical";
  readonly disposition: "covered" | "equivalent" | "not_applicable" | "pending" | "pending_scope" | "out_of_scope";
  readonly evidence?: readonly { readonly kind: string; readonly path: string; readonly title: string }[];
  readonly reason?: string;
}

interface InventoryFile {
  readonly path: string;
  readonly blob: string;
  readonly scope: {
    readonly kind: "in_scope" | "out_of_scope" | "needs_decision";
    readonly area: string;
    readonly reason?: string;
  };
  readonly tests: readonly InventoryTest[];
}

interface Inventory {
  readonly schemaVersion: number;
  readonly reference: {
    readonly tag: string;
    readonly tagObject: string;
    readonly commit: string;
  };
  readonly previousReference: {
    readonly tag: string;
    readonly tagObject: string;
    readonly commit: string;
  };
  readonly delta: {
    readonly path: string;
    readonly totals: Readonly<Record<"added" | "removed" | "changed_body" | "byte_identical", number>>;
  };
  readonly files: readonly InventoryFile[];
}

const repoRoot = process.cwd();
const inventoryPath = resolve(repoRoot, "docs/ocr-upstream-test-inventory.json");

describe("OCR v1.9.9 exhaustive upstream-test inventory", () => {
  test("exactly matches the pinned Git tree and local coverage annotations", () => {
    const check = spawnSync(
      "bun",
      ["run", "check:ocr-test-inventory"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(check.status, `${check.stdout}${check.stderr}`).toBe(0);
  });

  test("uses closed, internally consistent dispositions", () => {
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as Inventory;
    expect(inventory.schemaVersion).toBe(3);
    expect(inventory.reference).toEqual({
      tag: "v1.9.9",
      tagObject: "c95d3907d5448354d3f8a33f2ae5e4f23fdf1c94",
      commit: "4b6874bd23106b5c68bea6d230bb60303b9f0961",
    });
    expect(inventory.previousReference).toEqual({
      tag: "v1.9.3",
      tagObject: "4d796ae54cabdcf4e22b69ef502ed8871456a909",
      commit: "c35ddd7223f2b5540ce03aa43c9a25ef643fca27",
    });
    expect(inventory.delta).toEqual({
      path: "docs/ocr-upstream-test-delta.json",
      totals: { added: 112, removed: 10, changed_body: 48, byte_identical: 1837 },
    });

    const paths = inventory.files.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([...paths].sort((left, right) => left.localeCompare(right)));

    for (const file of inventory.files) {
      expect(file.path.endsWith("_test.go")).toBe(true);
      expect(file.blob).toMatch(/^[0-9a-f]{40}$/);
      expect(file.scope.area.length).toBeGreaterThan(0);
      const names = file.tests.map((entry) => entry.name);
      expect(new Set(names).size).toBe(names.length);

      for (const entry of file.tests) {
        expect(["added", "changed_body", "byte_identical"]).toContain(entry.delta);
        if (entry.disposition === "covered" || entry.disposition === "equivalent") {
          expect(entry.evidence?.length ?? 0).toBeGreaterThan(0);
          for (const evidence of entry.evidence ?? []) {
            expect(evidence.kind).toBe("bun-test-annotation");
            const localSource = readFileSync(resolve(repoRoot, evidence.path), "utf8");
            expect(localSource).toContain(`// OCR v1.9.3: ${entry.name}`);
            expect(localSource).toContain(`"${evidence.title}"`);
          }
          if (entry.disposition === "equivalent") expect(entry.reason?.length ?? 0).toBeGreaterThan(0);
        } else {
          expect(entry.reason?.length ?? 0).toBeGreaterThan(0);
          if (entry.disposition === "not_applicable") {
            const lower = (entry.reason ?? "").toLowerCase();
            expect(lower.includes("pi replaces") || lower.includes("not applicable") || lower.includes("deferred")).toBe(true);
          }
        }

        if (file.scope.kind === "out_of_scope") expect(entry.disposition).toBe("out_of_scope");
        if (file.scope.kind === "needs_decision" && entry.delta === "byte_identical") {
          expect(entry.disposition).toBe("pending_scope");
        }
        // equivalent and not_applicable are explicit per-test overrides validated by generator
      }
    }
  });
});

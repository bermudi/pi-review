// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { compareTestEntries, sourceSha256 } from "../../../scripts/generate-ocr-test-delta.js";

describe("OCR upstream test delta", () => {
  test("hashes exact test bodies, including table entries", () => {
    const original = "func TestTable(t *testing.T) { cases := []string{\"one\"} }";
    const changed = "func TestTable(t *testing.T) { cases := []string{\"one\", \"two\"} }";

    expect(sourceSha256(original)).not.toBe(sourceSha256(changed));
    expect(sourceSha256(original)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("distinguishes added, removed, changed-body, and byte-identical tests", () => {
    const previous = new Map([
      ["pkg/file_test.go::TestChanged", { blob: "a".repeat(40), bodySha256: "1".repeat(64) }],
      ["pkg/file_test.go::TestRemoved", { blob: "a".repeat(40), bodySha256: "2".repeat(64) }],
      ["pkg/file_test.go::TestSame", { blob: "a".repeat(40), bodySha256: "3".repeat(64) }],
    ]);
    const active = new Map([
      ["pkg/file_test.go::TestAdded", { blob: "b".repeat(40), bodySha256: "4".repeat(64) }],
      ["pkg/file_test.go::TestChanged", { blob: "b".repeat(40), bodySha256: "5".repeat(64) }],
      ["pkg/file_test.go::TestSame", { blob: "b".repeat(40), bodySha256: "3".repeat(64) }],
    ]);

    expect(compareTestEntries(previous, active).map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "TestAdded", kind: "added" },
      { name: "TestChanged", kind: "changed_body" },
      { name: "TestRemoved", kind: "removed" },
      { name: "TestSame", kind: "byte_identical" },
    ]);
  });
});

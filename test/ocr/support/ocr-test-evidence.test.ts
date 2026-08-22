// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import {
  annotations,
  evidenceApplicableToDelta,
  type Evidence,
} from "../../../scripts/generate-ocr-test-inventory.js";

const oldEvidence: Evidence = {
  kind: "bun-test-annotation",
  path: "test/ocr/support/fixtures/versioned-ocr-annotations.fixture.ts",
  title: "byte-identical legacy evidence",
  ocrVersion: "v1.9.3",
};

const upgradeEvidence: Evidence = {
  kind: "bun-test-annotation",
  path: "test/ocr/support/fixtures/versioned-ocr-annotations.fixture.ts",
  title: "changed-body upgrade evidence",
  ocrVersion: "v1.9.9",
};

describe("versioned OCR evidence", () => {
  test("parses direct v1.9.3 and v1.9.9 test annotations", () => {
    expect(annotations("test/ocr/support/fixtures/versioned-ocr-annotations.fixture.ts")).toEqual([
      { name: "TestByteIdentical", title: "byte-identical legacy evidence", ocrVersion: "v1.9.3" },
      { name: "TestChangedBody", title: "changed-body upgrade evidence", ocrVersion: "v1.9.9" },
    ]);
  });

  test("does not let v1.9.3 evidence cover changed-body semantics", () => {
    expect(evidenceApplicableToDelta("changed_body", [oldEvidence])).toEqual([]);
  });

  test("accepts direct v1.9.9 evidence for changed-body semantics", () => {
    expect(evidenceApplicableToDelta("changed_body", [upgradeEvidence])).toEqual([upgradeEvidence]);
  });

  test("keeps v1.9.3 evidence for byte-identical tests", () => {
    expect(evidenceApplicableToDelta("byte_identical", [oldEvidence])).toEqual([oldEvidence]);
  });
});

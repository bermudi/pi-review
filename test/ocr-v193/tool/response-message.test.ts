// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/response_message_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { expect, test } from "bun:test";
import { Complete, Fail, Of } from "../../../src/ocr-v193/tool/definitions.js";

// OCR v1.9.3: TestComplete
test("Complete sets only Completed", () => {
  const checkpoint = Complete();
  expect(checkpoint.Completed).toBe(true);
  expect(checkpoint.Failed).toBe(false);
  expect(checkpoint.Data).toBe("");
});

// OCR v1.9.3: TestFail
test("Fail sets failure data and only Failed", () => {
  const checkpoint = Fail("task failed");
  expect(checkpoint.Completed).toBe(false);
  expect(checkpoint.Failed).toBe(true);
  expect(checkpoint.Data).toBe("task failed");
});

// OCR v1.9.3: TestOf
test("Of sets data without terminal state", () => {
  const checkpoint = Of("hello");
  expect(checkpoint.Completed).toBe(false);
  expect(checkpoint.Failed).toBe(false);
  expect(checkpoint.Data).toBe("hello");
});

// OCR v1.9.3: TestOf_Empty
test("Of accepts empty data without completing", () => {
  const checkpoint = Of("");
  expect(checkpoint.Completed).toBe(false);
  expect(checkpoint.Data).toBe("");
});

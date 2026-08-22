// SPDX-License-Identifier: Apache-2.0
// Ported from internal/llm/client_params_test.go TestBuildToolInputSchema at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { buildToolInputSchema } from "../../../src/ocr/pi-adapter/tool-schema.js";

// OCR v1.9.3: TestBuildToolInputSchema
test("buildToolInputSchema preserves object-root guarantees and filters required", () => {
  const props = { a: { type: "string" } };
  const schema = buildToolInputSchema({
    type: "object",
    properties: props,
    required: ["a", 42 as unknown as string],
    additionalProperties: false,
  });

  expect(schema.Properties).toBeDefined();
  expect(schema.Properties).toEqual(props);
  expect(schema.Required).toEqual(["a"]);
  expect(schema.ExtraFields).toBeDefined();
  expect(schema.ExtraFields!["additionalProperties"]).toBe(false);
  expect(schema.ExtraFields!["type"]).toBeUndefined();
});

// OCR v1.9.3: TestBuildToolInputSchema_Empty
test("buildToolInputSchema empty input stays empty", () => {
  const schema = buildToolInputSchema({});
  expect(schema.Properties).toBeUndefined();
  expect(schema.Required).toBeUndefined();
  expect(schema.ExtraFields).toBeUndefined();
});



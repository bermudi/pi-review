// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/tool/stub_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { expect, test } from "bun:test";
import { NewBuiltin, NewStub } from "../../../src/ocr-v193/tool/definitions.js";
import { FileRead, NotAvailableMsg, TaskDone } from "../../../src/ocr-v193/tool/types.js";

// OCR v1.9.3: TestStubProvider_Tool
test("StubProvider returns its tool", () => {
  const stub = NewStub(FileRead);
  expect(stub.Tool()).toBe(FileRead);
});

// OCR v1.9.3: TestStubProvider_Execute
test("StubProvider Execute returns NotAvailableMsg", async () => {
  const stub = NewStub(FileRead);
  expect(await stub.Execute(undefined, null as never)).toBe(NotAvailableMsg);
});

// OCR v1.9.3: TestBuiltinToolProvider
test("BuiltinToolProvider returns its tool and delegates Execute", async () => {
  let called = false;
  const builtin = NewBuiltin(TaskDone, (_ctx, _args) => {
    called = true;
    return "result";
  });

  expect(builtin.Tool()).toBe(TaskDone);
  const got = await builtin.Execute(undefined, { key: "val" });
  expect(called).toBe(true);
  expect(got).toBe("result");
});

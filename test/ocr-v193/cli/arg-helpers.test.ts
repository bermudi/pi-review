// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/arg_errors_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { test, expect } from "bun:test";
import {
  positionalSignature,
  validArgNames,
  exactArgs,
  minimumArgs,
} from "../../../src/ocr-v193/cli/arg-helpers.js";

// OCR v1.9.3: TestPositionalSignature
test("positionalSignature extracts placeholders", () => {
  const cases: Array<{ use: string; want: string }> = [
    { use: "set <key> <value>", want: "<key> <value>" },
    { use: "rule [flags] <path...>", want: "<path...>" },
    { use: "completion [bash|zsh|fish]", want: "" },
    { use: "version", want: "" },
    { use: "show [flags] <session-id>", want: "<session-id>" },
    { use: "", want: "" },
  ];
  for (const tc of cases) {
    const got = positionalSignature({ Use: tc.use });
    expect(got, `Use=${JSON.stringify(tc.use)}`).toBe(tc.want);
  }
});

// OCR v1.9.3: TestValidArgNames
test("validArgNames strips tab descriptions", () => {
  const cases: Array<{ valid: string[]; want: string[] }> = [
    { valid: ["bash", "zsh"], want: ["bash", "zsh"] },
    { valid: ["bash\tBourne again shell", "zsh\tZ shell"], want: ["bash", "zsh"] },
    { valid: ["bash", " fish"], want: ["bash", " fish"] },
    { valid: [], want: [] },
  ];
  for (const tc of cases) {
    const got = validArgNames(tc.valid);
    expect(got).toEqual(tc.want);
  }
});

// OCR v1.9.3: TestValidInvocationsStillResolve
test("valid invocations still resolve via exact/minimum validators", () => {
  const cmd = { Use: "demo <x>", CommandPath: () => "demo", UseLine: () => "demo <x>" };
  const tests: Array<{ validator: ReturnType<typeof exactArgs> | ReturnType<typeof minimumArgs>; args: string[]; shouldPass: boolean }> = [
    { validator: exactArgs(1), args: ["a"], shouldPass: true },
    { validator: exactArgs(2), args: ["a", "b"], shouldPass: true },
    { validator: minimumArgs(1), args: ["a"], shouldPass: true },
    { validator: minimumArgs(1), args: ["a", "b", "c"], shouldPass: true },
  ];
  for (const tc of tests) {
    const err = tc.validator(cmd as never, tc.args);
    expect(err, `${tc.args.join(",")}`).toBeNull();
  }
  // also verify failure cases return error
  expect(exactArgs(1)({ Use: "demo <x>", CommandPath: () => "demo", UseLine: () => "demo <x>" } as never, [])).not.toBeNull();
  expect(minimumArgs(2)({ Use: "demo <x> <y>", CommandPath: () => "demo", UseLine: () => "demo <x> <y>" } as never, ["a"])).not.toBeNull();
});

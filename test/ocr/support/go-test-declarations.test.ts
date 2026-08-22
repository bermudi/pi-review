// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { extractGoTestDeclarations } from "./go-test-declarations.js";

describe("Go test declaration extraction", () => {
  test("finds top-level testing.T declarations with ordinary formatting", () => {
    const source = [
      "package sample",
      'import "testing"',
      "func TestOne(t *testing.T) {}",
      "func TestTwo( subject * testing.T ) {",
      "  t.Run(\"nested\", func(t *testing.T) {})",
      "}",
    ].join("\n");

    expect(extractGoTestDeclarations(source)).toEqual([
      { name: "TestOne", line: 3 },
      { name: "TestTwo", line: 4 },
    ]);
  });

  test("ignores comments, literals, methods, benchmarks, and TestMain", () => {
    const source = [
      "package sample",
      "// func TestComment(t *testing.T) {}",
      "/* func TestBlock(t *testing.T) {} */",
      'const interpreted = "func TestString(t *testing.T) {}"',
      "const raw = `func TestRaw(t *testing.T) {}`",
      "func (receiver value) TestMethod(t *testing.T) {}",
      "func BenchmarkThing(b *testing.B) {}",
      "func TestMain(m *testing.M) {}",
      "func TestReal(t *testing.T) {}",
    ].join("\n");

    expect(extractGoTestDeclarations(source)).toEqual([{ name: "TestReal", line: 9 }]);
  });
});

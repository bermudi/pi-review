// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/rules/system_rules_unmarshal_test.go at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { describe, expect, test } from "bun:test";

import { parseSystemRuleJson } from "../../../src/ocr/rules/index.js";

// OCR v1.9.3: TestSystemRuleUnmarshalJSON
describe("SystemRule JSON decoding", () => {
  test("preserves path_rule_map key order", () => {
    const rule = parseSystemRuleJson(
      '{"default_rule":"d.md","path_rule_map":{"*.go":"go.md","*.php":"php.md"}}',
    );

    expect(rule.defaultRule).toBe("d.md");
    expect(rule.pathRules).toHaveLength(2);
    expect(rule.pathRules[0]?.Pattern).toBe("*.go");
    expect(rule.pathRules[1]?.Pattern).toBe("*.php");
  });

  test("absent path_rule_map yields no rules", () => {
    const rule = parseSystemRuleJson('{"default_rule":"d.md"}');
    expect(rule.pathRules).toHaveLength(0);
  });

  test("null path_rule_map yields no rules", () => {
    const rule = parseSystemRuleJson('{"default_rule":"d.md","path_rule_map":null}');
    expect(rule.pathRules).toHaveLength(0);
  });

  const errorCases: ReadonlyArray<readonly [string, string, string]> = [
    ["invalid top-level json", "{", ""],
    [
      "path_rule_map is not an object",
      '{"default_rule":"d.md","path_rule_map":[1,2]}',
      "expected '{'",
    ],
    [
      "path_rule_map value is not a string",
      '{"default_rule":"d.md","path_rule_map":{"*.go":123}}',
      "read path_rule_map value",
    ],
  ];

  test.each(errorCases)("%s", (_name, input, wantedMessage) => {
    let thrown: unknown;
    try {
      parseSystemRuleJson(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (wantedMessage !== "") {
      expect((thrown as Error).message).toContain(wantedMessage);
    }
  });
});

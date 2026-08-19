// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/rules/system_rules_test.go at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { expect, test } from "bun:test";

import {
  expandBraces,
  loadDefaultSystemRule,
  resolveSystemRule,
  type SystemRule,
} from "../../../src/ocr-v193/rules/index.js";

// OCR v1.9.3: TestExpandBraces_NoBraces
test("expandBraces returns a pattern without braces unchanged", () => {
  expect(expandBraces("*.java")).toEqual(["*.java"]);
});

// OCR v1.9.3: TestExpandBraces_SingleGroup
test("expandBraces expands a single group", () => {
  expect(expandBraces("*.{go,py}")).toEqual(["*.go", "*.py"]);
});

// OCR v1.9.3: TestExpandBraces_MultipleOptions
test("expandBraces preserves the order of multiple options", () => {
  expect(expandBraces("**/*.{ts,js,tsx,jsx}")).toEqual([
    "**/*.ts",
    "**/*.js",
    "**/*.tsx",
    "**/*.jsx",
  ]);
});

// OCR v1.9.3: TestExpandBraces_UnclosedBrace
test("expandBraces returns an unclosed group unchanged", () => {
  expect(expandBraces("*.{go,py")).toEqual(["*.{go,py"]);
});

const defaultRuleCases: ReadonlyArray<readonly [string, string]> = [
  ["src/main/java/com/example/foo.java", "Logic Error Detection"],
  ["foo.java", "Logic Error Detection"],
  ["src/main/resources/templates/email.ftl", "Template Injection"],
  ["foo.ftl", "Template Injection"],
  ["foo.ftlh", "Template Injection"],
  ["foo.ftlx", "Template Injection"],
  ["src/main/resources/mapper/usermapper.xml", "SQL Logic Error Detection"],
  ["src/main/resources/dao/userdao.xml", "SQL Logic Error Detection"],
  ["pom.xml", "snapshot"],
  ["submodule/pom.xml", "snapshot"],
  ["src/main/resources/application.properties", "Configuration Error Detection"],
  ["frontend/package.json", "latest"],
  ["composer.json", "Composer Manifest Review Principles"],
  ["packages/library/composer.json", "Dependency Constraints and Resolution"],
  ["config/app.yaml", "yaml-key"],
  ["deploy/values.yml", "yaml-key"],
  ["src/pages/index.astro", "client:*"],
  ["src/components/app.tsx", "React"],
  ["lib/utils.ts", "TypeScript"],
  ["app.kt", "Null Safety"],
  ["src/main/handler.cpp", "Smart Pointer"],
  ["driver.c", "malloc"],
  ["pages/Index.ets", "State Decorator"],
  ["components/Button.ets", "State Decorator"],
  ["entry/src/main/module.json5", "json-key"],
  ["entry/oh-package.json5", "json-key"],
  ["src/lib.rs", "Ownership and Lifetime Correctness"],
  ["crates/service/src/main.rs", "Unsafe Code Boundaries"],
  ["crates/service/Cargo.toml", "Cargo Manifest Hygiene"],
  ["scripts/deploy.py", "Mutable Default Arguments"],
  ["src/app/main.py", "Mutable Default Arguments"],
  ["public/index.php", "PHP Review Principles"],
  ["templates/account/profile.phtml", "Web and Template Security Boundaries"],
  ["locale/zh_CN/LC_MESSAGES/messages.po", "Placeholder Mismatch"],
  ["i18n/app.po", "Plural Forms"],
  ["locale/messages.pot", "Placeholder Consistency"],
  ["i18n/app.pot", "Header Integrity"],
  ["api/schema.graphql", "Breaking Changes"],
  ["queries/user.gql", "Breaking Changes"],
  ["src/model.jl", "Type Stability"],
  ["MyPkg/src/solver.jl", "Type Stability"],
  ["main.tf", "Hardcoded Secrets"],
  ["modules/network/vpc.hcl", "Overly Permissive Access"],
  ["envs/prod.tfvars", "Hardcoded Secrets"],
  ["infra/main.bicep", "Hardcoded Secrets"],
  ["api/v1/user.proto", "Wire Compatibility"],
  ["service.proto", "Wire Compatibility"],
  ["src/Main.hs", "Partial Functions"],
  ["examples/Tutorial.lhs", "Partial Functions"],
  ["src/parser.nim", "Memory and Lifetime Safety"],
  ["scripts/build.nims", "Memory and Lifetime Safety"],
  ["project.nimble", "Memory and Lifetime Safety"],
];

const defaultSystemRule = loadDefaultSystemRule();

// OCR v1.9.3: TestResolve_DefaultRules
test.each(defaultRuleCases)("default rule resolves %s", (filePath, wantSubstring) => {
  expect(resolveSystemRule(defaultSystemRule, filePath)).toContain(wantSubstring);
});

const fallbackPaths: ReadonlyArray<readonly [string]> = [
  ["readme.md"],
  ["docs/architecture.txt"],
  ["Makefile"],
  ["ios/ViewController.swift"],
  ["ios/ViewController.m"],
];

// OCR v1.9.3: TestResolve_FallbackToDefault
test.each(fallbackPaths)("unmatched path %s falls back to the default", (filePath) => {
  expect(resolveSystemRule(defaultSystemRule, filePath)).toBe(defaultSystemRule.DefaultRule);
});

// OCR v1.9.3: TestResolve_CustomRule_FirstMatchWins
test("resolveSystemRule uses the first matching custom rule", () => {
  const rule: SystemRule = {
    DefaultRule: "default",
    PathRules: [
      { Pattern: "**/special.java", Rule: "special-rule" },
      { Pattern: "**/*.java", Rule: "java-rule" },
    ],
  };

  expect(resolveSystemRule(rule, "src/special.java")).toBe("special-rule");
  expect(resolveSystemRule(rule, "src/foo.java")).toBe("java-rule");
});

// OCR v1.9.3: TestResolve_CustomRule_DefaultFallback
test("resolveSystemRule uses a custom default when no pattern matches", () => {
  const rule: SystemRule = {
    DefaultRule: "fallback-rule",
    PathRules: [{ Pattern: "**/*.java", Rule: "java-rule" }],
  };

  expect(resolveSystemRule(rule, "main.go")).toBe("fallback-rule");
});

// OCR v1.9.3: TestResolve_CaseInsensitive
test("resolveSystemRule matches patterns case-insensitively", () => {
  const rule: SystemRule = {
    DefaultRule: "default",
    PathRules: [
      { Pattern: "**/*.astro", Rule: "astro-rule" },
      { Pattern: "**/*.java", Rule: "java-rule" },
      { Pattern: "**/Cargo.toml", Rule: "cargo-rule" },
    ],
  };

  expect(resolveSystemRule(rule, "Foo.Astro")).toBe("astro-rule");
  expect(resolveSystemRule(rule, "foo.astro")).toBe("astro-rule");
  expect(resolveSystemRule(rule, "Foo.Java")).toBe("java-rule");
  expect(resolveSystemRule(rule, "foo.java")).toBe("java-rule");
  expect(resolveSystemRule(rule, "crates/service/Cargo.toml")).toBe("cargo-rule");
  expect(resolveSystemRule(rule, "crates/service/cargo.toml")).toBe("cargo-rule");
});

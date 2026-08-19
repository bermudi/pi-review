// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/rules/canonical_config_test.go at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalConfigSystemRule,
  newResolver,
  type SystemRule,
} from "../../../src/ocr-v193/rules/index.js";

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-reviewer-rules-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withHome<T>(home: string, run: () => T): T {
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

function writeProjectRule(repoDir: string, ruleJson: string): void {
  const ocrDir = join(repoDir, ".opencodereview");
  mkdirSync(ocrDir, { recursive: true });
  writeFileSync(join(ocrDir, "rule.json"), ruleJson);
}

interface CanonicalConfigurer {
  canonicalConfig(): string[];
}

function requireCanonicalConfigurer(value: unknown): CanonicalConfigurer {
  if (
    typeof value !== "object" ||
    value === null ||
    !("canonicalConfig" in value) ||
    typeof value.canonicalConfig !== "function"
  ) {
    throw new Error("resolver does not implement canonicalConfig");
  }
  return value as CanonicalConfigurer;
}

// OCR v1.9.3: TestSystemRuleCanonicalConfig
test("system canonical config includes the default and ordered path rules", () => {
  const systemRule: SystemRule = {
    DefaultRule: "d",
    PathRules: [
      { Pattern: "*.go", Rule: "go" },
      { Pattern: "*.py", Rule: "py" },
    ],
  };
  const want = [
    "layer",
    "system",
    "default",
    "d",
    "layer",
    "system",
    "pattern",
    "*.go",
    "rule",
    "go",
    "layer",
    "system",
    "pattern",
    "*.py",
    "rule",
    "py",
  ];

  expect(canonicalConfigSystemRule(systemRule).join("\0")).toBe(want.join("\0"));
});

// OCR v1.9.3: TestComposedResolverCanonicalConfig
test("composed canonical config is deterministic and includes project and system layers", () => {
  withTempDir((home) =>
    withTempDir((repoDir) => {
      writeProjectRule(
        repoDir,
        '{"rules":[{"path":"force-api/**/*.java","rule":"project-java-rule"}]}',
      );

      withHome(home, () => {
        const { resolver } = newResolver(repoDir, "");
        const canonical = requireCanonicalConfigurer(resolver);
        const fields = canonical.canonicalConfig();
        const joined = fields.join("\0");

        expect(canonical.canonicalConfig().join("\0")).toBe(joined);
        expect(joined).toContain("project");
        expect(joined).toContain("project-java-rule");
        expect(joined).toContain("system");
      });
    }),
  );
});

// OCR v1.9.3: TestComposedResolverCanonicalConfig_ProjectRuleChangeChangesOutput
test("changing a project rule changes composed canonical config", () => {
  const build = (rule: string): string =>
    withTempDir((home) =>
      withTempDir((repoDir) => {
        writeProjectRule(
          repoDir,
          `{"rules":[{"path":"a/**","rule":${JSON.stringify(rule)}}]}`,
        );
        return withHome(home, () =>
          requireCanonicalConfigurer(newResolver(repoDir, "").resolver).canonicalConfig().join("\0"),
        );
      }),
    );

  expect(build("rule-one")).not.toBe(build("rule-two"));
});

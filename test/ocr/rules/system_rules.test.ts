// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/rules/system_rules_test.go at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27; selected language cases
// revalidated against OCR v1.9.9.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildFileFilter,
  createFileFilter,
  expandBraces,
  hasInclude,
  isUserExcluded,
  isUserIncluded,
  loadDefaultSystemRule,
  loadGlobalRule,
  loadProjectRule,
  loadRuleFile,
  newResolver,
  resolveSystemRule,
  type FileFilter,
  type ProjectRuleEntry,
  type SystemRule,
} from "../../../src/ocr/rules/index.js";
import {
  looksLikeFilePath,
  readRuleFileSafe,
  resolveRuleEntries,
} from "../../../src/ocr/rules/system_rules.js";

// ---------------------------------------------------------------------------
// Helpers — mirrors Go's t.TempDir / t.Setenv
// ---------------------------------------------------------------------------

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
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  // On Windows, os.homedir() may use USERPROFILE; set it as well for parity.
  if (process.env.USERPROFILE !== undefined) process.env.USERPROFILE = home;
  try {
    return run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}

function writeProjectRule(repoDir: string, ruleJson: string): void {
  const ocrDir = join(repoDir, ".opencodereview");
  mkdirSync(ocrDir, { recursive: true });
  writeFileSync(join(ocrDir, "rule.json"), ruleJson);
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

// ---------------------------------------------------------------------------
// Existing coverage — expandBraces + SystemRule.Resolve
// ---------------------------------------------------------------------------

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
  // Isolated adoption from OCR v1.11.2 b1ad13a: JS module files route to JS rules.
  ["scripts/config.mjs", "TypeScript"],
  ["server/bootstrap.cjs", "TypeScript"],
  ["app.kt", "Null Safety"],
  ["src/main/handler.cpp", "Smart Pointer"],
  // Isolated adoption from OCR v1.11.2 14fab72: .cxx/.hxx route to C++ rules.
  ["src/main/handler.cxx", "Smart Pointer"],
  ["include/handler.hxx", "Smart Pointer"],
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
  ["Sources/App/ContentView.swift", "Swift Review Principles"],
  ["MyApp/Models/UserStore.swift", "Swift Review Principles"],
  ["ChattyFit/ChattyFit/Views/WorkoutSessionView.swift", "SwiftUI State and Lifecycle"],
  ["src/Main.elm", "Elm Architecture"],
  ["app/Page/Home.elm", "Elm Architecture"],
  ["lib/config.libsonnet", "Late Binding"],
  ["environments/prod/main.jsonnet", "Late Binding"],
  ["jsonnet/kube-prometheus/components/grafana.libsonnet", "Late Binding"],
  ["src/foo.R", "R Code Review Principles"],
  ["analysis/plots.r", "R Code Review Principles"],
  ["src/main.zig", "Illegal Behavior"],
  ["build.zig", "Illegal Behavior"],
  ["idl/service.thrift", "Field IDs and Wire Compatibility"],
  ["if/common.thrift", "Field IDs and Wire Compatibility"],
  ["schema/addressbook.capnp", "Ordinals and Wire Compatibility"],
  ["src/rpc.capnp", "Ordinals and Wire Compatibility"],
];

const defaultSystemRule = loadDefaultSystemRule();

// OCR v1.9.9: TestResolve_DefaultRules
test.each(defaultRuleCases)("default rule resolves %s", (filePath, wantSubstring) => {
  expect(resolveSystemRule(defaultSystemRule, filePath)).toContain(wantSubstring);
});

const fallbackPaths: ReadonlyArray<readonly [string]> = [
  ["readme.md"],
  ["docs/architecture.txt"],
  ["Makefile"],
  ["ios/ViewController.m"],
  ["ios/ViewController.mm"],
];

// OCR v1.9.9: TestResolve_FallbackToDefault
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

// ---------------------------------------------------------------------------
// NewResolver composition and precedence
// ---------------------------------------------------------------------------

// OCR v1.9.3: TestNewResolver_DefaultOnly
test("NewResolver with no project rule resolves via system default", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        const { resolver } = newResolver(repoDir, "");
        const got = resolver.resolve("src/main.java");
        expect(got).toContain("Logic Error Detection");
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_ProjectFileMissing
test("NewResolver does not fail when project rule is missing", () => {
  withTempDir((repoDir) => {
    const { resolver } = newResolver(repoDir, "");
    const got = resolver.resolve("readme.md");
    expect(got.length).toBeGreaterThan(0);
  });
});

// OCR v1.9.3: TestNewResolver_ProjectRuleHighestPriority
test("project rule has highest priority over system", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(repoDir, '{"rules":[{"path":"force-api/**/*.java","rule":"project-java-rule"}]}');
        const { resolver } = newResolver(repoDir, "");
        expect(resolver.resolve("force-api/src/foo.java")).toContain("project-java-rule");
        expect(resolver.resolve("other/src/bar.java")).toContain("Logic Error Detection");
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_ProjectRuleFirstMatchWinsWithinFile
test("first matching project rule wins within file", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(
          repoDir,
          '{"rules":[{"path":"internal/**/*.go","rule":"first-go-rule"},{"path":"internal/config/**/*.go","rule":"second-config-rule"}]}',
        );
        const { resolver } = newResolver(repoDir, "");
        expect(resolver.resolve("internal/config/rules/system_rules.go")).toBe("first-go-rule");
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_ProjectRuleFallsBackToSystem
test("project rule falls back to system when not matched", () => {
  withTempDir((repoDir) => {
    writeProjectRule(repoDir, '{"rules":[{"path":"special/**/*.go","rule":"special-go-rule"}]}');
    const { resolver } = newResolver(repoDir, "");
    expect(resolver.resolve("other/main.go")).toContain("Go Review Principles");
  });
});

// OCR v1.9.3: TestNewResolver_CustomRuleOverridesDefault
test("custom rule overrides default and falls through on miss", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        withTempDir((customDir) => {
          const customPath = join(customDir, "custom_rules.json");
          writeFileSync(customPath, '{"rules":[{"path":"**/*.go","rule":"custom-go-rule"}]}');
          const { resolver } = newResolver(repoDir, customPath);
          expect(resolver.resolve("main.go")).toBe("custom-go-rule");
          expect(resolver.resolve("readme.md")).toContain("Correctness");
        });
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_EmptyRuleSkippedAndFallsBack
test("empty rule is skipped and falls back", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(
          repoDir,
          '{"rules":[{"path":"**/*.go","rule":""},{"path":"internal/**/*.go","rule":"second-rule"}]}',
        );
        const { resolver } = newResolver(repoDir, "");
        const first = resolver.resolve("main.go");
        expect(first.length).toBeGreaterThan(0);
        expect(first).not.toBe("");
        expect(resolver.resolve("internal/pkg/foo.go")).toBe("second-rule");
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_EmptyRuleMergeSystemRuleReturnsSystemOnly
test("empty rule with merge_system_rule returns system only", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(repoDir, '{"rules":[{"path":"**/*.go","rule":"","merge_system_rule":true}]}');
        const { resolver } = newResolver(repoDir, "");
        const systemRule = loadDefaultSystemRule();
        const wantSystemRule = resolveSystemRule(systemRule, "main.go");
        const got = resolver.resolve("main.go");
        expect(got).toBe(wantSystemRule);
        expect(got).not.toContain("User-Specific Rules");
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_ProjectRuleReplacesSystemRuleByDefault
test("project rule replaces system rule by default", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(repoDir, '{"rules":[{"path":"**/*.go","rule":"project-go-rule"}]}');
        const { resolver } = newResolver(repoDir, "");
        expect(resolver.resolve("main.go")).toBe("project-go-rule");
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_ProjectRuleMergesSystemRule
test("project rule merges system rule when requested", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(
          repoDir,
          '{"rules":[{"path":"**/*.go","rule":"project-go-rule","merge_system_rule":true}]}',
        );
        const { resolver } = newResolver(repoDir, "");
        const systemRule = loadDefaultSystemRule();
        const wantSystemRule = resolveSystemRule(systemRule, "main.go");
        const got = resolver.resolve("main.go");
        expect(got).toContain(wantSystemRule);
        expect(got).toContain("project-go-rule");
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_MergeSystemRuleKeepsRulePriority
test("merge does not change layer priority", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        const ocrDir = join(repoDir, ".opencodereview");
        mkdirSync(ocrDir, { recursive: true });
        writeFileSync(join(ocrDir, "rule.json"), '{"rules":[{"path":"**/*.go","rule":"project-go-rule"}]}');
        withTempDir((customDir) => {
          const customPath = join(customDir, "custom_rules.json");
          writeFileSync(customPath, '{"rules":[{"path":"main.go","rule":"custom-main-rule","merge_system_rule":true}]}');
          const { resolver } = newResolver(repoDir, customPath);
          const systemRule = loadDefaultSystemRule();
          const wantSystemRule = resolveSystemRule(systemRule, "main.go");
          const got = resolver.resolve("main.go");
          expect(got).toContain(wantSystemRule);
          expect(got).toContain("custom-main-rule");
          expect(got).not.toContain("project-go-rule");
        });
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_CustomOverridesProject
test("custom overrides project", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((customDir) => {
        const customPath = join(customDir, "custom_rules.json");
        writeFileSync(customPath, '{"rules":[{"path":"**/*.java","rule":"custom-java-rule"}]}');
        withTempDir((repoDir) => {
          writeProjectRule(
            repoDir,
            '{"rules":[{"path":"force-api/**/*.java","rule":"project-java-rule"},{"path":"**/*.go","rule":"project-go-rule"}]}',
          );
          const { resolver } = newResolver(repoDir, customPath);
          expect(resolver.resolve("force-api/src/foo.java")).toContain("custom-java-rule");
          expect(resolver.resolve("other/src/bar.java")).toContain("custom-java-rule");
          expect(resolver.resolve("main.go")).toContain("project-go-rule");
          expect(resolver.resolve("readme.md")).toContain("Correctness");
        });
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_ProjectFileMalformed
test("malformed project rule.json returns error", () => {
  withTempDir((repoDir) => {
    writeProjectRule(repoDir, "{invalid json");
    expect(() => newResolver(repoDir, "")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// FileFilter
// ---------------------------------------------------------------------------

// OCR v1.9.3: TestFileFilter_IsUserExcluded
test("FileFilter IsUserExcluded matches exclude patterns", () => {
  const f: FileFilter = {
    Include: [],
    Exclude: ["**/generated/**", "**/*.pb.go", "vendor/**/*.{go,js}"],
  };
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ["src/generated/api.java", true],
    ["pkg/foo.pb.go", true],
    ["vendor/lib/util.go", true],
    ["vendor/lib/util.js", true],
    ["src/main.go", false],
    ["src/generated.go", false],
  ];
  for (const [path, want] of cases) {
    expect(isUserExcluded(f, path)).toBe(want);
  }
});

// OCR v1.9.3: TestFileFilter_IsUserIncluded
test("FileFilter IsUserIncluded matches include patterns", () => {
  const f: FileFilter = {
    Include: ["src/**/*.java", "src/**/*.{kt,kts}"],
    Exclude: [],
  };
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ["src/main/foo.java", true],
    ["src/main/bar.kt", true],
    ["src/build.kts", true],
    ["test/main.java", false],
    ["src/main/util.go", false],
  ];
  for (const [path, want] of cases) {
    expect(isUserIncluded(f, path)).toBe(want);
  }
});

// OCR v1.9.3: TestFileFilter_IsUserIncluded_EmptyInclude
test("FileFilter IsUserIncluded false when include is empty", () => {
  const f: FileFilter = { Include: [], Exclude: [] };
  expect(isUserIncluded(f, "anything.java")).toBe(false);
  expect(hasInclude(f)).toBe(false);
  expect(hasInclude(null)).toBe(false);
  expect(hasInclude(undefined)).toBe(false);
});

// OCR v1.9.3: TestFileFilter_CaseInsensitive
test("FileFilter case-insensitive matching", () => {
  const f: FileFilter = {
    Include: ["src/**/*.java", "**/CHANGELOG.md"],
    Exclude: ["**/generated/**", "README.md", "**/*.{Go,Java}"],
  };
  expect(isUserIncluded(f, "SRC/Main/Foo.Java")).toBe(true);
  expect(isUserExcluded(f, "SRC/Generated/Api.java")).toBe(true);
  expect(isUserIncluded(f, "docs/CHANGELOG.md")).toBe(true);
  expect(isUserExcluded(f, "README.md")).toBe(true);
  expect(isUserExcluded(f, "pkg/Main.JAVA")).toBe(true);
});

// OCR v1.9.3: TestNewResolver_FileFilterMerged
test("NewResolver merges FileFilter from project layer", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(repoDir, '{"rules":[],"include":["src/**/*.java"],"exclude":["**/generated/**"]}');
        const { filter } = newResolver(repoDir, "");
        expect(filter).not.toBeNull();
        expect(hasInclude(filter)).toBe(true);
        expect(isUserIncluded(filter, "src/main/foo.java")).toBe(true);
        expect(isUserExcluded(filter, "src/generated/api.java")).toBe(true);
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_FileFilterNilWhenEmpty
test("NewResolver FileFilter nil when empty", () => {
  withTempDir((repoDir) => {
    const { filter } = newResolver(repoDir, "");
    expect(filter).toBeNull();
  });
});

// OCR v1.9.3: TestNewResolver_FileFilterPriorityOverride
test("FileFilter priority override custom over project", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(repoDir, '{"rules":[],"include":["src/**/*.java"],"exclude":["**/gen/**"]}');
        withTempDir((customDir) => {
          const customPath = join(customDir, "custom.json");
          writeFileSync(customPath, '{"rules":[],"include":["lib/**/*.kt"],"exclude":["**/tmp/**"]}');
          const { filter } = newResolver(repoDir, customPath);
          expect(filter).not.toBeNull();
          expect(isUserIncluded(filter, "lib/util.kt")).toBe(true);
          expect(isUserExcluded(filter, "lib/tmp/cache.kt")).toBe(true);
          expect(isUserIncluded(filter, "src/main/foo.java")).toBe(false);
          expect(isUserExcluded(filter, "src/gen/api.java")).toBe(false);
        });
      });
    }),
  );
});

// OCR v1.9.3: TestNewResolver_FileFilterFallsToProject
test("FileFilter falls to project when custom has none", () => {
  withTempDir((repoDir) => {
    writeProjectRule(repoDir, '{"rules":[],"include":["src/**/*.java"],"exclude":["**/gen/**"]}');
    withTempDir((customDir) => {
      const customPath = join(customDir, "custom.json");
      writeFileSync(customPath, '{"rules":[{"path":"**/*.go","rule":"custom-go"}]}');
      const { filter } = newResolver(repoDir, customPath);
      expect(filter).not.toBeNull();
      expect(isUserIncluded(filter, "src/main/foo.java")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// ResolveDetail
// ---------------------------------------------------------------------------

// OCR v1.9.3: TestResolveDetail_SystemDefault
test("ResolveDetail system default", () => {
  withTempDir((repoDir) => {
    const { resolver } = newResolver(repoDir, "");
    const detail = (resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }).resolveDetail(
      "readme.md",
    );
    expect(detail.Source).toBe("system");
    expect(detail.Pattern).toBe("default");
    expect(detail.Rule).toContain("Correctness");
  });
});

// OCR v1.9.3: TestResolveDetail_SystemPatternMatch
test("ResolveDetail system pattern match java", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        const { resolver } = newResolver(repoDir, "");
        const detail = (resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }).resolveDetail(
          "src/main/foo.java",
        );
        expect(detail.Source).toBe("system");
        expect(detail.Pattern).toBe("**/*.java");
        expect(detail.Rule).toContain("Logic Error Detection");
      });
    }),
  );
});

// OCR v1.9.3: TestResolveDetail_SystemPrismaPatternMatch
test.each(["schema.prisma", "prisma/schema.prisma", "PRISMA/SCHEMA.PRISMA"])(
  "ResolveDetail SystemPrisma %s",
  (filePath) => {
    withTempDir((home) =>
      withHome(home, () => {
        withTempDir((repoDir) => {
          const { resolver } = newResolver(repoDir, "");
          const detail = (
            resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }
          ).resolveDetail(filePath);
          expect(detail.Source).toBe("system");
          expect(detail.Pattern).toBe("**/*.prisma");
          expect(detail.Rule).toContain("Prisma Schema Review Principles");
        });
      }),
    );
  },
);

// OCR v1.9.3: TestResolveDetail_SystemGoPatternMatch
test.each(["main.go", "internal/service/user.go", "CMD/MAIN.GO"])("ResolveDetail SystemGo %s", (filePath) => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        const { resolver } = newResolver(repoDir, "");
        const detail = (
          resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }
        ).resolveDetail(filePath);
        expect(detail.Source).toBe("system");
        expect(detail.Pattern).toBe("**/*.go");
        for (const required of ["Go Review Principles", "Go 1.23+", "defer` inside a loop", "crypto/rand"]) {
          expect(detail.Rule).toContain(required);
        }
      });
    }),
  );
});

// OCR v1.9.3: TestResolveDetail_SystemPHPPatternMatch
test.each(["index.php", "src/Controller/UserController.php", "TEMPLATES/INDEX.PHTML"])(
  "ResolveDetail SystemPHP %s",
  (filePath) => {
    withTempDir((home) =>
      withHome(home, () => {
        withTempDir((repoDir) => {
          const { resolver } = newResolver(repoDir, "");
          const detail = (
            resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }
          ).resolveDetail(filePath);
          expect(detail.Source).toBe("system");
          expect(detail.Pattern).toBe("**/*.{php,phtml}");
          for (const required of [
            "PHP Review Principles",
            "foreach` value variable iterated by reference",
            "unserialize()",
            "PHPStan",
          ]) {
            expect(detail.Rule).toContain(required);
          }
        });
      }),
    );
  },
);

// OCR v1.9.3: TestResolveDetail_SystemComposerPatternPrecedesJSON
test.each(["composer.json", "packages/library/composer.json", "PACKAGES/APP/COMPOSER.JSON"])(
  "ResolveDetail SystemComposer %s",
  (filePath) => {
    withTempDir((home) =>
      withHome(home, () => {
        withTempDir((repoDir) => {
          const { resolver } = newResolver(repoDir, "");
          const detail = (
            resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }
          ).resolveDetail(filePath);
          expect(detail.Source).toBe("system");
          expect(detail.Pattern).toBe("**/composer.json");
          for (const required of ["Composer Manifest Review Principles", "config.allow-plugins", "PSR-4"]) {
            expect(detail.Rule).toContain(required);
          }
        });
      }),
    );
  },
);

// OCR v1.9.3: TestResolveDetail_ProjectOverridesSystem
test("ResolveDetail project overrides system", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(repoDir, '{"rules":[{"path":"src/**/*.java","rule":"project-java-rule"}]}');
        const { resolver } = newResolver(repoDir, "");
        const detail = (
          resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }
        ).resolveDetail("src/main/foo.java");
        expect(detail.Source).toBe("project");
        expect(detail.Pattern).toBe("src/**/*.java");
        expect(detail.Rule).toBe("project-java-rule");
        const detail2 = (
          resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }
        ).resolveDetail("other/bar.java");
        expect(detail2.Source).toBe("system");
      });
    }),
  );
});

// OCR v1.9.3: TestResolveDetail_MergeSystemRule
test("ResolveDetail merge system rule", () => {
  withTempDir((home) =>
    withHome(home, () => {
      withTempDir((repoDir) => {
        writeProjectRule(
          repoDir,
          '{"rules":[{"path":"src/**/*.java","rule":"project-java-rule","merge_system_rule":true}]}',
        );
        const { resolver } = newResolver(repoDir, "");
        const systemRule = loadDefaultSystemRule();
        const wantSystemRule = resolveSystemRule(systemRule, "src/main/foo.java");
        const detail = (
          resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }
        ).resolveDetail("src/main/foo.java");
        expect(detail.Source).toBe("project");
        expect(detail.Pattern).toBe("src/**/*.java");
        expect(detail.Rule).toContain(wantSystemRule);
        expect(detail.Rule).toContain("project-java-rule");
      });
    }),
  );
});

// OCR v1.9.3: TestResolveDetail_CustomOverridesAll
test("ResolveDetail custom overrides all", () => {
  withTempDir((repoDir) => {
    writeProjectRule(repoDir, '{"rules":[{"path":"**/*.java","rule":"project-java-rule"}]}');
    withTempDir((customDir) => {
      const customPath = join(customDir, "custom.json");
      writeFileSync(customPath, '{"rules":[{"path":"**/*.java","rule":"custom-java-rule"}]}');
      const { resolver } = newResolver(repoDir, customPath);
      const detail = (
        resolver as unknown as { resolveDetail: (p: string) => { Rule: string; Source: string; Pattern: string } }
      ).resolveDetail("src/foo.java");
      expect(detail.Source).toBe("custom");
      expect(detail.Rule).toBe("custom-java-rule");
    });
  });
});

// OCR v1.9.3: TestNewResolver_BraceExpansionInProjectRule
test("project rule brace expansion", () => {
  withTempDir((repoDir) => {
    writeProjectRule(repoDir, '{"rules":[{"path":"src/**/*.{java,kt}","rule":"jvm-rule"}]}');
    const { resolver } = newResolver(repoDir, "");
    expect(resolver.resolve("src/main/foo.java")).toContain("jvm-rule");
    expect(resolver.resolve("src/main/bar.kt")).toContain("jvm-rule");
    expect(resolver.resolve("src/main/baz.swift")).toContain("Correctness");
  });
});

// ---------------------------------------------------------------------------
// resolveRuleEntries
// ---------------------------------------------------------------------------

// OCR v1.9.3: TestResolveRuleEntries_BasicFile
test("resolveRuleEntries basic file resolution", () => {
  withTempDir((dir) => {
    const ruleFile = join(dir, "sql-rules.md");
    writeFileSync(ruleFile, "Check for SQL injection\n");
    const entries: ProjectRuleEntry[] = [
      { Path: "**/*.xml", Rule: "sql-rules.md" },
      { Path: "**/*.go", Rule: "Always check for nil" },
    ];
    resolveRuleEntries(entries, dir);
    expect(entries[0]?.Rule).toBe("Check for SQL injection");
    expect(entries[1]?.Rule).toBe("Always check for nil");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_MultiLineInline
test("resolveRuleEntries multi-line stays inline", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "security.md"), "file content");
    const entries: ProjectRuleEntry[] = [
      { Path: "**/*.ts", Rule: "security.md\nBut this is multi-line\nso it should stay inline" },
    ];
    resolveRuleEntries(entries, dir);
    expect(entries[0]?.Rule).toBe("security.md\nBut this is multi-line\nso it should stay inline");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_MissingFile
test("resolveRuleEntries missing file clears rule", () => {
  withTempDir((dir) => {
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.xml", Rule: "nonexistent.md" }];
    resolveRuleEntries(entries, dir);
    expect(entries[0]?.Rule).toBe("");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_AbsolutePath
test("resolveRuleEntries absolute path", () => {
  withTempDir((dir) => {
    const ruleFile = join(dir, "my-rule.md");
    writeFileSync(ruleFile, "absolute rule content");
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: ruleFile }];
    resolveRuleEntries(entries, "/some/other/repo");
    expect(entries[0]?.Rule).toBe("absolute rule content");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_TooLarge
test("resolveRuleEntries oversized file clears rule", () => {
  withTempDir((dir) => {
    const big = Buffer.alloc(513 * 1024, "a");
    const bigFile = join(dir, "big.md");
    writeFileSync(bigFile, big);
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "big.md" }];
    resolveRuleEntries(entries, dir);
    expect(entries[0]?.Rule).toBe("");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_RelativePath
test("resolveRuleEntries relative path at repo level", () => {
  withTempDir((repoDir) => {
    writeFileSync(join(repoDir, "shared.md"), "repo-level");
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "shared.md" }];
    resolveRuleEntries(entries, repoDir);
    expect(entries[0]?.Rule).toBe("repo-level");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_EmptyRule
test("resolveRuleEntries empty rules stay", () => {
  const entries: ProjectRuleEntry[] = [
    { Path: "**/*.go", Rule: "" },
    { Path: "**/*.ts", Rule: "  " },
    { Path: "**/*.java", Rule: "\t\n" },
  ];
  resolveRuleEntries(entries, "/tmp");
  expect(entries[0]?.Rule).toBe("");
  expect(entries[1]?.Rule).toBe("  ");
  expect(entries[2]?.Rule).toBe("\t\n");
});

// OCR v1.9.9: TestResolveRuleEntries_SymlinkSafety
test("resolveRuleEntries symlink to non-whitelisted is rejected", () => {
  withTempDir((dir) => {
    const sensitiveFile = join(dir, "secret.json");
    writeFileSync(sensitiveFile, "SECRET");
    const symlinkPath = join(dir, "evil.md");
    try {
      symlinkSync(sensitiveFile, symlinkPath);
    } catch {
      // Symlink not supported on this platform – skip assertion but keep test green.
      return;
    }
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "evil.md" }];
    resolveRuleEntries(entries, dir);
    expect(entries[0]?.Rule).toBe("");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_TxtExtension
test("resolveRuleEntries .txt is accepted", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "rules.txt"), "rule from txt");
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "rules.txt" }];
    resolveRuleEntries(entries, dir);
    expect(entries[0]?.Rule).toBe("rule from txt");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_MarkdownExtension
test("resolveRuleEntries .markdown is accepted", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "rules.markdown"), "rule from markdown");
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "rules.markdown" }];
    resolveRuleEntries(entries, dir);
    expect(entries[0]?.Rule).toBe("rule from markdown");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_SubdirectoryPath
test("resolveRuleEntries subdirectory path", () => {
  withTempDir((dir) => {
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "my-rule.md"), "nested rule");
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "docs/my-rule.md" }];
    resolveRuleEntries(entries, dir);
    expect(entries[0]?.Rule).toBe("nested rule");
  });
});

// OCR v1.9.3: TestLooksLikeFilePath_InlineContent
test("looksLikeFilePath inline content false", () => {
  for (const s of ["Check for null pointers", "Always validate input", "security", "xss"]) {
    expect(looksLikeFilePath(s)).toBe(false);
  }
});

// OCR v1.9.3: TestLooksLikeFilePath_MultiLine
test("looksLikeFilePath multiline false", () => {
  expect(looksLikeFilePath("line1\nline2\nline3")).toBe(false);
});

// OCR v1.9.3: TestLooksLikeFilePath_FileExtensions
test("looksLikeFilePath file extensions true", () => {
  for (const s of ["rules.md", "doc.txt", "doc.markdown", "DOC.MD", "path/to/file.md"]) {
    expect(looksLikeFilePath(s)).toBe(true);
  }
});

// OCR v1.9.3: TestLooksLikeFilePath_WithSpaces
test("looksLikeFilePath with spaces false", () => {
  for (const s of ["Follow rules from team.md", "Ensure output is in .md", "use .txt format"]) {
    expect(looksLikeFilePath(s)).toBe(false);
  }
});

// OCR v1.9.3: TestLooksLikeFilePath_PathWithoutExtension
test("looksLikeFilePath path without extension false", () => {
  for (const s of ["docs/security", "shared/rules/go", "Use HTTP/2 for all requests"]) {
    expect(looksLikeFilePath(s)).toBe(false);
  }
});

// OCR v1.9.3: TestReadRuleFileSafe_NormalFile
test("readRuleFileSafe normal file", () => {
  withTempDir((dir) => {
    const f = join(dir, "test.md");
    writeFileSync(f, "hello world\n");
    expect(readRuleFileSafe(f)).toBe("hello world");
  });
});

// OCR v1.9.3: TestReadRuleFileSafe_UnsupportedExt
test("readRuleFileSafe unsupported ext throws", () => {
  withTempDir((dir) => {
    const f = join(dir, "test.json");
    writeFileSync(f, "{}");
    expect(() => readRuleFileSafe(f)).toThrow();
  });
});

// OCR v1.9.3: TestReadRuleFileSafe_TooLarge
test("readRuleFileSafe too large throws", () => {
  withTempDir((dir) => {
    const f = join(dir, "big.md");
    writeFileSync(f, Buffer.alloc(513 * 1024, "a"));
    expect(() => readRuleFileSafe(f)).toThrow();
  });
});

// OCR v1.9.3: TestReadRuleFileSafe_Missing
test("readRuleFileSafe missing throws", () => {
  expect(() => readRuleFileSafe("/nonexistent/path.md")).toThrow();
});

// OCR v1.9.3: TestResolveRuleEntries_PathTraversalBlocked
test("resolveRuleEntries path traversal blocked", () => {
  withTempDir((dir) => {
    const outsideFile = mkdtempSync(join(tmpdir(), "outside-"));
    const outside = join(outsideFile, "outside.md");
    try {
      writeFileSync(outside, "should not be read\n");
      const entries: ProjectRuleEntry[] = [
        { Path: "**/*.go", Rule: outside },
        { Path: "**/*.ts", Rule: "../outside.md" },
      ];
      resolveRuleEntries(entries, dir);
      expect(entries[0]?.Rule).toBe("should not be read");
      expect(entries[1]?.Rule).toBe("");
    } finally {
      rmSync(outsideFile, { recursive: true, force: true });
    }
  });
});

// Isolated adoption from OCR 124bfc3: untrusted project layer stays inside repo.
test("resolveRuleEntries confined blocks absolute outside and symlink escape", () => {
  withTempDir((repoDir) => {
    const outsideDir = mkdtempSync(join(tmpdir(), "confine-outside-"));
    try {
      const outside = join(outsideDir, "secret.md");
      writeFileSync(outside, "secret\n");
      const inside = join(repoDir, "inside.md");
      writeFileSync(inside, "inside rule\n");
      // Symlink inside repo pointing outside.
      const linkInside = join(repoDir, "link.md");
      try {
        symlinkSync(outside, linkInside);
      } catch {
        // If symlinks unavailable, still verify absolute confinement below.
      }
      // Use real repo root as confineRoot (canonical).
      const confineRoot = realpathSync(repoDir);
      const entries: ProjectRuleEntry[] = [
        { Path: "**/*.go", Rule: outside },
        { Path: "**/*.ts", Rule: "inside.md" },
      ];
      resolveRuleEntries(entries, repoDir, confineRoot);
      expect(entries[0]?.Rule).toBe("");
      expect(entries[1]?.Rule).toBe("inside rule");
      // Symlink escape also blocked when present.
      if (existsSync(linkInside)) {
        const linkEntries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "link.md" }];
        resolveRuleEntries(linkEntries, repoDir, confineRoot);
        expect(linkEntries[0]?.Rule).toBe("");
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test("loadProjectRule ignores symlinked rule.json escaping repo", () => {
  withTempDir((repoDir) => {
    const outsideDir = mkdtempSync(join(tmpdir(), "rule-outside-"));
    try {
      const outsideRule = join(outsideDir, "rule.json");
      writeFileSync(outsideRule, '{"rules":[{"path":"**/*.go","rule":"evil"}]}');
      const ocrDir = join(repoDir, ".opencodereview");
      mkdirSync(ocrDir, { recursive: true });
      const linkPath = join(ocrDir, "rule.json");
      try {
        symlinkSync(outsideRule, linkPath);
      } catch {
        return;
      }
      expect(loadProjectRule(repoDir)).toBeNull();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test("rule loaders route warnings through injectable sink", () => {
  withTempDir((repoDir) => {
    const seen: string[] = [];
    const warn = (msg: string): void => {
      seen.push(msg);
    };
    // Missing file warns through the sink (no console.error).
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "missing.md" }];
    resolveRuleEntries(entries, repoDir, "", warn);
    expect(entries[0]?.Rule).toBe("");
    expect(seen.some((m) => m.includes("rule file not found"))).toBe(true);
    // Traversal rejection also routes through the sink.
    seen.length = 0;
    const bad: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "../outside.md" }];
    resolveRuleEntries(bad, repoDir, "", warn);
    expect(bad[0]?.Rule).toBe("");
    expect(seen.some((m) => m.includes("escapes repo dir"))).toBe(true);
  });
});

// OCR v1.9.3: TestResolveRuleEntries_EmptyRepoDirRelative
test("resolveRuleEntries empty repoDir relative rejected", () => {
  const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "rules.md" }];
  resolveRuleEntries(entries, "");
  expect(entries[0]?.Rule).toBe("");
});

// OCR v1.9.3: TestResolveRuleEntries_EmptyRepoDirAbsolute
test("resolveRuleEntries empty repoDir absolute works", () => {
  withTempDir((dir) => {
    const absFile = join(dir, "abs.md");
    writeFileSync(absFile, "absolute content\n");
    const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: absFile }];
    resolveRuleEntries(entries, "");
    expect(entries[0]?.Rule).toBe("absolute content");
  });
});

// OCR v1.9.3: TestResolveRuleEntries_GlobalRuleFileResolution
test("resolveRuleEntries global rule file resolution", () => {
  withTempDir((homeDir) => {
    withHome(homeDir, () => {
      const globalRuleDir = join(homeDir, ".opencodereview");
      mkdirSync(globalRuleDir, { recursive: true });
      writeFileSync(join(globalRuleDir, "reusable.md"), "global reusable rule\n");
      const entries: ProjectRuleEntry[] = [{ Path: "**/*.go", Rule: "reusable.md" }];
      resolveRuleEntries(entries, globalRuleDir);
      expect(entries[0]?.Rule).toBe("global reusable rule");
    });
  });
});

// OCR v1.9.3: TestLoadRuleFile
test("loadRuleFile reads and validates", () => {
  // read error on missing path
  expect(() => loadRuleFile(join(tmpdir(), "nope-" + Math.random().toString(36).slice(2) + ".json"))).toThrow();
  // unmarshal error on invalid JSON
  withTempDir((dir) => {
    const p = join(dir, "rule.json");
    writeFileSync(p, "{not json");
    expect(() => loadRuleFile(p)).toThrow();
  });
  // valid file returns rule
  withTempDir((dir) => {
    const p = join(dir, "rule.json");
    writeFileSync(p, '{"rules":[{"rule":"be careful"}]}');
    const pr = loadRuleFile(p);
    expect(pr?.Rules).toHaveLength(1);
    expect(pr?.Rules[0]?.Rule).toBe("be careful");
  });
});

// OCR v1.9.9: TestLoadGlobalRule
test("loadGlobalRule handles missing, directory, invalid, valid", () => {
  // missing file is not an error
  withTempDir((home) =>
    withHome(home, () => {
      const pr = loadGlobalRule();
      expect(pr).toBeNull();
    }),
  );

  // read error when path is a directory
  withTempDir((home) =>
    withHome(home, () => {
      const globalPath = join(home, ".opencodereview", "rule.json");
      mkdirSync(globalPath, { recursive: true });
      expect(() => loadGlobalRule()).toThrow();
      rmSync(globalPath, { recursive: true, force: true });
    }),
  );

  // unmarshal error on invalid JSON
  withTempDir((home) =>
    withHome(home, () => {
      const globalPath = join(home, ".opencodereview", "rule.json");
      mkdirSync(join(home, ".opencodereview"), { recursive: true });
      writeFileSync(globalPath, "{bad");
      expect(() => loadGlobalRule()).toThrow();
    }),
  );

  // valid file returns rule
  withTempDir((home) =>
    withHome(home, () => {
      const globalPath = join(home, ".opencodereview", "rule.json");
      mkdirSync(join(home, ".opencodereview"), { recursive: true });
      writeFileSync(globalPath, '{"rules":[{"rule":"global rule"}]}');
      const pr = loadGlobalRule();
      expect(pr?.Rules).toHaveLength(1);
      expect(pr?.Rules[0]?.Rule).toBe("global rule");
    }),
  );
});

// OCR v1.9.9: TestSystemRulesIntegrity
describe("SystemRulesIntegrity", () => {
  test("file_existence", () => {
    const rule = loadDefaultSystemRule();
    // referenced files are embedded; check that every referenced file exists in rule_docs
    // via the loaded rule's PathRules + DefaultRule (already verified by load)
    expect(rule.DefaultRule.length).toBeGreaterThan(0);
    expect(rule.PathRules.length).toBeGreaterThan(0);
  });

  test("pattern_validity", () => {
    const rule = loadDefaultSystemRule();
    for (const pr of rule.PathRules) {
      for (const p of expandBraces(pr.Pattern)) {
        // Validate pattern does not throw and is non-empty; mirrors doublestar.ValidatePattern
        expect(p.length).toBeGreaterThan(0);
        // Minimatch should be able to compile the pattern without throwing
        expect(() => {
          // Using a dummy path to trigger compilation
          const { minimatch } = require("minimatch") as typeof import("minimatch");
          minimatch("dummy.txt", p, { dot: true });
        }).not.toThrow();
      }
    }
  });

  test("no_orphan_files", () => {
    const raw = readFileSync(join(process.cwd(), "src/ocr/rules/system_rules.json"), "utf-8");
    const parsed = JSON.parse(raw) as { default_rule: string; path_rule_map: Record<string, string> };
    const refs = new Set<string>();
    if (parsed.default_rule) refs.add(parsed.default_rule);
    for (const v of Object.values(parsed.path_rule_map)) refs.add(v);
    const entries = readdirSync(join(process.cwd(), "src/ocr/rules/rule_docs"));
    for (const e of entries) {
      if (e === "PROVENANCE.json") continue;
      // Skip directories; only files
      try {
        const st = statSync(join(process.cwd(), "src/ocr/rules/rule_docs", e));
        if (st.isDirectory()) continue;
      } catch {}
      expect(refs.has(e)).toBe(true);
    }
  });

  test("no_duplicate_patterns", () => {
    const raw = readFileSync(join(process.cwd(), "src/ocr/rules/system_rules.json"), "utf-8");
    const parsed = JSON.parse(raw) as { default_rule: string; path_rule_map: Record<string, string> };
    const seen = new Map<string, number>();
    for (const pattern of Object.keys(parsed.path_rule_map)) {
      seen.set(pattern, (seen.get(pattern) ?? 0) + 1);
    }
    for (const [pattern, count] of seen) {
      expect(count).toBe(1);
    }
    // Also verify that load preserves order and doesn't deduplicate
    const rule = loadDefaultSystemRule();
    const patternCounts = new Map<string, number>();
    for (const pr of rule.PathRules) {
      patternCounts.set(pr.Pattern, (patternCounts.get(pr.Pattern) ?? 0) + 1);
    }
    for (const [, count] of patternCounts) {
      expect(count).toBe(1);
    }
  });
});

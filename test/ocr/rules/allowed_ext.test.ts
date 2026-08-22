// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/allowlist/allowed_ext_test.go at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { expect, test } from "bun:test";

import { isAllowedExt, isExcludedPath } from "../../../src/ocr/rules/index.js";

const allowedExtensionCases: ReadonlyArray<readonly [string, boolean]> = [
  [".go", true],
  [".GO", true],
  [".java", true],
  [".ts", true],
  [".tsx", true],
  [".astro", true],
  [".ASTRO", true],
  [".py", true],
  [".php", true],
  [".PHP", true],
  [".phtml", true],
  [".PHTML", true],
  [".rs", true],
  [".ets", true],
  [".ETS", true],
  [".json5", true],
  [".JSON5", true],
  [".ftl", true],
  [".FTL", true],
  [".ftlh", true],
  [".FTLH", true],
  [".ftlx", true],
  [".FTLX", true],
  [".graphql", true],
  [".GRAPHQL", true],
  [".gql", true],
  [".GQL", true],
  [".prisma", true],
  [".PRISMA", true],
  [".jl", true],
  [".JL", true],
  [".hcl", true],
  [".HCL", true],
  [".tfvars", true],
  [".TFVARS", true],
  [".bicep", true],
  [".BICEP", true],
  [".proto", true],
  [".PROTO", true],
  [".nix", true],
  [".NIX", true],
  [".hs", true],
  [".HS", true],
  [".lhs", true],
  [".LHS", true],
  [".nim", true],
  [".NIM", true],
  [".nims", true],
  [".NIMS", true],
  [".nimble", true],
  [".NIMBLE", true],
  [".txt", false],
  [".md", false],
  [".png", false],
  [".lock", false],
  ["", false],
];

// OCR v1.9.3: TestIsAllowedExt
test.each(allowedExtensionCases)("isAllowedExt(%p) = %p", (ext, want) => {
  expect(isAllowedExt(ext)).toBe(want);
});

const excludedPathCases: ReadonlyArray<readonly [string, string, boolean]> = [
  ["go test in subdir", "foo/bar_test.go", true],
  ["go test at root", "bar_test.go", true],
  ["go test deeply nested", "a/b/c/d_test.go", true],
  ["go non-test file", "foo/bar.go", false],
  ["go file with test in name", "foo/testutil.go", false],

  ["java test dir", "src/test/java/com/example/FooTest.java", true],
  ["java main dir", "src/main/java/com/example/Foo.java", false],

  ["java Test suffix", "com/example/FooTest.java", true],
  ["java Tests suffix", "com/example/FooTests.java", true],
  ["java non-test", "com/example/Foo.java", false],

  ["kotlin test dir", "src/test/kotlin/FooTest.kt", true],
  ["kotlin main dir", "src/main/kotlin/Foo.kt", false],

  ["js test file", "src/utils.test.js", true],
  ["tsx test file", "src/Component.test.tsx", true],
  ["ts spec file", "src/utils.spec.ts", true],
  ["jsx spec file", "src/App.spec.jsx", true],
  ["ts non-test", "src/utils.ts", false],

  ["__tests__ dir", "src/__tests__/foo.js", true],
  ["__tests__ nested", "packages/ui/__tests__/Button.test.tsx", true],

  ["python test file", "tests/test_utils.py", false],
  ["python _test suffix", "app/handler_test.py", true],
  ["python test dir", "test/unit/handler_test.py", true],
  ["python tests dir", "tests/unit/handler_test.py", true],
  ["python non-test", "app/handler.py", false],

  ["ruby spec file", "app/models/user_spec.rb", true],
  ["ruby spec dir", "spec/models/user_spec.rb", true],
  ["ruby non-spec", "app/models/user.rb", false],

  ["rust test file", "src/parser_test.rs", true],
  ["rust non-test", "src/parser.rs", false],

  ["prisma schema", "prisma/schema.prisma", false],

  ["oh_modules root", "oh_modules/some_lib/index.ets", true],
  ["oh_modules nested", "entry/oh_modules/lib/index.ets", true],
  ["ets test file", "entry/src/test/Component.test.ets", true],
  ["ets non-test", "entry/src/main/Component.ets", false],

  ["julia test file", "test/runtests.jl", true],
  ["julia test nested", "MyPkg/test/unit/foo.jl", true],
  ["julia non-test", "src/model.jl", false],

  ["haskell test directory", "test/Parser.hs", true],
  ["haskell nested test directory", "packages/core/test/unit/Parser.hs", true],
  ["haskell spec file", "src/ParserSpec.hs", true],
  ["haskell root spec file", "ParserSpec.hs", true],
  ["haskell non-test", "src/Parser.hs", false],
  ["lhs test directory", "test/Tutorial.lhs", true],
  ["lhs nested test directory", "packages/core/test/unit/Tutorial.lhs", true],
  ["lhs spec file", "src/ParserSpec.lhs", true],
  ["lhs root spec file", "ParserSpec.lhs", true],
  ["lhs non-test", "src/Tutorial.lhs", false],

  ["nim test directory", "tests/parser_test.nim", true],
  ["nim nested test directory", "packages/core/tests/unit/parser_test.nim", true],
  ["nim non-test", "src/parser.nim", false],
  ["nim tests in filename", "src/tests_helper.nim", false],

  ["jest snapshot dir", "src/__snapshots__/App.test.js.snap", true],
  ["snap file", "src/components/Button.snap", true],
  ["snap deeply nested", "packages/ui/src/__snapshots__/util.snap", true],

  ["testdata go", "internal/parser/testdata/input.json", true],
  ["testdata nested", "pkg/a/b/testdata/golden.txt", true],
  ["fixtures dir", "test/fixtures/sample.json", true],
  ["fixtures nested", "spec/fixtures/users.yml", true],

  ["generated go", "api/types.generated.go", true],
  ["generated ts", "src/graphql/schema.generated.ts", true],
  ["gen go", "proto/message.gen.go", true],
  ["pb go", "api/v1/service.pb.go", true],
  ["pb cc", "proto/message.pb.cc", true],
  ["pb h", "proto/message.pb.h", true],

  ["snapshots in name", "src/snapshots/util.ts", false],
  ["testdata in filename", "src/testdata.go", false],
  ["fixtures in filename", "src/fixtures.ts", false],
  ["generated not dotted", "src/generated/code.go", false],
  ["gen not suffix", "src/gen/util.go", false],
  ["pb not suffix", "src/pb/client.go", false],

  ["case insensitive go", "Foo/Bar_Test.go", true],
  ["case insensitive java", "com/FooTEST.java", true],
];

// OCR v1.9.3: TestIsExcludedPath
test.each(excludedPathCases)("%s", (_name, filePath, want) => {
  expect(isExcludedPath(filePath)).toBe(want);
});

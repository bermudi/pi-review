// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/allowlist/allowed_ext_test.go at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27; updated for OCR v1.9.9
// language cases from v1.9.5/v1.9.6.

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
  [".R", true],
  [".r", true],
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
  [".ipynb", true],
  [".IPYNB", true],
  [".elm", true],
  [".ELM", true],
  [".properties", true],
  [".PROPERTIES", true],
  [".po", true],
  [".PO", true],
  [".pot", true],
  [".POT", true],
  [".jsonnet", true],
  [".JSONNET", true],
  [".libsonnet", true],
  [".LIBSONNET", true],
  [".zig", true],
  [".ZIG", true],
  [".thrift", true],
  [".THRIFT", true],
  [".capnp", true],
  [".CAPNP", true],
  [".txt", false],
  [".md", false],
  [".png", false],
  [".lock", false],
  ["", false],
];

// OCR v1.9.9: TestIsAllowedExt
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

  ["swift Tests suffix", "MyAppTests/UserTests.swift", true],
  ["swift Tests suffix nested", "Tests/AppTests/UserTests.swift", true],
  ["swift UITests suffix", "MyAppUITests/LaunchTests.swift", true],
  ["swift Test suffix", "MyAppTests/UserTest.swift", true],
  ["swift Test dir helper", "Tests/AppTests/Mocks/MockService.swift", true],
  ["swift tests dir lowercase", "tests/AppTests/Helpers/Helper.swift", true],
  ["swift non-test", "Sources/App/User.swift", false],
  ["swift helper with test in name", "Sources/App/TestSupport.swift", false],

  ["r test directory", "tests/parser_test.R", true],
  ["r nested test directory", "packages/core/tests/unit/parser_test.R", true],
  ["r non-test", "src/parser.R", false],
  ["r tests in filename", "src/tests_helper.R", false],

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

  ["elm test directory", "tests/ParserTest.elm", true],
  ["elm nested test directory", "packages/core/tests/unit/ParserTest.elm", true],
  ["elm non-test", "src/Parser.elm", false],
  ["elm tests in filename", "src/TestsHelper.elm", false],

  ["kitex_gen at root", "kitex_gen/api/service.go", true],
  ["kitex_gen nested", "app/rpc/kitex_gen/user/user.go", true],
  ["thrift idl is reviewed", "idl/service.thrift", false],
  ["hand-written generated-ish dir name", "services/generated_client/client.go", false],
  ["gen in package name only", "internal/generator/main.go", false],
  ["kitex_gen holding non-Go file", "kitex_gen/api/schema.json", false],

  ["capnp generated header", "src/schema.capnp.h", true],
  ["capnp generated go", "tunnelrpc/proto/tunnelrpc.capnp.go", true],
  ["capnp generated rust", "src/element_capnp.rs", true],
  ["capnp generated typescript", "src/rpc.capnp.ts", true],
  ["capnp generated python", "schema/addressbook_capnp.py", true],
  ["capnp schema is reviewed", "schema/addressbook.capnp", false],
  ["capnp in filename only", "src/capnp_helpers.go", false],

  ["jsonnet vendor root", "vendor/github.com/grafana/jsonnet-libs/ksonnet-util/kausal.libsonnet", true],
  ["jsonnet vendor nested dir", "jsonnet/vendor/foo/main.jsonnet", true],
  ["jsonnet non-vendor lib", "lib/config.libsonnet", false],
  ["jsonnet non-vendor env", "environments/prod/main.jsonnet", false],
  ["go under vendor still reviewed", "vendor/github.com/pkg/errors/errors.go", false],
  ["php under vendor still reviewed", "vendor/monolog/monolog/src/Logger.php", false],

  ["zig test directory", "test/parser.zig", true],
  ["zig nested test directory", "src/test/unit/parser.zig", true],
  ["zig _test suffix", "src/parser_test.zig", true],
  ["zig non-test", "src/parser.zig", false],
  ["zig test in filename", "src/testutil.zig", false],

  ["ipynb checkpoint at root", ".ipynb_checkpoints/analysis-checkpoint.ipynb", true],
  ["ipynb checkpoint nested", "notebooks/eda/.ipynb_checkpoints/eda-checkpoint.ipynb", true],
  ["ipynb outside checkpoints", "notebooks/eda/eda.ipynb", false],
  ["ipynb checkpoints without dot", "notebooks/ipynb_checkpoints/eda.ipynb", false],

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

// OCR v1.9.9: TestIsExcludedPath
test.each(excludedPathCases)("%s", (_name, filePath, want) => {
  expect(isExcludedPath(filePath)).toBe(want);
});

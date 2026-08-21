// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Ported from internal/config/rules/resolve_github_test.go at
// c35ddd7223f2b5540ce03aa43c9a25ef643fca27.

import { expect, test } from "bun:test";

import { loadDefaultSystemRule, resolveSystemRule } from "../../../src/ocr-v193/rules/index.js";

const githubCases: ReadonlyArray<readonly [string, string]> = [
  [".github/workflows/ci.yml", "pull_request_target"],
  [".github/workflows/release.yaml", "pull_request_target"],
  [".github/ISSUE_TEMPLATE/bug_report.yml", "Issue Template"],
  [".github/release.yml", "Issue Template"],
  ["config/app.yaml", "spelling errors in yaml-keys"],
  ["k8s/deployment.yml", "spelling errors in yaml-keys"],
];

// OCR v1.9.3: TestResolve_GitHubWorkflows
test.each(githubCases)("TestResolve_GitHubWorkflows %s", (filePath, wantSub) => {
  const rule = loadDefaultSystemRule();
  const got = resolveSystemRule(rule, filePath);
  expect(got).toContain(wantSub);
});

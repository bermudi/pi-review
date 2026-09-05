// SPDX-License-Identifier: Apache-2.0
// Regression test: CLI defaults, factory fallback, and the public library
// adapter must share one per-file idle-timeout default. Previously the CLI
// used 5 minutes while the library adapter hardcoded 10, making the timeout
// entry-point dependent.

import { test, expect } from "bun:test";
import {
  DEFAULT_PER_FILE_TIMEOUT_MINUTES,
  defaultReviewOptions,
  defaultScanOptions,
  resolvePerFileTimeoutMinutes,
} from "../../../src/ocr/cli/shared.js";
import { buildOcrReviewOptions } from "../../../src/ocr/reviewer.js";

test("per-file idle timeout default is centralized", () => {
  expect(DEFAULT_PER_FILE_TIMEOUT_MINUTES).toBe(5);
  expect(defaultReviewOptions().perFileTimeout).toBe(DEFAULT_PER_FILE_TIMEOUT_MINUTES);
  expect(defaultScanOptions().perFileTimeout).toBe(DEFAULT_PER_FILE_TIMEOUT_MINUTES);
});

test("resolvePerFileTimeoutMinutes falls back to the centralized default", () => {
  expect(resolvePerFileTimeoutMinutes(0)).toBe(DEFAULT_PER_FILE_TIMEOUT_MINUTES);
  expect(resolvePerFileTimeoutMinutes(-1)).toBe(DEFAULT_PER_FILE_TIMEOUT_MINUTES);
  expect(resolvePerFileTimeoutMinutes(10)).toBe(10);
});

test("library adapter uses the centralized default", () => {
  const opts = buildOcrReviewOptions(
    { repository: "/tmp/repo", mode: { kind: "workspace" } },
    { model: "test-model" },
    "",
  );
  expect(opts.perFileTimeout).toBe(DEFAULT_PER_FILE_TIMEOUT_MINUTES);
});

// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/flags_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { parseReviewFlags } from "../../../src/ocr-v193/cli/index.js";

// OCR v1.9.3: TestParseReviewFlagsBackgroundFile
test("parseReviewFlags handles background-file long and short flags", () => {
  for (const flag of ["--background-file", "-B"] as const) {
    const opts = parseReviewFlags([flag, "./docs/req.md"]);
    expect(opts.backgroundFile).toBe("./docs/req.md");
  }
});

// OCR v1.9.3: TestParseReviewFlagsModelOverride
test("parseReviewFlags model override sets model and preserves text/human defaults", () => {
  const opts = parseReviewFlags(["--model", "claude-opus-4-6"]);
  expect(opts.model).toBe("claude-opus-4-6");
  expect(opts.outputFormat).toBe("text");
  expect(opts.audience).toBe("human");
});

// OCR v1.9.3: TestParseReviewFlagsProviderAndModelOverrides
test("parseReviewFlags provider and model overrides", () => {
  const opts = parseReviewFlags(["--provider", "anthropic", "--model", "claude-opus-4-6"]);
  expect(opts.provider).toBe("anthropic");
  expect(opts.model).toBe("claude-opus-4-6");
});

// OCR v1.9.3: TestParseReviewFlagsResume
test("parseReviewFlags resume with from/to", () => {
  const opts = parseReviewFlags(["--from", "main", "--to", "feature", "--resume", "session-123"]);
  expect(opts.resume).toBe("session-123");
});

// OCR v1.9.3: TestParseReviewFlags_PreviewWithResume
test("parseReviewFlags preview with resume is rejected", () => {
  expect(() => parseReviewFlags(["--commit", "abc123", "--preview", "--resume", "session-123"])).toThrow();
  try {
    parseReviewFlags(["--commit", "abc123", "--preview", "--resume", "session-123"]);
  } catch (e) {
    const msg = String((e as Error).message);
    expect(msg).toContain("--preview and --resume cannot be used together");
  }
});

// OCR v1.9.3: TestParseReviewFlags_InvalidAudience
test("parseReviewFlags invalid audience is rejected", () => {
  expect(() => parseReviewFlags(["--audience", "robot"])).toThrow();
  try {
    parseReviewFlags(["--audience", "robot"]);
  } catch (e) {
    const msg = String((e as Error).message);
    expect(msg).toContain('invalid --audience value "robot"');
    expect(msg).toContain("must be 'human' or 'agent'");
  }
});

// OCR v1.9.3: TestParseReviewFlags_NegativeMaxTools
test("parseReviewFlags negative max-tools is rejected", () => {
  expect(() => parseReviewFlags(["--max-tools", "-1"])).toThrow();
  try {
    parseReviewFlags(["--max-tools", "-1"]);
  } catch (e) {
    const msg = String((e as Error).message);
    expect(msg).toContain("--max-tools must be a non-negative integer");
  }
});

// OCR v1.9.3: TestParseReviewFlags_MaxToolsBelowMin
test("parseReviewFlags max-tools below minimum is clamped to 10", () => {
  const opts = parseReviewFlags(["--max-tools", "5"]);
  expect(opts.maxTools).toBe(10);
});

// OCR v1.9.3: TestParseReviewFlags_NegativeMaxGitProcs
test("parseReviewFlags negative max-git-procs is rejected", () => {
  expect(() => parseReviewFlags(["--max-git-procs", "-1"])).toThrow();
  try {
    parseReviewFlags(["--max-git-procs", "-1"]);
  } catch (e) {
    const msg = String((e as Error).message);
    expect(msg).toContain("--max-git-procs must be a non-negative integer");
  }
});

// OCR v1.9.3: TestParseReviewFlags_NegativeMaxTokensBudget
test("parseReviewFlags negative max-tokens-budget is rejected", () => {
  expect(() => parseReviewFlags(["--max-tokens-budget", "-1"])).toThrow();
  try {
    parseReviewFlags(["--max-tokens-budget", "-1"]);
  } catch (e) {
    const msg = String((e as Error).message);
    expect(msg).toContain("--max-tokens-budget must be a non-negative integer");
  }
});

// OCR v1.9.3: TestParseReviewFlags_NegativeMaxTokens
test("parseReviewFlags negative max-tokens is rejected", () => {
  expect(() => parseReviewFlags(["--max-tokens", "-1"])).toThrow();
  try {
    parseReviewFlags(["--max-tokens", "-1"]);
  } catch (e) {
    const msg = String((e as Error).message);
    expect(msg).toContain("--max-tokens must be a non-negative integer");
  }
});

// OCR v1.9.3: TestParseReviewFlags_MaxTokensParsed
test("parseReviewFlags max-tokens is parsed as 200000", () => {
  const opts = parseReviewFlags(["--max-tokens", "200000"]);
  expect(opts.maxTokens).toBe(200000);
});

// OCR v1.9.3: TestParseReviewFlags_BudgetFlagsDefaultZero
test("parseReviewFlags budget default is zero", () => {
  const opts = parseReviewFlags(["--from", "main", "--to", "dev"]);
  expect(opts.maxTokensBudget).toBe(0);
});

// OCR v1.9.3: TestParseReviewFlags_BudgetFlagsParsed
test("parseReviewFlags max-tokens-budget parsed as 120000", () => {
  const opts = parseReviewFlags(["--max-tokens-budget", "120000"]);
  expect(opts.maxTokensBudget).toBe(120000);
});

// OCR v1.9.3: TestParseReviewFlags_ConflictingModes
test("parseReviewFlags conflicting from/to with commit is rejected", () => {
  expect(() => parseReviewFlags(["--from", "main", "--to", "dev", "--commit", "abc"])).toThrow();
  try {
    parseReviewFlags(["--from", "main", "--to", "dev", "--commit", "abc"]);
  } catch (e) {
    const msg = String((e as Error).message);
    expect(msg).toContain("only one review mode allowed");
  }
});

// OCR v1.9.3: TestParseReviewFlags_FromWithoutTo
test("parseReviewFlags from without to is rejected", () => {
  expect(() => parseReviewFlags(["--from", "main"])).toThrow();
  try {
    parseReviewFlags(["--from", "main"]);
  } catch (e) {
    const msg = String((e as Error).message);
    expect(msg).toContain("--to is required when --from is specified");
  }
});

// OCR v1.9.3: TestParseReviewFlags_ToWithoutFrom
test("parseReviewFlags to without from is rejected", () => {
  expect(() => parseReviewFlags(["--to", "dev"])).toThrow();
  try {
    parseReviewFlags(["--to", "dev"]);
  } catch (e) {
    const msg = String((e as Error).message);
    expect(msg).toContain("--from is required when --to is specified");
  }
});

// OCR v1.9.3: TestParseReviewFlags_ShortFlags
test("parseReviewFlags short flags -c -f -p", () => {
  const opts = parseReviewFlags(["-c", "abc123", "-f", "json", "-p"]);
  expect(opts.commit).toBe("abc123");
  expect(opts.outputFormat).toBe("json");
  expect(opts.preview).toBe(true);
});

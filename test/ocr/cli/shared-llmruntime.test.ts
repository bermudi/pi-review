// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/shared_llmruntime_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLLMRuntime } from "../../../src/ocr/cli/shared.js";

function withTempHome(fn: (home: string) => Promise<void> | void) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "ocr-llm-"));
    const prevHome = process.env.HOME;
    const prevUrl = process.env.OCR_LLM_URL;
    const prevToken = process.env.OCR_LLM_TOKEN;
    const prevModel = process.env.OCR_LLM_MODEL;
    const prevAnthBase = process.env.ANTHROPIC_BASE_URL;
    const prevAnthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const prevAnthModel = process.env.ANTHROPIC_MODEL;
    try {
      process.env.HOME = home;
      // clear LLM env for isolation; individual tests set as needed
      delete process.env.OCR_LLM_URL;
      delete process.env.OCR_LLM_TOKEN;
      delete process.env.OCR_LLM_MODEL;
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_MODEL;
      await fn(home);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUrl === undefined) delete process.env.OCR_LLM_URL; else process.env.OCR_LLM_URL = prevUrl;
      if (prevToken === undefined) delete process.env.OCR_LLM_TOKEN; else process.env.OCR_LLM_TOKEN = prevToken;
      if (prevModel === undefined) delete process.env.OCR_LLM_MODEL; else process.env.OCR_LLM_MODEL = prevModel;
      if (prevAnthBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevAnthBase;
      if (prevAnthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prevAnthToken;
      if (prevAnthModel === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = prevAnthModel;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// OCR v1.9.3: TestLoadLLMRuntime_Success
test("loadLLMRuntime success resolves env", withTempHome(async () => {
  process.env.OCR_LLM_URL = "https://api.example.test/v1";
  process.env.OCR_LLM_TOKEN = "tok-123";
  process.env.OCR_LLM_MODEL = "test-model";
  const tpl = { applyLanguage: () => {} };
  const rt = await loadLLMRuntime(tpl as unknown as { applyLanguage: (s: string) => void }, "", {});
  expect(rt.model).toBe("test-model");
  expect(rt.client).not.toBeNull();
  expect(rt.collector).not.toBeNull();
  expect(rt.mainToolDefs.length).toBeGreaterThan(0);
  expect(rt.runtimeConfig.endpointHost).toBe("api.example.test");
}));

// OCR v1.9.3: TestLoadLLMRuntime_BadToolConfig
test("loadLLMRuntime bad tool config", withTempHome(async () => {
  const tpl = { applyLanguage: () => {} };
  await expect(loadLLMRuntime(tpl as unknown as { applyLanguage: (s: string) => void }, join(tmpdir(), "no-such-tools.json"), {})).rejects.toThrow(/load tools/);
}));

// OCR v1.9.3: TestLoadLLMRuntime_UnresolvableEndpoint
test("loadLLMRuntime unresolvable endpoint", withTempHome(async () => {
  const tpl = { applyLanguage: () => {} };
  await expect(loadLLMRuntime(tpl as unknown as { applyLanguage: (s: string) => void }, "", {})).rejects.toThrow(/resolve LLM endpoint/);
}));

test("loadLLMRuntime ignores OCR app config because Pi owns runtime settings", withTempHome(async (home) => {
  const cfgDir = join(home, ".opencodereview");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), "{not json", "utf8");
  const tpl = { applyLanguage: () => {} };
  await expect(loadLLMRuntime(tpl as unknown as { applyLanguage: (s: string) => void }, "", {})).rejects.toThrow(/resolve LLM endpoint/);
}));

// Public Pi ModelRuntime selection boundary; no network or credentials.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiModelSelection } from "../../../src/ocr/cli/factory.js";

test("resolves explicit provider/model through public Pi ModelRuntime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-model-runtime-"));
  try {
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      providers: {
        "test-provider": {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          models: [
            { id: "test-model", name: "Test", reasoning: true, input: ["text"], contextWindow: 4096, maxTokens: 1024 },
            { id: "vendor/test-model", name: "Slash", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 },
          ],
        },
        "other-provider": {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          models: [{ id: "test-model", name: "Other", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 }],
        },
      },
    }));
    const selected = await resolvePiModelSelection(dir, "", "test-provider/test-model");
    if (selected === null) throw new Error("model selection unexpectedly empty");
    expect(selected.identity).toEqual({ provider: "test-provider", model: "test-model" });
    expect(selected.model.id).toBe("test-model");
    const thinking = await resolvePiModelSelection(dir, "", "test-provider/test-model:high");
    expect(thinking?.identity).toEqual({ provider: "test-provider", model: "test-model" });
    expect(thinking?.thinkingLevel).toBe("high");
    const slashId = await resolvePiModelSelection(dir, "test-provider", "vendor/test-model");
    expect(slashId?.identity).toEqual({ provider: "test-provider", model: "vendor/test-model" });
    await expect(resolvePiModelSelection(dir, "test-provider", "")).rejects.toThrow("ambiguous");
    await expect(resolvePiModelSelection(dir, "", "test-model")).rejects.toThrow("ambiguous");
    await expect(resolvePiModelSelection(dir, "other", "test-provider/test-model")).rejects.toThrow("Unknown provider");
    await expect(resolvePiModelSelection(dir, "", "missing/model")).rejects.toThrow("not found");
    // Unknown id under a known provider synthesizes a default-spec custom
    // model — allowed, but never silently.
    let warned = "";
    const synthesized = await resolvePiModelSelection(dir, "", "test-provider/no-such-model", (m) => { warned = m; });
    expect(synthesized?.identity).toEqual({ provider: "test-provider", model: "no-such-model" });
    expect(warned).toContain("Using custom model id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaves Pi default selection untouched without flags", async () => {
  expect(await resolvePiModelSelection("/does/not/matter", "", "")).toBeNull();
});

test("resolves models recorded only in Pi's local catalog cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-model-cache-"));
  try {
    // No custom providers: the model exists only in models-store.json, the
    // cached provider catalog Pi's CLI keeps fresh. This pins the
    // create-time catalog restore that selector resolution depends on —
    // without it, only built-in plus custom models.json models resolve,
    // and cached catalog data (newer models, corrected context windows)
    // is invisible to --model selectors.
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }));
    writeFileSync(join(dir, "models-store.json"), JSON.stringify({
      openrouter: {
        checkedAt: "2026-01-01T00:00:00.000Z",
        // Entries without freshness markers are treated as stale and skipped
        // by Pi's catalog restore; mirror the real cache shape.
        lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
        etag: "test-etag",
        models: [{
          id: "cache-only/test-model",
          name: "Cache Only Test",
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          provider: "openrouter",
          reasoning: true,
          input: ["text"],
          contextWindow: 1234567,
          maxTokens: 65536,
        }],
      },
    }));
    const selected = await resolvePiModelSelection(dir, "", "openrouter/cache-only/test-model");
    if (selected === null) throw new Error("model selection unexpectedly empty");
    expect(selected.identity).toEqual({ provider: "openrouter", model: "cache-only/test-model" });
    // The cache's spec is used verbatim — a synthesized fallback would carry
    // Pi's default context window instead.
    expect(selected.model.contextWindow).toBe(1234567);
    const thinking = await resolvePiModelSelection(dir, "", "openrouter/cache-only/test-model:max");
    expect(thinking?.identity).toEqual({ provider: "openrouter", model: "cache-only/test-model" });
    expect(thinking?.thinkingLevel).toBe("max");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

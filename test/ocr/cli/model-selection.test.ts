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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaves Pi default selection untouched without flags", async () => {
  expect(await resolvePiModelSelection("/does/not/matter", "", "")).toBeNull();
});

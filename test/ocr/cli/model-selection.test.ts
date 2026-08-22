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
          models: [{ id: "test-model", name: "Test", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 }],
        },
      },
    }));
    const selected = await resolvePiModelSelection(dir, "", "test-provider/test-model");
    if (selected === null) throw new Error("model selection unexpectedly empty");
    expect(selected.identity).toBe("test-provider/test-model");
    expect(selected.model.id).toBe("test-model");
    await expect(resolvePiModelSelection(dir, "other", "test-provider/test-model")).rejects.toThrow("does not match");
    await expect(resolvePiModelSelection(dir, "", "missing/model")).rejects.toThrow("unknown model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

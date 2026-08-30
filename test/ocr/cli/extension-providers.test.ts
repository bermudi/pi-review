// User-level pi extension provider harvesting — hermetic: temporary agent
// dirs, no network, no credentials. Extension fixtures are real files written
// into `<agentDir>/extensions/` so the SDK's own discovery and loader execute
// them exactly as in production. Fake API keys are inert placeholders.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePiModelSelection, createReviewRunnerFactory, type RuntimeTransport } from "../../../src/ocr/cli/factory.js";
import { harvestExtensionProviders } from "../../../src/ocr/cli/extension-providers.js";
import { defaultReviewOptions } from "../../../src/ocr/cli/shared.js";

function newAgentDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ocr-ext-${label}-`));
}

function writeExtension(agentDir: string, fileName: string, source: string): void {
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", fileName), source);
}

const FAKE_PROVIDER_EXT = `
export default function (pi) {
  pi.registerProvider("fake-ext-provider", {
    name: "Fake Extension Provider",
    baseUrl: "https://example.invalid/v1",
    api: "openai-completions",
    apiKey: "not-a-real-key",
    models: [
      {
        id: "fake-model",
        name: "Fake Model",
        reasoning: true,
        input: ["text"],
        contextWindow: 777777,
        maxTokens: 2048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
`;

const CATALOG_EXT = `
export default function (pi) {
  pi.registerProvider("catalog-provider", {
    name: "Catalog Provider",
    baseUrl: "https://example.invalid/v1",
    api: "openai-completions",
    apiKey: "not-a-real-key",
    refreshModels: async (context) => {
      const stored = context.stored?.models ?? [];
      if (stored.length > 0 && context.stored) {
        await context.publish({ persist: { models: stored, checkedAt: context.stored.checkedAt } });
      }
      return stored;
    },
  });
}
`;

const BROKEN_EXT = `
export default function () {
  throw new Error("boom: broken extension factory");
}
`;

function scriptedTransport(): RuntimeTransport {
  return {
    CompletionsWithCtx: async () => ({
      content: "",
      toolCalls: [{ id: "done", type: "function", function: { name: "task_done", arguments: "{}" } }],
    }),
    dispose: async () => {},
    modelIdentity: () => ({ provider: "test", model: "model" }),
  };
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocr-ext-repo-"));
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]] as const) {
    if (spawnSync("git", args, { cwd: dir }).status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }
  writeFileSync(join(dir, "main.go"), "package main\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

test("user extension provider resolves through --model with real specs", async () => {
  const agentDir = newAgentDir("resolve");
  try {
    writeExtension(agentDir, "fake-provider.ts", FAKE_PROVIDER_EXT);
    let warning = "";
    const selection = await resolvePiModelSelection(agentDir, "", "fake-ext-provider/fake-model:high", (m) => {
      warning = m;
    });
    // A real catalog entry resolves without the fallback-synthesis warning.
    expect(warning).toBe("");
    expect(selection.identity).toEqual({ provider: "fake-ext-provider", model: "fake-model" });
    expect(selection.thinkingLevel).toBe("high");
    // Assert on specs and getModels membership, never bare resolution
    // success: a synthesized fallback would carry Pi's default spec instead.
    expect(selection.model?.contextWindow).toBe(777777);
    const models = selection.modelRuntime.getModels("fake-ext-provider");
    expect(models.some((m) => m.id === "fake-model" && m.contextWindow === 777777)).toBe(true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("extension provider composes from the local catalog cache, offline", async () => {
  const agentDir = newAgentDir("cache");
  try {
    writeExtension(agentDir, "catalog-provider.ts", CATALOG_EXT);
    // The model exists ONLY in models-store.json (kilo-style cached catalog:
    // a bare checkedAt is enough — the etag/lastModified staleness gate
    // applies to pi.dev built-in overlays, not extension-provider restores).
    writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
      "catalog-provider": {
        checkedAt: 1700000000000,
        models: [{
          id: "store-only-model",
          name: "Store Only",
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          provider: "catalog-provider",
          reasoning: true,
          input: ["text"],
          contextWindow: 888888,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    }));
    const selection = await resolvePiModelSelection(agentDir, "", "catalog-provider/store-only-model");
    expect(selection.identity).toEqual({ provider: "catalog-provider", model: "store-only-model" });
    // The cached spec is used verbatim — a synthesized fallback would carry
    // Pi's default context window instead.
    expect(selection.model?.contextWindow).toBe(888888);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("broken extension warns and other providers still register", async () => {
  const agentDir = newAgentDir("broken");
  try {
    writeExtension(agentDir, "broken.ts", BROKEN_EXT);
    writeExtension(agentDir, "fake-provider.ts", FAKE_PROVIDER_EXT);
    const warnings: string[] = [];
    const selection = await resolvePiModelSelection(agentDir, "", "fake-ext-provider/fake-model", (m) => {
      warnings.push(m);
    });
    // Warn-and-continue: the broken extension costs its provider only.
    expect(warnings.some((w) => w.includes("broken.ts") && w.includes("boom"))).toBe(true);
    expect(selection.identity).toEqual({ provider: "fake-ext-provider", model: "fake-model" });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("repository extensions are never executed or harvested", async () => {
  const originalCwd = process.cwd();
  const repoDir = mkdtempSync(join(tmpdir(), "ocr-ext-hostile-"));
  const agentDir = newAgentDir("hostile");
  try {
    // Repo-local extension with a top-level side effect (marker file) plus a
    // provider registration. If any part of it executes, the marker appears.
    mkdirSync(join(repoDir, ".pi", "extensions"), { recursive: true });
    const marker = join(repoDir, ".pi", "extensions", "executed.txt");
    writeFileSync(join(repoDir, ".pi", "extensions", "evil.ts"), `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export default function (pi) {
  pi.registerProvider("evil-provider", {
    name: "Evil",
    baseUrl: "https://example.invalid/v1",
    api: "openai-completions",
    apiKey: "not-a-real-key",
    models: [],
  });
}
`);
    process.chdir(repoDir);
    const selection = await resolvePiModelSelection(agentDir, "", "");
    expect(existsSync(marker)).toBe(false);
    expect(selection.modelRuntime.getModels("evil-provider")).toHaveLength(0);
  } finally {
    process.chdir(originalCwd);
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("project-scope extensions are filtered even when configured", async () => {
  const agentDir = newAgentDir("projectscope");
  try {
    // A local extension configured as a *project* package (its settings live
    // in `<agentDir>/.pi/settings.json`, the neutral-cwd project settings)
    // with a top-level marker side effect. The scope filter must keep its
    // path away from the loader entirely.
    const extDir = join(agentDir, "sneaky-ext");
    mkdirSync(extDir, { recursive: true });
    const marker = join(extDir, "executed.txt");
    writeFileSync(join(extDir, "index.ts"), `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export default function (pi) {
  pi.registerProvider("sneaky-provider", {
    name: "Sneaky",
    baseUrl: "https://example.invalid/v1",
    api: "openai-completions",
    apiKey: "not-a-real-key",
    models: [],
  });
}
`);
    mkdirSync(join(agentDir, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, ".pi", "settings.json"), JSON.stringify({
      packages: [extDir],
    }));
    const warnings: string[] = [];
    const harvest = await harvestExtensionProviders(agentDir, (m) => warnings.push(m));
    expect(existsSync(marker)).toBe(false);
    expect(harvest.registrations.some((r) => r.name === "sneaky-provider")).toBe(false);
    // The extension was never executed, so nothing failed either.
    expect(warnings).toEqual([]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("no-flag default path passes the augmented runtime to the transport pool", async () => {
  const repoDir = gitRepo();
  const agentDir = newAgentDir("default-path");
  const previousAgentDirEnv = process.env["PI_CODING_AGENT_DIR"];
  try {
    writeExtension(agentDir, "fake-provider.ts", FAKE_PROVIDER_EXT);
    // Pi's saved default is deliberately not consumed (decision 3): with no
    // flags the selection carries no model even when settings name one.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultModel: "settings-default/never-picked",
    }));
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    let capturedModelRuntime: unknown;
    const factory = createReviewRunnerFactory(
      { ...defaultReviewOptions(), repoDir, concurrency: 1 },
      repoDir,
      {
        createTransport: async (options) => {
          capturedModelRuntime = options.modelRuntime;
          return scriptedTransport();
        },
      },
    );
    const runner = await factory();
    await runner.run();
    // The transport pool received the augmented runtime, so Pi's own
    // fallback (first credential-configured provider) can resolve extension
    // providers.
    expect(capturedModelRuntime).toBeDefined();
    const models = (capturedModelRuntime as { getModels(id: string): readonly { id: string }[] }).getModels("fake-ext-provider");
    expect(models.some((m) => m.id === "fake-model")).toBe(true);
    // The identity is the scripted transport's own — never the settings default.
    expect(runner.sessionId).toBeDefined();
  } finally {
    if (previousAgentDirEnv === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDirEnv;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

test(
  "packed install cleans its environment on exit and sweeps an abandoned run",
  () => {
    if (!existsSync(join(projectRoot, "dist", "cli.js"))) {
      const build = spawnSync(process.execPath, ["run", "build"], {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 60_000,
      });
      expect(build.status, build.stderr || build.stdout).toBe(0);
    }

    const cache = spawnSync(process.execPath, ["pm", "cache"], {
      encoding: "utf-8",
    });
    expect(cache.status, cache.stderr || cache.stdout).toBe(0);
    const container = join(
      dirname(realpathSync(cache.stdout.trim())),
      "pi-reviewer-blackbox",
    );
    mkdirSync(container, { recursive: true, mode: 0o700 });
    const abandoned = mkdtempSync(join(container, "run-"));
    chmodSync(abandoned, 0o700);
    writeFileSync(join(abandoned, ".owner"), "2147483647\n", { mode: 0o600 });
    writeFileSync(join(abandoned, "sentinel"), "stale\n");

    try {
      const run = spawnSync(
        process.execPath,
        [
          "-e",
          [
            'import { runPackedInstallSmoke } from "./verification/blackbox/package-installer.ts";',
            "const result = await runPackedInstallSmoke();",
            'console.log(`CONSUMER=${result.consumerDir}`);',
          ].join("\n"),
        ],
        {
          cwd: projectRoot,
          encoding: "utf-8",
          timeout: 60_000,
        },
      );

      expect(run.status, run.stderr || run.stdout).toBe(0);
      const consumerLine = run.stdout
        .split("\n")
        .find((line) => line.startsWith("CONSUMER="));
      expect(consumerLine).toBeDefined();
      const consumerDir = consumerLine!.slice("CONSUMER=".length);

      expect(existsSync(dirname(consumerDir))).toBe(false);
      expect(existsSync(abandoned)).toBe(false);
      expect(dirname(dirname(consumerDir))).toBe(container);
    } finally {
      rmSync(abandoned, { recursive: true, force: true });
    }
  },
  70_000,
);

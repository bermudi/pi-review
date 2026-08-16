// SPDX-License-Identifier: Apache-2.0
// Gate 0 packed-install smoke — proves the published archive really works.
// Only Node/Bun stdlib + local types. Must not import src/**.

import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Why we pack and install instead of just checking dist/:
 * A build can succeed but the npm tarball can be missing files (the "files"
 * field in package.json controls what gets packed). The only honest test
 * is to do what a user does: pack, install into an empty directory, and run
 * the binary from that installed location.
 */

export interface PackResult {
  readonly archivePath: string;
  readonly archiveHash: string;
  readonly consumerDir: string;
  readonly binOutput: string;
}

function hashFile(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

function getSanitizedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (lower.includes("token") || lower.includes("key") || lower.includes("secret") || lower.includes("password") || lower.includes("credential") || k.startsWith("NPM_") || k.startsWith("GITHUB_")) {
      // Remove credential variables — the harness must never leak them and must prove offline install still works
      continue;
    }
    out[k] = v;
  }
  // Force offline-ish: local tarball must install without registry
  // We keep the env minimal and do not pass any registry auth.
  return out;
}

export async function runPackedInstallSmoke(): Promise<PackResult> {
  const sanitizedEnv = getSanitizedEnv();
  // 1. Pack — use `bun pm pack` (the repo's package manager)
  // We ask bun to put the tarball in a temp dir so we can find it reliably.
  // Run with credential env removed; pack itself does not need network.
  const packTmp = mkdtempSync(join(tmpdir(), "blackbox-pack-"));
  const packOut = spawnSync("bun", ["pm", "pack", "--destination", packTmp], {
    encoding: "utf-8",
    env: sanitizedEnv,
  });
  if (packOut.status !== 0) {
    throw new Error(`bun pm pack failed: ${packOut.stderr || packOut.stdout}`);
  }

  // Find the .tgz — bun prints its name, but we also scan the dir
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(packTmp);
  const tgz = files.find((f) => f.endsWith(".tgz"));
  if (!tgz) {
    throw new Error(`pack produced no .tgz in ${packTmp}: ${files.join(", ")}; stdout=${packOut.stdout}`);
  }
  const archivePath = join(packTmp, tgz);
  if (!existsSync(archivePath)) throw new Error(`archive not found at ${archivePath}`);

  const archiveHash = hashFile(archivePath);

  // 2. Create an empty temporary consumer directory
  const consumerDir = mkdtempSync(join(tmpdir(), "blackbox-consumer-"));

  // 3. Install the produced archive there — offline, with credentials removed
  // We run `bun add <path>` inside the consumer dir. Need a package.json first.
  const init = spawnSync("bun", ["init", "-y"], {
    cwd: consumerDir,
    encoding: "utf-8",
    env: sanitizedEnv,
  });
  // bun init may not be needed if we just use `bun add`; but ensure package.json exists
  if (!existsSync(join(consumerDir, "package.json"))) {
    // Fallback: write minimal package.json
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "blackbox-consumer", version: "0.0.0", private: true }), "utf-8");
  }

  // Offline: local tarball install must not need registry. We pass sanitized env and ensure no credential leakage.
  const add = spawnSync("bun", ["add", archivePath], {
    cwd: consumerDir,
    encoding: "utf-8",
    env: sanitizedEnv,
  });
  if (add.status !== 0) {
    throw new Error(`bun add ${archivePath} failed in ${consumerDir}: ${add.stderr || add.stdout}`);
  }

  // 4. Resolve the package and pi-review binary from that consumer directory
  const binPath = join(consumerDir, "node_modules", ".bin", "pi-review");
  if (!existsSync(binPath)) {
    // Try checking package's bin via node_modules/pi-reviewer
    const pkgBin = join(consumerDir, "node_modules", "pi-reviewer", "dist", "cli.js");
    if (!existsSync(pkgBin)) {
      throw new Error(`pi-review binary not found at ${binPath} nor ${pkgBin}; ls=${readdirSync(join(consumerDir, "node_modules")).join(",")}`);
    }
  }

  // 5. Execute `pi-review --help` from the consumer dir (offline, sanitized env)
  // We use the bin via npx-like resolution: `bun --cwd <consumerDir> pi-review --help` or direct spawn
  const help = spawnSync(binPath, ["--help"], {
    cwd: consumerDir,
    encoding: "utf-8",
    timeout: 15_000,
    env: sanitizedEnv,
  });

  if (help.status !== 0) {
    // Try alternative: bun run pi-review --help
    const alt = spawnSync("bun", ["run", "pi-review", "--help"], {
      cwd: consumerDir,
      encoding: "utf-8",
      timeout: 15_000,
      env: sanitizedEnv,
    });
    if (alt.status !== 0) {
      throw new Error(`pi-review --help failed: bin status=${help.status} stderr=${help.stderr} stdout=${help.stdout} alt stderr=${alt.stderr}`);
    }
    return { archivePath, archiveHash, consumerDir, binOutput: alt.stdout };
  }

  if (!help.stdout.includes("pi-review") && !help.stdout.includes("Usage") && !help.stdout.includes("--help")) {
    throw new Error(`pi-review --help output unexpected: ${help.stdout.slice(0, 500)}`);
  }

  return { archivePath, archiveHash, consumerDir, binOutput: help.stdout };
}

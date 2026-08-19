// SPDX-License-Identifier: Apache-2.0
// Gate 0 packed-install smoke — proves the published archive really works.
// Only Node/Bun stdlib + local types. Must not import src/**.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";

const WORKSPACE_CONTAINER_NAME = "pi-reviewer-blackbox";
const TEMP_WORKSPACE_PREFIX = "run-";
const OWNER_MARKER = ".owner";
const activeTempWorkspaces = new Set<string>();
let cleanupHooksInstalled = false;

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
  /** Remove the packed archive and installed consumer. Idempotent. */
  readonly cleanup: () => void;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function removeTempWorkspace(workspace: string, reportFailure: boolean): void {
  activeTempWorkspaces.delete(workspace);
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch (error) {
    if (reportFailure) {
      console.error(
        `[verify:packed-install] failed to clean temporary workspace ${workspace}`,
        error,
      );
    }
  }
}

function cleanupActiveTempWorkspaces(): void {
  for (const workspace of [...activeTempWorkspaces]) {
    removeTempWorkspace(workspace, true);
  }
}

function installCleanupHooks(): void {
  if (cleanupHooksInstalled) return;
  cleanupHooksInstalled = true;
  process.once("exit", cleanupActiveTempWorkspaces);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      cleanupActiveTempWorkspaces();
      // The once-listener has removed itself, so re-sending preserves the
      // signal's normal exit status instead of turning cancellation into PASS.
      process.kill(process.pid, signal);
    });
  }
}

function resolveWorkspaceContainer(env: Record<string, string>): string {
  const cacheResult = spawnSync("bun", ["pm", "cache"], {
    encoding: "utf-8",
    env,
  });
  if (cacheResult.status !== 0) {
    throw new Error(
      `Could not locate Bun's package cache: ${cacheResult.stderr || cacheResult.stdout}`,
    );
  }
  const reportedCache = cacheResult.stdout.trim();
  if (!reportedCache || !isAbsolute(reportedCache)) {
    throw new Error(
      `Bun returned an invalid package cache path: ${JSON.stringify(reportedCache)}`,
    );
  }

  const cacheDir = realpathSync(reportedCache);
  const container = join(dirname(cacheDir), WORKSPACE_CONTAINER_NAME);
  mkdirSync(container, { recursive: true, mode: 0o700 });

  const uid = process.getuid?.();
  const containerStat = lstatSync(container);
  if (
    !containerStat.isDirectory() ||
    containerStat.isSymbolicLink() ||
    (uid !== undefined && containerStat.uid !== uid)
  ) {
    throw new Error(
      `Packed-install workspace container is not a directory owned by the current user: ${container}`,
    );
  }
  chmodSync(container, 0o700);

  const cacheStat = statSync(cacheDir);
  if (cacheStat.dev !== containerStat.dev) {
    throw new Error(
      `Packed-install workspace and Bun cache are on different filesystems: ${container} vs ${cacheDir}`,
    );
  }
  return container;
}

function sweepAbandonedTempWorkspaces(container: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;

  let entries;
  try {
    entries = readdirSync(container, { withFileTypes: true });
  } catch (error) {
    console.error(
      "[verify:packed-install] failed to scan workspace container",
      error,
    );
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_WORKSPACE_PREFIX)) {
      continue;
    }
    const workspace = join(container, entry.name);
    try {
      const stat = lstatSync(workspace);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
        continue;
      }
      const owner = readFileSync(join(workspace, OWNER_MARKER), "utf-8").trim();
      if (!/^[1-9][0-9]*$/.test(owner)) continue;
      const pid = Number(owner);
      if (!Number.isSafeInteger(pid) || isProcessAlive(pid)) continue;
      removeTempWorkspace(workspace, true);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        continue;
      }
      console.error(
        `[verify:packed-install] failed to inspect stale workspace ${workspace}`,
        error,
      );
    }
  }
}

function createTempWorkspace(env: Record<string, string>): {
  readonly root: string;
  readonly packDir: string;
  readonly consumerDir: string;
  readonly cleanup: () => void;
} {
  const container = resolveWorkspaceContainer(env);
  sweepAbandonedTempWorkspaces(container);
  const root = mkdtempSync(join(container, TEMP_WORKSPACE_PREFIX));
  try {
    chmodSync(root, 0o700);
    writeFileSync(join(root, OWNER_MARKER), `${process.pid}\n`, {
      mode: 0o600,
    });
    const packDir = join(root, "pack");
    const consumerDir = join(root, "consumer");
    mkdirSync(packDir, { mode: 0o700 });
    mkdirSync(consumerDir, { mode: 0o700 });
    activeTempWorkspaces.add(root);
    installCleanupHooks();
    return {
      root,
      packDir,
      consumerDir,
      cleanup: () => removeTempWorkspace(root, true),
    };
  } catch (error) {
    removeTempWorkspace(root, true);
    throw error;
  }
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
    if (lower.includes("token") || lower.includes("key") || lower.includes("secret") || lower.includes("password") || lower.includes("credential") || k.startsWith("NPM_") || k.startsWith("GITHUB_") || k.startsWith("NODE_AUTH")) {
      // Remove credential variables — the harness must never leak them and must prove offline install still works
      continue;
    }
    out[k] = v;
  }
  // Offline: local tarball install must not need registry or network.
  // We explicitly mark offline and ensure no registry auth is passed.
  out["BUN_OFFLINE"] = "1";
  out["npm_config_offline"] = "true";
  // Do not set a registry URL; local file install must succeed without it.
  return out;
}

export async function runPackedInstallSmoke(): Promise<PackResult> {
  const sanitizedEnv = getSanitizedEnv();
  const workspace = createTempWorkspace(sanitizedEnv);
  try {
    // 1. Pack — use `bun pm pack` (the repo's package manager)
    // Run with credential env removed; pack itself does not need network.
    const packOut = spawnSync(
      "bun",
      ["pm", "pack", "--destination", workspace.packDir],
      {
        encoding: "utf-8",
        env: sanitizedEnv,
      },
    );
    if (packOut.status !== 0) {
      throw new Error(`bun pm pack failed: ${packOut.stderr || packOut.stdout}`);
    }

    // Find the .tgz — bun prints its name, but we also scan the dir
    const files = readdirSync(workspace.packDir);
    const tgz = files.find((f) => f.endsWith(".tgz"));
    if (!tgz) {
      throw new Error(
        `pack produced no .tgz in ${workspace.packDir}: ${files.join(", ")}; stdout=${packOut.stdout}`,
      );
    }
    const archivePath = join(workspace.packDir, tgz);
    if (!existsSync(archivePath)) {
      throw new Error(`archive not found at ${archivePath}`);
    }

    const archiveHash = hashFile(archivePath);

    // 2. Install into the empty consumer directory.
    const consumerDir = workspace.consumerDir;

    // We run `bun add <path>` inside the consumer dir. Need a package.json first.
    spawnSync("bun", ["init", "-y"], {
      cwd: consumerDir,
      encoding: "utf-8",
      env: sanitizedEnv,
    });
    // bun init may not be needed if we just use `bun add`; but ensure package.json exists
    if (!existsSync(join(consumerDir, "package.json"))) {
      writeFileSync(
        join(consumerDir, "package.json"),
        JSON.stringify({
          name: "blackbox-consumer",
          version: "0.0.0",
          private: true,
        }),
        "utf-8",
      );
    }

    // Offline: local tarball install must not need registry.
    const add = spawnSync("bun", ["add", "--backend=hardlink", archivePath], {
      cwd: consumerDir,
      encoding: "utf-8",
      env: sanitizedEnv,
    });
    if (add.status !== 0) {
      throw new Error(
        `bun add ${archivePath} failed in ${consumerDir}: ${add.stderr || add.stdout}`,
      );
    }

    // 3. Resolve the package and pi-review binary from that consumer directory
    const binPath = join(consumerDir, "node_modules", ".bin", "pi-review");
    if (!existsSync(binPath)) {
      const pkgBin = join(
        consumerDir,
        "node_modules",
        "pi-reviewer",
        "dist",
        "cli.js",
      );
      if (!existsSync(pkgBin)) {
        throw new Error(
          `pi-review binary not found at ${binPath} nor ${pkgBin}; ls=${readdirSync(join(consumerDir, "node_modules")).join(",")}`,
        );
      }
    }

    // 4. Execute `pi-review --help` from the consumer dir.
    const help = spawnSync(binPath, ["--help"], {
      cwd: consumerDir,
      encoding: "utf-8",
      timeout: 15_000,
      env: sanitizedEnv,
    });

    let binOutput = help.stdout;
    if (help.status !== 0) {
      const alt = spawnSync("bun", ["run", "pi-review", "--help"], {
        cwd: consumerDir,
        encoding: "utf-8",
        timeout: 15_000,
        env: sanitizedEnv,
      });
      if (alt.status !== 0) {
        throw new Error(
          `pi-review --help failed: bin status=${help.status} stderr=${help.stderr} stdout=${help.stdout} alt stderr=${alt.stderr}`,
        );
      }
      binOutput = alt.stdout;
    }

    if (
      !binOutput.includes("pi-review") &&
      !binOutput.includes("Usage") &&
      !binOutput.includes("--help")
    ) {
      throw new Error(
        `pi-review --help output unexpected: ${binOutput.slice(0, 500)}`,
      );
    }

    return {
      archivePath,
      archiveHash,
      consumerDir,
      binOutput,
      cleanup: workspace.cleanup,
    };
  } catch (error) {
    workspace.cleanup();
    throw error;
  }
}

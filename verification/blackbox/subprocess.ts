// SPDX-License-Identifier: Apache-2.0
// Gate 0 subprocess capture — runs a command with isolation and records boundary evidence.
// Allowed: Node/Bun stdlib + local types. No src/**.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import type { ProcessCapture } from "./types.js";
import type { FakeProviderServer } from "./server.js";
import { validateProcessCapture } from "./schemas.js";

/**
 * Why isolation matters:
 * Each engine gets its own HOME, its own server, and no credential env vars.
 * That way a test that makes Pi never contact its server can't cheat by
 * reusing OCR's capture file — it must actually show zero HTTP requests.
 */

const CREDENTIAL_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "PI_CODING_AGENT_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];

function sanitizeEnv(input: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (CREDENTIAL_ENV_VARS.includes(k)) continue;
    if (k.toLowerCase().includes("key") || k.toLowerCase().includes("token") || k.toLowerCase().includes("secret")) {
      // Keep the key name but redact value for artifact
      out[k] = "<REDACTED>";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface RunOpts {
  readonly engine: "ocr" | "pi";
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly server: FakeProviderServer;
  readonly extraEnv?: Record<string, string>;
  readonly artifactDir: string;
  readonly timeoutMs?: number;
}

/**
 * Run a command, capture stdout/stderr/exit, and tie it to the server's HTTP captures.
 * The caller must have already started the server and will stop it afterwards.
 *
 * The artifactDir gets:
 *   <artifactDir>/<engine>/capture.json  — the ProcessCapture (validated by zod)
 *   <artifactDir>/<engine>/stdout.txt
 *   <artifactDir>/<engine>/stderr.txt
 *   <artifactDir>/<engine>/provider-requests.json  — sanitized HTTP captures
 */
export async function runIsolatedSubprocess(opts: RunOpts): Promise<ProcessCapture> {
  const isolatedHome = mkdtempSync(join(tmpdir(), `blackbox-home-${opts.engine}-`));
  const isolatedTmp = mkdtempSync(join(tmpdir(), `blackbox-tmp-${opts.engine}-`));

  const env: Record<string, string> = {
    ...sanitizeEnv(process.env),
    HOME: isolatedHome,
    TMPDIR: isolatedTmp,
    PROVIDER_URL: opts.server.url,
    // Ensure no network beyond loopback — provider URL is the only allowed host
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ...opts.extraEnv,
  };

  // Remove any credential vars that slipped through
  for (const k of CREDENTIAL_ENV_VARS) delete env[k];

  const [cmd, ...args] = opts.command;
  if (!cmd) throw new Error("empty command");

  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));

  const exitCode: number | null = await new Promise<number | null>((resolve, reject) => {
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`subprocess timeout after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    child.on("close", (code, _signal) => {
      if (timer) clearTimeout(timer);
      // `code` is null if killed by signal
      resolve(code);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  }).catch((e: unknown) => {
    // Timeout or spawn error → treat as failure with stderr
    stderr += `\n[harness] ${e instanceof Error ? e.message : String(e)}`;
    return null as number | null;
  });

  // Give server a moment to flush its last capture
  await Bun.sleep(50);

  const capture: ProcessCapture = {
    engine: opts.engine,
    command: [...opts.command],
    envSanitized: true,
    stdout,
    stderr,
    exitCode,
    signal: null,
    providerCaptures: opts.server.getSanitizedCaptures(),
    artifactFiles: [],
    producedAt: new Date().toISOString(),
  };

  // Validate before writing — if invalid, we want a clear failure
  validateProcessCapture(capture);

  const engineDir = join(opts.artifactDir, opts.engine);
  await mkdir(engineDir, { recursive: true });
  await writeFile(join(engineDir, "capture.json"), JSON.stringify(capture, null, 2), "utf-8");
  await writeFile(join(engineDir, "stdout.txt"), stdout, "utf-8");
  await writeFile(join(engineDir, "stderr.txt"), stderr, "utf-8");
  await writeFile(join(engineDir, "provider-requests.json"), JSON.stringify(capture.providerCaptures, null, 2), "utf-8");
  await writeFile(join(engineDir, "command.txt"), opts.command.join(" "), "utf-8");

  return capture;
}

/**
 * Create a tiny fake engine script that contacts PROVIDER_URL and prints JSON.
 * This is what Gate 0 uses for its differential tests — it's a real subprocess
 * that really does a fetch, so the HTTP capture is observed, not synthesized.
 *
 * The script is written to a temp file and executed via `bun run <file>`.
 */
export async function writeFakeEngineScript(opts: {
  readonly dir: string;
  readonly name: string;
  readonly payload: unknown;
  readonly responseHandling: "echo" | "no-contact";
}): Promise<string> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(opts.dir, { recursive: true });
  const filePath = join(opts.dir, `${opts.name}.ts`);

  if (opts.responseHandling === "no-contact") {
    await writeFile(
      filePath,
      `
      // Fake engine that never contacts provider — for test 7
      console.log(JSON.stringify({ comments: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, stopReason: "complete" }));
      `,
      "utf-8",
    );
  } else {
    const payloadStr = JSON.stringify(opts.payload);
    await writeFile(
      filePath,
      `
      const url = process.env.PROVIDER_URL;
      if (!url) {
        console.error("missing PROVIDER_URL");
        process.exit(2);
      }
      const payload = ${payloadStr};
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer test-key" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      // Echo what we got, so stdout contains the provider response's content
      const out = {
        comments: [{ path: "main.go", content: data.choices?.[0]?.message?.content ?? "no content", startLine: 10 }],
        usage: data.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        stopReason: "complete",
        providerMessage: data.choices?.[0]?.message ?? null,
      };
      console.log(JSON.stringify(out));
      `,
      "utf-8",
    );
  }
  return filePath;
}

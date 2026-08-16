// SPDX-License-Identifier: Apache-2.0
// Gate 0 differential harness — process-isolated OCR vs Pi runner.
// Only Node/Bun stdlib + local modules. No src/**.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { createCaptureServer } from "./server.js";
import { runIsolatedSubprocess, writeFakeEngineScript } from "./subprocess.js";
import { compareCaptures } from "./comparer.js";
import { writeMismatchArtifacts } from "./artifacts.js";
import type { ProcessCapture } from "./types.js";

/**
 * What the harness does for each fixture:
 * 1. Make one immutable Git fixture (for Gate 0 we use a temp dir as stand-in).
 * 2. Clone it separately for OCR and Pi — here we just use separate temp dirs.
 * 3. Start a separate local provider server for each.
 * 4. Give both servers frozen copies of the same response sequence.
 * 5. Isolate HOME/cache/output.
 * 6. Run both engines as subprocesses.
 * 7. Capture HTTP, stdout, stderr, exit, and artifact files.
 * 8. Validate with zod.
 * 9. Compare only fields with explicit provenance.
 */

export interface HarnessFixture {
  readonly id: string;
  readonly ocrResponses: readonly unknown[];
  readonly piResponses: readonly unknown[];
  readonly ocrPayload: unknown;
  readonly piPayload: unknown;
}

export interface HarnessResult {
  readonly ocr: ProcessCapture;
  readonly pi: ProcessCapture;
  readonly compare: ReturnType<typeof compareCaptures>;
  readonly artifactDir: string;
}

/**
 * Run a single differential fixture using real subprocess + real HTTP.
 * This is the boundary the anti-false-positive tests rely on — we don't
 * just build two objects and call the comparer; we actually run processes
 * and actually hit HTTP servers, then read captures from disk files.
 */
export async function runDifferentialFixture(opts: {
  readonly fixture: HarnessFixture;
  readonly artifactDir: string;
  readonly ocrExtraEnv?: Record<string, string>;
  readonly piExtraEnv?: Record<string, string>;
  readonly piNoContact?: boolean;
}): Promise<HarnessResult> {
  const fixtureDir = join(opts.artifactDir, opts.fixture.id);
  await mkdir(fixtureDir, { recursive: true });

  // Deep-frozen copies: each server gets its own clone so mutation on one
  // doesn't affect the other unless we explicitly mutate after creation.
  const ocrServer = createCaptureServer({ responses: opts.fixture.ocrResponses });
  const piServer = createCaptureServer({ responses: opts.fixture.piResponses });

  const engineDir = mkdtempSync(join(tmpdir(), `blackbox-engines-${opts.fixture.id}-`));
  const ocrScript = await writeFakeEngineScript({
    dir: engineDir,
    name: `ocr-${opts.fixture.id}`,
    payload: opts.fixture.ocrPayload,
    responseHandling: "echo",
  });
  const piScript = await writeFakeEngineScript({
    dir: engineDir,
    name: `pi-${opts.fixture.id}`,
    payload: opts.fixture.piPayload,
    responseHandling: opts.piNoContact ? "no-contact" : "echo",
  });

  let ocr: ProcessCapture;
  let pi: ProcessCapture;

  try {
    // Run OCR first, then Pi — each with its own server and isolated HOME.
    // We run sequentially to avoid port conflicts and to keep the test deterministic.
    ocr = await runIsolatedSubprocess({
      engine: "ocr",
      command: ["bun", "run", ocrScript],
      server: ocrServer,
      artifactDir: fixtureDir,
      extraEnv: opts.ocrExtraEnv,
      timeoutMs: 10_000,
    });

    pi = await runIsolatedSubprocess({
      engine: "pi",
      command: ["bun", "run", piScript],
      server: piServer,
      artifactDir: fixtureDir,
      extraEnv: opts.piExtraEnv,
      timeoutMs: 10_000,
    });
  } finally {
    ocrServer.stop();
    piServer.stop();
    await rm(engineDir, { recursive: true, force: true }).catch(() => {});
  }

  const compare = compareCaptures(ocr, pi);

  if (!compare.equal) {
    await writeMismatchArtifacts({
      artifactDir: opts.artifactDir,
      fixtureId: opts.fixture.id,
      ocr,
      pi,
      result: compare,
    });
  }

  return { ocr, pi, compare, artifactDir: fixtureDir };
}

/**
 * Helper to create a baseline fixture where both engines should agree.
 * Both servers return the same usage and content, both payloads have same tool schemas.
 */
export function baselineFixture(id: string): HarnessFixture {
  const response = {
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1234567890,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content: "looks good" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const payload = {
    model: "test-model",
    messages: [{ role: "user", content: "review main.go" }],
    tools: [{ type: "function", function: { name: "code_comment", description: "leave a comment", parameters: { type: "object", properties: {} } } }],
  };
  return {
    id,
    ocrResponses: [response],
    piResponses: [JSON.parse(JSON.stringify(response))],
    ocrPayload: JSON.parse(JSON.stringify(payload)),
    piPayload: JSON.parse(JSON.stringify(payload)),
  };
}

// SPDX-License-Identifier: Apache-2.0
// Gate 0 artifact writer — preserves raw sanitized captures + mismatches.
// Only Node/Bun stdlib + local types.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessCapture, CompareResult } from "./types.js";

/**
 * Why we keep raw artifacts:
 * If a future Gate fails, we need to see exactly what each engine sent
 * and got back — not a summary. The artifact directory is the proof.
 * Secrets are already redacted by the server's sanitizer, so even a
 * mismatch artifact is safe to keep in GitHub Actions logs.
 */

export async function writeMismatchArtifacts(opts: {
  readonly artifactDir: string;
  readonly fixtureId: string;
  readonly ocr: ProcessCapture | null;
  readonly pi: ProcessCapture | null;
  readonly result: CompareResult;
}): Promise<string> {
  const dir = join(opts.artifactDir, opts.fixtureId);
  await mkdir(dir, { recursive: true });

  if (opts.ocr) {
    await writeFile(join(dir, "ocr-capture.json"), JSON.stringify(opts.ocr, null, 2), "utf-8");
    await writeFile(join(dir, "ocr-stdout.txt"), opts.ocr.stdout, "utf-8");
    await writeFile(join(dir, "ocr-provider.json"), JSON.stringify(opts.ocr.providerCaptures, null, 2), "utf-8");
  } else {
    await writeFile(join(dir, "ocr-missing.txt"), "missing OCR capture", "utf-8");
  }

  if (opts.pi) {
    await writeFile(join(dir, "pi-capture.json"), JSON.stringify(opts.pi, null, 2), "utf-8");
    await writeFile(join(dir, "pi-stdout.txt"), opts.pi.stdout, "utf-8");
    await writeFile(join(dir, "pi-provider.json"), JSON.stringify(opts.pi.providerCaptures, null, 2), "utf-8");
  } else {
    await writeFile(join(dir, "pi-missing.txt"), "missing Pi capture", "utf-8");
  }

  // The mismatch file must contain both raw observations and the field path,
  // but no secrets. Our captures are already sanitized, so we can write them directly.
  const mismatchPayload = {
    fixtureId: opts.fixtureId,
    equal: opts.result.equal,
    mismatches: opts.result.mismatches.map((m) => ({
      fieldPath: m.fieldPath,
      provenance: m.provenance,
      ocrValue: m.ocrValue,
      piValue: m.piValue,
      message: m.message,
    })),
    notObservable: opts.result.notObservable,
    rawOcr: opts.ocr ? { stdout: opts.ocr.stdout.slice(0, 2000), provider: opts.ocr.providerCaptures.slice(0, 2) } : null,
    rawPi: opts.pi ? { stdout: opts.pi.stdout.slice(0, 2000), provider: opts.pi.providerCaptures.slice(0, 2) } : null,
  };

  // Ensure no secret leaked into artifact — quick scan
  const payloadStr = JSON.stringify(mismatchPayload);
  if (/sk-[a-zA-Z0-9_-]{20,}/.test(payloadStr) || /Bearer\s+[a-zA-Z0-9_-]{20,}/.test(payloadStr)) {
    throw new Error("artifact would contain secret — refusing to write");
  }

  await writeFile(join(dir, "mismatches.json"), JSON.stringify(mismatchPayload, null, 2), "utf-8");
  await writeFile(join(dir, "mismatches.txt"), formatMismatches(opts.result), "utf-8");

  return dir;
}

function formatMismatches(result: CompareResult): string {
  if (result.equal) return "OK — all fields match";
  const lines = [`FAIL — ${result.mismatches.length} mismatch(es):`];
  for (const m of result.mismatches) {
    lines.push(`  fieldPath: ${m.fieldPath}`);
    lines.push(`  provenance: ${m.provenance.source}/${m.provenance.kind}`);
    lines.push(`  message: ${m.message}`);
  }
  if (result.notObservable.length > 0) {
    lines.push(`  notObservable: ${result.notObservable.join(", ")}`);
  }
  return lines.join("\n");
}

export async function readCaptureFromDisk(path: string): Promise<ProcessCapture | null> {
  try {
    const raw = await readFile(path, "utf-8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as ProcessCapture;
  } catch {
    return null;
  }
}

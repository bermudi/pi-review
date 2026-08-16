#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Helper for Gate 0 anti-tests 4/5 — loads captures from disk and runs the same
// comparison path that active gates use. Must be invoked as a subprocess so the
// test cannot cheat by calling compareCaptures in-process on hand-built objects.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { compareCaptures } from "./comparer.js";
import { readCaptureFromDisk } from "./artifacts.js";

function parseArgs(): { ocrPath: string | null; piPath: string | null; fixtureDir: string | null } {
  const args = process.argv.slice(2);
  let ocrPath: string | null = null;
  let piPath: string | null = null;
  let fixtureDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--ocr" && i + 1 < args.length) ocrPath = args[++i]!;
    else if (a === "--pi" && i + 1 < args.length) piPath = args[++i]!;
    else if (a === "--fixtureDir" && i + 1 < args.length) fixtureDir = args[++i]!;
    else if (a?.startsWith("--ocr=")) ocrPath = a.split("=")[1]!;
    else if (a?.startsWith("--pi=")) piPath = a.split("=")[1]!;
    else if (a?.startsWith("--fixtureDir=")) fixtureDir = a.split("=")[1]!;
  }
  if (fixtureDir) {
    ocrPath = join(fixtureDir, "ocr", "capture.json");
    piPath = join(fixtureDir, "pi", "capture.json");
  }
  return { ocrPath, piPath, fixtureDir };
}

async function main(): Promise<void> {
  const { ocrPath, piPath } = parseArgs();
  if (!ocrPath || !piPath) {
    console.error("usage: bun run compare-artifacts.ts --ocr <path> --pi <path>  OR  --fixtureDir <dir>");
    process.exit(2);
  }

  let ocr = null;
  let pi = null;
  // Load via same path active gates use — readCaptureFromDisk
  // If file missing, readCaptureFromDisk returns null, which compareCaptures maps to exact error.
  ocr = await readCaptureFromDisk(ocrPath);
  pi = await readCaptureFromDisk(piPath);

  // Also handle case where file exists but is empty or invalid JSON — treat as missing
  // readCaptureFromDisk already returns null on catch.

  // Extra check: if file exists but providerCaptures is missing, we still want to detect?
  // The comparer will handle it.

  const result = compareCaptures(ocr, pi);

  if (result.equal) {
    console.error("compare-artifacts: equal (no mismatches)");
    process.exit(0);
  } else {
    // Print mismatches to stderr with fieldPath for assertability
    for (const m of result.mismatches) {
      console.error(`mismatch: ${m.fieldPath}: ${m.message}`);
    }
    // Also print notObservable if any
    if (result.notObservable.length > 0) {
      console.error(`notObservable: ${result.notObservable.join(", ")}`);
    }
    // Exit non-zero; the caller asserts the exact string is present
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`compare-artifacts fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});

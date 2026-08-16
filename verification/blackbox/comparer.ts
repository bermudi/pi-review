// SPDX-License-Identifier: Apache-2.0
// Gate 0 comparer — compares two ProcessCaptures with explicit provenance.
// Only Node/Bun stdlib + local types. No src/**.

import type { ProcessCapture, CompareResult, Provenance } from "./types.js";

/**
 * Why provenance matters:
 * The spec says every compared field must say where it came from.
 * If we say "comments match" but one side was synthesized from a fixture,
 * that's not parity — it's a lie. So each mismatch carries its source
 * and kind, and anything we can't observe goes in notObservable.
 */

function provenance(
  source: Provenance["source"],
  kind: Provenance["kind"] = "observed",
  derivedFrom?: string[],
  deriveFn?: string,
): Provenance {
  return { source, kind, derivedFrom, deriveFn };
}

function normalizeTmp(s: string): string {
  return String(s)
    .replace(/\/tmp\/[^\s"']+/g, "<TMP>")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<PORT>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>")
    .replace(/chatcmpl-[^\s"']+/g, "chatcmpl:<ID>");
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
      return sorted;
    }
    return val;
  });
}

export function compareCaptures(ocr: ProcessCapture | null, pi: ProcessCapture | null): CompareResult {
  const mismatches: Array<CompareResult["mismatches"][number]> = [];
  const notObservable: string[] = [];

  // Guard: missing captures must fail with a named error, not silently pass.
  if (!ocr) {
    return {
      equal: false,
      mismatches: [
        {
          fieldPath: "missing OCR stdout",
          provenance: provenance("stdout"),
          ocrValue: null,
          piValue: pi?.stdout ?? null,
          message: "missing OCR stdout: capture file not found or empty",
        },
      ],
      notObservable: [],
    };
  }
  if (!pi) {
    return {
      equal: false,
      mismatches: [
        {
          fieldPath: "missing Pi provider trace",
          provenance: provenance("provider_request"),
          ocrValue: ocr.providerCaptures.length,
          piValue: null,
          message: "missing Pi provider trace: no HTTP captures recorded",
        },
      ],
      notObservable: [],
    };
  }

  // Engine identity collision: both captures claim same engine
  if (ocr.engine === pi.engine) {
    return {
      equal: false,
      mismatches: [
        {
          fieldPath: "engine identity collision",
          provenance: provenance("artifact", "derived", ["ocr.engine", "pi.engine"], "engine equality check"),
          ocrValue: ocr.engine,
          piValue: pi.engine,
          message: `engine identity collision: both captures report engine=${ocr.engine}`,
        },
      ],
      notObservable: [],
    };
  }

  // No-contact check: Pi never hit its server
  if (pi.providerCaptures.length === 0) {
    (mismatches as unknown as Array<CompareResult["mismatches"][number]>).push({
      fieldPath: "pi provider contact",
      provenance: provenance("provider_request"),
      ocrValue: ocr.providerCaptures.length,
      piValue: 0,
      message: "Pi process never contacted its provider server (0 captures)",
    });
  }

  // Helper to push a mismatch with provenance
  function check(
    fieldPath: string,
    prov: Provenance,
    pass: boolean,
    ocrVal: unknown,
    piVal: unknown,
    msg: string,
  ): void {
    if (!pass) (mismatches as unknown as Array<CompareResult["mismatches"][number]>).push({ fieldPath, provenance: prov, ocrValue: ocrVal, piValue: piVal, message: msg });
  }

  // Provider request count and tool schemas
  const ocrReqCount = ocr.providerCaptures.length;
  const piReqCount = pi.providerCaptures.length;
  check(
    "provider_request.count",
    provenance("provider_request"),
    ocrReqCount === piReqCount,
    ocrReqCount,
    piReqCount,
    `provider request count ${ocrReqCount} vs ${piReqCount}`,
  );

  const minReq = Math.min(ocrReqCount, piReqCount);
  for (let i = 0; i < minReq; i++) {
    const oReq = ocr.providerCaptures[i]!.request.body as Record<string, unknown>;
    const pReq = pi.providerCaptures[i]!.request.body as Record<string, unknown>;

    const oTools = ((oReq.tools ?? oReq.tool_defs ?? []) as unknown[]).map((t: unknown) => {
      const tt = t as Record<string, unknown>;
      return (tt.function as Record<string, unknown>)?.name ?? tt.name ?? "";
    });
    const pTools = ((pReq.tools ?? pReq.tool_defs ?? []) as unknown[]).map((t: unknown) => {
      const tt = t as Record<string, unknown>;
      return (tt.function as Record<string, unknown>)?.name ?? tt.name ?? "";
    });

    check(
      `provider_request[${i}].tool_schema`,
      provenance("provider_request"),
      stableStringify(oTools.sort()) === stableStringify(pTools.sort()),
      oTools,
      pTools,
      `tool schema mismatch for request ${i}: ${JSON.stringify(oTools)} vs ${JSON.stringify(pTools)}`,
    );

    // Also compare full request bodies normalized
    const oBody = normalizeTmp(stableStringify(oReq));
    const pBody = normalizeTmp(stableStringify(pReq));
    check(
      `provider_request[${i}].body`,
      provenance("provider_request"),
      oBody === pBody,
      oReq,
      pReq,
      `request body mismatch for request ${i}`,
    );
  }

  // Provider response: usage, content, tool calls
  for (let i = 0; i < minReq; i++) {
    const oResp = ocr.providerCaptures[i]!.response.body as Record<string, unknown>;
    const pResp = pi.providerCaptures[i]!.response.body as Record<string, unknown>;

    const oUsage = (oResp.usage ?? oResp.usageInfo ?? {}) as Record<string, unknown>;
    const pUsage = (pResp.usage ?? pResp.usageInfo ?? {}) as Record<string, unknown>;

    check(
      `provider_response[${i}].usage`,
      provenance("provider_response"),
      stableStringify(oUsage) === stableStringify(pUsage),
      oUsage,
      pUsage,
      `usage mismatch for response ${i}`,
    );

    // Granular usage fields for named mismatch (test 3 looks for this path)
    for (const k of new Set([...Object.keys(oUsage), ...Object.keys(pUsage)])) {
      check(
        `provider_response[${i}].usage.${k}`,
        provenance("provider_response"),
        stableStringify(oUsage[k]) === stableStringify(pUsage[k]),
        oUsage[k],
        pUsage[k],
        `usage.${k} mismatch`,
      );
    }

    const oChoices = (oResp.choices ?? []) as unknown[];
    const pChoices = (pResp.choices ?? []) as unknown[];
    check(
      `provider_response[${i}].choices`,
      provenance("provider_response"),
      stableStringify(oChoices) === stableStringify(pChoices),
      oChoices,
      pChoices,
      `choices mismatch for response ${i}`,
    );
  }

  // Stdout: parsed JSON comments etc.
  let ocrOut: unknown = null;
  let piOut: unknown = null;
  try {
    ocrOut = ocr.stdout ? JSON.parse(ocr.stdout) : null;
  } catch {
    ocrOut = ocr.stdout;
  }
  try {
    piOut = pi.stdout ? JSON.parse(pi.stdout) : null;
  } catch {
    piOut = pi.stdout;
  }

  if (!ocr.stdout) {
    (mismatches as unknown as Array<CompareResult["mismatches"][number]>).push({
      fieldPath: "missing OCR stdout",
      provenance: provenance("stdout"),
      ocrValue: null,
      piValue: pi.stdout.slice(0, 500),
      message: "missing OCR stdout",
    });
  } else if (!pi.stdout) {
    (mismatches as unknown as Array<CompareResult["mismatches"][number]>).push({
      fieldPath: "missing Pi stdout",
      provenance: provenance("stdout"),
      ocrValue: ocr.stdout.slice(0, 500),
      piValue: null,
      message: "missing Pi stdout",
    });
  } else {
    check(
      "stdout",
      provenance("stdout"),
      normalizeTmp(stableStringify(ocrOut)) === normalizeTmp(stableStringify(piOut)),
      ocrOut,
      piOut,
      "stdout mismatch",
    );

    // Specific output field for test 1 (mutate provider response → output mismatch)
    const oComments = (ocrOut as Record<string, unknown>)?.comments;
    const pComments = (piOut as Record<string, unknown>)?.comments;
    if (oComments !== undefined || pComments !== undefined) {
      check(
        "stdout.comments",
        provenance("stdout", "derived", ["stdout", "provider_response"], "parse stdout JSON and extract comments"),
        stableStringify(oComments) === stableStringify(pComments),
        oComments,
        pComments,
        "comments mismatch in stdout",
      );
    }
  }

  // Stderr and exit
  check("stderr", provenance("stderr"), normalizeTmp(ocr.stderr) === normalizeTmp(pi.stderr), ocr.stderr, pi.stderr, "stderr mismatch");
  check("exit", provenance("exit"), ocr.exitCode === pi.exitCode, ocr.exitCode, pi.exitCode, `exit code ${ocr.exitCode} vs ${pi.exitCode}`);

  return {
    equal: mismatches.length === 0,
    mismatches,
    notObservable,
  };
}

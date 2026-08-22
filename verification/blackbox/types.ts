// SPDX-License-Identifier: Apache-2.0
// Ported from OCR v1.9.3 differential contract at c35ddd7223f2b5540ce03aa43c9a25ef643fca27
// This is the fresh black-box harness for Gate 0 — it must not import src/**, dist/**, test/ocr/harness or Pi private paths.

/**
 * What this file is for:
 * Defines the small, trusted vocabulary the black-box verifier uses.
 * Everything the verifier compares has to point back to where it came from —
 * a captured HTTP request, a process stdout, a file on disk, etc.
 * That way we never compare something we invented.
 */

// Where a value was seen. The spec names these seven sources.
// If we can't see it, it's "not_observable" — we don't silently ignore it.
export type ProvenanceSource =
  | "provider_request"
  | "provider_response"
  | "stdout"
  | "stderr"
  | "exit"
  | "git"
  | "artifact";

// How the value was turned into something we can compare.
export type ProvenanceKind = "observed" | "normalized" | "derived";

export interface Provenance {
  readonly source: ProvenanceSource;
  readonly kind: ProvenanceKind;
  // For derived values, name the exact inputs and function.
  readonly derivedFrom?: readonly string[];
  readonly deriveFn?: string;
}

// A single HTTP capture — what the fake provider server saw.
// Response is null when request arrived but response was never delivered
// (e.g., stalled and aborted). Separating arrival from delivery is
// required by Gate 1: "a stalled, aborted request has a captured request
// but no captured provider response."
export interface CapturedHttp {
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  } | null;
  // Whether response bytes were actually delivered to the client.
  readonly delivered: boolean;
  // Sanitized means secrets stripped (Authorization, api keys).
  readonly sanitized: boolean;
}

// What we keep from a subprocess run.
// This is the "boundary" — we only know what the process printed,
// what it sent over the wire, and how it exited.
export interface ProcessCapture {
  readonly engine: "ocr" | "pi";
  readonly command: readonly string[];
  readonly envSanitized: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly providerCaptures: readonly CapturedHttp[];
  readonly artifactFiles: readonly string[];
  readonly producedAt: string;
}

// One field we compare between OCR and Pi, with its provenance.
export interface ComparedField {
  readonly fieldPath: string;
  readonly provenance: Provenance;
  readonly ocrValue: unknown;
  readonly piValue: unknown;
}

// Result of comparing two ProcessCaptures.
export interface CompareResult {
  readonly equal: boolean;
  readonly mismatches: readonly {
    readonly fieldPath: string;
    readonly provenance: Provenance;
    readonly ocrValue: unknown;
    readonly piValue: unknown;
    readonly message: string;
  }[];
  readonly notObservable: readonly string[];
}

// The JSON report Gate 0 must emit — one JSON object to stdout.
export interface Gate0Report {
  readonly gate: "blackbox-integrity";
  readonly commit: string;
  readonly ocrTagObject: string;
  readonly ocrCommit: string;
  readonly packageArchiveHash: string | null;
  readonly fixtures: readonly string[];
  readonly assertions: number;
  readonly notObservable: readonly string[];
  readonly forbiddenImports: number;
  readonly forbiddenImportDetails: readonly string[];
  readonly result: "pass" | "fail";
  readonly artifactDir: string;
  readonly error?: string;
}

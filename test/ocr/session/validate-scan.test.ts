// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/validate_scan_options_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.
import { describe, expect, test } from "bun:test";
import { ResumeState } from "../../../src/ocr/session/resume.ts";
import { ReviewModeFullScan, ReviewModeRange } from "../../../src/ocr/session/history.ts";

function callValidate(state: ResumeState | null, scanPaths: string[]): Error | null {
  if (state === null) return null;
  return state.ValidateScanOptions(scanPaths);
}

describe("ocr session validate scan options", () => {
  // OCR v1.9.3: TestValidateScanOptions
  test("ValidateScanOptions covers every branch", () => {
    // nil state is a no-op
    {
      const s: ResumeState | null = null;
      const err = callValidate(s, ["a"]);
      expect(err).toBeNull();
      // Also verify optional-chaining guard mirrors Go nil receiver
      const err2 = (s as unknown as { ValidateScanOptions?: (p: string[]) => Error | null })?.ValidateScanOptions?.(["a"]) ?? null;
      expect(err2).toBeNull();
    }

    // missing review mode metadata errors
    {
      const s = new ResumeState("sess-1", "/tmp");
      s.reviewMode = "";
      const err = s.ValidateScanOptions([]);
      expect(err).not.toBeNull();
      expect(err!.message.includes("missing review mode metadata"), `err=${JSON.stringify(err?.message)} should contain missing review mode metadata`).toBe(true);
    }

    // non-scan mode errors
    {
      const s = new ResumeState("sess-1", "/tmp");
      s.reviewMode = ReviewModeRange;
      const err = s.ValidateScanOptions([]);
      expect(err).not.toBeNull();
      expect(err!.message.includes("does not match current mode"), `err=${JSON.stringify(err?.message)} should contain does not match current mode`).toBe(true);
    }

    // scope mismatch errors
    {
      const s = new ResumeState("sess-1", "/tmp");
      s.reviewMode = ReviewModeFullScan;
      s.hasScanPathScope = true;
      s.scanPaths = ["src"];
      const err = s.ValidateScanOptions(["docs"]);
      expect(err).not.toBeNull();
      expect(err!.message.includes("scan path scope"), `err=${JSON.stringify(err?.message)} should contain scan path scope`).toBe(true);
    }

    // matching scope succeeds after normalization
    {
      const s = new ResumeState("sess-1", "/tmp");
      s.reviewMode = ReviewModeFullScan;
      s.hasScanPathScope = true;
      s.scanPaths = ["src"];
      // "./src/" normalizes to "src", so the scopes match.
      const err = s.ValidateScanOptions(["./src/"]);
      expect(err).toBeNull();
    }

    // no recorded scope skips the scope check
    {
      const s = new ResumeState("sess-1", "/tmp");
      s.reviewMode = ReviewModeFullScan;
      s.hasScanPathScope = false;
      s.scanPaths = [];
      const err = s.ValidateScanOptions(["anything"]);
      expect(err).toBeNull();
    }
  });
});

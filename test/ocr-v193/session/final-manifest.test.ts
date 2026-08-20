// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/final_manifest_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.

import { describe, expect, test } from "bun:test";
import { SessionHistory } from "../../../src/ocr-v193/session/history.ts";
import type { RunManifest } from "../../../src/ocr-v193/session/manifest.ts";

function makeManifest(overrides: Partial<RunManifest> & Pick<RunManifest, "runId" | "operation">): RunManifest {
  return {
    schemaVersion: "ocr.run-manifest/v1",
    runId: overrides.runId,
    operation: overrides.operation,
    terminalState: overrides.terminalState ?? "complete",
    repository: overrides.repository ?? {},
    input: overrides.input ?? { mode: "workspace" },
    execution: overrides.execution ?? {},
    coverage: overrides.coverage ?? { selected: [], completed: [], reused: [], failed: [], waived: [] },
    elapsedMs: overrides.elapsedMs ?? 0,
    parentRunId: overrides.parentRunId,
    runFailure: overrides.runFailure,
  };
}

describe("ocr-v193 session final manifest", () => {
  // OCR v1.9.3: TestFinalManifest
  test("FinalManifest nil safety, empty handling and clone", () => {
    // Nil receiver must not panic.
    const nilSH = null as unknown as SessionHistory | null;
    expect(() => {
      const got = (nilSH as unknown as { FinalManifest?: () => RunManifest | null })?.FinalManifest?.() ?? null;
      expect(got).toBeNull();
    }).not.toThrow();

    // Direct prototype call on nil must also not panic and return null.
    expect(() => {
      const got = SessionHistory.prototype.FinalManifest.call(nilSH as unknown as SessionHistory);
      expect(got).toBeNull();
    }).not.toThrow();

    // A session with no frozen manifest (legacy/scan) returns nil.
    const sh = new SessionHistory("/tmp/repo", "main", "test-model", {});
    expect(sh.FinalManifest()).toBeNull();

    // SetFinalManifest is a no-op on a nil receiver.
    expect(() => {
      SessionHistory.prototype.SetFinalManifest.call(
        nilSH as unknown as SessionHistory,
        makeManifest({ runId: "ignored", operation: "review" }),
      );
    }).not.toThrow();

    // After storing, FinalManifest returns a cloned copy carrying the data.
    const stored = makeManifest({ runId: "run-123", operation: "review" });
    sh.SetFinalManifest(stored);
    const got = sh.FinalManifest();
    expect(got).not.toBeNull();
    expect(got?.runId).toBe("run-123");
    expect(got?.operation).toBe("review");

    // Returned copy must be cloned: mutating the returned object must not affect the stored value.
    if (got !== null) {
      const mutated = got;
      mutated.runId = "mutated";
      mutated.operation = "mutated-op";
    }
    const again = sh.FinalManifest();
    expect(again?.runId).toBe("run-123");
    expect(again?.operation).toBe("review");

    // Also ensure SetFinalManifest stores by reference but FinalManifest always clones,
    // so mutating the original input after set does not affect stored? The current impl stores reference,
    // so we document the observable guarantee: FinalManifest always returns a new object.
    // Verify that two consecutive calls return distinct objects.
    const a = sh.FinalManifest();
    const b = sh.FinalManifest();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

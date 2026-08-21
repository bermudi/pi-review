// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/output_manifest_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27

import { test, expect } from "bun:test";
import { warningsForOutput, manifestMessage } from "../../../src/ocr-v193/cli/output.js";
import type { AgentWarning } from "../../../src/ocr-v193/cli/output.js";
import type { RunManifest } from "../../../src/ocr-v193/session/manifest.js";

function makeManifest(overrides: Partial<RunManifest> & { terminalState: RunManifest["terminalState"] }): RunManifest {
  return {
    schemaVersion: "ocr.run-manifest/v1",
    runId: "run-1",
    operation: "review",
    terminalState: overrides.terminalState,
    repository: {},
    input: { mode: "workspace" },
    execution: {},
    coverage: overrides.coverage ?? { selected: [], completed: [], reused: [], failed: [], waived: [] },
    elapsedMs: 0,
    ...overrides,
  } as RunManifest;
}

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({ itemId: `id-${i}`, path: `file${i}.go` }));
}

// OCR v1.9.3: TestWarningsForOutput
test("warningsForOutput filtering", () => {
  const warns: AgentWarning[] = [
    { type: "subtask_error", file: "a.go", message: "fail" },
    { type: "scan_subtask_error", file: "b.go", message: "fail2" },
    { type: "token_budget_reached", file: "c.go", message: "budget" },
  ];
  const manifest = makeManifest({
    terminalState: "complete",
    coverage: { selected: items(1), completed: items(1), reused: [], failed: [], waived: [] },
  });

  // nil manifest passes through unchanged
  const gotNil = warningsForOutput(warns as readonly AgentWarning[], null);
  expect(gotNil).toHaveLength(warns.length);

  // all subtask errors collapse to empty
  const only = [
    { type: "subtask_error", file: "x", message: "" },
    { type: "scan_subtask_error", file: "y", message: "" },
  ] as AgentWarning[];
  expect(warningsForOutput(only, manifest)).toEqual([]);

  // mixed keeps only non-subtask warnings
  const gotMixed = warningsForOutput(warns as readonly AgentWarning[], manifest);
  expect(gotMixed).toHaveLength(1);
  expect(gotMixed[0]!.type).toBe("token_budget_reached");
});

// OCR v1.9.3: TestManifestMessage
test("manifestMessage branches", () => {
  expect(manifestMessage(null, 0)).toBe("");
  expect(manifestMessage(undefined, 0)).toBe("");

  const complete = makeManifest({
    terminalState: "complete",
    coverage: { selected: items(3), completed: items(3), reused: [], failed: [], waived: [] },
  });
  expect(manifestMessage(complete, 2)).toContain("Review complete: 2 finding(s) across 3 selected item(s).");

  const withWaived = makeManifest({
    terminalState: "complete",
    coverage: { selected: items(3), completed: items(2), reused: [], failed: [], waived: items(1) },
  });
  expect(manifestMessage(withWaived, 2)).toContain("including 1 waived");

  const partial = makeManifest({
    terminalState: "partial",
    coverage: { selected: items(4), completed: items(3), reused: [], failed: items(1), waived: [] },
  });
  expect(manifestMessage(partial, 1)).toContain("partially complete");

  const failedWithClass = makeManifest({
    terminalState: "failed",
    coverage: { selected: items(2), completed: [], reused: [], failed: items(2), waived: [] },
    runFailure: { classification: "input", reason: "bad" },
  } as unknown as RunManifest);
  expect(manifestMessage(failedWithClass, 0)).toContain("Review failed (input)");

  const failedNoClass = makeManifest({
    terminalState: "failed",
    coverage: { selected: items(2), completed: [], reused: [], failed: items(2), waived: [] },
  });
  expect(manifestMessage(failedNoClass, 0)).toContain("Review failed: 0 finding(s)");

  const skipped = makeManifest({ terminalState: "skipped", coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] } });
  expect(manifestMessage(skipped, 0)).toContain("Review skipped");

  const unknown = makeManifest({ terminalState: "bogus" as unknown as RunManifest["terminalState"], coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] } });
  expect(manifestMessage(unknown, 0)).toContain("unknown manifest state");
});

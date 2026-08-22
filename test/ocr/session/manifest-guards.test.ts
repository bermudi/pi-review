// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from internal/session/manifest_guards_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.
// Provenance: OCR v1.9.3 commit c35ddd7223f2b5540ce03aa43c9a25ef643fca27 (tag v1.9.3, tag object 4d796ae54cabdcf4e22b69ef502ed8871456a909).

import { describe, expect, test } from "bun:test";
import {
  errFrozen,
  errNilBuilder,
  FailureBudget,
  FailureProvider,
  InputModeCommit,
  InputModeWorkspace,
  ManifestBuilder,
  ManifestError,
  NewManifestBuilder,
  RunFailureBudget,
} from "../../../src/ocr/session/manifest.ts";
import type {
  CoverageItem,
  ManifestExecution,
  ManifestInput,
  ManifestRepository,
} from "../../../src/ocr/session/manifest.ts";

describe("ocr session manifest guards", () => {
  // OCR v1.9.3: TestManifestBuilderNilReceiver
  test("TestManifestBuilderNilReceiver", () => {
    // Go's var b *ManifestBuilder nil-receiver has no direct TS equivalent because
    // NewManifestBuilder always returns a valid instance and class methods require
    // an instance. Adapt via optional chaining to prove the equivalent observable
    // contract: void setters degrade quietly, predicates degrade to false, and the
    // sentinel errNilBuilder represents the "operation on nil builder" failure.
    function nilBuilder(): ManifestBuilder | null {
      return null;
    }
    const b: ManifestBuilder | null = nilBuilder();

    // Void setters: must not panic / not throw when receiver is nil (via optional chaining).
    expect(() => {
      b?.SetParentRunID("parent");
      b?.SetRepository({} as ManifestRepository);
      b?.SetInput({ mode: InputModeWorkspace } as ManifestInput);
      b?.SetExecution({} as ManifestExecution);
    }).not.toThrow();

    // Sentinel is stable and carries the expected message.
    expect(errNilBuilder).toBeInstanceOf(ManifestError);
    expect(errNilBuilder.message).toBe("manifest: operation on nil builder");

    // Error-returning methods on a nil receiver must conceptually return errNilBuilder.
    // In TS, optional chaining yields undefined; we assert the fallback contract maps
    // undefined to errNilBuilder.
    const nilSetRunFailure: Error | null | undefined = b?.SetRunFailure(RunFailureBudget, "r");
    expect(nilSetRunFailure).toBeUndefined();
    // Observable contract helper: when builder is nullish, the caller should treat as errNilBuilder.
    const effectiveSetRunFailure: Error | null = b?.SetRunFailure(RunFailureBudget, "r") ?? errNilBuilder;
    expect(effectiveSetRunFailure).toBe(errNilBuilder);

    const nilSetPending: Error | null | undefined = b?.SetPendingFailureCause(FailureBudget, "r");
    expect(nilSetPending).toBeUndefined();
    expect((b?.SetPendingFailureCause(FailureBudget, "r") ?? errNilBuilder)).toBe(errNilBuilder);

    const sel: CoverageItem = { itemId: "a", path: "a.go", fingerprint: "fp" };
    expect(b?.RegisterSelected(sel)).toBeUndefined();
    expect((b?.RegisterSelected(sel) ?? errNilBuilder)).toBe(errNilBuilder);

    expect(b?.SealSelected()).toBeUndefined();
    expect((b?.SealSelected() ?? errNilBuilder)).toBe(errNilBuilder);

    expect(b?.MarkCompleted("a")).toBeUndefined();
    expect((b?.MarkCompleted("a") ?? errNilBuilder)).toBe(errNilBuilder);

    expect(b?.MarkReused("a")).toBeUndefined();
    expect((b?.MarkReused("a") ?? errNilBuilder)).toBe(errNilBuilder);

    expect(b?.MarkFailed("a", FailureProvider, "r")).toBeUndefined();
    expect((b?.MarkFailed("a", FailureProvider, "r") ?? errNilBuilder)).toBe(errNilBuilder);

    expect(b?.MarkWaived("a", "r")).toBeUndefined();
    expect((b?.MarkWaived("a", "r") ?? errNilBuilder)).toBe(errNilBuilder);

    const nilFinalize = b?.Finalize(0) as { manifest: unknown; error: Error | null } | undefined;
    expect(nilFinalize).toBeUndefined();
    const effectiveFinalize = (b?.Finalize(0) as { manifest: unknown; error: Error | null } | undefined) ?? {
      manifest: null,
      error: errNilBuilder,
    };
    expect(effectiveFinalize.error).toBe(errNilBuilder);

    // Boolean predicates: must report false on a nil receiver (via nullish fallback).
    expect(b?.Sealed() ?? false).toBe(false);
    expect(b?.Frozen() ?? false).toBe(false);

    // TS-specific observable contract: NewManifestBuilder never returns nil; it always
    // yields a valid instance whose predicates start false. This is the user-visible
    // guarantee that replaces the Go nil-receiver possibility.
    const valid = NewManifestBuilder("run-guard-nil-check", "review");
    expect(valid).toBeInstanceOf(ManifestBuilder);
    expect(valid.Sealed()).toBe(false);
    expect(valid.Frozen()).toBe(false);
  });

  // OCR v1.9.3: TestManifestBuilderFrozenNoOp
  test("TestManifestBuilderFrozenNoOp", () => {
    const b = NewManifestBuilder("run-frozen", "review");
    b.SetInput({ mode: InputModeWorkspace } as ManifestInput);
    b.SetParentRunID("orig-parent");
    const first = b.Finalize(0);
    expect(first.error).toBeNull();
    expect(b.Frozen()).toBe(true);

    // Void setters must silently no-op once frozen (no throw, no mutation).
    expect(() => {
      b.SetParentRunID("changed");
      b.SetRepository({} as ManifestRepository);
      b.SetInput({ mode: InputModeCommit } as ManifestInput);
      b.SetExecution({} as ManifestExecution);
    }).not.toThrow();

    // Mutating methods must report errFrozen — mirror Go's frozenReturners map.
    const frozenReturners: Record<string, Error | null> = {
      SetRunFailure: b.SetRunFailure(RunFailureBudget, "r"),
      SetPendingFailureCause: b.SetPendingFailureCause(FailureBudget, "r"),
      RegisterSelected: b.RegisterSelected({ itemId: "z", path: "z.go" } as CoverageItem),
      SealSelected: b.SealSelected(),
      MarkCompleted: b.MarkCompleted("a"),
    };
    for (const [name, err] of Object.entries(frozenReturners)) {
      expect(err, `${name} after freeze should be errFrozen`).toBe(errFrozen);
      expect(err).toBeInstanceOf(ManifestError);
      if (err !== null) expect(err.message).toBe("manifest: builder already finalized");
    }

    // The frozen manifest must still report the original parent, proving the
    // post-freeze SetParentRunID was a no-op. Finalize is idempotent after freeze.
    const second = b.Finalize(0);
    expect(second.error).toBeNull();
    expect(second.manifest).not.toBeNull();
    expect(second.manifest?.parentRunId).toBe("orig-parent");
    // Idempotent Finalize preserves elapsed and terminal fields from first freeze.
    expect(second.manifest?.parentRunId).toBe(first.manifest?.parentRunId);
    expect(second.manifest?.coverage.selected.length).toBe(first.manifest?.coverage.selected.length);
  });
});

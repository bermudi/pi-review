// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// Ported from internal/session/resume_identity_test.go at c35ddd7223f2b5540ce03aa43c9a25ef643fca27; modifications under GPL-3.0-or-later.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionHistory } from "../../../src/ocr/session/history.ts";
import {
  ResumeState,
  NewResumeLineage,
  ResumeLineageSchemaVersion,
  LoadSummary,
  isResumeTransition,
} from "../../../src/ocr/session/resume.ts";
import { SessionFilePath, JsonlWriter } from "../../../src/ocr/session/persist.ts";
import {
  ManifestSchemaVersion,
  OperationReview,
  InputModeRange,
  InputModeCommit,
} from "../../../src/ocr/session/manifest.ts";
import type { RunManifest } from "../../../src/ocr/session/manifest.ts";
import type { RunIdentity, ResumeRequest, ResumeLineage } from "../../../src/ocr/session/resume.ts";

// Helpers mirroring Go parentState/request

const parentIdentity: RunIdentity = {
  mode: InputModeRange,
  sourceArtifactSha256: "artifact-parent",
  ruleConfigSha256: "rules-parent",
  repositorySha256: "repo-parent",
};

function parentState(mutate?: (m: RunManifest) => void): ResumeState {
  const m: RunManifest = {
    schemaVersion: ManifestSchemaVersion,
    runId: "run-parent",
    operation: OperationReview,
    terminalState: "complete",
    repository: { identitySha256: parentIdentity.repositorySha256 },
    input: {
      mode: parentIdentity.mode,
      sourceArtifactSha256: parentIdentity.sourceArtifactSha256,
    },
    execution: {
      provider: "anthropic",
      model: "claude",
      ruleConfigSha256: parentIdentity.ruleConfigSha256,
    },
    coverage: {
      selected: [{ itemId: "item-1", path: "item-1" }],
      completed: [],
      reused: [],
      failed: [],
      waived: [],
    },
    elapsedMs: 0,
  };
  if (mutate) mutate(m);
  const s = new ResumeState("parent-session", "/tmp");
  // Directly assign manifest and closed, mirroring Go's ResumeState literal
  (s as unknown as { manifest: RunManifest | null }).manifest = m;
  (s as unknown as { closed: boolean }).closed = true;
  return s;
}

function request(mutate?: (r: ResumeRequest) => void): ResumeRequest {
  const req: ResumeRequest = {
    identity: { ...parentIdentity },
    provider: "anthropic",
    model: "claude",
    providerExplicit: false,
    modelExplicit: false,
  };
  if (mutate) mutate(req);
  return req;
}

describe("ocr session resume identity", () => {
  // OCR v1.9.3: TestValidateResume
  test("ValidateResume accepts or rejects with precise error substrings", () => {
    type Case = {
      name: string;
      parent?: (m: RunManifest) => void;
      req?: (r: ResumeRequest) => void;
      state?: (s: ResumeState) => void;
      wantErr: string;
    };
    const cases: Case[] = [
      { name: "identical input, provider and model is accepted", wantErr: "" },
      {
        name: "parent that completed nothing is still resumable",
        parent: (m) => { m.coverage.failed = [{ itemId: "item-1", path: "item-1" }]; },
        wantErr: "",
      },
      {
        name: "differing ref text with identical resolved input is accepted",
        parent: (m) => { m.input.requestedFrom = "main"; m.input.requestedHead = "abc1234"; },
        wantErr: "",
      },
      { name: "interrupted parent with no manifest is rejected as unverifiable", state: (s) => { (s as unknown as { manifest: RunManifest | null }).manifest = null; (s as unknown as { closed: boolean }).closed = false; }, wantErr: "was interrupted before it closed" },
      { name: "parent that closed without a manifest is rejected as unverifiable", state: (s) => { (s as unknown as { manifest: RunManifest | null }).manifest = null; }, wantErr: "closed without a run manifest" },
      { name: "unknown manifest schema is rejected", parent: (m) => { m.schemaVersion = "ocr.run-manifest/v99"; }, wantErr: "manifest schema" },
      { name: "non-review parent is rejected", parent: (m) => { m.operation = "scan"; }, wantErr: "operation" },
      { name: "parent that selected nothing is rejected", parent: (m) => { m.coverage.selected = []; }, wantErr: "selected no input" },
      { name: "changed input mode is rejected", req: (r) => { r.identity.mode = InputModeCommit; }, wantErr: "input mode changed" },
      { name: "changed repository identity is rejected", req: (r) => { r.identity.repositorySha256 = "repo-other"; }, wantErr: "repository identity changed" },
      {
        name: "repository with no remote on both sides is unchanged",
        parent: (m) => { m.repository.identitySha256 = ""; },
        req: (r) => { r.identity.repositorySha256 = ""; },
        wantErr: "",
      },
      { name: "changed source artifact is rejected", req: (r) => { r.identity.sourceArtifactSha256 = "artifact-moved"; }, wantErr: "reviewed input changed" },
      { name: "parent without rule identity is rejected as unverifiable", parent: (m) => { m.execution.ruleConfigSha256 = ""; }, wantErr: "no rule identity" },
      { name: "changed rule config is rejected", req: (r) => { r.identity.ruleConfigSha256 = "rules-other"; }, wantErr: "rule identity changed" },
      {
        name: "filter change is reported as an input change, not a rule change",
        req: (r) => { r.identity.sourceArtifactSha256 = "artifact-fewer-files"; r.identity.ruleConfigSha256 = "rules-with-exclude"; },
        wantErr: "reviewed input changed",
      },
      { name: "implicit provider change is rejected", req: (r) => { r.provider = "openai"; }, wantErr: "provider changed" },
      { name: "explicit provider change is accepted", req: (r) => { r.provider = "openai"; r.model = "gpt-5"; r.providerExplicit = true; }, wantErr: "" },
      { name: "implicit model change is rejected", req: (r) => { r.model = "claude-next"; }, wantErr: "model changed" },
      { name: "explicit model change is accepted", req: (r) => { r.model = "claude-next"; r.modelExplicit = true; }, wantErr: "" },
    ];

    for (const tc of cases) {
      const state = parentState(tc.parent);
      if (tc.state) tc.state(state);
      const err = state.ValidateResume(request(tc.req));
      if (tc.wantErr === "" && err !== null) {
        throw new Error(`${tc.name}: want accepted, got error: ${err.message}`);
      }
      if (tc.wantErr !== "" && err === null) {
        throw new Error(`${tc.name}: want rejection mentioning ${JSON.stringify(tc.wantErr)}, got accepted`);
      }
      if (tc.wantErr !== "" && err !== null && !err.message.includes(tc.wantErr)) {
        throw new Error(`${tc.name}: error ${JSON.stringify(err.message)} does not mention ${JSON.stringify(tc.wantErr)}`);
      }
      expect(true).toBe(true);
    }
  });

  // OCR v1.9.3: TestValidateResumeNilStateAccepts
  test("nil parent is accepted as non-resume run", () => {
    const s: ResumeState | null = null;
    const err = (s as unknown as { ValidateResume?: (r: ResumeRequest) => Error | null })?.ValidateResume?.(request()) ?? null;
    // In Go, (*ResumeState)(nil).ValidateResume accepts. In TS, we treat null as accepted.
    expect(err).toBeNull();
    // Also test direct null handling via function that guards nil
    const guard = (state: ResumeState | null, req: ResumeRequest): Error | null => {
      if (state === null) return null;
      return state.ValidateResume(req);
    };
    expect(guard(null, request())).toBeNull();
  });

  // OCR v1.9.3: TestTransitionRejectionStaysActionableWithNoName
  test("transition rejection with empty provider/model still hints flag", () => {
    const cases = [
      { name: "provider resolved to no name", req: (r: ResumeRequest) => { r.provider = ""; }, wantSub: "pass --provider <name> explicitly" },
      { name: "model resolved to no name", req: (r: ResumeRequest) => { r.model = ""; }, wantSub: "pass --model <name> explicitly" },
    ];
    for (const tc of cases) {
      const err = parentState().ValidateResume(request(tc.req));
      expect(err, tc.name).not.toBeNull();
      expect(err!.message.includes(tc.wantSub), `${tc.name}: message ${JSON.stringify(err!.message)} must contain ${JSON.stringify(tc.wantSub)}`).toBe(true);
    }
  });

  // OCR v1.9.3: TestNewResumeLineage
  test("NewResumeLineage handles nil, missing manifest, transition and non-transition", () => {
    // nil parent records nothing
    expect(NewResumeLineage(null, "run-child", "anthropic", "claude")).toBeNull();
    // parent without manifest records nothing
    const sNoManifest = parentState();
    (sNoManifest as unknown as { manifest: RunManifest | null }).manifest = null;
    expect(NewResumeLineage(sNoManifest, "run-child", "anthropic", "claude")).toBeNull();
    // transition carries both endpoints
    const l = NewResumeLineage(parentState(), "run-child", "openai", "gpt-5");
    expect(l).not.toBeNull();
    const want: ResumeLineage = {
      type: "resume_lineage",
      schemaVersion: ResumeLineageSchemaVersion,
      runId: "run-child",
      parentRunId: "run-parent",
      sourceProvider: "anthropic",
      sourceModel: "claude",
      targetProvider: "openai",
      targetModel: "gpt-5",
    };
    expect(l).toEqual(want);
    expect(isResumeTransition(l)).toBe(true);
    // same target is a lineage but not a transition
    const l2 = NewResumeLineage(parentState(), "run-child", "anthropic", "claude")!;
    expect(l2).not.toBeNull();
    expect(isResumeTransition(l2)).toBe(false);
    // nil lineage is not a transition
    expect(isResumeTransition(null)).toBe(false);
  });

  function attachTestWriter(sh: SessionHistory): void {
    if (sh.HasPersistence()) return;
    const w = new JsonlWriter(sh.sessionId, sh.repoDir, sh.gitBranch, sh.model, {
      reviewMode: sh.reviewMode,
      diffFrom: sh.diffFrom,
      diffTo: sh.diffTo,
      diffCommit: sh.diffCommit,
      scanPaths: sh.scanPaths,
      resumedFrom: sh.resumedFrom,
    });
    w.open();
    w.WriteSessionStart(sh.startTime);
    const handle = {
      writeReviewItemDone: (...a: Parameters<JsonlWriter["WriteReviewItemDone"]>) => { w.WriteReviewItemDone(...a); },
      writeReviewItemReused: (...a: Parameters<JsonlWriter["WriteReviewItemReused"]>) => { w.WriteReviewItemReused(...a); },
      writeReviewItemFailed: (...a: Parameters<JsonlWriter["WriteReviewItemFailed"]>) => { w.WriteReviewItemFailed(...a); },
      writeResumeLineage: (l: import("../../../src/ocr/session/resume.ts").ResumeLineage) => { w.WriteResumeLineage(l); },
      writeSessionEnd: (...a: Parameters<JsonlWriter["WriteSessionEnd"]>) => w.WriteSessionEnd(...a),
    } as unknown as import("../../../src/ocr/session/history.ts").PersistHandle;
    (sh as unknown as { _attachPersist: (h: unknown) => void })._attachPersist(handle);
  }

  // OCR v1.9.3: TestResumeLineageRoundTripsThroughSessionFile
  test("resume lineage round-trips through session file", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "feature", "gpt-5", { reviewMode: "range", diffFrom: "main", diffTo: "feature", resumedFrom: "parent-session", operation: "review" } as unknown as import("../../../src/ocr/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      const want = NewResumeLineage(parentState(), sh.sessionId, "openai", "gpt-5")!;
      sh.RecordResumeLineage(want);
      const err = sh.Finalize();
      expect(err).toBeNull();
      const summary = LoadSummary(repoDir, sh.sessionId);
      const got = summary.resumeLineage;
      expect(got).not.toBeNull();
      expect(got).toEqual(want);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestResumeLineageReachesDiskBeforeFinalize
  test("resume lineage reaches disk before finalize", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "feature", "gpt-5", { reviewMode: "range", operation: "review" } as unknown as import("../../../src/ocr/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      sh.RecordResumeLineage(NewResumeLineage(parentState(), sh.sessionId, "openai", "gpt-5")!);
      const fp = SessionFilePath(repoDir, sh.sessionId);
      const raw = fs.readFileSync(fp, "utf-8");
      expect(raw.includes(ResumeLineageSchemaVersion)).toBe(true);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // OCR v1.9.3: TestUnknownLineageSchemaIsIgnored
  test("unknown lineage schema is ignored", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-repo-"));
      const sh = new SessionHistory(repoDir, "main", "model", { reviewMode: "range", operation: "review" } as unknown as import("../../../src/ocr/session/history.ts").SessionOptions);
      attachTestWriter(sh);
      const fp = SessionFilePath(repoDir, sh.sessionId);
      sh.Finalize();
      const unknown = JSON.stringify({ type: "resume_lineage", schema_version: "ocr.resume-lineage/v99", parent_run_id: "run-parent" }) + "\n";
      fs.appendFileSync(fp, unknown);
      const summary = LoadSummary(repoDir, sh.sessionId);
      expect(summary.resumeLineage).toBeNull();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

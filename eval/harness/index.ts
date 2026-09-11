// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors

/**
 * Eval harness — typed library code for corpus-grounded evaluation of the
 * review engine (evolution roadmap Phase 0 item 2; design per
 * docs/evolution/decisions.md D2, layout per eval/README.md).
 *
 * The pipeline: load a hash-pinned corpus manifest (`corpus.ts`), run each
 * case through the real review engine with an injected scripted model
 * transport (`runner.ts`, `transport.ts` — zero paid/network calls), judge
 * findings through the injectable scorer seam (`scorer.ts`), and write a
 * deterministic per-run report (`report.ts`). No CLI yet: callers compose
 * these functions.
 */

export { EvalContractError } from "./errors.js";

export { canonicalJson, stableJson, sha256Hex } from "./canonical.js";

export {
	CORPUS_MANIFEST_SCHEMA_VERSION,
	CorpusCaseSchema,
	CorpusManifestSchema,
	DefectReferenceSchema,
	ExpectationSchema,
	buildCorpusManifest,
	corpusCaseContentSha256,
	loadCorpusManifest,
	manifestSha256,
	parseCorpusManifest,
} from "./corpus.js";
export type {
	CorpusCase,
	CorpusCaseInput,
	CorpusExpectation,
	CorpusManifest,
	DefectReference,
} from "./corpus.js";

export {
	createScriptedModelPool,
	cannedReviewResponder,
} from "./transport.js";
export type {
	CannedFinding,
	CannedReviewModel,
	ModelIdentity,
	RuntimeTransport,
	RuntimeTransportFactory,
	ScriptedModelPool,
	ScriptedPoolStats,
	ScriptedResponder,
} from "./transport.js";

export { runCase, runCorpus } from "./runner.js";
export type {
	CaseRunOptions,
	CaseRunRecord,
	CaseRunTarget,
	CaseWorkspace,
	CaseWorkspaceProvider,
} from "./runner.js";

export {
	scoreCase,
	scoreCorpusRun,
	summarize,
} from "./scorer.js";
export type {
	CaseOutcome,
	FindingVerdict,
	Judge,
	JudgeInput,
	JudgedFinding,
	RunScoreSummary,
	ScoredCase,
} from "./scorer.js";

export {
	RUN_CONFIG_SCHEMA_VERSION,
	RUN_SUMMARY_SCHEMA_VERSION,
	buildRunSummary,
	writeRunResults,
} from "./report.js";
export type { RunConfig, WrittenRunResults } from "./report.js";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Scorer seam: injected fake judges, D2 outcome validation, and aggregates.
// No model is called anywhere — the real blind judge will plug into the same
// Judge seam later.

import { describe, expect, test } from "bun:test";

import {
	EvalContractError,
	buildCorpusManifest,
	scoreCase,
	scoreCorpusRun,
	summarize,
	type CaseOutcome,
	type CaseRunRecord,
	type Judge,
	type ScoredCase,
} from "../../eval/harness/index.js";
import type { Finding } from "../../src/types.js";

const FIXTURE_MANIFEST = buildCorpusManifest({
	name: "scorer-suite",
	cases: [
		{
			id: "case-fix",
			repo: { url: "https://github.com/example/repo" },
			baseCommit: "a".repeat(40),
			headCommit: "b".repeat(40),
			expectation: { kind: "defect-fix", defect: { reference: "issue #7: radix" } },
			language: "typescript",
		},
		{
			id: "case-clean",
			repo: { url: "https://github.com/example/repo" },
			baseCommit: "a".repeat(40),
			headCommit: "c".repeat(40),
			expectation: { kind: "clean" },
			language: "typescript",
		},
	],
});
const FIX_CASE = FIXTURE_MANIFEST.cases[0]!;
const CLEAN_CASE = FIXTURE_MANIFEST.cases[1]!;

function finding(path: string, content: string): Finding {
	return { path, content, existingCode: "", startLine: 1, endLine: 1, category: "bug", severity: "high" };
}

function runRecord(caseId: string, findings: readonly Finding[], status: CaseRunRecord["status"] = "complete"): CaseRunRecord {
	return {
		caseId,
		expectationKind: "defect-fix",
		target: { mode: "range", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) },
		model: { provider: "scripted", model: "eval-model" },
		status,
		message: "recorded",
		findings,
		coverage: { selected: [], completed: [], failed: [], skipped: [], excluded: [] },
		usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
		warnings: [],
		sessionId: "session-1",
		modelRequests: 3,
		transports: 1,
		elapsedMs: 5,
	};
}

/** Deterministic fake blind judge: hits findings whose content names the defect marker. */
function markerJudge(marker: string, extras: { readonly falseAlarms?: number } = {}): Judge {
	return ({ findings }) => {
		const judged = findings.map((finding, index) => ({
			index,
			verdict: (finding.content.includes(marker) ? "hit" : "false-alarm") as "hit" | "false-alarm",
			rationale: finding.content.includes(marker) ? "names the defect" : "unrelated",
		}));
		return {
			kind: "defect-fix",
			hit: judged.some((entry) => entry.verdict === "hit"),
			judged,
			notes: extras.falseAlarms === undefined ? [] : [`${String(extras.falseAlarms)} false alarms`],
		} satisfies CaseOutcome;
	};
}

/** Wrap a defect-fix judge so clean cases get the only outcome they may have. */
function kindAwareJudge(defectFixJudge: Judge): Judge {
	return (input) => {
		if (input.caseDef.expectation.kind === "clean") {
			return {
				kind: "clean",
				judged: input.findings.map((_, index) => ({ index, verdict: "false-alarm" as const })),
				notes: [],
			};
		}
		return defectFixJudge(input);
	};
}

describe("scoreCase", () => {
	test("defect-fix: hit with false alarms and notes", async () => {
		const run = runRecord("case-fix", [
			finding("src/radix.ts", "radix missing — matches issue #7: radix"),
			finding("src/style.ts", "naming nit"),
		]);
		const scored = await scoreCase(FIX_CASE, run, markerJudge("issue #7: radix"));
		expect(scored.outcome.kind).toBe("defect-fix");
		expect(scored.outcome).toMatchObject({ hit: true });
		expect(scored.outcome.judged.map((entry) => entry.verdict)).toEqual(["hit", "false-alarm"]);
	});

	test("defect-fix: missed when no finding identifies the defect", async () => {
		const run = runRecord("case-fix", [finding("src/style.ts", "naming nit")]);
		const scored = await scoreCase(FIX_CASE, run, markerJudge("issue #7: radix"));
		expect(scored.outcome.kind === "defect-fix" && scored.outcome.hit).toBe(false);
	});

	test("defect-fix: no findings means missed", async () => {
		const scored = await scoreCase(FIX_CASE, runRecord("case-fix", []), markerJudge("issue #7: radix"));
		expect(scored.outcome.kind === "defect-fix" && scored.outcome.hit).toBe(false);
	});

	test("clean case: findings may only be false alarms", async () => {
		const run = runRecord("case-clean", [finding("src/noise.ts", "unrelated complaint")]);
		const judge: Judge = ({ findings }) => ({
			kind: "clean",
			judged: findings.map((finding, index) => ({ index, verdict: "false-alarm" as const })),
			notes: [],
		});
		const scored = await scoreCase(CLEAN_CASE, run, judge);
		expect(scored.outcome.kind).toBe("clean");
	});

	test("judge inconsistencies throw EvalContractError", async () => {
		const run = runRecord("case-fix", [finding("src/a.ts", "x"), finding("src/b.ts", "y")]);
		const badJudges: Array<[string, Judge]> = [
			["index out of range", () => ({ kind: "defect-fix", hit: true, judged: [{ index: 2, verdict: "hit" }], notes: [] })],
			["duplicate index", () => ({
				kind: "defect-fix",
				hit: true,
				judged: [
					{ index: 0, verdict: "hit" },
					{ index: 0, verdict: "false-alarm" },
				],
				notes: [],
			})],
			["wrong outcome kind", () => ({ kind: "clean", judged: [], notes: [] })],
			["hit on clean case", () => ({ kind: "clean", judged: [{ index: 0, verdict: "hit" }], notes: [] }) as CaseOutcome],
		];
		for (const [label, judge] of badJudges) {
			const caseDef = label === "hit on clean case" ? CLEAN_CASE : FIX_CASE;
			await expect(scoreCase(caseDef, run, judge), label).rejects.toThrow(EvalContractError);
		}
	});
});

describe("scoreCorpusRun", () => {
	test("requires exactly one record per manifest case", async () => {
		const judge = kindAwareJudge(markerJudge("issue #7: radix"));
		const good = [runRecord("case-fix", []), runRecord("case-clean", [])];
		expect((await scoreCorpusRun(FIXTURE_MANIFEST, good, judge)).map((scored) => scored.caseDef.id)).toEqual([
			"case-fix",
			"case-clean",
		]);
		await expect(scoreCorpusRun(FIXTURE_MANIFEST, [runRecord("case-fix", [])], judge)).rejects.toThrow(/missing records/);
		await expect(
			scoreCorpusRun(FIXTURE_MANIFEST, [runRecord("case-fix", []), runRecord("case-fix", []), runRecord("case-clean", [])], judge),
		).rejects.toThrow(/two records/);
		await expect(
			scoreCorpusRun(FIXTURE_MANIFEST, [runRecord("case-fix", []), runRecord("case-stray", []), runRecord("case-clean", [])], judge),
		).rejects.toThrow(/outside the corpus manifest/);
	});
});

describe("summarize", () => {
	test("aggregates hits, misses, and false alarms; excludes incomplete runs from bins", async () => {
		const hitRun = runRecord("case-fix", [finding("src/a.ts", "radix defect"), finding("src/b.ts", "noise")]);
		const cleanRun = runRecord("case-clean", [finding("src/c.ts", "noise")]);
		const judge = kindAwareJudge(markerJudge("radix defect"));
		const scored: ScoredCase[] = [
			await scoreCase(FIX_CASE, hitRun, judge),
			await scoreCase(CLEAN_CASE, cleanRun, judge),
		];
		// An incomplete run of another defect-fix case must not count as a miss.
		const failedManifest = buildCorpusManifest({
			name: "scorer-suite",
			cases: [
				{
					id: "case-broken",
					repo: { url: "https://github.com/example/repo" },
					baseCommit: "a".repeat(40),
					headCommit: "d".repeat(40),
					expectation: { kind: "defect-fix", defect: { reference: "x" } },
					language: "go",
				},
			],
		});
		scored.push(await scoreCase(failedManifest.cases[0]!, runRecord("case-broken", [], "failed"), markerJudge("x")));

		const summary = summarize(scored);
		expect(summary.cases).toBe(3);
		expect(summary.completeRuns).toBe(2);
		expect(summary.incompleteRuns).toBe(1);
		expect(summary.defectFix).toEqual({ total: 1, hits: 1, missed: 0, falseAlarms: 1 });
		expect(summary.clean).toEqual({ total: 1, clean: 0, runsWithFalseAlarms: 1, falseAlarms: 1 });
	});
});

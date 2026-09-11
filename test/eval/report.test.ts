// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Report generator: deterministic bytes, no-overwrite rule, and aggregate
// correctness. All writes go to temporary directories.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	EvalContractError,
	buildRunSummary,
	writeRunResults,
	type RunConfig,
	type ScoredCase,
} from "../../eval/harness/index.js";
import type { Finding } from "../../src/types.js";

const CONFIG: RunConfig = {
	schemaVersion: "pi-review.eval-run/v1",
	runId: "run-2026-09-10-mock",
	corpusName: "unit-suite",
	corpusManifestSha256: "9".repeat(64),
	model: { provider: "scripted", model: "eval-model" },
	reviewOptions: { concurrency: 4, maxToolRounds: null, exclude: [], rules: false, background: false },
};

function finding(path: string, content: string): Finding {
	return { path, content, existingCode: "code", startLine: 2, endLine: 2, category: "bug", severity: "high" };
}

function scoredCase(caseId: string, expectationKind: "defect-fix" | "clean", findings: readonly Finding[]): ScoredCase {
	return {
		caseDef: {
			id: caseId,
			repo: { url: "https://github.com/example/repo" },
			baseCommit: "a".repeat(40),
			headCommit: "b".repeat(40),
			expectation: expectationKind === "clean" ? { kind: "clean" } : { kind: "defect-fix", defect: { reference: "issue #7" } },
			language: "go",
			contentSha256: "0".repeat(64),
		},
		run: {
			caseId,
			expectationKind,
			target: { mode: "range", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) },
			model: { provider: "scripted", model: "eval-model" },
			status: "complete",
			message: "reviewed",
			findings,
			coverage: { selected: [], completed: [], failed: [], skipped: [], excluded: [] },
			usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 14 },
			warnings: [],
			sessionId: "session-1",
			modelRequests: 3,
			transports: 1,
			elapsedMs: 7,
		},
		outcome:
			expectationKind === "clean"
				? { kind: "clean", judged: findings.map((_, index) => ({ index, verdict: "false-alarm" as const })), notes: [] }
				: {
						kind: "defect-fix",
						hit: findings.length > 0,
						judged: findings.map((_, index) => ({ index, verdict: index === 0 ? ("hit" as const) : ("false-alarm" as const) })),
						notes: [],
					},
	};
}

function tmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "eval-results-"));
}

describe("writeRunResults", () => {
	test("writes config.json and summary.json with correct totals", async () => {
		const root = tmpRoot();
		try {
			const scored = [
				scoredCase("case-fix", "defect-fix", [finding("src/a.go", "the defect"), finding("src/b.go", "noise")]),
				scoredCase("case-clean", "clean", []),
			];
			const written = await writeRunResults(root, CONFIG, scored);
			expect(written.directory).toBe(path.join(root, CONFIG.runId));

			const configOnDisk = JSON.parse(fs.readFileSync(written.configPath, "utf8")) as RunConfig;
			expect(configOnDisk).toEqual(CONFIG);

			const summary = JSON.parse(fs.readFileSync(written.summaryPath, "utf8")) as {
				schemaVersion: string;
				runId: string;
				corpus: { name: string; manifestSha256: string; cases: number };
				totals: { cases: number; completeRuns: number; incompleteRuns: number; defectFix: { total: number; hits: number; missed: number; falseAlarms: number }; clean: { total: number; clean: number; runsWithFalseAlarms: number; falseAlarms: number } };
				cases: Array<{ caseId: string; runStatus: string; hit: boolean | null; judged: Array<{ index: number }> }>;
			};
			expect(summary.schemaVersion).toBe("pi-review.eval-summary/v1");
			expect(summary.runId).toBe(CONFIG.runId);
			expect(summary.corpus).toEqual({ name: "unit-suite", manifestSha256: CONFIG.corpusManifestSha256, cases: 2 });
			expect(summary.totals).toEqual({
				cases: 2,
				completeRuns: 2,
				incompleteRuns: 0,
				defectFix: { total: 1, hits: 1, missed: 0, falseAlarms: 1 },
				clean: { total: 1, clean: 1, runsWithFalseAlarms: 0, falseAlarms: 0 },
			});
			expect(summary.cases.map((entry) => entry.caseId)).toEqual(["case-clean", "case-fix"]);
			expect(summary.cases.find((entry) => entry.caseId === "case-fix")?.hit).toBe(true);
			expect(summary.cases.find((entry) => entry.caseId === "case-clean")?.hit).toBeNull();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("bytes are deterministic regardless of record order", async () => {
		const firstRoot = tmpRoot();
		const secondRoot = tmpRoot();
		try {
			const a = scoredCase("case-a", "defect-fix", [finding("src/a.go", "defect")]);
			const b = scoredCase("case-b", "clean", []);
			const first = await writeRunResults(firstRoot, CONFIG, [a, b]);
			const second = await writeRunResults(secondRoot, CONFIG, [b, a]);
			expect(fs.readFileSync(first.summaryPath, "utf8")).toBe(fs.readFileSync(second.summaryPath, "utf8"));
			expect(fs.readFileSync(first.configPath, "utf8")).toBe(fs.readFileSync(second.configPath, "utf8"));
			// Committed artifacts are pretty-printed stable JSON with a trailing newline.
			const summaryText = fs.readFileSync(first.summaryPath, "utf8");
			expect(summaryText.endsWith("\n")).toBe(true);
			expect(summaryText).toContain("\n  \"schemaVersion\":");
		} finally {
			fs.rmSync(firstRoot, { recursive: true, force: true });
			fs.rmSync(secondRoot, { recursive: true, force: true });
		}
	});

	test("refuses to overwrite an existing run directory", async () => {
		const root = tmpRoot();
		try {
			await writeRunResults(root, CONFIG, [scoredCase("case-a", "clean", [])]);
			await expect(writeRunResults(root, CONFIG, [scoredCase("case-a", "clean", [])])).rejects.toThrow(
				/never overwritten/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects unsafe run ids and duplicate scored cases", async () => {
		const root = tmpRoot();
		try {
			await expect(
				writeRunResults(root, { ...CONFIG, runId: "../escape" }, [scoredCase("case-a", "clean", [])]),
			).rejects.toThrow(EvalContractError);
			await expect(
				writeRunResults(
					root,
					{ ...CONFIG, runId: "run-dup" },
					[scoredCase("case-a", "clean", []), scoredCase("case-a", "clean", [])],
				),
			).rejects.toThrow(/duplicate case/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("buildRunSummary", () => {
	test("judged findings are ordered by index regardless of judge order", () => {
		const entry = scoredCase("case-fix", "defect-fix", [finding("src/a.go", "one"), finding("src/b.go", "two")]);
		const reordered: ScoredCase = {
			...entry,
			outcome:
				entry.outcome.kind === "defect-fix"
					? {
							...entry.outcome,
							judged: [
								{ index: 1, verdict: "false-alarm" },
								{ index: 0, verdict: "hit" },
							],
						}
					: entry.outcome,
		};
		const summary = buildRunSummary(CONFIG, [reordered]) as {
			cases: Array<{ judged: Array<{ index: number }> }>;
		};
		expect(summary.cases[0]!.judged.map((judged) => judged.index)).toEqual([0, 1]);
	});
});

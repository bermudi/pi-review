// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors

/**
 * Scorer seam (evolution Phase 0 item 2; outcome design per
 * docs/evolution/decisions.md D2).
 *
 * Per-case outcomes distinguish: a *hit* (a finding identifies the defect
 * the fix commit addressed), *false alarms* (findings that do not), *missed*
 * (defect-fix case with no hit), and free-form *notes*. For `clean` cases
 * every finding is by definition a false alarm.
 *
 * Judging is an injected {@link Judge} — unit tests and mock runs use a fake
 * judge; the real blind judge (a model that is not the model under test, per
 * D2) plugs into the same seam later. The scorer validates that a judge
 * classifies every finding exactly once and never returns hits for clean
 * cases, so judge bugs cannot silently corrupt evidence.
 */

import type { Finding } from "../../src/types.js";

import { EvalContractError } from "./errors.js";
import type { CorpusCase } from "./corpus.js";
import type { CaseRunRecord } from "./runner.js";

export interface JudgeInput {
	readonly caseDef: CorpusCase;
	readonly findings: readonly Finding[];
}

export type FindingVerdict = "hit" | "false-alarm";

export interface JudgedFinding {
	readonly index: number;
	readonly verdict: FindingVerdict;
	readonly rationale?: string;
}

export type CaseOutcome =
	| {
			readonly kind: "defect-fix";
			/** True when at least one finding identifies the referenced defect. */
			readonly hit: boolean;
			readonly judged: readonly JudgedFinding[];
			readonly notes: readonly string[];
	  }
	| {
			readonly kind: "clean";
			readonly judged: readonly JudgedFinding[];
			readonly notes: readonly string[];
	  };

/**
 * The judging seam. Blind judging (judge does not know which engine or model
 * produced the findings) is a property of the judge implementation, not of
 * this type; the future real judge receives only case expectation plus
 * findings.
 */
export type Judge = (input: JudgeInput) => CaseOutcome | Promise<CaseOutcome>;

export interface ScoredCase {
	readonly caseDef: CorpusCase;
	readonly run: CaseRunRecord;
	readonly outcome: CaseOutcome;
}

function validateJudged(judged: readonly JudgedFinding[], findings: readonly Finding[], what: string): void {
	const seen = new Set<number>();
	for (const entry of judged) {
		if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= findings.length) {
			throw new EvalContractError(`${what}: judged finding index ${String(entry.index)} is out of range (0..${String(findings.length - 1)})`);
		}
		if (seen.has(entry.index)) {
			throw new EvalContractError(`${what}: finding ${String(entry.index)} was judged more than once`);
		}
		seen.add(entry.index);
	}
}

/**
 * Judge one case's findings into a D2 outcome. Throws {@link EvalContractError}
 * when the judge's output is inconsistent with the case or the findings.
 */
export async function scoreCase(caseDef: CorpusCase, run: CaseRunRecord, judge: Judge): Promise<ScoredCase> {
	const outcome = await judge({ caseDef, findings: run.findings });

	if (outcome.kind !== caseDef.expectation.kind) {
		throw new EvalContractError(
			`judge returned outcome kind "${outcome.kind}" for case ${caseDef.id} with expectation "${caseDef.expectation.kind}"`,
		);
	}
	validateJudged(outcome.judged, run.findings, `judge output for case ${caseDef.id}`);
	if (outcome.kind === "clean") {
		const hits = outcome.judged.filter((entry) => entry.verdict === "hit");
		if (hits.length > 0) {
			throw new EvalContractError(
				`judge returned ${String(hits.length)} hit verdict(s) for clean case ${caseDef.id}; clean cases have no defect to hit`,
			);
		}
	}

	const finalOutcome: CaseOutcome =
		outcome.kind === "defect-fix"
			? { ...outcome, hit: outcome.judged.some((entry) => entry.verdict === "hit") }
			: outcome;
	return { caseDef, run, outcome: finalOutcome };
}

/**
 * Score a full run's records against a manifest. Requires exactly one record
 * per manifest case (a corpus run that loses a case is invalid evidence).
 */
export async function scoreCorpusRun(
	manifest: { readonly cases: readonly CorpusCase[] },
	records: readonly CaseRunRecord[],
	judge: Judge,
): Promise<ScoredCase[]> {
	const byId = new Map<string, CaseRunRecord>();
	for (const record of records) {
		if (byId.has(record.caseId)) {
			throw new EvalContractError(`run produced two records for case ${record.caseId}`);
		}
		byId.set(record.caseId, record);
	}
	const missing = manifest.cases.filter((caseDef) => !byId.has(caseDef.id)).map((caseDef) => caseDef.id);
	if (missing.length > 0) {
		throw new EvalContractError(`run is missing records for corpus case(s): ${missing.join(", ")}`);
	}
	const unknown = [...byId.keys()].filter((id) => !manifest.cases.some((caseDef) => caseDef.id === id));
	if (unknown.length > 0) {
		throw new EvalContractError(`run has records outside the corpus manifest: ${unknown.join(", ")}`);
	}
	const scored: ScoredCase[] = [];
	for (const caseDef of manifest.cases) {
		const record = byId.get(caseDef.id);
		if (record === undefined) throw new EvalContractError(`missing record for case ${caseDef.id}`);
		scored.push(await scoreCase(caseDef, record, judge));
	}
	return scored;
}

// ---------------------------------------------------------------------------
// Aggregates — deterministic, order-independent summaries for report.json.
// Only complete runs contribute to precision/recall-style bins; incomplete
// (partial/failed/skipped) runs are counted separately so a broken engine
// run never masquerades as a miss.
// ---------------------------------------------------------------------------

export interface RunScoreSummary {
	readonly cases: number;
	readonly completeRuns: number;
	readonly incompleteRuns: number;
	readonly defectFix: {
		readonly total: number;
		readonly hits: number;
		readonly missed: number;
		readonly falseAlarms: number;
	};
	readonly clean: {
		readonly total: number;
		/** Complete clean runs with zero findings. */
		readonly clean: number;
		readonly runsWithFalseAlarms: number;
		readonly falseAlarms: number;
	};
}

export function summarize(scored: readonly ScoredCase[]): RunScoreSummary {
	let completeRuns = 0;
	let incompleteRuns = 0;
	let defectFixTotal = 0;
	let hits = 0;
	let missed = 0;
	let defectFalseAlarms = 0;
	let cleanTotal = 0;
	let cleanRuns = 0;
	let runsWithFalseAlarms = 0;
	let cleanFalseAlarms = 0;

	for (const entry of scored) {
		if (entry.run.status !== "complete") {
			incompleteRuns += 1;
			continue;
		}
		completeRuns += 1;
		const falseAlarms = entry.outcome.judged.filter((j) => j.verdict === "false-alarm").length;
		if (entry.outcome.kind === "defect-fix") {
			defectFixTotal += 1;
			if (entry.outcome.hit) hits += 1;
			else missed += 1;
			defectFalseAlarms += falseAlarms;
		} else {
			cleanTotal += 1;
			if (entry.outcome.judged.length === 0) cleanRuns += 1;
			else runsWithFalseAlarms += 1;
			cleanFalseAlarms += falseAlarms;
		}
	}

	return {
		cases: scored.length,
		completeRuns,
		incompleteRuns,
		defectFix: { total: defectFixTotal, hits, missed, falseAlarms: defectFalseAlarms },
		clean: { total: cleanTotal, clean: cleanRuns, runsWithFalseAlarms, falseAlarms: cleanFalseAlarms },
	};
}

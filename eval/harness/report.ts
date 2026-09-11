// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors

/**
 * Report generator (evolution Phase 0 item 2).
 *
 * Writes one directory per run under the results root —
 * `<root>/<run-id>/config.json` and `<root>/<run-id>/summary.json` —
 * deterministically derived from the run config and scored records:
 *
 * - object keys are sorted (stable JSON), arrays are deterministically
 *   ordered (cases by id, judged findings by index), and the generator
 *   invents no timestamps or ids of its own;
 * - run directories are never overwritten (eval/README.md rule); a second
 *   write to the same run id is an error;
 * - the generator performs no I/O other than creating the two files.
 *
 * Summaries are the committed, citable artifact; raw transcripts stay
 * gitignored per eval/README.md.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stableJson } from "./canonical.js";
import { EvalContractError } from "./errors.js";
import type { ModelIdentity } from "./transport.js";
import { summarize, type ScoredCase, type RunScoreSummary } from "./scorer.js";

export const RUN_CONFIG_SCHEMA_VERSION = "pi-review.eval-run/v1";
export const RUN_SUMMARY_SCHEMA_VERSION = "pi-review.eval-summary/v1";

/** The runId doubles as the results directory name. */
const RUN_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,127}$";

export interface RunConfig {
	readonly schemaVersion: typeof RUN_CONFIG_SCHEMA_VERSION;
	readonly runId: string;
	readonly corpusName: string;
	/** `manifestSha256` of the corpus manifest this run scored. */
	readonly corpusManifestSha256: string;
	readonly model: ModelIdentity;
	/** Review-contract surface the runs exercised (public contract slice). */
	readonly reviewOptions: {
		readonly concurrency: number;
		readonly maxToolRounds: number | null;
		readonly exclude: readonly string[];
		readonly rules: boolean;
		readonly background: boolean;
	};
	readonly notes?: string;
}

export interface WrittenRunResults {
	readonly directory: string;
	readonly configPath: string;
	readonly summaryPath: string;
}

interface SummaryCaseEntry {
	readonly caseId: string;
	readonly expectationKind: string;
	readonly language: string;
	readonly target: { readonly mode: string; readonly baseCommit: string; readonly headCommit: string };
	readonly runStatus: string;
	readonly runMessage: string;
	readonly hit: boolean | null;
	readonly findings: unknown;
	readonly judged: unknown;
	readonly notes: readonly string[];
	readonly usage: unknown;
	readonly modelRequests: number;
	readonly transports: number;
}

function summaryCase(entry: ScoredCase): SummaryCaseEntry {
	const { caseDef, run, outcome } = entry;
	const judged = [...outcome.judged].sort((a, b) => a.index - b.index);
	return {
		caseId: caseDef.id,
		expectationKind: caseDef.expectation.kind,
		language: caseDef.language,
		target: run.target,
		runStatus: run.status,
		runMessage: run.message,
		hit: outcome.kind === "defect-fix" ? outcome.hit : null,
		findings: run.findings,
		judged,
		notes: outcome.notes,
		usage: run.usage,
		modelRequests: run.modelRequests,
		transports: run.transports,
	};
}

/**
 * Build the summary document from scored records. Exposed for tests and for
 * callers that want to inspect the exact bytes-to-be without writing.
 */
export function buildRunSummary(config: RunConfig, scored: readonly ScoredCase[]): unknown {
	const totals: RunScoreSummary = summarize(scored);
	return {
		schemaVersion: RUN_SUMMARY_SCHEMA_VERSION,
		runId: config.runId,
		corpus: {
			name: config.corpusName,
			manifestSha256: config.corpusManifestSha256,
			cases: scored.length,
		},
		model: config.model,
		totals,
		cases: [...scored].sort((a, b) => (a.caseDef.id < b.caseDef.id ? -1 : a.caseDef.id > b.caseDef.id ? 1 : 0)).map(summaryCase),
	};
}

/**
 * Write `config.json` and `summary.json` for one run under
 * `<resultsRoot>/<runId>/`. Returns the created directory. Refuses to
 * overwrite an existing run directory.
 */
export async function writeRunResults(
	resultsRoot: string,
	config: RunConfig,
	scored: readonly ScoredCase[],
): Promise<WrittenRunResults> {
	if (!new RegExp(RUN_ID_PATTERN).test(config.runId)) {
		throw new EvalContractError(`run id ${JSON.stringify(config.runId)} is not safe as a results directory name`);
	}
	if (config.schemaVersion !== RUN_CONFIG_SCHEMA_VERSION) {
		throw new EvalContractError(`run config has schemaVersion ${config.schemaVersion}, expected ${RUN_CONFIG_SCHEMA_VERSION}`);
	}
	const ids = new Set<string>();
	for (const entry of scored) {
		if (ids.has(entry.caseDef.id)) {
			throw new EvalContractError(`scored run contains duplicate case ${entry.caseDef.id}`);
		}
		ids.add(entry.caseDef.id);
	}

	const directory = join(resultsRoot, config.runId);
	try {
		await stat(directory);
		throw new EvalContractError(`results directory ${directory} already exists; run results are never overwritten`);
	} catch (error) {
		if (error instanceof EvalContractError) throw error;
		// ENOENT — the expected case.
	}

	await mkdir(directory, { recursive: true });
	const configPath = join(directory, "config.json");
	const summaryPath = join(directory, "summary.json");
	await writeFile(configPath, `${stableJson(config)}\n`, "utf8");
	await writeFile(summaryPath, `${stableJson(buildRunSummary(config, scored))}\n`, "utf8");
	return { directory, configPath, summaryPath };
}

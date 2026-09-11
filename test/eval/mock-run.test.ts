// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Phase 0 done-criterion proof: the scoring pipeline produces a summary from
// a scripted (unpaid) mock run. Manifest → runner (injected transports, real
// temporary git repos, zero network) → injected judge → deterministic
// summary on disk.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildCorpusManifest,
	cannedReviewResponder,
	createScriptedModelPool,
	loadCorpusManifest,
	manifestSha256,
	runCorpus,
	scoreCorpusRun,
	writeRunResults,
	type CaseWorkspace,
	type CaseWorkspaceProvider,
	type CorpusCase,
	type CorpusCaseInput,
	type Judge,
	type RunConfig,
	type ScoredCase,
} from "../../eval/harness/index.js";
import { createTempRepo, type TempRepo } from "./support/temp-repo.js";

const MODEL = { provider: "scripted", model: "mock-gpt" } as const;

const VULN_BASE = `package main

import "os"

func ReadConfig(path string) string {
	data, _ := os.ReadFile(path)
	return string(data)
}
`;

const VULN_HEAD = `package main

import "os"

func ReadConfig(path string) string {
	data, _ := os.ReadFile(path)
	return string(data)
}

func ReadSecret(path string) string {
	data, _ := os.ReadFile(path)
	return string(data)
}
`;

const CLEAN_BASE = `export const guide = "one";
`;

const CLEAN_HEAD = `export const guide = "one"; // clarified for new maintainers
`;

function caseInput(id: string, repo: { baseCommit: string; headCommit: string }, kind: "defect-fix" | "clean"): CorpusCaseInput {
	return {
		id,
		repo: { url: "https://github.com/example/mock-corpus" },
		baseCommit: repo.baseCommit,
		headCommit: repo.headCommit,
		expectation:
			kind === "clean"
				? { kind: "clean" }
				: { kind: "defect-fix", defect: { reference: "issue #3: unchecked error from os.ReadFile" } },
		language: "go",
	};
}

/** Fake blind judge: hits findings that name the defect marker. */
const blindJudge: Judge = ({ caseDef, findings }) => {
	const marker = caseDef.expectation.kind === "defect-fix" ? "os.ReadFile error" : null;
	const judged = findings.map((finding, index) => ({
		index,
		verdict: (marker !== null && finding.content.includes(marker) ? "hit" : "false-alarm") as "hit" | "false-alarm",
	}));
	if (caseDef.expectation.kind === "clean") {
		return { kind: "clean", judged, notes: [] };
	}
	return { kind: "defect-fix", hit: judged.some((entry) => entry.verdict === "hit"), judged, notes: [] };
};

describe("phase 0 mock run (scripted, unpaid)", () => {
	test("manifest → scripted review → judged summary on disk", async () => {
		const defectRepo = createTempRepo({
			baseFiles: { "cmd/main.go": VULN_BASE },
			headFiles: { "cmd/main.go": VULN_HEAD },
		});
		const cleanRepo = createTempRepo({
			baseFiles: { "src/notes.ts": CLEAN_BASE },
			headFiles: { "src/notes.ts": CLEAN_HEAD },
		});
		const repos = new Map<string, TempRepo>([
			["mock-defect", defectRepo],
			["mock-clean", cleanRepo],
		]);
		const provider: CaseWorkspaceProvider = {
			async provide(caseDef: CorpusCase): Promise<CaseWorkspace> {
				const repo = repos.get(caseDef.id);
				if (repo === undefined) throw new Error(`no fixture repo for case ${caseDef.id}`);
				return { root: repo.root };
			},
			async dispose() {
				// Fixture repos are disposed by the test's finally block.
			},
		};

		const manifest = buildCorpusManifest({
			name: "mock-corpus",
			cases: [
				caseInput("mock-defect", defectRepo, "defect-fix"),
				caseInput("mock-clean", cleanRepo, "clean"),
			],
		});

		// The manifest round-trips through the loader with the same pinning hash.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-mock-"));
		const manifestPath = path.join(dir, "manifest.json");
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
		const loaded = await loadCorpusManifest(manifestPath);
		expect(loaded.manifestSha256).toBe(manifestSha256(manifest));

		const resultsRoot = path.join(dir, "results");
		try {
			// One scripted pool per case: fresh model state per case, every model
			// interaction observable, zero network by construction.
			const pools = new Map<string, ReturnType<typeof createScriptedModelPool>>();
			const records = await runCorpus({
				manifest: loaded.manifest,
				provider,
				model: MODEL,
				concurrency: 1,
				createTransportForCase: (caseDef) => {
					const pool = createScriptedModelPool({
						identity: MODEL,
						respond: cannedReviewResponder({
							findingsForFile: (filePath) =>
								caseDef.id === "mock-defect" && filePath === "cmd/main.go"
									? [
											{
												content: "os.ReadFile error is ignored, a partially read config is treated as valid",
												existingCode: "data, _ := os.ReadFile(path)",
												category: "bug",
												severity: "high",
											},
											{
												content: "function name ReadSecret is too long",
												existingCode: "func ReadSecret(path string) string {",
												category: "style",
												severity: "low",
											},
										]
									: [],
						}),
					});
					pools.set(caseDef.id, pool);
					return pool.factory;
				},
			});

			expect(records.map((record) => record.caseId).sort()).toEqual(["mock-clean", "mock-defect"]);
			const defectRecord = records.find((record) => record.caseId === "mock-defect")!;
			expect(defectRecord.status).toBe("complete");
			expect(defectRecord.findings).toHaveLength(2);
			expect(pools.get("mock-defect")!.stats().requests).toBe(defectRecord.modelRequests);

			const scored: ScoredCase[] = await scoreCorpusRun(loaded.manifest, records, blindJudge);

			const config: RunConfig = {
				schemaVersion: "pi-review.eval-run/v1",
				runId: "run-0000-mock-phase0",
				corpusName: loaded.manifest.name,
				corpusManifestSha256: loaded.manifestSha256,
				model: MODEL,
				reviewOptions: { concurrency: 1, maxToolRounds: null, exclude: [], rules: false, background: false },
				notes: "phase 0 scripted mock run — no paid model calls",
			};
			const written = await writeRunResults(resultsRoot, config, scored);

			const summary = JSON.parse(fs.readFileSync(written.summaryPath, "utf8")) as {
				corpus: { manifestSha256: string };
				totals: {
					cases: number;
					completeRuns: number;
					incompleteRuns: number;
					defectFix: { total: number; hits: number; missed: number; falseAlarms: number };
					clean: { total: number; clean: number; runsWithFalseAlarms: number; falseAlarms: number };
				};
			};
			expect(summary.corpus.manifestSha256).toBe(loaded.manifestSha256);
			expect(summary.totals).toEqual({
				cases: 2,
				completeRuns: 2,
				incompleteRuns: 0,
				defectFix: { total: 1, hits: 1, missed: 0, falseAlarms: 1 },
				clean: { total: 1, clean: 1, runsWithFalseAlarms: 0, falseAlarms: 0 },
			});
			expect(fs.existsSync(path.join(written.directory, "config.json"))).toBe(true);
		} finally {
			for (const repo of repos.values()) repo.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

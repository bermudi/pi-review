// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Eval runner: full engine reviews of temporary git repositories with an
// injected scripted model transport. Zero paid/network calls — every model
// interaction is observable through the injected pool, and the transport
// factory is the engine's only model surface during these runs.

import { describe, expect, test } from "bun:test";

import {
	EvalContractError,
	buildCorpusManifest,
	cannedReviewResponder,
	createScriptedModelPool,
	runCase,
	type CorpusCase,
	type CorpusCaseInput,
} from "../../eval/harness/index.js";
import { createTempRepo, type TempRepo } from "./support/temp-repo.js";

const MODEL = { provider: "scripted", model: "eval-model" } as const;

const BASE_FILE = `export function parsePort(text: string): number {
  return parseInt(text);
}
`;

const HEAD_FILE = `export function parsePort(text: string): number {
  return parseInt(text, 0);
}
`;

function caseInput(repo: TempRepo, overrides: Partial<CorpusCaseInput> = {}): CorpusCaseInput {
	return {
		id: "case-fix",
		repo: { url: "https://github.com/example/defect-repo" },
		baseCommit: repo.baseCommit,
		headCommit: repo.headCommit,
		expectation: {
			kind: "defect-fix",
			defect: { reference: "issue #7: parseInt without radix" },
		},
		language: "typescript",
		...overrides,
	};
}

async function runSimpleCase(caseDef: CorpusCase, repo: TempRepo, responder: Parameters<typeof cannedReviewResponder>[0]) {
	const pool = createScriptedModelPool({ identity: MODEL, respond: cannedReviewResponder(responder) });
	const record = await runCase({
		caseDef,
		workspace: { root: repo.root },
		model: MODEL,
		createTransport: pool.factory,
		concurrency: 1,
	});
	return { record, pool };
}

describe("eval runner", () => {
	test("defect-fix case: full engine review with injected scripted model", async () => {
		const repo = createTempRepo({ baseFiles: { "src/radix.ts": BASE_FILE }, headFiles: { "src/radix.ts": HEAD_FILE } });
		try {
			const caseDef = buildCorpusManifest({ name: "runner-suite", cases: [caseInput(repo)] }).cases[0]!;
			const { record, pool } = await runSimpleCase(caseDef, repo, {
				findingsForFile: (filePath) =>
					filePath === "src/radix.ts"
						? [
								{
									content: "parseInt called without an explicit radix; on legacy runtimes leading zeros parse as octal",
									existingCode: "return parseInt(text, 0);",
									category: "bug",
									severity: "high",
								},
							]
						: [],
			});

			// The engine reviewed the pinned range and surfaced the scripted finding.
			expect(record.status).toBe("complete");
			expect(record.caseId).toBe("case-fix");
			expect(record.expectationKind).toBe("defect-fix");
			expect(record.target).toEqual({ mode: "range", baseCommit: repo.baseCommit, headCommit: repo.headCommit });
			expect(record.model).toEqual(MODEL);
			expect(record.findings).toHaveLength(1);
			const finding = record.findings[0]!;
			expect(finding.path).toBe("src/radix.ts");
			expect(finding.startLine).toBeGreaterThan(0);
			expect(finding.category).toBe("bug");
			expect(finding.severity).toBe("high");
			expect(finding.existingCode).toBe("return parseInt(text, 0);");

			// Coverage and session evidence are real engine output.
			expect(record.coverage.completed).toContain("src/radix.ts");
			expect(record.coverage.selected).toContain("src/radix.ts");
			expect(record.sessionId).toBeTruthy();
			expect(record.usage.totalTokens).toBeGreaterThan(0);
			expect(record.warnings).toEqual([]);

			// Model traffic flowed only through the injected pool: main rounds
			// (comment + done) plus the terminal review filter.
			expect(record.modelRequests).toBeGreaterThanOrEqual(3);
			expect(record.transports).toBe(1);
			expect(pool.stats()).toEqual({ created: 1, disposed: 1, requests: record.modelRequests });
			for (const request of pool.requests()) {
				const meta = request.requestMeta;
				expect(meta).toBeDefined();
				expect(["plan_task", "main_task", "review_filter_task", "memory_compression_task"]).toContain(
					meta!.taskType,
				);
			}
		} finally {
			repo.dispose();
		}
	});

	test("clean case: task_done immediately, no findings", async () => {
		// A code-file change that introduces no defect (default rules exclude
		// docs, so a .md-only change would select zero files and be "skipped").
		const repo = createTempRepo({
			baseFiles: { "src/notes.ts": "export const guide = 'one';\n" },
			headFiles: { "src/notes.ts": "export const guide = 'one'; // clarified\n" },
		});
		try {
			const caseDef = buildCorpusManifest({
				name: "runner-suite",
				cases: [caseInput(repo, { id: "case-clean", expectation: { kind: "clean" } })],
			}).cases[0]!;
			const { record } = await runSimpleCase(caseDef, repo, {});
			expect(record.status).toBe("complete");
			expect(record.findings).toHaveLength(0);
			expect(record.modelRequests).toBeGreaterThanOrEqual(1);
		} finally {
			repo.dispose();
		}
	});

	test("two changed files use isolated transports", async () => {
		const repo = createTempRepo({
			baseFiles: {
				"src/a.ts": "export const a = 1;\n",
				"src/b.ts": "export const b = 2;\n",
			},
			headFiles: {
				"src/a.ts": "export const a = 11;\n",
				"src/b.ts": "export const b = 22;\n",
			},
		});
		try {
			const caseDef = buildCorpusManifest({ name: "runner-suite", cases: [caseInput(repo)] }).cases[0]!;
			const { record, pool } = await runSimpleCase(caseDef, repo, {
				findingsForFile: (filePath) => [
					{
						content: `finding in ${filePath}`,
						existingCode: filePath === "src/a.ts" ? "export const a = 11;" : "export const b = 22;",
						category: "bug",
						severity: "low",
					},
				],
			});
			expect(record.status).toBe("complete");
			expect(record.findings.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
			// One transport per file affinity; each disposed exactly once.
			expect(record.transports).toBe(2);
			expect(pool.stats().created).toBe(2);
			expect(pool.stats().disposed).toBe(2);
		} finally {
			repo.dispose();
		}
	});

	test("terminal filter can remove a finding", async () => {
		const repo = createTempRepo({ baseFiles: { "src/radix.ts": BASE_FILE }, headFiles: { "src/radix.ts": HEAD_FILE } });
		try {
			const caseDef = buildCorpusManifest({ name: "runner-suite", cases: [caseInput(repo)] }).cases[0]!;
			const { record, pool } = await runSimpleCase(caseDef, repo, {
				findingsForFile: () => [
					{
						content: "speculative finding the filter proves wrong",
						existingCode: "return parseInt(text, 0);",
						category: "bug",
						severity: "medium",
					},
				],
				filterRemovalsForFile: () => ["c-0"],
			});
			expect(record.status).toBe("complete");
			expect(record.findings).toHaveLength(0);
			// The terminal filter stage ran even though nothing survived it.
			expect(pool.requests().some((r) => r.requestMeta?.taskType === "review_filter_task")).toBe(true);
		} finally {
			repo.dispose();
		}
	});

	test("pinned model identity is enforced on every created transport", async () => {
		const repo = createTempRepo({ baseFiles: { "src/radix.ts": BASE_FILE }, headFiles: { "src/radix.ts": HEAD_FILE } });
		try {
			const caseDef = buildCorpusManifest({ name: "runner-suite", cases: [caseInput(repo)] }).cases[0]!;
			const pool = createScriptedModelPool({
				identity: { provider: "scripted", model: "other-model" },
				respond: cannedReviewResponder({}),
			});
			await expect(
				runCase({
					caseDef,
					workspace: { root: repo.root },
					model: MODEL,
					createTransport: pool.factory,
					concurrency: 1,
				}),
			).rejects.toThrow(EvalContractError);
		} finally {
			repo.dispose();
		}
	});

	test("unresolvable head commit yields a failed record, not a throw", async () => {
		const repo = createTempRepo({
			baseFiles: { "src/radix.ts": BASE_FILE },
			headFiles: { "src/radix.ts": HEAD_FILE },
		});
		try {
			const caseDef = buildCorpusManifest({
				name: "runner-suite",
				cases: [caseInput(repo, { headCommit: "f".repeat(40) })],
			}).cases[0]!;
			const pool = createScriptedModelPool({ identity: MODEL, respond: cannedReviewResponder({}) });
			const record = await runCase({
				caseDef,
				workspace: { root: repo.root },
				model: MODEL,
				createTransport: pool.factory,
				concurrency: 1,
			});
			expect(record.status).toBe("failed");
			expect(record.findings).toHaveLength(0);
			expect(record.sessionId).toBeNull();
			expect(record.message).not.toBe("");
		} finally {
			repo.dispose();
		}
	});
});

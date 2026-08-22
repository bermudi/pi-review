// SPDX-License-Identifier: Apache-2.0
// Parity-engine library facade for the public review API.
//
// This exposes the domain-level review seam routed through the OCR v1.9.3
// parity engine. The legacy engine has been removed; this is the sole
// library API.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	EMPTY_USAGE,
	type ExcludedFile,
	type FailedFile,
	type Finding,
	type FindingCategory,
	type FindingSeverity,
	type ReviewCoverage,
	type ReviewInput,
	type ReviewOptions,
	type ReviewResult,
	type ReviewStatus,
	type ReviewUsage,
	type SkippedFile,
} from "../types.js";

import { createReviewRunnerFactory } from "./cli/factory.js";
import type { ReviewRunner } from "./cli/review.js";
import { manifestMessage } from "./cli/output.js";
import type { ReviewOptions as OcrReviewOptions } from "./cli/shared.js";
import type { LlmComment } from "./model/review.js";
import type { CoverageItem, RunManifest } from "./session/manifest.js";

const VALID_CATEGORIES = new Set<FindingCategory>([
	"bug",
	"security",
	"performance",
	"maintainability",
	"test",
	"style",
	"documentation",
	"other",
]);

const VALID_SEVERITIES = new Set<FindingSeverity>([
	"critical",
	"high",
	"medium",
	"low",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCategory(value: unknown): FindingCategory {
	if (typeof value === "string" && VALID_CATEGORIES.has(value as FindingCategory)) {
		return value as FindingCategory;
	}
	return "other";
}

function normalizeSeverity(value: unknown): FindingSeverity {
	if (typeof value === "string" && VALID_SEVERITIES.has(value as FindingSeverity)) {
		return value as FindingSeverity;
	}
	return "low";
}

function modelSpecWithThinking(model: string, thinking: ReviewOptions["thinking"]): string {
	if (thinking === undefined) return model;

	const slash = model.indexOf("/");
	const colon = model.lastIndexOf(":");
	const suffix = colon > slash ? model.slice(colon + 1) : undefined;
	const levels = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	const base =
		suffix !== undefined && levels.has(suffix)
			? model.slice(0, colon)
			: model;
	return `${base}:${thinking}`;
}

function buildOcrReviewOptions(
	input: ReviewInput,
	options: ReviewOptions,
	rulePath: string,
): OcrReviewOptions {
	const mode = input.mode;
	const from = mode.kind === "range" ? mode.base : "";
	const to = mode.kind === "range" ? mode.head : "";
	const commit = mode.kind === "commit" ? mode.ref : "";

	return {
		toolConfigPath: "",
		rulePath,
		repoDir: input.repository,
		from,
		to,
		commit,
		resume: options.resumeSessionFile ?? "",
		excludes: (options.exclude ?? []).join(","),
		outputFormat: "json",
		color: "never",
		audience: "human",
		background: input.background ?? "",
		backgroundFile: "",
		provider: "",
		model: modelSpecWithThinking(options.model, options.thinking),
		concurrency: options.concurrency ?? 8,
		perFileTimeout: 10,
		maxTools: options.maxToolRounds ?? 0,
		maxGitProcs: 16,
		maxTokens: 0,
		maxTokensBudget: 0,
		noFilter: false,
		preview: false,
	};
}

function llmCommentToFinding(c: LlmComment): Finding {
	return {
		path: c.path,
		content: c.content,
		suggestionCode: c.suggestionCode,
		existingCode: c.existingCode ?? "",
		startLine: c.startLine ?? 0,
		endLine: c.endLine ?? 0,
		category: normalizeCategory(c.category),
		severity: normalizeSeverity(c.severity),
	};
}

function coverageItemPath(c: CoverageItem): string {
	return c.path;
}

function buildCoverage(manifest: RunManifest | null | undefined): ReviewCoverage {
	const selected: string[] = [];
	const completed: string[] = [];
	const failed: FailedFile[] = [];
	const skipped: SkippedFile[] = [];
	const excluded: ExcludedFile[] = [];

	if (manifest !== null && manifest !== undefined) {
		for (const c of manifest.coverage.selected) selected.push(coverageItemPath(c));
		for (const c of manifest.coverage.completed) completed.push(coverageItemPath(c));
		for (const c of manifest.coverage.reused) completed.push(coverageItemPath(c));
		for (const c of manifest.coverage.failed) {
			failed.push({ path: coverageItemPath(c), reason: c.reason ?? "failed" });
		}
		for (const c of manifest.coverage.waived) {
			excluded.push({ path: coverageItemPath(c), reason: c.reason ?? "waived" });
		}
	}

	return { selected, completed, failed, skipped, excluded };
}

function defaultMessage(status: ReviewStatus, findings: number, coverage: ReviewCoverage): string {
	switch (status) {
		case "complete": {
			const excluded = coverage.excluded.length > 0 ? ` ${coverage.excluded.length} file(s) were excluded before review.` : "";
			return findings === 0
				? `Review complete: no findings across ${coverage.completed.length} file(s).${excluded}`
				: `Review complete: ${findings} finding(s) across ${coverage.completed.length} file(s).${excluded}`;
		}
		case "partial":
			return `Review partial: ${coverage.completed.length} of ${coverage.selected.length} file(s) completed; findings are incomplete.`;
		case "failed":
			return `Review failed: ${coverage.completed.length} of ${coverage.selected.length} file(s) completed.`;
		case "skipped":
			return "Review skipped: no reviewable files were selected.";
		default:
			return "Review finished.";
	}
}

function buildReviewResult(
	runner: ReviewRunner,
	comments: readonly LlmComment[],
	model: string,
	startedAt: number,
): ReviewResult {
	const manifest = runner.manifest ?? null;
	const status: ReviewStatus = manifest?.terminalState ?? (comments.length > 0 ? "complete" : "skipped");
	const findings = comments.map(llmCommentToFinding);
	const coverage = buildCoverage(manifest);
	const message = manifest
		? manifestMessage(manifest, findings.length)
		: defaultMessage(status, findings.length, coverage);

	const usage: ReviewUsage = {
		inputTokens: runner.inputTokens,
		outputTokens: runner.outputTokens,
		cacheReadTokens: runner.cacheReadTokens,
		cacheWriteTokens: runner.cacheWriteTokens,
		totalTokens: runner.totalTokens,
	};

	const warnings = runner.warnings.map((w) => (w.file ? `[${w.type}] ${w.file}: ${w.message}` : `[${w.type}]: ${w.message}`));

	return {
		status,
		message,
		model,
		findings,
		coverage,
		warnings,
		usage,
		elapsedMs: Math.max(0, Date.now() - startedAt),
	};
}

function makeFailedResult(model: string, message: string, startedAt: number): ReviewResult {
	return {
		status: "failed",
		message,
		model,
		findings: [],
		coverage: { selected: [], completed: [], failed: [], skipped: [], excluded: [] },
		warnings: [message],
		usage: { ...EMPTY_USAGE },
		elapsedMs: Math.max(0, Date.now() - startedAt),
	};
}

async function runParityReview(input: ReviewInput, options: ReviewOptions): Promise<ReviewResult> {
	const startedAt = Date.now();

	const env = process.env as Record<string, string | undefined>;
	const originalAgentDir = env.PI_CODING_AGENT_DIR;
	if (options.agentDir !== undefined && options.agentDir !== "") {
		env.PI_CODING_AGENT_DIR = options.agentDir;
	}

	let ruleDir = "";
	let rulePath = "";

	try {
		if (input.rules !== undefined && input.rules.trim() !== "") {
			ruleDir = await mkdtemp(join(tmpdir(), "pi-reviewer-rules-"));
			rulePath = join(ruleDir, "rules.md");
			await writeFile(rulePath, input.rules, "utf-8");
		}

		const ocrOpts = buildOcrReviewOptions(input, options, rulePath);
		const factory = createReviewRunnerFactory(ocrOpts, process.cwd());
		const runner = await factory(options.signal);
		const comments = await runner.run(options.signal);

		return buildReviewResult(runner, comments, options.model, startedAt);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return makeFailedResult(options.model, message, startedAt);
	} finally {
		if (options.agentDir !== undefined && options.agentDir !== "") {
			if (originalAgentDir === undefined) {
				delete env.PI_CODING_AGENT_DIR;
			} else {
				env.PI_CODING_AGENT_DIR = originalAgentDir;
			}
		}
		if (ruleDir !== "") {
			await rm(ruleDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

/**
 * Domain-level review orchestration backed by the OCR v1.9.3 parity engine.
 */
export class Reviewer {
		// Accepts an optional dependencies argument for API symmetry;
	// the parity engine does not use a legacy dependency seam.
	constructor(_dependencies?: unknown) {}

	async review(input: ReviewInput, options: ReviewOptions): Promise<ReviewResult> {
		return runParityReview(input, options);
	}
}

/** Explicit factory for hosts that want to retain a configured seam. */
export function createReviewer(_dependencies?: unknown): Reviewer {
	return new Reviewer();
}

/** Run one review with production defaults, without requiring a Reviewer object. */
export function review(input: ReviewInput, options: ReviewOptions): Promise<ReviewResult> {
	return runParityReview(input, options);
}

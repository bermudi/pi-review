// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors

/**
 * Corpus manifest schema, loader, and content-hash pinning (evolution Phase 0
 * item 2; ground-truth design per docs/evolution/decisions.md D2).
 *
 * A corpus case pins one maintainer-fix review target: a repository URL, the
 * base and head commit (full object names), and an expectation — either
 * `defect-fix` (head fixes a referenced defect) or `clean` (head introduces
 * no defect; measures false-alarm rate). Planted-bug suites reuse the same
 * shape with synthetic repos.
 *
 * Every case carries a `contentSha256` over its semantic content (canonical
 * JSON of everything except the hash itself), and the loader recomputes it,
 * so a committed manifest cannot drift unnoticed. The manifest-level
 * `manifestSha256(manifest)` is what a run config pins to stay reproducible
 * and comparable.
 *
 * Parsing uses TypeBox schemas against `unknown` — file bytes are untrusted
 * input, narrowed at this seam only.
 */

import { readFile } from "node:fs/promises";

import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import { canonicalJson, sha256Hex } from "./canonical.js";
import { EvalContractError } from "./errors.js";

export const CORPUS_MANIFEST_SCHEMA_VERSION = "pi-review.eval-corpus/v1";

/** Safe directory/identifier charset for case ids. */
const ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,127}$";
/** Full git object names only — abbreviated SHAs would not pin content. */
const COMMIT_PATTERN = "^([0-9a-f]{40}|[0-9a-f]{64})$";

export const DefectReferenceSchema = Type.Object({
	/** What the fix commit addressed, e.g. an upstream issue reference. */
	reference: Type.String({ minLength: 1, maxLength: 2048 }),
	/** Repository-relative paths the defect is known to involve (advisory). */
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 })),
	/** Human-readable summary of the defect for blind judges. */
	summary: Type.Optional(Type.String({ maxLength: 8192 })),
});

export const ExpectationSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("defect-fix"),
		defect: DefectReferenceSchema,
	}),
	Type.Object({
		kind: Type.Literal("clean"),
	}),
]);

export const CorpusCaseSchema = Type.Object({
	id: Type.String({ pattern: ID_PATTERN }),
	repo: Type.Object({
		url: Type.String({
			minLength: 1,
			maxLength: 512,
			pattern: "^(https?|git|ssh)://|^git@",
		}),
	}),
	baseCommit: Type.String({ pattern: COMMIT_PATTERN }),
	headCommit: Type.String({ pattern: COMMIT_PATTERN }),
	expectation: ExpectationSchema,
	language: Type.String({ pattern: "^[a-z0-9+#-]{1,32}$" }),
	notes: Type.Optional(Type.String({ maxLength: 8192 })),
	contentSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
});

export const CorpusManifestSchema = Type.Object({
	schemaVersion: Type.Literal(CORPUS_MANIFEST_SCHEMA_VERSION),
	name: Type.String({ pattern: ID_PATTERN }),
	cases: Type.Array(CorpusCaseSchema, { minItems: 1, maxItems: 1000 }),
});

export type DefectReference = Static<typeof DefectReferenceSchema>;
export type CorpusExpectation = Static<typeof ExpectationSchema>;
export type CorpusCase = Static<typeof CorpusCaseSchema>;
export type CorpusManifest = Static<typeof CorpusManifestSchema>;

/** A case as authored, before its content hash is computed. */
export type CorpusCaseInput = Omit<CorpusCase, "contentSha256">;

function contractIssues(schema: TSchema, value: unknown): string[] {
	const issues: string[] = [];
	for (const error of Errors(schema, value)) {
		issues.push(`${error.instancePath || "/"}: ${error.message}`);
	}
	return issues;
}

function parseWith<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	if (!Check(schema, value)) {
		throw new EvalContractError(`${what} does not match the corpus contract`, contractIssues(schema, value));
	}
	return value as Static<T>;
}

/** Canonical content of a case — everything except the pinning hash itself. */
function caseContent(caseDef: CorpusCaseInput): {
	id: string;
	repo: { url: string };
	baseCommit: string;
	headCommit: string;
	expectation: CorpusExpectation;
	language: string;
	notes?: string;
} {
	return {
		id: caseDef.id,
		repo: { url: caseDef.repo.url },
		baseCommit: caseDef.baseCommit,
		headCommit: caseDef.headCommit,
		expectation: caseDef.expectation,
		language: caseDef.language,
		...(caseDef.notes === undefined ? {} : { notes: caseDef.notes }),
	};
}

/** Content hash pinning one case's semantic content. */
export function corpusCaseContentSha256(caseDef: CorpusCaseInput): string {
	return sha256Hex(canonicalJson(caseContent(caseDef)));
}

/** Aggregate hash pinning a whole manifest (cases including their hashes). */
export function manifestSha256(manifest: CorpusManifest): string {
	return sha256Hex(canonicalJson(manifest));
}

/**
 * Author a manifest from hash-less case inputs, computing each case's
 * content hash. Validates the result through the same contract as parsing,
 * so built manifests are always loadable.
 */
export function buildCorpusManifest(input: {
	readonly name: string;
	readonly cases: ReadonlyArray<CorpusCaseInput>;
}): CorpusManifest {
	return parseCorpusManifest({
		schemaVersion: CORPUS_MANIFEST_SCHEMA_VERSION,
		name: input.name,
		cases: input.cases.map((caseDef) => ({ ...caseContent(caseDef), contentSha256: corpusCaseContentSha256(caseDef) })),
	});
}

/**
 * Narrow untrusted input (e.g. parsed manifest JSON) to a validated
 * {@link CorpusManifest}. Verifies every case's pinned content hash and
 * rejects duplicate case ids.
 */
export function parseCorpusManifest(value: unknown): CorpusManifest {
	const manifest = parseWith(CorpusManifestSchema, value, "corpus manifest");

	const hashIssues: string[] = [];
	const seenIds = new Set<string>();
	for (const caseDef of manifest.cases) {
		if (seenIds.has(caseDef.id)) {
			hashIssues.push(`/${caseDef.id}: duplicate case id`);
			continue;
		}
		seenIds.add(caseDef.id);
		const { contentSha256, ...content } = caseDef;
		const recomputed = sha256Hex(canonicalJson(content));
		if (recomputed !== contentSha256) {
			hashIssues.push(
				`/${caseDef.id}: pinned contentSha256 ${contentSha256} does not match case content (${recomputed})`,
			);
		}
	}
	if (hashIssues.length > 0) {
		throw new EvalContractError("corpus manifest fails content-hash pinning", hashIssues);
	}
	return manifest;
}

/** Load and validate a manifest file. Returns the manifest plus its pinning hash. */
export async function loadCorpusManifest(path: string): Promise<{
	readonly manifest: CorpusManifest;
	readonly manifestSha256: string;
}> {
	const { readFile } = await import("node:fs/promises");
	const raw = await readFile(path, "utf8").catch((error: Error) => {
		throw new EvalContractError(`corpus manifest ${path} could not be read: ${error.message}`);
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new EvalContractError(`corpus manifest ${path} is not valid JSON: ${(error as Error).message}`);
	}
	const manifest = parseCorpusManifest(parsed);
	return { manifest, manifestSha256: manifestSha256(manifest) };
}

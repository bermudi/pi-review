// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors
//
// Corpus manifest contract: schema validation, content-hash pinning, and
// deterministic hashing. No network, no cloning.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	EvalContractError,
	buildCorpusManifest,
	corpusCaseContentSha256,
	loadCorpusManifest,
	manifestSha256,
	parseCorpusManifest,
	type CorpusCaseInput,
} from "../../eval/harness/index.js";

function caseInput(overrides: Partial<CorpusCaseInput> = {}): CorpusCaseInput {
	return {
		id: "case-alpha",
		repo: { url: "https://github.com/example/repo" },
		baseCommit: "a".repeat(40),
		headCommit: "b".repeat(40),
		expectation: {
			kind: "defect-fix",
			defect: { reference: "issue #12: parser accepts malformed input" },
		},
		language: "go",
		...overrides,
	};
}

describe("corpus manifest", () => {
	test("build produces a loadable manifest with pinned content hashes", () => {
		const manifest = buildCorpusManifest({ name: "unit-suite", cases: [caseInput(), caseInput({ id: "case-clean", expectation: { kind: "clean" } })] });
		expect(manifest.schemaVersion).toBe("pi-review.eval-corpus/v1");
		expect(manifest.cases).toHaveLength(2);
		for (const caseDef of manifest.cases) {
			expect(caseDef.contentSha256).toMatch(/^[0-9a-f]{64}$/);
		}
		// Round-trips through parse without complaint.
		expect(parseCorpusManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
	});

	test("content hash is stable and content-sensitive", () => {
		const base = caseInput();
		const hash = corpusCaseContentSha256(base);
		expect(hash).toBe(corpusCaseContentSha256(caseInput()));
		// Key order does not matter (canonical JSON).
		const reordered = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
		const flipped = Object.fromEntries(Object.entries(reordered).reverse());
		expect(corpusCaseContentSha256(flipped as unknown as CorpusCaseInput)).toBe(hash);
		// Content drift changes the hash.
		expect(corpusCaseContentSha256(caseInput({ headCommit: "c".repeat(40) }))).not.toBe(hash);
		// The hash itself is not part of the hashed content.
		const pinned = { ...base, contentSha256: hash };
		expect(pinned.contentSha256).toBe(corpusCaseContentSha256(base));
	});

	test("manifest hash pins the full manifest and is deterministic", () => {
		const first = buildCorpusManifest({ name: "unit-suite", cases: [caseInput()] });
		const second = buildCorpusManifest({ name: "unit-suite", cases: [caseInput()] });
		expect(manifestSha256(first)).toBe(manifestSha256(second));
		const tampered = { ...first, cases: [{ ...first.cases[0]!, baseCommit: "d".repeat(40) }] };
		expect(manifestSha256(tampered as typeof first)).not.toBe(manifestSha256(first));
	});

	test("parse rejects tampered content hashes", () => {
		const manifest = buildCorpusManifest({ name: "unit-suite", cases: [caseInput()] });
		const tampered = structuredClone(manifest);
		tampered.cases[0]!.headCommit = "e".repeat(40);
		expect(() => parseCorpusManifest(tampered)).toThrow(EvalContractError);
		try {
			parseCorpusManifest(tampered);
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("case-alpha");
			expect(message).toContain("contentSha256");
		}
	});

	test("parse rejects schema violations with issue paths", () => {
		const badInputs: Array<[string, () => unknown]> = [
			["missing field", () => ({ schemaVersion: "pi-review.eval-corpus/v1", name: "s", cases: [] })],
			["wrong schema version", () => ({ schemaVersion: "other/v9", name: "s", cases: [] })],
			["abbreviated commit", () => buildCorpusManifest({ name: "s", cases: [caseInput({ baseCommit: "abc123" })] })],
			["uppercase commit", () => buildCorpusManifest({ name: "s", cases: [caseInput({ headCommit: "F".repeat(40) })] })],
			["unsafe id", () => buildCorpusManifest({ name: "s", cases: [caseInput({ id: "../escape" })] })],
			["bad expectation kind", () => buildCorpusManifest({ name: "s", cases: [caseInput({ expectation: { kind: "vibes" } as never })] })],
			["defect-fix without defect", () => buildCorpusManifest({ name: "s", cases: [caseInput({ expectation: { kind: "defect-fix" } as never })] })],
			["empty defect reference", () => buildCorpusManifest({ name: "s", cases: [caseInput({ expectation: { kind: "defect-fix", defect: { reference: "" } } })] })],
			["repo url without scheme", () => buildCorpusManifest({ name: "s", cases: [caseInput({ repo: { url: "example/repo" } })] })],
			["uppercase language", () => buildCorpusManifest({ name: "s", cases: [caseInput({ language: "Go" })] })],
		];
		for (const [label, make] of badInputs) {
			expect(() => parseCorpusManifest(make()), label).toThrow(EvalContractError);
		}
		try {
			parseCorpusManifest(buildCorpusManifest({ name: "s", cases: [caseInput({ baseCommit: "abc123" })] }));
		} catch (error) {
			expect((error as EvalContractError).issues.join("\n")).toContain("/baseCommit");
		}
	});

	test("parse rejects duplicate case ids", () => {
		const manifest = buildCorpusManifest({ name: "s", cases: [caseInput()] });
		const duplicated = { ...manifest, cases: [manifest.cases[0]!, { ...manifest.cases[0]!, headCommit: "f".repeat(40) }] };
		expect(() => parseCorpusManifest(duplicated)).toThrow(/duplicate case id/);
	});

	test("loadCorpusManifest reads a file and returns the pinning hash", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-corpus-"));
		try {
			const manifest = buildCorpusManifest({ name: "file-suite", cases: [caseInput()] });
			const file = path.join(dir, "manifest.json");
			fs.writeFileSync(file, JSON.stringify(manifest, null, 2), "utf8");
			const loaded = await loadCorpusManifest(file);
			expect(loaded.manifest).toEqual(manifest);
			expect(loaded.manifestSha256).toBe(manifestSha256(manifest));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("loadCorpusManifest reports unreadable and invalid JSON files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-corpus-"));
		try {
			await expect(loadCorpusManifest(path.join(dir, "missing.json"))).rejects.toThrow(/could not be read/);
			const file = path.join(dir, "broken.json");
			fs.writeFileSync(file, "{not json", "utf8");
			await expect(loadCorpusManifest(file)).rejects.toThrow(/not valid JSON/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

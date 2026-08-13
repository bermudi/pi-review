import { describe, expect, test } from "bun:test";

import {
	exitCodeForResult,
	formatProgress,
	HELP_TEXT,
	parseArgs,
	renderJson,
	renderText,
	runCli,
	type CliIoOverrides,
} from "../src/cli.ts";
import type {
	Finding,
	ReviewEvent,
	ReviewInput,
	ReviewOptions,
	ReviewResult,
} from "../src/types.ts";

const usage = {
	inputTokens: 1,
	outputTokens: 2,
	cacheReadTokens: 3,
	cacheWriteTokens: 4,
	totalTokens: 10,
};

function result(status: ReviewResult["status"]): ReviewResult {
	const finding: Finding = {
		content: "Validate the value before using it.",
		existingCode: "const value = input;",
		suggestionCode: "const value = validate(input);",
		category: "bug",
		severity: "high",
		path: "src/app.ts",
		startLine: 12,
		endLine: 13,
	};
	return {
		status,
		message: `Review ${status}`,
		model: "test/model",
		findings: status === "complete" ? [finding] : [],
		coverage: {
			selected: status === "skipped" ? [] : status === "failed" ? ["src/app.ts"] : ["src/app.ts", "src/other.ts"],
			completed: status === "complete" ? ["src/app.ts", "src/other.ts"] : status === "partial" ? ["src/app.ts"] : [],
			failed: status === "partial" ? [{ path: "src/other.ts", reason: "task failed" }] : [],
			skipped: status === "failed" ? [{ path: "src/app.ts", reason: "aborted" }] : [],
			excluded: status === "skipped" ? [{ path: "README.md", reason: "unsupported_ext" }] : [],
		},
		warnings: ["One planner warning."],
		usage,
		elapsedMs: 42,
	};
}

function captureIo(): {
	io: CliIoOverrides;
	stdout: () => string;
	stderr: () => string;
	signals: Map<string, () => void>;
} {
	let out = "";
	let err = "";
	const signals = new Map<string, () => void>();
	return {
		io: {
			cwd: () => "/fake/repository",
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
			onSignal: (signal, listener) => {
				signals.set(signal, listener);
			},
			offSignal: (signal) => {
				signals.delete(signal);
			},
		},
		stdout: () => out,
		stderr: () => err,
		signals,
	};
}

describe("CLI argument parsing", () => {
	test("parses the workspace defaults and all review options", () => {
		const options = parseArgs([
			"--model",
			"anthropic/claude-sonnet:high",
			"--thinking",
			"medium",
			"--repo",
			"/tmp/repo",
			"--include",
			"src/**",
			"--include=tests/**",
			"--exclude",
			"vendor/**",
			"--background",
			"Review API boundaries",
			"--concurrency",
			"3",
			"--max-tool-rounds",
			"8",
			"--plan-threshold",
			"50",
			"--agent-dir",
			".agents",
			"--session-dir",
			"/tmp/sessions",
			"--json",
		], "/default");

		expect(options).toEqual({
			help: false,
			repo: "/tmp/repo",
			model: "anthropic/claude-sonnet:high",
			thinking: "medium",
			mode: { kind: "workspace" },
			include: ["src/**", "tests/**"],
			exclude: ["vendor/**"],
			background: "Review API boundaries",
			backgroundFile: undefined,
			hostEvidence: undefined,
			hostEvidenceFile: undefined,
			rulesFile: undefined,
			concurrency: 3,
			maxToolRounds: 8,
			planThreshold: 50,
			agentDir: ".agents",
			sessionDir: "/tmp/sessions",
			resume: undefined,
			json: true,
		});
	});

	test("parses resume and rejects conflicting persistence or concurrency options", () => {
		const parsed = parseArgs(["--model", "p/m", "--resume", "/tmp/review.jsonl"]);
		expect(parsed.resume).toBe("/tmp/review.jsonl");
		expect(parseArgs(["--model", "p/m", "--resume", "a", "--concurrency", "01"]).concurrency).toBe(1);
		expect(() => parseArgs(["--model", "p/m", "--resume", "a", "--session-dir", "b"])).toThrow("mutually exclusive");
		expect(() => parseArgs(["--model", "p/m", "--resume", "a", "--concurrency", "2"])).toThrow("concurrency 1");
	});

	test("selects range and commit modes and rejects invalid combinations", () => {
		expect(parseArgs(["--model", "p/m", "--base", "main", "--head", "topic"]).mode).toEqual({
			kind: "range",
			base: "main",
			head: "topic",
		});
		expect(parseArgs(["--model", "p/m", "--commit", "HEAD~1"]).mode).toEqual({
			kind: "commit",
			ref: "HEAD~1",
		});
		expect(parseArgs(["--model", "p/m", "--base", "main"]).mode).toEqual({
			kind: "range",
			base: "main",
			head: "HEAD",
		});
		expect(() => parseArgs(["--model", "p/m", "--head", "topic"])).toThrow("--base is required");
		expect(() => parseArgs(["--model", "p/m", "--commit", "HEAD", "--base", "main", "--head", "topic"])).toThrow("--commit");
		expect(() => parseArgs(["--model", "p/m", "--background", "one", "--background-file", "two"])).toThrow("mutually exclusive");
	});

	test("validates the required model, thinking, and integer values", () => {
		expect(() => parseArgs([])).toThrow("required --model");
		expect(() => parseArgs(["--model", "bad model"])).toThrow("provider/model");
		expect(parseArgs(["--model", "not-a-model"]).model).toBe("not-a-model");
		expect(parseArgs(["--model", "openrouter/org/model:variant"]).model).toBe("openrouter/org/model:variant");
		expect(() => parseArgs(["--model", "p/m", "--thinking", "turbo"])).toThrow("--thinking");
		expect(() => parseArgs(["--model", "p/m", "--concurrency", "0"])).toThrow("--concurrency");
		expect(() => parseArgs(["--model", "p/m", "--max-tool-rounds", "0"])).toThrow("--max-tool-rounds");
		expect(() => parseArgs(["--model", "p/m", "--max-tool-rounds", "-1"])).toThrow("--max-tool-rounds");
		expect(() => parseArgs(["--model", "p/m", "--max-tool-rounds", "1.5"])).toThrow("--max-tool-rounds");
		expect(() => parseArgs(["--model", "p/m", "--max-tool-rounds", "9007199254740991"])).toThrow("9007199254740990");
		expect(parseArgs(["--model", "p/m", "--max-tool-rounds", "9007199254740990"]).maxToolRounds).toBe(Number.MAX_SAFE_INTEGER - 1);
		expect(() => parseArgs(["--model", "p/m", "--plan-threshold", "1.5"])).toThrow("--plan-threshold");
		expect(parseArgs(["--help"]).help).toBe(true);
	});

	test("falls back to PI_REVIEW_MODEL when --model is absent", () => {
		const options = parseArgs([], "/repo", { PI_REVIEW_MODEL: "provider/model" });
		expect(options.model).toBe("provider/model");
		expect(options.help).toBe(false);
	});

	test("--model wins over PI_REVIEW_MODEL", () => {
		const options = parseArgs(["--model", "explicit/m"], "/repo", { PI_REVIEW_MODEL: "env/m" });
		expect(options.model).toBe("explicit/m");
	});

	test("treats a blank PI_REVIEW_MODEL as unset", () => {
		expect(() => parseArgs([], "/repo", { PI_REVIEW_MODEL: "   " })).toThrow("required --model");
	});

	test("validates PI_REVIEW_MODEL like --model", () => {
		expect(() => parseArgs([], "/repo", { PI_REVIEW_MODEL: "bad model" })).toThrow("provider/model");
	});

	test("--help bypasses the model requirement even without PI_REVIEW_MODEL", () => {
		expect(parseArgs(["--help"], "/repo", {}).help).toBe(true);
	});

	test("accepts the -m shorthand and bare model names", () => {
		expect(parseArgs(["-m", "p/m"]).model).toBe("p/m");
		expect(parseArgs(["-m=p/m"]).model).toBe("p/m");
		expect(parseArgs(["-m", "gpt-5.6-luna:max"]).model).toBe("gpt-5.6-luna:max");
		expect(parseArgs(["--model", "gpt-5.6-luna:max"]).model).toBe("gpt-5.6-luna:max");
	});

	test("rejects duplicate model flags, malformed models, and unknown short flags", () => {
		expect(() => parseArgs(["-m", "p/m", "--model", "a/b"])).toThrow("Duplicate --model");
		expect(() => parseArgs(["-m", "p/m", "-m", "a/b"])).toThrow("Duplicate --model");
		expect(() => parseArgs(["-m", "bad model"])).toThrow("provider/model");
		expect(() => parseArgs(["-m="])).toThrow("non-empty");
		expect(() => parseArgs(["-mx"])).toThrow("--option form");
	});
});

describe("CLI rendering and exit codes", () => {
	test("renders anchored findings, coverage, and warnings without ANSI", () => {
		const text = renderText(result("complete"));
		expect(text).toContain("Status: complete");
		expect(text).toContain("Message: Review complete");
		expect(text).toContain("Coverage:");
		expect(text).toContain("excluded:");
		expect(text).toContain("skipped:");
		expect(text).toContain("Warnings:");
		expect(text).toContain("high/bug src/app.ts:12-13");
		expect(text).toContain("Validate the value before using it.");
		expect(text).not.toMatch(/\u001b/u);
	});

	test("JSON rendering is the exact ReviewResult object", () => {
		const expected = result("partial");
		expect(renderJson(expected)).toBe(`${JSON.stringify(expected)}\n`);
		expect(JSON.parse(renderJson(expected))).toEqual(expected);
	});

	test("documents the compatibility budget name and reserved recovery in help", () => {
		expect(HELP_TEXT).toContain("--max-tool-rounds N");
		expect(HELP_TEXT).toContain("recovery reserved");
	});

	test("maps result status to the documented exit code", () => {
		expect(exitCodeForResult(result("complete"))).toBe(0);
		expect(exitCodeForResult(result("skipped"))).toBe(0);
		expect(exitCodeForResult(result("partial"))).toBe(2);
		expect(exitCodeForResult(result("failed"))).toBe(1);
	});
});

describe("CLI execution seams", () => {
	test("reads UTF-8 files, passes options to Reviewer, and keeps progress on stderr", async () => {
		const captured = captureIo();
		const reads: Array<{ path: string; encoding: string }> = [];
		let receivedInput: ReviewInput | undefined;
		let receivedOptions: ReviewOptions | undefined;
		const events: ReviewEvent[] = [];
		const expected = result("complete");

		const exitCode = await runCli([
			"--model",
			"provider/model",
			"--repo",
			"repo",
			"--base",
			"base",
			"--head",
			"head",
			"--background-file",
			"background.md",
			"--rules-file",
			"rules.md",
			"--include",
			"src/**",
			"--exclude",
			"src/generated/**",
			"--concurrency",
			"2",
			"--max-tool-rounds",
			"4",
			"--plan-threshold",
			"10",
			"--agent-dir",
			"agents",
		], {
			io: captured.io,
			readFile: async (path, encoding) => {
				reads.push({ path, encoding });
				return path === "background.md" ? "background text" : "rules text";
			},
			reviewer: {
				review: async (input, options) => {
					receivedInput = input;
					receivedOptions = options;
					options.onEvent?.({ type: "review_started", files: 1 });
					options.onEvent?.({ type: "file_started", path: "src/app.ts" });
					options.onEvent?.({ type: "tool_started", path: "src/app.ts", tool: "file_read" });
					options.onEvent?.({ type: "file_completed", path: "src/app.ts", findings: 1 });
					options.onEvent?.({ type: "warning", message: "be careful" });
					events.push(
						{ type: "review_started", files: 1 },
						{ type: "file_started", path: "src/app.ts" },
					);
					return expected;
				},
			},
		});

		expect(exitCode).toBe(0);
		expect(reads).toEqual([
			{ path: "background.md", encoding: "utf8" },
			{ path: "rules.md", encoding: "utf8" },
		]);
		expect(receivedInput).toEqual({
			repository: "repo",
			mode: { kind: "range", base: "base", head: "head" },
			background: "background text",
			rules: "rules text",
		});
		expect(receivedOptions?.model).toBe("provider/model");
		expect(receivedOptions?.concurrency).toBe(2);
		expect(receivedOptions?.maxToolRounds).toBe(4);
		expect(receivedOptions?.planChangedLineThreshold).toBe(10);
		expect(receivedOptions?.include).toEqual(["src/**"]);
		expect(receivedOptions?.exclude).toEqual(["src/generated/**"]);
		expect(receivedOptions?.signal).toBeInstanceOf(AbortSignal);
		expect(captured.stdout()).toContain("Status: complete");
		expect(captured.stderr()).toContain("Review started: 1 file(s).");
		expect(captured.stderr()).toContain("Evidence: src/app.ts -> file_read.");
		expect(events).toHaveLength(2);
	});

	test("emits exact JSON to stdout and installs/removes termination handlers", async () => {
		const captured = captureIo();
		const expected = result("partial");
		let signalWasAborted = false;
		const exitCode = await runCli(["--model", "provider/model", "--json"], {
			io: captured.io,
			reviewer: {
				review: async (_input, options) => {
					captured.signals.get("SIGINT")?.();
					signalWasAborted = options.signal?.aborted === true;
					return expected;
				},
			},
		});

		expect(exitCode).toBe(2);
		expect(captured.stdout()).toBe(`${JSON.stringify(expected)}\n`);
		expect(JSON.parse(captured.stdout())).toEqual(expected);
		expect(signalWasAborted).toBe(true);
		expect(captured.signals.size).toBe(0);
		expect(captured.stderr()).toBe("");
	});

	test("uses PI_REVIEW_MODEL when --model is not passed", async () => {
		const captured = captureIo();
		let receivedOptions: ReviewOptions | undefined;
		const exitCode = await runCli(["--repo", "repo"], {
			io: { ...captured.io, env: () => ({ PI_REVIEW_MODEL: "env/provider/model" }) },
			reviewer: {
				review: async (_input, options) => {
					receivedOptions = options;
					return result("complete");
				},
			},
		});

		expect(exitCode).toBe(0);
		expect(receivedOptions?.model).toBe("env/provider/model");
		expect(captured.stdout()).toContain("Status: complete");
	});

	test("passes --host-evidence through to ReviewInput", async () => {
		const captured = captureIo();
		let receivedInput: ReviewInput | undefined;
		const exitCode = await runCli(["--model", "provider/model", "--host-evidence", "tsc output"], {
			io: captured.io,
			reviewer: {
				review: async (input) => {
					receivedInput = input;
					return result("complete");
				},
			},
		});

		expect(exitCode).toBe(0);
		expect(receivedInput?.hostEvidence).toBe("tsc output");
	});

	test("reads --host-evidence-file and passes it to ReviewInput", async () => {
		const captured = captureIo();
		let receivedInput: ReviewInput | undefined;
		const exitCode = await runCli(["--model", "provider/model", "--host-evidence-file", "evidence.txt"], {
			io: captured.io,
			readFile: async (path) => {
				if (path !== "evidence.txt") throw new Error("unexpected file");
				return "build output";
			},
			reviewer: {
				review: async (input) => {
					receivedInput = input;
					return result("complete");
				},
			},
		});

		expect(exitCode).toBe(0);
		expect(receivedInput?.hostEvidence).toBe("build output");
	});

	test("returns exit 1 when --host-evidence-file cannot be read", async () => {
		const captured = captureIo();
		const exitCode = await runCli(["--model", "provider/model", "--host-evidence-file", "missing.txt"], {
			io: captured.io,
			readFile: async () => {
				throw new Error("ENOENT");
			},
			reviewer: {
				review: async () => result("complete"),
			},
		});

		expect(exitCode).toBe(1);
		expect(captured.stderr()).toContain("Unable to read --host-evidence-file");
	});
});

test("formats every progress event as stderr-safe text", () => {
	expect(formatProgress({ type: "review_started", files: 2 })).toBe("Review started: 2 file(s).\n");
	expect(formatProgress({ type: "file_failed", path: "a.ts", reason: "nope" })).toBe("Failed a.ts: nope.\n");
	expect(formatProgress({ type: "file_failed", path: "a.ts", reason: "nope", sessionFile: "/tmp/s/rev.jsonl" })).toBe(
		"Failed a.ts: nope.\nSession: /tmp/s/rev.jsonl\n",
	);
	expect(formatProgress({ type: "warning", message: "multi\nline" })).toBe("Warning: multi line\n");
});

import { describe, expect, test } from "bun:test";

import type { PiTask, TaskOutcome } from "../src/pi-runner.ts";
import { Reviewer, type TaskExecutor } from "../src/reviewer.ts";
import type { ChangedFile, ReviewMode, ReviewTarget, ReviewUsage } from "../src/types.ts";

type Tool = {
	readonly name: string;
	readonly execute: (...args: readonly unknown[]) => Promise<unknown>;
};

const emptyUsage: ReviewUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

function usage(seed: number): ReviewUsage {
	return {
		inputTokens: seed,
		outputTokens: seed + 1,
		cacheReadTokens: seed + 2,
		cacheWriteTokens: seed + 3,
		totalTokens: seed + 6,
	};
}

function changedFile(path: string, lineCount = 1): ChangedFile {
	const lines = Array.from({ length: lineCount }, (_, index) => `const value${index + 1} = ${index + 1};`);
	return {
		oldPath: path,
		newPath: path,
		rawDiff: [
			`diff --git a/${path} b/${path}`,
			`--- a/${path}`,
			`+++ b/${path}`,
			`@@ -0,0 +1,${lines.length} @@`,
			...lines.map((line) => `+${line}`),
		].join("\n"),
		newContent: `${lines.join("\n")}\n`,
		isBinary: false,
		isDeleted: false,
		isNew: true,
		isRenamed: false,
		insertions: lines.length,
		deletions: 0,
		hunks: [
			{
				oldStart: 0,
				oldCount: 0,
				newStart: 1,
				newCount: lines.length,
				lines: lines.map((text, index) => ({ kind: "addition" as const, text, newLine: index + 1 })),
			},
		],
	};
}

/** A file whose added lines carry exported declarations, so the change map has facts. */
function exportedFile(path: string, lineCount = 1): ChangedFile {
	const lines = Array.from(
		{ length: lineCount },
		(_, index) => `export function fn${index + 1}() { return ${index + 1}; }`,
	);
	return {
		oldPath: path,
		newPath: path,
		rawDiff: [
			`diff --git a/${path} b/${path}`,
			`--- a/${path}`,
			`+++ b/${path}`,
			`@@ -0,0 +1,${lines.length} @@`,
			...lines.map((line) => `+${line}`),
		].join("\n"),
		newContent: `${lines.join("\n")}\n`,
		isBinary: false,
		isDeleted: false,
		isNew: true,
		isRenamed: false,
		insertions: lines.length,
		deletions: 0,
		hunks: [
			{
				oldStart: 0,
				oldCount: 0,
				newStart: 1,
				newCount: lines.length,
				lines: lines.map((text, index) => ({ kind: "addition" as const, text, newLine: index + 1 })),
			},
		],
	};
}

/** A file whose rawDiff exceeds the review byte limit but has few changed lines. */
function oversizedFile(path: string): ChangedFile {
	const padding = "x".repeat(100_000);
	const declarations = [
		"export function hugeFn1() { return 1; }",
		"export function hugeFn2() { return 2; }",
	];
	return {
		oldPath: path,
		newPath: path,
		rawDiff: [
			`diff --git a/${path} b/${path}`,
			`--- a/${path}`,
			`+++ b/${path}`,
			`@@ -0,0 +1,2 @@`,
			...declarations.map((line) => `+${line}`),
			` ${padding}`,
		].join("\n"),
		newContent: `${declarations.join("\n")}\n`,
		isBinary: false,
		isDeleted: false,
		isNew: true,
		isRenamed: false,
		insertions: declarations.length,
		deletions: 0,
		hunks: [
			{
				oldStart: 0,
				oldCount: 0,
				newStart: 1,
				newCount: declarations.length,
				lines: declarations.map((text, index) => ({ kind: "addition" as const, text, newLine: index + 1 })),
			},
		],
	};
}

function target(files: readonly ChangedFile[]): ReviewTarget {
	const mode: ReviewMode = { kind: "workspace" };
	const contents = new Map(files.map((file) => [file.newPath, file.newContent ?? ""]));
	return {
		repositoryRoot: "/fake/repository",
		mode,
		files: [...files],
		readFile: async (path) => contents.get(path) ?? "",
		listFiles: async () => [...contents.keys()].sort(),
	};
}

function tool(task: PiTask, name: string): Tool {
	const candidate = task.customTools?.find((entry) => {
		if (typeof entry !== "object" || entry === null) return false;
		return "name" in entry && entry.name === name;
	});
	if (typeof candidate !== "object" || candidate === null || !("execute" in candidate)) {
		throw new Error(`Task did not supply ${name}`);
	}
	const execute = candidate.execute;
	if (typeof execute !== "function") throw new Error(`Tool ${name} is not executable`);
	return {
		name,
		execute: execute as (...args: readonly unknown[]) => Promise<unknown>,
	};
}

async function invoke(task: PiTask, name: string, params: unknown): Promise<unknown> {
	return tool(task, name).execute("fake-call", params, task.signal, undefined, undefined);
}

function complete(phaseUsage: ReviewUsage, terminalTool?: string, sessionFile?: string): TaskOutcome {
	return {
		status: "complete",
		stopReason: terminalTool === undefined ? "stop" : "toolUse",
		text: "",
		usage: phaseUsage,
		toolResults: terminalTool === undefined
			? []
			: [{ toolName: terminalTool, details: {}, isError: false }],
		...(sessionFile === undefined ? {} : { sessionFile }),
	};
}

function failed(message: string, phaseUsage: ReviewUsage = emptyUsage, sessionFile?: string): TaskOutcome {
	return {
		status: "failed",
		stopReason: "error",
		error: message,
		text: "",
		usage: phaseUsage,
		toolResults: [],
		...(sessionFile === undefined ? {} : { sessionFile }),
	};
}

const validPlan = {
	change_summary: "Adds a large changed block.",
	issues: [
		{
			severity: "high" as const,
			description: "Confirm the new value is validated before use.",
			tool_guidance: [
				{
					name: "file_read" as const,
					reason: "Inspect the target validation path.",
					arguments: "path=src/large.ts, offset=1, limit=50",
				},
			],
		},
	],
};

class PhaseExecutor implements TaskExecutor {
	readonly tasks: PiTask[] = [];
	abortAllCalls = 0;
	readonly vetoed: readonly string[] | undefined;
	readonly failPlan: boolean;
	readonly failVeto: boolean;
	readonly noFindings: boolean;
	readonly unanchored: boolean;
	readonly missingDone: boolean;
	readonly invalidPlan: boolean;
	readonly sessionFile: string | undefined;

	constructor(options: {
		vetoed?: readonly string[];
		failPlan?: boolean;
		failVeto?: boolean;
		noFindings?: boolean;
		unanchored?: boolean;
		missingDone?: boolean;
		invalidPlan?: boolean;
		sessionFile?: string;
	} = {}) {
		this.vetoed = options.vetoed;
		this.failPlan = options.failPlan === true;
		this.failVeto = options.failVeto === true;
		this.noFindings = options.noFindings === true;
		this.unanchored = options.unanchored === true;
		this.missingDone = options.missingDone === true;
		this.invalidPlan = options.invalidPlan === true;
		this.sessionFile = options.sessionFile;
	}

	async run(task: PiTask): Promise<TaskOutcome> {
		this.tasks.push(task);
		const names = task.allowedTools ?? [];
		const name = names.includes("submit_plan")
			? "submit_plan"
			: names.includes("submit_veto")
				? "submit_veto"
				: names.includes("submit_review")
					? "submit_review"
					: names[0];
		if (name === undefined) return failed("no supplied tools");
		task.onEvent?.({ type: "tool_started", toolName: name });

		if (name === "submit_plan") {
			if (this.invalidPlan) {
				return { status: "invalid", stopReason: "error", error: "corrupt outcome", text: "", usage: usage(10), toolResults: [] } as unknown as TaskOutcome;
			}
			if (this.failPlan) return failed("planner unavailable", usage(10));
			await invoke(task, name, validPlan);
			return complete(usage(10), "submit_plan");
		}
		if (name === "submit_review") {
			if (this.missingDone) return complete(usage(20), undefined, this.sessionFile);
			const comments = this.noFindings
				? []
				: [
					{
						content: "The new value is not validated before use.",
						existingCode: "const value1 = 1;",
						category: "bug",
						severity: "high",
					},
					...(this.unanchored
						? [{
							content: "This snippet is not in the changed target.",
							existingCode: "not present();",
							category: "bug",
							severity: "medium",
						}]
						: [{
							content: "The second changed value is not validated before use.",
							existingCode: "const value2 = 2;",
							category: "security",
							severity: "medium",
						}]),
				];
			await invoke(task, name, { state: "DONE", comments });
			return complete(usage(20), "submit_review");
		}
		if (name === "submit_veto") {
			if (this.failVeto) return failed("filter unavailable", usage(30));
			await invoke(task, name, { candidate_ids: this.vetoed ?? [] });
			return complete(usage(30), "submit_veto");
		}
		return failed(`unexpected phase ${name}`);
	}

	async abortAll(): Promise<void> {
		this.abortAllCalls += 1;
	}
}

function options(overrides: Partial<Parameters<Reviewer["review"]>[1]> = {}) {
	return {
		model: "fake/model",
		...overrides,
	};
}

describe("Reviewer", () => {
	test("passes the resolved repository root to Pi task sessions", async () => {
		const executor = new PhaseExecutor({ noFindings: true });
		let runnerCwd: string | undefined;
		const result = await new Reviewer({
			targetFactory: async () => target([changedFile("src/current.ts")]),
			taskExecutorFactory: (runnerOptions) => {
				runnerCwd = runnerOptions.cwd;
				return executor;
			},
		}).review({ repository: "/requested/subdirectory", mode: { kind: "workspace" } }, options());

		expect(result.status).toBe("complete");
		expect(runnerCwd).toBe("/fake/repository");
	});

	test("runs plan, main, and veto phases through their supplied structured tools", async () => {
		const file = changedFile("src/large.ts", 50);
		const executor = new PhaseExecutor({ vetoed: ["c-1"] });
		const events: string[] = [];
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review(
			{
				repository: "/fake/repository",
				mode: { kind: "workspace" },
				background: "The value must be validated.",
				rules: "Report only actionable bugs.",
			},
			options({
				planChangedLineThreshold: 50,
				maxToolRounds: 8,
				onEvent: (event) => events.push(event.type),
			}),
		);

		expect(result.status).toBe("complete");
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]).toMatchObject({ path: "src/large.ts", startLine: 1 });
		expect(result.usage).toEqual({
			inputTokens: 60,
			outputTokens: 63,
			cacheReadTokens: 66,
			cacheWriteTokens: 69,
			totalTokens: 78,
		});
		expect(executor.tasks.map((task) => task.allowedTools)).toEqual([
			["submit_plan"],
			["file_read", "code_search", "file_find", "file_read_diff", "submit_review"],
			["submit_veto"],
		]);
		expect(executor.tasks.map((task) => task.maxToolStarts)).toEqual([3, 9, 3]);
		expect((executor.tasks[1]?.prompt as { user: string }).user).toContain("The value must be validated.");
		expect((executor.tasks[1]?.prompt as { user: string }).user).toContain("Adds a large changed block.");
		expect((executor.tasks[2]?.prompt as { user: string }).user).toContain('"id": "c-0"');
		expect(events).toEqual([
			"review_started",
			"file_started",
			"tool_started",
			"tool_started",
			"tool_started",
			"file_completed",
		]);
	});

	test("passes host evidence from ReviewInput into the review prompt", async () => {
		const executor = new PhaseExecutor({ noFindings: true });
		const evidence = "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
		await new Reviewer({
			targetFactory: async () => target([changedFile("src/current.ts")]),
			taskExecutor: executor,
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" }, hostEvidence: evidence },
			options(),
		);

		expect(executor.tasks).toHaveLength(1);
		const prompt = executor.tasks[0]?.prompt as { user: string } | undefined;
		expect(prompt?.user).toContain('<untrusted-data name="host-evidence">');
		expect(prompt?.user).toContain(evidence);
	});

	test("threads sessionDir and per-phase session ids through to tasks", async () => {
		const file = changedFile("src/large.ts", 50);
		const executor = new PhaseExecutor({ vetoed: ["c-1"] });
		let runnerSessionDir: string | undefined;
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutorFactory: (runnerOptions) => {
				runnerSessionDir = runnerOptions.sessionDir;
				return executor;
			},
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" } },
			options({ planChangedLineThreshold: 50, sessionDir: "/tmp/sessions" }),
		);

		expect(result.status).toBe("complete");
		expect(runnerSessionDir).toBe("/tmp/sessions");
		expect(executor.tasks.map((task) => task.sessionId)).toEqual([
			"review-src-large.ts-plan",
			"review-src-large.ts-review",
			"review-src-large.ts-veto",
		]);
	});

	test("surfaces the persisted session file on failed files", async () => {
		const executor = new PhaseExecutor({ missingDone: true, sessionFile: "/tmp/sessions/rev.jsonl" });
		const events: Array<{ type: string; sessionFile?: string }> = [];
		const result = await new Reviewer({
			targetFactory: async () => target([changedFile("src/current.ts")]),
			taskExecutor: executor,
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" } },
			options({
				onEvent: (event) => {
					events.push(event as { type: string; sessionFile?: string });
				},
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.coverage.failed).toHaveLength(1);
		expect(result.coverage.failed[0]?.sessionFile).toBe("/tmp/sessions/rev.jsonl");
		expect(result.coverage.failed[0]?.reason).toContain("submit_review DONE");
		const failedEvent = events.find((event) => event.type === "file_failed");
		expect(failedEvent?.sessionFile).toBe("/tmp/sessions/rev.jsonl");
	});

	test("fails soft when planning fails and still completes the main review", async () => {
		const file = changedFile("src/large.ts", 50);
		const executor = new PhaseExecutor({ failPlan: true, noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options());

		expect(result.status).toBe("complete");
		expect(result.findings).toEqual([]);
		expect(result.warnings.some((warning) => warning.includes("planner"))).toBe(true);
		expect(executor.tasks).toHaveLength(2);
	});

	test("counts planner usage when the plan phase returns a non-complete outcome", async () => {
		const file = changedFile("src/large.ts", 50);
		const executor = new PhaseExecutor({ failPlan: true, noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options());

		expect(result.usage).toEqual({
			inputTokens: 30,
			outputTokens: 32,
			cacheReadTokens: 34,
			cacheWriteTokens: 36,
			totalTokens: 42,
		});
	});

	test("counts planner usage when the plan phase returns an invalid outcome", async () => {
		const file = changedFile("src/large.ts", 50);
		const executor = new PhaseExecutor({ invalidPlan: true, noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options());

		expect(result.status).toBe("complete");
		expect(result.warnings.some((warning) => warning.includes("planner"))).toBe(true);
		expect(result.usage).toEqual({
			inputTokens: 30,
			outputTokens: 32,
			cacheReadTokens: 34,
			cacheWriteTokens: 36,
			totalTokens: 42,
		});
	});

	test("applies include/exclude selection and skips empty diffs before dispatch", async () => {
		const emptyDiff = { ...changedFile("src/empty.ts"), rawDiff: "" };
		const executor = new PhaseExecutor({ noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([
				changedFile("src/ok.ts"),
				emptyDiff,
				changedFile("README.md"),
				changedFile("src/excluded.ts"),
			]),
			taskExecutor: executor,
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" } },
			options({ exclude: ["src/excluded.ts"] }),
		);

		expect(result.status).toBe("complete");
		expect(result.coverage.selected).toEqual(["src/ok.ts"]);
		expect(result.coverage.skipped).toEqual([
			{ path: "README.md", reason: "unsupported_ext" },
			{ path: "src/empty.ts", reason: "empty_diff" },
			{ path: "src/excluded.ts", reason: "user_exclude" },
		]);
		expect(executor.tasks).toHaveLength(1);
	});

	test("suppresses unanchored candidates with a visible warning", async () => {
		const file = changedFile("src/current.ts");
		const executor = new PhaseExecutor({ unanchored: true });
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options());

		expect(result.status).toBe("complete");
		expect(result.findings).toHaveLength(1);
		expect(result.warnings.some((warning) => warning.includes("unanchored"))).toBe(true);
	});

	test("treats a successful task without explicit DONE as a file failure", async () => {
		const file = changedFile("src/current.ts");
		const executor = new PhaseExecutor({ missingDone: true });
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options());

		expect(result.status).toBe("failed");
		expect(result.findings).toEqual([]);
		expect(result.coverage.failed[0]?.reason).toContain("DONE");
		expect(executor.tasks).toHaveLength(1);
	});

	test("rejects a review when another tool result follows submit_review", async () => {
		const file = changedFile("src/current.ts");
		class LateToolExecutor extends PhaseExecutor {
			override async run(task: PiTask): Promise<TaskOutcome> {
				const outcome = await super.run(task);
				if (task.allowedTools?.includes("submit_review")) {
					return {
						...outcome,
						toolResults: [
							...outcome.toolResults,
							{ toolName: "file_read", details: {}, isError: true },
						],
					};
				}
				return outcome;
			}
		}
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: new LateToolExecutor(),
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options());

		expect(result.status).toBe("failed");
		expect(result.coverage.failed[0]?.reason).toContain("final successful tool result");
	});

	test("fails open when veto filtering fails", async () => {
		const file = changedFile("src/current.ts");
		const executor = new PhaseExecutor({ failVeto: true });
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options());

		expect(result.status).toBe("complete");
		expect(result.findings).toHaveLength(1);
		expect(result.warnings.some((warning) => warning.includes("keeping all findings"))).toBe(true);
	});

	test("reports partial coverage instead of claiming success", async () => {
		const files = [changedFile("src/a.ts"), changedFile("src/b.ts")];
		class OneFileFails extends PhaseExecutor {
			private index = 0;
			override async run(task: PiTask): Promise<TaskOutcome> {
				this.index += 1;
				if (this.index === 1) return failed("model failed", usage(5));
				return super.run(task);
			}
		}
		const executor = new OneFileFails({ noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target(files),
			taskExecutor: executor,
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options({ concurrency: 1 }));

		expect(result.status).toBe("partial");
		expect(result.coverage.selected).toEqual(["src/a.ts", "src/b.ts"]);
		expect(result.coverage.completed).toEqual(["src/b.ts"]);
		expect(result.coverage.failed[0]?.path).toBe("src/a.ts");
		expect(result.message.toLowerCase()).not.toContain("looks good");
	});

	test("returns complete with no findings when every selected file terminates DONE", async () => {
		const file = changedFile("src/clean.ts");
		const executor = new PhaseExecutor({ noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options());

		expect(result.status).toBe("complete");
		expect(result.findings).toEqual([]);
		expect(result.message.toLowerCase()).toContain("no findings");
	});

	test("aborts active tasks when the outer signal aborts", async () => {
		const file = changedFile("src/pending.ts");
		const controller = new AbortController();
		let release: (() => void) | undefined;
		let startedResolve: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		class PendingExecutor implements TaskExecutor {
			abortAllCalls = 0;
			async run(): Promise<TaskOutcome> {
				startedResolve?.();
				return new Promise<TaskOutcome>((resolve) => {
					release = () => resolve({ ...failed("aborted"), status: "aborted", stopReason: "aborted" });
				});
			}
			async abortAll(): Promise<void> {
				this.abortAllCalls += 1;
				release?.();
			}
		}
		const executor = new PendingExecutor();
		const pending = new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review({ repository: "/fake", mode: { kind: "workspace" } }, options({ signal: controller.signal }));

		await started;
		controller.abort(new Error("cancelled"));
		const result = await pending;

		expect(executor.abortAllCalls).toBe(1);
		expect(result.status).toBe("failed");
		expect(result.coverage.failed[0]?.path).toBe("src/pending.ts");
	});

	test("warns when all selected files complete after an abort", async () => {
		const file = changedFile("src/complete.ts");
		const executor = new PhaseExecutor({ noFindings: true });
		const controller = new AbortController();
		const events: string[] = [];
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" } },
			options({
				signal: controller.signal,
				onEvent: (event) => {
					events.push(event.type);
					if (event.type === "file_completed") controller.abort(new Error("post-completion abort"));
				},
			}),
		);

		expect(result.status).toBe("complete");
		expect(result.warnings.some((warning) => warning.includes("abort"))).toBe(true);
		expect(events).toContain("warning");
	});

	test("injects the per-file change-map slice into both plan and review prompts", async () => {
		const executor = new PhaseExecutor({ noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([exportedFile("src/a.ts", 60), exportedFile("src/b.ts", 60)]),
			taskExecutor: executor,
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" } },
			options({ concurrency: 1, planChangedLineThreshold: 50 }),
		);

		expect(result.status).toBe("complete");
		expect(executor.tasks.map((task) => {
			const tools = task.allowedTools ?? [];
			if (tools.includes("submit_plan")) return "plan";
			if (tools.includes("submit_review")) return "review";
			return "other";
		})).toEqual(["plan", "review", "plan", "review"]);

		const planA = executor.tasks[0]?.prompt as { user: string } | undefined;
		const reviewA = executor.tasks[1]?.prompt as { user: string } | undefined;
		const planB = executor.tasks[2]?.prompt as { user: string } | undefined;
		const reviewB = executor.tasks[3]?.prompt as { user: string } | undefined;

		for (const prompt of [planA, reviewA]) {
			expect(prompt?.user).toContain('<untrusted-data name="cross-file-change-map">');
			expect(prompt?.user).toContain("This file (src/a.ts):");
			expect(prompt?.user).toContain("src/a.ts: function fn1 added (line 1)");
			expect(prompt?.user).toContain("Other changed declarations:");
			expect(prompt?.user).toContain("src/b.ts: function fn1 added (line 1)");
			expect(prompt?.user).not.toContain("This file (src/b.ts):");
		}
		for (const prompt of [planB, reviewB]) {
			expect(prompt?.user).toContain("This file (src/b.ts):");
			expect(prompt?.user).toContain("src/b.ts: function fn1 added (line 1)");
			expect(prompt?.user).not.toContain("This file (src/a.ts):");
		}
	});

	test("injects the change-map slice into the review prompt even when planning is skipped", async () => {
		const executor = new PhaseExecutor({ noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([exportedFile("src/small.ts", 1)]),
			taskExecutor: executor,
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" } },
			options({ planChangedLineThreshold: 50 }),
		);

		expect(result.status).toBe("complete");
		expect(executor.tasks).toHaveLength(1);
		const prompt = executor.tasks[0]?.prompt as { user: string } | undefined;
		expect(prompt?.user).toContain('<untrusted-data name="cross-file-change-map">');
		expect(prompt?.user).toContain("This file (src/small.ts):");
		expect(prompt?.user).toContain("src/small.ts: function fn1 added (line 1)");
	});

	test("keeps explicitly excluded file content out of the change map and prompts", async () => {
		const secret = {
			...exportedFile("src/secret.ts", 1),
			hunks: [
				{
					oldStart: 0,
					oldCount: 0,
					newStart: 1,
					newCount: 1,
					lines: [
						{
							kind: "addition" as const,
							text: "export function secretHelper() { return 'do not leak'; }",
							newLine: 1,
						},
					],
				},
			],
		};
		const executor = new PhaseExecutor({ noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([exportedFile("src/ok.ts", 60), secret]),
			taskExecutor: executor,
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" } },
			options({ exclude: ["src/secret.ts"], concurrency: 1, planChangedLineThreshold: 50 }),
		);

		expect(result.status).toBe("complete");
		expect(result.coverage.selected).toEqual(["src/ok.ts"]);
		expect(result.coverage.skipped).toEqual([{ path: "src/secret.ts", reason: "user_exclude" }]);
		for (const task of executor.tasks) {
			const prompt = task.prompt as { user: string };
			expect(prompt.user).not.toContain("secretHelper");
			expect(prompt.user).toContain("src/ok.ts: function fn1 added (line 1)");
		}
	});

	test("treats diff_size_limit-gated files as metadata-only in the change map", async () => {
		const ok = exportedFile("src/ok.ts", 1);
		const huge = oversizedFile("src/huge.ts");
		const executor = new PhaseExecutor({ noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([ok, huge]),
			taskExecutor: executor,
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" } },
			options(),
		);

		expect(result.status).toBe("complete");
		expect(result.coverage.selected).toEqual(["src/ok.ts"]);
		expect(result.coverage.skipped).toContainEqual({ path: "src/huge.ts", reason: "diff_size_limit" });
		expect(executor.tasks).toHaveLength(1);
		const prompt = executor.tasks[0]?.prompt as { user: string } | undefined;
		expect(prompt?.user).toContain('<untrusted-data name="cross-file-change-map">');
		expect(prompt?.user).toContain("New files:");
		expect(prompt?.user).toContain("src/huge.ts");
		expect(prompt?.user).not.toContain("hugeFn1");
		expect(prompt?.user).not.toContain("hugeFn2");
	});

	test("warns and continues without the map when building the cross-file change map throws", async () => {
		const file = exportedFile("src/a.ts", 1);
		Object.defineProperty(file, "hunks", {
			get: () => {
				throw new Error("change map build boom");
			},
		});

		const executor = new PhaseExecutor({ noFindings: true });
		const result = await new Reviewer({
			targetFactory: async () => target([file]),
			taskExecutor: executor,
		}).review(
			{ repository: "/fake", mode: { kind: "workspace" } },
			options(),
		);

		expect(result.status).toBe("complete");
		expect(result.warnings.some((warning) => warning.includes("Unable to build or render cross-file change map"))).toBe(true);
		expect(result.warnings.some((warning) => warning.includes("change map build boom"))).toBe(true);
		expect(executor.tasks).toHaveLength(1);
		const prompt = executor.tasks[0]?.prompt as { user: string } | undefined;
		expect(prompt?.user).toContain('<untrusted-data name="cross-file-change-map">');
		expect(prompt?.user).not.toContain("This file (src/a.ts):");
		expect(prompt?.user).not.toContain("LEXICAL  src/a.ts: function fn1 added (line 1)");
	});
});
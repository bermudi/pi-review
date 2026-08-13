/**
 * Composition repro: the review-toolkit dispatcher's "reserve a slot for
 * submit_review" guard (tools.ts) and the Pi runner's hard tool-start cap
 * (pi-runner.ts) are each tested in isolation and pass. This file wires them
 * together through the real runner + real toolkit to show how they interact.
 */
import { describe, expect, test } from "bun:test";

import {
	PiTaskRunner,
	type TaskSession,
	type TaskSessionFactoryOptions,
} from "../src/pi-runner.ts";
import {
	buildTask,
	MAX_PLAN_TOOL_STARTS,
} from "../src/reviewer.ts";
import {
	createPlanToolkit,
} from "../src/phase-tools.ts";
import {
	DEFAULT_MAX_TOOL_CALLS,
	DEFAULT_VERIFICATION_MAX_TOOL_CALLS,
	createReviewToolkit,
	createVerificationToolkit,
	type ReviewToolkit,
} from "../src/tools.ts";
import type { ChangedFile, ReviewMode, ReviewTarget } from "../src/types.ts";

const model = { provider: "fake", id: "model", name: "Fake model" };

function assistant(stopReason: "stop" | "toolUse" | "error" | "aborted", text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		stopReason,
	};
}

interface FakeTargetData {
	files: Record<string, string>;
	changed: ChangedFile[];
	readPaths: string[];
}

function changedFile(path: string, rawDiff = `diff for ${path}\n+added\n`): ChangedFile {
	return {
		oldPath: path,
		newPath: path,
		rawDiff,
		newContent: undefined,
		isBinary: false,
		isDeleted: false,
		isNew: false,
		isRenamed: false,
		insertions: 1,
		deletions: 0,
		hunks: [],
	};
}

function fakeTarget(data: FakeTargetData): ReviewTarget {
	const mode: ReviewMode = { kind: "workspace" };
	return {
		repositoryRoot: "/fake/repository",
		mode,
		files: data.changed,
		readFile: async (path) => {
			data.readPaths.push(path);
			const content = data.files[path];
			if (content === undefined) throw new Error(`unknown fake path: ${path}`);
			return content;
		},
		listFiles: async () => Object.keys(data.files).sort(),
	};
}

interface ScriptedCall {
	readonly tool: string;
	readonly params: unknown;
}

/**
 * A fake agent loop that, for each scripted tool call, emits
 * tool_execution_start (advancing the runner's toolStarts counter) AND then
 * invokes the real toolkit tool's execute() (advancing the dispatcher's `calls`
 * counter and its reserve-slot guard). This is the composition the isolated
 * tests never exercise.
 */
class ComposingSession implements TaskSession {
	private listener: ((event: unknown) => void) | undefined;
	private aborted = false;
	private readonly script: readonly ScriptedCall[];
	private readonly toolkit: ReviewToolkit;
	readonly messages: readonly unknown[] = [];
	abortCalls = 0;
	disposeCalls = 0;

	constructor(script: readonly ScriptedCall[], toolkit: ReviewToolkit) {
		this.script = script;
		this.toolkit = toolkit;
	}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	private tick(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	private emit(event: unknown): void {
		this.listener?.(event);
	}

	async prompt(_text: string): Promise<void> {
		for (let index = 0; index < this.script.length; index += 1) {
			if (this.aborted) return;
			const step = this.script[index]!;
			const toolCallId = `call-${index}`;
			// 1) Runner counts this start; may trip the hard cap and requestAbort().
			this.emit({ type: "tool_execution_start", toolCallId, toolName: step.tool, args: step.params });
			await this.tick();
			if (this.aborted) return;
			// 2) Dispatcher counts this call and enforces the reserve-slot guard.
			const definition = this.toolkit.tools.find((candidate) => candidate.name === step.tool);
			if (definition === undefined) throw new Error(`missing tool ${step.tool}`);
			try {
				const result = await definition.execute(toolCallId, step.params, undefined, undefined, undefined as never);
				this.emit({ type: "tool_execution_end", toolCallId, toolName: step.tool, result, isError: false });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.emit({
					type: "tool_execution_end",
					toolCallId,
					toolName: step.tool,
					result: { content: [{ type: "text", text: message }] },
					isError: true,
				});
			}
			await this.tick();
		}
		this.emit({ type: "agent_end", messages: [assistant("stop", "done")] });
	}

	abort(): Promise<void> {
		this.abortCalls += 1;
		this.aborted = true;
		this.emit({ type: "agent_end", messages: [assistant("aborted", "")] });
		return Promise.resolve();
	}

	dispose(): void {
		this.disposeCalls += 1;
	}
}

interface ScriptedHarness {
	runner: PiTaskRunner;
	toolkit: ReviewToolkit;
}

function scriptedHarness(script: readonly ScriptedCall[], toolkit: ReviewToolkit): ScriptedHarness {
	const session = new ComposingSession(script, toolkit);
	const runner = new PiTaskRunner({
		model: "fake/model:high",
		modelRuntime: {
			getModel: () => model,
			getModels: () => [model],
			hasConfiguredAuth: () => true,
		},
		sessionFactory: async (_input: TaskSessionFactoryOptions) => session,
	});
	return { runner, toolkit };
}

function makeToolkit(): { toolkit: ReviewToolkit; data: FakeTargetData } {
	const data: FakeTargetData = {
		files: { "src/current.ts": "const a = 1;\nconst b = 2;\n" },
		changed: [changedFile("src/current.ts")],
		readPaths: [],
	};
	return { toolkit: createReviewToolkit(fakeTarget(data), "src/current.ts"), data };
}

const FILE_READ = (path = "src/current.ts"): ScriptedCall => ({ tool: "file_read", params: { path } });
const SUBMIT_DONE: ScriptedCall = { tool: "submit_review", params: { state: "DONE", comments: [] } };

function makeReviewTask(toolkit: ReviewToolkit, maxToolRounds: number | undefined = undefined) {
	return buildTask(
		"review",
		{ system: "system", user: "work" },
		toolkit.tools,
		{ maxToolRounds, signal: undefined },
		() => {},
	);
}

describe("budget composition (dispatcher x runner)", () => {
	test("buildTask derives the runner cap from the phase and configured budget", () => {
		const reviewToolkit = makeToolkit().toolkit;
		const planToolkit = createPlanToolkit();
		const verificationToolkit = createVerificationToolkit(
			fakeTarget({
				files: { "src/current.ts": "added\n" },
				changed: [changedFile("src/current.ts")],
				readPaths: [],
			}),
			"src/current.ts",
			"diff for src/current.ts\n+added\n",
			["c-0"],
		);

		const reviewTask = buildTask(
			"review",
			{ system: "system", user: "work" },
			reviewToolkit.tools,
			{ maxToolRounds: 8, signal: undefined },
			() => {},
		);
		const defaultReviewTask = buildTask(
			"review",
			{ system: "system", user: "work" },
			reviewToolkit.tools,
			{ maxToolRounds: undefined, signal: undefined },
			() => {},
		);

		expect(reviewTask.maxToolStarts).toBe(9);
		expect(defaultReviewTask.maxToolStarts).toBe(DEFAULT_MAX_TOOL_CALLS + 1);
		expect(makeReviewTask(reviewToolkit, Number.MAX_SAFE_INTEGER - 1).maxToolStarts).toBe(Number.MAX_SAFE_INTEGER);
		expect(
			buildTask(
				"plan",
				{ system: "system", user: "work" },
				planToolkit.tools,
				{ maxToolRounds: undefined, signal: undefined },
				() => {},
			).maxToolStarts,
		).toBe(MAX_PLAN_TOOL_STARTS);
		expect(
			buildTask(
				"verification",
				{ system: "system", user: "work" },
				verificationToolkit.tools,
				{ maxToolRounds: undefined, signal: undefined },
				() => {},
			).maxToolStarts,
		).toBe(DEFAULT_VERIFICATION_MAX_TOOL_CALLS + 1);
	});

	test("30 evidence calls plus submission completes", async () => {
		const { toolkit } = makeToolkit();
		const explorations = Array.from({ length: 30 }, () => FILE_READ());
		const { runner } = scriptedHarness([...explorations, SUBMIT_DONE], toolkit);
		const task = makeReviewTask(toolkit);

		const outcome = await runner.run(task);

		expect(task.maxToolStarts).toBe(33);
		expect(outcome.status).toBe("complete");
		expect(toolkit.completion).toBe("DONE");
		expect(toolkit.toolCallCount).toBe(31);
	});

	test("one or two rejected evidence attempts still leave a submit path", async () => {
		for (const excess of [1, 2]) {
			const { toolkit } = makeToolkit();
			const explorations = Array.from({ length: 30 + excess }, () => FILE_READ());
			const { runner } = scriptedHarness([...explorations, SUBMIT_DONE], toolkit);
			const outcome = await runner.run(makeReviewTask(toolkit));

			expect(outcome.status).toBe("complete");
			expect(toolkit.completion).toBe("DONE");
			expect(toolkit.toolCallCount).toBe(31 + excess);
		}
	});

	test("a third rejected evidence attempt pushes submission past the hard cap", async () => {
		const { toolkit } = makeToolkit();
		const explorations = Array.from({ length: 33 }, () => FILE_READ());
		const { runner } = scriptedHarness([...explorations, SUBMIT_DONE], toolkit);
		const task = makeReviewTask(toolkit);

		const outcome = await runner.run(task);

		expect(outcome.status).toBe("aborted");
		expect(outcome.error).toBe(`Maximum tool starts exceeded (${task.maxToolStarts}).`);
		expect(toolkit.completion).toBe("pending");
		expect(toolkit.toolCallCount).toBe(33);
	});

	test("a malformed final submission can be corrected", async () => {
		const { toolkit } = makeToolkit();
		const invalid: ScriptedCall = { tool: "submit_review", params: { state: "DONE", comments: [{ bad: true }] } };
		const { runner } = scriptedHarness([invalid, SUBMIT_DONE], toolkit);

		const outcome = await runner.run(makeReviewTask(toolkit));

		expect(outcome.status).toBe("complete");
		expect(toolkit.completion).toBe("DONE");
		expect(toolkit.toolCallCount).toBe(2);
	});

	test("tiny configured budgets preserve a submit-only path", async () => {
		const { toolkit } = makeToolkit();
		const { runner } = scriptedHarness([SUBMIT_DONE], toolkit);
		const task = makeReviewTask(toolkit, 1);

		const outcome = await runner.run(task);

		expect(task.maxToolStarts).toBe(2);
		expect(outcome.status).toBe("complete");
		expect(toolkit.completion).toBe("DONE");
	});
});

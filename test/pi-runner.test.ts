import { describe, expect, test } from "bun:test";

import {
	PiTaskRunner,
	type PiTaskRunnerOptions,
	type ResolvedTaskModel,
	type TaskSession,
	type TaskSessionFactoryOptions,
} from "../src/pi-runner.ts";

interface TestAssistantMessage {
	readonly role: "assistant";
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly usage: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly totalTokens: number;
	};
	readonly stopReason: "stop" | "toolUse" | "error" | "aborted";
	readonly errorMessage?: string;
}

const model = { provider: "fake", id: "model", name: "Fake model" };

function assistant(
	stopReason: TestAssistantMessage["stopReason"],
	text: string,
	overrides: Partial<TestAssistantMessage["usage"]> = {},
): TestAssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 2,
			output: 3,
			cacheRead: 4,
			cacheWrite: 5,
			totalTokens: 14,
			...overrides,
		},
		stopReason,
	};
}

class FakeSession implements TaskSession {
	private listener: ((event: unknown) => void) | undefined;
	private promptResolver: (() => void) | undefined;
	readonly promptInputs: string[] = [];
	abortCalls = 0;
	disposeCalls = 0;
	promptError: Error | undefined;
	readonly messages: readonly unknown[] = [];
	private readonly promptImplementation: (session: FakeSession) => Promise<void>;

	constructor(promptImplementation: (session: FakeSession) => Promise<void>) {
		this.promptImplementation = promptImplementation;
	}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	async prompt(text: string): Promise<void> {
		this.promptInputs.push(text);
		if (this.promptError) throw this.promptError;
		await this.promptImplementation(this);
	}

	abort(): Promise<void> {
		this.abortCalls += 1;
		this.emit({
			type: "agent_end",
			messages: [assistant("aborted", "")],
		});
		this.promptResolver?.();
		return Promise.resolve();
	}

	dispose(): void {
		this.disposeCalls += 1;
	}

	waitForAbort(): Promise<void> {
		return new Promise((resolve) => {
			this.promptResolver = resolve;
		});
	}

	emit(event: unknown): void {
		this.listener?.(event);
	}
}

interface Harness {
	runner: PiTaskRunner;
	factoryInputs: TaskSessionFactoryOptions[];
	sessions: FakeSession[];
}

function harness(
	makeSession: (input: TaskSessionFactoryOptions, index: number) => FakeSession,
	extra: Partial<PiTaskRunnerOptions> = {},
): Harness {
	const factoryInputs: TaskSessionFactoryOptions[] = [];
	const sessions: FakeSession[] = [];
	const runner = new PiTaskRunner({
		model: "fake/model:high",
		modelRuntime: {
			getModel: () => model,
			getModels: () => [model],
			hasConfiguredAuth: () => true,
		},
		sessionFactory: async (input) => {
			factoryInputs.push(input);
			const session = makeSession(input, sessions.length);
			sessions.push(session);
			return session;
		},
		...extra,
	});
	return { runner, factoryInputs, sessions };
}

describe("PiTaskRunner", () => {
	test("resolves the explicit model, isolates tools, subscribes first, and sanitizes results", async () => {
		let promptSawSubscription = false;
		const events: string[] = [];
		const { runner, factoryInputs, sessions } = harness(
			() =>
				new FakeSession(async (session) => {
					promptSawSubscription = true;
					session.emit({ type: "tool_execution_start", toolName: "inspect", args: { path: "x" } });
					session.emit({
						type: "tool_execution_end",
						toolCallId: "call-1",
						toolName: "inspect",
						result: {
							content: [{ type: "text", text: "should not escape" }],
							details: { line: 7, nested: { ok: true } },
						},
						isError: false,
					});
					session.emit({ type: "agent_end", messages: [assistant("stop", "done")] });
				}),
			{
				onToolStart: (toolName) => events.push(toolName),
			},
		);

		const outcome = await runner.run({
			prompt: { system: "fixed system", user: "review this" },
			customTools: [{ name: "inspect" }],
			allowedTools: ["inspect"],
		});

		expect(outcome).toEqual({
			status: "complete",
			text: "done",
			stopReason: "stop",
			usage: {
				inputTokens: 2,
				outputTokens: 3,
				cacheReadTokens: 4,
				cacheWriteTokens: 5,
				totalTokens: 14,
			},
			toolResults: [{ toolName: "inspect", details: { line: 7, nested: { ok: true } }, isError: false }],
		});
		expect(promptSawSubscription).toBe(true);
		expect(events).toEqual(["inspect"]);
		expect(factoryInputs).toHaveLength(1);
		expect(factoryInputs[0]?.modelProvider).toBe("fake");
		expect(factoryInputs[0]?.modelId).toBe("model");
		expect(factoryInputs[0]?.thinkingLevel).toBe("high");
		expect(factoryInputs[0]?.tools).toEqual(["inspect"]);
		expect(factoryInputs[0]?.customTools).toEqual([{ name: "inspect" }]);
		const loader = factoryInputs[0]?.resourceLoader as {
			getAgentsFiles: () => { agentsFiles: unknown[] };
			getExtensions: () => { extensions: unknown[] };
			getSkills: () => { skills: unknown[] };
			getPrompts: () => { prompts: unknown[] };
			getThemes: () => { themes: unknown[] };
		};
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getPrompts().prompts).toEqual([]);
		expect(loader.getThemes().themes).toEqual([]);
		expect(sessions[0]?.promptInputs).toEqual(["review this"]);
		expect(sessions[0]?.disposeCalls).toBe(1);
	});

	test("aborts at the first tool start beyond the configured limit", async () => {
		const { runner, sessions } = harness(() =>
			new FakeSession(async (session) => {
				session.emit({ type: "tool_execution_start", toolName: "one" });
				session.emit({ type: "tool_execution_start", toolName: "two" });
			}),
		);

		const outcome = await runner.run({
			prompt: { system: "system", user: "work" },
			allowedTools: ["one", "two"],
			maxToolStarts: 1,
		});

		expect(outcome.status).toBe("aborted");
		expect(outcome.stopReason).toBe("aborted");
		expect(sessions[0]?.abortCalls).toBe(1);
		expect(sessions[0]?.disposeCalls).toBe(1);
	});

	test("accepts a terminating structured-output tool-use turn", async () => {
		const { runner } = harness(() =>
			new FakeSession(async (session) => {
				session.emit({ type: "agent_end", messages: [assistant("toolUse", "")] });
			}),
		);

		const outcome = await runner.run({ prompt: { system: "system", user: "work" } });

		expect(outcome.status).toBe("complete");
		expect(outcome.stopReason).toBe("toolUse");
	});

	test("uses final error stop reasons and still disposes the session", async () => {
		const { runner, sessions } = harness(() =>
			new FakeSession(async (session) => {
				session.emit({
					type: "agent_end",
					messages: [
						{
							...assistant("error", "provider failed", { input: 9, totalTokens: 21 }),
							errorMessage: "provider failed",
						},
					],
				});
			}),
		);

		const outcome = await runner.run({ prompt: { system: "system", user: "work" } });

		expect(outcome.status).toBe("failed");
		expect(outcome.stopReason).toBe("error");
		expect(outcome.error).toBe("provider failed");
		expect(outcome.text).toBe("provider failed");
		expect(outcome.usage.inputTokens).toBe(9);
		expect(outcome.usage.totalTokens).toBe(21);
		expect(sessions[0]?.disposeCalls).toBe(1);
	});

	test("abortAll aborts every active session", async () => {
		const pending: FakeSession[] = [];
		const { runner } = harness(() => {
			const session = new FakeSession(async (current) => current.waitForAbort());
			pending.push(session);
			return session;
		});

		const first = runner.run({ prompt: { system: "system", user: "one" } });
		const second = runner.run({ prompt: { system: "system", user: "two" } });
		while (pending.length < 2) await Promise.resolve();
		await Promise.resolve();
		await runner.abortAll();
		const outcomes = await Promise.all([first, second]);

		expect(pending).toHaveLength(2);
		expect(pending.map((session) => session.abortCalls)).toEqual([1, 1]);
		expect(pending.map((session) => session.disposeCalls)).toEqual([1, 1]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["aborted", "aborted"]);
	});

	test("verifies authentication before creating a session", async () => {
		const { runner, sessions } = harness(() => new FakeSession(async () => undefined), {
			modelRuntime: {
				getModel: () => model,
				hasConfiguredAuth: () => false,
			},
		});

		const outcome = await runner.run({ prompt: { system: "system", user: "work" } });

		expect(outcome.status).toBe("failed");
		expect(outcome.error).toContain("No configured authentication");
		expect(sessions).toHaveLength(0);
	});

	test("honors an AbortSignal while a session is prompting", async () => {
		const controller = new AbortController();
		let promptStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			promptStarted = resolve;
		});
		const { runner, sessions } = harness(
			() =>
				new FakeSession(async (session) => {
					promptStarted?.();
					await session.waitForAbort();
				}),
			{ signal: controller.signal },
		);

		const pending = runner.run({ prompt: { system: "system", user: "work" } });
		await started;
		controller.abort(new Error("cancelled by test"));
		const outcome = await pending;

		expect(outcome.status).toBe("aborted");
		expect(outcome.error).toBe("cancelled by test");
		expect(sessions[0]?.abortCalls).toBe(1);
		expect(sessions[0]?.disposeCalls).toBe(1);
	});

	test("requires custom tools to appear in an explicit allowlist", async () => {
		const { runner, sessions } = harness(() => new FakeSession(async () => undefined));

		await expect(
			runner.run({
				prompt: { system: "system", user: "work" },
				customTools: [{ name: "inspect" }],
			}),
		).rejects.toThrow("requires an explicit allowlist");
		expect(sessions).toHaveLength(0);
	});

	test("supports an injected model resolver without loading Pi", async () => {
		const resolved: ResolvedTaskModel = {
			model,
			provider: "fake",
			id: "model",
			thinkingLevel: "low",
		};
		let seenSpec = "";
		const { runner, factoryInputs } = harness(() =>
			new FakeSession(async (session) => {
				session.emit({ type: "agent_end", messages: [assistant("stop", "ok")] });
			}),
			{
				modelResolver: ({ modelSpec }) => {
					seenSpec = modelSpec;
					return resolved;
				},
			},
		);

		await runner.run({ prompt: { system: "system", user: "work" } });
		expect(seenSpec).toBe("fake/model:high");
		expect(factoryInputs[0]?.thinkingLevel).toBe("low");
	});

	test("accepts bare model references and forwards them to the injected resolver", async () => {
		const resolved: ResolvedTaskModel = {
			model,
			provider: "fake",
			id: "model",
			thinkingLevel: "max",
		};
		let seenSpec = "";
		const { runner, factoryInputs } = harness(
			() =>
				new FakeSession(async (session) => {
					session.emit({ type: "agent_end", messages: [assistant("stop", "ok")] });
				}),
			{
				model: "gpt-5.6-luna:max",
				modelResolver: ({ modelSpec }) => {
					seenSpec = modelSpec;
					return resolved;
				},
			},
		);

		await runner.run({ prompt: { system: "system", user: "work" } });
		expect(seenSpec).toBe("gpt-5.6-luna:max");
		expect(factoryInputs[0]?.modelId).toBe("model");
		expect(factoryInputs[0]?.modelProvider).toBe("fake");
		expect(factoryInputs[0]?.thinkingLevel).toBe("max");
	});
});

import { homedir } from "node:os";
import { join } from "node:path";

import type { BuiltPrompt } from "./prompts.js";
import { EMPTY_USAGE, type ReviewUsage } from "./types.js";

/** Thinking levels accepted in a model reference. */
export type TaskThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Stop reasons exposed by a task without leaking Pi's message types. */
export type TaskStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export type TaskStatus = "complete" | "failed" | "aborted";

/** The only tool-result data that crosses the Pi boundary. */
export interface TaskToolResult {
	readonly toolName: string;
	readonly details: unknown;
	readonly isError: boolean;
}

export interface TaskOutcome {
	readonly status: TaskStatus;
	readonly text: string;
	readonly stopReason?: TaskStopReason;
	readonly error?: string;
	readonly usage: ReviewUsage;
	readonly toolResults: readonly TaskToolResult[];
}

/** A deliberately small event vocabulary for callers that want progress. */
export type TaskEvent =
	| { readonly type: "tool_started"; readonly toolName: string }
	| { readonly type: "warning"; readonly message: string };

export type TaskEventListener = (event: TaskEvent) => void;
export type TaskToolStartListener = (toolName: string) => void;

/**
 * A Pi session narrowed to the operations the runner needs. Keeping this
 * interface structural makes fake sessions cheap and keeps AgentSession out of
 * the runner's public result contract.
 */
export interface TaskSession {
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	readonly messages?: readonly unknown[];
}

export interface TaskSessionFactoryOptions {
	readonly model: unknown;
	readonly modelProvider: string;
	readonly modelId: string;
	readonly thinkingLevel?: TaskThinkingLevel;
	readonly cwd: string;
	readonly agentDir: string;
	readonly systemPrompt: string;
	/** Explicit names only. An empty list means no tools. */
	readonly tools: readonly string[];
	readonly allowedTools: readonly string[];
	readonly customTools: readonly unknown[];
	readonly modelRuntime: unknown;
	readonly modelRegistry?: unknown;
	/** Minimal loader with all discovery sources empty. */
	readonly resourceLoader: unknown;
}

/**
 * Factories may return the session directly or the SDK-shaped `{ session }`
 * result. Supporting both keeps the injection seam small without exposing Pi's
 * result type to callers.
 */
export interface TaskSessionFactoryResult {
	readonly session: TaskSession;
}

export type TaskSessionFactory = (
	options: TaskSessionFactoryOptions,
) => TaskSession | TaskSessionFactoryResult | Promise<TaskSession | TaskSessionFactoryResult>;

export interface ResolvedTaskModel {
	readonly model: unknown;
	readonly provider: string;
	readonly id: string;
	readonly thinkingLevel?: TaskThinkingLevel;
	readonly warning?: string;
}

export type TaskModelResolver = (input: {
	readonly modelSpec: string;
	readonly modelRuntime: unknown;
}) => Promise<ResolvedTaskModel> | ResolvedTaskModel;

export interface PiTaskRunnerOptions {
	/** Provider/model[:thinking] or model[:thinking] reference; bare and partial
	 * names resolve through Pi's model runtime exactly as `pi --model` does. */
	readonly model?: string;
	/** Alias for model, useful at call sites that already use "modelSpec". */
	readonly modelSpec?: string;
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly maxToolStarts?: number;
	readonly signal?: AbortSignal;
	readonly onEvent?: TaskEventListener;
	readonly onToolStart?: TaskToolStartListener;
	/** Inject a prepared ModelRuntime/legacy registry in tests or hosts. */
	readonly modelRuntime?: unknown;
	readonly modelResolver?: TaskModelResolver;
	readonly sessionFactory?: TaskSessionFactory;
	/** Optional host-side auth check for a custom runtime seam. */
	readonly verifyAuth?: (input: {
		readonly model: unknown;
		readonly provider: string;
		readonly modelRuntime: unknown;
	}) => Promise<boolean> | boolean;
}

export type TaskRunnerOptions = PiTaskRunnerOptions;
export type PiRunnerOptions = PiTaskRunnerOptions;

/**
 * One independent prompt. `prompt` accepts the BuiltPrompt shape used by
 * src/prompts.ts; the explicit fields are convenient for generic callers and
 * make the boundary unambiguous in tests.
 */
export interface PiTask {
	readonly prompt?: BuiltPrompt | string;
	readonly systemPrompt?: string;
	readonly userPrompt?: string;
	readonly system?: string;
	readonly user?: string;
	/** Custom Pi tool definitions. */
	readonly customTools?: readonly unknown[];
	/** Alias for customTools, or a string allowlist when all entries are strings. */
	readonly tools?: readonly unknown[];
	/** Names exposed to the model. There is no implicit default tool set. */
	readonly allowedTools?: readonly string[];
	readonly toolAllowlist?: readonly string[];
	readonly maxToolStarts?: number;
	readonly signal?: AbortSignal;
	readonly onEvent?: TaskEventListener;
	readonly onToolStart?: TaskToolStartListener;
}

export type TaskInput = PiTask;

export interface RunTaskOptions {
	readonly signal?: AbortSignal;
	readonly maxToolStarts?: number;
	readonly onEvent?: TaskEventListener;
	readonly onToolStart?: TaskToolStartListener;
}

interface RuntimeHandle {
	readonly runtime: unknown;
	readonly legacyRegistry?: unknown;
	readonly modern: boolean;
	readonly legacy: boolean;
	readonly piModule?: PiCodingAgentModule;
}

interface PiCodingAgentModule {
	readonly createAgentSession?: (options: Record<string, unknown>) => Promise<{ readonly session: unknown }>;
	readonly createExtensionRuntime?: () => unknown;
	readonly SessionManager?: {
		readonly inMemory: (cwd?: string) => unknown;
	};
	readonly SettingsManager?: {
		readonly inMemory: (settings?: unknown) => unknown;
	};
	readonly ModelRuntime?: {
		readonly create: (options: Record<string, unknown>) => Promise<unknown>;
	};
	readonly AuthStorage?: {
		readonly create: (authPath?: string) => unknown;
	};
	readonly ModelRegistry?: {
		readonly create: (authStorage: unknown, modelsPath?: string) => unknown;
	};
	readonly resolveCliModel?: (options: Record<string, unknown>) => unknown;
}

interface UnknownRecord {
	[key: string]: unknown;
}

interface ActiveRun {
	readonly session: TaskSession;
	abortRequested: boolean;
	abortReason?: string;
	abortPromise?: Promise<void>;
	abortError?: unknown;
	requestAbort(reason: string, classifyAsAbort?: boolean): Promise<void>;
}

interface NormalizedTask {
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly customTools: readonly unknown[];
	readonly allowedTools: readonly string[];
	readonly maxToolStarts?: number;
	readonly signal?: AbortSignal;
	readonly onEvent?: TaskEventListener;
	readonly onToolStart?: TaskToolStartListener;
}

const THINKING_LEVELS = new Set<TaskThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const STOP_REASONS = new Set<TaskStopReason>([
	"pending",
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
]);

function asRecord(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function functionValue(value: unknown): ((...args: unknown[]) => unknown) | undefined {
	return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : undefined;
}

function hasFunction(value: unknown, name: string): boolean {
	const record = asRecord(value);
	return record !== undefined && functionValue(record[name]) !== undefined;
}

async function callMethod(value: unknown, name: string, args: readonly unknown[]): Promise<unknown> {
	const record = asRecord(value);
	const method = record === undefined ? undefined : functionValue(record[name]);
	if (!method) throw new Error(`Pi runtime does not implement ${name}().`);
	return method.apply(value, [...args]);
}

function errorText(error: unknown, fallback = "Pi task failed"): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error.length > 0) return error;
	return fallback;
}

function abortText(signal: AbortSignal | undefined, fallback = "Task aborted"): string {
	if (!signal?.reason) return fallback;
	return errorText(signal.reason, fallback);
}

function emptyUsage(): ReviewUsage {
	return { ...EMPTY_USAGE };
}

function failedOutcome(error: string, toolResults: readonly TaskToolResult[] = []): TaskOutcome {
	return {
		status: "failed",
		text: "",
		stopReason: "error",
		error,
		usage: emptyUsage(),
		toolResults: [...toolResults],
	};
}

function abortedOutcome(error = "Task aborted", toolResults: readonly TaskToolResult[] = []): TaskOutcome {
	return {
		status: "aborted",
		text: "",
		stopReason: "aborted",
		error,
		usage: emptyUsage(),
		toolResults: [...toolResults],
	};
}

function validateLimit(value: number | undefined, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${field} must be a non-negative integer.`);
	}
	return value;
}

function modelSpecFromOptions(options: PiTaskRunnerOptions): string {
	const value = options.model ?? options.modelSpec;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("A provider/model[:thinking] or model[:thinking] model reference is required.");
	}
	return value.trim();
}

function normalizeAgentDir(value: string | undefined): string {
	const configured = value?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

function createMinimalResourceLoader(systemPrompt: string, extensionRuntime: unknown): UnknownRecord {
	const extensions = { extensions: [], errors: [], runtime: extensionRuntime };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => undefined,
		reload: async () => undefined,
	};
}

function validateSession(value: unknown): TaskSession {
	const record = asRecord(value);
	if (
		record === undefined ||
		!hasFunction(record, "subscribe") ||
		!hasFunction(record, "prompt") ||
		!hasFunction(record, "abort") ||
		!hasFunction(record, "dispose")
	) {
		throw new Error("Pi session factory returned an invalid session.");
	}
	return value as TaskSession;
}

function sessionFromFactoryResult(value: unknown): TaskSession {
	const record = asRecord(value);
	const session = record !== undefined && Object.hasOwn(record, "session") ? record.session : value;
	return validateSession(session);
}

function modelInfo(value: unknown): { readonly provider: string; readonly id: string } | undefined {
	const record = asRecord(value);
	const provider = record === undefined ? undefined : stringValue(record.provider);
	const id = record === undefined ? undefined : stringValue(record.id);
	return provider && id ? { provider, id } : undefined;
}

function parseModelSpec(modelSpec: string): {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: TaskThinkingLevel;
} {
	const slash = modelSpec.indexOf("/");
	const provider = modelSpec.slice(0, slash).trim();
	let modelId = modelSpec.slice(slash + 1).trim();
	let thinkingLevel: TaskThinkingLevel | undefined;
	const colon = modelId.lastIndexOf(":");
	if (colon > 0) {
		const suffix = modelId.slice(colon + 1);
		if (THINKING_LEVELS.has(suffix as TaskThinkingLevel)) {
			thinkingLevel = suffix as TaskThinkingLevel;
			modelId = modelId.slice(0, colon);
		}
	}
	if (!provider || !modelId) throw new TypeError(`Invalid model reference "${modelSpec}".`);
	return { provider, modelId, thinkingLevel };
}

function modelMatches(value: unknown, provider: string, id: string): boolean {
	const info = modelInfo(value);
	return info !== undefined && info.provider.toLowerCase() === provider.toLowerCase() && info.id.toLowerCase() === id.toLowerCase();
}

async function modelList(runtime: unknown): Promise<readonly unknown[]> {
	for (const method of ["getModels", "getAll"]) {
		if (hasFunction(runtime, method)) {
			const result = await callMethod(runtime, method, []);
			if (!Array.isArray(result)) throw new Error(`Pi runtime ${method}() returned a non-array model list.`);
			return result;
		}
	}
	return [];
}

function normalizeResolvedModel(value: unknown, modelSpec: string): ResolvedTaskModel {
	const record = asRecord(value);
	if (!record) throw new Error("Model resolver returned an invalid result.");
	const model = record.model;
	const info = modelInfo(model);
	const provider = stringValue(record.provider) ?? info?.provider;
	const id = stringValue(record.id) ?? info?.id;
	if (!provider || !id) throw new Error(`Model resolver did not return provider/model for "${modelSpec}".`);
	const thinking = record.thinkingLevel;
	if (thinking !== undefined && (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking as TaskThinkingLevel))) {
		throw new Error(`Model resolver returned an invalid thinking level for "${modelSpec}".`);
	}
	const warning = record.warning;
	if (warning !== undefined && typeof warning !== "string") {
		throw new Error(`Model resolver returned an invalid warning for "${modelSpec}".`);
	}
	return {
		model,
		provider,
		id,
		thinkingLevel: thinking as TaskThinkingLevel | undefined,
		warning: warning as string | undefined,
	};
}

function sanitizeDetails(value: unknown, seen = new Set<object>(), depth = 0): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") return undefined;
	if (depth >= 8) return "[details truncated]";
	if (seen.has(value)) return "[circular details]";
	seen.add(value);
	if (Array.isArray(value)) {
		return value.slice(0, 100).map((entry) => sanitizeDetails(entry, seen, depth + 1));
	}
	const record = asRecord(value);
	if (!record) return undefined;
	const output: UnknownRecord = {};
	for (const key of Object.keys(record).slice(0, 100)) {
		Object.defineProperty(output, key, {
			configurable: true,
			enumerable: true,
			value: sanitizeDetails(record[key], seen, depth + 1),
			writable: true,
		});
	}
	return output;
}

function resultDetails(value: unknown): unknown {
	const record = asRecord(value);
	return record && Object.hasOwn(record, "details") ? sanitizeDetails(record.details) : undefined;
}

function assistantMessage(value: unknown): UnknownRecord | undefined {
	const record = asRecord(value);
	return record?.role === "assistant" ? record : undefined;
}

function assistantStopReason(value: UnknownRecord): TaskStopReason | undefined {
	const reason = stringValue(value.stopReason);
	return reason && STOP_REASONS.has(reason as TaskStopReason) ? (reason as TaskStopReason) : undefined;
}

function assistantText(value: UnknownRecord): string {
	const content = value.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return record?.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.join("");
}

function numericField(record: UnknownRecord, name: string): number {
	const value = record[name];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function aggregateUsage(messages: readonly UnknownRecord[]): ReviewUsage {
	const usage = emptyUsage();
	for (const message of messages) {
		const value = asRecord(message.usage);
		if (!value) continue;
		const input = numericField(value, "input");
		const output = numericField(value, "output");
		const cacheRead = numericField(value, "cacheRead");
		const cacheWrite = numericField(value, "cacheWrite");
		const reportedTotal = numericField(value, "totalTokens");
		usage.inputTokens += input;
		usage.outputTokens += output;
		usage.cacheReadTokens += cacheRead;
		usage.cacheWriteTokens += cacheWrite;
		usage.totalTokens += reportedTotal > 0 ? reportedTotal : input + output + cacheRead + cacheWrite;
	}
	return usage;
}

function lastAssistant(messages: readonly unknown[]): UnknownRecord | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = assistantMessage(messages[index]);
		if (message) return message;
	}
	return undefined;
}

function eventMessages(event: UnknownRecord): readonly unknown[] {
	return Array.isArray(event.messages) ? event.messages : [];
}

function taskOutcomeFromFinal(
	final: UnknownRecord | undefined,
	allMessages: readonly UnknownRecord[],
	toolResults: readonly TaskToolResult[],
	requestedAbort: boolean,
	abortReason: string | undefined,
	runError: string | undefined,
): TaskOutcome {
	const usage = aggregateUsage(allMessages);
	if (requestedAbort) {
		return {
			status: "aborted",
			text: final ? assistantText(final) : "",
			stopReason: "aborted",
			error: abortReason ?? "Task aborted",
			usage,
			toolResults: [...toolResults],
		};
	}
	if (!final) return failedOutcome(runError ?? "Pi task completed without a final assistant message.", toolResults);
	const stopReason = assistantStopReason(final);
	if (!stopReason) return failedOutcome(runError ?? "Final Pi assistant message had no stop reason.", toolResults);
	const text = assistantText(final);
	// A terminating structured-output tool ends Pi's loop on the assistant's
	// tool-use turn, so `toolUse` is a successful final state as well as `stop`.
	if ((stopReason === "stop" || stopReason === "toolUse") && !runError) {
		return { status: "complete", text, stopReason, usage, toolResults: [...toolResults] };
	}
	if (stopReason === "aborted" && !runError) {
		return {
			status: "aborted",
			text,
			stopReason,
			error: stringValue(final.errorMessage) ?? "Task aborted",
			usage,
			toolResults: [...toolResults],
		};
	}
	return {
		status: "failed",
		text,
		stopReason,
		error: runError ?? stringValue(final.errorMessage) ?? `Pi task stopped with reason "${stopReason}".`,
		usage,
		toolResults: [...toolResults],
	};
}

async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
	return (await import("@earendil-works/pi-coding-agent")) as unknown as PiCodingAgentModule;
}

async function createRuntime(agentDir: string): Promise<RuntimeHandle> {
	const pi = await loadPiCodingAgent();
	if (pi.ModelRuntime?.create) {
		const runtime = await pi.ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		return { runtime, modern: true, legacy: false, piModule: pi };
	}
	if (!pi.AuthStorage?.create || !pi.ModelRegistry?.create) {
		throw new Error("Installed Pi SDK does not expose ModelRuntime or the legacy model registry.");
	}
	const authStorage = pi.AuthStorage.create(join(agentDir, "auth.json"));
	const registry = pi.ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	return { runtime: registry, legacyRegistry: registry, modern: false, legacy: true, piModule: pi };
}

async function resolveWithInstalledResolver(
	pi: PiCodingAgentModule,
	handle: RuntimeHandle,
	modelSpec: string,
): Promise<ResolvedTaskModel | undefined> {
	if (!pi.resolveCliModel) return undefined;
	const options: Record<string, unknown> = handle.modern
		? { cliModel: modelSpec, modelRuntime: handle.runtime }
		: { cliModel: modelSpec, modelRegistry: handle.runtime };
	const raw = await Promise.resolve(pi.resolveCliModel(options));
	const result = asRecord(raw);
	if (!result) throw new Error("Pi model resolver returned an invalid result.");
	const error = stringValue(result.error);
	if (error) throw new Error(error);
	const model = result.model;
	if (model === undefined) throw new Error(`Model "${modelSpec}" was not resolved.`);
	const info = modelInfo(model);
	if (!info) throw new Error(`Pi model resolver returned an invalid model for "${modelSpec}".`);
	const thinking = stringValue(result.thinkingLevel);
	if (thinking !== undefined && !THINKING_LEVELS.has(thinking as TaskThinkingLevel)) {
		throw new Error(`Pi model resolver returned an invalid thinking level for "${modelSpec}".`);
	}
	return {
		model,
		provider: info.provider,
		id: info.id,
		thinkingLevel: thinking as TaskThinkingLevel | undefined,
		warning: stringValue(result.warning),
	};
}

async function resolveWithoutInstalledResolver(handle: RuntimeHandle, modelSpec: string): Promise<ResolvedTaskModel> {
	const parsed = parseModelSpec(modelSpec);
	let model: unknown;
	if (hasFunction(handle.runtime, "getModel")) {
		model = await callMethod(handle.runtime, "getModel", [parsed.provider, parsed.modelId]);
	} else if (hasFunction(handle.runtime, "find")) {
		model = await callMethod(handle.runtime, "find", [parsed.provider, parsed.modelId]);
	}
	if (model === undefined) {
		const models = await modelList(handle.runtime);
		model = models.find((entry) => modelMatches(entry, parsed.provider, parsed.modelId));
	}
	const info = modelInfo(model);
	if (!info) throw new Error(`Model "${modelSpec}" was not found.`);
	return {
		model,
		provider: info.provider,
		id: info.id,
		thinkingLevel: parsed.thinkingLevel,
	};
}

async function defaultSessionFactory(input: TaskSessionFactoryOptions): Promise<TaskSession> {
	const pi = await loadPiCodingAgent();
	if (!pi.createAgentSession || !pi.SessionManager?.inMemory || !pi.SettingsManager?.inMemory) {
		throw new Error("Installed Pi SDK does not expose the AgentSession factory.");
	}
	const extensionRuntime = pi.createExtensionRuntime?.();
	const resourceLoader = createMinimalResourceLoader(input.systemPrompt, extensionRuntime);
	const options: Record<string, unknown> = {
		cwd: input.cwd,
		agentDir: input.agentDir,
		model: input.model,
		thinkingLevel: input.thinkingLevel,
		modelRuntime: input.modelRuntime,
		modelRegistry: input.modelRegistry ?? input.modelRuntime,
		resourceLoader,
		tools: [...input.tools],
		customTools: [...input.customTools],
		sessionManager: pi.SessionManager.inMemory(input.cwd),
		settingsManager: pi.SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 2 },
		}),
	};
	if (input.thinkingLevel === undefined) delete options.thinkingLevel;
	return validateSession((await pi.createAgentSession(options)).session);
}

function normalizeTask(task: PiTask): NormalizedTask {
	if (typeof task !== "object" || task === null) throw new TypeError("A task object is required.");
	const prompt = task.prompt;
	const promptRecord = asRecord(prompt);
	const systemPrompt = task.systemPrompt ?? task.system ?? stringValue(promptRecord?.system) ?? "";
	const userPrompt = task.userPrompt ?? task.user ?? (typeof prompt === "string" ? prompt : stringValue(promptRecord?.user));
	if (typeof systemPrompt !== "string") throw new TypeError("Task system prompt must be a string.");
	if (typeof userPrompt !== "string") throw new TypeError("Task user prompt must be a string.");

	if (task.tools !== undefined && !Array.isArray(task.tools)) {
		throw new TypeError("Task tools must be an array.");
	}
	if (task.customTools !== undefined && !Array.isArray(task.customTools)) {
		throw new TypeError("Task customTools must be an array.");
	}
	if (task.allowedTools !== undefined && !Array.isArray(task.allowedTools)) {
		throw new TypeError("Task allowedTools must be an array.");
	}
	if (task.toolAllowlist !== undefined && !Array.isArray(task.toolAllowlist)) {
		throw new TypeError("Task toolAllowlist must be an array.");
	}
	const taskToolArray = task.tools ?? [];
	const stringToolNames = taskToolArray.every((entry) => typeof entry === "string");
	const customTools = task.customTools ?? (stringToolNames ? [] : taskToolArray);
	const explicitAllowlist = task.toolAllowlist ?? task.allowedTools;
	const inferredAllowlist = stringToolNames ? taskToolArray.filter((entry): entry is string => typeof entry === "string") : undefined;
	if (task.toolAllowlist && task.allowedTools) {
		if (task.toolAllowlist.join("\0") !== task.allowedTools.join("\0")) {
			throw new TypeError("Task toolAllowlist and allowedTools disagree.");
		}
	}
	const rawAllowlist = explicitAllowlist ?? inferredAllowlist ?? [];
	if (!Array.isArray(rawAllowlist) || rawAllowlist.some((name) => typeof name !== "string" || name.length === 0)) {
		throw new TypeError("Task tool allowlist must contain non-empty strings.");
	}
	const allowedTools = [...new Set(rawAllowlist)];
	const toolNames = new Set<string>();
	for (const tool of customTools) {
		const name = stringValue(asRecord(tool)?.name);
		if (!name) throw new TypeError("Every custom tool must have a name.");
		if (toolNames.has(name)) throw new TypeError(`Duplicate custom tool "${name}".`);
		toolNames.add(name);
		if (!allowedTools.includes(name)) {
			throw new TypeError(`Custom tool "${name}" requires an explicit allowlist entry.`);
		}
	}
	return {
		systemPrompt,
		userPrompt,
		customTools: [...customTools],
		allowedTools,
		maxToolStarts: validateLimit(task.maxToolStarts, "maxToolStarts"),
		signal: task.signal,
		onEvent: task.onEvent,
		onToolStart: task.onToolStart,
	};
}

export class PiTaskRunner {
	private readonly modelSpec: string;
	private readonly options: PiTaskRunnerOptions;
	private readonly activeRuns = new Set<ActiveRun>();
	private runtimePromise: Promise<RuntimeHandle> | undefined;
	private resolvedModelPromise: Promise<ResolvedTaskModel> | undefined;

	constructor(options: PiTaskRunnerOptions) {
		this.modelSpec = modelSpecFromOptions(options);
		validateLimit(options.maxToolStarts, "maxToolStarts");
		this.options = options;
	}

	async run(task: PiTask, runOptions: RunTaskOptions = {}): Promise<TaskOutcome> {
		const normalized = normalizeTask(task);
		const signal = normalized.signal ?? runOptions.signal ?? this.options.signal;
		const notify = normalized.onEvent ?? runOptions.onEvent ?? this.options.onEvent;
		const onToolStart = normalized.onToolStart ?? runOptions.onToolStart ?? this.options.onToolStart;
		const maxToolStarts = normalized.maxToolStarts ?? runOptions.maxToolStarts ?? this.options.maxToolStarts;
		validateLimit(maxToolStarts, "maxToolStarts");
		if (signal?.aborted) return abortedOutcome(abortText(signal));

		let handle: RuntimeHandle;
		let resolved: ResolvedTaskModel;
		try {
			handle = await this.runtime();
			resolved = await this.resolveModel(handle);
			if (resolved.warning) notify?.({ type: "warning", message: resolved.warning });
			await this.verifyAuth(handle, resolved);
		} catch (error) {
			if (signal?.aborted) return abortedOutcome(abortText(signal));
			return failedOutcome(errorText(error, `Unable to prepare model "${this.modelSpec}".`));
		}

		if (signal?.aborted) return abortedOutcome(abortText(signal));

		let session: TaskSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let cleanupError: unknown;
		let runError: string | undefined;
		let finalMessages: readonly unknown[] = [];
		const assistantMessages: UnknownRecord[] = [];
		const assistantMessageObjects = new Set<UnknownRecord>();
		const toolResults: TaskToolResult[] = [];
		const toolResultIds = new Set<string>();
		let toolStarts = 0;
		let latestAssistant: UnknownRecord | undefined;
		let activeRun: ActiveRun | undefined;

		const recordAssistant = (value: unknown): void => {
			const message = assistantMessage(value);
			if (!message) return;
			latestAssistant = message;
			if (!assistantMessageObjects.has(message)) {
				assistantMessageObjects.add(message);
				assistantMessages.push(message);
			}
		};
		const collectToolResult = (toolName: unknown, result: unknown, isError: unknown, toolCallId: unknown): void => {
			if (typeof toolName !== "string" || toolName.length === 0) return;
			if (typeof toolCallId === "string" && toolResultIds.has(toolCallId)) return;
			if (typeof toolCallId === "string") toolResultIds.add(toolCallId);
			toolResults.push({
				toolName,
				details: resultDetails(result),
				isError: isError === true,
			});
		};
		const collectToolResultMessage = (value: unknown): void => {
			const message = asRecord(value);
			if (message?.role !== "toolResult") return;
			collectToolResult(message.toolName, message, message.isError, message.toolCallId);
		};

		const handleEvent = (rawEvent: unknown): void => {
			const event = asRecord(rawEvent);
			if (!event) return;
			const type = stringValue(event.type);
			if (type === "tool_execution_start" || type === "tool_start" || type === "tool_started") {
				const toolName = stringValue(event.toolName);
				if (!toolName) return;
				toolStarts += 1;
				notify?.({ type: "tool_started", toolName });
				onToolStart?.(toolName);
				if (maxToolStarts !== undefined && toolStarts > maxToolStarts && activeRun) {
					activeRun.abortRequested = true;
					activeRun.abortReason ??= `Maximum tool starts exceeded (${maxToolStarts}).`;
					void activeRun.requestAbort(activeRun.abortReason);
				}
				return;
			}
			if (type === "tool_execution_end" || type === "tool_end" || type === "tool_result") {
				collectToolResult(event.toolName, event.result, event.isError, event.toolCallId);
				return;
			}
			if (type === "turn_end") {
				recordAssistant(event.message);
				if (Array.isArray(event.toolResults)) {
					for (const result of event.toolResults) {
						const record = asRecord(result);
						if (record) collectToolResult(record.toolName, record, record.isError, record.toolCallId);
					}
				}
				return;
			}
			if (type === "message_end") {
				collectToolResultMessage(event.message);
				recordAssistant(event.message);
				return;
			}
			if (type === "agent_end") {
				finalMessages = eventMessages(event);
				for (const message of finalMessages) {
					collectToolResultMessage(message);
					recordAssistant(message);
				}
			}
		};

		try {
			const factory = this.options.sessionFactory ?? defaultSessionFactory;
			const created = await factory({
				model: resolved.model,
				modelProvider: resolved.provider,
				modelId: resolved.id,
				thinkingLevel: resolved.thinkingLevel,
				cwd: this.options.cwd ?? process.cwd(),
				agentDir: normalizeAgentDir(this.options.agentDir),
				systemPrompt: normalized.systemPrompt,
				tools: normalized.allowedTools,
				allowedTools: normalized.allowedTools,
				customTools: normalized.customTools,
				modelRuntime: handle.runtime,
				modelRegistry: handle.legacyRegistry,
				resourceLoader: createMinimalResourceLoader(
					normalized.systemPrompt,
					handle.piModule?.createExtensionRuntime?.(),
				),
			});
			session = sessionFromFactoryResult(created);
			activeRun = {
				session,
				abortRequested: false,
				requestAbort: async (reason: string, classifyAsAbort = true): Promise<void> => {
					if (!activeRun) return;
					if (classifyAsAbort) {
						activeRun.abortRequested = true;
						activeRun.abortReason ??= reason;
					}
					if (!activeRun.abortPromise) {
						activeRun.abortPromise = (async () => {
							try {
								await session?.abort();
							} catch (error) {
								activeRun!.abortError = error;
							}
						})();
					}
					await activeRun.abortPromise;
				},
			};
			this.activeRuns.add(activeRun);
			const abortListener = (): void => {
				if (activeRun) {
					activeRun.abortRequested = true;
					activeRun.abortReason ??= abortText(signal);
					void activeRun.requestAbort(activeRun.abortReason);
				}
			};
			if (signal) {
				signal.addEventListener("abort", abortListener, { once: true });
				if (signal.aborted) abortListener();
			}
			try {
				// This must remain directly before prompt: subscriptions must see the
				// first user message and every tool event.
				unsubscribe = session.subscribe(handleEvent);
				if (activeRun.abortRequested) {
					await activeRun.requestAbort(activeRun.abortReason ?? "Task aborted.");
				} else {
					await session.prompt(normalized.userPrompt);
					if (signal?.aborted) {
						activeRun.abortRequested = true;
						activeRun.abortReason ??= abortText(signal);
						await activeRun.requestAbort(activeRun.abortReason);
					}
				}
			} catch (error) {
				runError = errorText(error);
				if (signal?.aborted) {
					activeRun.abortRequested = true;
					activeRun.abortReason ??= abortText(signal);
					void activeRun.requestAbort(activeRun.abortReason);
				} else if (!activeRun.abortRequested) {
					void activeRun.requestAbort("Prompt failed.", false);
				}
			} finally {
				if (signal) signal.removeEventListener("abort", abortListener);
				if (activeRun.abortPromise) await activeRun.abortPromise;
			}
			const sessionMessages = Array.isArray(session.messages) ? session.messages : [];
			if (finalMessages.length === 0 && sessionMessages.length > 0) finalMessages = sessionMessages;
			for (const message of sessionMessages) {
				collectToolResultMessage(message);
				recordAssistant(message);
			}
			latestAssistant = lastAssistant(finalMessages) ?? latestAssistant;
		} catch (error) {
			runError = errorText(error);
		} finally {
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch (error) {
					cleanupError = error;
				}
			}
			if (activeRun?.abortPromise) await activeRun.abortPromise;
			if (session) {
				try {
					session.dispose();
				} catch (error) {
					cleanupError ??= error;
				}
			}
			if (activeRun) this.activeRuns.delete(activeRun);
		}

		if (cleanupError && !runError) runError = `Pi task cleanup failed: ${errorText(cleanupError)}`;
		const final = lastAssistant(finalMessages) ?? latestAssistant ?? lastAssistant(assistantMessages);
		const finalAssistantMessages = finalMessages
			.map((message) => assistantMessage(message))
			.filter((message): message is UnknownRecord => message !== undefined);
		const usageMessages = finalAssistantMessages.length > 0 ? finalAssistantMessages : assistantMessages;
		return taskOutcomeFromFinal(
			final,
			usageMessages,
			toolResults,
			activeRun?.abortRequested ?? signal?.aborted ?? false,
			activeRun?.abortReason,
			runError,
		);
	}

	async runTask(task: PiTask, options?: RunTaskOptions): Promise<TaskOutcome> {
		return this.run(task, options);
	}

	async abortAll(): Promise<void> {
		const runs = [...this.activeRuns];
		const failures: unknown[] = [];
		await Promise.all(
			runs.map(async (run) => {
				await run.requestAbort("All active tasks aborted.");
				if (run.abortError !== undefined) failures.push(run.abortError);
			}),
		);
		if (failures.length > 0) {
			throw new AggregateError(failures, "One or more Pi sessions failed to abort.");
		}
	}

	private async runtime(): Promise<RuntimeHandle> {
		if (this.options.modelRuntime !== undefined) {
			const runtime = this.options.modelRuntime;
			return {
				runtime,
				modern: hasFunction(runtime, "getModels") || hasFunction(runtime, "getModel"),
				legacy: hasFunction(runtime, "getAll") || hasFunction(runtime, "find"),
			};
		}
		this.runtimePromise ??= createRuntime(normalizeAgentDir(this.options.agentDir));
		return this.runtimePromise;
	}

	private async resolveModel(handle: RuntimeHandle): Promise<ResolvedTaskModel> {
		if (this.options.modelResolver) {
			return normalizeResolvedModel(
				await this.options.modelResolver({ modelSpec: this.modelSpec, modelRuntime: handle.runtime }),
				this.modelSpec,
			);
		}
		if (this.resolvedModelPromise) return this.resolvedModelPromise;
		this.resolvedModelPromise = (async () => {
			const installed = handle.piModule ? await resolveWithInstalledResolver(handle.piModule, handle, this.modelSpec) : undefined;
			return installed ?? resolveWithoutInstalledResolver(handle, this.modelSpec);
		})();
		return this.resolvedModelPromise;
	}

	private async verifyAuth(handle: RuntimeHandle, resolved: ResolvedTaskModel): Promise<void> {
		if (this.options.verifyAuth) {
			if (!(await this.options.verifyAuth({ model: resolved.model, provider: resolved.provider, modelRuntime: handle.runtime }))) {
				throw new Error(`No configured authentication for provider "${resolved.provider}".`);
			}
			return;
		}
		const runtime = handle.runtime;
		if (hasFunction(runtime, "hasConfiguredAuth")) {
			const argument = handle.legacy && !handle.modern ? resolved.model : resolved.provider;
			const configured = await callMethod(runtime, "hasConfiguredAuth", [argument]);
			if (configured !== true) throw new Error(`No configured authentication for provider "${resolved.provider}".`);
			return;
		}
		if (hasFunction(runtime, "getProviderAuthStatus")) {
			const status = asRecord(await callMethod(runtime, "getProviderAuthStatus", [resolved.provider]));
			if (status?.configured === true) return;
		}
		if (hasFunction(runtime, "checkAuth")) {
			const status = await callMethod(runtime, "checkAuth", [resolved.provider]);
			const statusRecord = asRecord(status);
			if (status !== undefined && status !== null && status !== false && statusRecord?.configured !== false) return;
		}
		throw new Error(`Pi runtime cannot verify authentication for provider "${resolved.provider}".`);
	}
}

export function createPiTaskRunner(options: PiTaskRunnerOptions): PiTaskRunner {
	return new PiTaskRunner(options);
}

export const createTaskRunner = createPiTaskRunner;

export async function runPiTask(task: PiTask, options: PiTaskRunnerOptions, runOptions?: RunTaskOptions): Promise<TaskOutcome> {
	return new PiTaskRunner(options).run(task, runOptions);
}

export { PiTaskRunner as TaskRunner };

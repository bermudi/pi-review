#!/usr/bin/env bun

import { readFile as readUtf8File } from "node:fs/promises";

import { z } from "zod";

import type {
	Finding,
	ReviewEvent,
	ReviewInput,
	ReviewMode,
	ReviewOptions,
	ReviewResult,
	ReviewStatus,
	ThinkingLevel,
} from "./types.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const SIGNALS = ["SIGINT", "SIGTERM"] as const;

type SignalName = (typeof SIGNALS)[number];
type SignalListener = () => void;
type FileEncoding = "utf8";

type RawCliValues = {
	repo?: string;
	model?: string;
	thinking?: string;
	base?: string;
	head?: string;
	commit?: string;
	include: string[];
	exclude: string[];
	background?: string;
	backgroundFile?: string;
	rulesFile?: string;
	concurrency?: string;
	maxToolRounds?: string;
	planThreshold?: string;
	agentDir?: string;
	sessionDir?: string;
	json: boolean;
	help: boolean;
};

const optionValue = z
	.string()
	.min(1)
	.refine((value) => !value.includes("\0"));

const rawCliValuesSchema = z.object({
	repo: optionValue.optional(),
	model: optionValue.optional(),
	thinking: optionValue.optional(),
	base: optionValue.optional(),
	head: optionValue.optional(),
	commit: optionValue.optional(),
	include: z.array(optionValue),
	exclude: z.array(optionValue),
	background: optionValue.optional(),
	backgroundFile: optionValue.optional(),
	rulesFile: optionValue.optional(),
	concurrency: optionValue.optional(),
	maxToolRounds: optionValue.optional(),
	planThreshold: optionValue.optional(),
	agentDir: optionValue.optional(),
	sessionDir: optionValue.optional(),
	json: z.boolean(),
	help: z.boolean(),
}).strict();

/** Parsed, semantically validated command-line options. */
export interface CliOptions {
	readonly help: boolean;
	readonly repo: string;
	readonly model: string | undefined;
	readonly thinking: ThinkingLevel | undefined;
	readonly mode: ReviewMode;
	readonly include: readonly string[];
	readonly exclude: readonly string[];
	readonly background: string | undefined;
	readonly backgroundFile: string | undefined;
	readonly rulesFile: string | undefined;
	readonly concurrency: number | undefined;
	readonly maxToolRounds: number | undefined;
	readonly planThreshold: number | undefined;
	readonly agentDir: string | undefined;
	readonly sessionDir: string | undefined;
	readonly json: boolean;
}

/** A controlled error suitable for displaying as command-line usage output. */
export class CliUsageError extends Error {
	readonly kind = "usage" as const;

	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

/** The small reviewer seam used by the CLI and its tests. */
export interface CliReviewer {
	review(input: ReviewInput, options: ReviewOptions): Promise<ReviewResult>;
}

/** UTF-8 file-reading seam used for background and rules files. */
export type Utf8FileReader = (
	path: string,
	encoding: FileEncoding,
) => Promise<string> | string;

/** Process and stream seams used by the CLI. */
export interface CliIo {
	readonly cwd: () => string;
	readonly env: () => Record<string, string | undefined>;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly onSignal: (signal: SignalName, listener: SignalListener) => void;
	readonly offSignal: (signal: SignalName, listener: SignalListener) => void;
}

export interface CliIoOverrides {
	readonly cwd?: () => string;
	readonly env?: () => Record<string, string | undefined>;
	readonly stdout?: (text: string) => void;
	readonly stderr?: (text: string) => void;
	readonly onSignal?: (signal: SignalName, listener: SignalListener) => void;
	readonly offSignal?: (signal: SignalName, listener: SignalListener) => void;
}

/** Replaceable boundaries for deterministic CLI tests. */
export interface CliDependencies {
	readonly reviewer?: CliReviewer;
	readonly reviewerFactory?: () => CliReviewer | Promise<CliReviewer>;
	readonly io?: CliIoOverrides;
	readonly readFile?: Utf8FileReader;
	readonly fileReader?: Utf8FileReader;
}

export const HELP_TEXT = `Usage: pi-review [-m provider/model[:thinking]] [options]

Review the current workspace by default, or a selected Git target.

Options:
  --repo PATH                 Repository to review (default: current directory)
  -m, --model PROVIDER/MODEL  Model reference, optionally with :thinking;
                              required unless PI_REVIEW_MODEL is set
  --thinking LEVEL            off, minimal, low, medium, high, xhigh, or max
  --base REF [--head REF]    Review the range from REF to REF (head defaults to HEAD)
  --commit REF               Review one commit
  --include PATTERN          Include a path pattern (repeatable)
  --exclude PATTERN          Exclude a path pattern (repeatable)
  --background TEXT          Extra review background
  --background-file PATH     Read review background as UTF-8
  --rules-file PATH          Read review rules as UTF-8
  --concurrency N            Maximum concurrent file reviews
  --max-tool-rounds N        Maximum tool rounds per task
  --plan-threshold N         Changed-line threshold for risk planning
  --agent-dir PATH           Pi agent directory
  --session-dir PATH         Write per-task session transcripts (.jsonl) under PATH
  --json                     Emit the exact ReviewResult as JSON
  --help                     Show this help

Exit status: 0 complete or skipped, 2 partial, 1 failed or invalid usage.
`;

const knownValueOptions = new Set([
	"repo",
	"model",
	"thinking",
	"base",
	"head",
	"commit",
	"include",
	"exclude",
	"background",
	"background-file",
	"rules-file",
	"concurrency",
	"max-tool-rounds",
	"plan-threshold",
	"agent-dir",
	"session-dir",
]);

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function optionSyntaxError(message: string): never {
	throw new CliUsageError(message);
}

function setValue(raw: RawCliValues, name: string, value: string): void {
	switch (name) {
		case "repo":
			if (raw.repo !== undefined) optionSyntaxError("Duplicate --repo option.");
			raw.repo = value;
			return;
		case "model":
			if (raw.model !== undefined) optionSyntaxError("Duplicate --model option.");
			raw.model = value;
			return;
		case "thinking":
			if (raw.thinking !== undefined) optionSyntaxError("Duplicate --thinking option.");
			raw.thinking = value;
			return;
		case "base":
			if (raw.base !== undefined) optionSyntaxError("Duplicate --base option.");
			raw.base = value;
			return;
		case "head":
			if (raw.head !== undefined) optionSyntaxError("Duplicate --head option.");
			raw.head = value;
			return;
		case "commit":
			if (raw.commit !== undefined) optionSyntaxError("Duplicate --commit option.");
			raw.commit = value;
			return;
		case "include":
			raw.include.push(value);
			return;
		case "exclude":
			raw.exclude.push(value);
			return;
		case "background":
			if (raw.background !== undefined) optionSyntaxError("Duplicate --background option.");
			raw.background = value;
			return;
		case "background-file":
			if (raw.backgroundFile !== undefined) optionSyntaxError("Duplicate --background-file option.");
			raw.backgroundFile = value;
			return;
		case "rules-file":
			if (raw.rulesFile !== undefined) optionSyntaxError("Duplicate --rules-file option.");
			raw.rulesFile = value;
			return;
		case "concurrency":
			if (raw.concurrency !== undefined) optionSyntaxError("Duplicate --concurrency option.");
			raw.concurrency = value;
			return;
		case "max-tool-rounds":
			if (raw.maxToolRounds !== undefined) optionSyntaxError("Duplicate --max-tool-rounds option.");
			raw.maxToolRounds = value;
			return;
		case "plan-threshold":
			if (raw.planThreshold !== undefined) optionSyntaxError("Duplicate --plan-threshold option.");
			raw.planThreshold = value;
			return;
		case "agent-dir":
			if (raw.agentDir !== undefined) optionSyntaxError("Duplicate --agent-dir option.");
			raw.agentDir = value;
			return;
		case "session-dir":
			if (raw.sessionDir !== undefined) optionSyntaxError("Duplicate --session-dir option.");
			raw.sessionDir = value;
			return;
		default:
			optionSyntaxError("Unknown command-line option.");
	}
}

function parseRawArgv(argv: readonly string[]): RawCliValues {
	const raw: RawCliValues = {
		include: [],
		exclude: [],
		json: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const token = expandShortOptions(argv[index] as string);
		if (token === undefined || !token.startsWith("--") || token === "--") {
			optionSyntaxError("Arguments must use the documented --option form.");
		}

		const equalsIndex = token.indexOf("=");
		const name = equalsIndex === -1 ? token.slice(2) : token.slice(2, equalsIndex);
		const hasInlineValue = equalsIndex !== -1;
		if (name.length === 0) optionSyntaxError("Empty command-line option.");

		if (name === "help" || name === "json") {
			if (hasInlineValue) optionSyntaxError(`--${name} does not take a value.`);
			if (name === "help") {
				if (raw.help) optionSyntaxError("Duplicate --help option.");
				raw.help = true;
			} else {
				if (raw.json) optionSyntaxError("Duplicate --json option.");
				raw.json = true;
			}
			continue;
		}

		if (!knownValueOptions.has(name)) optionSyntaxError("Unknown command-line option.");
		let value: string | undefined;
		if (hasInlineValue) {
			value = token.slice(equalsIndex + 1);
		} else {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) {
				optionSyntaxError(`--${name} requires a value.`);
			}
			value = next;
			index += 1;
		}
		if (value === undefined || value.length === 0) optionSyntaxError(`--${name} requires a non-empty value.`);
		setValue(raw, name, value);
	}

	const parsed = rawCliValuesSchema.safeParse(raw);
	if (!parsed.success) optionSyntaxError("Invalid command-line arguments.");
	return parsed.data;
}

/**
 * `-m` is the documented shorthand for `--model`. It accepts both the
 * separate-value (`-m provider/model`) and inline (`-m=provider/model`) forms;
 * everything else flows through the ordinary `--option` parser below.
 */
function expandShortOptions(token: string): string {
	if (token === "-m") return "--model";
	if (token.startsWith("-m=")) return `--model=${token.slice(3)}`;
	return token;
}

function parseInteger(value: string | undefined, option: string, minimum: number): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/u.test(value)) {
		optionSyntaxError(`Invalid --${option}; expected a ${minimum === 0 ? "non-negative" : "positive"} safe integer.`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		optionSyntaxError(`Invalid --${option}; expected a ${minimum === 0 ? "non-negative" : "positive"} safe integer.`);
	}
	return parsed;
}

function validateModel(model: string): void {
	if (model.length === 0 || model.includes("\0") || /\s/u.test(model)) {
		optionSyntaxError("Invalid --model; expected provider/model[:thinking] or model[:thinking].");
	}
}

function validateMode(values: RawCliValues): ReviewMode {
	const hasRange = values.base !== undefined || values.head !== undefined;
	if (hasRange && values.base === undefined) {
		optionSyntaxError("--base is required when --head is supplied.");
	}
	if (values.commit !== undefined && hasRange) {
		optionSyntaxError("--commit cannot be combined with --base or --head.");
	}
	if (values.commit !== undefined) return { kind: "commit", ref: values.commit };
	if (hasRange) return { kind: "range", base: values.base as string, head: values.head ?? "HEAD" };
	return { kind: "workspace" };
}

/**
 * Parse and validate argv without touching the filesystem or process state.
 * `--help` intentionally bypasses the required-model check so it is useful on
 * its own.
 *
 * The model may come from `--model` or, when absent, from the `PI_REVIEW_MODEL`
 * environment variable. An explicit flag always wins; a blank or missing env
 * value behaves as unset. The env value gets the same validation as the flag.
 */
export function parseArgs(
	argv: readonly unknown[],
	cwd = process.cwd(),
	env: Record<string, string | undefined> = process.env,
): CliOptions {
	const parsedArgv = z.array(z.string()).safeParse(argv);
	if (!parsedArgv.success) optionSyntaxError("Arguments must be strings.");

	const values = parseRawArgv(parsedArgv.data);
	if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
		optionSyntaxError("Current directory is invalid.");
	}
	if (values.help) {
		return {
			help: true,
			repo: values.repo ?? cwd,
			model: values.model,
			thinking: undefined,
			mode: { kind: "workspace" },
			include: [...values.include],
			exclude: [...values.exclude],
			background: values.background,
			backgroundFile: values.backgroundFile,
			rulesFile: values.rulesFile,
			concurrency: undefined,
			maxToolRounds: undefined,
			planThreshold: undefined,
			agentDir: values.agentDir,
			sessionDir: values.sessionDir,
			json: values.json,
		};
	}

	const envModel = env?.PI_REVIEW_MODEL?.trim();
	const model = values.model ?? (envModel === undefined || envModel.length === 0 ? undefined : envModel);
	if (model === undefined) {
		optionSyntaxError("Missing required --model option; pass --model or set PI_REVIEW_MODEL.");
	}
	validateModel(model);

	let thinking: ThinkingLevel | undefined;
	if (values.thinking !== undefined) {
		if (!isThinkingLevel(values.thinking)) optionSyntaxError("Invalid --thinking value.");
		thinking = values.thinking;
	}
	if (values.background !== undefined && values.backgroundFile !== undefined) {
		optionSyntaxError("--background and --background-file are mutually exclusive.");
	}

	return {
		help: false,
		repo: values.repo ?? cwd,
		model,
		thinking,
		mode: validateMode(values),
		include: [...values.include],
		exclude: [...values.exclude],
		background: values.background,
		backgroundFile: values.backgroundFile,
		rulesFile: values.rulesFile,
		concurrency: parseInteger(values.concurrency, "concurrency", 1),
		maxToolRounds: parseInteger(values.maxToolRounds, "max-tool-rounds", 1),
		planThreshold: parseInteger(values.planThreshold, "plan-threshold", 0),
		agentDir: values.agentDir,
		sessionDir: values.sessionDir,
		json: values.json,
	};
}

/** Alias with a name that reads naturally at call sites. */
export const parseCliArgs = parseArgs;

function defaultIo(): CliIo {
	return {
		cwd: () => process.cwd(),
		env: () => process.env,
		stdout: (text) => {
			process.stdout.write(text);
		},
		stderr: (text) => {
			process.stderr.write(text);
		},
		onSignal: (signal, listener) => {
			process.on(signal, listener);
		},
		offSignal: (signal, listener) => {
			process.off(signal, listener);
		},
	};
}

function makeIo(overrides: CliIoOverrides | undefined): CliIo {
	const defaults = defaultIo();
	return {
		cwd: overrides?.cwd ?? defaults.cwd,
		env: overrides?.env ?? defaults.env,
		stdout: overrides?.stdout ?? defaults.stdout,
		stderr: overrides?.stderr ?? defaults.stderr,
		onSignal: overrides?.onSignal ?? defaults.onSignal,
		offSignal: overrides?.offSignal ?? defaults.offSignal,
	};
}

function oneLine(value: string): string {
	return value.replace(/[\r\n]+/gu, " ");
}

/** Render one reviewer event as a single stderr progress line. */
export function formatProgress(event: ReviewEvent): string {
	switch (event.type) {
		case "review_started":
			return `Review started: ${event.files} file(s).\n`;
		case "file_started":
			return `Reviewing ${oneLine(event.path)}.\n`;
		case "tool_started":
			return `Evidence: ${oneLine(event.path)} -> ${oneLine(event.tool)}.\n`;
		case "file_completed":
			return `Completed ${oneLine(event.path)}: ${event.findings} finding(s).\n`;
		case "file_failed":
			return `Failed ${oneLine(event.path)}: ${oneLine(event.reason)}.\n`
				+ (event.sessionFile === undefined ? "" : `Session: ${oneLine(event.sessionFile)}\n`);
		case "warning":
			return `Warning: ${oneLine(event.message)}\n`;
	}
}

function formatList(values: readonly string[]): string {
	return values.length === 0 ? "(none)" : values.join(", ");
}

function formatFailureList(values: ReadonlyArray<{ readonly path: string; readonly reason: string }>): string {
	return values.length === 0
		? "(none)"
		: values.map((value) => `${value.path} (${value.reason})`).join(", ");
}

function findingLocation(finding: Finding): string {
	return finding.startLine === finding.endLine
		? `${finding.path}:${finding.startLine}`
		: `${finding.path}:${finding.startLine}-${finding.endLine}`;
}

function indentMultiline(prefix: string, value: string): string[] {
	const lines = value.split(/\r?\n/u);
	return lines.map((line, index) => `${prefix}${index === 0 ? "" : "  "}${line}`);
}

/** Render the human-readable result. It deliberately contains no ANSI codes. */
export function renderText(result: ReviewResult): string {
	const lines: string[] = [
		`Status: ${result.status}`,
		`Message: ${result.message}`,
		"Coverage:",
		`  selected: ${formatList(result.coverage.selected)}`,
		`  completed: ${formatList(result.coverage.completed)}`,
		`  failed: ${formatFailureList(result.coverage.failed)}`,
		`  skipped: ${formatFailureList(result.coverage.skipped)}`,
		"Warnings:",
	];

	if (result.warnings.length === 0) {
		lines.push("  (none)");
	} else {
		for (const warning of result.warnings) lines.push(...indentMultiline("  - ", warning));
	}

	lines.push("Findings:");
	if (result.findings.length === 0) {
		lines.push("  (none)");
	} else {
		for (const finding of result.findings) {
			lines.push(`  - ${finding.severity}/${finding.category} ${findingLocation(finding)}`);
			lines.push(...indentMultiline("    ", finding.content));
			lines.push(...indentMultiline("    Existing: ", finding.existingCode));
			if (finding.suggestionCode !== undefined) {
				lines.push(...indentMultiline("    Suggestion: ", finding.suggestionCode));
			}
		}
	}

	return `${lines.join("\n")}\n`;
}

/** JSON output is intentionally the result object itself, without an envelope. */
export function renderJson(result: ReviewResult): string {
	return `${JSON.stringify(result)}\n`;
}

export function exitCodeForResult(result: ReviewResult | ReviewStatus): number {
	const status = typeof result === "string" ? result : result.status;
	switch (status) {
		case "complete":
		case "skipped":
			return 0;
		case "partial":
			return 2;
		case "failed":
		default:
			return 1;
	}
}

async function defaultReviewer(): Promise<CliReviewer> {
	const reviewerModule = await import("./reviewer.js");
	return new reviewerModule.Reviewer();
}

async function readOptionFile(
	reader: Utf8FileReader,
	path: string,
): Promise<string> {
	const value = await reader(path, "utf8");
	if (typeof value !== "string") throw new Error("file reader returned non-text data");
	return value;
}

function reportUsage(io: CliIo, error: CliUsageError): void {
	io.stderr(`Error: ${error.message}\n\n${HELP_TEXT}`);
}

/**
 * Execute the CLI without calling process.exit. This is the primary test seam;
 * production invocation is the small import.meta.main block at the bottom.
 */
export async function runCli(
	argv: readonly unknown[] = process.argv.slice(2),
	dependencies: CliDependencies = {},
): Promise<number> {
	const io = makeIo(dependencies.io);
	let parsed: CliOptions;
	try {
		parsed = parseArgs(argv, io.cwd(), io.env());
	} catch (error) {
		if (error instanceof CliUsageError) {
			reportUsage(io, error);
		} else {
			io.stderr("Error: Unable to parse command-line arguments.\n");
		}
		return 1;
	}

	if (parsed.help) {
		io.stdout(HELP_TEXT);
		return 0;
	}

	const controller = new AbortController();
	const onSignal = (): void => {
		controller.abort();
	};
	const registeredSignals: SignalName[] = [];
	try {
		for (const signal of SIGNALS) {
			io.onSignal(signal, onSignal);
			registeredSignals.push(signal);
		}

		const reader = dependencies.readFile ?? dependencies.fileReader ?? ((path: string, _encoding: FileEncoding) => readUtf8File(path, "utf8"));
		let background = parsed.background;
		if (parsed.backgroundFile !== undefined) {
			try {
				background = await readOptionFile(reader, parsed.backgroundFile);
			} catch {
				io.stderr("Error: Unable to read --background-file as UTF-8.\n");
				return 1;
			}
		}
		let rules: string | undefined;
		if (parsed.rulesFile !== undefined) {
			try {
				rules = await readOptionFile(reader, parsed.rulesFile);
			} catch {
				io.stderr("Error: Unable to read --rules-file as UTF-8.\n");
				return 1;
			}
		}

		const input: ReviewInput = {
			repository: parsed.repo,
			mode: parsed.mode,
			...(background === undefined ? {} : { background }),
			...(rules === undefined ? {} : { rules }),
		};
		const options: ReviewOptions = {
			model: parsed.model as string,
			onEvent: (event) => io.stderr(formatProgress(event)),
			signal: controller.signal,
			...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
			...(parsed.concurrency === undefined ? {} : { concurrency: parsed.concurrency }),
			...(parsed.include.length === 0 ? {} : { include: [...parsed.include] }),
			...(parsed.exclude.length === 0 ? {} : { exclude: [...parsed.exclude] }),
			...(parsed.maxToolRounds === undefined ? {} : { maxToolRounds: parsed.maxToolRounds }),
			...(parsed.planThreshold === undefined ? {} : { planChangedLineThreshold: parsed.planThreshold }),
			...(parsed.agentDir === undefined ? {} : { agentDir: parsed.agentDir }),
			...(parsed.sessionDir === undefined ? {} : { sessionDir: parsed.sessionDir }),
		};

		let reviewer: CliReviewer;
		try {
			reviewer = dependencies.reviewer
				?? (dependencies.reviewerFactory === undefined ? await defaultReviewer() : await dependencies.reviewerFactory());
		} catch {
			io.stderr("Error: Unable to initialize the reviewer.\n");
			return 1;
		}
		if (reviewer === undefined || typeof reviewer.review !== "function") {
			io.stderr("Error: Unable to initialize the reviewer.\n");
			return 1;
		}

		let result: ReviewResult;
		try {
			result = await reviewer.review(input, options);
		} catch {
			io.stderr("Error: Review failed before producing a result.\n");
			return 1;
		}

		io.stdout(parsed.json ? renderJson(result) : renderText(result));
		return exitCodeForResult(result);
	} finally {
		for (const signal of registeredSignals) io.offSignal(signal, onSignal);
	}
}

/** Production entry point, also useful to hosts that want a named main. */
export async function main(
	argv: readonly unknown[] = process.argv.slice(2),
	dependencies: CliDependencies = {},
): Promise<number> {
	return runCli(argv, dependencies);
}

if (import.meta.main) {
	void main().then((exitCode) => {
		process.exitCode = exitCode;
	}).catch(() => {
		process.exitCode = 1;
	});
}

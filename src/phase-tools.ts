import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { type Static, type TSchema, Type } from "typebox";

/** The evidence tools a plan may ask the later review worker to use. */
export const PLAN_TOOL_NAMES = ["file_read", "code_search", "file_read_diff", "file_find"] as const;

export type PlanToolName = (typeof PLAN_TOOL_NAMES)[number];
export type PlanSeverity = "high" | "medium" | "low";

/** Conservative limits keep a planner's result useful as a compact prompt input. */
export const MAX_PLAN_SUMMARY_LENGTH = 500;
export const MAX_PLAN_ISSUES = 8;
export const MAX_PLAN_DESCRIPTION_LENGTH = 1_500;
export const MAX_TOOL_GUIDANCE_PER_ISSUE = 4;
export const MAX_TOOL_GUIDANCE_REASON_LENGTH = 500;
export const MAX_TOOL_GUIDANCE_ARGUMENTS_LENGTH = 1_000;

const planSeveritySchema = Type.Union([
	Type.Literal("high"),
	Type.Literal("medium"),
	Type.Literal("low"),
]);

const planToolNameSchema = Type.Union([
	Type.Literal("file_read"),
	Type.Literal("code_search"),
	Type.Literal("file_read_diff"),
	Type.Literal("file_find"),
]);

const toolGuidanceSchema = Type.Object(
	{
		name: planToolNameSchema,
		reason: Type.String({
			minLength: 1,
			maxLength: MAX_TOOL_GUIDANCE_REASON_LENGTH,
			description: "The concrete evidence this bounded call should obtain",
		}),
		arguments: Type.String({
			minLength: 1,
			maxLength: MAX_TOOL_GUIDANCE_ARGUMENTS_LENGTH,
			description: "Bounded arguments for the named evidence tool",
		}),
	},
	{ additionalProperties: false },
);

const planIssueSchema = Type.Object(
	{
		severity: planSeveritySchema,
		description: Type.String({
			minLength: 1,
			maxLength: MAX_PLAN_DESCRIPTION_LENGTH,
			description: "A specific, actionable risk and its likely impact",
		}),
		tool_guidance: Type.Array(toolGuidanceSchema, {
			maxItems: MAX_TOOL_GUIDANCE_PER_ISSUE,
			description: `At most ${MAX_TOOL_GUIDANCE_PER_ISSUE} bounded evidence calls`,
		}),
	},
	{ additionalProperties: false },
);

/** The exact structured value accepted by submit_plan. */
export const riskPlanParameters = Type.Object(
	{
		change_summary: Type.String({
			minLength: 1,
			maxLength: MAX_PLAN_SUMMARY_LENGTH,
			description: "A short summary of the changed code's scope",
		}),
		issues: Type.Array(planIssueSchema, {
			maxItems: MAX_PLAN_ISSUES,
			description: `Zero to ${MAX_PLAN_ISSUES} prioritized risks`,
		}),
	},
	{ additionalProperties: false },
);

export type RiskPlan = Static<typeof riskPlanParameters>;
export type PlanIssue = RiskPlan["issues"][number];
export type ToolGuidance = PlanIssue["tool_guidance"][number];

/** A plan toolkit owns one terminating submit_plan call. */
export interface PlanToolkit {
	readonly tools: readonly ToolDefinition[];
	readonly value: RiskPlan | undefined;
	/** Named alias for callers that do not use the generic value property. */
	readonly plan: RiskPlan | undefined;
}

/** A veto toolkit owns one terminating submit_veto call. */
export interface VetoToolkit {
	readonly tools: readonly ToolDefinition[];
	readonly value: readonly string[] | undefined;
	/** Named alias for callers that do not use the generic value property. */
	readonly vetoedIds: readonly string[] | undefined;
}

interface PlanState {
	value: RiskPlan | undefined;
	terminated: boolean;
}

interface VetoState {
	value: readonly string[] | undefined;
	terminated: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function isNonBlank(value: string): boolean {
	return value.trim().length > 0;
}

function validationDetail(schema: TSchema, value: unknown): string {
	const first = Value.Errors(schema, value)[0];
	if (first === undefined) return "value does not match the required schema";
	const location = first.instancePath.length > 0 ? ` at ${first.instancePath}` : "";
	return `${first.message}${location}`;
}

function validatePlan(value: unknown): RiskPlan {
	if (!Value.Check(riskPlanParameters, value)) {
		throw new Error(`submit_plan parameters are invalid: ${validationDetail(riskPlanParameters, value)}`);
	}

	const plan = value as RiskPlan;
	if (!isNonBlank(plan.change_summary)) {
		throw new Error("submit_plan.change_summary must not be blank");
	}
	for (const [issueIndex, issue] of plan.issues.entries()) {
		if (!isNonBlank(issue.description)) {
			throw new Error(`submit_plan.issues[${issueIndex}].description must not be blank`);
		}
		for (const [guidanceIndex, guidance] of issue.tool_guidance.entries()) {
			if (!isNonBlank(guidance.reason)) {
				throw new Error(
					`submit_plan.issues[${issueIndex}].tool_guidance[${guidanceIndex}].reason must not be blank`,
				);
			}
			if (!isNonBlank(guidance.arguments)) {
				throw new Error(
					`submit_plan.issues[${issueIndex}].tool_guidance[${guidanceIndex}].arguments must not be blank`,
				);
			}
		}
	}

	return {
		change_summary: plan.change_summary,
		issues: plan.issues.map((issue) => ({
			severity: issue.severity,
			description: issue.description,
			tool_guidance: issue.tool_guidance.map((guidance) => ({
				name: guidance.name,
				reason: guidance.reason,
				arguments: guidance.arguments,
			})),
		})),
	};
}

function clonePlan(value: RiskPlan): RiskPlan {
	return {
		change_summary: value.change_summary,
		issues: value.issues.map((issue) => ({
			severity: issue.severity,
			description: issue.description,
			tool_guidance: issue.tool_guidance.map((guidance) => ({
				name: guidance.name,
				reason: guidance.reason,
				arguments: guidance.arguments,
			})),
		})),
	};
}

function ensurePending(terminated: boolean, toolName: string): void {
	if (terminated) throw new Error(`${toolName} toolkit has already terminated`);
}

function makePlanTool(state: PlanState): ToolDefinition {
	return defineTool({
		name: "submit_plan",
		label: "submit_plan",
		description:
			"Submit one compact risk plan for the current changed file. This is the final action for the planning stage.",
		promptSnippet: "Submit the validated compact risk plan and terminate",
		promptGuidelines: [
			"Call submit_plan exactly once after planning the current changed file.",
			"Use only the four bounded evidence tool names in the tool_guidance entries.",
		],
		parameters: riskPlanParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			ensurePending(state.terminated, "submit_plan");
			const plan = validatePlan(params);
			throwIfAborted(signal);
			state.value = plan;
			state.terminated = true;
			return {
				content: [{ type: "text", text: "Risk plan submitted." }],
				details: clonePlan(plan),
				terminate: true,
			};
		},
	});
}

function validateCandidateIds(candidateIds: readonly string[]): string[] {
	if (!Array.isArray(candidateIds)) throw new TypeError("candidateIds must be an array");

	const seen = new Set<string>();
	for (const [index, candidateId] of candidateIds.entries()) {
		if (typeof candidateId !== "string" || candidateId.length === 0 || !isNonBlank(candidateId)) {
			throw new TypeError(`candidateIds[${index}] must be a non-blank string`);
		}
		if (seen.has(candidateId)) throw new Error(`candidateIds contains duplicate ID ${JSON.stringify(candidateId)}`);
		seen.add(candidateId);
	}
	return [...candidateIds];
}

function makeCandidateIdSchema(candidateIds: readonly string[]) {
	const literals = candidateIds.map((candidateId) => Type.Literal(candidateId));
	if (literals.length === 0) return Type.Never({ description: "No candidate IDs are available to veto" });
	if (literals.length === 1) {
		const [literal] = literals;
		if (literal !== undefined) return literal;
	}
	return Type.Union(literals);
}

function validateVetoIds(
	value: unknown,
	candidateIds: ReadonlySet<string>,
	parameters: TSchema,
	signal: AbortSignal | undefined,
): string[] {
	throwIfAborted(signal);
	if (!Array.isArray(value)) throw new TypeError("submit_veto expects an array of candidate IDs");

	const ids: string[] = [];
	const seen = new Set<string>();
	for (const [index, candidateId] of value.entries()) {
		throwIfAborted(signal);
		if (typeof candidateId !== "string" || candidateId.length === 0 || !isNonBlank(candidateId)) {
			throw new TypeError(`submit_veto ID at index ${index} must be a non-blank string`);
		}
		if (!candidateIds.has(candidateId)) {
			throw new Error(`submit_veto ID ${JSON.stringify(candidateId)} is unknown`);
		}
		if (seen.has(candidateId)) {
			throw new Error(`submit_veto IDs must be unique; duplicate ${JSON.stringify(candidateId)}`);
		}
		seen.add(candidateId);
		ids.push(candidateId);
	}
	if (!Value.Check(parameters, ids)) {
		throw new Error(`submit_veto parameters are invalid: ${validationDetail(parameters, ids)}`);
	}
	return ids;
}

function makeVetoTool(state: VetoState, candidateIds: readonly string[]): ToolDefinition {
	const suppliedIds = new Set(candidateIds);
	const candidateIdsSchema = Type.Array(makeCandidateIdSchema(candidateIds), {
		maxItems: candidateIds.length,
		uniqueItems: true,
		description: "Unique candidate IDs to veto; an empty array keeps every candidate",
	});
	const parameters = Type.Object(
		{ candidate_ids: candidateIdsSchema },
		{ additionalProperties: false },
	);

	return defineTool({
		name: "submit_veto",
		label: "submit_veto",
		description: "Submit the candidate IDs disproved directly by the current diff and terminate the veto stage.",
		promptSnippet: "Submit the candidate IDs to veto and terminate",
		promptGuidelines: [
			"Call submit_veto exactly once with { candidate_ids: [...] }.",
			"Use only candidate IDs supplied for this veto stage, with no duplicates.",
		],
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			ensurePending(state.terminated, "submit_veto");
			const ids = validateVetoIds(params.candidate_ids, suppliedIds, candidateIdsSchema, signal);
			throwIfAborted(signal);
			state.value = [...ids];
			state.terminated = true;
			return {
				content: [{ type: "text", text: `Veto submitted (${ids.length} candidate${ids.length === 1 ? "" : "s"}).` }],
				details: [...ids],
				terminate: true,
			};
		},
	});
}

export function createPlanToolkit(): PlanToolkit {
	const state: PlanState = { value: undefined, terminated: false };
	const tools = [makePlanTool(state)];
	return {
		tools,
		get value() {
			return state.value === undefined ? undefined : clonePlan(state.value);
		},
		get plan() {
			return state.value === undefined ? undefined : clonePlan(state.value);
		},
	};
}

export function createVetoToolkit(candidateIds: readonly string[]): VetoToolkit {
	const suppliedIds = validateCandidateIds(candidateIds);
	const state: VetoState = { value: undefined, terminated: false };
	const tools = [makeVetoTool(state, suppliedIds)];
	return {
		tools,
		get value() {
			return state.value === undefined ? undefined : [...state.value];
		},
		get vetoedIds() {
			return state.value === undefined ? undefined : [...state.value];
		},
	};
}



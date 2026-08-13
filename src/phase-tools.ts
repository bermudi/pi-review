import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { type Static, type TSchema, Type } from "typebox";

/** The evidence tools a plan may ask the later review worker to use. */
export const PLAN_TOOL_NAMES = ["file_read", "code_search", "file_read_diff", "file_find"] as const;

export type PlanToolName = (typeof PLAN_TOOL_NAMES)[number];
export type PlanSeverity = "high" | "medium" | "low";

/** Conservative limits keep a planner's result useful as a compact prompt input. */
export const MAX_PLAN_SUMMARY_LENGTH = 500;
export const MAX_PLAN_ISSUES = 4;
export const MAX_PLAN_DESCRIPTION_LENGTH = 1_500;
export const MAX_TOOL_GUIDANCE_PER_ISSUE = 1;
export const MAX_PLAN_TOOL_GUIDANCE = 4;
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
			description: `At most ${MAX_TOOL_GUIDANCE_PER_ISSUE} bounded evidence suggestion per risk`,
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
			description: `Zero to ${MAX_PLAN_ISSUES} prioritized risks, with at most ${MAX_PLAN_TOOL_GUIDANCE} total evidence suggestions`,
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

interface PlanState {
	value: RiskPlan | undefined;
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
	let guidanceCount = 0;
	for (const [issueIndex, issue] of plan.issues.entries()) {
		guidanceCount += issue.tool_guidance.length;
		if (issue.tool_guidance.length > MAX_TOOL_GUIDANCE_PER_ISSUE) {
			throw new Error(`submit_plan allows at most ${MAX_TOOL_GUIDANCE_PER_ISSUE} evidence suggestion per risk`);
		}
		if (guidanceCount > MAX_PLAN_TOOL_GUIDANCE) {
			throw new Error(`submit_plan allows at most ${MAX_PLAN_TOOL_GUIDANCE} total evidence suggestions`);
		}
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
			`Return at most ${MAX_PLAN_ISSUES} prioritized risks, with no more than one evidence suggestion per risk and ${MAX_PLAN_TOOL_GUIDANCE} suggestions total.`,
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



import { describe, expect, test } from "bun:test";

import {
	MAX_PLAN_ISSUES,
	MAX_PLAN_TOOL_GUIDANCE,
	MAX_TOOL_GUIDANCE_PER_ISSUE,
	createPlanToolkit,
	createVetoToolkit,
	type PlanToolkit,
	type RiskPlan,
	type VetoToolkit,
} from "../src/phase-tools.ts";

function tool(toolkit: PlanToolkit | VetoToolkit, name: string) {
	const definition = toolkit.tools.find((candidate) => candidate.name === name);
	if (definition === undefined) throw new Error(`Missing tool ${name}`);
	return definition;
}

async function execute(
	toolkit: PlanToolkit | VetoToolkit,
	name: string,
	params: unknown,
	signal?: AbortSignal,
) {
	return tool(toolkit, name).execute("test-call", params, signal, undefined, undefined as never);
}

const validPlan: RiskPlan = {
	change_summary: "Adds bounded phase submission tools.",
	issues: [
		{
			severity: "high",
			description: "The new call can receive an invalid value from an unchecked boundary.",
			tool_guidance: [
				{
					name: "file_read",
					reason: "Read the caller's validation path.",
					arguments: "path=src/caller.ts, offset=1, limit=80",
				},
			],
		},
	],
};

describe("phase toolkits", () => {
	test("submit_plan captures a bounded plan and terminates", async () => {
		const toolkit = createPlanToolkit();
		expect(toolkit.tools.map((candidate) => candidate.name)).toEqual(["submit_plan"]);
		expect(toolkit.value).toBeUndefined();

		const result = await execute(toolkit, "submit_plan", validPlan);

		expect(result).toMatchObject({ terminate: true, details: validPlan });
		expect(toolkit.value).toEqual(validPlan);
		expect(toolkit.plan).toEqual(validPlan);
		await expect(execute(toolkit, "submit_plan", validPlan)).rejects.toThrow(/already terminated/);
	});

	test("submit_plan rejects malformed, oversized, and unbounded guidance", async () => {
		const toolkit = createPlanToolkit();
		await expect(execute(toolkit, "submit_plan", { ...validPlan, issues: [{ ...validPlan.issues[0], severity: "urgent" }] })).rejects.toThrow(
			/invalid/,
		);
		await expect(
			execute(toolkit, "submit_plan", {
				...validPlan,
				issues: [
					{
						...validPlan.issues[0],
						tool_guidance: Array.from({ length: MAX_TOOL_GUIDANCE_PER_ISSUE + 1 }, () => validPlan.issues[0]!.tool_guidance[0]),
					},
				],
			}),
		).rejects.toThrow(/invalid/);
		await expect(
			execute(toolkit, "submit_plan", {
			...validPlan,
				issues: [{ ...validPlan.issues[0], tool_guidance: [{ ...validPlan.issues[0]!.tool_guidance[0], name: "bash" }] }],
		}),
		).rejects.toThrow(/invalid/);
		expect(toolkit.value).toBeUndefined();
	});

	test("submit_plan rejects more than four total evidence suggestions", async () => {
		const toolkit = createPlanToolkit();
		const issues = Array.from({ length: MAX_PLAN_ISSUES + 1 }, (_value, index) => ({
			...validPlan.issues[0]!,
			description: `Risk ${index + 1}`,
		}));
		await expect(execute(toolkit, "submit_plan", { ...validPlan, issues })).rejects.toThrow(/invalid|at most/);
		expect(MAX_PLAN_TOOL_GUIDANCE).toBe(MAX_PLAN_ISSUES);
	});

	test("submit_plan honors cancellation before capture", async () => {
		const toolkit = createPlanToolkit();
		const controller = new AbortController();
		controller.abort();

		await expect(execute(toolkit, "submit_plan", validPlan, controller.signal)).rejects.toThrow(/aborted/i);
		expect(toolkit.value).toBeUndefined();
	});

	test("submit_veto accepts only unique supplied IDs, including an empty result", async () => {
		const toolkit = createVetoToolkit(["c-0", "c-1", "c-2"]);
		expect(toolkit.tools.map((candidate) => candidate.name)).toEqual(["submit_veto"]);
		expect(toolkit.value).toBeUndefined();

		const result = await execute(toolkit, "submit_veto", { candidate_ids: ["c-2", "c-0"] });
		expect(result).toMatchObject({ terminate: true, details: ["c-2", "c-0"] });
		expect(toolkit.value).toEqual(["c-2", "c-0"]);
		expect(toolkit.vetoedIds).toEqual(["c-2", "c-0"]);
		await expect(execute(toolkit, "submit_veto", { candidate_ids: [] })).rejects.toThrow(/already terminated/);

		const keepAll = createVetoToolkit(["c-0"]);
		const empty = await execute(keepAll, "submit_veto", { candidate_ids: [] });
		expect(empty).toMatchObject({ terminate: true, details: [] });
		expect(keepAll.value).toEqual([]);
	});

	test("submit_veto rejects unknown and duplicate IDs, and validates caller IDs", async () => {
		const toolkit = createVetoToolkit(["c-0", "c-1"]);
		await expect(execute(toolkit, "submit_veto", { candidate_ids: ["c-9"] })).rejects.toThrow(/unknown/);
		await expect(execute(toolkit, "submit_veto", { candidate_ids: ["c-0", "c-0"] })).rejects.toThrow(/unique|duplicate/);
		expect(toolkit.value).toBeUndefined();

		expect(() => createVetoToolkit(["c-0", "c-0"])).toThrow(/duplicate/);
		expect(() => createVetoToolkit(["c-0", " "])).toThrow(/non-blank/);
	});

	test("submit_veto honors cancellation before capture", async () => {
		const toolkit = createVetoToolkit(["c-0"]);
		const controller = new AbortController();
		controller.abort();

		await expect(execute(toolkit, "submit_veto", { candidate_ids: ["c-0"] }, controller.signal)).rejects.toThrow(/aborted/i);
		expect(toolkit.value).toBeUndefined();
	});
});

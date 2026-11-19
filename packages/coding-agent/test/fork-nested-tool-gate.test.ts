/**
 * fork: nested calls to a sequential tool run alone, whatever
 * else the calling script started, and a tool's own nested calls never wait for it.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type NestedToolCallHost, NestedToolCallRunner } from "../src/core/nested-tool-calls.ts";

type Run = (callerId: string, name: string) => Promise<unknown>;

function setup(build: (run: Run) => AgentTool[], options: { sequential?: boolean } = {}) {
	let runner: NestedToolCallRunner | undefined;
	const run: Run = (callerId, name) => runner!.execute(callerId, name, {});
	const tools = build(run);
	const host: NestedToolCallHost = {
		getTools: () => tools,
		isSequential: () => options.sequential ?? false,
		runToolCall: async (toolCall, _parentId, signal) => {
			const tool = tools.find((candidate) => candidate.name === toolCall.name)!;
			const result = await tool.execute(toolCall.id, toolCall.arguments, signal);
			return { toolCall, result, isError: false };
		},
		emit: async () => {},
	};
	runner = new NestedToolCallRunner(host);
	return { run };
}

/** A tool that logs its start and end around a short wait, then optionally runs nested calls. */
function tool(
	name: string,
	log: string[],
	options: { sequential?: boolean; children?: (id: string) => Promise<unknown> } = {},
): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		executionMode: options.sequential ? "sequential" : undefined,
		async execute(id) {
			log.push(`start ${name}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
			await options.children?.(id);
			log.push(`end ${name}`);
			return { content: [], details: {} };
		},
	};
}

/** The largest number of tools running at once, and whether a sequential one ever ran with another. */
function overlaps(log: string[], sequential: string[]): { max: number; sequentialShared: boolean } {
	const running = new Set<string>();
	let max = 0;
	let sequentialShared = false;
	for (const line of log) {
		const [kind, name] = line.split(" ");
		if (kind === "start") running.add(name);
		else running.delete(name);
		max = Math.max(max, running.size);
		if (running.size > 1 && [...running].some((n) => sequential.includes(n))) sequentialShared = true;
	}
	return { max, sequentialShared };
}

describe("nested calls to sequential tools", () => {
	it.each([
		["sequential first", ["seq", "par1", "par2"]],
		["sequential last", ["par1", "par2", "seq"]],
		["sequential between", ["par1", "seq", "par2"]],
	])("a mixed batch never runs the sequential tool with another (%s)", async (_label, order) => {
		const log: string[] = [];
		const { run } = setup(() => [tool("seq", log, { sequential: true }), tool("par1", log), tool("par2", log)]);
		await Promise.all(order.map((name) => run("call", name)));
		expect(overlaps(log, ["seq"]).sequentialShared).toBe(false);
		expect(log.filter((line) => line.startsWith("end"))).toHaveLength(3);
	});

	it("still runs parallel tools together", async () => {
		const log: string[] = [];
		const { run } = setup(() => [tool("par1", log), tool("par2", log)]);
		await Promise.all([run("call", "par1"), run("call", "par2")]);
		expect(overlaps(log, []).max).toBe(2);
	});

	it("serializes sequential descendants of a tool that already runs alone", async () => {
		const log: string[] = [];
		const { run } = setup((run) => [
			tool("holder", log, {
				sequential: true,
				children: (id) => Promise.all([run(id, "seqA"), run(id, "seqB"), run(id, "par")]),
			}),
			tool("seqA", log, { sequential: true }),
			tool("seqB", log, { sequential: true }),
			tool("par", log),
		]);
		await run("call", "holder");
		const children = log.filter((line) => !line.endsWith("holder"));
		expect(overlaps(children, ["seqA", "seqB"]).sequentialShared).toBe(false);
		expect(children).toHaveLength(6);
		expect(log.at(-1)).toBe("end holder");
	});

	it("lets nested calls of a tool run while every call is exclusive", async () => {
		const log: string[] = [];
		const { run } = setup((run) => [tool("outer", log, { children: (id) => run(id, "inner") }), tool("inner", log)], {
			sequential: true,
		});
		await Promise.all([run("call", "outer"), run("call", "outer")]);
		expect(log).toEqual([
			"start outer",
			"start inner",
			"end inner",
			"end outer",
			"start outer",
			"start inner",
			"end inner",
			"end outer",
		]);
	});
});

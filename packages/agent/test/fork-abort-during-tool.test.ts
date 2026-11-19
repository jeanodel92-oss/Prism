import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentMessage, AgentTool } from "../src/types.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model = {
	id: "mock",
	api: "openai-responses",
	provider: "openai",
	input: ["text"],
} as unknown as Model<"openai-responses">;

const assistant = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	usage,
	stopReason,
	timestamp: Date.now(),
});

const stream = (message: AssistantMessage, reason: "toolUse" | "stop") => {
	const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => (event.type === "done" ? event.message : (event as { error: AssistantMessage }).error),
	);
	queueMicrotask(() => events.push({ type: "done", reason, message }));
	return events;
};

const run = async (tool: AgentTool, signal: AbortSignal) => {
	const events: AgentEvent[] = [];
	let requests = 0;
	await runAgentLoop(
		[{ role: "user", content: "go", timestamp: 0 } as AgentMessage],
		{ messages: [], tools: [tool] },
		{ model, convertToLlm: (messages) => messages as never },
		(event) => {
			events.push(event);
		},
		signal,
		() => {
			requests++;
			return requests === 1
				? stream(assistant([{ type: "toolCall", id: "1", name: "wait", arguments: {} }], "toolUse"), "toolUse")
				: stream(assistant([{ type: "text", text: "done" }], "stop"), "stop");
		},
	);
	return { events, requests };
};

describe("fork: an interrupt during a tool", () => {
	const parameters = Type.Object({});
	const tool = (execute: () => void): AgentTool => ({
		name: "wait",
		label: "Wait",
		description: "Waits",
		parameters,
		async execute() {
			execute();
			return { content: [{ type: "text", text: "over" }], details: {} };
		},
	});

	it("ends the run with an aborted response, without another request, and reports its end once", async () => {
		const controller = new AbortController();
		const { events, requests } = await run(
			tool(() => controller.abort()),
			controller.signal,
		);
		expect(requests).toBe(1);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		const ended = events.filter((event) => event.type === "message_end").map((event) => event.message);
		expect(ended.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted", content: [] });
		expect(ended.filter((message) => message.role === "toolResult")).toHaveLength(1);
	});

	it("leaves a run that was not interrupted alone", async () => {
		const { requests } = await run(
			tool(() => {}),
			new AbortController().signal,
		);
		expect(requests).toBe(2);
	});
});

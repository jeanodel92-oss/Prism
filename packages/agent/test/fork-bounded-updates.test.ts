// fork: a tool's updates wait for slow listeners 64 at a time at most; a
// later update replaces the one waiting for a free slot, and the last one is always delivered.
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

const prompt = (): AgentMessage => ({ role: "user", content: "go", timestamp: Date.now() });

describe("fork: bounded tool updates", () => {
	it("holds at most 64 deliveries for a listener that does not keep up, and delivers the last update", async () => {
		const tool: AgentTool<ReturnType<typeof Type.Object>> = {
			name: "chatty",
			label: "Chatty",
			description: "Reports progress 10 000 times",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, onUpdate) {
				for (let index = 1; index <= 10_000; index++) {
					onUpdate?.({ content: [{ type: "text", text: String(index) }], details: undefined });
				}
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};
		let waiting = 0;
		let most = 0;
		const delivered: string[] = [];
		let turns = 0;
		await runAgentLoop(
			[prompt()],
			{ messages: [], tools: [tool] },
			{ model, convertToLlm: (messages) => messages as Message[] },
			async (event: AgentEvent) => {
				if (event.type !== "tool_execution_update") return;
				waiting++;
				most = Math.max(most, waiting);
				// A slow reader: each update takes a few milliseconds to be taken.
				await new Promise((resolve) => setTimeout(resolve, 2));
				const part = event.partialResult.content[0];
				delivered.push(part?.type === "text" ? part.text : "");
				waiting--;
			},
			undefined,
			() => {
				const mock = new MockAssistantStream();
				queueMicrotask(() => {
					const message =
						turns++ === 0
							? assistant([{ type: "toolCall", id: "c1", name: "chatty", arguments: {} }], "toolUse")
							: assistant([{ type: "text", text: "end" }], "stop");
					mock.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				});
				return mock;
			},
		);
		expect(most).toBeLessThanOrEqual(64);
		expect(delivered.length).toBeLessThan(200);
		expect(delivered.at(-1)).toBe("10000");
		expect(delivered.slice(0, 64)).toEqual(Array.from({ length: 64 }, (_, index) => String(index + 1)));
	});
});

// fork: a failure in the loop's own steps ends the low-level stream with
// an error, as Agent does for its runs, and a progress listener's rejection is seen at once and fails the call's run.
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue, runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

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
const never = () => {
	throw new Error("no request expected");
};

/** Every event of `stream`, or "pending" when it has not ended after `ms`. */
async function drain(stream: EventStream<AgentEvent, AgentMessage[]>, ms = 1000) {
	const events: AgentEvent[] = [];
	const ended = (async () => {
		for await (const event of stream) events.push(event);
		return { events, result: await stream.result() };
	})();
	return Promise.race([ended, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))]);
}

describe("fork: failures inside the low-level agent loop", () => {
	const config: AgentLoopConfig = {
		model,
		convertToLlm: (messages) => messages as Message[],
		prepareRequest: async () => {
			throw new Error("context store unreachable");
		},
	};

	for (const [name, start] of [
		["agentLoop", () => agentLoop([prompt()], { messages: [] }, config, undefined, never)],
		["agentLoopContinue", () => agentLoopContinue({ messages: [prompt()] }, config, undefined, never)],
	] as const) {
		it(`254: ${name} ends its stream with an error when preparing the request fails`, async () => {
			const outcome = await drain(start());
			expect(outcome).not.toBe("pending");
			if (outcome === "pending") return;
			const end = outcome.events.at(-1);
			expect(end?.type).toBe("agent_end");
			const failure = outcome.result.at(-1) as AssistantMessage;
			expect(failure.role).toBe("assistant");
			expect(failure.stopReason).toBe("error");
			expect(failure.errorMessage).toBe("context store unreachable");
			expect(outcome.events.map((event) => event.type)).toContain("turn_end");
		});
	}

	it("255: a progress listener that rejects is seen at once and fails the run, not the process", async () => {
		const schema = Type.Object({});
		const slow: AgentTool<typeof schema> = {
			name: "slow",
			label: "Slow",
			description: "Reports progress, then works on",
			parameters: schema,
			async execute(_id, _params, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "half" }], details: undefined });
				await new Promise((resolve) => setTimeout(resolve, 100));
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		let turns = 0;
		try {
			const run = runAgentLoop(
				[prompt()],
				{ messages: [], tools: [slow] },
				{ model, convertToLlm: (messages) => messages as Message[] },
				async (event) => {
					if (event.type === "tool_execution_update") throw new Error("listener broke");
				},
				undefined,
				() => {
					const mock = new MockAssistantStream();
					queueMicrotask(() => {
						const message =
							turns++ === 0
								? assistant([{ type: "toolCall", id: "c1", name: "slow", arguments: {} }], "toolUse")
								: assistant([{ type: "text", text: "end" }], "stop");
						mock.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
					});
					return mock;
				},
			);
			await expect(run).rejects.toThrow("listener broke");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

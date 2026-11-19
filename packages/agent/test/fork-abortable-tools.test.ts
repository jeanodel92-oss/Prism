// fork: a tool that ignores its AbortSignal must not hold the turn or the other results of
// its batch.
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { settleOrAbort } from "../src/fork/settle-or-abort.ts";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool, AgentToolResult } from "../src/types.ts";

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

const text = (value: string): AgentToolResult<undefined> => ({
	content: [{ type: "text", text: value }],
	details: undefined,
});
const schema = Type.Object({ value: Type.String() });

/** Runs one turn of `calls` parallel tool calls, aborting `abortAfterMs` after the turn starts. */
async function runBatch(tools: AgentTool<typeof schema>[], calls: Array<[string, string]>, abortAfterMs: number) {
	const controller = new AbortController();
	const context: AgentContext = { messages: [], tools };
	const prompt: AgentMessage = { role: "user", content: "go", timestamp: Date.now() };
	let turns = 0;
	const stream = agentLoop(
		[prompt],
		context,
		{
			model,
			convertToLlm: (messages) => messages as Message[],
			toolExecution: "parallel",
		},
		controller.signal,
		() => {
			const mock = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					turns++ === 0
						? assistant(
								calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: { value: id } })),
								"toolUse",
							)
						: assistant([{ type: "text", text: "done" }], "stop");
				mock.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			});
			return mock;
		},
	);
	setTimeout(() => controller.abort(), abortAfterMs);
	const started = Date.now();
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	const results = events.flatMap((event) =>
		event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
	);
	return { results, elapsedMs: Date.now() - started };
}

const echo: AgentTool<typeof schema> = {
	name: "echo",
	label: "Echo",
	description: "Echo",
	parameters: schema,
	async execute(_id, params) {
		return text(`echoed ${params.value}`);
	},
};

describe("fork: aborting a turn with a tool that ignores the signal", () => {
	it("ends the turn and keeps the results of the other calls of the batch", async () => {
		const hang: AgentTool<typeof schema> = {
			name: "hang",
			label: "Hang",
			description: "Never settles and ignores the signal",
			parameters: schema,
			execute: () => new Promise<never>(() => {}),
		};
		const { results, elapsedMs } = await runBatch(
			[echo, hang],
			[
				["c1", "echo"],
				["c2", "hang"],
				["c3", "echo"],
				["c4", "echo"],
				["c5", "echo"],
			],
			50,
		);

		expect(elapsedMs).toBeLessThan(5000);
		expect(results.map((r) => r.toolCallId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
		const texts = results.map((r) => (r.content[0]?.type === "text" ? r.content[0].text : ""));
		expect(texts.filter((_t, i) => i !== 1)).toEqual(["echoed c1", "echoed c3", "echoed c4", "echoed c5"]);
		expect(results[1]?.isError).toBe(true);
		expect(texts[1]).toContain("did not stop after the abort");
	});

	it("keeps the tool's own result when it stops within the grace period", async () => {
		const polite: AgentTool<typeof schema> = {
			name: "polite",
			label: "Polite",
			description: "Stops on abort with its partial output",
			parameters: schema,
			execute: (_id, _params, signal) =>
				new Promise((resolve) => {
					signal?.addEventListener("abort", () => resolve(text("stopped with partial output")), { once: true });
				}),
		};
		const { results } = await runBatch([echo, polite], [["p1", "polite"]], 20);
		expect(results).toHaveLength(1);
		expect(results[0]?.content[0]).toEqual({ type: "text", text: "stopped with partial output" });
	});
});

describe("fork: settleOrAbort", () => {
	it("passes the run's value and rejection through when nothing aborts", async () => {
		const controller = new AbortController();
		const abandon = () => new Error("abandoned");
		await expect(settleOrAbort(Promise.resolve(1), controller.signal, abandon)).resolves.toBe(1);
		await expect(settleOrAbort(Promise.reject(new Error("boom")), controller.signal, abandon)).rejects.toThrow(
			"boom",
		);
	});

	it("abandons a run that outlives the grace period, even when the signal was already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const run = new Promise<number>(() => {});
		await expect(settleOrAbort(run, controller.signal, () => new Error("abandoned"), 10)).rejects.toThrow(
			"abandoned",
		);
	});
});

// fork.12 security audit, lot 3, AS-032: the Anthropic SSE reader searched its whole buffer again for every chunk,
// with no bound: a 32 MiB line took 5 s and 64 MiB without a line break ran the process out of heap. Lines are now
// split in linear time and an event over MAX_SSE_EVENT_CHARS ends the turn with a clear error.
// 2026-11-18: the pi-messages, Mistral and Codex readers had the same defect; they read whole events through
// SseEventSplitter.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { MAX_SSE_EVENT_CHARS, SseEventSplitter, SseLineSplitter } from "../src/fork/sse-lines.ts";
import type { AssistantMessage, Model } from "../src/types.ts";

const event = (name: string, payload: object) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
const START =
	event("message_start", {
		type: "message_start",
		message: { id: "m", model: "fake", usage: { input_tokens: 1, output_tokens: 0 } },
	}) +
	event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const END =
	event("content_block_stop", { type: "content_block_stop", index: 0 }) +
	event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) +
	event("message_stop", { type: "message_stop" });

/** A response whose body arrives in 64 KiB chunks, as from the network. */
function chunkedResponse(text: string): Response {
	const bytes = Buffer.from(text);
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + 65536)));
			offset += 65536;
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function run(text: string) {
	const client = {
		beta: { messages: { create: () => ({ asResponse: async () => chunkedResponse(text) }) } },
	} as unknown as Anthropic;
	return streamAnthropic(
		getModel("anthropic", "claude-haiku-4-5"),
		normalizeContext({ messages: [{ role: "user", content: "go", timestamp: 1 }] }),
		{ client },
	).result();
}

const delta = (text: string) =>
	event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });

describe("AS-032: SSE lines are split in linear time and bounded", () => {
	it("splits lines across chunks, CRLF cut between two chunks included", () => {
		const lines = new SseLineSplitter();
		expect(lines.push("event: a\r")).toEqual(["event: a"]);
		expect(lines.push("\ndata: 1")).toEqual([]);
		expect(lines.push("2\r\n\r")).toEqual(["data: 12", ""]);
		expect(lines.push("data: x\ny")).toEqual(["data: x"]);
		expect(lines.end()).toBe("y");
		expect(lines.end()).toBeUndefined();
	});

	it("refuses an event over the bound, its lines together or one line without a break", () => {
		const lines = new SseLineSplitter();
		const half = "A".repeat(MAX_SSE_EVENT_CHARS / 2);
		expect(lines.push(`data: ${half}\n`)).toHaveLength(1);
		expect(() => lines.push(`data: ${half}\n`)).toThrow("MiB");
		const single = new SseLineSplitter();
		expect(() => {
			for (let i = 0; i <= MAX_SSE_EVENT_CHARS / 65536; i++) single.push("A".repeat(65536));
		}).toThrow("MiB");
	});

	it("ends the turn with a clear error when the provider sends one event over the bound", async () => {
		const result = await run(START + delta("A".repeat(MAX_SSE_EVENT_CHARS)) + END);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream event over 8 MiB");
	});

	it("still reads a large valid event", async () => {
		const text = "A".repeat(MAX_SSE_EVENT_CHARS - 1024);
		const result = await run(START + delta(text) + END);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text }]);
	});
});

describe("SSE events are split in linear time and bounded in the pi-messages, Mistral and Codex readers", () => {
	const context = normalizeContext({ messages: [{ role: "user", content: "go", timestamp: 1 }] });
	const huge = "A".repeat(MAX_SSE_EVENT_CHARS);
	const big = "A".repeat(MAX_SSE_EVENT_CHARS - 1024);
	/** The length of each text block: a failure does not print megabytes. */
	const texts = (content: AssistantMessage["content"]) =>
		content.map((block) => (block.type === "text" ? block.text.length : block.type));
	const data = (payload: object, eol = "\n") => `data: ${JSON.stringify(payload)}${eol}${eol}`;

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("splits events on any line break, across chunks, and keeps the last one without an empty line", () => {
		const events = new SseEventSplitter();
		expect(events.push("event: a\r\ndata: 1\r")).toEqual([]);
		expect(events.push("\n\r\ndata: 2\r\rdata: 3\n\n\n")).toEqual(["event: a\ndata: 1", "data: 2", "data: 3"]);
		expect(events.push("data: 4\ndata: 5")).toEqual([]);
		expect(events.end()).toBe("data: 4\ndata: 5");
		expect(events.end()).toBeUndefined();
	});

	function piMessages(text: string) {
		const model: Model<"pi-messages"> = {
			id: "auto",
			name: "Auto",
			api: "pi-messages",
			provider: "radius",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		};
		return streamPiMessages(model, context, { apiKey: "k", fetch: async () => chunkedResponse(text) }).result();
	}
	const piText = (text: string, eol?: string) =>
		data({ type: "start" }, eol) +
		data({ type: "text_start", contentIndex: 0 }, eol) +
		data({ type: "text_delta", contentIndex: 0, delta: text }, eol) +
		data({ type: "text_end", contentIndex: 0, content: text }, eol) +
		data(
			{
				type: "done",
				reason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			eol,
		);

	it("pi-messages: refuses an event over the bound, still reads a large one", async () => {
		const refused = await piMessages(piText(huge));
		expect(refused.stopReason).toBe("error");
		expect(refused.errorMessage).toContain("stream event over 8 MiB");
		const read = await piMessages(piText(big, "\r\n"));
		expect(read.stopReason).toBe("stop");
		expect(texts(read.content)).toEqual([big.length]);
	});

	function mistral(text: string) {
		return streamMistral(getModel("mistral", "mistral-large-latest"), context, {
			apiKey: "k",
			fetch: async () => chunkedResponse(text),
		}).result();
	}
	const mistralText = (text: string, eol?: string) =>
		data({ id: "r", model: "m", choices: [{ index: 0, delta: { content: text } }] }, eol) +
		data(
			{
				id: "r",
				model: "m",
				choices: [{ index: 0, finish_reason: "stop", delta: {} }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			},
			eol,
		) +
		`data: [DONE]${eol ?? "\n"}${eol ?? "\n"}`;

	it("Mistral: refuses an event over the bound, still reads a large one", async () => {
		const refused = await mistral(mistralText(huge));
		expect(refused.stopReason).toBe("error");
		expect(refused.errorMessage).toContain("stream event over 8 MiB");
		const read = await mistral(mistralText(big, "\r\n"));
		expect(read.stopReason).toBe("stop");
		expect(texts(read.content)).toEqual([big.length]);
	});

	function codex(text: string) {
		vi.stubEnv("PI_CODING_AGENT_DIR", mkdtempSync(join(tmpdir(), "pi-codex-sse-")));
		vi.stubGlobal("fetch", async () => chunkedResponse(text));
		const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } }));
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		return streamCodex(model, context, { apiKey: `a.${claims.toString("base64")}.b`, transport: "sse" }).result();
	}
	const codexText = (text: string) =>
		data({
			type: "response.output_item.added",
			item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] },
		}) +
		data({ type: "response.content_part.added", part: { type: "output_text", text: "" } }) +
		data({ type: "response.output_text.delta", delta: text }) +
		data({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "m1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		}) +
		data({
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		});

	it("Codex: refuses an event over the bound, still reads a large one", async () => {
		const refused = await codex(codexText(huge));
		expect(refused.stopReason).toBe("error");
		expect(refused.errorMessage).toContain("stream event over 8 MiB");
		const read = await codex(codexText(big));
		expect(read.stopReason).toBe("stop");
		expect(texts(read.content)).toEqual([big.length]);
	});
});

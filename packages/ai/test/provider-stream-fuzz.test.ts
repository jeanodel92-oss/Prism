import type Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, FetchFunction, Model } from "../src/types.ts";

// Synthetic models: the fuzz target must not depend on the weekly model catalogue snapshot.
const modelAnthropic: Model<"anthropic-messages"> = {
	id: "claude-fuzz",
	name: "Claude Fuzz",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};
const modelMistral: Model<"mistral-conversations"> = {
	...modelAnthropic,
	id: "mistral-fuzz",
	name: "Mistral Fuzz",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "https://api.mistral.ai",
};

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function chunkedResponse(body: string, random: () => number): Response {
	const bytes = new TextEncoder().encode(body);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < bytes.length; ) {
					const size = 1 + Math.floor(random() * 11);
					controller.enqueue(bytes.slice(offset, offset + size));
					offset += size;
				}
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function anthropicResponse(body: string, random: () => number): Anthropic {
	return {
		beta: {
			messages: {
				create: () => ({ asResponse: async () => chunkedResponse(body, random) }),
			},
		},
	} as unknown as Anthropic;
}

// Splits text into up to three deltas, so a parser that keeps only the last delta is caught.
function deltas(text: string): string[] {
	const chars = [...text];
	const third = Math.ceil(chars.length / 3);
	return [0, 1, 2].map((part) => chars.slice(part * third, (part + 1) * third).join("")).filter(Boolean);
}

function mistralBody(text: string): string {
	const events = [
		...deltas(text).map((content) => ({
			id: "fuzz",
			model: "mistral-large-latest",
			choices: [{ index: 0, delta: { content }, finish_reason: null }],
		})),
		{
			id: "fuzz",
			model: "mistral-large-latest",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		},
	];
	return `${events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")}data: [DONE]\r\n\r\n`;
}

function anthropicBody(text: string): string {
	const events = [
		[
			"message_start",
			{ type: "message_start", message: { id: "fuzz", usage: { input_tokens: 1, output_tokens: 0 } } },
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		...deltas(text).map(
			(part) =>
				[
					"content_block_delta",
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } },
				] as const,
		),
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
		],
		["message_stop", { type: "message_stop" }],
	] as const;
	return `${events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")}`;
}

async function within<T>(promise: Promise<T>, seed: number, index: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error(`stream exceeded 250ms seed=${seed} case=${index}`)), 250).unref();
		}),
	]);
}

function messageSummary(message: AssistantMessage) {
	return { content: message.content, stopReason: message.stopReason, usage: message.usage };
}

it("fuzzes Anthropic and Mistral provider streams with deterministic byte chunking", async () => {
	const seed = Number(process.env.PI_FUZZ_SEED ?? 7_705);
	const random = makeRandom(seed);
	const context = normalizeContext({ messages: [{ role: "user", content: "reply", timestamp: 1 }] });
	const textSamples = ["hello", "café 😀", "\u001b]52;c;fuzz\u0007", "line\r\nbreak", "\u0000control"];
	const started = performance.now();
	for (let index = 0; index < 48; index++) {
		const text = textSamples[Math.floor(random() * textSamples.length)]!;
		const validAnthropic = anthropicBody(text);
		const validMistral = mistralBody(text);
		try {
			const anthropicFull = await within(
				streamAnthropic(modelAnthropic, context, { client: anthropicResponse(validAnthropic, () => 0) }).result(),
				seed,
				index,
			);
			const anthropicSplit = await within(
				streamAnthropic(modelAnthropic, context, { client: anthropicResponse(validAnthropic, random) }).result(),
				seed,
				index,
			);
			expect(messageSummary(anthropicSplit), `seed=${seed} case=${index}`).toEqual(messageSummary(anthropicFull));
			// A complete, valid stream ends normally with the whole text, whatever the chunking.
			expect(anthropicFull.stopReason, `seed=${seed} case=${index}`).toBe("stop");
			expect(anthropicFull.content, `seed=${seed} case=${index}`).toEqual([{ type: "text", text }]);

			const fetchFull: FetchFunction = async () => new Response(validMistral, { status: 200 });
			const fetchSplit: FetchFunction = async () => chunkedResponse(validMistral, random);
			const mistralFull = await within(
				streamMistral(modelMistral, context, { apiKey: "fuzz", fetch: fetchFull }).result(),
				seed,
				index,
			);
			const mistralSplit = await within(
				streamMistral(modelMistral, context, { apiKey: "fuzz", fetch: fetchSplit }).result(),
				seed,
				index,
			);
			expect(messageSummary(mistralSplit), `seed=${seed} case=${index}`).toEqual(messageSummary(mistralFull));
			expect(mistralFull.stopReason, `seed=${seed} case=${index}`).toBe("stop");
			expect(mistralFull.content, `seed=${seed} case=${index}`).toEqual([{ type: "text", text }]);

			const malformed = [
				"",
				validAnthropic.slice(0, Math.floor(random() * validAnthropic.length)),
				`${validAnthropic}event: unknown\ndata: not-json\n\n`,
				`${validAnthropic}data: {broken}\r\n\r\n`,
				`${validAnthropic}${"x".repeat(4096)}\n\n`,
				validAnthropic.replace("message_stop", "message_start"),
				`${validMistral}data: {broken}\r\n\r\n`,
				`${validMistral.slice(0, -12)}data: [DONE]`,
			];
			const body = malformed[Math.floor(random() * malformed.length)]!;
			const anthropicResult = await within(
				streamAnthropic(modelAnthropic, context, { client: anthropicResponse(body, random) }).result(),
				seed,
				index,
			);
			expect(["stop", "error", "length", "toolUse"], `seed=${seed} case=${index}`).toContain(
				anthropicResult.stopReason,
			);
			const mistralBodyInput =
				body.includes("event: message_") || body === ""
					? validMistral.slice(0, Math.floor(random() * validMistral.length))
					: body;
			const mistralResult = await within(
				streamMistral(modelMistral, context, {
					apiKey: "fuzz",
					fetch: async () => chunkedResponse(mistralBodyInput, random),
				}).result(),
				seed,
				index,
			);
			expect(["stop", "error", "length", "toolUse"], `seed=${seed} case=${index}`).toContain(
				mistralResult.stopReason,
			);
		} catch (error) {
			throw new Error(`Provider stream fuzz failure seed=${seed} case=${index}: ${String(error)}`);
		}
	}
	expect(performance.now() - started, `seed=${seed} exceeded 4000ms`).toBeLessThan(4_000);
}, 5_000);

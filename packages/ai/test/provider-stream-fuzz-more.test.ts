import { afterEach, expect, it, vi } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Model } from "../src/types.ts";

const fakeProviders = vi.hoisted(() => ({
	googleChunks: [] as unknown[],
	bedrockEvents: [] as unknown[],
}));

vi.mock("@google/genai", () => ({
	FinishReason: Object.fromEntries(
		[
			"STOP",
			"MAX_TOKENS",
			"BLOCKLIST",
			"PROHIBITED_CONTENT",
			"SPII",
			"SAFETY",
			"IMAGE_SAFETY",
			"IMAGE_PROHIBITED_CONTENT",
			"IMAGE_RECITATION",
			"IMAGE_OTHER",
			"RECITATION",
			"FINISH_REASON_UNSPECIFIED",
			"OTHER",
			"LANGUAGE",
			"MALFORMED_FUNCTION_CALL",
			"UNEXPECTED_TOOL_CALL",
			"TOO_MANY_TOOL_CALLS",
			"NO_IMAGE",
		].map((value) => [value, value]),
	),
	FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
	ThinkingLevel: {
		THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
		MINIMAL: "MINIMAL",
		LOW: "LOW",
		MEDIUM: "MEDIUM",
		HIGH: "HIGH",
	},
	GoogleGenAI: class {
		models = {
			generateContentStream: async () => ({
				async *[Symbol.asyncIterator]() {
					yield* fakeProviders.googleChunks;
				},
			}),
		};
	},
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
	BedrockRuntimeClient: class {
		middlewareStack = { add: () => undefined };
		async send() {
			return {
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield* fakeProviders.bedrockEvents;
				})(),
			};
		}
	},
	BedrockRuntimeServiceException: class extends Error {},
	ConverseStreamCommand: class {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	},
	StopReason: {
		END_TURN: "end_turn",
		STOP_SEQUENCE: "stop_sequence",
		MAX_TOKENS: "max_tokens",
		MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
		TOOL_USE: "tool_use",
	},
	CachePointType: { DEFAULT: "default" },
	CacheTTL: { ONE_HOUR: "ONE_HOUR" },
	ConversationRole: { ASSISTANT: "assistant", USER: "user" },
	ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
	ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
}));

afterEach(() => {
	vi.restoreAllMocks();
});

const modelCompletions: Model<"openai-completions"> = {
	id: "openai-completions-fuzz",
	name: "OpenAI Completions Fuzz",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};
const { compat: _completionsCompat, ...modelBase } = modelCompletions;
const modelResponses: Model<"openai-responses"> = {
	...modelBase,
	id: "openai-responses-fuzz",
	name: "OpenAI Responses Fuzz",
	api: "openai-responses",
};
const modelGoogle: Model<"google-generative-ai"> = {
	...modelBase,
	id: "google-fuzz",
	name: "Google Fuzz",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
};
const modelBedrock: Model<"bedrock-converse-stream"> = {
	...modelBase,
	id: "bedrock-fuzz",
	name: "Bedrock Fuzz",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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

function deltas(text: string): string[] {
	const chars = [...text];
	const third = Math.ceil(chars.length / 3);
	return [0, 1, 2].map((part) => chars.slice(part * third, (part + 1) * third).join("")).filter(Boolean);
}

function openAICompletionsBody(text: string): string {
	const chunks = [
		...deltas(text).map((content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })),
		{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("")}data: [DONE]\r\n\r\n`;
}

function openAIResponsesBody(text: string): string {
	const events = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_fuzz", role: "assistant", content: [] },
		},
		...deltas(text).map((delta) => ({ type: "response.output_text.delta", output_index: 0, delta })),
		{
			type: "response.completed",
			response: {
				status: "completed",
				output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function googleChunks(text: string, splitText = true): unknown[] {
	return [
		...(splitText ? deltas(text) : [text]).map((part) => ({
			candidates: [{ content: { parts: [{ text: part }] } }],
		})),
		{ candidates: [{ finishReason: "STOP", content: { parts: [] } }] },
	];
}

function bedrockEvents(text: string, splitText = true): unknown[] {
	return [
		{ messageStart: { role: "assistant" } },
		...(splitText ? deltas(text) : [text]).map((part) => ({
			contentBlockDelta: { contentBlockIndex: 0, delta: { text: part } },
		})),
		{ messageStop: { stopReason: "end_turn" } },
		{ metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
	];
}

function completionsToolBody(): string {
	const chunks = [
		{
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{ index: 0, id: "call-fuzz", type: "function", function: { name: "lookup", arguments: '{"val' } },
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			choices: [
				{
					index: 0,
					delta: { tool_calls: [{ index: 0, function: { arguments: 'ue":"fuzz"}' } }] },
					finish_reason: null,
				},
			],
		},
		{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	];
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function responsesToolBody(): string {
	const events = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", id: "fc_fuzz", call_id: "call-fuzz", name: "lookup", arguments: "" },
		},
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"val' },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: 'ue":"fuzz"}' },
		{ type: "response.function_call_arguments.done", output_index: 0, arguments: '{"value":"fuzz"}' },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_fuzz",
				call_id: "call-fuzz",
				name: "lookup",
				arguments: '{"value":"fuzz"}',
			},
		},
		{ type: "response.completed", response: { status: "completed" } },
	];
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function within<T>(promise: Promise<T>, seed: number, index: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error(`stream exceeded 250ms seed=${seed} case=${index}`)), 250).unref();
		}),
	]);
}

function summary(message: AssistantMessage) {
	return { content: message.content, stopReason: message.stopReason, usage: message.usage };
}

it("fuzzes OpenAI, Google, and Bedrock provider streams with deterministic mutations", async () => {
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const seed = Number(process.env.PI_FUZZ_SEED ?? 7_706);
	const random = makeRandom(seed);
	const context = normalizeContext({ messages: [{ role: "user", content: "reply", timestamp: 1 }] });
	const samples = ["hello from several deltas", "café 😀", "\u001b]52;c;fuzz\u0007", "line\r\nbreak", "\u0000control"];
	const started = performance.now();
	for (let index = 0; index < 48; index++) {
		const text = samples[Math.floor(random() * samples.length)]!;
		const completionBody = openAICompletionsBody(text);
		const responsesBody = openAIResponsesBody(text);
		const completionFull = await within(
			streamCompletions(modelCompletions, context, {
				apiKey: "fuzz",
				fetch: async () => new Response(completionBody, { status: 200 }),
				maxRetries: 0,
			}).result(),
			seed,
			index,
		);
		const completionSplit = await within(
			streamCompletions(modelCompletions, context, {
				apiKey: "fuzz",
				fetch: async () => chunkedResponse(completionBody, random),
				maxRetries: 0,
			}).result(),
			seed,
			index,
		);
		const responsesFull = await within(
			streamResponses(modelResponses, context, {
				apiKey: "fuzz",
				fetch: async () => new Response(responsesBody, { status: 200 }),
				maxRetries: 0,
			}).result(),
			seed,
			index,
		);
		const responsesSplit = await within(
			streamResponses(modelResponses, context, {
				apiKey: "fuzz",
				fetch: async () => chunkedResponse(responsesBody, random),
				maxRetries: 0,
			}).result(),
			seed,
			index,
		);
		fakeProviders.googleChunks = googleChunks(text, false);
		const googleFull = await within(streamGoogle(modelGoogle, context, { apiKey: "fuzz" }).result(), seed, index);
		fakeProviders.googleChunks = googleChunks(text);
		const googleSplit = await within(streamGoogle(modelGoogle, context, { apiKey: "fuzz" }).result(), seed, index);
		fakeProviders.bedrockEvents = bedrockEvents(text, false);
		const bedrockFull = await within(
			streamBedrock(modelBedrock, context, { cacheRetention: "none" }).result(),
			seed,
			index,
		);
		fakeProviders.bedrockEvents = bedrockEvents(text);
		const bedrockSplit = await within(
			streamBedrock(modelBedrock, context, { cacheRetention: "none" }).result(),
			seed,
			index,
		);

		for (const [name, full, split] of [
			["OpenAI completions", completionFull, completionSplit],
			["OpenAI responses", responsesFull, responsesSplit],
			["Google", googleFull, googleSplit],
			["Bedrock", bedrockFull, bedrockSplit],
		] as const) {
			expect(summary(split), `seed=${seed} case=${index} ${name}`).toEqual(summary(full));
			expect(full.stopReason, `seed=${seed} case=${index} ${name}`).toBe("stop");
			expect(full.content, `seed=${seed} case=${index} ${name}`).toEqual([{ type: "text", text }]);
		}

		const malformed = [
			"",
			completionBody.slice(0, Math.floor(random() * completionBody.length)),
			`${completionBody}data: {broken}\r\n\r\n`,
			`${completionBody}event: unknown\ndata: {"type":"future.event"}\n\n`,
			completionBody.replace("[DONE]", ""),
		];
		const badBody = malformed[Math.floor(random() * malformed.length)]!;
		for (const [name, run] of [
			[
				"OpenAI completions",
				() =>
					streamCompletions(modelCompletions, context, {
						apiKey: "fuzz",
						fetch: async () => chunkedResponse(badBody, random),
						maxRetries: 0,
					}).result(),
			],
			[
				"OpenAI responses",
				() =>
					streamResponses(modelResponses, context, {
						apiKey: "fuzz",
						fetch: async () => chunkedResponse(badBody, random),
						maxRetries: 0,
					}).result(),
			],
		] as const) {
			const result = await within(run(), seed, index);
			expect(["stop", "length", "toolUse", "error"], `seed=${seed} case=${index} ${name}`).toContain(
				result.stopReason,
			);
		}
		fakeProviders.googleChunks = [
			...(index % 4 === 0 ? [] : googleChunks(text).slice(0, -1)),
			...(index % 4 === 1 ? [{ candidates: [{ content: { parts: [{ text: "\u001b[31m" }] } }] }] : []),
			...(index % 4 === 2 ? [{}] : []),
		];
		const googleResult = await within(streamGoogle(modelGoogle, context, { apiKey: "fuzz" }).result(), seed, index);
		expect(["stop", "length", "toolUse", "error"], `seed=${seed} case=${index} Google`).toContain(
			googleResult.stopReason,
		);
		fakeProviders.bedrockEvents =
			index % 4 === 0
				? []
				: index % 4 === 2
					? [...bedrockEvents(text), { futureEvent: {} }]
					: bedrockEvents(text).slice(0, -2);
		const bedrockResult = await within(
			streamBedrock(modelBedrock, context, { cacheRetention: "none" }).result(),
			seed,
			index,
		);
		expect(["stop", "length", "toolUse", "error"], `seed=${seed} case=${index} Bedrock`).toContain(
			bedrockResult.stopReason,
		);
	}
	const toolContext = normalizeContext({ messages: [{ role: "user", content: "lookup", timestamp: 1 }] });
	const completionsTool = await within(
		streamCompletions(modelCompletions, toolContext, {
			apiKey: "fuzz",
			fetch: async () => new Response(completionsToolBody()),
			maxRetries: 0,
		}).result(),
		seed,
		48,
	);
	const responsesTool = await within(
		streamResponses(modelResponses, toolContext, {
			apiKey: "fuzz",
			fetch: async () => new Response(responsesToolBody()),
			maxRetries: 0,
		}).result(),
		seed,
		48,
	);
	fakeProviders.googleChunks = [
		{
			candidates: [
				{ content: { parts: [{ functionCall: { id: "call-fuzz", name: "lookup", args: { value: "fuzz" } } }] } },
			],
		},
		{ candidates: [{ finishReason: "STOP" }] },
	];
	const googleTool = await within(streamGoogle(modelGoogle, toolContext, { apiKey: "fuzz" }).result(), seed, 48);
	fakeProviders.bedrockEvents = [
		{ messageStart: { role: "assistant" } },
		{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call-fuzz", name: "lookup" } } } },
		{
			contentBlockDelta: {
				contentBlockIndex: 0,
				delta: { toolUse: { input: '{"val' } },
			},
		},
		{
			contentBlockDelta: {
				contentBlockIndex: 0,
				delta: { toolUse: { input: 'ue":"fuzz"}' } },
			},
		},
		{ contentBlockStop: { contentBlockIndex: 0 } },
		{ messageStop: { stopReason: "tool_use" } },
	];
	const bedrockTool = await within(
		streamBedrock(modelBedrock, toolContext, { cacheRetention: "none" }).result(),
		seed,
		48,
	);
	for (const [name, result] of [
		["OpenAI completions", completionsTool],
		["OpenAI responses", responsesTool],
		["Google", googleTool],
		["Bedrock", bedrockTool],
	] as const) {
		expect(result.stopReason, `seed=${seed} case=48 ${name}`).toBe("toolUse");
		expect(
			result.content.map((block) =>
				block.type === "toolCall" ? { type: block.type, name: block.name, arguments: block.arguments } : block,
			),
			`seed=${seed} case=48 ${name}`,
		).toEqual([{ type: "toolCall", name: "lookup", arguments: { value: "fuzz" } }]);
	}
	expect(performance.now() - started, `seed=${seed} exceeded 4000ms`).toBeLessThan(4_000);
}, 5_000);

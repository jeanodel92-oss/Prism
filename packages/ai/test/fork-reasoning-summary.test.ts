// fork: every API that offers a native reasoning summary asks for it by default. The other APIs
// are covered by upstream tests (anthropic-thinking-disable, bedrock-thinking-payload,
// google-thinking-level-map, openai-codex-stream); these two had none.
import { describe, expect, it } from "vitest";
import { streamSimple as streamAzure } from "../src/api/azure-openai-responses.ts";
import { streamSimple as streamResponses } from "../src/api/openai-responses.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });

function model<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "gpt-test",
		name: "gpt-test",
		api,
		provider: "test",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

/** The `reasoning` field of the request body, captured before any network call. */
async function captureReasoning(
	run: (onPayload: (request: unknown) => never) => { result(): Promise<unknown> },
): Promise<unknown> {
	let reasoning: unknown;
	await run((request) => {
		reasoning = (request as { reasoning?: unknown }).reasoning;
		throw new Error("payload captured");
	}).result();
	return reasoning;
}

describe("fork: native reasoning summaries", () => {
	it("OpenAI Responses asks for the summary", async () => {
		const reasoning = await captureReasoning((onPayload) =>
			streamResponses(model("openai-responses"), context, { apiKey: "test", reasoning: "medium", onPayload }),
		);
		expect(reasoning).toMatchObject({ summary: "auto" });
	});

	it("Azure OpenAI Responses asks for the summary", async () => {
		const reasoning = await captureReasoning((onPayload) =>
			streamAzure(model("azure-openai-responses"), context, { apiKey: "test", reasoning: "medium", onPayload }),
		);
		expect(reasoning).toMatchObject({ summary: "auto" });
	});
});

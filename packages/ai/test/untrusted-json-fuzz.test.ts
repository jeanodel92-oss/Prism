import { expect, it } from "vitest";
import { type AssistantMessage, reduceAssistantMessageFrames } from "../src/index.ts";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "../src/utils/json-parse.ts";

function assistantSeed(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 1,
	};
}

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

it("fuzzes JSON repair and partial tool-argument parsing deterministically", () => {
	const seed = Number(process.env.PI_FUZZ_SEED ?? 7_701);
	const random = makeRandom(seed);
	const corpus = [
		"{}",
		'{"a":',
		"[1,2,",
		'{"s":"x\\q"}',
		'{"s":"a\\nb\\u0041\\"c"}',
		'{"path":"src/a.ts","edits":[{"oldText":"x","newText":"y"}]}',
		"null",
		"\u001b]52;c;payload\u0007",
		"{broken",
		'"unclosed',
	];
	const fragment = () => {
		const source = corpus[Math.floor(random() * corpus.length)]!;
		const start = Math.floor(random() * (source.length + 1));
		return random() < 0.5 ? source : source.slice(start, start + Math.floor(random() * (source.length + 1)));
	};
	const noise = () =>
		String.fromCodePoint(Math.floor(random() * 0x80), 0x80 + Math.floor(random() * 0x2000)).slice(
			0,
			1 + Math.floor(random() * 2),
		);
	const started = performance.now();
	for (let index = 0; index < 800; index++) {
		// One to four corpus fragments, sometimes separated by random characters.
		const input = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
			random() < 0.3 ? `${fragment()}${noise()}` : fragment(),
		).join("");
		try {
			const partial = parseStreamingJson(input);
			expect(partial, `seed=${seed} case=${index}`).toBeDefined();
			let valid: { value: unknown } | undefined;
			try {
				valid = { value: JSON.parse(input) };
			} catch {}
			// Repair must never change the meaning of JSON that was already valid.
			if (valid && input.trim()) {
				expect(partial, `seed=${seed} case=${index}`).toEqual(valid.value);
				expect(JSON.parse(repairJson(input)), `seed=${seed} case=${index}`).toEqual(valid.value);
			}
			const replay = reduceAssistantMessageFrames([
				{ type: "start", partial: assistantSeed() },
				{
					type: "toolcall_start",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: `call-${index}`, name: "fuzz", arguments: {} },
				},
				{ type: "toolcall_delta", contentIndex: 0, delta: input },
			]);
			expect(replay?.content[0], `seed=${seed} case=${index}`).toBeDefined();
			expect(() => repairJson(input), `seed=${seed} case=${index}`).not.toThrow();
			try {
				parseJsonWithRepair(input);
			} catch (error) {
				expect(error, `seed=${seed} case=${index}`).toBeInstanceOf(SyntaxError);
			}
		} catch (error) {
			throw new Error(`JSON fuzz failure seed=${seed} case=${index}: ${String(error)}`);
		}
	}
	expect(performance.now() - started, `seed=${seed} exceeded 4000ms`).toBeLessThan(4_000);
}, 5_000);

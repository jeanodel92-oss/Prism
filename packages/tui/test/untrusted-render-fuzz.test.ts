import assert from "node:assert/strict";
import { it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { sanitizeTerminalText, visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

it("fuzzes terminal sanitizing and Markdown width with a fixed replayable seed", { timeout: 5_000 }, () => {
	const seed = Number(process.env.PI_FUZZ_SEED ?? 7_702);
	const random = makeRandom(seed);
	const atoms = [
		"text",
		"\u001b]52;c;secret\u0007",
		"\u001b[31mred\u001b[0m",
		"\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007",
		"\u001b",
		"\u0000",
		"\u202e",
		"e\u0301",
		"😀",
		"\n",
		"**bold**",
		"```ts\nconst x = 1;\n```",
	];
	const started = performance.now();
	for (let index = 0; index < 500; index++) {
		const joined = Array.from(
			{ length: Math.floor(random() * 18) },
			() => atoms[Math.floor(random() * atoms.length)]!,
		).join(random() < 0.5 ? " " : "");
		// Cutting at a random point leaves incomplete escape sequences and broken Markdown.
		const input = random() < 0.3 ? joined.slice(0, Math.floor(random() * (joined.length + 1))) : joined;
		try {
			const sanitized = sanitizeTerminalText(input);
			assert.doesNotMatch(
				sanitized.replace(/\u001b\[[0-9;:]*m|\u001b\]8;;(?:\u0007|\u001b\\)/g, ""),
				/\u001b/,
				`seed=${seed} case=${index}`,
			);
			const width = 8 + Math.floor(random() * 73);
			const lines = new Markdown(input, 0, 0, defaultMarkdownTheme).render(width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `seed=${seed} case=${index} width=${width}`);
		} catch (error) {
			throw new Error(`TUI fuzz failure seed=${seed} case=${index}: ${String(error)}`);
		}
	}
	assert.ok(performance.now() - started < 4_000, `seed=${seed} exceeded 4000ms`);
});

it(
	"Markdown keeps every rendered line within a one-column terminal",
	{ todo: "Known defect: list indentation can exceed width 1" },
	() => {
		const lines = new Markdown("- item", 0, 0, defaultMarkdownTheme).render(1);
		assert.ok(lines.every((line) => visibleWidth(line) <= 1));
	},
);

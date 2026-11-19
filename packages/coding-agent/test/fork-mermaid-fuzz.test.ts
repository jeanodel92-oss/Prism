// fork: fuzz target for Mermaid diagrams in the model's text (grok-mermaid). Whatever the model writes, the
// transformer must not throw, must keep the text around a diagram, and a drawn diagram must fit the width it was
// drawn for. No defect found on 2026-10-21; this guards dependency upgrades. Replay with PI_FUZZ_SEED.
import { Markdown } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const seed = Number(process.env.PI_FUZZ_SEED ?? 7_719);
const HEADS = ["graph TD", "graph LR", "flowchart TB", "sequenceDiagram", "classDiagram", "stateDiagram-v2", "pie", ""];
const TOKENS = [
	"A",
	"B",
	"C",
	"-->",
	"---",
	"-.->",
	"==>",
	"--|x|",
	"|",
	"[",
	"]",
	"(",
	")",
	"{",
	"}",
	'"',
	":",
	";",
	"\n",
	" ",
	"subgraph",
	"end",
	"->>",
	"participant",
	"note over",
	"loop",
	"%%",
	"classDef",
	"<br>",
	"é",
	"😀",
	"\t",
	"`",
	"[*]",
	"title",
];

beforeAll(() => initTheme("dark"));

it("draws or keeps any diagram the model writes, within the available width", () => {
	const random = makeRandom(seed);
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
	const transform = createMermaidMarkdownTransformer({ getMode: () => "streaming", theme });
	let drawn = 0;
	for (let index = 0; index < 1500; index++) {
		let diagram = `${pick(HEADS)}\n`;
		for (let count = Math.floor(random() * 60); count > 0; count--) diagram += pick(TOKENS);
		const width = 20 + Math.floor(random() * 100);
		const markdown = `Before ${index}\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\nAfter ${index}`;
		const label = `seed=${seed} case=${index} width=${width} ${JSON.stringify(diagram)}`;
		const output = transform(markdown, {
			availableWidth: width,
			isStreaming: random() < 0.5,
			messageType: "assistant",
		});
		expect(output, label).toContain(`Before ${index}`);
		expect(output, label).toContain(`After ${index}`);
		if (output.includes("```mermaid")) continue;
		drawn++;
		// Markdown wraps what is too wide, so a diagram that fits renders the same at its width as without limit.
		const markdownOf = (renderWidth: number) =>
			new Markdown(output, 0, 0, getMarkdownTheme()).render(renderWidth).map((line) => line.trimEnd());
		expect(markdownOf(width), label).toEqual(markdownOf(1_000));
	}
	// The generator must reach the drawing path, not only the fallback.
	expect(drawn).toBeGreaterThan(100);
}, 60_000);

it("draws a diagram with a very long label in linear time", () => {
	const transform = createMermaidMarkdownTransformer({ getMode: () => "final" });
	const context = { availableWidth: 120, isStreaming: false, messageType: "assistant" as const };
	transform('```mermaid\ngraph TD\nA["warm-up"]-->B\n```', context);
	// CPU time: a busy machine stretches wall time, not the work.
	const started = process.cpuUsage();
	transform(`\`\`\`mermaid\ngraph TD\nA["${"word ".repeat(40_000)}"]-->B\n\`\`\``, context);
	// 200 KB took 235 ms when measured; a quadratic step would take seconds.
	const used = process.cpuUsage(started);
	expect((used.user + used.system) / 1000).toBeLessThan(2_000);
});

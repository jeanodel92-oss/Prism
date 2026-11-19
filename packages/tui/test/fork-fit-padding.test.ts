// fork: TruncatedText and Box added their side padding even when it filled
// the whole width, so TruncatedText("x", 1).render(2) gave a line of 3 columns and could stop the renderer.
import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Text } from "../src/components/text.ts";
import { TruncatedText } from "../src/components/truncated-text.ts";
import { visibleWidth } from "../src/utils.ts";

const texts = ["", "x", "hello world", "日本語"];

function assertFits(lines: string[], width: number, label: string): void {
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${label}: ${JSON.stringify(line)} > ${width}`);
}

describe("fork: padding bounded by the width", () => {
	it("keeps TruncatedText within widths 0, 1 and 2", () => {
		for (const width of [0, 1, 2, 3]) {
			for (const text of texts) {
				const lines = new TruncatedText(text, 1, 1).render(width);
				assertFits(lines, width, `TruncatedText(${text}) at ${width}`);
				for (const line of lines) assert.strictEqual(visibleWidth(line), width);
			}
		}
		assert.strictEqual(new TruncatedText("x", 1, 0).render(2)[0], "x ");
		assert.strictEqual(new TruncatedText("x", 1, 0).render(3)[0], " x ");
	});

	it("keeps a Box and its nested text within widths 0, 1 and 2", () => {
		for (const width of [0, 1, 2, 3]) {
			for (const text of texts) {
				const box = new Box(1, 1);
				box.addChild(new TruncatedText(text, 1, 0));
				box.addChild(new Text(text, 1, 0));
				assertFits(box.render(width), width, `Box(${text}) at ${width}`);
			}
		}
	});
});

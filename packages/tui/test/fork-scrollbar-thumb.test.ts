// fork: the scrollbar thumb is drawn to an eighth of a cell.
import assert from "node:assert";
import { describe, it } from "node:test";
import { thumbCell } from "../src/fork/scrollbar-thumb.ts";

describe("fork: scrollbar thumb to an eighth of a cell", () => {
	it("draws full, starting and ending cells", () => {
		// Thumb over rows 2.25 to 4.5.
		assert.strictEqual(thumbCell(1, 2.25, 4.5), undefined);
		assert.deepStrictEqual(thumbCell(2, 2.25, 4.5), { glyph: "▆", reverse: false });
		assert.deepStrictEqual(thumbCell(3, 2.25, 4.5), { glyph: "█", reverse: false });
		assert.deepStrictEqual(thumbCell(4, 2.25, 4.5), { glyph: "▄", reverse: true });
		assert.strictEqual(thumbCell(5, 2.25, 4.5), undefined);
	});

	it("moves by an eighth of a cell when the thumb moves by an eighth", () => {
		const glyphs = [0, 0.125, 0.25, 0.375].map((start) => thumbCell(3, 3 + start, 6)?.glyph);
		assert.deepStrictEqual(glyphs, ["█", "▇", "▆", "▅"]);
	});
});

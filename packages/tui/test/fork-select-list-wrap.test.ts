import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

// fork: a long /help action was cut at the terminal's edge; with wrapDescription it goes on underneath.

const theme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const items = [
	{ value: "a", label: "Shift+Tab", description: "Change the thinking level (or click the level under the editor)" },
	{ value: "b", label: "Ctrl+T", description: "Show or hide thinking" },
];

const mouse = (type: "press" | "click", y: number): TuiMouseEvent => ({
	type,
	button: "left",
	x: 2,
	y,
	screenX: 2,
	screenY: y,
	width: 42,
	height: 10,
	shift: false,
	alt: false,
	ctrl: false,
});

describe("fork: SelectList wrapDescription", () => {
	it("cuts the description by default", () => {
		const lines = new SelectList(items, 5, theme, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 12 }).render(
			50,
		);
		assert.strictEqual(lines.length, 2);
	});

	for (const width of [100, 64, 50, 42]) {
		it(`wraps the whole description within ${width} columns, under its column`, () => {
			const list = new SelectList(items, 5, theme, {
				minPrimaryColumnWidth: 12,
				maxPrimaryColumnWidth: 12,
				wrapDescription: true,
			});
			const lines = list.render(width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${line} wider than ${width}`);
			const first = lines.slice(
				0,
				lines.findIndex((line) => line.includes("Ctrl+T")),
			);
			const text = first.map((line, i) => (i === 0 ? line.slice(14) : line.trimStart())).join(" ");
			assert.strictEqual(text.replace(/\s+/g, " ").trim(), items[0]!.description);
			for (const line of first.slice(1)) assert.match(line, /^ {14}\S/);
		});
	}

	it("maps a click on a wrapped line to its item", () => {
		const list = new SelectList(items, 5, theme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			wrapDescription: true,
		});
		const lines = list.render(42);
		const second = lines.findIndex((line) => line.includes("Ctrl+T"));
		assert.ok(second > 1);
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		list.handleMouse(mouse("press", second - 1));
		list.handleMouse(mouse("click", second - 1));
		list.handleMouse(mouse("press", second));
		list.handleMouse(mouse("click", second));
		assert.deepStrictEqual(chosen, ["a", "b"]);
	});
});

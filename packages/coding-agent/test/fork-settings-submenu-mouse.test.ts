// fork: in /settings, a click in the theme or compaction threshold list sometimes chose
// another row. The window drew the list narrower than the width its click carried, so the list measured its
// wrapped description at the wrong width and placed its rows one line off. A click in "Thinking level for each
// model" did nothing: that menu has steps and did not pass clicks to the step shown.
import type { SettingItem, TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { SettingsView } from "../src/fork/settings-view.ts";
import { SelectSubmenu, SteppedSubmenu } from "../src/modes/interactive/components/settings-submenu.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");

const click = (x: number, y: number, width: number): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width,
	height: 30,
	shift: false,
	alt: false,
	ctrl: false,
});

// Fits on one line of the whole window, but wraps in the narrower settings column.
const description = (width: number) =>
	"Chosen for the light terminals, in automatic mode, before the dark one is, and kept for the next sessions."
		.slice(0, width - 2)
		.trimEnd();

function open(width: number, steps = false) {
	const picked = vi.fn();
	const item: SettingItem = steps
		? {
				id: "theme",
				label: "Theme",
				currentValue: "first",
				submenu: (_value, done) =>
					new SteppedSubmenu(
						[
							{
								key: "model",
								title: "Per-Model Thinking Level",
								description: description(width),
								options: () =>
									["first", "second", "third"].map((value) => ({ value, label: `model ${value}` })),
								searchable: true,
							},
							{
								key: "level",
								title: "Thinking Level",
								description: "Select default thinking level for this model",
								options: () => ["low", "medium", "high"].map((value) => ({ value, label: `level ${value}` })),
							},
						],
						(context) => picked(`${context.model}/${context.level}`),
						() => done(),
					),
			}
		: {
				id: "theme",
				label: "Theme",
				currentValue: "first",
				submenu: (_value, done) =>
					new SelectSubmenu(
						"Theme",
						description(width),
						["first", "second", "third", "fourth"].map((value) => ({ value, label: `choice ${value}` })),
						"first",
						(value) => {
							picked(value);
							done(value);
						},
						() => done(),
					),
			};
	const model = groupSettingsByDomain([item], vi.fn(), { builtinExtensions: [], onBuiltinExtensionChange: vi.fn() });
	const view = new SettingsView(model, { onClose: vi.fn(), rows: () => 30, domain: "appearance", item: "theme" });
	view.render(width);
	view.handleInput("\r");
	return { view, picked };
}

describe("fork: a click in a /settings submenu", () => {
	beforeAll(() => initTheme("dark"));

	for (const width of [100, 64]) {
		it(`chooses the row clicked, at ${width} columns`, () => {
			const { view, picked } = open(width);
			const lines = view.render(width).map(plain);
			const at = (text: string) => lines.findIndex((line) => line.includes(text));
			// Two description lines, then a blank line, before the list.
			expect(at("choice first") - at("Chosen for")).toBe(3);
			for (const value of ["third", "second", "fourth"]) {
				const { view: fresh, picked: chosen } = open(width);
				const drawn = fresh.render(width).map(plain);
				const row = drawn.findIndex((line) => line.includes(`choice ${value}`));
				expect(row).toBeGreaterThan(0);
				fresh.handleMouse(click(drawn[row]!.indexOf(`choice ${value}`) + 1, row, width));
				expect(chosen).toHaveBeenCalledWith(value);
			}
			expect(picked).not.toHaveBeenCalled();
		});
	}

	for (const width of [100, 64]) {
		it(`goes through the steps of a menu with steps, at ${width} columns`, () => {
			const { view, picked } = open(width, true);
			const press = (text: string) => {
				const drawn = view.render(width).map(plain);
				const row = drawn.findIndex((line) => line.includes(text));
				expect(row).toBeGreaterThan(0);
				view.handleMouse(click(drawn[row]!.indexOf(text) + 1, row, width));
			};
			press("model second");
			press("level high");
			expect(picked).toHaveBeenCalledWith("second/high");
		});
	}
});

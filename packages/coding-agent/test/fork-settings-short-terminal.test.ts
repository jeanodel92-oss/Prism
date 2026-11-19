/**
 * fork: on a short terminal, /settings cut its domains, its choices
 * and a list's field instead of scrolling to what is selected.
 */
import type { SettingItem, TuiMouseEvent } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsDomain, SettingsModel } from "../src/fork/settings-domains.ts";
import { ListEditor } from "../src/fork/settings-list-editor.ts";
import { SettingsView } from "../src/fork/settings-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ENTER = "\r";

function model(domains: Array<{ label: string; items: SettingItem[] }>): SettingsModel {
	const list: SettingsDomain[] = domains.map((domain, i) => ({
		id: `d${i}`,
		label: domain.label,
		description: `${domain.label} settings`,
		advancedOnly: false,
		size: domain.items.length,
		items: () => domain.items,
		searchItems: () => [],
	}));
	return {
		domains: () => list,
		onChange: vi.fn(),
		isAdvanced: () => true,
		isAdvancedSetting: () => false,
		counts: () => ({ shown: 1, total: 1 }),
	};
}

const click = (x: number, y: number): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 100,
	height: 16,
	shift: false,
	alt: false,
	ctrl: false,
});

describe("fork: /settings on a short terminal", () => {
	beforeAll(() => initTheme("dark"));

	it("scrolls the domains to the selected one and keeps their count", () => {
		const domains = Array.from({ length: 12 }, (_, i) => ({
			label: `Domain ${String.fromCharCode(65 + i)}`,
			items: [{ id: `s${i}`, label: `Setting ${i}`, currentValue: "on", values: ["on", "off"] }],
		}));
		for (const width of [100, 40]) {
			const view = new SettingsView(model(domains), { onClose: vi.fn(), rows: () => 16 });
			for (let i = 0; i < 11; i++) view.handleInput(DOWN);
			const lines = view.render(width).map(plain);
			expect(lines.length).toBeLessThanOrEqual(15);
			expect(lines.some((l) => l.includes("12 Domain L"))).toBe(true);
			expect(lines.some((l) => l.includes("1 settings"))).toBe(true);
			for (const l of lines) expect(visibleWidth(l)).toBe(width);
		}
		// A click selects the domain drawn on that row, not the one at that position in the full list.
		const view = new SettingsView(model(domains), { onClose: vi.fn(), rows: () => 16 });
		for (let i = 0; i < 11; i++) view.handleInput(DOWN);
		const lines = view.render(100).map(plain);
		const row = lines.findIndex((l) => l.includes("11 Domain K"));
		view.handleMouse(click(3, row));
		expect(
			view
				.render(100)
				.map(plain)
				.find((l) => l.includes("Domain K settings")),
		).toBeDefined();
	});

	it("scrolls a tall menu of choices to the selected one, inside its frame", () => {
		const values = Array.from({ length: 20 }, (_, i) => `choice-${i}`);
		const item: SettingItem = { id: "many", label: "Many", currentValue: "choice-0", values };
		const view = new SettingsView(model([{ label: "Only", items: [item] }]), { onClose: vi.fn(), rows: () => 16 });
		view.handleInput(RIGHT);
		view.handleInput(ENTER);
		for (let i = 0; i < 19; i++) view.handleInput(DOWN);
		const lines = view.render(40).map(plain);
		expect(lines.some((l) => l.includes("choice-19"))).toBe(true);
		expect(lines.some((l) => l.includes("┌─ Many"))).toBe(true);
		expect(lines.some((l) => /└─+┘/.test(l))).toBe(true);
		// A click on a drawn choice picks that one.
		const row = lines.findIndex((l) => l.includes("choice-18"));
		view.handleMouse({ ...click(10, row), width: 40 });
		expect(item.currentValue).toBe("choice-18");
	});

	it("keeps a long list's field and its message in view while adding", () => {
		const entries = Array.from({ length: 30 }, (_, i) => ({ text: `entry-${i}` }));
		const item: SettingItem = {
			id: "rules",
			label: "Rules",
			currentValue: "30",
			submenu: () =>
				new ListEditor({
					title: "Rules",
					description: "The rules.",
					entries: () => entries,
					addPrompt: "Type the new rule",
					parse: (text) => (text === "bad" ? new Error("Not a rule: bad") : text),
					onAdd: vi.fn(),
					onRemove: vi.fn(),
					requestRender: vi.fn(),
					done: vi.fn(),
				}),
		};
		const view = new SettingsView(model([{ label: "Only", items: [item] }]), { onClose: vi.fn(), rows: () => 16 });
		view.handleInput(RIGHT);
		view.handleInput(ENTER);
		// « Add… » is selected: Enter asks for the text.
		view.handleInput(ENTER);
		let lines = view.render(100).map(plain);
		expect(lines.some((l) => l.includes("Type the new rule"))).toBe(true);
		for (const ch of "bad") view.handleInput(ch);
		view.handleInput(ENTER);
		lines = view.render(100).map(plain);
		expect(lines.some((l) => l.includes("Not a rule: bad"))).toBe(true);
		expect(lines.some((l) => l.includes("Type the new rule"))).toBe(true);
	});
});

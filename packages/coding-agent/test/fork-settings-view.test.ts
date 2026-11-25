// fork: /settings as a window: domains beside their settings, search, choices, the interface switch.
import type { SettingItem, TuiMouseEvent } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { tok } from "../src/fork/prism/lib/palette.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { drawSwitch, SettingsView, WIDE_WIDTH } from "../src/fork/settings-view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");

/** `interfaceMode`: fork.12.5, the Mermaid setting the tests choose from is in the advanced interface only. */
function setup(rows = 30, interfaceMode: "simple" | "advanced" = "simple") {
	const onChange = vi.fn();
	const items: SettingItem[] = [
		{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
		{ id: "animations", label: "Animations", currentValue: "on", values: ["on", "off"] },
		{
			id: "mermaid-rendering",
			label: "Mermaid diagrams",
			description: "When diagrams are drawn.",
			currentValue: "streaming",
			values: ["streaming", "final", "off"],
		},
		{ id: "autocompact", label: "Auto-compact", currentValue: "true", values: ["true", "false"] },
		{ id: "tui-mode", label: "TUI mode", currentValue: "regular", values: ["regular", "fullscreen"] },
		{ id: "transport", label: "Transport", currentValue: "auto", values: ["auto", "sse"] },
	];
	const model = groupSettingsByDomain(items, onChange, {
		builtinExtensions: [{ name: "web", enabled: true }],
		onBuiltinExtensionChange: vi.fn(),
		interfaceMode,
	});
	const onClose = vi.fn();
	const view = new SettingsView(model, { onClose, rows: () => rows });
	return { view, model, onChange, onClose, items };
}

const mouse = (x: number, y: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent => ({
	type,
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 100,
	height: 30,
	shift: false,
	alt: false,
	ctrl: false,
});

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

describe("fork: /settings window", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setLanguage("en"));

	it("fits every width at one fixed height whatever the domain", () => {
		for (const width of [40, 64, WIDE_WIDTH - 1, WIDE_WIDTH, 100, 120]) {
			const { view } = setup();
			const first = view.render(width);
			for (const line of first) expect(visibleWidth(line)).toBe(width);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			expect(view.render(width).length).toBe(first.length);
		}
		// Never taller than the terminal allows.
		expect(setup(16).view.render(100).length).toBeLessThanOrEqual(14);
	});

	it("shows the domains beside the selected domain's settings, numbered, with the help zone below", () => {
		const { view } = setup();
		const lines = view.render(100).map(plain);
		expect(lines[1]).toContain("Settings");
		expect(lines[1]).toContain("/ Search a setting…");
		expect(lines[1]).toContain("Simple │ Advanced");
		expect(lines[1]).toContain("✕");
		const row = lines.find((l) => l.includes("01 Appearance"))!;
		expect(row).toContain("Appearance");
		expect(lines.some((l) => l.includes("Theme") && l.includes("dark ▾"))).toBe(true);
		expect(lines.some((l) => l.includes("Animations") && l.includes("● on"))).toBe(true);
		// Transport is advanced: not in simple, and counted.
		expect(lines.some((l) => l.includes("Network"))).toBe(false);
		expect(lines.some((l) => /\d+ of \d+ settings/.test(l))).toBe(true);
		expect(lines.at(-2)).toContain("→ or Enter open");
	});

	it("goes into the settings with →, switches on/off with Enter, opens choices with their descriptions", () => {
		const { view, onChange, model } = setup(30, "advanced");
		view.render(100);
		view.handleInput(RIGHT);
		view.handleInput(DOWN);
		view.handleInput("\r");
		expect(model.domains()[0]!.items()[1]!.currentValue).toBe("off");
		view.handleInput(DOWN);
		let lines = view.render(100).map(plain);
		// The help zone lists what each choice does (settings-descriptions.ts).
		expect(lines.some((l) => l.includes("final :"))).toBe(true);
		view.handleInput("\r");
		lines = view.render(100).map(plain);
		expect(lines.some((l) => l.includes("Mermaid diagrams") && l.includes("┌"))).toBe(true);
		view.handleInput(DOWN);
		view.handleInput("\r");
		expect(onChange).toHaveBeenLastCalledWith("mermaid-rendering", "final");
		view.handleInput(LEFT);
		expect(plain(view.render(100).at(-2)!)).toContain("→ or Enter open");
	});

	it("searches every domain, accents and case aside, and Escape clears before it closes", () => {
		const { view, onClose } = setup();
		view.render(100);
		for (const c of "TUI") view.handleInput(c);
		let lines = view.render(100).map(plain);
		expect(lines.some((l) => l.includes("TUI mode") && l.includes("Terminal"))).toBe(true);
		expect(lines.some((l) => l.includes("Animations"))).toBe(false);
		view.handleInput("\x1b");
		lines = view.render(100).map(plain);
		expect(lines.some((l) => l.includes("Animations"))).toBe(true);
		expect(onClose).not.toHaveBeenCalled();
		view.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("shows one column below the wide width: the domains, then one domain with a way back", () => {
		const { view } = setup();
		let lines = view.render(64).map(plain);
		expect(lines.some((l) => l.includes("Appearance"))).toBe(true);
		expect(lines.some((l) => l.includes("Theme"))).toBe(false);
		view.handleInput("\r");
		lines = view.render(64).map(plain);
		expect(lines[1]).toContain("‹ Appearance");
		expect(lines.some((l) => l.includes("Theme"))).toBe(true);
		view.handleInput(LEFT);
		lines = view.render(64).map(plain);
		expect(lines.some((l) => l.includes("Theme"))).toBe(false);
	});

	it("switches the interface from the title row and keeps the domain shown", () => {
		const { view, model } = setup();
		const width = 100;
		const lines = view.render(width).map(plain);
		const at = lines[1]!.indexOf("Advanced");
		view.handleMouse(mouse(at + 2, 1));
		expect(model.isAdvanced()).toBe(true);
		expect(
			view
				.render(width)
				.map(plain)
				.some((l) => l.includes("Network")),
		).toBe(true);
		view.handleMouse(mouse(lines[1]!.indexOf("Simple") + 1, 1));
		expect(model.isAdvanced()).toBe(false);
	});

	it("selects a domain and switches a setting with the mouse, and closes with ✕", () => {
		const { view, onChange, onClose } = setup();
		const lines = view.render(100).map(plain);
		const conversation = lines.findIndex((l) => l.includes("Conversation"));
		view.handleMouse(mouse(4, conversation));
		const after = view.render(100).map(plain);
		const row = after.findIndex((l) => l.includes("Auto-compact") && l.includes("●"));
		view.handleMouse(mouse(after[row]!.indexOf("Auto-compact"), row));
		expect(onChange).toHaveBeenLastCalledWith("autocompact", "false");
		view.handleMouse(mouse(after[1]!.indexOf("✕"), 1));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("draws /settings in French within every width", () => {
		setLanguage("fr");
		const { view } = setup();
		for (const width of [40, 64, 100]) {
			for (const line of view.render(width)) expect(visibleWidth(line)).toBe(width);
		}
		const lines = view.render(100).map(plain);
		expect(lines[1]).toContain("Simple │ Avancé");
		expect(lines.at(-2)).toContain("Entrée");
		expect(lines.some((l) => l.includes("● activé"))).toBe(true);
	});

	it("keeps a space between a cut value and the domain in search results", () => {
		const { view } = setup(30, "advanced");
		for (const key of "/mermaid") view.handleInput(key);
		for (const width of [100, 44, 40]) {
			const row = view
				.render(width)
				.map(plain)
				.find((l) => l.includes("Mermaid") && l.includes("Appearance"));
			expect(row, String(width)).toMatch(/\S \s*Appearance │\s*$/);
			// fork: the label is cut before the value.
			expect(row, String(width)).toContain("streaming ▾");
			expect(row, String(width)).not.toMatch(/[…▾]Appearance/);
		}
	});

	it("draws on/off as the site's state dot: ● in the accent when on, ○ in the strong line when off", () => {
		const dot = (s: string) => /\x1b\[38;2;([\d;]+)m[●○]/.exec(s)?.[1];
		expect(plain(drawSwitch(true))).toBe("● on");
		expect(plain(drawSwitch(false))).toBe("○ off");
		expect(dot(drawSwitch(true))).toBe(tok(theme, "accent").join(";"));
		expect(dot(drawSwitch(false))).toBe(tok(theme, "borderAccent").join(";"));
	});
});

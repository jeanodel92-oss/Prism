// fork: a theme made for the other background sets the terminal's own background and
// foreground for the session, and gives them back.
import type { TerminalColors, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { backdropColors, TerminalBackdrop } from "../src/fork/terminal-backdrop.ts";
import { initTheme, setTerminalColors } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

const DARK_TERMINAL = { background: { r: 0, g: 0, b: 0 }, foreground: { r: 221, g: 221, b: 221 } };
const LIGHT_TERMINAL = { background: { r: 255, g: 255, b: 255 }, foreground: { r: 0, g: 0, b: 0 } };
const PRISM_LIGHT = { appearance: "light" as const, text: "#1c1f2b", pageBg: "#ffffff" };
const PRISM = { appearance: "dark" as const, text: "#e6e8f2", pageBg: "#0d0f15" };

function recorder() {
	const writes: string[] = [];
	return { writes, backdrop: new TerminalBackdrop((data) => writes.push(data)) };
}

describe("fork: terminal backdrop", () => {
	it("a light theme in a dark terminal sets the terminal's colours, and restores them when the theme matches", () => {
		const { writes, backdrop } = recorder();
		backdrop.sync(PRISM_LIGHT, DARK_TERMINAL);
		expect(writes).toEqual(["\x1b]11;rgb:ff/ff/ff\x07\x1b]10;rgb:1c/1f/2b\x07"]);
		backdrop.sync(PRISM_LIGHT, DARK_TERMINAL);
		expect(writes).toHaveLength(1);
		backdrop.sync(PRISM, DARK_TERMINAL);
		expect(writes.at(-1)).toBe("\x1b]110\x07\x1b]111\x07");
	});

	it("a dark theme in a light terminal does the same; a matching theme writes nothing", () => {
		const { writes, backdrop } = recorder();
		backdrop.sync(PRISM_LIGHT, LIGHT_TERMINAL);
		expect(writes).toEqual([]);
		backdrop.sync(PRISM, LIGHT_TERMINAL);
		expect(writes).toEqual(["\x1b]11;rgb:0d/0f/15\x07\x1b]10;rgb:e6/e8/f2\x07"]);
		backdrop.restore();
		expect(writes.at(-1)).toBe("\x1b]110\x07\x1b]111\x07");
	});

	it("leaves a terminal that did not report its background alone", () => {
		const { writes, backdrop } = recorder();
		backdrop.sync(PRISM_LIGHT, undefined);
		backdrop.sync(PRISM_LIGHT, { foreground: DARK_TERMINAL.foreground });
		expect(writes).toEqual([]);
	});

	it("reports taken while the backdrop is on still describe the real terminal", () => {
		const { backdrop } = recorder();
		backdrop.sync(PRISM_LIGHT, DARK_TERMINAL);
		const reported = { background: { r: 255, g: 255, b: 255 }, foreground: { r: 28, g: 31, b: 43 } };
		expect(backdrop.unmask(reported)).toEqual(DARK_TERMINAL);
		backdrop.restore();
		expect(backdrop.unmask(reported)).toEqual(reported);
	});

	it("restores the terminal on exit", () => {
		const { writes, backdrop } = recorder();
		const before = process.listenerCount("exit");
		backdrop.sync(PRISM_LIGHT, DARK_TERMINAL);
		expect(process.listenerCount("exit")).toBe(before + 1);
		// Call only our listener: emitting "exit" would run the test runner's own handlers too.
		const hook = process.listeners("exit").at(-1) as (code: number) => void;
		hook(0);
		expect(writes.at(-1)).toBe("\x1b]110\x07\x1b]111\x07");
		expect(process.listenerCount("exit")).toBe(before);
	});

	it("falls back to a readable foreground when the theme's text follows the terminal's", () => {
		expect(backdropColors({ appearance: "light", text: "#f0f0f0", pageBg: "#ffffff" }).foreground).toEqual({
			r: 0,
			g: 0,
			b: 0,
		});
		expect(backdropColors({ appearance: "light", text: "#1c1f2b" }).background).toEqual({ r: 255, g: 255, b: 255 });
	});
});

describe("fork: theme controller and terminal backdrop", () => {
	afterEach(() => {
		setTerminalColors({});
		initTheme("dark");
	});

	it("choosing a light theme in a dark terminal sets the backdrop; choosing a dark one restores it", async () => {
		const writes: string[] = [];
		const ui = {
			invalidate: vi.fn(),
			requestRender: vi.fn(),
			setTerminalColorSchemeNotifications: vi.fn(),
			onTerminalColorSchemeChange: vi.fn(() => () => {}),
			queryTerminalColors: vi.fn(async (): Promise<TerminalColors> => DARK_TERMINAL),
			terminal: { write: (data: string) => writes.push(data) },
		} as unknown as TUI;
		const settings = SettingsManager.inMemory({ theme: "prism" });
		const controller = new InteractiveThemeController(ui, {
			getSettingsManager: () => settings,
			showError: vi.fn(),
			onChanged: vi.fn(),
		});
		controller.applyFromSettings();
		await controller.waitForTerminalColors();
		expect(writes).toEqual([]);

		expect(controller.setThemeName("prism-light").success).toBe(true);
		expect(writes).toEqual(["\x1b]11;rgb:f2/f2/f0\x07\x1b]10;rgb:11/11/11\x07"]);

		controller.setThemeName("prism");
		expect(writes.at(-1)).toBe("\x1b]110\x07\x1b]111\x07");
		controller.dispose();
	});
});

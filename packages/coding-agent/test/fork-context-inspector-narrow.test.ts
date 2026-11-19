// fork: /context at 60 columns cut the end of its rows and their right border.
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { loadVendored } from "./fork-vendored-module.ts";

type StatsTab = {
	renderContent(innerWidth: number, height: number): string[];
	handleInput(data: string): boolean;
	footerHints: string;
};
type Compaction = { line?: string; choose(action: "compact" | "settings"): void };
type Helpers = { row(content: string): string };

const dir = new URL("../vendor/forks/pi-context-inspector/src/", import.meta.url).pathname;
const { StatsTabContent } = await loadVendored<{
	StatsTabContent: new (
		breakdown: object | null,
		th: typeof theme,
		model?: { name: string },
		compaction?: Compaction,
	) => StatsTab;
}>(`${dir}stats-tab-content.ts`);
const { createBorderHelpers } = await loadVendored<{
	createBorderHelpers(th: typeof theme, innerW: number): Helpers;
}>(`${dir}utils.ts`);

const breakdown = {
	total: 2000,
	contextWindow: 200000,
	percent: 1,
	reserveTokens: 16000,
	safeAvailable: 182000,
	systemPrompt: 247,
	systemTools: 1000,
	tools: 0,
	skills: 0,
	messages: 27,
	other: 0,
};

describe("fork: /context in a narrow terminal", () => {
	beforeAll(() => initTheme("dark"));

	it("stacks the breakdown above the grid when both do not fit side by side", () => {
		const tab = new StatsTabContent(breakdown, theme, { name: "scripted" });
		const narrow = tab.renderContent(56, 40);
		expect(Math.max(...narrow.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(56);
		const labels = narrow.findIndex((line) => line.includes("System prompt"));
		const firstGridRow = narrow.findIndex((line) => line.includes("󰋙") && !line.includes("Available"));
		expect(labels).toBeGreaterThan(0);
		expect(firstGridRow).toBeGreaterThan(narrow.findIndex((line) => line.includes("Auto-compact buffer")));

		const wide = tab.renderContent(100, 40);
		expect(wide.some((line) => line.includes("󰋙") && line.includes("System prompt"))).toBe(true);
	});

	// the terminal's gauge opens /context, which says how auto-compaction runs
	// and compacts or opens its settings, as the window's /context does.
	it("shows Prism's auto-compaction line and runs its two actions", () => {
		const chosen: string[] = [];
		const compaction = {
			line: "auto: at 85%, Prism summarises",
			choose: (action: string) => void chosen.push(action),
		};
		const tab = new StatsTabContent(breakdown, theme, { name: "scripted" }, compaction);
		const lines = tab.renderContent(100, 40);
		expect(lines.some((line) => line.includes("auto: at 85%, Prism summarises"))).toBe(true);
		expect(lines.some((line) => line.includes("Auto-compact starts after"))).toBe(false);
		expect(tab.footerHints).toBe("c compact · s settings");
		expect(tab.handleInput("c")).toBe(true);
		expect(tab.handleInput("s")).toBe(true);
		expect(tab.handleInput("x")).toBe(false);
		expect(chosen).toEqual(["compact", "settings"]);
		const empty = new StatsTabContent(null, theme, { name: "scripted" }, compaction).renderContent(100, 10);
		expect(empty.some((line) => line.includes("auto: at 85%"))).toBe(true);
		// Wrapped in a narrow terminal, not cut at the border.
		const long = {
			...compaction,
			line: "auto: at 92%, Prism summarises the older messages to make room (auto-compaction).",
		};
		const narrow = new StatsTabContent(breakdown, theme, { name: "scripted" }, long).renderContent(56, 40);
		expect(Math.max(...narrow.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(56);
		expect(
			narrow
				.join(" ")
				.replace(/\x1b\[[0-9;]*m/g, "")
				.replace(/\s+/g, " "),
		).toContain("(auto-compaction).");
		// Outside Prism, the stock tab.
		const stock = new StatsTabContent(breakdown, theme, { name: "scripted" });
		expect(stock.renderContent(100, 40).some((line) => line.includes("Auto-compact starts after"))).toBe(true);
		expect(stock.handleInput("c")).toBe(false);
	});

	it("keeps the right border of a row wider than the overlay", () => {
		const { row } = createBorderHelpers(theme, 10);
		const line = row("x".repeat(30));
		expect(visibleWidth(line)).toBe(12);
		expect(line.endsWith("│\x1b[39m") || line.endsWith("│")).toBe(true);
	});
});

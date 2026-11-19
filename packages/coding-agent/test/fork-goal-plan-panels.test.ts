// fork: the menus of the bundled Goal and Plan plug-ins (pi-tui-kit screens) are drawn as
// windows, like /settings and /perm, instead of bare menus at the bottom.
import { setKeybindings, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { EditorSlot } from "../src/fork/editor-slot.ts";
import { dialogFrameHook } from "../src/fork/prism/dialogs.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { setRenderHooks } from "../src/fork/render-hooks.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createMenuScreenComponent } from "../vendor/node_modules/@narumitw/pi-tui-kit/dist/components/index.js";
import type { MenuScreen } from "../vendor/node_modules/@narumitw/pi-tui-kit/dist/index.js";

type Screen = MenuScreen<string, string>;

const GOAL: Screen = {
	kind: "actions",
	title: "Goal",
	lines: ["No goal is currently set"],
	items: [
		{ id: "start", label: "Start a goal…", action: "start" },
		{ id: "help", label: "Help", to: "help" },
		{ id: "close", label: "Close", close: true },
	],
	hint: "back",
};

const HELP: Screen = {
	kind: "detail",
	title: "Goal help",
	lines: ["Use the menu for guided status.", "Escape cancels the current menu or input without changing goal state."],
	hint: "back",
};

function kitScreen(screen: Screen, rows = 40) {
	const events: Array<{ kind: string; itemId?: string }> = [];
	const component = createMenuScreenComponent({
		screen,
		tui: { terminal: { rows }, requestRender() {} },
		theme,
		keybindings: new KeybindingsManager({}),
		onEvent: (event) => events.push(event),
	});
	return { component, events };
}

function hook() {
	const state = createState();
	state.theme = theme;
	state.animates = () => false;
	return dialogFrameHook(state);
}

function click(x: number, y: number, type: TuiMouseEvent["type"]): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 30,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("fork: Goal and Plan menus as windows", () => {
	beforeAll(() => {
		initTheme("prism");
		setKeybindings(new KeybindingsManager({}));
	});
	afterEach(() => setRenderHooks({}));

	it("draws a kit screen as a box with its title, a close cross, its lines and its key hints", () => {
		const frame = hook();
		for (let width = 30; width <= 140; width++) {
			const { component } = kitScreen(GOAL);
			const out = frame(component, width)!;
			const lines = out.lines.map((line) => stripAnsi(line));
			for (const line of out.lines) expect(visibleWidth(line)).toBe(width);
			expect(lines[0]).toMatch(/^┌─+┐$/);
			expect(lines[1]).toMatch(/^│ Goal +✕ │$/);
			expect(lines[2]).toMatch(/^├─+┤$/);
			expect(lines.at(-1)).toMatch(/^└─+┘$/);
			expect(lines).toContainEqual(expect.stringMatching(/^│ +No goal is currently set +│$/));
			expect(lines).toContainEqual(expect.stringMatching(/^│▌❯ Start a goal… +│$/));
			// The hints close the window; wrapped on a narrow one, never left among the options.
			const rule = lines.findLastIndex((line) => line.startsWith("├"));
			expect(lines.slice(rule + 1, -1).join(" ")).toMatch(/navigate.*select.*back.*close/);
			expect(lines.slice(3, rule).join(" ")).not.toMatch(/navigate/);
			expect(out.close).toEqual({ row: 1, from: width - 4, to: width - 1 });
			// Mouse rows map to the kit's own rows: the options keep their place.
			const own = component.render(out.innerWidth).map((line: string) => stripAnsi(line));
			const at = lines.findIndex((line) => line.includes("Help"));
			expect(own[out.rows[at]!]).toContain("Help");
		}
	});

	it("keeps a detail screen's text lines out of its hints, even those naming keys", () => {
		const { component } = kitScreen(HELP);
		const lines = hook()(component, 100)!.lines.map((line) => stripAnsi(line));
		expect(lines[1]).toMatch(/^│ Goal help +✕ │$/);
		expect(lines).toContainEqual(expect.stringMatching(/^│ +Escape cancels the current menu/));
		expect(lines.at(-2)).toMatch(/^│ esc back • ctrl\+c close +│$/);
	});

	it("fits a short terminal, dropping blank lines and rules before content", () => {
		const { component } = kitScreen(GOAL, 12);
		// The kit and the window read the same terminal.
		const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });
		let out: ReturnType<ReturnType<typeof hook>>;
		try {
			out = hook()(component, 60);
		} finally {
			if (rows) Object.defineProperty(process.stdout, "rows", rows);
			else delete (process.stdout as { rows?: number }).rows;
		}
		const lines = out!.lines.map((line) => stripAnsi(line));
		expect(lines.length).toBeLessThanOrEqual(12 - 3);
		expect(lines.join("\n")).toContain("Start a goal…");
		expect(lines.join("\n")).toContain("Close");
		expect(lines.at(-1)).toMatch(/^└─+┘$/);
	});

	it("closes the whole menu on a click on the cross, and runs an option on a click on it", () => {
		setRenderHooks({ dialogFrame: hook() });
		const goal = kitScreen(GOAL);
		const slot = new EditorSlot();
		slot.addChild(goal.component);
		const lines = slot.render(80).map((line) => stripAnsi(line));
		const cross = lines[1]!.indexOf("✕");
		expect(slot.handleMouse(click(cross, 1, "press"))?.handled).toBe(true);
		slot.handleMouse(click(cross, 1, "click"));
		expect(goal.events).toEqual([{ kind: "close" }]);

		const help = kitScreen(GOAL);
		const other = new EditorSlot();
		other.addChild(help.component);
		const row = other
			.render(80)
			.map((line) => stripAnsi(line))
			.findIndex((line) => line.includes("Help"));
		other.handleMouse(click(6, row, "press"));
		other.handleMouse(click(6, row, "click"));
		expect(help.events).toEqual([{ kind: "activate", itemId: "help" }]);
	});
});

// fork: Plan, Goal, the thinking level and the permission mode can be changed from the
// composer's info row and the statusline, by click, besides their keys and commands.
import { setKeybindings, TuiMainScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SlashCommandInfo } from "../src/core/slash-commands.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { createEditorFactory } from "../src/fork/prism/editor.ts";
import { chip, findPermChip, findSandboxChip } from "../src/fork/prism/footer.ts";
import { installModeSwitches } from "../src/fork/prism/index.ts";
import { createState, type PrismState } from "../src/fork/prism/lib/state.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");

function click(x: number, y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 100,
		height: 6,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function composer(state: PrismState) {
	return createEditorFactory(state)(
		new TuiMainScreen(new VirtualTerminal()),
		defaultEditorTheme,
		new KeybindingsManager({}),
	) as unknown as { render(width: number): string[]; handleMouse(event: TuiMouseEvent): unknown };
}

describe("fork: Prism mode switches", () => {
	beforeAll(() => {
		initTheme("prism");
		setKeybindings(new KeybindingsManager({}));
	});

	function setup(statuses: Record<string, string> = {}, files = false) {
		const state = createState();
		state.theme = theme;
		state.thinkingLevel = "medium";
		state.ctx = { model: { id: "qwen", provider: "local", reasoning: true } } as unknown as ExtensionContext;
		state.statuses = () => new Map(Object.entries(statuses));
		state.cycleThinking = vi.fn();
		state.togglePlan = vi.fn();
		state.openCommand = vi.fn();
		state.planShortcut = () => "alt+p";
		state.modes = { plan: true, goal: true, files };
		const editor = composer(state);
		const lines = editor.render(100);
		// One text line: status 0, padding 1, text 2, gap 3, info row 4.
		const info = plain(lines[4]!);
		// The row is drawn after the bar and two spaces: column 3 of the composer.
		// Columns of the composer: the plain line starts with the bar and its gutter.
		const at = (text: string) => [...info.slice(0, info.indexOf(text))].length;
		return { state, editor, info, at };
	}

	it("shows the Plan and Goal switches with their keys next to the thinking level", () => {
		const { info } = setup();
		expect(info).toContain("qwen  local · medium");
		expect(info).toContain("● plan alt+p");
		expect(info).toContain("● goal alt+g");
	});

	// Code review 2026-10-20 (L12): the Goal and files keys are app keybindings, so keybindings.json changes them.
	it("shows the Goal and files keys from the keybindings configuration", () => {
		setKeybindings(new KeybindingsManager({ "app.goal.menu": "alt+o", "app.files.browse": "ctrl+o" }));
		try {
			const { info } = setup({}, true);
			expect(info).toContain("● goal alt+o");
			expect(info).toContain("files ctrl+o");
		} finally {
			setKeybindings(new KeybindingsManager({}));
		}
	});

	it("marks an active mode by drawing its dot and label in ink", () => {
		const raw = (statuses: Record<string, string>) => {
			const state = setup(statuses).state;
			return composer(state).render(100)[4]!;
		};
		// The theme's own escape: truecolor or 256 colours, whatever the environment gives.
		const ink = theme.getFgAnsi("accent");
		const strong = theme.getFgAnsi("borderAccent");
		const on = raw({ "plan-mode": "plan active", goal: "active 2m · automatic 1/25" });
		expect(on).toContain(`${ink}● plan`);
		expect(on).toContain(`${ink}● goal`);
		// The plan module words its status in the interface language: "plan actif" is on too.
		expect(raw({ "plan-mode": "plan actif" })).toContain(`${ink}● plan`);
		expect(raw({ "plan-mode": "plan prêt" })).toContain(`${ink}● plan`);
		expect(raw({ "plan-mode": "plan saved" })).not.toContain(`${ink}● plan`);
		expect(raw({ goal: "complete" })).toContain(`${strong}●`);
		expect(raw({ goal: "complete" })).not.toContain(`${ink}● goal`);
	});

	it("cycles the thinking level, toggles Plan and opens the Goal menu on click", () => {
		const { state, editor, at } = setup();
		expect(editor.handleMouse(click(at("medium"), 4))).toEqual({ handled: true });
		expect(state.cycleThinking).toHaveBeenCalledTimes(1);
		expect(editor.handleMouse(click(at("● plan"), 4))).toEqual({ handled: true });
		expect(state.togglePlan).toHaveBeenCalledTimes(1);
		expect(editor.handleMouse(click(at("● goal") + 2, 4))).toEqual({ handled: true });
		expect(state.openCommand).toHaveBeenCalledWith("goal");
		// The key hint and the model name are not switches.
		expect(editor.handleMouse(click(at("alt+p"), 4))).toEqual({ handled: true, focus: true });
		expect(state.togglePlan).toHaveBeenCalledTimes(1);
	});

	it("shows the file browser button when its extension is loaded, and opens it on click", () => {
		expect(setup().info).not.toContain("files");
		const { state, editor, info, at } = setup({}, true);
		expect(info).toContain("files alt+e");
		expect(editor.handleMouse(click(at("files"), 4))).toEqual({ handled: true });
		expect(state.openCommand).toHaveBeenCalledWith("files");
	});

	it("finds the sandbox word after the permission chip, only when the status says it", () => {
		const line = "  ~/x  ▐ask▌ · sandbox  ▄▄▄▄ 1%/200k";
		const chip = findPermChip([line], "perm: ask · sandbox");
		expect(findSandboxChip([line], chip, "perm: ask · sandbox")).toEqual({ row: 0, from: 15, to: 22 });
		expect(findSandboxChip([line], chip, "perm: ask")).toBeUndefined();
		expect(findSandboxChip(["  ▐ask▌"], undefined, "perm: ask · sandbox")).toBeUndefined();
	});

	it("finds the permission chip in the statusline", () => {
		expect(findPermChip(["  ~/x  ▐broad▌  ▄▄▄▄ 1%/200k"], "perm: broad")).toEqual({ row: 0, from: 7, to: 14 });
		expect(findPermChip(["  ~/x", " ▐ask▌ (3 rules)  • plan active"], "perm: ask (3 rules)")).toEqual({
			row: 1,
			from: 1,
			to: 6,
		});
		expect(findPermChip(["  ~/x"], undefined)).toBeUndefined();
	});

	// the maintainer's QA on 1.0.0-fork.6 found "plan, goal, files" and "broad" in English.
	it("draws the bar and the permission chip in French, and still finds the chip", () => {
		setLanguage("fr");
		try {
			const { info } = setup({}, true);
			expect(info).toContain("● plan alt+p");
			expect(info).toContain("● objectif alt+g");
			expect(info).toContain("fichiers alt+e");
			// the thinking level was left in English ("medium").
			expect(info).toContain("qwen  local · moyen");
			expect(plain(chip(theme, "permissions", "perm: broad (3 rules)"))).toContain("▐large▌");
			expect(findPermChip(["  ~/x  ▐sans limite▌"], "perm: unrestricted")).toEqual({ row: 0, from: 7, to: 20 });
		} finally {
			setLanguage("en");
		}
	});

	it.each(["prompt", "skill"] as const)("ignores %s commands named plan or goal", async (source) => {
		let commands: SlashCommandInfo[] = ["plan", "goal"].map((name) => ({
			name,
			source,
			sourceInfo: { source: "local", scope: "project", origin: "top-level", path: `/project/${name}.md` },
		}));
		const handlers: Array<() => Promise<void>> = [];
		const sendUserMessage = vi.fn();
		const notify = vi.fn();
		const pi = {
			on: (_event: string, handler: () => Promise<void>) => handlers.push(handler),
			getCommands: () => commands,
			sendUserMessage,
		};
		const state = createState();
		state.theme = theme;
		state.ctx = { ui: { notify } } as unknown as ExtensionContext;
		installModeSwitches(pi as unknown as ExtensionAPI, state);
		for (const handler of handlers) await handler();
		expect(state.modes).toEqual({ plan: false, goal: false, files: false });
		const editor = composer(state);
		for (const width of [100, 60, 40]) {
			const info = plain(editor.render(width)[4]!);
			expect(info).not.toContain("plan");
			expect(info).not.toContain("goal");
		}
		state.togglePlan?.();
		state.openCommand?.("goal");
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/plan is not available in this session.", "info");
		expect(notify).toHaveBeenCalledWith("/goal is not available in this session.", "info");

		// An extension with the same name still supplies the mode and the click action.
		commands = [...commands, ...commands.map((entry) => ({ ...entry, source: "extension" as const }))];
		for (const handler of handlers) await handler();
		expect(state.modes).toEqual({ plan: true, goal: true, files: false });
		const info = plain(editor.render(100)[4]!);
		expect(info).toContain("● plan");
		expect(info).toContain("● goal");
		editor.handleMouse(click([...info.slice(0, info.indexOf("● plan"))].length, 4));
		editor.handleMouse(click([...info.slice(0, info.indexOf("● goal"))].length, 4));
		expect(sendUserMessage.mock.calls.map(([text]) => text)).toEqual(["/plan", "/goal"]);
	});

	it("cycles through the levels the model supports and runs only known commands", async () => {
		let level = "off";
		const shortcuts: string[] = [];
		const sent: string[] = [];
		const notices: string[] = [];
		const handlers: Array<() => Promise<void>> = [];
		const pi = {
			on: (_event: string, handler: () => Promise<void>) => handlers.push(handler),
			registerShortcut: (key: string) => shortcuts.push(key),
			getThinkingLevel: () => level,
			setThinkingLevel: (next: string) => {
				level = next;
			},
			getCommands: () => [
				{ name: "goal", source: "extension" },
				{ name: "perm", source: "extension" },
			],
			sendUserMessage: async (text: string) => {
				sent.push(text);
			},
		};
		const state = createState();
		state.ctx = {
			model: {
				id: "qwen",
				provider: "local",
				reasoning: true,
				thinkingLevelMap: { minimal: null, high: null, xhigh: "xhigh" },
			},
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ExtensionContext;
		installModeSwitches(pi as unknown as ExtensionAPI, state);
		// Code review 2026-10-20 (L12): the Goal key is the configurable app.goal.menu, not a shortcut of the module.
		expect(shortcuts).toEqual([]);

		const seen: string[] = [];
		for (let i = 0; i < 5; i++) {
			state.cycleThinking?.();
			seen.push(level);
		}
		expect(seen).toEqual(["low", "medium", "xhigh", "off", "low"]);

		state.openCommand?.("perm window");
		state.openCommand?.("nope");
		expect(sent).toEqual(["/perm window"]);
		expect(notices).toEqual(["/nope is not available in this session."]);

		for (const handler of handlers) await handler();
		expect(state.modes).toEqual({ plan: false, goal: true, files: false });
		state.togglePlan?.();
		expect(notices.at(-1)).toBe("/plan is not available in this session.");
	});
});

// fork: transitions of panels and of the blocks a click unfolds, and no timer while off.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import type { AnimationId } from "../src/fork/animations.ts";
import { dialogFrameHook } from "../src/fork/prism/dialogs.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { transcriptHooks } from "../src/fork/prism/transcript.ts";
import {
	curtain,
	PANEL_CLOSE_MS,
	PANEL_OPEN_MS,
	transitionHooks,
	UNFOLD_MS,
	unfold,
} from "../src/fork/prism/transitions.ts";
import { setRenderHooks } from "../src/fork/render-hooks.ts";
import { unfoldOnScreen } from "../src/fork/unfold-on-screen.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const agentDir = mkdtempSync(join(tmpdir(), "prism-transitions-"));
const rows = (n: number, tag = "row") => Array.from({ length: n }, (_, i) => `${tag} ${i}`);

function prism(on: readonly AnimationId[]) {
	const state = createState();
	state.theme = theme;
	state.animates = (id) => on.includes(id);
	setRenderHooks({ ...transcriptHooks(state), ...transitionHooks(state) });
	return state;
}

function clickAt(component: Component, y: number, height: number): void {
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width: 80,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(component.handleMouse?.(event)?.handled).toBe(true);
}

function tool(ui: TuiMainScreen): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"read",
		"t1",
		{ path: "notes.txt" },
		{ showImages: false },
		createReadToolDefinition(agentDir),
		ui,
		agentDir,
	);
	component.updateResult({ content: [{ type: "text", text: rows(30, "out").join("\n") }], isError: false });
	return component;
}

function thinkingMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: rows(20, "reason").join("\n\n") },
			{ type: "text", text: "answer" },
		],
		api: "openai-completions",
		provider: "fake",
		model: "scripted",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

type Toggles = {
	onToolsKey(this: object): void;
	onThinkingKey(this: object): void;
	toggleToolOutputExpansion: unknown;
	toggleThinkingBlockVisibility: unknown;
	unfoldOnScreen: unknown;
	setToolsExpanded: unknown;
	updateThinkingBlockVisibility: unknown;
};

/** The parts of the interactive mode ctrl+o and ctrl+t use, on a main screen whose viewport starts at `top`. */
function toggles(chat: Component[], top: number) {
	const prototype = InteractiveMode.prototype as unknown as Toggles;
	const chatContainer = new Container();
	for (const block of chat) chatContainer.addChild(block);
	const renderer = Object.create(TuiMainScreen.prototype) as TuiMainScreen;
	renderer.captureRenderState = () => ({
		previousLines: [],
		previousWidth: 80,
		previousHeight: 24,
		cursorRow: 0,
		hardwareCursorRow: 0,
		maxLinesRendered: 0,
		previousViewportTop: top,
	});
	return {
		headerContainer: new Container(),
		loadedResourcesContainer: new Container(),
		chatContainer,
		renderer,
		ui: { terminal: { columns: 80 }, requestRender: () => {} },
		settingsManager: { setHideThinkingBlock: () => {} },
		toolOutputExpanded: false,
		hideThinkingBlock: true,
		showStatus: () => {},
		unfoldOnScreen: prototype.unfoldOnScreen,
		setToolsExpanded: prototype.setToolsExpanded,
		updateThinkingBlockVisibility: prototype.updateThinkingBlockVisibility,
		toggleToolOutputExpansion: prototype.toggleToolOutputExpansion,
		toggleThinkingBlockVisibility: prototype.toggleThinkingBlockVisibility,
		onToolsKey: prototype.onToolsKey,
		onThinkingKey: prototype.onThinkingKey,
	};
}

describe("fork: transitions", () => {
	beforeAll(() => {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PRISM_CODING_AGENT_DIR", agentDir);
		initTheme("prism");
	});
	afterEach(() => {
		setRenderHooks({});
		vi.useRealTimers();
	});
	afterAll(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("opens a panel from its middle out, keeping its first and last rows", () => {
		const lines = rows(10);
		expect(curtain(lines, 0)).toEqual(["row 0", "row 9"]);
		expect(curtain(lines, 1)).toEqual(lines);
		let previous = 0;
		for (let p = 0; p <= 1; p += 0.1) {
			const shown = curtain(lines, p);
			expect(shown[0]).toBe("row 0");
			expect(shown.at(-1)).toBe("row 9");
			expect(shown.length).toBeGreaterThanOrEqual(previous);
			previous = shown.length;
		}
	});

	it("unfolds the rows between the ones a block keeps, both ways", () => {
		const collapsed = ["head", "a", "foot"];
		const expanded = ["head", "a", "b", "c", "d", "foot"];
		expect(unfold(collapsed, expanded, 0)).toEqual(collapsed);
		expect(unfold(collapsed, expanded, 1)).toEqual(expanded);
		const middle = unfold(collapsed, expanded, 0.3);
		expect(middle[0]).toBe("head");
		expect(middle.at(-1)).toBe("foot");
		expect(middle.length).toBeGreaterThan(collapsed.length);
		expect(middle.length).toBeLessThan(expanded.length);
		const folding = unfold(expanded, collapsed, 0.3);
		expect(folding.length).toBeLessThan(expanded.length);
		expect(folding.length).toBeGreaterThan(collapsed.length);
		expect(unfold(expanded, collapsed, 1)).toEqual(collapsed);
	});

	it("arms no menu timer while the menus animation is off", () => {
		// The timer used to be armed before the switch was read: turned off, the menu still redrew every 16 ms.
		vi.useFakeTimers();
		class SettingsSelectorComponent {
			render() {
				return ["→ first", "  second", "↑↓ navigate  enter select"];
			}
			invalidate() {}
		}
		for (const on of [false, true]) {
			const state = createState();
			state.theme = theme;
			state.animates = () => on;
			dialogFrameHook(state)(new SettingsSelectorComponent(), 60);
			expect(vi.getTimerCount() > 0).toBe(on);
			vi.runAllTimers();
		}
	});

	it("opens and closes an extension panel with a transition, focus back at once", async () => {
		vi.useFakeTimers();
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		for (const on of [true, false]) {
			prism(on ? ["menus"] : []);
			const editor = new Container();
			ui.setFocus(editor);
			const mode = {
				ui,
				editor: Object.assign(editor, { getText: () => "", setText: () => {} }),
				editorContainer: new Container(),
				extensionWindowsOpened: 0,
				keybindings: {},
				disposeActiveSelector: () => {},
			};
			let close: ((value: string) => void) | undefined;
			let clicks = 0;
			const panel: Component & { dispose?(): void } = {
				render: () => rows(12, "panel"),
				invalidate: () => {},
				handleInput: () => {},
				handleMouse: () => {
					clicks++;
					return { handled: true };
				},
			};
			const show = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as (
				this: typeof mode,
				factory: (...args: unknown[]) => Component,
				options: { overlay: boolean },
			) => Promise<string>;
			const result = show.call(
				mode,
				(_tui, _theme, _keys, done) => {
					close = done as (value: string) => void;
					return panel;
				},
				{ overlay: true },
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(ui.hasOverlay()).toBe(true);
			// Opening: fewer rows at first, all of them once the transition is over.
			expect(panel.render(80).length).toBe(on ? 2 : 12);
			vi.advanceTimersByTime(PANEL_OPEN_MS);
			expect(panel.render(80)).toEqual(rows(12, "panel"));
			close!("done");
			expect(await result).toBe("done");
			// Closing: keys go back at once; the panel folds, takes no click, then goes.
			expect(ui.hasOverlay()).toBe(on);
			expect(ui.getFocusedComponent()).toBe(editor);
			panel.handleMouse?.({} as TuiMouseEvent);
			expect(clicks).toBe(on ? 0 : 1);
			vi.advanceTimersByTime(PANEL_CLOSE_MS + 20);
			expect(ui.hasOverlay()).toBe(false);
			vi.advanceTimersByTime(100);
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	// fork: opening, a panel drew row 18 of its layout at y=14, where a click
	// selected row 14 instead.
	it("passes no click to a panel while it opens, nor the rest of a press taken then", () => {
		vi.useFakeTimers();
		for (const on of [true, false]) {
			const state = prism(on ? ["menus"] : []);
			const received: string[] = [];
			const panel: Component = {
				render: () => rows(30, "panel"),
				invalidate: () => {},
				handleMouse: (event) => {
					received.push(`${event.type} ${event.y}`);
					return { handled: true };
				},
			};
			const transition = transitionHooks(state).panel?.(panel);
			expect(transition !== undefined).toBe(on);
			const mouse = (type: TuiMouseEvent["type"], y: number) =>
				panel.handleMouse?.({ ...({} as TuiMouseEvent), type, button: "left", x: 2, y, screenX: 2, screenY: y })
					?.handled;
			vi.advanceTimersByTime(PANEL_OPEN_MS / 3);
			if (on) expect(panel.render(80).length).toBeLessThan(30);
			expect(mouse("press", 14)).toBe(true);
			expect(mouse("wheel", 14)).toBe(true);
			vi.advanceTimersByTime(PANEL_OPEN_MS);
			// Released and clicked once the panel is open: still the press of the opening.
			expect(mouse("release", 14)).toBe(true);
			expect(mouse("click", 14)).toBe(true);
			expect(received).toEqual(on ? [] : ["press 14", "wheel 14", "release 14", "click 14"]);
			received.length = 0;
			// Open: every row is where it is drawn, and clicks pass.
			expect(panel.render(80)).toEqual(rows(30, "panel"));
			mouse("press", 18);
			mouse("release", 18);
			mouse("click", 18);
			mouse("wheel", 18);
			expect(received).toEqual(["press 18", "release 18", "click 18", "wheel 18"]);
			vi.runAllTimers();
		}
	});

	it("opens and folds a menu shown in place of the editor, but not between two of its screens", async () => {
		vi.useFakeTimers();
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		for (const on of [true, false]) {
			prism(on ? ["menus"] : []);
			let text = "draft";
			const editor = Object.assign(new Container(), {
				getText: () => text,
				setText: (value: string) => {
					text = value;
				},
			});
			const editorContainer = new Container();
			editorContainer.addChild(editor);
			ui.setFocus(editor);
			const mode = {
				ui,
				editor,
				editorContainer,
				extensionWindowsOpened: 0,
				keybindings: {},
				disposeActiveSelector: () => {},
			};
			const show = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as (
				this: typeof mode,
				factory: (...args: unknown[]) => Component,
			) => Promise<string>;
			const screen = (tag: string) => {
				let close: ((value: string) => void) | undefined;
				const component: Component = { render: () => rows(12, tag), invalidate: () => {}, handleInput: () => {} };
				const result = show.call(mode, (_tui, _theme, _keys, done) => {
					close = done as (value: string) => void;
					return component;
				});
				return { component, result, close: (value: string) => close!(value) };
			};
			const slot = () => editorContainer.children[0];

			// Opening from the editor: fewer rows at first, all of them once the transition is over.
			const first = screen("menu");
			await vi.advanceTimersByTimeAsync(0);
			expect(slot()).toBe(first.component);
			expect(first.component.render(80).length).toBe(on ? 2 : 12);
			vi.advanceTimersByTime(PANEL_OPEN_MS);
			expect(first.component.render(80)).toEqual(rows(12, "menu"));

			// The next screen of the same menu replaces the one going, without a transition of its own.
			first.close("next");
			expect(await first.result).toBe("next");
			const second = screen("sub");
			await vi.advanceTimersByTimeAsync(0);
			expect(slot()).toBe(second.component);
			expect(second.component.render(80)).toEqual(rows(12, "sub"));
			vi.advanceTimersByTime(PANEL_CLOSE_MS + 20);
			expect(slot()).toBe(second.component);
			expect(second.component.render(80)).toEqual(rows(12, "sub"));

			// Closing: keys go back to the editor at once; the menu folds, then the editor comes back with its text.
			second.close("done");
			expect(await second.result).toBe("done");
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(slot()).toBe(on ? second.component : editor);
			vi.advanceTimersByTime(PANEL_CLOSE_MS / 2);
			if (on) expect(second.component.render(80).length).toBeLessThan(12);
			vi.advanceTimersByTime(PANEL_CLOSE_MS);
			expect(slot()).toBe(editor);
			expect(editorContainer.children).toHaveLength(1);
			expect(text).toBe("draft");
			vi.advanceTimersByTime(100);
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	it("folds /settings before it goes, without the keys", () => {
		vi.useFakeTimers();
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		for (const on of [true, false]) {
			prism(on ? ["menus"] : []);
			const editor = new Container();
			ui.setFocus(editor);
			let close: (() => void) | undefined;
			const panel: Component = { render: () => rows(12, "settings"), invalidate: () => {}, handleInput: () => {} };
			const show = Reflect.get(InteractiveMode.prototype, "showSettingsOverlay") as (
				this: { ui: TuiMainScreen; editorContainer: Container },
				create: (done: () => void) => { component: Component; focus: Component },
			) => void;
			const editorContainer = new Container();
			editorContainer.addChild(editor);
			show.call({ ui, editorContainer }, (done) => {
				close = done;
				return { component: panel, focus: panel };
			});
			expect(panel.render(80).length).toBe(on ? 2 : 12);
			vi.advanceTimersByTime(PANEL_OPEN_MS);
			close!();
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(ui.hasOverlay()).toBe(on);
			vi.advanceTimersByTime(PANEL_CLOSE_MS + 120);
			expect(ui.hasOverlay()).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	it("unfolds a tool's details on a click, at once and without a timer when its animation is off", () => {
		vi.useFakeTimers();
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		for (const on of [true, false]) {
			prism(on ? ["tools"] : []);
			const read = tool(ui);
			const collapsed = read.render(80).length;
			clickAt(read, 0, collapsed);
			const first = read.render(80).length;
			vi.advanceTimersByTime(UNFOLD_MS / 2);
			const middle = read.render(80).length;
			vi.advanceTimersByTime(UNFOLD_MS);
			const expanded = read.render(80);
			expect(stripAnsi(expanded.join("\n"))).toContain("out 29");
			if (on) {
				expect(first).toBe(collapsed);
				expect(middle).toBeGreaterThan(collapsed);
				expect(middle).toBeLessThan(expanded.length);
			} else {
				expect(first).toBe(expanded.length);
			}
			vi.advanceTimersByTime(100);
			expect(vi.getTimerCount()).toBe(0);
			if (!on) {
				// Folding back is instant too.
				clickAt(read, 0, expanded.length);
				expect(read.render(80).length).toBe(collapsed);
				expect(vi.getTimerCount()).toBe(0);
			}
		}
	});

	it("unfolds a thinking block on a click under the thinking switch", () => {
		vi.useFakeTimers();
		prism(["thinking"]);
		const component = new AssistantMessageComponent(thinkingMessage(), true);
		const lines = component.render(80);
		const row = lines.findIndex((line) => /Thinking|Réflexion/.test(stripAnsi(line)));
		expect(row).toBeGreaterThanOrEqual(0);
		clickAt(component, row, lines.length);
		expect(component.render(80).length).toBe(lines.length);
		vi.advanceTimersByTime(UNFOLD_MS / 2);
		const middle = component.render(80).length;
		vi.advanceTimersByTime(UNFOLD_MS);
		const open = component.render(80);
		expect(stripAnsi(open.join("\n"))).toContain("reason 19");
		expect(middle).toBeGreaterThan(lines.length);
		expect(middle).toBeLessThan(open.length);
		vi.advanceTimersByTime(100);
		expect(vi.getTimerCount()).toBe(0);
	});

	// ctrl+o and ctrl+t were instant.
	it("unfolds the tool details on screen with ctrl+o, and changes the ones above the screen at once", () => {
		vi.useFakeTimers();
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		for (const on of [true, false]) {
			prism(on ? ["tools"] : []);
			const above = tool(ui);
			const below = tool(ui);
			const collapsed = above.render(80).length;
			const mode = toggles([above, below], collapsed);
			mode.onToolsKey();
			const first = { above: above.render(80).length, below: below.render(80).length };
			vi.advanceTimersByTime(UNFOLD_MS / 2);
			const middle = below.render(80).length;
			vi.advanceTimersByTime(UNFOLD_MS);
			const expanded = below.render(80).length;
			expect(expanded).toBeGreaterThan(collapsed);
			expect(first.above).toBe(expanded);
			if (on) {
				expect(first.below).toBe(collapsed);
				expect(middle).toBeGreaterThan(collapsed);
				expect(middle).toBeLessThan(expanded);
			} else expect(first.below).toBe(expanded);
			vi.advanceTimersByTime(100);
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	it("unfolds the thinking blocks on screen with ctrl+t", () => {
		vi.useFakeTimers();
		prism(["thinking"]);
		const message = new AssistantMessageComponent(thinkingMessage(), true);
		const hidden = message.render(80).length;
		toggles([message], 0).onThinkingKey();
		expect(message.render(80).length).toBe(hidden);
		vi.advanceTimersByTime(UNFOLD_MS / 2);
		const middle = message.render(80).length;
		vi.advanceTimersByTime(UNFOLD_MS);
		const shown = message.render(80);
		expect(stripAnsi(shown.join("\n"))).toContain("reason 19");
		expect(middle).toBeGreaterThan(hidden);
		expect(middle).toBeLessThan(shown.length);
		vi.advanceTimersByTime(100);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("starts no transition for a block whose first row is outside the given rows", () => {
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const blocks = [tool(ui), tool(ui), tool(ui)];
		const unfolded: Component[] = [];
		setRenderHooks({ unfold: (component) => unfolded.push(component) });
		const height = blocks[0]!.render(80).length;
		unfoldOnScreen(blocks, 80, height, 2 * height, ["tools"]);
		expect(unfolded).toEqual([blocks[1]]);
	});
});

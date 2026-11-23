// fork: the mouse behaves the same everywhere. maintainer's QA report on 1.0.0-fork.6: the
// wheel skipped several files, a click outside the file browser left it open, and Goal, a finished
// Plan and /perm opened with a click but then needed the keyboard. Measured in a real kitty: one
// wheel notch is one event, so the steps below are per event.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Component,
	Container,
	getKeybindings,
	SelectList,
	setKeybindings,
	type TUI,
	TuiAltScreen,
	type TuiMouseEvent,
	VStack,
} from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import docsCommand from "../src/fork/docs-command.ts";
import { EditorSlot } from "../src/fork/editor-slot.ts";
import { FileBrowser } from "../src/fork/file-browser.ts";
import { keyboardListMouse, optionRows } from "../src/fork/keyboard-list-mouse.ts";
import { closeMenusOnOutsidePress } from "../src/fork/outside-press.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { getSelectListTheme, initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ESC = "\x1b";

function mouse(type: TuiMouseEvent["type"], y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: type === "wheel" ? "none" : "left",
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width: 60,
		height: 30,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}
const wheel = (delta: number, y = 0) => mouse("wheel", y, { wheelDelta: delta });

/** A menu that only reads keys, as pi-tui-kit's: a SelectList whose arrows wrap around. */
class KeyboardMenu implements Component {
	readonly list: SelectList;
	readonly keys: string[] = [];
	chosen: string | undefined;
	constructor(count: number, visible = count) {
		const items = Array.from({ length: count }, (_, index) => ({ value: `item${index}`, label: `Item ${index}` }));
		this.list = new SelectList(items, visible, getSelectListTheme());
		this.list.onSelect = (item) => {
			this.chosen = item.value;
		};
	}
	render(width: number): string[] {
		return ["Title", "Some text", "", ...this.list.render(width), "", "↑/↓ navigate • enter select"];
	}
	handleInput(data: string): void {
		this.keys.push(data);
		this.list.handleInput(data);
	}
	invalidate(): void {}
	selectedRow(): number {
		return this.render(60).findIndex((line) => stripAnsi(line).trimStart().startsWith("→ "));
	}
}

describe("fork: one mouse behaviour everywhere", () => {
	const root = mkdtempSync(join(tmpdir(), "prism-mouse-"));
	beforeAll(() => {
		initTheme("prism");
		setKeybindings(new KeybindingsManager({}));
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("moves the file browser one entry per wheel notch", () => {
		for (const name of ["a", "b", "c", "d", "e", "f"]) writeFileSync(join(root, `${name}.txt`), "");
		const browser = new FileBrowser({
			root,
			height: () => 20,
			onAttach: () => {},
			onClose: () => {},
			requestRender: () => {},
		});
		const selected = () =>
			browser
				.render(40)
				.map((line) => stripAnsi(line))
				.findIndex((line) => line.includes("a.txt"));
		const first = selected();
		browser.handleMouse(wheel(1));
		browser.handleMouse(wheel(1));
		// The selection is drawn on a background; the list does not scroll, so find it by its style.
		const rows = browser.render(40);
		const highlighted = rows.findIndex((line) => line.includes("\x1b[48"));
		expect(highlighted - first).toBe(2);
	});

	it("scrolls a /docs page one line per wheel notch", async () => {
		let handler: RegisteredCommand["handler"] | undefined;
		docsCommand({
			registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				handler = command.handler;
			},
		} as unknown as ExtensionAPI);
		let reader: Component | undefined;
		let close: ((value: undefined) => void) | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				notify: () => {},
				custom: async <T>(
					factory: (tui: TUI, theme: Theme, keys: unknown, done: (result: T) => void) => Component,
				) =>
					new Promise<T>((resolve) => {
						reader = factory(
							{ terminal: { rows: 20 }, requestRender: () => {} } as unknown as TUI,
							{} as Theme,
							{},
							resolve,
						);
						close = resolve as (value: undefined) => void;
					}),
			},
		} as unknown as ExtensionContext;
		const done = handler?.("settings", ctx as ExtensionCommandContext);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const position = () => /(\d+)-\d+ \/ \d+/.exec(stripAnsi(reader!.render(80)[0]!))?.[1];
		expect(position()).toBe("1");
		expect(reader!.handleMouse?.(wheel(1))).toMatchObject({ handled: true });
		reader!.handleMouse?.(wheel(1));
		expect(position()).toBe("3");
		reader!.handleMouse?.(wheel(-1));
		expect(position()).toBe("2");
		close?.(undefined);
		await done;
	});

	it("drives a standard selector (/perm) with the wheel and a click", () => {
		let chosen: string | undefined;
		const selector = new ExtensionSelectorComponent(
			"Permissions",
			["ask", "safe", "broad"],
			(option) => {
				chosen = option;
			},
			() => {},
		);
		const lines = () => selector.render(60).map((line) => stripAnsi(line));
		const row = (text: string) => lines().findIndex((line) => line.includes(text));
		const selected = () =>
			lines()
				.find((line) => line.includes("→"))
				?.trim();
		selector.handleMouse(wheel(1));
		expect(selected()).toBe("→ safe");
		selector.handleMouse(wheel(1));
		selector.handleMouse(wheel(1));
		expect(selected()).toBe("→ broad");
		selector.handleMouse(wheel(-1));
		expect(selected()).toBe("→ safe");
		const askRow = row("ask");
		expect(selector.handleMouse(mouse("press", askRow))).toBeDefined();
		selector.handleMouse(mouse("click", askRow));
		expect(chosen).toBe("ask");
		expect(selected()).toBe("→ ask");
	});

	it("finds the options of a keyboard-only menu in its rows", () => {
		const menu = new KeyboardMenu(4);
		expect(optionRows(menu.render(60))).toEqual({ selected: 3, first: 3, last: 6 });
		const long = new KeyboardMenu(12, 5);
		long.handleInput("\x1b[B");
		long.handleInput("\x1b[B");
		expect(optionRows(long.render(60))).toMatchObject({ position: { index: 3, count: 12 } });
		expect(optionRows(["Title", "no list here"])).toBeUndefined();
	});

	it("drives a keyboard-only menu (Goal, Plan) with keys from the mouse", () => {
		const menu = new KeyboardMenu(4);
		keyboardListMouse(menu, wheel(1));
		keyboardListMouse(menu, wheel(1));
		expect(menu.selectedRow()).toBe(5);
		keyboardListMouse(menu, wheel(1));
		// The arrows wrap around at the end; the wheel stops there.
		keyboardListMouse(menu, wheel(1));
		expect(menu.selectedRow()).toBe(6);
		keyboardListMouse(menu, wheel(-1));
		expect(menu.selectedRow()).toBe(5);

		expect(keyboardListMouse(menu, mouse("press", 3))).toMatchObject({ handled: true });
		keyboardListMouse(menu, mouse("click", 3));
		expect(menu.chosen).toBe("item0");
		// Outside the options: not handled, no key.
		const before = menu.keys.length;
		expect(keyboardListMouse(menu, mouse("click", 0))).toBeUndefined();
		expect(menu.keys).toHaveLength(before);

		const long = new KeyboardMenu(12, 5);
		for (let notch = 0; notch < 20; notch++) keyboardListMouse(long, wheel(1));
		expect(optionRows(long.render(60))?.position).toEqual({ index: 12, count: 12 });
		keyboardListMouse(long, wheel(-1));
		expect(optionRows(long.render(60))?.position).toEqual({ index: 11, count: 12 });
	});

	describe("a click outside an open menu closes it", () => {
		const press = (column: number, row: number) => `\x1b[<0;${column + 1};${row + 1}M`;
		const release = (column: number, row: number) => `\x1b[<0;${column + 1};${row + 1}m`;

		/** Esc closes it, as menus do; it records the keys it got. */
		class Menu extends KeyboardMenu {
			closed = false;
			override handleInput(data: string): void {
				super.handleInput(data);
				if (getKeybindings().matches(data, "tui.select.cancel")) this.closed = true;
			}
		}

		function screen() {
			const terminal = new VirtualTerminal(60, 20);
			const tui = new TuiAltScreen(terminal);
			const transcript = new Container();
			for (let line = 0; line < 8; line++) transcript.addChild({ render: () => [`line ${line}`], invalidate() {} });
			const editor: Component = { render: () => ["> editor"], invalidate() {}, handleInput() {} };
			const slot = new EditorSlot();
			slot.addChild(editor);
			tui.addChild(transcript);
			tui.addChild(slot);
			// The fullscreen screen is a stack, as in the app (createChatViewport): each part gets its own box.
			tui.setLayoutRoot(
				new VStack([
					{ component: transcript, basis: "auto" },
					{ component: slot, basis: "auto" },
				]),
			);
			const question = { pending: false };
			closeMenusOnOutsidePress(
				tui,
				slot,
				() => editor,
				() => question.pending,
			);
			tui.start();
			return { terminal, tui, slot, editor, question };
		}

		it("closes an overlay, but not on a click inside it", async () => {
			const { terminal, tui } = screen();
			try {
				const menu = new Menu(3);
				tui.showOverlay(menu, { anchor: "top-left", width: 30, row: 0, col: 0 });
				await terminal.waitForRender();
				terminal.sendInput(press(5, 4));
				terminal.sendInput(release(5, 4));
				expect(menu.closed).toBe(false);
				terminal.sendInput(press(50, 15));
				terminal.sendInput(release(50, 15));
				expect(menu.closed).toBe(true);
				expect(menu.keys.at(-1)).toBe(ESC);
			} finally {
				tui.stop();
			}
		});

		it("leaves a question the model is waiting on open, a click elsewhere answers nothing", async () => {
			const { terminal, tui, slot, question } = screen();
			try {
				question.pending = true;
				const menu = new Menu(3);
				slot.clear();
				slot.addChild(menu);
				tui.setFocus(menu);
				tui.requestRender();
				await terminal.waitForRender();
				terminal.sendInput(press(5, 2));
				terminal.sendInput(release(5, 2));
				expect(menu.closed).toBe(false);
				question.pending = false;
				terminal.sendInput(press(5, 2));
				terminal.sendInput(release(5, 2));
				expect(menu.closed).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("closes a menu shown in place of the editor, and leaves the editor alone", async () => {
			const { terminal, tui, slot, editor } = screen();
			try {
				const editorKeys: string[] = [];
				editor.handleInput = (data) => editorKeys.push(data);
				terminal.sendInput(press(5, 2));
				terminal.sendInput(release(5, 2));
				expect(editorKeys).toEqual([]);

				const menu = new Menu(3);
				slot.clear();
				slot.addChild(menu);
				tui.setFocus(menu);
				tui.requestRender();
				await terminal.waitForRender();
				const menuRow = terminal.getViewport().findIndex((line) => line.includes("Item 1"));
				terminal.sendInput(press(5, menuRow));
				terminal.sendInput(release(5, menuRow));
				expect(menu.closed).toBe(false);
				// The click went through the slot to the keyboard-only menu: it picked the option.
				expect(menu.chosen).toBe("item1");
				terminal.sendInput(press(5, 2));
				terminal.sendInput(release(5, 2));
				expect(menu.closed).toBe(true);
			} finally {
				tui.stop();
			}
		});
	});
});

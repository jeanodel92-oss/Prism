/**
 * fork: a large paste lives in the editor as a "[paste #1 …]" marker. Opening the
 * extension editor's external editor wrote the marker, not the text, and reading it back dropped the paste; closing a
 * `ctx.ui.custom` window put the same marker back with setText, which also dropped the paste.
 */
import { Container, Editor, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const PASTE = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

describe("fork: a large paste survives the editor round trips", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("gives the external editor the pasted text and submits it", async () => {
		const tui = { stop() {}, start() {}, requestRender() {} };
		let submitted: string | undefined;
		const component = new ExtensionEditorComponent(
			tui as never,
			new KeybindingsManager(),
			"Edit",
			undefined,
			(value) => {
				submitted = value;
			},
			() => {},
			undefined,
			"true", // an editor that exits at once without changing the file
		);
		component.handleInput(`\x1b[200~${PASTE}\x1b[201~`);
		await (Reflect.get(component, "handleOpenExternalEditor") as () => Promise<void>).call(component);
		component.handleInput("\r");
		expect(submitted).toBe(PASTE);
	});

	it("keeps the paste of a draft left untouched by a custom window", async () => {
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const editor = new Editor(ui, getEditorTheme());
		editor.handleInput(`\x1b[200~${PASTE}\x1b[201~`);
		expect(editor.getText()).toMatch(/^\[paste #1/);
		const mode = {
			ui,
			editor,
			editorContainer: new Container(),
			extensionWindowsOpened: 0,
			keybindings: {},
			disposeActiveSelector: () => {},
		};
		const show = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as (
			this: typeof mode,
			factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: string) => void) => unknown,
		) => Promise<string | undefined>;
		await show.call(mode, (_tui, _theme, _keys, done) => {
			queueMicrotask(() => done("closed"));
			return { render: () => ["window"], invalidate() {} };
		});
		expect(editor.getExpandedText()).toBe(PASTE);
	});
});

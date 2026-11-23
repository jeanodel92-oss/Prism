/**
 * fork: the ctrl+z defect was invisible because key bindings were tested
 * as a table. This test sends the raw byte a terminal sends for ctrl+z (0x1a) to the terminal's real composer, with
 * the interactive mode's suspend handler attached, and checks that it undoes and never suspends.
 */
import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createEditorFactory } from "../src/fork/prism/editor.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("fork: ctrl+z from the terminal to the composer", () => {
	beforeAll(() => {
		initTheme("prism");
		setKeybindings(new KeybindingsManager({}));
	});

	for (const [name, makeEditor] of [
		[
			"Prism's composer",
			() => {
				const state = createState();
				state.theme = theme;
				return createEditorFactory(state)(
					new TuiMainScreen(new VirtualTerminal()),
					defaultEditorTheme,
					new KeybindingsManager({}),
				) as CustomEditor;
			},
		],
		[
			"the default editor",
			() =>
				new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, new KeybindingsManager({})),
		],
	] as const) {
		it(`undoes in ${name} and does not suspend`, () => {
			const editor = makeEditor();
			const suspend = vi.fn();
			editor.onAction("app.suspend", suspend);
			for (const char of "hello world") editor.handleInput(char);
			editor.handleInput("\x1a");
			expect(editor.getText()).toBe("hello");
			expect(suspend).not.toHaveBeenCalled();
		});
	}
});

/**
 * fork: ctrl+backspace and ctrl+delete delete a word in the editor and the
 * input, as in most editors; before, ctrl+delete did nothing and ctrl+backspace deleted one character.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const CTRL_BACKSPACE = "\x1b[127;5u"; // kitty keyboard protocol
const CTRL_DELETE = "\x1b[3;5~";
const HOME = "\x1b[H";
const CTRL_RIGHT = "\x1b[1;5C";

const type = (target: { handleInput(data: string): void }, text: string) => {
	for (const char of text) target.handleInput(char);
};

describe("fork: word deletion keys", () => {
	it("deletes the word before the cursor with ctrl+backspace, and after it with ctrl+delete, in the editor", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		type(editor, "one two three");
		editor.handleInput(CTRL_BACKSPACE);
		assert.strictEqual(editor.getText(), "one two ");
		editor.handleInput(HOME);
		editor.handleInput(CTRL_DELETE);
		assert.strictEqual(editor.getText(), " two ");
	});

	it("does the same in the input", () => {
		const input = new Input();
		type(input, "one two three");
		input.handleInput(CTRL_BACKSPACE);
		assert.strictEqual(input.getValue(), "one two ");
		input.handleInput(HOME);
		input.handleInput(CTRL_RIGHT);
		input.handleInput(CTRL_DELETE);
		assert.strictEqual(input.getValue(), "one ");
	});
});

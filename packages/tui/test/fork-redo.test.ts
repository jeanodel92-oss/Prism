/**
 * fork: redo in the editor and the input. Undo took an edit back with no way to put it
 * back; tui.editor.redo (ctrl+shift+z here, ctrl+y too in the coding agent) redoes what undo took, and a new edit
 * drops what was left to redo.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const UNDO = "\x1b[45;5u"; // ctrl+-
const REDO = "\x1b[122;6u"; // ctrl+shift+z

const type = (target: { handleInput(data: string): void }, text: string) => {
	for (const char of text) target.handleInput(char);
};

describe("fork: redo", () => {
	it("puts back in the editor what undo took, in order", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		type(editor, "hello world");
		editor.handleInput(UNDO);
		editor.handleInput(UNDO);
		assert.strictEqual(editor.getText(), "");
		editor.handleInput(REDO);
		assert.strictEqual(editor.getText(), "hello");
		editor.handleInput(REDO);
		assert.strictEqual(editor.getText(), "hello world");
		editor.handleInput(REDO);
		assert.strictEqual(editor.getText(), "hello world");
		editor.handleInput(UNDO);
		assert.strictEqual(editor.getText(), "hello");
	});

	it("drops what was left to redo in the editor after a new edit", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		type(editor, "hello world");
		editor.handleInput(UNDO);
		type(editor, "!");
		editor.handleInput(REDO);
		assert.strictEqual(editor.getText(), "hello!");
	});

	it("puts back in the input what undo took, and a new edit drops it", () => {
		const input = new Input();
		type(input, "hello world");
		input.handleInput(UNDO);
		assert.strictEqual(input.getValue(), "hello");
		input.handleInput(REDO);
		assert.strictEqual(input.getValue(), "hello world");
		input.handleInput(UNDO);
		type(input, "!");
		input.handleInput(REDO);
		assert.strictEqual(input.getValue(), "hello!");
	});
});

/**
 * fork: keyboard selection in the prompt editor, and a small
 * conformance suite for what an ordinary text box does (move and delete by word, line start and end,
 * delete or paste over a selection, wide characters and emoji).
 */
import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import { setKittyProtocolActive } from "../src/keys.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Legacy xterm sequences, as sent by most terminals and by tmux.
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const HOME = "\x1b[H";
const END = "\x1b[F";
const SHIFT_LEFT = "\x1b[1;2D";
const SHIFT_RIGHT = "\x1b[1;2C";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const SHIFT_HOME = "\x1b[1;2H";
const SHIFT_END = "\x1b[1;2F";
const CTRL_SHIFT_LEFT = "\x1b[1;6D";
const CTRL_SHIFT_RIGHT = "\x1b[1;6C";
const ALT_SHIFT_LEFT = "\x1b[1;4D";
const CTRL_LEFT = "\x1b[1;5D";
const CTRL_RIGHT = "\x1b[1;5C";
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";
const SHIFT_BACKSPACE = "\x1b[127;2u";
const CTRL_BACKSPACE = "\x1b[127;5u";
const CTRL_DELETE = "\x1b[3;5~";
const CTRL_W = "\x17";
const ALT_D = "\x1bd";
const CTRL_A = "\x01";
const CTRL_E = "\x05";
const UNDO = "\x1b[45;5u"; // ctrl+-
const SHIFT_ENTER = "\x1b[13;2u";

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

function createEditor(cols = 80): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(cols, 24)), defaultEditorTheme);
	editor.focused = true;
	return editor;
}

function type(editor: Editor, text: string): void {
	for (const char of text) editor.handleInput(char);
}

function press(editor: Editor, key: string, times = 1): void {
	for (let i = 0; i < times; i++) editor.handleInput(key);
}

afterEach(() => setKittyProtocolActive(false));

describe("fork: keyboard selection in the editor", () => {
	it("replaces the text selected with shift+left by what is typed next", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, SHIFT_LEFT, 3);
		assert.strictEqual(editor.getSelectedText(), "rld");
		type(editor, "X");
		assert.strictEqual(editor.getText(), "hello woX");
		assert.strictEqual(editor.getSelectedText(), undefined);
	});

	it("selects the line with home then shift+end, and a character replaces it", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, HOME);
		press(editor, SHIFT_END);
		assert.strictEqual(editor.getSelectedText(), "hello world");
		type(editor, "Z");
		assert.strictEqual(editor.getText(), "Z");
	});

	it("selects to the line start with shift+home", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, LEFT, 6);
		press(editor, SHIFT_HOME);
		assert.strictEqual(editor.getSelectedText(), "hello");
	});

	it("selects by word with ctrl+shift and alt+shift arrows", () => {
		const editor = createEditor();
		type(editor, "one two three");
		press(editor, CTRL_SHIFT_LEFT);
		assert.strictEqual(editor.getSelectedText(), "three");
		press(editor, ALT_SHIFT_LEFT);
		assert.strictEqual(editor.getSelectedText(), "two three");
		press(editor, CTRL_SHIFT_RIGHT); // to the end of "two"
		assert.strictEqual(editor.getSelectedText(), " three");
	});

	it("shrinks the selection when moving back over the anchor, and drops it when empty", () => {
		const editor = createEditor();
		type(editor, "abcdef");
		press(editor, SHIFT_LEFT, 2);
		press(editor, SHIFT_RIGHT, 2);
		assert.strictEqual(editor.getSelectedText(), undefined);
		press(editor, SHIFT_RIGHT); // at the end: nothing to select
		assert.strictEqual(editor.getSelectedText(), undefined);
		type(editor, "g");
		assert.strictEqual(editor.getText(), "abcdefg");
	});

	it("collapses to the selection edge with left and right, like a text field", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, SHIFT_LEFT, 5);
		press(editor, LEFT);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		assert.strictEqual(editor.getSelectedText(), undefined);

		press(editor, HOME);
		press(editor, SHIFT_RIGHT, 5);
		press(editor, LEFT); // anchor was the left edge
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		press(editor, SHIFT_RIGHT, 5);
		press(editor, RIGHT);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		type(editor, "!");
		assert.strictEqual(editor.getText(), "hello! world");
	});

	it("drops the selection on other cursor moves, which then move normally", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, SHIFT_LEFT, 3);
		press(editor, HOME);
		assert.strictEqual(editor.getSelectedText(), undefined);
		type(editor, ">");
		assert.strictEqual(editor.getText(), ">hello world");
	});

	it("deletes the selection with backspace, delete and the word and line deletion keys", () => {
		for (const key of [BACKSPACE, DELETE, SHIFT_BACKSPACE, CTRL_BACKSPACE, CTRL_DELETE, CTRL_W, ALT_D, "\x0b"]) {
			const editor = createEditor();
			type(editor, "one two three");
			press(editor, LEFT, 6);
			press(editor, SHIFT_LEFT, 3);
			editor.handleInput(key);
			assert.strictEqual(editor.getText(), "one  three", `key ${JSON.stringify(key)}`);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });
		}
	});

	it("restores the replaced text with one undo", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, SHIFT_LEFT, 5);
		type(editor, "there");
		assert.strictEqual(editor.getText(), "hello there");
		press(editor, UNDO);
		assert.strictEqual(editor.getText(), "hello world");
	});

	it("keeps word-by-word undo after a replacement", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, SHIFT_LEFT, 5);
		type(editor, "big cat");
		assert.strictEqual(editor.getText(), "hello big cat");
		press(editor, UNDO);
		assert.strictEqual(editor.getText(), "hello big");
		press(editor, UNDO);
		assert.strictEqual(editor.getText(), "hello world");
	});

	it("restores a deleted selection with undo", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, SHIFT_HOME);
		press(editor, BACKSPACE);
		assert.strictEqual(editor.getText(), "");
		press(editor, UNDO);
		assert.strictEqual(editor.getText(), "hello world");
	});

	it("pastes over the selection, undone in one step", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, CTRL_SHIFT_LEFT);
		editor.handleInput(paste("there"));
		assert.strictEqual(editor.getText(), "hello there");
		press(editor, UNDO);
		assert.strictEqual(editor.getText(), "hello world");
	});

	it("replaces the selection with a new line", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, LEFT, 5);
		press(editor, SHIFT_LEFT);
		editor.handleInput(SHIFT_ENTER);
		assert.strictEqual(editor.getText(), "hello\nworld");
	});

	it("replaces the selection with programmatic insertion", () => {
		const editor = createEditor();
		type(editor, "see image");
		press(editor, CTRL_SHIFT_LEFT);
		editor.insertTextAtCursor("[image]");
		assert.strictEqual(editor.getText(), "see [image]");
	});

	it("selects across lines with shift+up and shift+down", () => {
		const editor = createEditor();
		type(editor, "first line");
		editor.handleInput(SHIFT_ENTER);
		type(editor, "second line");
		press(editor, SHIFT_UP); // column 11 is past the end of "first line"
		assert.strictEqual(editor.getSelectedText(), "\nsecond line");
		press(editor, SHIFT_UP); // already on the first line: extends to its start
		assert.strictEqual(editor.getSelectedText(), "first line\nsecond line");
		press(editor, SHIFT_DOWN);
		assert.strictEqual(editor.getSelectedText(), "second line");
		press(editor, SHIFT_DOWN); // already on the last line: extends to its end, back on the anchor
		assert.strictEqual(editor.getSelectedText(), undefined);
		press(editor, SHIFT_UP);
		press(editor, BACKSPACE);
		assert.strictEqual(editor.getText(), "first line");
	});

	it("drops the selection on submit and history browsing keys", () => {
		const editor = createEditor();
		let submitted: string | undefined;
		editor.onSubmit = (text) => {
			submitted = text;
			editor.addToHistory(text);
		};
		type(editor, "hello");
		press(editor, SHIFT_LEFT, 2);
		editor.handleInput("\r");
		assert.strictEqual(submitted, "hello");
		assert.strictEqual(editor.getSelectedText(), undefined);
		press(editor, UP);
		assert.strictEqual(editor.getText(), "hello");
		type(editor, "!"); // the history entry opens with the cursor at its start
		assert.strictEqual(editor.getText(), "!hello");
	});

	it("expands paste markers in the selected text", () => {
		const editor = createEditor();
		const big = "x".repeat(1200);
		type(editor, "a ");
		editor.handleInput(paste(big));
		press(editor, SHIFT_HOME);
		assert.strictEqual(editor.getSelectedText(), `a ${big}`);
	});

	it("selects whole emoji and wide characters, and replaces them", () => {
		const editor = createEditor();
		type(editor, "日本語👍🏽ok");
		press(editor, SHIFT_LEFT, 3);
		assert.strictEqual(editor.getSelectedText(), "👍🏽ok");
		type(editor, "X");
		assert.strictEqual(editor.getText(), "日本語X");
		press(editor, SHIFT_LEFT, 2);
		assert.strictEqual(editor.getSelectedText(), "語X");
		press(editor, BACKSPACE);
		assert.strictEqual(editor.getText(), "日本");
	});

	it("parses the rxvt and kitty forms of shift+arrow", () => {
		const editor = createEditor();
		type(editor, "hello");
		press(editor, "\x1b[d"); // rxvt shift+left
		assert.strictEqual(editor.getSelectedText(), "o");
		setKittyProtocolActive(true);
		press(editor, "\x1b[1;2:2D"); // kitty shift+left, key repeat
		assert.strictEqual(editor.getSelectedText(), "lo");
		press(editor, "\x1b[1;2:1H"); // kitty shift+home, explicit press
		assert.strictEqual(editor.getSelectedText(), "hello");
	});

	it("renders the selection in inverse video, without a separate cursor block", () => {
		const editor = createEditor(40);
		type(editor, "hello world");
		press(editor, SHIFT_LEFT, 3);
		const line = editor.render(40)[1]!.replace(CURSOR_MARKER, "");
		assert.ok(line.includes("hello wo\x1b[7mrld\x1b[27m"), JSON.stringify(line));
		assert.ok(!line.includes("\x1b[7m \x1b[0m"), "no cursor block after the selection");
		assert.strictEqual(visibleWidth(line), 40);
		assert.strictEqual(stripVTControlCharacters(line).trimEnd(), "hello world");
	});

	it("shows a selected line break as an inverse space", () => {
		const editor = createEditor(40);
		type(editor, "ab");
		editor.handleInput(SHIFT_ENTER);
		type(editor, "cd");
		press(editor, SHIFT_UP);
		const lines = editor.render(40).map((line) => line.replace(CURSOR_MARKER, ""));
		assert.ok(lines[1]!.includes("ab\x1b[7m \x1b[27m"), JSON.stringify(lines[1]));
		assert.ok(lines[2]!.includes("\x1b[7mcd\x1b[27m"), JSON.stringify(lines[2]));
		for (const line of lines) assert.ok(visibleWidth(line) <= 40);
	});

	it("keeps wrapped and wide-character lines within a narrow width", () => {
		for (const width of [8, 20, 64]) {
			const editor = createEditor(width);
			type(editor, "日本語のテキストと emoji 👍🏽 and some long words to wrap around");
			editor.handleInput(SHIFT_ENTER);
			type(editor, "second");
			press(editor, SHIFT_UP, 3);
			press(editor, SHIFT_LEFT, 4);
			const lines = editor.render(width);
			assert.ok(lines.some((line) => line.includes("\x1b[7m")));
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
		}
	});
});

describe("fork: basic text editing conformance (TESTS-10)", () => {
	it("moves by word with ctrl+left/right and alt+b/f", () => {
		const editor = createEditor();
		type(editor, "one two three");
		press(editor, CTRL_LEFT);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });
		press(editor, "\x1bb");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });
		press(editor, CTRL_RIGHT);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });
		press(editor, "\x1bf");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 13 });
	});

	it("deletes a word backward with ctrl+w and ctrl+backspace, forward with alt+d and ctrl+delete", () => {
		const editor = createEditor();
		type(editor, "one two three four");
		press(editor, CTRL_W);
		assert.strictEqual(editor.getText(), "one two three ");
		press(editor, CTRL_BACKSPACE);
		assert.strictEqual(editor.getText(), "one two ");
		press(editor, HOME);
		press(editor, ALT_D);
		assert.strictEqual(editor.getText(), " two ");
		press(editor, CTRL_DELETE);
		assert.strictEqual(editor.getText(), " ");
	});

	it("goes to the line start and end with home/end and ctrl+a/ctrl+e", () => {
		const editor = createEditor();
		type(editor, "hello");
		press(editor, HOME);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		press(editor, END);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		press(editor, CTRL_A);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		press(editor, CTRL_E);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
	});

	it("deletes whole emoji and wide characters with backspace and delete", () => {
		const editor = createEditor();
		type(editor, "a👍🏽日b");
		press(editor, LEFT);
		press(editor, BACKSPACE);
		assert.strictEqual(editor.getText(), "a👍🏽b");
		press(editor, BACKSPACE);
		assert.strictEqual(editor.getText(), "ab");
		press(editor, HOME);
		press(editor, DELETE);
		assert.strictEqual(editor.getText(), "b");
	});

	it("pastes at the cursor, in the middle of the text", () => {
		const editor = createEditor();
		type(editor, "hello world");
		press(editor, LEFT, 6);
		editor.handleInput(paste(", big"));
		assert.strictEqual(editor.getText(), "hello, big world");
	});
});

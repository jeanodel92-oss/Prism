/**
 * fork: the editor's paste markers and the Enter key on a completion.
 * - expanding the markers ran once per paste over the whole result, so a paste quoting "[paste #2]" got the
 *   second paste inserted into it.
 * - deleting a marker renumbered [paste #10] to [paste #9] before cutting the line at the old column, which
 *   kept a "[" of the deleted marker and ate the next character.
 * - Enter on the completion of an absolute path in the middle of the draft also sent the draft.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): { editor: Editor; submitted: string[] } {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	return { editor, submitted };
}

const paste = (editor: Editor, text: string) => editor.handleInput(`\x1b[200~${text}\x1b[201~`);

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

function provider(items: string[], prefixOf: (beforeCursor: string) => string): AutocompleteProvider {
	return {
		getSuggestions: async (lines, cursorLine, cursorCol) => ({
			items: items.map((value) => ({ value, label: value })),
			prefix: prefixOf((lines[cursorLine] ?? "").slice(0, cursorCol)),
		}),
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
			const line = lines[cursorLine] ?? "";
			const next = [...lines];
			next[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
			return { lines: next, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
		},
	};
}

describe("fork: the editor's paste markers and completions", () => {
	it("sends a paste that quotes another paste's marker as it was pasted", () => {
		const { editor, submitted } = createEditor();
		const first = `${"a".repeat(1100)} [paste #2] `;
		const second = "b".repeat(1100);
		paste(editor, first);
		paste(editor, second);
		assert.match(editor.getText(), /^\[paste #1 \d+ chars\]\[paste #2 \d+ chars\]$/);
		assert.strictEqual(editor.getExpandedText(), first + second);
		editor.handleInput("\r");
		assert.deepStrictEqual(submitted, [(first + second).trim()]);
	});

	it("deletes a marker whole when an earlier marker loses a digit", () => {
		const { editor, submitted } = createEditor();
		const contents = Array.from({ length: 10 }, (_, index) => String.fromCharCode(65 + index).repeat(1001));
		paste(editor, contents[0]!);
		editor.handleInput("hello");
		editor.handleInput("\x01"); // Ctrl+A: pastes 2 to 10 go before paste 1
		for (const content of contents.slice(1)) paste(editor, content);
		assert.match(editor.getText(), /\[paste #10 1001 chars\]\[paste #1 1001 chars\]hello$/);
		editor.handleInput("\x05"); // Ctrl+E
		for (let i = 0; i < "hello".length; i++) editor.handleInput("\x1b[D");
		editor.handleInput("\x7f"); // Backspace deletes [paste #1]

		const text = editor.getText();
		assert.match(text, /^(\[paste #\d 1001 chars\]){9}hello$/);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: text.indexOf("hello") });
		editor.handleInput("\r");
		assert.deepStrictEqual(submitted, [`${contents.slice(1).join("")}hello`]);
	});

	it("writes an absolute path chosen with Enter and keeps the draft open", async () => {
		const { editor, submitted } = createEditor();
		editor.setAutocompleteProvider(
			provider(["/tmp/proj-a/", "/tmp/proj-b/"], (before) => before.slice(before.lastIndexOf(" ") + 1)),
		);
		editor.setText("Consulte /tmp/proj");
		editor.handleInput("\t");
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		editor.handleInput("\r");
		assert.strictEqual(editor.getText(), "Consulte /tmp/proj-a/");
		assert.deepStrictEqual(submitted, []);
	});

	it("still sends a command name chosen with Enter", async () => {
		const { editor, submitted } = createEditor();
		editor.setAutocompleteProvider(provider(["/model", "/mode"], (before) => before.trimStart()));
		editor.setText("/mo");
		editor.handleInput("\t");
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		editor.handleInput("\r");
		assert.deepStrictEqual(submitted, ["/model"]);
	});
});

/**
 * fork: no recursion on a structure the user or the model sizes. A grapheme
 * wider than the editor and a LaTeX block with a forged layout marker or thousands of nested groups
 * used to overflow the stack while rendering.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, wordWrapLine } from "../src/components/editor.ts";
import { renderLatex } from "../src/latex.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("fork: grapheme wider than the line", () => {
	it("gives it a chunk of its own", () => {
		assert.deepStrictEqual(wordWrapLine("界", 1), [{ text: "界", startIndex: 0, endIndex: 1 }]);
		assert.deepStrictEqual(
			wordWrapLine("a界😀b", 1).map((chunk) => chunk.text),
			["a", "界", "😀", "b"],
		);
	});

	it("renders a CJK and emoji draft within one to three columns", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(2, 10)), defaultEditorTheme);
		editor.setText("界😀\n漢字");
		for (const width of [1, 2, 3]) {
			for (const line of editor.render(width))
				assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
		}
		assert.strictEqual(editor.getText(), "界😀\n漢字");
	});
});

describe("fork: LaTeX that would recurse without end", () => {
	it("leaves a block with a layout marker of its own unrendered", () => {
		const marker = "\u{f0000}0\u{f0001}";
		assert.strictEqual(renderLatex(`\\frac{${marker}}{x}`, { display: true }), undefined);
		assert.strictEqual(
			renderLatex(`\\frac{\u{f0000}1\u{f0001}}{\\frac{\u{f0000}0\u{f0001}}{y}}`, { display: true }),
			undefined,
		);
	});

	it("leaves thousands of nested groups unrendered, and still renders ordinary nesting", () => {
		assert.strictEqual(renderLatex(`${"\\frac{".repeat(2000)}x${"}{y}".repeat(2000)}`, { display: true }), undefined);
		assert.strictEqual(renderLatex(`${"{".repeat(10_000)}x${"}".repeat(10_000)}`), undefined);
		assert.strictEqual(renderLatex(`${"x^{".repeat(5000)}y${"}".repeat(5000)}`), undefined);
		assert.ok(renderLatex(`${"\\frac{".repeat(5)}x${"}{y}".repeat(5)}`, { display: true })?.includes("x"));
	});
});

// fork: a model often soft-wraps a paragraph inside an inline formula
// ("$E =\nmc^2$"); the formula stayed raw. It may now span one line break of its paragraph, never more, never a
// blank line or a block boundary, and prices on two lines stay text.
import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const plain = (source: string, width = 80) =>
	new Markdown(source, 0, 0, defaultMarkdownTheme)
		.render(width)
		.map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07/g, "").trimEnd());

describe("fork: inline math over a soft line break", () => {
	it("renders a $…$ formula wrapped once", () => {
		assert.deepStrictEqual(plain("the energy $E =\nmc^2$ is conserved"), ["the energy E = mc² is conserved"]);
		assert.deepStrictEqual(plain("a ratio $\\frac{a}{\nb}$ here"), ["a ratio a/b here"]);
		assert.deepStrictEqual(plain("map \\(s \\to\n\\infty\\) too"), ["map s → ∞ too"]);
	});

	it("renders it inside a list item", () => {
		assert.deepStrictEqual(plain("- the energy $E =\n  mc^2$ is"), ["- the energy E = mc² is"]);
	});

	it("wraps the rendered formula at a narrow width", () => {
		const lines = plain("the energy of a body at rest is $E =\nmc^2$ by the famous relation", 40);
		assert.ok(
			lines.every((line) => !line.includes("$")),
			lines.join("|"),
		);
		assert.ok(lines.join(" ").includes("E = mc²"), lines.join("|"));
	});

	it("leaves prices and shell variables on two lines as text", () => {
		assert.deepStrictEqual(plain("It costs $5 and\n$10 with tax"), ["It costs $5 and", "$10 with tax"]);
		assert.deepStrictEqual(plain("I paid $5\nand you paid $3."), ["I paid $5", "and you paid $3."]);
		assert.deepStrictEqual(plain("Paths: $HOME/x\n$USER/y"), ["Paths: $HOME/x", "$USER/y"]);
		assert.deepStrictEqual(plain("From $8k to\n$12k"), ["From $8k to", "$12k"]);
	});

	it("never spans two line breaks, a blank line or a block boundary", () => {
		assert.deepStrictEqual(plain("x $a +\nb +\nc$ y"), ["x $a +", "b +", "c$ y"]);
		assert.deepStrictEqual(plain("x $a =\n\nb$ y"), ["x $a =", "", "b$ y"]);
		assert.deepStrictEqual(plain("- $a =\n- b$"), ["- $a =", "- b$"]);
	});

	it("keeps escaped dollars and code spans as text", () => {
		assert.deepStrictEqual(plain("x \\$a =\nb\\$ y"), ["x $a =", "b$ y"]);
		assert.deepStrictEqual(plain("x `$a =`\n`b$` y"), ["x $a =", "b$ y"]);
	});

	it("still renders a $$ display block", () => {
		assert.deepStrictEqual(plain("$$\nE =\nmc^2\n$$"), ["E = mc²"]);
	});
});

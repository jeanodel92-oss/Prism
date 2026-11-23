// fork: a model often soft-wraps a paragraph inside an inline formula
// ("$E =\nmc^2$"); the formula stayed raw in the window as in the terminal. It may now span one line break of its
// paragraph, never more, never a blank line or a block boundary, and prices on two lines stay text. Same cases as
// packages/tui/test/fork-latex-soft-wrap.test.ts. Run by hand:
// node --test --experimental-test-module-mocks fork/gui/tests/math-soft-wrap.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import vm from "node:vm";
import { Marked } from "../ui/vendor/marked.esm.js";
import { LATEX_EXTENSIONS } from "../ui/js/math-tokens.js";

const lexer = new Marked({ gfm: true, breaks: false }).use({ extensions: LATEX_EXTENSIONS });

/** Every math token of a Markdown text, in order: { type, text, pending? }. */
function maths(markdown) {
	const found = [];
	const walk = (tokens = []) => {
		for (const token of tokens) {
			if (token.type === "latex" || token.type === "latexBlock")
				found.push({ type: token.type, text: token.text, ...(token.pending ? { pending: true } : {}) });
			walk(token.tokens);
			walk(token.items);
		}
	};
	walk(lexer.lexer(markdown));
	return found;
}

const inline = (text) => ({ type: "latex", text });

test("a formula wrapped once is math", () => {
	assert.deepEqual(maths("the energy $E =\nmc^2$ is conserved"), [inline("E =\nmc^2")]);
	assert.deepEqual(maths("a ratio $\\frac{a}{\nb}$ here"), [inline("\\frac{a}{\nb}")]);
	assert.deepEqual(maths("map \\(s \\to\n\\infty\\) too"), [inline("s \\to\n\\infty")]);
	assert.deepEqual(maths("- the energy $E =\n  mc^2$ is"), [inline("E =\nmc^2")]);
});

test("prices and shell variables on two lines stay text", () => {
	assert.deepEqual(maths("It costs $5 and\n$10 with tax"), []);
	assert.deepEqual(maths("I paid $5\nand you paid $3."), []);
	assert.deepEqual(maths("Paths: $HOME/x\n$USER/y"), []);
	assert.deepEqual(maths("From $8k to\n$12k"), []);
});

test("never two line breaks, a blank line or a block boundary", () => {
	// The opening "$a =" alone in its block stays an unclosed (pending) formula, shown as written, as before.
	const closed = (markdown) => maths(markdown).filter((token) => !token.pending);
	assert.deepEqual(closed("x $a +\nb +\nc$ y"), []);
	assert.deepEqual(closed("x $a =\n\nb$ y"), []);
	assert.deepEqual(closed("- $a =\n- b$"), []);
});

test("escaped dollars and code spans stay text", () => {
	assert.deepEqual(maths("x \\$a =\nb\\$ y"), []);
	assert.deepEqual(maths("x `$a =`\n`b$` y"), []);
});

test("a $$ display block still works", () => {
	assert.deepEqual(maths("$$\nE =\nmc^2\n$$"), [{ type: "latexBlock", text: "E =\nmc^2" }]);
});

// The window's Markdown, with math.js replaced by a stand-in that marks what it was given.
const element = (tag, attrs = {}, ...children) => ({
	tag,
	text: attrs.text,
	children: children.flat().filter((child) => child !== undefined && child !== null && child !== false),
	append(...more) {
		this.children.push(...more);
	},
});
mock.module(new URL("../ui/js/dom.js", import.meta.url).href, { namedExports: { h: element, copyText() {} } });
mock.module(new URL("../ui/js/diagram.js", import.meta.url).href, { namedExports: { diagram() {} } });
mock.module(new URL("../ui/js/i18n.js", import.meta.url).href, { namedExports: { t: (key) => key } });
mock.module(new URL("../ui/js/math.js", import.meta.url).href, {
	namedExports: {
		math: (token, display) => (token.pending ? token.raw : element(display ? "math-block" : "math", { text: `[${token.text}]` })),
	},
});
const { renderMarkdown } = await import("../ui/js/markdown.js");
const text = (node) => (typeof node === "string" ? node : (node.text ?? "") + node.children.map((child) => text(child)).join(""));

test("the window's Markdown draws the wrapped formula and keeps two prices as text", () => {
	assert.equal(text(renderMarkdown("the energy $E =\nmc^2$ is")), "the energy [E =\nmc^2] is");
	assert.equal(text(renderMarkdown("It costs $5 and\n$10 with tax")), "It costs $5 and\n$10 with tax");
	assert.equal(text(renderMarkdown("x $a =\n\nb$ y")), "x $a =b$ y", "two paragraphs, no formula");
});

test("KaTeX draws the wrapped source as the one-line one", () => {
	// The window's copy of KaTeX (scripts/prepare.sh), loaded as the page loads it.
	const self = {};
	vm.runInNewContext(readFileSync(new URL("../ui/vendor/katex/katex.min.js", import.meta.url), "utf8"), { self });
	const draw = (source) => self.katex.renderToString(source, { throwOnError: true, output: "html" });
	assert.equal(draw("E =\nmc^2"), draw("E = mc^2"));
	assert.equal(draw("\\frac{a}{\nb}"), draw("\\frac{a}{b}"));
});

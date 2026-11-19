// fork: math in the window's Markdown. What is math must be what the terminal reads as math
// (packages/tui/test/markdown.test.ts, "LaTeX math"): the same cases, on the window's tokenizer (math-tokens.js) and
// its Markdown (markdown.js). Run by hand:
// node --test --experimental-test-module-mocks fork/gui/tests/math.test.mjs
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Marked } from "../ui/vendor/marked.esm.js";
import { LATEX_EXTENSIONS } from "../ui/js/math-tokens.js";

const lexer = new Marked({ gfm: true, breaks: false }).use({ extensions: LATEX_EXTENSIONS });

/** Every math token of a Markdown text, in order: { type, text, pending }. */
function maths(markdown) {
	const found = [];
	const walk = (tokens = []) => {
		for (const token of tokens) {
			if (token.type === "latex" || token.type === "latexBlock")
				found.push({ type: token.type, text: token.text, ...(token.pending ? { pending: true } : {}) });
			walk(token.tokens);
			walk(token.items);
			for (const cell of token.header ?? []) walk(cell.tokens);
			for (const row of token.rows ?? []) for (const cell of row) walk(cell.tokens);
		}
	};
	walk(lexer.lexer(markdown));
	return found;
}

const inline = (text) => ({ type: "latex", text });
const block = (text) => ({ type: "latexBlock", text });

test("inline dollar and parenthesis delimiters", () => {
	assert.deepEqual(
		maths(String.raw`A map $\mathbb{C}^3 \to \mathbb{C}^3$, $xy$, $x-y$, $-x$, $\frac{1}{2}$, $\rightarrow$, and \(s \to \infty\).`),
		[String.raw`\mathbb{C}^3 \to \mathbb{C}^3`, "xy", "x-y", "-x", String.raw`\frac{1}{2}`, String.raw`\rightarrow`, String.raw`s \to \infty`].map(inline),
	);
	assert.deepEqual(maths(String.raw`inline $$a+b$$ and \[c\] too`), [inline("a+b"), inline("c")]);
});

test("display dollar delimiters, between paragraphs", () => {
	const source = String.raw`Before

$$\{3x+2y,\; x \in \{0, \pm 1\}\}$$

after`;
	assert.deepEqual(maths(source), [block(String.raw`\{3x+2y,\; x \in \{0, \pm 1\}\}`)]);
	assert.deepEqual(
		lexer.lexer(source).filter((token) => token.type !== "space").map((token) => token.type),
		["paragraph", "latexBlock", "paragraph"],
	);
});

test("display bracket delimiters, a matrix and a limit", () => {
	assert.deepEqual(maths("Before\n\n\\[\nE \\approx \\frac{0.1\\ \\text{lux}}{100\\ \\text{lm/W}}\n\\]\n\nafter"), [
		block(String.raw`E \approx \frac{0.1\ \text{lux}}{100\ \text{lm/W}}`),
	]);
	assert.deepEqual(maths("Consider the matrix\n\n\\[\nA=\n\\begin{pmatrix}\n\\pi & 0\\\\\n0 & \\frac{1}{\\pi}\n\\end{pmatrix}.\n\\]"), [
		block("A=\n\\begin{pmatrix}\n\\pi & 0\\\\\n0 & \\frac{1}{\\pi}\n\\end{pmatrix}."),
	]);
	assert.deepEqual(maths("\\[\n\\lim_{x\\to 0}\\frac{\\frac{\\sin x}{x}-1}{\\frac{e^x-1}{x}-1}=0\n\\]"), [
		block(String.raw`\lim_{x\to 0}\frac{\frac{\sin x}{x}-1}{\frac{e^x-1}{x}-1}=0`),
	]);
	assert.deepEqual(maths("$$\n\\widetilde Y_{sf}\n=\n(1-w_{sf})\\mu_{sf}^{\\mathrm{MAR}}\n$$\n\nInline \\(A_{sf}\\)"), [
		block("\\widetilde Y_{sf}\n=\n(1-w_{sf})\\mu_{sf}^{\\mathrm{MAR}}"),
		inline("A_{sf}"),
	]);
});

test("math inside lists and tables", () => {
	assert.deepEqual(maths("- Formula: $F_1 = u^2$\n\n| Value |\n| --- |\n| $\\mathbb{C}^3$ |"), [inline("F_1 = u^2"), inline(String.raw`\mathbb{C}^3`)]);
});

test("prices, shell variables and code spans stay text", () => {
	assert.deepEqual(maths("Costs $5 and $10 or $8k–$12k; use `$x$`, $HOME, and $" + "{PATH}."), []);
	assert.deepEqual(maths("$5 and $10"), []);
	assert.deepEqual(maths("echo $HOME"), []);
	assert.deepEqual(maths("It costs $5"), [], "an open $ before plain text is not pending math");
	// fork: a lone shell-like name opens no pending formula, which kept the rest of the paragraph raw.
	assert.deepEqual(maths("Paths: $HOME/$USER and $XDG_CONFIG_HOME/$APP_CONFIG"), []);
	assert.deepEqual(maths("Set $APP_CONFIG to **bold** and `code`."), []);
	assert.deepEqual(maths("Edit $HOME/.config/x_y.toml"), []);
});

test("an unknown command is still math: KaTeX refuses it and its source stays", () => {
	assert.deepEqual(maths(String.raw`Unknown $x + \unknown{y}$ after`), [inline(String.raw`x + \unknown{y}`)]);
});

test("delimiters still open while the reply streams are pending, then math once closed", () => {
	assert.deepEqual(maths(String.raw`Streaming $\mathbb{C}^3`), [{ type: "latex", text: String.raw`\mathbb{C}^3`, pending: true }]);
	assert.deepEqual(maths(String.raw`Map \(\mathbb{C}^3`), [{ type: "latex", text: String.raw`\mathbb{C}^3`, pending: true }]);
	assert.deepEqual(maths("\\[\nx^2"), [{ type: "latexBlock", text: "x^2", pending: true }]);
	assert.deepEqual(maths("$$\nx^2"), [{ type: "latexBlock", text: "x^2", pending: true }]);
	assert.deepEqual(maths(String.raw`Map $\mathbb{C}^3$`), [inline(String.raw`\mathbb{C}^3`)]);
});

test("escaped delimiters and code fences are not math", () => {
	assert.deepEqual(maths([String.raw`Escaped \$x-y\$.`, "", "```text", String.raw`$\mathbb{C}^3$`, "```"].join("\n")), []);
	assert.deepEqual(maths("`\\(x\\)` and\n\n    $$x$$ indented code"), []);
});

// The Markdown's nodes, with math.js replaced by a stand-in that marks what it was given.
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
const tags = (node, found = []) => {
	if (typeof node !== "string") {
		found.push(node.tag);
		for (const child of node.children) tags(child, found);
	}
	return found;
};

test("the window's Markdown draws math in the line, in blocks, lists, tables and emphasis", () => {
	const root = renderMarkdown("**bold $x^2$** and $5\n\n$$\\frac{a}{b}$$\n\n- item \\(y\\)\n\n| A |\n|---|\n| $z$ |");
	assert.equal(text(root), "bold [x^2] and $5[\\frac{a}{b}]item [y]A[z]");
	assert.deepEqual(
		tags(root).filter((tag) => tag.startsWith("math")),
		["math", "math-block", "math", "math"],
	);
	assert.equal(text(renderMarkdown("Map $\\mathbb{C}^3")), "Map $\\mathbb{C}^3", "pending: as written");
	for (const source of ["Costs $5 and $10 or $8k–$12k, $HOME and $" + "{PATH}.", "Paths: $HOME/$USER and $XDG_CONFIG_HOME/$APP_CONFIG"])
		assert.equal(text(renderMarkdown(source)), source);
});

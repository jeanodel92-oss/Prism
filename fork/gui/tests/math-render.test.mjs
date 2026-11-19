// fork: a formula comes from the model, so KaTeX draws it as untrusted input (math.js): no link, picture
// or HTML extension acts, sizes and macro expansions are bounded, and any error leaves the source shown. Checked on the
// vendored KaTeX (scripts/prepare.sh). Run by hand: node --test fork/gui/tests/math-render.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const { KATEX_OPTIONS, MAX_SOURCE, render } = await import("../ui/js/math.js");

// The window's copy of KaTeX, a UMD script, loaded as the page loads it (it sets `self.katex`).
const self = {};
vm.runInNewContext(readFileSync(new URL("../ui/vendor/katex/katex.min.js", import.meta.url), "utf8"), { self });
const { katex } = self;

// katex.render needs a document: the same parse and options through renderToString, its output kept on the element.
const library = { render: (text, element, options) => (element.html = katex.renderToString(text, options)) };
const element = () => ({ html: undefined, replaceChildren() {
	this.html = undefined;
} });

test("the options say what the window relies on", () => {
	assert.equal(katex.version, "0.19.1");
	assert.equal(KATEX_OPTIONS.trust, false);
	assert.equal(KATEX_OPTIONS.throwOnError, true);
	assert.equal(KATEX_OPTIONS.strict, "ignore");
	assert.ok(Number.isFinite(KATEX_OPTIONS.maxSize) && KATEX_OPTIONS.maxSize > 0);
	assert.ok(Number.isFinite(KATEX_OPTIONS.maxExpand) && KATEX_OPTIONS.maxExpand > 0);
	assert.ok(Object.isFrozen(KATEX_OPTIONS));
});

test("fractions, roots, matrices, scripts are drawn, inline and as a block", () => {
	for (const source of [String.raw`\frac{a}{b}`, String.raw`\sqrt[3]{x^2+1}`, String.raw`\begin{pmatrix}1&0\\0&1\end{pmatrix}`, "x_i^2"]) {
		for (const display of [false, true]) {
			const el = element();
			assert.equal(render(library, source, el, display), true, source);
			assert.match(el.html, display ? /class="katex-display"/ : /^<span class="katex">/);
		}
	}
});

test("links, pictures and HTML extensions do not act", () => {
	for (const source of [
		String.raw`\href{javascript:alert(1)}{click}`,
		String.raw`\url{https://example.invalid/}`,
		String.raw`\includegraphics{https://example.invalid/x.png}`,
		String.raw`\htmlClass{evil}{x}`,
		String.raw`\htmlId{evil}{x}`,
		String.raw`\htmlStyle{position:fixed}{x}`,
		String.raw`\htmlData{evil=1}{x}`,
	]) {
		const el = element();
		render(library, source, el, false);
		// The source itself is kept as text in the MathML annotation; nothing of it becomes markup.
		const markup = (el.html ?? "").replace(/<annotation[^>]*>[^<]*<\/annotation>/, "");
		assert.doesNotMatch(markup, /<a\b|<img\b|href=|src=|evil|position:fixed|javascript/, source);
	}
});

test("a malformed, unknown, endless or too deep formula is refused, its element left empty", () => {
	for (const source of [
		String.raw`\frac{1}{`,
		String.raw`x + \unknown{y}`,
		String.raw`\def\a{\a}\a`,
		// 31 expansions for each \a: 1240 in all.
		String.raw`\def\a{\b\b}\def\b{\c\c}\def\c{\d\d}\def\d{\e\e}\def\e{xx}` + String.raw`\a`.repeat(40),
		`${"{".repeat(5000)}x${"}".repeat(5000)}`,
	]) {
		const el = element();
		assert.equal(render(library, source, el, false), false, source.slice(0, 40));
		assert.equal(el.html, undefined);
	}
});

test("sizes are capped", () => {
	const el = element();
	assert.equal(render(library, String.raw`\rule{1000em}{1000em}`, el, false), true);
	const sizes = [...el.html.matchAll(/(?:height|width|border-right-width|border-top-width):([\d.]+)em/g)].map((m) => Number(m[1]));
	assert.ok(sizes.length > 0 && Math.max(...sizes) <= KATEX_OPTIONS.maxSize, String(sizes));
});

test("a source longer than the bound is not given to KaTeX", () => {
	let calls = 0;
	const counting = { render: () => calls++ };
	assert.equal(render(counting, "x".repeat(MAX_SOURCE + 1), element(), false), false);
	assert.equal(calls, 0);
	assert.equal(render(counting, "x", element(), true), true);
	assert.equal(calls, 1);
});

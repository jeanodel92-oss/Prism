// Math in Markdown (math-tokens.js says what is math), drawn with KaTeX (vendor/katex/, KaTeX 0.19.1 unmodified but
// for its stylesheet trimmed to the woff2 fonts, MIT: vendor/katex.LICENSE). The library and its stylesheet load on
// the first formula only; until then, and for good when KaTeX refuses a formula, its source shows as code.
//
// A formula comes from the model, so it is untrusted:
// - katex.render builds DOM nodes and sets their styles through the CSSOM, which the window's CSP (style-src 'self')
//   allows; renderToString's markup would rely on style attributes, which it blocks;
// - trust: false: no \href, \url, \includegraphics or \html… command acts (KaTeX shows the command's name in red);
// - sizes, macro expansions and the source's length are bounded; any error leaves the source shown as code.

import { h } from "./dom.js";

/** What KaTeX is given, for every formula. */
export const KATEX_OPTIONS = Object.freeze({
	// Thrown errors are caught: the formula's source is shown instead (as the terminal keeps an unknown command's).
	throwOnError: true,
	trust: false,
	// LaTeX-faithfulness warnings neither throw nor reach the console.
	strict: "ignore",
	// In ems: \rule{1000em}{1000em} or \kern1000em stay this size at most.
	maxSize: 20,
	maxExpand: 1000,
	// The MathML copy is for screen readers; the HTML is what is seen.
	output: "htmlAndMathml",
	globalGroup: false,
});

/** A longer source is not drawn: one formula must not hold the window. */
export const MAX_SOURCE = 10_000;

let library; // KaTeX, once loaded
let loading; // its loading, started by the first formula
let failed = false; // it could not be loaded: sources stay as they are
// The sources shown while KaTeX loads, with what to draw in their place.
const waiting = new Map();

function load() {
	loading ??= Promise.all([
		new Promise((resolve, reject) => {
			const sheet = document.createElement("link");
			sheet.rel = "stylesheet";
			sheet.href = "vendor/katex/katex.min.css";
			sheet.onload = resolve;
			sheet.onerror = () => reject(new Error("katex.min.css"));
			document.head.append(sheet);
		}),
		new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = "vendor/katex/katex.min.js";
			script.onload = () => (typeof globalThis.katex?.render === "function" ? resolve(globalThis.katex) : reject(new Error("katex")));
			script.onerror = () => reject(new Error("katex.min.js"));
			document.head.append(script);
		}),
	]).then(
		([, katex]) => {
			library = katex;
			for (const [shown, { text, display }] of waiting) {
				const drawn = draw(katex, text, display);
				if (drawn && shown.parentNode) shown.replaceWith(drawn);
			}
			waiting.clear();
		},
		() => {
			failed = true;
			waiting.clear();
		},
	);
	return loading;
}

/**
 * Draws `text` with `katex` into `element` (cleared first); false when it is too long or KaTeX refuses it, the element
 * then empty.
 */
export function render(katex, text, element, display) {
	if (text.length > MAX_SOURCE) return false;
	try {
		katex.render(text, element, { ...KATEX_OPTIONS, displayMode: display });
		return true;
	} catch {
		// A parse error, or a stack overflow on a deeply nested source.
		element.replaceChildren();
		return false;
	}
}

function draw(katex, text, display) {
	const element = h(display ? "div" : "span", { class: display ? "math-display" : "math" });
	return render(katex, text, element, display) ? element : undefined;
}

function source(raw, display) {
	return display ? h("pre", { class: "math-source", text: raw.trim() }) : h("code", { class: "math-source", text: raw });
}

/** A math token of the Markdown (math-tokens.js) as a node; `display`: a block of its own. */
export function math(token, display) {
	// Still streaming: its text as written, as the terminal shows it.
	if (token.pending) return display ? h("p", { class: "math-pending", text: token.raw.trim() }) : token.raw;
	if (library) return draw(library, token.text, display) ?? source(token.raw, display);
	const shown = source(token.raw, display);
	if (failed) return shown;
	waiting.set(shown, { text: token.text, display });
	load();
	return shown;
}

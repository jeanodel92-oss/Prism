// The terminal's Mermaid diagrams (Settings › Appearance › Mermaid diagrams) drawn as pictures in the window. A
// diagram comes from the model, so it is untrusted: mermaid parses it in its strict mode, and its drawing is shown
// as an image, never as page markup, so nothing in it runs or reaches the page. The library (vendor/mermaid.min.js,
// mermaid 12.2.0 unmodified, MIT: vendor/mermaid.LICENSE) loads on the first diagram only.

import { h } from "./dom.js";
import { t } from "./i18n.js";
import { activeAppearance } from "./theme.js";

// `${appearance}\n${source}` → the drawing's data URL, or null when mermaid cannot draw it.
const drawn = new Map();
// The same key → the sources shown while it is drawn: every block of that diagram (two identical diagrams, or replies
// shown before the drawing ends) is replaced when it ends.
const waiting = new Map();
let library;
// Mermaid draws one diagram at a time.
let queue = Promise.resolve();
let count = 0;

function load() {
	library ??= new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = "vendor/mermaid.min.js";
		script.onload = () => (globalThis.mermaid ? resolve(globalThis.mermaid) : reject(new Error("mermaid")));
		script.onerror = () => reject(new Error("mermaid"));
		document.head.append(script);
	});
	return library;
}

async function draw(source, appearance) {
	const mermaid = await load();
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		theme: appearance === "light" ? "default" : "dark",
		// Text labels in the drawing itself: an image shows no HTML.
		htmlLabels: false,
		flowchart: { htmlLabels: false },
	});
	const { svg } = await mermaid.render(`mermaid-${++count}`, source);
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// A diagram is drawn in the colours of the light or the dark appearance: the replies that show one are drawn
// again when the window changes appearance.
document.addEventListener("prism-appearance", () => {
	for (const figure of document.querySelectorAll(".msg.assistant .text figure.diagram")) figure.closest(".text")?.block?.redraw();
});

function picture(url) {
	return h("figure", { class: "diagram" }, h("img", { src: url, alt: t("diagram") }));
}

/** The diagram's picture, or `fallback` (its source) until it is drawn, and for good when it cannot be. */
export function diagram(source, fallback) {
	const appearance = activeAppearance();
	const key = `${appearance}\n${source}`;
	const known = drawn.get(key);
	if (known) return picture(known);
	if (known === null) return fallback;
	// The reply may be drawn again while the diagram is drawn: the sources no longer on the page are skipped at the end.
	const first = !waiting.has(key);
	if (first) waiting.set(key, new Set());
	waiting.get(key).add(fallback);
	if (first) {
		queue = queue
			.then(() => draw(source, appearance))
			.then(
				(url) => {
					drawn.set(key, url);
					for (const shown of waiting.get(key) ?? []) if (shown.isConnected) shown.replaceWith(picture(url));
				},
				() => drawn.set(key, null),
			)
			.finally(() => waiting.delete(key));
	}
	return fallback;
}

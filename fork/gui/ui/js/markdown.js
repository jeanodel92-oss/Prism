// Markdown from the model or a tool is untrusted. It is tokenised by marked's lexer only (marked never
// produces HTML here) and every token becomes DOM nodes through textContent:
// - raw HTML stays visible as text;
// - images are never fetched: they show as a labelled link to their address;
// - links do not navigate the window; a click asks before opening http(s) in the browser;
// - math ($…$, \(…\), $$…$$, \[…\], as the terminal reads it: math-tokens.js) is drawn by KaTeX (math.js).

import { Marked } from "../vendor/marked.esm.js";
import { decodeCharacterReferences } from "./char-refs.js";
import { diagram } from "./diagram.js";
import { copyText, h } from "./dom.js";
import { t } from "./i18n.js";
import { math } from "./math.js";
import { LATEX_EXTENSIONS } from "./math-tokens.js";

const lexer = new Marked({ gfm: true, breaks: false }).use({ extensions: LATEX_EXTENSIONS });

// `mermaid` (a reply's text only): the Mermaid setting, "off", "final" or "streaming"; `final`: the reply is complete.
export function renderMarkdown(source, { onLink, onLocalLink, mermaid, final } = {}) {
	const root = h("div", { class: "md" });
	let tokens;
	try {
		tokens = lexer.lexer(String(source ?? ""));
	} catch {
		root.append(h("p", { text: String(source ?? "") }));
		return root;
	}
	for (const token of tokens) {
		const node = block(token, { onLink, onLocalLink, mermaid, final });
		if (node) root.append(node);
	}
	return root;
}

function block(token, onLink) {
	switch (token.type) {
		case "space":
		case "def":
			return null;
		case "heading":
			return h(`h${Math.min(Math.max(token.depth, 1), 4)}`, {}, inline(token.tokens, onLink));
		case "paragraph":
			return h("p", {}, inline(token.tokens, onLink));
		case "text":
			return h("p", {}, token.tokens ? inline(token.tokens, onLink) : decodeCharacterReferences(token.text));
		case "code":
			// As the terminal: a diagram is drawn once the reply is complete ("final"), or once its block is closed.
			if (token.lang === "mermaid" && (onLink.mermaid === "streaming" || (onLink.mermaid === "final" && onLink.final))) {
				if (onLink.final || /\n(`{3,}|~{3,})[ \t]*\n?$/.test(token.raw)) return diagram(token.text, codeBlock(token.text, token.lang));
			}
			return codeBlock(token.text, token.lang);
		case "blockquote":
			return h("blockquote", {}, token.tokens.map((child) => block(child, onLink)));
		case "hr":
			return h("hr");
		case "list": {
			const list = h(token.ordered ? "ol" : "ul", token.ordered && token.start !== 1 ? { start: token.start } : {});
			for (const item of token.items) {
				const li = h("li", item.task ? { class: "task" } : {});
				if (item.task) li.append(h("span", { class: "check", "aria-hidden": "true", text: item.checked ? "■" : "□" }));
				for (const child of item.tokens) {
					// Tight lists: their text tokens render inline.
					if (child.type === "text" && !token.loose)
						li.append(...(child.tokens ? inline(child.tokens, onLink) : [decodeCharacterReferences(child.text)]));
					else {
						const node = block(child, onLink);
						if (node) li.append(node);
					}
				}
				list.append(li);
			}
			return list;
		}
		case "table": {
			const head = h(
				"tr",
				{},
				token.header.map((cell, i) => h("th", alignment(token.align[i]), inline(cell.tokens, onLink))),
			);
			const rows = token.rows.map((row) =>
				h(
					"tr",
					{},
					row.map((cell, i) => h("td", alignment(token.align[i]), inline(cell.tokens, onLink))),
				),
			);
			return h("div", { class: "table" }, h("table", {}, h("thead", {}, head), h("tbody", {}, rows)));
		}
		case "html":
			return h("p", { class: "raw" }, token.raw);
		case "latexBlock":
			return math(token, true);
		default:
			return token.raw ? h("p", {}, token.raw) : null;
	}
}

const alignment = (align) => (align ? { class: `align-${align}` } : {});

function inline(tokens = [], onLink) {
	const out = [];
	for (const token of tokens) {
		switch (token.type) {
			case "text":
				// "&amp;" shows as "&".
				out.push(...(token.tokens ? inline(token.tokens, onLink) : [decodeCharacterReferences(token.text)]));
				break;
			case "escape":
				out.push(token.text);
				break;
			case "strong":
				out.push(h("strong", {}, inline(token.tokens, onLink)));
				break;
			case "em":
				out.push(h("em", {}, inline(token.tokens, onLink)));
				break;
			case "del":
				out.push(h("del", {}, inline(token.tokens, onLink)));
				break;
			case "codespan":
				out.push(h("code", { text: token.text }));
				break;
			case "br":
				out.push(h("br"));
				break;
			case "link":
				out.push(link(token.href, inline(token.tokens, onLink), onLink));
				break;
			case "image":
				out.push(
					h(
						"span",
						{ class: "image-ref", title: token.href },
						t("imageNotLoaded", token.text || token.href || ""),
					),
				);
				break;
			case "html":
				out.push(token.raw);
				break;
			case "latex":
				out.push(math(token, false));
				break;
			default:
				out.push(token.raw ?? "");
		}
	}
	return out;
}

function link(href, children, handlers) {
	const url = String(href ?? "");
	const external = /^https?:\/\//i.test(url);
	const onLink = external ? handlers?.onLink : handlers?.onLocalLink;
	if (!external && !onLink) return h("span", { class: "link-text" }, children);
	const el = h("a", { class: "link", role: "link", tabindex: "0", title: url }, children);
	const open = (event) => {
		event.preventDefault();
		onLink?.(url);
	};
	el.addEventListener("click", open);
	el.addEventListener("keydown", (event) => {
		if (event.key === "Enter") open(event);
	});
	return el;
}

export function codeBlock(text, lang) {
	const button = h("button", { class: "ghost small copy", type: "button", text: t("copy") });
	button.addEventListener("click", async () => {
		if (await copyText(text)) {
			button.textContent = t("copied");
			setTimeout(() => {
				button.textContent = t("copy");
			}, 1500);
		}
	});
	return h(
		"figure",
		{ class: "code" },
		h("figcaption", {}, h("span", { class: "lang", text: lang || "" }), button),
		h("pre", {}, h("code", { text })),
	);
}

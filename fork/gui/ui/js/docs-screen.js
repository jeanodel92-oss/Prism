// The same shipped pages and search as /docs, rendered once as native Markdown instead of terminal cells.
import { ListBox, Panel } from "./components.js";
import { h, stripAnsi } from "./dom.js";
import { t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { findRanges } from "./search.js";

// The page search's highlights are one registry for the whole window: the reader that set them last owns them.
let highlightOwner;

/** A heading's id, as GitHub writes it: lower case, punctuation dropped, accents kept, spaces as hyphens. */
export function headingId(text) {
	return text.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-");
}

/** An id with only its letters and digits, accents removed: "S'authentifier" and "s-authentifier" agree. */
const looseId = (id) => id.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Which of `ids` a link's `fragment` names: the same id, else the one that differs only by accents and punctuation.
 * Audit of 2026-11-23, DOC-23: links of the French pages name some headings without their accents
 * (#controler-lexposition-des-outils for "Contrôler l'exposition des outils") and led nowhere.
 */
export function anchorTarget(ids, fragment) {
	const wanted = decodeURIComponent(fragment);
	return ids.find((id) => id === wanted) ?? ids.find((id) => looseId(id) === looseId(wanted));
}

export async function docsScreen(view, query = "") {
	const panel = new Panel({ title: t("docsTitle"), kind: "report docs" });
	const page = h("div", { class: "docs-page markdown", tabindex: "0" });
	const count = h("span", { class: "docs-matches muted", role: "status" });
	const search = h("input", { class: "field", type: "search", placeholder: t("docsPageSearch"), "aria-label": t("docsPageSearch") });
	let ranges = [];
	let selected = 0;
	let request = 0;
	let closed = false;
	let timer;
	let currentPath;
	const highlight = () => {
		count.textContent = search.value ? (ranges.length ? `${selected + 1}/${ranges.length}` : t("noMatches")) : "";
		if (CSS.highlights) {
			highlightOwner = panel;
			// ranges added one by one, never spread into call arguments.
			const all = new Highlight();
			for (const one of ranges) all.add(one);
			CSS.highlights.set("prism-docs-search", all);
			CSS.highlights.set("prism-docs-current", ranges[selected] ? new Highlight(ranges[selected]) : new Highlight());
		}
		const range = ranges[selected];
		if (range) page.scrollTop += range.getBoundingClientRect().top - page.getBoundingClientRect().top - 32;
	};
	const find = () => {
		ranges = findRanges(page, search.value, true);
		selected = 0;
		highlight();
	};
	// a page opened from the topic search is searched for what was typed, so it shows
	// where the words are: the whole query when the page holds it, otherwise its first word the page holds.
	const carry = () => {
		const typed = topics.value.trim();
		if (!typed) return;
		for (const words of [typed, ...typed.split(/\s+/)]) {
			search.value = words;
			find();
			if (ranges.length) return;
		}
		search.value = typed;
		find();
	};
	search.addEventListener("input", find);
	// Back on screen after a switch of conversation: its ranges collapsed when it left the page, and another
	// conversation's reader may hold the highlights. The selected match is kept.
	panel.el.addEventListener("panel-shown", () => {
		if (!search.value) return;
		const kept = selected;
		ranges = findRanges(page, search.value, true);
		selected = Math.min(kept, Math.max(0, ranges.length - 1));
		highlight();
	});
	search.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			selected = ranges.length ? (selected + (event.shiftKey ? ranges.length - 1 : 1)) % ranges.length : 0;
			highlight();
		} else if (event.key === "Escape" && search.value) {
			event.preventDefault();
			event.stopPropagation();
			search.value = "";
			find();
		}
	});
	const show = async (path, fragment = "", searched = false) => {
		const id = ++request;
		try {
			const data = await view.engine.request({ type: "get_docs", path });
			if (closed || id !== request) return;
			panel.setTitle(t("docsTitle"), data.title);
			currentPath = data.path;
			page.replaceChildren(renderMarkdown(data.markdown, {
				...view.app.markdownOptions,
				onLocalLink: (href) => {
					const target = new URL(href, `https://docs.local/${currentPath}`);
					if (target.origin === "https://docs.local") show(decodeURIComponent(target.pathname.slice(1)), target.hash.slice(1));
				},
			}));
			for (const heading of page.querySelectorAll("h1, h2, h3, h4")) heading.id = headingId(heading.textContent);
			for (const anchor of page.querySelectorAll(".raw")) {
				const id = /^<a\s+(?:id|name)="([\w-]+)"><\/a>\s*$/.exec(anchor.textContent)?.[1];
				if (id) { anchor.id = id; anchor.textContent = ""; }
			}
			page.scrollTop = 0;
			if (searched) carry();
			else find();
			if (fragment) {
				const targets = [...page.querySelectorAll("[id]")];
				const id = anchorTarget(targets.map((el) => el.id), fragment);
				targets.find((el) => el.id === id)?.scrollIntoView({ block: "start" });
			}
		} catch (error) {
			if (!closed) view.app.toast(String(error?.message ?? error), "error");
		}
	};
	const list = new ListBox({ empty: t("noMatch"), onChoose: (item) => show(item.value, "", true) });
	const topics = h("input", { class: "field", type: "search", placeholder: t("docsSearch"), "aria-label": t("docsSearch"), value: query, dataset: { autofocus: "" } });
	let listing = 0;
	const load = async (initial = false) => {
		const id = ++listing;
		try {
			const { topics: found } = await view.engine.request({ type: "get_docs", query: topics.value });
			if (closed || id !== listing) return;
			// each page shows its own first match and how often the words occur in it.
			list.setItems(found.map((entry) => ({
				label: entry.label,
				value: entry.path,
				meta: entry.matches ? t("docsMatches", entry.matches) : undefined,
				description: entry.excerpt ? stripAnsi(entry.excerpt) : undefined,
			})));
			if (initial && found.length) await show(found[0].path, "", true);
		} catch (error) {
			if (!closed) view.app.toast(String(error?.message ?? error), "error");
		}
	};
	topics.addEventListener("input", () => {
		clearTimeout(timer);
		timer = setTimeout(() => load(), 100);
	});
	topics.addEventListener("keydown", (event) => {
		if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) list.key(event);
	});
	panel.setBody(h("div", { class: "docs-layout" }, h("div", { class: "docs-topics" }, topics, list.el), h("div", { class: "docs-reader" }, h("div", { class: "docs-search" }, search, count), page)));
	await load(true);
	try {
		await view.showPanel("docs", panel);
	} finally {
		closed = true;
		clearTimeout(timer);
		if (highlightOwner === panel) {
			highlightOwner = undefined;
			CSS.highlights?.delete("prism-docs-search");
			CSS.highlights?.delete("prism-docs-current");
		}
	}
}

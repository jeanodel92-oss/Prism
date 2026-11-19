// The terminal's transcript search (tui.altScreen.search, packages/tui/src/alt-screen-search.ts) on the
// window's transcript: the same matching (case-insensitive, runs of spaces as one, across lines), the same
// first match (the first one from the top of what is shown), the same "n/m" count and keys. What is
// matched is what is shown, as in the terminal: a closed block (thinking, tool output) is not searched.
// Only the entries around the view are in the page (transcript-list.js): the others are searched in their text,
// drawn once out of the page and kept while the search is open, and drawn in the page when a match there is chosen.
// A match does not run from one entry into the next. A formula drawn by KaTeX (math.js) is searched in the characters
// it shows; its MathML copy, for screen readers only, is not.

import { matches as keyMatches, keyText } from "./keys.js";
import { t } from "./i18n.js";

const BLOCKS = new Set(["P", "LI", "PRE", "DIV", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "SUMMARY", "TR", "SECTION", "DETAILS"]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function blockOf(node, root) {
	for (let el = node.parentElement; el && el !== root; el = el.parentElement) if (BLOCKS.has(el.tagName)) return el;
	return root;
}

/** The shown text of `root` with each kept character's node and offset; blocks are apart by a space. */
function corpus(root, accents = false) {
	const chars = [];
	const nodes = [];
	const offsets = [];
	let block;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) =>
			node.parentElement?.closest("details:not([open]) > :not(summary), [hidden], button, .katex-mathml")
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT,
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const nodeBlock = blockOf(node, root);
		if (block && nodeBlock !== block && chars.at(-1) !== " ") {
			chars.push(" ");
			nodes.push(undefined);
			offsets.push(0);
		}
		block = nodeBlock;
		const text = node.data;
		for (let i = 0; i < text.length; i++) {
			const space = /\s/.test(text[i]);
			if (space && (chars.length === 0 || chars.at(-1) === " ")) continue;
			const normalized = space ? " " : accents ? text[i].normalize("NFD").replace(/\p{M}/gu, "") : text[i];
			for (let unit = 0; unit < normalized.length; unit++) {
				chars.push(normalized[unit]);
				nodes.push(node);
				offsets.push(i);
			}
		}
	}
	return { text: chars.join(""), nodes, offsets };
}

const normalize = (query, accents) => (accents ? query.normalize("NFD").replace(/\p{M}/gu, "") : query).replace(/\s+/gu, " ").trim();

/** How many times `pattern` (a global RegExp of the normalized query) is found in a text made by `corpus`. */
function countIn(text, pattern) {
	let count = 0;
	pattern.lastIndex = 0;
	while (pattern.exec(text)) count++;
	return count;
}

export function findRanges(root, query, accents = false) {
	const normalized = normalize(query, accents);
	if (!normalized) return [];
	const { text, nodes, offsets } = corpus(root, accents);
	const ranges = [];
	for (const match of text.matchAll(new RegExp(escapeRegExp(normalized), "giu"))) {
		let first = match.index;
		let last = match.index + match[0].length - 1;
		while (first <= last && !nodes[first]) first++;
		while (last >= first && !nodes[last]) last--;
		if (first > last) continue;
		const range = new Range();
		range.setStart(nodes[first], offsets[first]);
		range.setEnd(nodes[last], offsets[last] + 1);
		ranges.push(range);
	}
	return ranges;
}

export class TranscriptSearch {
	constructor(app) {
		this.app = app;
		this.el = document.getElementById("search");
		this.input = document.getElementById("search-input");
		this.result = document.getElementById("search-result");
		this.ranges = [];
		this.selected = -1;
		this.current = undefined; // the chosen match: { entry, index } (its rank in the entry)
		this.texts = new WeakMap(); // the text of entries not drawn, while the search is open
		this.refreshScheduled = false;
		this.observer = new MutationObserver(() => this.#scheduleRefresh());
		this.input.addEventListener("input", () => this.#search("query"));
		this.input.addEventListener("keydown", (event) => this.#key(event));
		document.getElementById("search-previous").addEventListener("click", () => this.#search("previous"));
		document.getElementById("search-next").addEventListener("click", () => this.#search("next"));
	}

	get open() {
		return !this.el.hidden;
	}

	toggle() {
		if (this.open) return this.close();
		const keys = this.app.active?.keys?.bindings ?? {};
		const label = (id) => (keys[id]?.keys[0] ? ` ${keyText(keys[id].keys[0])}` : "");
		document.getElementById("search-previous").textContent = `↑${label("tui.altScreen.searchPrevious")}`;
		document.getElementById("search-next").textContent = `↓${label("tui.altScreen.searchNext")}`;
		this.el.hidden = false;
		this.input.value = "";
		this.#search("query");
		this.input.focus();
	}

	close() {
		if (!this.open) return;
		this.el.hidden = true;
		this.observer.disconnect();
		this.ranges = [];
		this.current = undefined;
		this.texts = new WeakMap();
		CSS.highlights?.delete("prism-search");
		CSS.highlights?.delete("prism-search-current");
		document.getElementById("input").focus();
	}

	/** The transcript of another conversation is shown: its matches replace the old ones. */
	shown() {
		this.texts = new WeakMap();
		if (this.open) this.#search("query");
	}

	/** The transcript's blocks were opened or closed everywhere (tool outputs, thinking): what is shown changed. */
	changed() {
		this.texts = new WeakMap();
		if (this.open) this.#scheduleRefresh();
	}

	#key(event) {
		const keys = this.app.active?.keys?.bindings ?? {};
		const is = (id) => keys[id]?.keys.some((key) => keyMatches(event, key));
		const action = is("tui.altScreen.searchClose")
			? "close"
			: is("tui.altScreen.searchPrevious")
				? "previous"
				: is("tui.altScreen.searchNext")
					? "next"
					: is("tui.altScreen.search")
						? "close"
						: undefined;
		if (!action) return;
		event.preventDefault();
		event.stopPropagation();
		if (action === "close") this.close();
		else this.#search(action);
	}

	#scheduleRefresh() {
		if (this.refreshScheduled) return;
		this.refreshScheduled = true;
		requestAnimationFrame(() => {
			this.refreshScheduled = false;
			if (this.open) this.#search("retain");
		});
	}

	/**
	 * How many matches each entry of the transcript holds, in order: found in the page for those drawn, in their text
	 * for the others. `complete` is false while some texts are still to be read (a few ms of them per call).
	 */
	#counts(list, query) {
		const counts = new Array(list.size).fill(0);
		const drawn = new Map();
		const deadline = performance.now() + 25;
		const pattern = new RegExp(escapeRegExp(normalize(query, false)), "giu");
		let complete = true;
		for (const [index, entry] of list.entries.entries()) {
			if (entry.el?.isConnected) {
				const ranges = findRanges(entry.el, query);
				drawn.set(entry, ranges);
				counts[index] = ranges.length;
				continue;
			}
			let text = entry.el ? corpus(entry.el).text : this.texts.get(entry);
			if (text === undefined) {
				if (performance.now() > deadline) {
					complete = false;
					continue;
				}
				text = list.peek(entry, (el) => corpus(el).text);
				this.texts.set(entry, text);
			}
			counts[index] = countIn(text, pattern);
		}
		return { counts, drawn, complete };
	}

	// mode: "query" (the first match from the top of what is shown), "next", "previous", "retain".
	#search(mode) {
		const view = this.app.active;
		const list = view?.list;
		const query = this.input.value;
		const previous = this.current;
		const { counts, complete, drawn: found } = list && query.trim() ? this.#counts(list, query) : { counts: [], drawn: new Map(), complete: true };
		// A match as a rank in the whole transcript, and back.
		const before = (index) => counts.slice(0, index).reduce((sum, n) => sum + n, 0);
		const total = before(counts.length);
		const at = (rank) => {
			let index = 0;
			while (index < counts.length && rank >= counts[index]) rank -= counts[index++];
			return { entry: list.entries[index], index: rank };
		};
		const rankOf = (match) => {
			const index = match ? list.entries.indexOf(match.entry) : -1;
			return index >= 0 && match.index < counts[index] ? before(index) + match.index : -1;
		};
		if (!total) this.selected = -1;
		else if (mode === "query") {
			// The first match from the top of what is shown, else the first one after it, else the first one.
			const top = document.getElementById("scroller").getBoundingClientRect().top;
			let rank = -1;
			for (const [entry, ranges] of found) {
				const index = ranges.findIndex((range) => range.getBoundingClientRect().bottom >= top);
				if (index >= 0) {
					rank = before(list.entries.indexOf(entry)) + index;
					break;
				}
			}
			if (rank < 0) {
				const last = list.shown().at(-1);
				const after = last ? list.entries.indexOf(last) + 1 : 0;
				rank = counts.slice(after).some((n) => n > 0) ? before(after) : 0;
			}
			this.selected = rank;
		} else {
			// The same match as before, when it is still there (the transcript changes while the reply streams).
			const same = rankOf(previous);
			const base = same >= 0 ? same : Math.min(this.selected, total - 1);
			if (mode === "next") this.selected = base < 0 ? 0 : (base + 1) % total;
			else if (mode === "previous") this.selected = base < 0 ? total - 1 : (base - 1 + total) % total;
			else this.selected = Math.max(0, base);
		}
		this.current = total ? at(this.selected) : undefined;
		let drawn = found;
		if (this.current && mode !== "retain") {
			this.#reveal(list, this.current);
			// The page changed around the view: what is drawn now is highlighted.
			drawn = this.#drawn(list, query);
		}
		const more = complete ? "" : "…";
		this.result.textContent = !query.trim() ? "" : total ? `${this.selected + 1}/${total}${more}` : complete ? t("noMatches") : more;
		this.ranges = [...drawn.values()].flat();
		const currentRange = this.current && drawn.get(this.current.entry)?.[this.current.index];
		if (CSS.highlights) {
			// ranges added one by one, never spread into call arguments.
			const all = new Highlight();
			for (const range of this.ranges) all.add(range);
			CSS.highlights.set("prism-search", all);
			CSS.highlights.set("prism-search-current", currentRange ? new Highlight(currentRange) : new Highlight());
		}
		this.observer.disconnect();
		// A folded block opened or closed (`open`, `hidden`) changes what is shown, so what is found
		// ; other attributes do not.
		if (view)
			this.observer.observe(view.el, { childList: true, subtree: true, characterData: true, attributeFilter: ["open", "hidden"] });
		// The texts still to read, a few at a time, without holding the window.
		if (!complete) setTimeout(() => this.open && this.#search("retain"), 0);
	}

	/** The matches in the entries drawn in the page. */
	#drawn(list, query) {
		const drawn = new Map();
		for (const entry of list.shown()) if (entry.el?.isConnected) drawn.set(entry, findRanges(entry.el, query));
		return drawn;
	}

	/** Brings the match into view, at a third of its height, drawing its entry first when it is not. */
	#reveal(list, match) {
		const scroller = document.getElementById("scroller");
		const view = scroller.getBoundingClientRect();
		let range = match.entry.el?.isConnected ? findRanges(match.entry.el, this.input.value)[match.index] : undefined;
		let box = range?.getBoundingClientRect();
		if (box && box.top >= view.top && box.bottom <= view.bottom) return;
		this.app.stick = false;
		if (!range) {
			list.scrollToEntry(match.entry, view.height / 3);
			range = match.entry.el?.isConnected ? findRanges(match.entry.el, this.input.value)[match.index] : undefined;
			if (!range) return;
			box = range.getBoundingClientRect();
		}
		scroller.scrollTop += box.top - view.top - view.height / 3;
		// The entries around the view's new place, drawn now rather than on the next frame.
		list.reconcile();
	}
}

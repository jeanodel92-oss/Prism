// The transcript's entries, of which only those around the view are in the page
// .
//
// Each entry is one element of the transcript (a message, a tool card, a turn's line, a notice). An entry read from
// the session (`build`) is drawn when it comes near the view and dropped when it leaves; one the window drew as it
// happened (a reply streamed, a card of a ! command) keeps its element, out of the page while far from the view.
// An entry is pinned (never dropped) once it holds state of its own: a tool the engine still reports on, a question,
// a block the reader opened. Two spacers hold the place of what is not drawn, at the heights last measured (or the
// average of entries of the same kind, until measured): the scroll bar and the view stay where the reader expects.

/** Room drawn above and below the view, at least: a view's height, so a scroll by a page finds its entries drawn. */
const OVERSCAN_MIN = 600;
/** Heights assumed for entries never drawn, by kind, until one of that kind is measured. */
const DEFAULT_HEIGHTS = { user: 60, assistant: 240, tool: 80, turn: 20, other: 40 };
/** A selection or focus keeps its entries drawn, unless it would keep more than this many (memory stays bounded). */
const HOLD_SPAN_MAX = 200;
/** Entries drawn while the transcript is not in the page (nothing can be measured there): its last ones. */
const DETACHED_TAIL = 30;

/** What an element of the transcript is, for the heights assumed before it is measured. */
export function kindOf(el) {
	const classes = el.classList;
	if (classes.contains("turn-slot")) return "slot";
	if (classes.contains("msg")) return classes.contains("user") ? "user" : classes.contains("assistant") ? "assistant" : "other";
	if (classes.contains("tool")) return "tool";
	if (classes.contains("turn-summary")) return "turn";
	return "other";
}

/**
 * Each entry's top, from its extent (its height and the gap after it; 0 when it takes no room): `tops[i]` is the top
 * of entry i, `tops[n]` the end of the last one's gap.
 */
export function topsOf(extents) {
	const tops = new Float64Array(extents.length + 1);
	for (let i = 0; i < extents.length; i++) tops[i + 1] = tops[i] + extents[i];
	return tops;
}

/** The first entry whose bottom (its top and extent) is at or below `y`: the first one crossing `y` or after it. */
export function firstFrom(tops, y) {
	let low = 0;
	let high = tops.length - 1;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (tops[mid + 1] > y) high = mid;
		else low = mid + 1;
	}
	return low;
}

/** The entries crossing [from, to]: [first, last], last < first when there is none. */
export function rangeOf(tops, from, to) {
	const n = tops.length - 1;
	if (n === 0) return [0, -1];
	const first = Math.min(firstFrom(tops, from), n - 1);
	let last = firstFrom(tops, to);
	if (last >= n || tops[last] > to) last--;
	return [first, Math.max(first, last)];
}

/** The last entries that fill `room` from the end: [first, n - 1]. */
export function endRange(tops, room) {
	const n = tops.length - 1;
	if (n === 0) return [0, -1];
	let first = n - 1;
	while (first > 0 && tops[n] - tops[first] < room) first--;
	return [first, n - 1];
}

export class TranscriptList {
	/**
	 * `root`: the transcript's element. `host`: { scroller() (the element that scrolls it), active() (it is the
	 * transcript on screen), following() (the view follows its end), moved(delta, placed) (the list moved the view by
	 * `delta` px to keep what the reader sees in place, or `placed` it: at the end, at an entry), dropped(entry, el)
	 * (an entry's element is no longer kept) }.
	 */
	constructor(root, host) {
		this.root = root;
		this.host = host;
		this.entries = [];
		this.start = 0; // the entries in the page: [start, end]
		this.end = -1;
		this.byEl = new WeakMap();
		this.measured = {}; // kind → { sum, count } of the heights measured
		this.topSpacer = undefined; // made when first needed, as the observer: the list starts with nothing drawn
		this.bottomSpacer = undefined;
		this.resizes = undefined;
		this.scheduled = false;
	}

	get size() {
		return this.entries.length;
	}

	/** The entry a node of the transcript belongs to. */
	entryOf(node) {
		for (let at = node; at && at !== this.root; at = at.parentNode) {
			const entry = this.byEl.get(at);
			if (entry) return entry;
		}
		return undefined;
	}

	/** The last entry's element, drawn now if it was not. */
	lastEl() {
		const entry = this.entries.at(-1);
		return entry && this.materialize(entry);
	}

	/** The elements kept (in the page or out of it): what a change of every block of a kind must reach. */
	*elements() {
		for (const entry of this.entries) if (entry.el) yield entry.el;
	}

	querySelectorAll(selector) {
		const found = [];
		for (const el of this.elements()) {
			if (el.matches(selector)) found.push(el);
			// A loop, not a spread: a long message can hold more matches than a call takes arguments.
			for (const match of el.querySelectorAll(selector)) found.push(match);
		}
		return found;
	}

	/** The entries in the page, in order. */
	shown() {
		return this.entries.slice(this.start, this.end + 1);
	}

	// ---------------------------------------------------------------------------------------------
	// Changes of the transcript

	/** Replaces the whole transcript with entries read from the session ({ kind, build }), shown from its end. */
	reset(entries) {
		for (const entry of this.entries) this.#drop(entry);
		this.root.replaceChildren();
		this.entries = entries;
		this.start = 0;
		this.end = -1;
		for (const entry of entries) entry.pinned = false;
		// At the end while the view follows it (a conversation opened); elsewhere, where the view is.
		if (this.#measurable()) this.reconcile();
		else this.#apply(Math.max(0, entries.length - DETACHED_TAIL), entries.length - 1);
	}

	/** An element the window drew as it happened, at the end; in the page at once when the end is. */
	append(el) {
		const entry = { el, kind: kindOf(el) };
		this.byEl.set(el, entry);
		this.#push(entry);
		return entry;
	}

	remove(el) {
		const entry = this.byEl.get(el);
		const index = entry ? this.entries.indexOf(entry) : -1;
		if (index < 0) return;
		el.remove();
		this.byEl.delete(el);
		this.entries.splice(index, 1);
		if (index < this.start) this.start--;
		if (index <= this.end) this.end--;
		this.schedule();
	}

	/** `next` in the place of `el`. */
	replace(el, next) {
		const entry = this.byEl.get(el);
		if (!entry) return;
		this.byEl.delete(el);
		entry.el = next;
		entry.kind = kindOf(next);
		entry.build = undefined;
		entry.height = undefined;
		this.byEl.set(next, entry);
		const index = this.entries.indexOf(entry);
		if (index >= this.start && index <= this.end) el.replaceWith(next);
		this.schedule();
	}

	/** An element already in the transcript, moved to its end (a ! command run during a reply goes after it). */
	moveToEnd(el) {
		const entry = this.byEl.get(el);
		if (!entry) return;
		this.remove(el);
		this.byEl.set(el, entry);
		this.#push(entry);
	}

	/** A kept entry at the end: in the page when the end is (the view follows it), else out of it until it is near. */
	#push(entry) {
		const tailShown = this.entries.length === 0 || (this.end === this.entries.length - 1 && this.end >= this.start);
		this.entries.push(entry);
		if (tailShown) {
			if (this.bottomSpacer?.isConnected) this.bottomSpacer.before(entry.el);
			else this.root.append(entry.el);
			if (this.end < this.start) this.start = this.entries.length - 1;
			this.end = this.entries.length - 1;
		}
		this.schedule();
	}

	/** The entry's element, built if needed; it is kept from then on, in the page or out of it. */
	pin(entry) {
		entry.pinned = true;
		return this.materialize(entry);
	}

	/** The entry's element, built if needed (out of the page until its place is drawn). */
	materialize(entry) {
		if (!entry.el) {
			entry.el = entry.build();
			this.byEl.set(entry.el, entry);
		}
		return entry.el;
	}

	/** `use(el)` on the entry's element; one built for it is dropped after (a search reads what is not drawn). */
	peek(entry, use) {
		if (entry.el) return use(entry.el);
		const el = entry.build();
		try {
			return use(el);
		} finally {
			this.host.dropped(entry, el);
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Drawing what is around the view

	schedule() {
		if (this.scheduled) return;
		this.scheduled = true;
		requestAnimationFrame(() => {
			this.scheduled = false;
			this.reconcile();
		});
	}

	/**
	 * Puts in the page the entries around the view, and only those. `end`: the view goes to the transcript's end.
	 * `anchor` ({ entry, offset }): the view goes to that entry, its top `offset` px under the view's top. Otherwise
	 * what the reader sees stays where it is, whatever the heights of the entries drawn or dropped above it.
	 */
	reconcile({ end = false, anchor: target } = {}) {
		if (!this.#measurable()) return;
		if (!this.resizes) {
			// What is drawn changes with the transcript's height: a block opened or closed, a reply growing.
			this.resizes = new ResizeObserver(() => this.schedule());
			this.resizes.observe(this.root);
			this.topSpacer = spacer();
			this.bottomSpacer = spacer();
		}
		const scroller = this.host.scroller();
		const following = end || (!target && this.host.following());
		let targetIndex = target ? this.entries.indexOf(target.entry) : -1;
		for (let pass = 0; pass < 4; pass++) {
			const gap = Number.parseFloat(getComputedStyle(this.root).rowGap) || 0;
			const viewTop = scroller.getBoundingClientRect().top;
			// What the reader sees: the first entry in the page whose bottom is in the view, and where its top is.
			let anchor = -1;
			let offset = 0;
			for (let i = this.start; i <= this.end; i++) {
				const entry = this.entries[i];
				const rect = this.#measure(entry);
				if (anchor < 0 && !entry.hidden && rect.bottom > viewTop) {
					anchor = i;
					offset = rect.top - viewTop;
				}
			}
			const tops = this.#tops(gap);
			const room = scroller.clientHeight;
			const overscan = Math.max(OVERSCAN_MIN, room);
			let range;
			if (following) range = endRange(tops, room + overscan);
			else {
				let top;
				if (targetIndex >= 0) top = tops[targetIndex] - target.offset;
				else if (anchor >= 0) top = tops[anchor] - offset;
				else top = scroller.scrollTop - this.#rootTop(scroller);
				range = rangeOf(tops, top - overscan, top + room + overscan);
				if (targetIndex >= 0) range = [Math.min(range[0], targetIndex), Math.max(range[1], targetIndex)];
			}
			range = this.#hold(range);
			const changed = range[0] !== this.start || range[1] !== this.end;
			if (changed) this.#apply(range[0], range[1]);
			this.#spacers(tops, gap);
			const was = scroller.scrollTop;
			if (following) {
				const bottom = scroller.scrollHeight - scroller.clientHeight;
				if (Math.abs(scroller.scrollTop - bottom) > 0.5) {
					scroller.scrollTop = bottom;
					this.host.moved(scroller.scrollTop - was, true);
				}
			} else if (targetIndex >= 0) {
				const el = this.entries[targetIndex].el;
				const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - target.offset;
				if (Math.abs(delta) > 0.5) {
					scroller.scrollTop += delta;
					this.host.moved(scroller.scrollTop - was, true);
				}
			} else if (anchor >= 0 && this.entries[anchor]?.el?.isConnected) {
				// The reader's entry where it was: the heights drawn above it differ from those assumed.
				const delta = this.entries[anchor].el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
				if (Math.abs(delta) > 0.5) {
					scroller.scrollTop += delta;
					this.host.moved(scroller.scrollTop - was, false);
				}
			}
			if (!changed) break;
			// The entry asked for stays the anchor of the next pass, at its place now.
			if (targetIndex >= 0) targetIndex = this.entries.indexOf(target.entry);
		}
	}

	/** Shows `entry` with its top `offset` px under the view's top (search, the jump between prompts). */
	scrollToEntry(entry, offset = 0) {
		if (this.#measurable()) this.reconcile({ anchor: { entry, offset } });
		else {
			const index = this.entries.indexOf(entry);
			if (index >= 0) this.#apply(Math.max(0, index - DETACHED_TAIL / 2), Math.min(this.entries.length - 1, index + DETACHED_TAIL / 2));
		}
	}

	/**
	 * Where each entry's top is from the view's top, in px: measured for those in the page, from the heights kept for
	 * the others. Undefined while the transcript is not on screen.
	 */
	offsets() {
		if (!this.#measurable()) return undefined;
		const scroller = this.host.scroller();
		const gap = Number.parseFloat(getComputedStyle(this.root).rowGap) || 0;
		const viewTop = scroller.getBoundingClientRect().top;
		const tops = this.#tops(gap);
		let shift = this.#rootTop(scroller) - scroller.scrollTop;
		const first = this.entries[this.start];
		if (first?.el?.isConnected) shift = first.el.getBoundingClientRect().top - viewTop - tops[this.start];
		return Array.from({ length: this.entries.length }, (_, i) => {
			const entry = this.entries[i];
			return entry.el?.isConnected ? entry.el.getBoundingClientRect().top - viewTop : tops[i] + shift;
		});
	}

	// ---------------------------------------------------------------------------------------------

	#measurable() {
		return this.root.isConnected && this.host.active();
	}

	#rootTop(scroller) {
		return this.root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
	}

	/** Reads an entry's height in the page (and whether it takes room at all: a turn's slot does not). */
	#measure(entry) {
		const el = entry.el;
		const rect = el.getBoundingClientRect();
		entry.hidden = el.getClientRects().length === 0;
		if (!entry.hidden) {
			if (entry.height === undefined) {
				if (!this.measured[entry.kind]) this.measured[entry.kind] = { sum: 0, count: 0 };
				const kind = this.measured[entry.kind];
				kind.sum += rect.height;
				kind.count++;
			}
			entry.height = rect.height;
		}
		return rect;
	}

	#tops(gap) {
		const assumed = {};
		for (const [kind, height] of Object.entries(DEFAULT_HEIGHTS)) {
			const seen = this.measured[kind];
			assumed[kind] = seen?.count ? seen.sum / seen.count : height;
		}
		return topsOf(
			this.entries.map((entry) => {
				if (entry.hidden || entry.kind === "slot") return 0;
				return (entry.height ?? assumed[entry.kind] ?? DEFAULT_HEIGHTS.other) + gap;
			}),
		);
	}

	/** The range, widened to the entries that hold the selection or the focus (a drag, a field being typed in). */
	#hold([first, last]) {
		const held = [];
		const selection = window.getSelection();
		if (selection?.rangeCount) held.push(selection.anchorNode, selection.focusNode);
		held.push(document.activeElement);
		for (const node of held) {
			if (!node || !this.root.contains(node)) continue;
			const index = this.entries.indexOf(this.entryOf(node));
			if (index < 0) continue;
			const wider = [Math.min(first, index), Math.max(last, index)];
			if (wider[1] - wider[0] <= HOLD_SPAN_MAX) [first, last] = wider;
		}
		return [first, last];
	}

	/** Puts entries [first, last] in the page: those that stay are not moved (no animation replayed, no focus lost). */
	#apply(first, last) {
		const before = [this.start, this.end];
		const overlap = before[0] <= before[1] && first <= before[1] && last >= before[0];
		for (let i = before[0]; i <= before[1]; i++) {
			if (overlap && i >= first && i <= last) continue;
			const entry = this.entries[i];
			entry.el?.remove();
			if (entry.build && !entry.pinned) this.#drop(entry);
		}
		this.start = first;
		this.end = last;
		if (last < first) return;
		const els = (from, to) => {
			const list = [];
			for (let i = from; i <= to; i++) list.push(this.materialize(this.entries[i]));
			return list;
		};
		if (overlap) {
			const firstKept = this.entries[Math.max(first, before[0])].el;
			const lastKept = this.entries[Math.min(last, before[1])].el;
			if (first < before[0]) firstKept.before(...els(first, before[0] - 1));
			if (last > before[1]) lastKept.after(...els(before[1] + 1, last));
		} else {
			const all = els(first, last);
			if (this.topSpacer?.isConnected) this.topSpacer.after(...all);
			else if (this.bottomSpacer?.isConnected) this.bottomSpacer.before(...all);
			else this.root.append(...all);
		}
	}

	#drop(entry) {
		if (!entry.el || !entry.build) return;
		const el = entry.el;
		this.byEl.delete(el);
		entry.el = undefined;
		this.host.dropped(entry, el);
	}

	/** The spacers' heights: what is not drawn above and below takes the room it would. */
	#spacers(tops, gap) {
		const n = this.entries.length;
		const above = this.end >= this.start ? tops[this.start] : 0;
		const below = this.end >= this.start ? tops[n] - tops[this.end + 1] : 0;
		place(this.topSpacer, above > 0 ? above - gap : undefined, (el) => this.root.prepend(el));
		place(this.bottomSpacer, below > 0 ? below - gap : undefined, (el) => this.root.append(el));
	}
}

function spacer() {
	const el = document.createElement("div");
	el.className = "transcript-spacer";
	el.setAttribute("aria-hidden", "true");
	return el;
}

function place(el, height, insert) {
	if (height === undefined) {
		el.remove();
		return;
	}
	const value = `${Math.max(0, height).toFixed(2)}px`;
	if (el.style.height !== value) el.style.height = value;
	if (!el.isConnected) insert(el);
}

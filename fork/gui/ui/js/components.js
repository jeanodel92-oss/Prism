// The window's own interaction components: a panel (title, close, scrolling body, actions) and a list
// that the keyboard, the mouse and the wheel all move through. Every command, question or view that is
// not conversation goes through these, so they open, scroll, take and give back the focus, and close the
// same way. Text always goes in as text (dom.js).

import { fuzzyFilter } from "../vendor/fuzzy.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";

/**
 * A panel of the interaction surface (surface.js). `onCancel` runs on Escape and on the close button:
 * the maintainer decides what cancelling means (answer the engine, close a view) and then removes the panel.
 */
export class Panel {
	constructor({ title = "", subtitle = "", kind = "", onCancel, label } = {}) {
		this.onCancel = onCancel;
		this.titleEl = h("h2", { class: "panel-title", text: title });
		this.subtitleEl = h("span", { class: "panel-subtitle", text: subtitle });
		this.body = h("div", { class: "panel-body" });
		this.actions = h("div", { class: "panel-actions" });
		this.el = h(
			"section",
			{ class: `panel ${kind}`, role: "group", tabindex: "-1", "aria-label": label ?? title },
			h(
				"header",
				{ class: "panel-head" },
				this.titleEl,
				this.subtitleEl,
				h("button", {
					type: "button",
					class: "ghost icon panel-close",
					"aria-label": t("close"),
					title: t("closeEsc"),
					text: "×",
					onclick: () => this.cancel(),
				}),
			),
			this.body,
			this.actions,
		);
		this.el.addEventListener("keydown", (event) => {
			// fork: an Escape that cancels an IME composition does not close the panel.
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			this.cancel();
		});
	}

	setTitle(title, subtitle = "") {
		this.titleEl.textContent = title;
		this.subtitleEl.textContent = subtitle;
		this.el.setAttribute("aria-label", title);
	}

	/** The panel's content, replacing what it showed. */
	setBody(...nodes) {
		clear(this.body);
		this.body.append(...nodes.flat().filter(Boolean));
	}

	setActions(...buttons) {
		clear(this.actions);
		this.actions.append(...buttons.flat().filter(Boolean));
		this.actions.hidden = this.actions.childElementCount === 0;
	}

	cancel() {
		this.onCancel?.();
	}

	/** The first thing to type in or choose; the panel itself otherwise. */
	focus() {
		const target = this.el.querySelector("[data-autofocus]") ?? this.el.querySelector(".field, .listbox, .panel-actions button");
		(target ?? this.el).focus({ preventScroll: true });
	}
}

/**
 * A list of items to choose from: ↑ ↓ Home End PageUp PageDown move, Enter chooses, the mouse points and
 * clicks, the wheel scrolls (the list is a scrolling box, never a fixed window of five rows). With `filter`,
 * a field above it narrows the items as the user types, and keeps the keyboard.
 *
 * Items: `{ label, description?, meta?, searchText?, value, disabled?, current?, indent?, className?, title? }` (`current`: what
 * is in use now, marked; `indent`: a level in a tree). `onChoose(item, index, via)`, `via` "key" (Enter) or
 * "pointer" (a click).
 */
export class ListBox {
	constructor({ items = [], onChoose, onSelect, filter = false, placeholder = "", selected = 0, empty = "" } = {}) {
		this.onChoose = onChoose;
		this.onSelect = onSelect;
		this.empty = empty;
		this.fuzzy = filter === "fuzzy";
		this.all = items;
		this.items = items;
		this.selected = Math.min(Math.max(0, selected), Math.max(0, items.length - 1));
		this.list = h("ul", { class: "listbox", role: "listbox", tabindex: filter ? "-1" : "0" });
		this.list.addEventListener("keydown", (event) => this.key(event));
		this.field = filter
			? h("input", {
					class: "field listbox-filter",
					type: "text",
					spellcheck: "false",
					autocomplete: "off",
					placeholder,
					"aria-label": placeholder,
					dataset: { autofocus: "" },
				})
			: undefined;
		if (this.field) {
			this.field.addEventListener("input", () => this.#filter());
			this.field.addEventListener("keydown", (event) => this.key(event));
		} else this.list.dataset.autofocus = "";
		this.el = h("div", { class: "listbox-wrap" }, this.field, this.list);
		// A list is built before its panel is shown, when scrolling to the selection does nothing: it scrolls
		// there once it has a size, and again when its size changes (the current point of /tree, the model in use).
		new ResizeObserver(() => {
			if (this.list.clientHeight) this.list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
		}).observe(this.list);
		this.#render();
	}

	setItems(items, selected = 0) {
		this.all = items;
		this.selected = selected;
		this.#filter(false);
	}

	// `reset`: the user typed, the first match is selected; new items keep the selection they come with.
	#filter(reset = true) {
		const words = (this.field?.value ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		this.items = this.fuzzy
			? fuzzyFilter(this.all, this.field?.value ?? "", (item) => `${item.label} ${item.description ?? ""} ${item.meta ?? ""} ${item.searchText ?? ""}`)
			: words.length
			? this.all.filter((item) => {
					const text = `${item.label} ${item.description ?? ""} ${item.meta ?? ""} ${item.searchText ?? ""}`.toLowerCase();
					return words.every((word) => text.includes(word));
				})
			: this.all;
		if (this.field && (reset || words.length)) this.selected = 0;
		this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
		this.#render();
	}

	/** A key for the list (from the list or its filter field); true when used. */
	key(event) {
		if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;
		const count = this.items.length;
		const page = Math.max(1, Math.floor(this.list.clientHeight / (this.list.firstElementChild?.offsetHeight || 32)) - 1);
		let next;
		switch (event.key) {
			case "ArrowDown":
				next = count ? (this.selected + 1) % count : 0;
				break;
			case "ArrowUp":
				next = count ? (this.selected - 1 + count) % count : 0;
				break;
			case "PageDown":
				next = Math.min(count - 1, this.selected + page);
				break;
			case "PageUp":
				next = Math.max(0, this.selected - page);
				break;
			case "Home":
				if (this.field) return false; // the field's own Home
				next = 0;
				break;
			case "End":
				if (this.field) return false;
				next = count - 1;
				break;
			case "Enter":
				event.preventDefault();
				event.stopPropagation();
				this.choose(this.selected, "key");
				return true;
			default:
				return false;
		}
		event.preventDefault();
		event.stopPropagation();
		this.select(Math.max(0, next));
		return true;
	}

	select(index) {
		this.selected = index;
		this.onSelect?.(this.items[index]);
		for (const [i, row] of [...this.list.children].entries()) {
			const on = i === index;
			row.classList.toggle("selected", on);
			row.setAttribute("aria-selected", String(on));
			if (on) {
				this.list.setAttribute("aria-activedescendant", row.id);
				row.scrollIntoView({ block: "nearest" });
			}
		}
	}

	choose(index, via = "pointer") {
		const item = this.items[index];
		if (!item || item.disabled) return;
		this.onChoose?.(item, index, via);
	}

	#render() {
		clear(this.list);
		if (this.items.length === 0 && this.empty) this.list.append(h("li", { class: "listbox-empty", text: this.empty }));
		for (const [index, item] of this.items.entries()) {
			const row = h(
				"li",
				{
					id: `lb-${Math.random().toString(36).slice(2)}`,
					role: "option",
					class: [item.disabled && "disabled", item.current && "current", item.className].filter(Boolean).join(" "),
					style: item.indent ? `--indent: ${item.indent}` : undefined,
					title: item.title,
					"aria-disabled": item.disabled ? "true" : undefined,
					"aria-current": item.current ? "true" : undefined,
				},
				h("span", { class: "listbox-label", text: item.label }),
				item.meta ? h("span", { class: "listbox-meta", text: item.meta }) : undefined,
				item.description ? h("span", { class: "listbox-description", text: item.description }) : undefined,
			);
			// Pressing does not move the focus out of the filter; a click chooses, a hover points.
			row.addEventListener("mousedown", (event) => event.preventDefault());
			row.addEventListener("mousemove", () => {
				if (this.selected !== index) this.select(index);
			});
			row.addEventListener("click", () => this.choose(index));
			this.list.append(row);
		}
		this.select(this.selected);
	}
}

/** A two-column table of facts (label, value), for read-only reports. */
export function facts(rows) {
	return h(
		"dl",
		{ class: "facts" },
		// Labels written for a line of text ("Name:") lose their colon in the column.
		rows.filter(Boolean).flatMap(([label, value]) => [h("dt", { text: String(label).replace(/\s*:\s*$/, "") }), h("dd", { text: String(value ?? "") })]),
	);
}

/**
 * A row of mutually exclusive choices (a filter, a mode): `options` `[{value, label}]`, `onChange(value)`.
 * ← → move between them as in a radio group.
 */
export class Segmented {
	constructor({ options, value, onChange, label = "" }) {
		this.onChange = onChange;
		this.el = h("div", { class: "segmented", role: "radiogroup", "aria-label": label });
		this.buttons = options.map((option) => {
			const button = h("button", { type: "button", role: "radio", text: option.label, onclick: () => this.set(option.value, true) });
			button.dataset.value = option.value;
			button.addEventListener("keydown", (event) => {
				const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
				if (!step) return;
				event.preventDefault();
				const next = this.buttons[(this.buttons.indexOf(button) + step + this.buttons.length) % this.buttons.length];
				next.focus();
				this.set(next.dataset.value, true);
			});
			return button;
		});
		this.el.append(...this.buttons);
		this.set(value);
	}

	set(value, notify = false) {
		this.value = value;
		for (const button of this.buttons) {
			const on = button.dataset.value === value;
			button.setAttribute("aria-checked", String(on));
			button.tabIndex = on ? 0 : -1;
		}
		if (notify) this.onChange?.(value);
	}
}

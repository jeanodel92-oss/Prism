// The terminal editor's completion list under the composer: "/" commands and their arguments, "@" files,
// Tab, and the extensions' completions. The engine decides everything (complete, apply_completion in
// src/fork/autocomplete.ts): when the list opens, what it holds, which item comes first and what choosing
// one writes. Here: the list, its keys and its clicks.

import { clear, h } from "./dom.js";

/** Edits closer than this are asked as one (the terminal's editor waits 20 ms after an @ edit, editor.ts). */
const EDIT_GROUP_MS = 20;

export class Completion {
	constructor(app, input, list) {
		this.app = app;
		this.input = input;
		this.list = list;
		this.state = undefined; // { items, prefix, selected, mode } while the list is shown
		this.request = 0;
	}

	get open() {
		return this.state !== undefined;
	}

	close() {
		this.request++;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.grouped?.();
		// A search still running for the list is stopped in the engine, with its walk of the files.
		if (this.asking) {
			this.asking.engine.send({ type: "complete_cancel" }).catch(() => {});
			this.asking = undefined;
		}
		this.state = undefined;
		this.list.hidden = true;
		clear(this.list);
	}

	/** After an edit of the composer (an input event): typing and deleting follow the editor's rules. */
	edited(event) {
		if (this.writing) return;
		const typed = event.inputType === "insertText" && event.data ? [...event.data].at(-1) : undefined;
		// A paste, a new line or anything else closes the list, as in the editor.
		if (!typed && !event.inputType?.startsWith("delete")) return this.close();
		// Quick edits are asked once, as the terminal's editor groups them: a newer search stops
		// the older one in the engine.
		const options = { typed, ...(this.state ? { open: this.state.mode } : {}) };
		clearTimeout(this.timer);
		this.grouped?.();
		this.pending = new Promise((resolve) => {
			// An edit grouped with the next one, or a list closed meanwhile, asks nothing: whoever waits goes on.
			this.grouped = () => {
				this.grouped = undefined;
				resolve();
			};
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.grouped = undefined;
				resolve(this.#ask(options));
			}, EDIT_GROUP_MS);
		});
	}

	/** The keys of the editor while the list is shown, and Tab; true when the key was used. */
	key(event) {
		const modified = event.altKey || event.ctrlKey || event.metaKey;
		if (event.key === "Tab" && !event.shiftKey && !modified) {
			if (this.state) this.#choose(this.state.items[this.state.selected]);
			else if (this.input.value.trim()) this.pending = this.#ask({ tab: true });
			else return false; // an empty composer keeps Tab for moving the focus
			return true;
		}
		if (!this.state || modified || event.shiftKey) return false;
		if (event.key === "Escape") {
			this.close();
			return true;
		}
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			const count = this.state.items.length;
			this.state.selected = (this.state.selected + (event.key === "ArrowUp" ? count - 1 : 1)) % count;
			this.#render();
			return true;
		}
		if (event.key === "Enter" && !event.isComposing) {
			// A command is chosen and sent at once; a file or an argument is only written (editor.ts). An absolute
			// path also starts with "/": a command name is alone at the start of the first line, with no other "/"
			//.
			const { prefix, text, cursor } = this.state;
			const before = text.slice(0, cursor - prefix.length);
			const command = prefix.startsWith("/") && !before.includes("\n") && !before.trim() && !prefix.slice(1).includes("/");
			this.#choose(this.state.items[this.state.selected], command);
			return true;
		}
		return false;
	}

	async #ask(options) {
		const view = this.app.active;
		if (!view?.ready) return;
		const id = ++this.request;
		const text = this.input.value;
		const cursor = this.input.selectionStart;
		const asking = { engine: view.engine };
		this.asking = asking;
		let data;
		try {
			data = await view.engine.request({ type: "complete", text, cursor, ...options });
		} catch {
			data = { items: [] };
		} finally {
			if (this.asking === asking) this.asking = undefined;
		}
		// An answer for a text that changed since is dropped, as in the editor.
		if (id !== this.request || this.input.value !== text || this.input.selectionStart !== cursor) return;
		if (data.applied) {
			this.close();
			this.#write(data.applied);
			return;
		}
		if (!data.items?.length) {
			this.close();
			return;
		}
		this.state = { items: data.items, prefix: data.prefix, selected: data.selected ?? 0, mode: data.mode, text, cursor };
		this.#render();
	}

	async #choose(item, submit = false) {
		const view = this.app.active;
		const text = this.input.value;
		const cursor = this.input.selectionStart;
		// The old list can still be shown while the last keystroke's answer is in flight.
		if (this.state?.text !== text || this.state?.cursor !== cursor) {
			await this.pending;
			if (this.app.active === view && this.input.value === text && this.input.selectionStart === cursor && this.state?.text === text && this.state?.cursor === cursor)
				return this.#choose(this.state.items[this.state.selected], submit);
			return;
		}
		const { prefix } = this.state;
		this.close();
		const id = this.request;
		if (!view || !item) return;
		try {
			const result = await view.engine.request({ type: "apply_completion", text, cursor, item, prefix });
			if (this.app.active !== view || this.request !== id || this.input.value !== text || this.input.selectionStart !== cursor) return;
			this.#write(result);
			if (submit) this.app.submit({ fromKey: true });
		} catch (error) {
			if (this.app.active === view) this.app.toast(String(error?.message ?? error), "error");
		}
	}

	#write({ text, cursor }) {
		this.input.value = text;
		this.input.setSelectionRange(cursor, cursor);
		// The composer grows and leaves the history; the completion does not reopen on its own text.
		this.writing = true;
		this.input.dispatchEvent(new Event("input", { bubbles: true }));
		this.writing = false;
	}

	// Every item, in a list that floats above the composer and scrolls (wheel, keys), as many rows at a time as the
	// terminal's setting says (Autocomplete max items, get_display); the list keeps the composer's and the scene's
	// geometry unchanged whatever its length.
	#render() {
		const { items, selected } = this.state;
		clear(this.list);
		items.forEach((item, index) => {
			const row = h(
				"li",
				{ class: index === selected ? "selected" : "", role: "option", "aria-selected": String(index === selected) },
				h("span", { class: "completion-label" }, item.label),
				item.description ? h("span", { class: "completion-description" }, item.description) : "",
			);
			// The composer keeps the focus: the press does not take it, the click chooses.
			row.addEventListener("mousedown", (event) => event.preventDefault());
			row.addEventListener("click", () => {
				this.state.selected = index;
				this.#choose(item);
			});
			this.list.append(row);
		});
		this.list.hidden = false;
		const rows = this.app.active?.display?.autocompleteMaxVisible;
		const row = this.list.firstElementChild;
		if (rows && row) {
			const padding = this.list.offsetHeight - this.list.clientHeight + parseFloat(getComputedStyle(this.list).paddingTop) * 2;
			this.list.style.maxHeight = `min(${rows * row.offsetHeight + padding}px, 45vh)`;
		}
		this.list.children[selected]?.scrollIntoView({ block: "nearest" });
	}
}

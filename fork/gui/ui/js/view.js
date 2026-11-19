// A view of the engine: a terminal component an extension shows with `ctx.ui.custom` (/perm, /bg, /files,
// /doctor…). The engine renders it at the window's size and sends its lines; this panel only draws them
// and sends back keys and mouse events as a terminal would (fork/rpc-views.ts). Nothing of the view's
// logic is here: every choice made in it is made by the engine, with its own checks.

import { ansiLine } from "./ansi.js";
import { Panel } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";
import { nativeMenu } from "./native-menu.js";

const CSI = "\x1b[";

const NAMED = {
	ArrowUp: "A",
	ArrowDown: "B",
	ArrowRight: "C",
	ArrowLeft: "D",
	Home: "H",
	End: "F",
};
const TILDE = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 };

/** The bytes a terminal sends for this key (legacy encoding, CSI u where legacy has none); undefined to ignore. */
export function keySequence(event) {
	if (event.isComposing || event.key === "Dead" || event.key === "Unidentified") return undefined;
	const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
	const { key } = event;
	if (key in NAMED) return modifier > 1 ? `${CSI}1;${modifier}${NAMED[key]}` : `${CSI}${NAMED[key]}`;
	if (key in TILDE) return modifier > 1 ? `${CSI}${TILDE[key]};${modifier}~` : `${CSI}${TILDE[key]}~`;
	switch (key) {
		case "Enter":
			if (event.shiftKey || event.ctrlKey) return `${CSI}13;${modifier}u`;
			return event.altKey ? "\x1b\r" : "\r";
		case "Escape":
			return "\x1b";
		case "Tab":
			return event.shiftKey ? `${CSI}Z` : "\t";
		case "Backspace":
			if (event.ctrlKey) return "\x17";
			return event.altKey ? "\x1b\x7f" : "\x7f";
	}
	if ([...key].length !== 1 || event.metaKey) return undefined;
	if (event.ctrlKey) {
		const lower = key.toLowerCase();
		let control;
		if (lower >= "a" && lower <= "z") control = String.fromCharCode(lower.charCodeAt(0) - 96);
		else if (key === " ") control = "\x00";
		else if (key === "[") control = "\x1b";
		else if (key === "\\") control = "\x1c";
		else if (key === "]") control = "\x1d";
		else return undefined;
		return event.altKey ? `\x1b${control}` : control;
	}
	return event.altKey ? `\x1b${key}` : key;
}

export class TerminalView {
	// The view's lines sit in a panel of the interaction surface (surface.js), titled by the command that
	// opened it; the panel's close button and Escape outside the view close it through the engine.
	constructor(session, id, overlay, owner) {
		this.session = session;
		this.id = id;
		this.owner = owner;
		this.overlay = overlay;
		this.columns = 0;
		this.lines = [];
		this.closed = false;
		this.pre = h("pre", { class: "view-lines" });
		this.el = h(
			"div",
			{
				class: `view ${overlay ? "overlay" : "inline"}`,
				tabindex: "0",
				"aria-label": t("viewLabel"),
				dataset: { view: id, autofocus: "" },
			},
			this.pre,
		);
		this.panel = new Panel({
			title: owner && !["agent", "extension"].includes(owner) ? `/${owner}` : t("viewLabel"),
			kind: "terminal-view",
			onCancel: () => this.session.closeView(this),
		});
		this.panel.setBody(this.el);
		this.el.addEventListener("keydown", (event) => this.#key(event));
		this.el.addEventListener("paste", (event) => {
			if (this.menu) return;
			const text = event.clipboardData?.getData("text/plain");
			if (!text) return;
			event.preventDefault();
			this.#send(`${CSI}200~${text}${CSI}201~`);
		});
		this.pre.addEventListener("pointerdown", (event) => this.#pointer(event, "press"));
		this.pre.addEventListener("pointerup", (event) => {
			this.#pointer(event, "release");
			this.#pointer(event, "click");
		});
		this.pre.addEventListener(
			"wheel",
			(event) => {
				const cell = this.#cell(event);
				if (!cell) return;
				this.#mouse({ type: "wheel", button: "none", ...cell, wheelDelta: Math.sign(event.deltaY) * 3 });
			},
			{ passive: true },
		);
	}

	frame(columns, lines, menu) {
		if (menu) {
			const focused = this.el.contains(document.activeElement) || this.refocus;
			this.refocus = false;
			this.menu = menu;
			this.el.className = "native-menu-host";
			this.el.removeAttribute("data-autofocus");
			this.panel.el.classList.replace("terminal-view", "native-command");
			this.el.replaceChildren(nativeMenu(this, menu));
			if (focused) this.panel.focus();
			return;
		}
		this.columns = columns;
		this.lines = lines;
		this.el.style.setProperty("--view-columns", String(columns));
		clear(this.pre);
		for (const line of lines) {
			const row = h("div", { class: "view-line" });
			row.append(ansiLine(line));
			this.pre.append(row);
		}
		this.pre.querySelector(".caret")?.scrollIntoView({ block: "nearest" });
	}

	focus() {
		this.el.focus({ preventScroll: true });
	}

	#key(event) {
		if (this.menu) return;
		// Copy what is selected in the view, as a terminal does; otherwise Ctrl+C goes to the view.
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && String(window.getSelection())) return;
		const data = keySequence(event);
		if (data === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		this.#send(data);
	}

	#cell(event) {
		const size = this.session.app.cellSize();
		const rect = this.pre.getBoundingClientRect();
		const x = Math.floor((event.clientX - rect.left) / size.width);
		const y = Math.floor((event.clientY - rect.top) / size.height);
		if (x < 0 || y < 0 || y >= this.lines.length) return undefined;
		return { x: Math.min(x, Math.max(0, this.columns - 1)), y };
	}

	#pointer(event, type) {
		if (event.pointerType === "mouse" && event.button > 2) return;
		const cell = this.#cell(event);
		if (!cell) return;
		const button = ["left", "middle", "right"][event.button] ?? "left";
		this.#mouse({ type, button, ...cell, shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey });
	}

	#mouse(event) {
		if (this.closed) return;
		this.session.engine.request({ type: "view_mouse", viewId: this.id, event }).catch(() => {});
	}

	#send(data) {
		if (this.closed) return;
		this.session.engine.request({ type: "view_input", viewId: this.id, data }).catch(() => {});
	}

	close() {
		this.closed = true;
	}
}

// What the keyboard does on the PC, by touch on the phone: a long press on Send queues the
// message after the running task instead of steering it (Alt+Enter); a magnifier in the top bar searches the
// conversation (Ctrl+F); a module's terminal screen gets a button that unfolds the keys a phone keyboard lacks
// (Escape, Tab, the arrows, Enter). No permanent row of keys: the maintainer refused one.

import { h } from "../js/dom.js";
import { t } from "../js/i18n.js";

/** How long a press on Send lasts before it queues, in ms: Android's own long press, which also raises `contextmenu`. */
export const HOLD = 450;

/** A long press on `button` calls `held()`; the press's own click (the form's submit) is then dropped, so the message
 * is not sent twice. A short press stays the button's click. */
export function holdToQueue(button, held) {
	let timer;
	let fired = false;
	const fire = () => {
		clearTimeout(timer);
		timer = undefined;
		fired = true;
		held();
	};
	const cancel = () => {
		clearTimeout(timer);
		timer = undefined;
	};
	button.addEventListener("pointerdown", () => {
		cancel();
		fired = false;
		timer = setTimeout(fire, HOLD);
	});
	for (const type of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(type, cancel);
	// Android reports its long press as a context menu, sometimes before the timer: the same press, counted once.
	button.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		if (timer !== undefined) fire();
	});
	button.addEventListener(
		"click",
		(event) => {
			if (!fired) return;
			fired = false;
			event.preventDefault();
			event.stopPropagation();
		},
		true,
	);
}

/** The top bar's magnifier: opens and closes the conversation's search, whose field may take the focus (and the
 * keyboard) from this touch (`data-focuses`, read by the phone's rule that keeps the keyboard down). */
export function searchButton(app) {
	const button = h("button", {
		type: "button",
		class: "ghost icon phone-search",
		"aria-label": t("searchTranscript"),
		title: t("searchTranscript"),
		dataset: { focuses: "search-input" },
	});
	button.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="14" cy="14" r="8"/><path d="m20 20 7 7"/></svg>';
	button.addEventListener("click", () => {
		app.search?.toggle();
		// The window writes each arrow's keyboard shortcut beside it; a phone has no such keys.
		document.getElementById("search-previous").textContent = "↑";
		document.getElementById("search-next").textContent = "↓";
	});
	return button;
}

const KEYS = [
	["Esc", "Escape"],
	["Tab", "Tab"],
	["←", "ArrowLeft"],
	["↑", "ArrowUp"],
	["↓", "ArrowDown"],
	["→", "ArrowRight"],
	["⏎", "Enter"],
];

/** The keys of one terminal screen: a button in the panel's head and the row it unfolds, folded at first. A key is
 * given to the screen as the keyboard's would be (view.js reads `keydown`). */
function addKeys(panel) {
	const head = panel.querySelector(":scope > .panel-head");
	if (!head || head.querySelector(".view-keys-toggle")) return;
	const row = h("div", { class: "view-keys", role: "toolbar", "aria-label": t("viewKeys"), hidden: true });
	for (const [label, key] of KEYS) {
		const button = h("button", { type: "button", class: "ghost small", text: label, "aria-label": key });
		button.addEventListener("click", () => {
			panel.querySelector(".view")?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
		});
		row.append(button);
	}
	const toggle = h("button", { type: "button", class: "ghost small view-keys-toggle", text: t("viewKeys"), "aria-expanded": "false" });
	toggle.addEventListener("click", () => {
		row.hidden = !row.hidden;
		toggle.setAttribute("aria-expanded", String(!row.hidden));
	});
	head.querySelector(".panel-close")?.before(toggle);
	head.after(row);
}

/** Every terminal screen shown in `surface` gets its keys, now and as they open. */
export function viewKeys(surface) {
	const add = () => {
		for (const panel of surface.querySelectorAll(":scope > .panel.terminal-view")) addKeys(panel);
	};
	new MutationObserver(add).observe(surface, { childList: true });
	add();
}

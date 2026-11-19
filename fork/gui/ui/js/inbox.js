// What waits for you: one folded line under the topbar, "2 things wait for
// you", that unfolds into the other conversations' questions (an authorisation, a choice) and their finished turns.
// Touching an entry opens its conversation, where the question is answered as usual. Gone when nothing waits.
// Sources: the conversations open in the app; those running only on the PC come with live sharing.
// fork: in the PC window too, at the same place, and each waiting conversation of the
// side panel carries a dot (kindOf).

import { tintCss, tintOf } from "../phone/glass.js";
import { h } from "./dom.js";
import { t } from "./i18n.js";

/** The side panel's dot after a conversation's name: it waits for an answer, or finished while another was shown. */
export function inboxDot(kind) {
	if (!kind) return [];
	const label = kind === "ask" ? t("inboxAsk") : t("inboxFinished");
	return [h("span", { class: `inbox-dot ${kind}`, role: "img", "aria-label": label, title: label })];
}

export class Inbox {
	constructor(app, place) {
		this.app = app;
		this.finished = new Set(); // conversations whose turn ended while another was shown
		this.streaming = new Map();
		this.unfolded = false;
		this.summary = h("button", { type: "button", class: "inbox-line", "aria-expanded": "false" });
		this.list = h("ul", { class: "inbox-list", hidden: true });
		this.el = h("div", { class: "inbox", hidden: true }, this.summary, this.list);
		this.summary.addEventListener("click", () => {
			this.unfolded = !this.unfolded;
			this.draw();
		});
		place.after(this.el);
	}

	update() {
		const app = this.app;
		for (const view of app.sessions) {
			const was = this.streaming.get(view);
			if (was && !view.streaming && app.active !== view) this.finished.add(view);
			this.streaming.set(view, view.streaming);
		}
		this.finished.delete(app.active);
		for (const view of this.finished) if (!app.sessions.includes(view)) this.finished.delete(view);
		this.draw();
	}

	entries() {
		const app = this.app;
		const entries = [];
		for (const view of app.sessions) {
			if (view === app.active || view.closed) continue;
			for (const dialog of view.dialogs.values())
				entries.push({ view, kind: "ask", text: dialog.request?.title || t("inboxQuestion") });
		}
		for (const view of this.finished) entries.push({ view, kind: "done", text: t("inboxDone") });
		return entries;
	}

	/** "ask" when the conversation waits for an answer, "done" when its turn ended while another was shown. */
	kindOf(view) {
		if (view === this.app.active || view.closed) return undefined;
		if (view.dialogs.size > 0) return "ask";
		return this.finished.has(view) ? "done" : undefined;
	}

	draw() {
		const entries = this.entries();
		this.el.hidden = entries.length === 0;
		if (!entries.length) {
			this.unfolded = false;
			return;
		}
		this.summary.textContent = t("inboxWaiting", entries.length);
		this.summary.setAttribute("aria-expanded", String(this.unfolded));
		this.summary.classList.toggle("asks", entries.some((entry) => entry.kind === "ask"));
		this.list.hidden = !this.unfolded;
		this.list.replaceChildren(
			...entries.map((entry) =>
				h(
					"li",
					{},
					h(
						"button",
						{
							type: "button",
							class: `inbox-entry ${entry.kind}`,
							style: `--tint: ${tintCss(tintOf(entry.view.path))}`,
							onclick: () => {
								this.unfolded = false;
								this.app.activate(entry.view);
							},
						},
						h("span", { class: "inbox-kind", text: entry.kind === "ask" ? t("inboxAsk") : t("inboxFinished") }),
						h("span", { class: "inbox-title", text: entry.view.title }),
						h("span", { class: "inbox-text", text: entry.text }),
					),
				),
			),
		);
	}
}

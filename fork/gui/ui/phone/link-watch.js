// The link to the PC, watched: when the connection drops, the conversations' engines
// on the PC stop with it (app-android.md § 3 quater) and the transport tries again by itself (fork/android/phone,
// `keep_trying`). Meanwhile a line under the topbar says the PC cannot be reached; once it can, the conversation on
// screen starts again from its session file, as one that slept does (session.js `wake`). The others wake when opened.

import { h } from "../js/dom.js";
import { t } from "../js/i18n.js";

const { invoke } = window.__TAURI__.core;

/** How often the page asks the transport; asking also makes it try again now while the link is lost. */
const EVERY = 2000;

export class LinkWatch {
	/** `onChange()` when the PC becomes unreachable or reachable again. */
	constructor(app, place, onChange) {
		this.app = app;
		this.onChange = onChange;
		this.text = h("span", { class: "phone-link-text" });
		this.el = h("div", { class: "phone-link", role: "status", hidden: true }, this.text);
		place.after(this.el);
		this.lost = false;
		setInterval(() => this.check(), EVERY);
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden) this.check();
		});
	}

	async check() {
		const status = await invoke("link_status").catch(() => undefined);
		if (!status) return;
		// The PC removed this phone (or it was forgotten elsewhere): the pairing screen, with the reason, takes over.
		if (!status.paired) {
			if (this.paired) location.reload();
			return;
		}
		this.paired = true;
		if (!status.connected) {
			if (!this.lost) {
				this.lost = true;
				this.onChange?.();
			}
			this.el.hidden = false;
			this.text.textContent = t("phoneLinkLost");
			return;
		}
		this.el.hidden = true;
		if (!this.lost) return;
		this.lost = false;
		// Prism on the PC started again in another folder: the conversations on the phone are
		// the old folder's, so the page starts over in the new one, as the PC window does.
		const info = await invoke("app_info").catch(() => undefined);
		if (info?.cwd && this.app.info?.cwd && info.cwd !== this.app.info.cwd) {
			location.reload();
			return;
		}
		this.onChange?.();
		// Back: the conversation on screen, if its engine went with the connection, starts again.
		const view = this.app.active;
		if (view?.lostLink && !view.engine.alive && !view.closed) {
			view.error = undefined;
			view.suspended = true;
			this.app.activate(view);
		}
	}
}

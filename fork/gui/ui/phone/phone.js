// The phone's own design over the window's interface. Mounted by app.js only when
// the app runs on the phone (the link exists); it marks the page `data-device="phone"`, which every rule of
// phone.css requires, so the desktop window loads nothing active from here.

import { h } from "../js/dom.js";
import { t } from "../js/i18n.js";
import { Band } from "./band.js";
import { Beam } from "./beam.js";
import { Facets } from "./facets.js";
import { Finished } from "./finished.js";
import { holdToQueue, searchButton, viewKeys } from "./gestures.js";
import { tintCss, tintOf, TINTS } from "./glass.js";
import { LinkWatch } from "./link-watch.js";
import { Notices } from "./notices.js";

// The new session's slab is clear glass, without a tint.
const NEW = { key: "new", tint: { name: "clear", rgb: [0.86, 0.88, 0.9] } };
/** How often the home reads the PC's conversation list while it is shown. */
const HOME_HISTORY_POLL_MS = 3000;

export class Phone {
	constructor(app, link) {
		this.app = app;
		this.link = link;
		document.documentElement.dataset.device = "phone";
		this.home = h("section", { class: "phone-home", "aria-label": t("phoneHome"), hidden: true });
		const canvas = h("canvas", { class: "facets", "aria-hidden": "true" });
		this.labels = h("div", { class: "facet-labels", "aria-hidden": "true" });
		this.where = h("span", { class: "phone-where" });
		this.list = h("ul", { class: "offscreen" });
		this.home.append(
			canvas,
			this.labels,
			h(
				"header",
				{ class: "phone-head" },
				h("span", { class: "phone-mark", "aria-hidden": "true" }),
				h("span", { class: "phone-name", text: "Prism" }),
				this.where,
			),
			this.list,
		);
		this.home.querySelector(".phone-mark").innerHTML = '<svg viewBox="0 0 32 32"><path d="M16 5 28 26H4Z"/><path d="M1 19.5h8.4"/></svg>';
		document.body.append(this.home);
		this.facets = new Facets(canvas, this.labels, (item) => this.pick(item));
		// The topbar's way back to the facets.
		const back = h("button", { type: "button", class: "ghost icon phone-back", "aria-label": t("phoneHome"), title: t("phoneHome") });
		back.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 5 28 26H4Z"/></svg>';
		back.addEventListener("click", () => this.showHome());
		const topbar = document.querySelector(".topbar");
		topbar?.prepend(back);
		// The quick switcher's grip hangs under the topbar; the beam runs along the composer.
		this.band = new Band(
			() => this.switchList(),
			(item) => this.pick(item, false),
		);
		// The keyboard's shortcuts, by touch: search, queue, a terminal screen's keys.
		// The phone's own magnifier, in place of the window's (whose arrows show keyboard shortcuts).
		document.getElementById("search-button")?.remove();
		topbar?.append(searchButton(app));
		const send = document.getElementById("send");
		if (send) {
			holdToQueue(send, () => {
				if (document.getElementById("input").value.trim() || app.active?.attachments?.length) app.submit({ behavior: "followUp" });
			});
		}
		const surface = document.getElementById("surface");
		if (surface) viewKeys(surface);
		topbar?.append(this.band.grip);
		if (topbar) this.band.bindPull(topbar, false);
		this.beam = new Beam(document.getElementById("composer"), document.getElementById("transcript-slot"));
		// The home's header says when the PC cannot be reached, in place of its name.
		this.linkWatch = new LinkWatch(app, topbar, () => this.drawWhere());
		// An engine that cannot start while the PC cannot be reached waits for the link (app.js #startFailed).
		app.linkDown = async () => {
			if (this.linkWatch.lost) return true;
			const status = await window.__TAURI__.core.invoke("link_status").catch(() => undefined);
			return Boolean(status?.paired && !status.connected);
		};
		// A turn that ended while the reader was elsewhere: its slab says "Done".
		this.finished = new Finished();
		// The same, and a question, told by Android while the app is not on screen.
		const invoke = window.__TAURI__.core.invoke;
		this.notices = new Notices(
			({ id, title, kind }) => {
				const body = t(kind === "waiting" ? "noticeWaiting" : "noticeDone");
				// `largeBody` too: without it the plugin gives Android an empty list of lines as the expanded text, and the
				// notice, shown expanded at the top of the shade, has a title and nothing under it.
				return invoke("plugin:notification|notify", {
					options: { id, title: title || t("untitled"), body, largeBody: body, icon: "ic_link", autoCancel: true },
				}).catch(() => {});
			},
			(ids) => invoke("plugin:notification|remove_active", { notifications: ids.map((id) => ({ id })) }).catch(() => {}),
		);
		const notice = () => this.notices.track(app.sessions, document.hidden, this.linkWatch.lost);
		document.addEventListener("visibilitychange", notice);
		// A conversation started on the PC shows on the home within seconds, not at the window's 20 s re-read
		// read again often while the home is on screen, and when the app comes back to the front.
		// Only the folder's file names are read that often (`sessions_stamp`); the list itself when they change.
		const homeShown = () => !this.home.hidden && !document.hidden;
		let stamp;
		setInterval(async () => {
			const engine = app.active?.engine;
			if (!homeShown() || !engine?.alive) return;
			const now = await engine.request({ type: "sessions_stamp" }).catch(() => undefined);
			if (now?.stamp === undefined || now.stamp === stamp) return;
			if (stamp !== undefined) app.refreshHistory();
			stamp = now.stamp;
		}, HOME_HISTORY_POLL_MS);
		document.addEventListener("visibilitychange", () => {
			if (homeShown()) app.refreshHistory();
		});
		// The rail's mark leads home as well, from the open drawer.
		const mark = document.querySelector(".rail-mark");
		if (mark) {
			mark.removeAttribute("aria-hidden");
			mark.setAttribute("role", "button");
			mark.setAttribute("aria-label", t("phoneHome"));
			mark.tabIndex = 0;
			mark.addEventListener("click", () => {
				app.sideMenu.fold(false);
				this.showHome();
			});
		}
		this.#keepKeyboardDown();
		this.#settingsInTwoScreens();
		this.#keepEndInView();
		// Android's back button goes back to the facets from a conversation.
		window.addEventListener("popstate", () => {
			if (this.home.hidden) this.showHome(false);
		});
		// The facets follow the conversations: a turn that starts or ends changes which facet breathes.
		const render = app.render.bind(app);
		app.render = (...args) => {
			render(...args);
			this.finished.track(app.sessions, this.home.hidden ? app.active : undefined, this.linkWatch.lost);
			notice();
			if (!this.home.hidden) this.scheduleRefresh();
			this.shown();
		};
	}

	/** A screen that opens with a search field focuses it for the keyboard of the desktop; on the phone that raises the
	 * on-screen keyboard over half the screen. A field gets the focus only from a touch on itself.
	 * The composer too: a closed panel or dialog gave it the focus back, and the keyboard with it. */
	#keepKeyboardDown() {
		let touched;
		document.addEventListener("pointerdown", (event) => (touched = event.target), true);
		document.addEventListener(
			"focusin",
			(event) => {
				const field = event.target;
				if (!(field instanceof HTMLElement) || !field.matches("input:not([type='checkbox'], [type='radio'], [type='range'], [type='button'], [type='submit'], [type='file']), textarea")) return;
				if (touched instanceof Node && (field === touched || field.contains(touched) || touched.closest?.("label")?.control === field)) return;
				// A button made to open this field (the search's magnifier) gives it the keyboard as well.
				if (touched instanceof Element && field.id && touched.closest("[data-focuses]")?.dataset.focuses === field.id) return;
				const holder = field.parentElement?.closest("[tabindex], dialog, [role='dialog']");
				field.blur();
				if (holder instanceof HTMLElement) holder.focus({ preventScroll: true });
			},
			true,
		);
	}

	/** The on-screen keyboard shrinks the page (MainActivity pads the content by its height): a conversation that was
	 * at its end stays at its end, the end of the reply no longer under the composer. One
	 * scrolled up keeps its place, which a smaller view does not move. The end is remembered from the reader's last
	 * scroll, not read after the resize: a larger view (the keyboard put away) moves the view by itself, and the
	 * window's reader-scrolled-up rule would take that for the reader's. */
	#keepEndInView() {
		const scroller = document.getElementById("scroller");
		if (!scroller) return;
		let atEnd = true;
		const distance = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		scroller.addEventListener("scroll", () => (atEnd = distance() < 48), { passive: true });
		new ResizeObserver(() => {
			if (atEnd) this.app.followEnd();
		}).observe(scroller);
	}

	/** The settings on the phone: the list of their sections fills the screen, a section touched
	 * fills it in turn with a way back; the narrow window's layout put both on one screen, cut in two. */
	#settingsInTwoScreens() {
		const dialog = document.getElementById("settings");
		const settings = this.app.settingsDialog;
		if (!dialog || !settings) return;
		const pane = dialog.querySelector(".settings-pane");
		// The history entries the dialog holds: one for the dialog, one more for a section. Android's back button pops them
		// (a section to the list, the list to the conversation) instead of leaving the conversation; both go with the
		// dialog, without the conversation reading that as a way home.
		let entries = 0;
		const push = (key) => {
			history.pushState({ [key]: true }, "");
			entries++;
		};
		const level = (name) => {
			if (!dialog.open) return;
			if (entries === 0) push("settingsList");
			if (name === "pane" && dialog.dataset.level !== "pane") push("settingsPane");
			dialog.dataset.level = name;
		};
		const back = h("button", { type: "button", class: "ghost phone-settings-back", text: `‹ ${t("settings")}` });
		back.addEventListener("click", () => (history.state?.settingsPane ? history.back() : level("list")));
		pane.prepend(back);
		const close = h("button", { type: "button", class: "ghost icon phone-settings-close", "aria-label": t("close"), text: "×" });
		close.addEventListener("click", () => dialog.close());
		dialog.querySelector("#settings-title")?.after(close);
		const open = settings.open.bind(settings);
		settings.open = (section = "window", ...rest) => {
			open(section, ...rest);
			level(section === "window" ? "list" : "pane");
		};
		// Opened before this layer existed (a tap on the window's settings while the first conversation was still
		// loading): the dialog has no level yet, so it showed both screens. It takes the one of the section it shows.
		if (dialog.open) level(settings.shown === "window" ? "list" : "pane");
		dialog.addEventListener("click", (event) => {
			if (event.target.closest?.(".settings-section")) level("pane");
		});
		settings.search.addEventListener("input", () => {
			dialog.dataset.level = settings.search.value.trim() ? "search" : "list";
		});
		let leaving = false;
		dialog.addEventListener("close", () => {
			dialog.dataset.level = "list";
			if (entries === 0) return;
			leaving = true;
			history.go(-entries);
			entries = 0;
		});
		window.addEventListener("popstate", (event) => {
			if (leaving) {
				leaving = false;
				event.stopImmediatePropagation();
			} else if (dialog.open && dialog.dataset.level === "pane" && !history.state?.settingsPane) {
				// From a section to the list.
				entries--;
				dialog.dataset.level = "list";
				event.stopImmediatePropagation();
			} else if (dialog.open) {
				// From the list: the settings close, the conversation stays (before, the facets opened under a dialog
				// that stayed open).
				entries = 0;
				event.stopImmediatePropagation();
				dialog.close();
			}
		});
	}

	showHome(push = true) {
		if (!push && history.state?.conversation) history.back();
		this.home.hidden = false;
		this.app.refreshHistory();
		this.refresh();
		this.facets.show(true);
	}

	hideHome() {
		this.home.hidden = true;
		this.facets.show(false);
		history.pushState({ conversation: true }, "");
	}

	scheduleRefresh() {
		if (this.refreshing) return;
		this.refreshing = true;
		setTimeout(() => {
			this.refreshing = false;
			this.refresh();
		}, 250);
	}

	/** The conversations open in the app first, then the folder's saved sessions, newest first. */
	sessionItems() {
		const app = this.app;
		const seen = new Set();
		const items = [];
		for (const view of app.sessions) {
			// A conversation with nothing in it yet is the new-session facet's.
			if (!view.firstMessage && !view.state?.sessionName && !view.savedTitle) continue;
			seen.add(view.path);
			// Waiting for an answer (an authorisation, a choice): its slab lit, steady.
			const waiting = !view.closed && view.dialogs.size > 0;
			const active = Boolean(view.streaming);
			const done = !waiting && !active && this.finished.has(view.path);
			items.push({ key: view.path, path: view.path, cwd: view.cwd, title: view.title || t("untitled"), modified: Date.now(), active, waiting, done });
		}
		for (const session of [...(app.history ?? [])].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))) {
			if (seen.has(session.path)) continue;
			seen.add(session.path);
			items.push({ key: session.path, path: session.path, cwd: session.cwd, title: session.name || session.firstMessage || t("untitled"), modified: Date.parse(session.modified), active: false });
		}
		return items;
	}

	/** The facets: seven sessions at most, and the new session's. */
	refresh() {
		const app = this.app;
		const items = this.sessionItems();
		const shown = items.slice(0, 7).map((item, k) => ({ ...item, tint: tintOf(item.key), weight: 1 - k / 8, meta: item.waiting ? t("inboxAsk") : item.active ? t("phoneWorking") : item.done ? t("inboxFinished") : ago(item.modified) }));
		shown.push({ ...NEW, title: t("newSession"), meta: "", weight: 0.25, active: false });
		this.facets.set(shown);
		// The same list for a screen reader and the keyboard: the canvas is only a picture of it.
		this.list.replaceChildren(...shown.map((item) => h("li", {}, h("button", { type: "button", text: item.title, onclick: () => this.pick(item) }))));
		this.drawWhere();
	}

	/** The header: the folder and the PC, or that the PC cannot be reached. */
	drawWhere() {
		const app = this.app;
		const cwd = app.active?.cwd ?? app.info?.cwd ?? "";
		const lost = this.linkWatch.lost;
		this.where.textContent = [cwd.split("/").filter(Boolean).at(-1), lost ? t("phoneUnreachable") : this.link.host].filter(Boolean).join(" · ");
		this.where.classList.toggle("lost", lost);
		// The ground's beam of light goes out while the PC does not answer.
		this.facets.beam(!lost);
	}

	/** The switcher's sessions: the shown one, then the others as on the facets. */
	switchList() {
		const items = this.sessionItems().map((item) => ({ ...item, tint: tintOf(item.key) }));
		const at = Math.max(0, items.findIndex((item) => item.path === this.app.active?.path));
		return { items, at };
	}

	/** The shown conversation's tint goes to the beam and the glow behind the conversation. */
	shown() {
		const path = this.app.active?.path;
		if (path === this.shownPath) return;
		this.shownPath = path;
		const { items, at } = this.switchList();
		const tint = tintOf(path);
		const count = items.length;
		const neighbours = count > 2 ? [items[(at + count - 1) % count].tint, items[(at + 1) % count].tint] : [TINTS[(TINTS.indexOf(tint) + 6) % 7], TINTS[(TINTS.indexOf(tint) + 1) % 7]];
		this.beam.tint([tint, ...neighbours]);
		document.documentElement.style.setProperty("--phone-tint", tintCss(tint));
	}

	pick(item, fromHome = true) {
		if (fromHome) this.hideHome();
		if (item.key === NEW.key) this.app.openSession(undefined);
		else this.app.openSession(item.path, item.title, item.cwd);
	}
}

function ago(time) {
	const seconds = (time - Date.now()) / 1000;
	const format = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: "auto" });
	for (const [unit, size] of [
		["day", 86400],
		["hour", 3600],
		["minute", 60],
	])
		if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
	return format.format(0, "minute");
}

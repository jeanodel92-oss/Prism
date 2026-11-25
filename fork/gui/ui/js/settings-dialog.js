// the window's Settings dialog. Its first section holds the window's own preferences (index.html);
// the engine's /settings domains follow, each drawn from the engine's native screens (settings-native.ts, layout
// "sections") in the dialog rather than in a panel of the conversation. Every change is the engine's, as in /settings.

import { Segmented } from "./components.js";
import { h } from "./dom.js";
import { t } from "./i18n.js";
import { nativeMenu, send } from "./native-menu.js";

const $ = (id) => document.getElementById(id);

/** Text as the settings search compares it: without accents or case, as the engine's (settings-native.ts). */
const fold = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The engine's settings view, drawn in the dialog's pane: what native-menu.js needs of a view's panel. */
class DialogView {
	constructor(session, id, dialog) {
		this.session = session;
		this.id = id;
		this.owner = "settings";
		this.closed = false;
		this.dialog = dialog;
		this.el = dialog.engine;
		this.panel = { setTitle: (title) => dialog.title(title) };
		// The search the engine was last sent (SettingsDialog.sections).
		this.searched = "";
	}

	frame(_columns, _lines, menu) {
		// A frame the engine sent before it read the dialog's close draws nothing.
		if (!menu || this.closed) return;
		// Typing in the settings search keeps the keyboard while the results come.
		const focused = document.activeElement !== this.dialog.search && (this.el.contains(document.activeElement) || this.refocus);
		this.refocus = false;
		this.menu = menu;
		this.el.replaceChildren(nativeMenu(this, menu));
		this.dialog.sections(menu);
		if (focused) this.el.querySelector("[data-autofocus]")?.focus({ preventScroll: true });
		// A frame follows each change: the window shows the theme and the drawing settings at once, not on Close.
		void this.session.refreshDisplay();
	}

	close() {
		this.closed = true;
	}
}

export class SettingsDialog {
	constructor(app) {
		this.app = app;
		this.el = $("settings");
		this.nav = $("settings-sections");
		this.window = $("settings-window");
		this.engine = $("settings-engine");
		this.heading = $("settings-pane-title");
		this.shown = "window";
		this.windowButton = this.el.querySelector("[data-section='window']");
		// Simple │ Advanced always at hand, as in the terminal's /settings title
		// row, rather than only as a setting of the Interface domain. The engine says the mode on each screen.
		this.mode = new Segmented({
			options: [
				{ value: "simple", label: t("interfaceSimple") },
				{ value: "advanced", label: t("interfaceAdvanced") },
			],
			label: t("interfaceMode"),
			onChange: (value) => {
				if (this.view && !this.view.closed) void send(this.view, { kind: "interface-mode", value });
			},
		});
		this.mode.el.classList.add("settings-mode");
		this.mode.el.hidden = true;
		this.el.querySelector("#settings-title").after(this.mode.el);
		// one search across the window's preferences and every engine domain, as
		// the terminal's /settings search.
		this.query = "";
		// built before the language is known, so named again when it changes.
		this.search = h("input", {
			type: "search",
			class: "field settings-search",
			placeholder: t("searchSettings"),
			"aria-label": t("searchSettings"),
			dataset: { i18nPlaceholder: "searchSettings", i18nLabel: "searchSettings" },
		});
		let typing;
		this.search.addEventListener("input", () => {
			clearTimeout(typing);
			typing = setTimeout(() => this.#search(this.search.value), 120);
		});
		this.mode.el.after(this.search);
		this.windowButton.addEventListener("click", () => this.show("window"));
		// Closed by Close, Escape or a row that runs a command: the engine's view closes with it.
		this.closings = 0;
		this.el.addEventListener("close", () => {
			this.closings++;
			if (this.view && !this.view.closed) {
				this.view.session.closeView(this.view);
				this.view.close();
			}
			this.nav.replaceChildren();
			this.engine.replaceChildren();
			this.mode.el.hidden = true;
			this.#endSearch();
		});
	}

	/** Shows what matches `text` in the window's preferences and, through the engine, in every domain. */
	#search(text) {
		const query = text.trim();
		if (query === this.query) return;
		if (!query) {
			const back = this.beforeSearch ?? "window";
			this.#endSearch();
			this.show(back);
			return;
		}
		if (!this.query) this.beforeSearch = this.shown;
		this.query = query;
		this.shown = "search";
		const words = fold(query).split(/\s+/).filter(Boolean);
		const area = fold(t("settingsWindow"));
		let matches = 0;
		for (const row of this.window.querySelectorAll(".field-row")) {
			const text = `${fold(row.querySelector("span")?.textContent ?? "")} ${area}`;
			row.hidden = !words.every((word) => text.includes(word));
			if (!row.hidden) matches++;
		}
		for (const info of this.window.querySelectorAll(".info")) info.hidden = true;
		this.windowMatches = matches;
		this.window.hidden = matches === 0;
		this.engine.hidden = false;
		this.heading.textContent = t("searchResults");
		this.#current();
		this.#sendSearch();
	}

	/** The engine's part of the search, once its settings are drawn; one request per new query. */
	#sendSearch() {
		const view = this.view?.closed ? undefined : this.view;
		if (!view?.menu || view.searched === this.query) return;
		view.searched = this.query;
		void send(view, { kind: "search", query: this.query });
	}

	/** The window's rows all shown again and the engine back on its domain; the field emptied. */
	#endSearch() {
		this.query = "";
		this.beforeSearch = undefined;
		this.search.value = "";
		for (const el of this.window.querySelectorAll(".field-row, .info")) el.hidden = false;
		const view = this.view?.closed ? undefined : this.view;
		if (view?.menu && view.searched) {
			view.searched = "";
			void send(view, { kind: "search", query: "" });
		}
	}

	/** Opens the dialog on `section` (the window's, or an engine domain once the engine has drawn it). */
	open(section = "window") {
		const opening = !this.el.open;
		if (opening) this.el.showModal();
		this.show(section);
		// Audit of 2026-11-23, UX-12: opened with the keyboard in none of its controls, WebKitGTK let Escape do nothing.
		// The keyboard starts on the section shown (app.js also closes the dialog on Escape wherever the keyboard is).
		if (opening) this.#currentButton()?.focus({ preventScroll: true });
		void this.#start(section === "window" ? undefined : section);
	}

	/** Shows the window's section, or the engine's domain `id`, which the engine draws. */
	show(id) {
		// A section chosen ends the search (the engine leaves it for the domain itself).
		if (this.query) {
			const view = this.view?.closed ? undefined : this.view;
			if (view && id !== "window") view.searched = "";
			this.#endSearch();
		}
		this.shown = id;
		this.window.hidden = id !== "window";
		this.engine.hidden = id === "window";
		const view = this.view?.closed ? undefined : this.view;
		const menu = view?.menu;
		if (id === "window") this.title(t("settingsWindow"));
		else if (menu?.title) this.title(menu.title);
		// Another domain, or the top of this one from a page opened in it.
		if (id !== "window" && view && menu?.sections && (menu.section !== id || !menu.root || menu.searching)) {
			send(view, { kind: "section", sectionId: id });
		}
		this.#current();
	}

	title(text) {
		this.heading.textContent = this.shown === "window" ? t("settingsWindow") : this.shown === "search" ? t("searchResults") : text;
	}

	/** The engine's domains, from the screen it shows. */
	sections(menu) {
		this.mode.el.hidden = !menu?.interfaceMode;
		if (menu?.interfaceMode) {
			this.mode.set(menu.interfaceMode);
			this.mode.el.setAttribute("aria-label", t("interfaceMode"));
			this.mode.buttons[0].textContent = t("interfaceSimple");
			this.mode.buttons[1].textContent = t("interfaceAdvanced");
		}
		const sections = menu?.sections ?? [];
		if (sections.map((section) => section.id).join("\n") !== [...this.nav.children].map((el) => el.dataset.section).join("\n")) {
			this.nav.replaceChildren(
				...sections.map((section) =>
					h("button", {
						type: "button",
						class: "settings-section",
						title: section.description,
						text: section.label,
						dataset: { section: section.id },
						onclick: () => this.show(section.id),
					}),
				),
			);
		} else {
			for (const [index, el] of [...this.nav.children].entries()) {
				el.textContent = sections[index].label;
				el.title = sections[index].description ?? "";
			}
		}
		if (this.query) {
			this.#sendSearch();
			// Nothing in the engine's domains but rows of the window: only those.
			if (menu?.searching === this.query) this.engine.hidden = (menu.items ?? []).length === 0 && this.windowMatches > 0;
			this.#current();
			return;
		}
		// The engine came back to its first domain (the one shown was left out): follow it.
		if (this.shown !== "window" && menu?.section && menu.section !== this.shown && menu.root) this.shown = menu.section;
		this.#current();
	}

	#current() {
		for (const el of [this.windowButton, ...this.nav.children]) {
			el.setAttribute("aria-current", String(el.dataset.section === this.shown));
		}
		// A narrow window lists the sections on one scrolling row (da.css, FIN-30): the one shown stays in view.
		this.#currentButton()?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	#currentButton() {
		return [this.windowButton, ...this.nav.children].find((el) => el.dataset.section === this.shown);
	}

	/** The engine's /settings for the active session, once the ones closed a moment ago have ended. */
	async #start(domain) {
		while (this.running) await this.running;
		const session = this.app.active;
		if (!this.el.open || !session?.ready || !session.engine.alive) return;
		this.running = this.#run(session, domain).finally(() => {
			this.running = undefined;
		});
	}

	/** Until the dialog closes or a row ends the settings. */
	async #run(session, domain) {
		const closings = this.closings;
		let reloaded = false;
		session.viewHost = (id) => {
			session.viewHost = undefined;
			this.view = new DialogView(session, id, this);
			return this.view;
		};
		try {
			const result = await session.engine.request({
				type: "settings",
				layout: "sections",
				...(domain ? { domain } : {}),
			});
			reloaded = Boolean(result.reloaded);
			await session.refreshResources();
			if (reloaded) this.app.toast(t("settingsReloaded"));
			if (result.line) {
				this.el.close();
				void session.prompt(result.line);
			}
		} catch (error) {
			this.app.toast(String(error?.message ?? error), "error");
		} finally {
			const last = this.view?.menu?.section;
			session.viewHost = undefined;
			this.view = undefined;
			this.nav.replaceChildren();
			this.engine.replaceChildren();
			this.mode.el.hidden = true;
			// Modules turned on or off end the engine's settings to reload the session: they open again where they
			// were, unless the dialog was closed meanwhile (opened again since, it draws its own).
			const kept = this.el.open && this.closings === closings;
			if (reloaded && kept) this.open(this.shown === "window" ? "window" : (last ?? "window"));
			else if (kept && this.shown !== "window") this.show("window");
		}
	}
}

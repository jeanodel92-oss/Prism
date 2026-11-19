// The window: sidebar, conversation, composer and settings around the open sessions. Each session view
// talks to its own engine; this module only arranges them and keeps the window's own preferences
// (theme, language, animations), which are not engine settings.

import { draftChips, imageAttachment } from "./attachments.js";
import { builtin } from "./builtins.js";
import { ListBox, Panel } from "./components.js";
import { Completion } from "./completion.js";
import { TranscriptSearch } from "./search.js";
import { clear, h, show, stripAnsi } from "./dom.js";
import { runDrive } from "./drive.js";
import { shellQuote } from "./shell-quote.js";
import { formatCost, formatNumber, setLanguage, t } from "./i18n.js";
import { boundAction, COMPOSER_KEYS, KEYS, keyText, matches } from "./keys.js";
import { canSleep, criticalMemory, isBlank, lifecycle, lowMemory, memoryInfo } from "./lifecycle.js";
import { Inbox, inboxDot } from "./inbox.js";
import { sessionStateBody } from "./inspector-screen.js";
import { WelcomeScene } from "./optics.js";
import { phoneAttachment, pickOnPhone } from "../phone/pick.js";
import { uploadToPc } from "../phone/transfer.js";
import { Phone } from "../phone/phone.js";
import { startupUpdateCheck } from "./android-update.js";
import { linkStatus, mountLinkSettings, pairScreenNotice, showPairScreen } from "./pair-screen.js";
import { phoneLinkScreen, phoneLinkState, phonesList, revokePhone } from "./phone-link.js";
import { androidAppQr } from "./android-app.js";
import { projectScreen } from "./project-screen.js";
import { followPointer } from "./light.js";
import { SessionView } from "./session.js";
import { SettingsDialog } from "./settings-dialog.js";
import { SideMenu } from "./side-menu.js";
import { Surface } from "./surface.js";
import { loadThemes, setThemePreference, themeName } from "./theme.js";

/** How often the conversation list is read again while the window is shown (sessions started elsewhere). */
const HISTORY_POLL_MS = 20_000;
/** How often the window asks which conversations a phone has open through its engines. */
const PHONE_SESSIONS_POLL_MS = 3000;
const { invoke, Channel } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const PREFS_KEY = "prism.gui.prefs";

function loadPrefs() {
	try {
		return { theme: "system", language: "system", animations: "system", ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
	} catch {
		return { theme: "system", language: "system", animations: "system" };
	}
}

function savePrefs(prefs) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// Preferences then last for this run only.
	}
}

class App {
	constructor() {
		this.sessions = [];
		// The pending placement of a new conversation (openSession).
		this.placing = undefined;
		this.active = undefined;
		this.prefs = loadPrefs();
		this.info = undefined;
		// The saved conversations of `historyCwd`'s folder; undefined while not known for the folder on screen.
		this.history = [];
		this.historyCwd = undefined;
		this.footerFit = Number.POSITIVE_INFINITY; // how many pinned commands the footer last had room for
		this.stick = true;
		// Where the transcript's view was last seen (#seen), to tell the reader's scroll up from the transcript's changes.
		this.seenTop = 0;
		this.seenHeight = 0;
		this.renderScheduled = false;
		this.lastEscape = 0; // the terminal editor's double Escape
		this.renderTimes = [];
		this.markdownOptions = { onLink: (url) => this.confirmLink(url) };
		this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	}

	async init() {
		followPointer();
		this.info = await invoke("app_info");
		const drops = new Channel();
		drops.onmessage = (paths) => this.dropped(paths);
		await invoke("drop_listen", { onDrop: drops });
		loadThemes(this.info.themes);
		this.scene = new WelcomeScene($("scene"));
		this.settingsDialog = new SettingsDialog(this);
		this.surface = new Surface($("surface"), document.querySelector(".main"), $("composer"));
		this.sideMenu = new SideMenu(this);
		// fork: what waits for you, under the topbar as on the phone.
		this.inbox = new Inbox(this, document.querySelector(".topbar"));
		// fork: desktop notifications only while the window is not in front (notify.ts).
		for (const name of ["focus", "blur"])
			window.addEventListener(name, () => {
				for (const view of this.sessions) this.reportFocus(view);
			});
		// fork: a conversation started elsewhere (the phone, a terminal) shows in the list without
		// a reload: read again when the window comes back to the front, and every 20 s while it is shown.
		window.addEventListener("focus", () => this.refreshHistory());
		setInterval(() => {
			if (document.visibilityState === "visible") this.refreshHistory();
		}, HISTORY_POLL_MS);
		this.#applyPrefs();
		this.#bind();
		// The first frames drawn: `prism --gui` knows the window started (a window that stops at its first draw is reported, not announced as open)
		// .
		requestAnimationFrame(() => requestAnimationFrame(() => invoke("window_ready").catch(() => {})));
		// The phone app only: without a link to a PC there is no engine, so the pairing screen takes the window's place.
		const link = await linkStatus();
		if (link) {
			this.redrawLink = mountLinkSettings($("settings-link"), link);
			// in "notify" mode, a newer app version is said at start (android-update.js).
			void startupUpdateCheck((text, download) => {
				const action = { label: t("updateDownload"), run: download };
				if (!pairScreenNotice(text, action)) this.toast(text, "info", { sticky: true, action });
			});
			if (!link.connected) {
				showPairScreen(link);
				return;
			}
		}
		// fork: the PC window links a phone, from its settings and once from its welcome.
		else {
			void this.#offerPhoneLink();
			setInterval(() => void this.#followPhones(), PHONE_SESSIONS_POLL_MS);
		}
		if (this.info.engineError) {
			this.#banner(t("engineFailed"), this.info.engineError);
			return;
		}
		await this.openSession(undefined);
		// The phone app has its own home and look over the same window.
		if (link) new Phone(this, link).showHome(false);
		// Idle conversations not on screen go to sleep (lifecycle.js); checked once a minute.
		setInterval(() => this.reclaim(), 60_000);
	}

	// ---------------------------------------------------------------------------------------------
	// Sessions

	/**
	 * Puts idle conversations to sleep: those idle for `lifecycle.idleMs`, the least recently used beyond
	 * `lifecycle.maxAwake` running engines, and, when memory runs short, every idle one, least recently used first.
	 * With `starting`, one more engine is about to start, and the result says whether it may (false when memory
	 * stays short). `idle: false` leaves the idle time to the minute's check.
	 */
	async reclaim({ starting = false, idle: byIdle = true } = {}) {
		let memory = await memoryInfo();
		const now = performance.now();
		const short = memory && lowMemory(memory);
		const idle = this.sessions.filter((view) => canSleep(view, this.active, now, 0)).sort((a, b) => a.lastActive - b.lastActive);
		// Engines running or starting: a woken or new conversation counts before its engine is up.
		let awake =
			this.sessions.filter((view) => (!view.suspended || view.waking) && !view.closed && !view.exit && !view.error).length +
			(starting ? 1 : 0);
		let slept = 0;
		for (const view of idle) {
			const over = awake > lifecycle.maxAwake;
			if (!short && !over && (!byIdle || now - view.lastActive < lifecycle.idleMs)) continue;
			// Checked again now: while an earlier one went to sleep, this one may have been opened or started a turn
			//.
			if (!canSleep(view, this.active, performance.now(), 0)) continue;
			await view.sleep();
			slept++;
			awake--;
			if (short) memory = await memoryInfo();
			if (short && memory && !lowMemory(memory) && awake <= lifecycle.maxAwake) break;
		}
		if (slept) this.render();
		return !(starting && memory && criticalMemory(memory));
	}

	/** `title`: the saved conversation's name, shown while it loads (else the history's). */
	async openSession(path, title, cwd) {
		// One at a time up to the new conversation's place in the list: the memory check awaits the host, and two
		// quick clicks on "New conversation" both found no empty conversation and started two engines.
		const placed = (this.placing ?? Promise.resolve()).then(() => this.placeSession(path, title, cwd));
		this.placing = placed.catch(() => {});
		const view = await placed;
		if (!view) return;
		try {
			await view.open();
		} catch (error) {
			await this.#startFailed(view, error);
		}
		this.refreshHistory();
	}

	/**
	 * An engine that could not start. On the phone, when the PC cannot be reached (its window closed, the network
	 * gone), the conversation waits for the link instead, as one cut by the link does: no failure of its own, the line
	 * under the topbar says why, and it starts once the PC is back (phone/link-watch.js). Owner's QA of the fork.11
	 * candidate, 2026-11-15: each conversation opened failed on its own with "Connection refused".
	 */
	async #startFailed(view, error) {
		if (await this.linkDown?.().catch(() => false)) {
			view.error = undefined;
			view.ready = false;
			view.suspended = true;
			view.lostLink = true;
		} else view.error = String(error?.message ?? error);
		this.sessionChanged(view);
	}

	/** The new conversation, listed and shown; undefined when an open one was shown instead or none may start. */
	async placeSession(path, title, cwd) {
		const known = path ? this.history?.find((s) => s.path === path) : undefined;
		cwd ??= known?.cwd ?? this.active?.cwd ?? this.info.cwd;
		const existing = path ? this.sessions.find((s) => s.path === path) : this.sessions.find((s) => isBlank(s) && s.cwd === cwd);
		if (existing) {
			this.activate(existing);
			return undefined;
		}
		if (!(await this.reclaim({ starting: true }))) {
			this.toast(t("memoryLow"), "error");
			return undefined;
		}
		const view = new SessionView(this, path, title ?? (known?.name || known?.firstMessage), cwd);
		this.sessions.push(view);
		this.activate(view);
		return view;
	}

	/**
	 * Wakes the conversation just shown. Its engine starts as a new conversation's does: one at a time, and only when
	 * memory allows it, else it stays asleep. The least recently used beyond the
	 * running ones sleeps first.
	 */
	#wakeShown(view) {
		const woken = (this.placing ?? Promise.resolve()).then(async () => {
			if (!view.suspended || view.waking || view.closed) return;
			if (!(await this.reclaim({ starting: true, idle: false }))) {
				this.toast(t("memoryLow"), "error");
				return;
			}
			if (!view.suspended || view.waking || view.closed) return;
			view.wake().catch((error) => this.#startFailed(view, error));
		});
		this.placing = woken.catch(() => {});
	}

	activate(view) {
		this.completion?.close();
		const changed = this.active !== view;
		// there is one composer on screen, and each conversation keeps its own draft in it.
		if (this.active !== view) {
			const input = $("input");
			if (this.active) this.active.draft = input.value;
			input.value = view.draft ?? "";
			this.browsing = undefined;
			this.#grow();
		}
		this.active = view;
		// The history is the folder's: switching to a conversation of the same folder keeps it on screen while the
		// new one's engine starts and cannot list it yet, instead of "no saved sessions".
		if (changed) {
			if (view.cwd !== this.historyCwd) this.history = undefined;
			this.refreshHistory();
		}
		view.lastActive = performance.now();
		if (view.suspended) this.#wakeShown(view);
		document.body.classList.remove("sidebar-open");
		const slot = $("transcript-slot");
		clear(slot);
		slot.append(view.el);
		this.followEnd();
		this.surface.place(view);
		this.languageShown(view);
		this.search?.shown();
		this.render();
		// The keyboard goes back where it was in that conversation: its open interaction, or the composer.
		this.focusAfterInteraction(view);
	}

	/**
	 * fork: a conversation a phone has open through this window's engines is listed
	 * under "Open" here too, asleep until shown: shown, it shares the phone's engine. One listed only for the phone
	 * leaves the list when the phone lets it go, unless it was shown here meanwhile.
	 */
	async #followPhones() {
		if (this.followingPhones) return;
		this.followingPhones = true;
		try {
			const paths = await invoke("phone_sessions").catch(() => undefined);
			if (!paths) return;
			const held = new Set(paths);
			// Closed here while the phone had it: not listed again until the phone lets it go.
			this.phoneClosed ??= new Set();
			for (const path of this.phoneClosed) if (!held.has(path)) this.phoneClosed.delete(path);
			let changed = false;
			for (const path of paths) {
				if (this.phoneClosed.has(path) || this.sessions.some((view) => view.path === path)) continue;
				const known = this.history?.find((session) => session.path === path);
				const view = new SessionView(this, path, known?.name || known?.firstMessage, known?.cwd ?? this.info.cwd);
				view.suspended = true;
				view.forPhone = true;
				this.sessions.push(view);
				changed = true;
				// Its title, if the folder's list does not have it yet.
				if (!known) this.refreshHistory();
			}
			for (const view of this.sessions) {
				const onPhone = held.has(view.path);
				if (view.onPhone !== onPhone) changed = true;
				view.onPhone = onPhone;
				// Shown here once: it is the window's too.
				if (view === this.active || !view.suspended) view.forPhone = false;
				// A conversation the phone started after it was listed: its title once the history has it.
				if (view.forPhone && !view.savedTitle) {
					const known = this.history?.find((session) => session.path === view.path);
					if (known?.name || known?.firstMessage) {
						view.savedTitle = known.name || known.firstMessage;
						changed = true;
					}
				}
			}
			const gone = this.sessions.filter((view) => view.forPhone && !view.onPhone && view.suspended && !view.waking);
			if (gone.length) {
				this.sessions = this.sessions.filter((view) => !gone.includes(view));
				this.refreshHistory();
				changed = true;
			}
			if (changed) this.render();
		} finally {
			this.followingPhones = false;
		}
	}

	async closeSession(view) {
		if (view.onPhone) (this.phoneClosed ??= new Set()).add(view.path);
		// Answer its questions first, then stop listening: what the engine reports while it shuts down
		// concerns a conversation that is gone, and must not land as a notice on another one.
		view.cancelDialogs();
		view.closed = true;
		await view.engine.stop().catch(() => {});
		this.sessions = this.sessions.filter((s) => s !== view);
		if (this.active === view) {
			if (this.sessions.length) this.activate(this.sessions.at(-1));
			else await this.openSession(undefined);
		}
		// Closed, it is listed with the folder's history.
		this.refreshHistory();
		this.render();
	}

	async reopen(view) {
		const { path, title, cwd } = view;
		this.sessions = this.sessions.filter((s) => s !== view);
		await this.openSession(path, title, cwd);
	}

	// A choice the window asks for a built-in command (/fork), on the interaction surface, filterable;
	// resolves to the chosen value, or undefined.
	choose(view, owner, title, options) {
		const panel = new Panel({ title, kind: "choice" });
		const list = new ListBox({
			items: options.map((option) => ({ label: option.label.split("\n")[0], description: option.description, value: option.value })),
			filter: options.length > 6,
			placeholder: t("filter"),
			empty: t("noMatch"),
			onChoose: (item) => panel.done(item.value),
		});
		panel.setBody(list.el);
		return view.showPanel(owner, panel);
	}

	/**
	 * Renames the conversation on screen in place: its title becomes a field; Enter or leaving it keeps the
	 * name (the engine's set_session_name, as /name), Escape cancels.
	 */
	editTitle(view = this.active) {
		const button = $("session-title");
		if (view !== this.active || !view?.ready || !view.engine.alive || button.hidden) return;
		const before = view.state?.sessionName ?? "";
		const field = h("input", {
			type: "text",
			class: "field title-field",
			value: before || view.title,
			spellcheck: "false",
			autocomplete: "off",
			"aria-label": t("renameSession"),
		});
		let finished = false;
		const finish = async (keep) => {
			if (finished) return;
			finished = true;
			const name = field.value.trim();
			field.remove();
			button.hidden = false;
			if (!keep || !name || name === before) return;
			try {
				await view.rename(name);
			} catch (error) {
				this.toast(String(error?.message ?? error), "error");
			}
		};
		field.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			finish(event.key === "Enter");
			$("input").focus();
		});
		field.addEventListener("blur", () => finish(true));
		button.hidden = true;
		$("title-slot").append(field);
		field.focus();
		field.select();
	}

	/** `text` with the terminal key bound to `id` in the active conversation, as a tooltip shows it. */
	withKey(text, id) {
		const key = this.active?.keys?.bindings?.[id]?.keys?.[0];
		return key ? `${text} (${keyText(key)})` : text;
	}

	/**
	 * The model picker, on the interaction surface: every model the engine offers, filterable, with what tells
	 * them apart (provider, context, reasoning, images). Runs inside the "model" command (/model, its key, the
	 * composer's button), so a second press closes it.
	 */
	async modelPicker(view, all = false) {
		const current = view.state?.model;
		const same = (m) => current && m.provider === current.provider && m.id === current.id;
		// the models of /scoped-models first, as in the terminal; one row shows them all.
		// Asked at each opening: /scoped-models and the login checklist change them during the session.
		const chosen = all ? [] : ((await view.engine.request({ type: "get_scoped_models" }).catch(() => undefined))?.models ?? []);
		const scoped = chosen.map((s) => view.models.find((m) => m.provider === s.provider && m.id === s.id)).filter(Boolean);
		const models = scoped.length > 0 ? scoped : view.models;
		const items = models.map((m) => ({ label: m.name || m.id, meta: m.provider, description: modelFacts(m), value: m, current: same(m) }));
		const showAll = { label: t("modelShowAll"), value: "all" };
		const panel = new Panel({ title: t(scoped.length > 0 ? "modelTitleScoped" : "modelTitle"), kind: "choice picker-panel" });
		const list = new ListBox({
			items: scoped.length > 0 ? [...items, showAll] : items,
			selected: Math.max(0, models.findIndex(same)),
			filter: items.length > 6,
			placeholder: t("filter"),
			empty: t("noMatch"),
			onChoose: (item) => panel.done(item.value),
		});
		panel.setBody(list.el);
		const picked = await view.showPanel("model", panel);
		if (picked === "all") return this.modelPicker(view, true);
		if (picked && !same(picked)) await view.setModel(picked.provider, picked.id);
	}

	/** The reasoning levels the model accepts, the current one marked. Inside the "thinking" command. */
	async thinkingPicker(view) {
		const level = view.state?.thinkingLevel;
		const panel = new Panel({ title: t("thinkingTitle"), kind: "choice picker-panel" });
		const list = new ListBox({
			items: view.levels.map((value) => ({ label: levelName(value), value, current: value === level })),
			selected: Math.max(0, view.levels.indexOf(level)),
			onChoose: (item) => panel.done(item.value),
		});
		panel.setBody(list.el);
		const chosen = await view.showPanel("thinking", panel);
		if (chosen && chosen !== level) await view.setThinking(chosen);
	}

	/** A picker from the composer's buttons or a key: the same command as typing it, so it toggles. */
	#openPicker(name) {
		const view = this.active;
		if (!view?.ready || !view.engine.alive) return;
		const work = name === "model" ? () => this.modelPicker(view) : () => this.thinkingPicker(view);
		view.interactions.run(name, work, { toggle: true }).catch((error) => this.toast(String(error?.message ?? error), "error"));
	}

	showHistory() {
		this.sideMenu.show("chat");
		this.refreshHistory();
	}

	async refreshHistory() {
		const source = this.active;
		if (!source?.engine.alive || !source.state) return;
		try {
			const { sessions } = await source.engine.request({ type: "list_sessions" });
			if (source !== this.active) return;
			// Read again on a timer: nothing new, nothing drawn again.
			if (source.cwd === this.historyCwd && JSON.stringify(sessions) === JSON.stringify(this.history)) return;
			this.history = sessions;
			this.historyCwd = source.cwd;
		} catch {
			if (source !== this.active) return;
			this.history = [];
			this.historyCwd = source.cwd;
		}
		this.render();
	}

	// ---------------------------------------------------------------------------------------------
	// Called by session views

	/** minimised while the agent has the user's desktop, back when it gives it back. */
	agentHasDesktop(has) {
		if (has === Boolean(this.minimizedForAgent)) return;
		this.minimizedForAgent = has;
		invoke("set_minimized", { minimized: has }).catch(() => {});
	}

	sessionChanged(view) {
		if (view.streaming === false && view.wasStreaming) this.refreshHistory();
		view.wasStreaming = view.streaming;
		this.render();
	}

	followTranscript() {
		if (!this.stick) return;
		// Asked again in the frame: a scroll of the reader's since the request wins (a long reply, written a frame at a time, brought the view back on every scroll up)
		// . WebKitGTK may send that scroll's event
		// after this frame, so the view's place is read here too.
		requestAnimationFrame(() => {
			if (!this.following()) return;
			const scroller = $("scroller");
			// The transcript's last entries drawn first: only those around the view are in the page (transcript-list.js).
			if (this.active) this.active.list.reconcile({ end: true });
			else scroller.scrollTop = scroller.scrollHeight;
			this.#seen(scroller);
		});
	}

	/** Whether the view follows the transcript's end: no longer from the reader's scroll up, even one not yet seen as an event. */
	following() {
		if (this.stick && this.#readerScrolledUp()) this.stick = false;
		return this.stick;
	}

	/**
	 * The transcript moved the view itself, not the reader (transcript-list.js): by `delta` px to keep what the reader
	 * sees in place (a scroll of the reader's not seen yet still counts), or `placed` at its end or at an entry.
	 */
	transcriptMoved(delta, placed) {
		const scroller = $("scroller");
		if (placed) this.#seen(scroller);
		else {
			this.seenTop += delta;
			this.seenHeight = scroller.scrollHeight;
		}
		this.ownScroll = scroller.scrollTop;
	}

	/** The view at the end of the transcript, following it: a conversation shown, a message sent. */
	followEnd() {
		this.stick = true;
		this.seenTop = 0;
		this.followTranscript();
	}

	// Following the reply stops as soon as the reader moves the view up, by any amount, and starts again at the end.
	// QA-007: decided by the distance to the end alone, small steps up (a touchpad, smooth scrolling) stayed under
	// 48 px and the next frame brought the view back down: the reader could not leave the end of a reply being
	// written. The view moving up because the transcript got shorter (a block written again) is not the reader's.
	#readerScrolledUp() {
		const scroller = $("scroller");
		return scroller.scrollTop < this.seenTop - 0.5 && scroller.scrollHeight >= this.seenHeight;
	}

	#seen(scroller) {
		this.seenTop = scroller.scrollTop;
		this.seenHeight = scroller.scrollHeight;
	}

	/**
	 * A short message at the bottom right; `sticky` (a path, a link to copy) stays until its × is pressed. The
	 * engine's messages may carry terminal codes (/share's links): the window shows their text.
	 */
	toast(text, kind = "info", { sticky = false, action } = {}) {
		if (!text) return;
		const el = h("div", { class: `toast ${kind}${sticky ? " sticky" : ""}`, role: kind === "error" ? "alert" : "status" }, h("span", { class: "toast-text", text: stripAnsi(text) }));
		const remove = () => {
			el.remove();
			this.fitToasts();
		};
		// one action in the toast (the phone app's update download), which closes it.
		if (action)
			el.append(
				h("button", {
					type: "button",
					class: "ghost",
					text: action.label,
					onclick: () => {
						action.run();
						remove();
					},
				}),
			);
		if (sticky) el.append(h("button", { type: "button", class: "ghost icon toast-close", "aria-label": t("close"), text: "×", onclick: remove }));
		else setTimeout(remove, kind === "error" ? 10000 : 6000);
		$("toasts").append(el);
		this.fitToasts();
	}

	/**
	 * Toasts stay in the band between the top bar (or the open search) and what is open above the composer (a
	 * panel, else the composer), at its bottom: they never cover an interaction. The newest is at the bottom; the
	 * older ones that do not fit wait, hidden, until a panel closes and leaves room (a sticky path or link is not
	 * lost).
	 */
	fitToasts() {
		const box = $("toasts");
		const surface = $("surface");
		const below = surface.classList.contains("open") ? surface : $("composer");
		const floor = below.getBoundingClientRect().top - 8;
		box.style.bottom = `${Math.max(8, window.innerHeight - floor)}px`;
		const search = document.querySelector(".search:not([hidden])");
		const ceiling = (search ?? document.querySelector(".topbar"))?.getBoundingClientRect().bottom ?? 0;
		let used = 0;
		let full = false;
		for (const el of [...box.children].reverse()) {
			el.hidden = false;
			const height = el.offsetHeight;
			full ||= used > 0 && floor - used - height < ceiling + 8;
			el.hidden = full;
			if (!full) used += height + 6;
		}
	}

	closeWindow() {
		return invoke("close_window");
	}

	composerText() {
		return $("input").value;
	}

	/**
	 * The composer of `view`: the one on screen when it is active, else its kept draft. What a conversation's late
	 * answer writes goes to its own draft, never to the conversation the user switched to.
	 */
	composerOf(view = this.active) {
		return view === this.active ? $("input").value : (view?.draft ?? "");
	}

	setComposerText(text, view = this.active) {
		if (view !== this.active) {
			if (view) view.draft = text ?? "";
			return;
		}
		const input = $("input");
		input.value = text ?? "";
		this.#grow();
		input.focus();
	}

	/** The messages taken back from `view`'s queue, before what its composer holds. */
	#restoreQueued(view, queued) {
		this.setComposerText([...queued, this.composerOf(view)].filter((s) => s.trim()).join("\n\n"), view);
	}

	isTyping() {
		const el = document.activeElement;
		return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement;
	}

	// Size of one cell of the views, in pixels, from a probe set in the views' own font.
	cellSize() {
		const probe = $("view-probe");
		const rect = probe.getBoundingClientRect();
		const width = rect.width / probe.textContent.length;
		const height = Number.parseFloat(getComputedStyle(probe).lineHeight) || rect.height;
		return width > 0 && height > 0 ? { width, height } : { width: 8, height: 17 };
	}

	// The engine renders views at the size the window gives them: the column's width, and the rows that fit
	// in the interaction surface, whose height comes from the window alone (surface.js). Its colours are the
	// window's theme.
	viewSettings(view) {
		const cell = this.cellSize();
		const measure = $("view-measure");
		const style = getComputedStyle(measure);
		const inner = measure.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
		return {
			type: "set_views",
			nativeMenus: true,
			columns: Math.max(20, Math.floor(inner / cell.width)),
			rows: this.surface.rows(cell.height),
			theme: themeName(),
		};
	}

	async configureViews(view) {
		const settings = this.viewSettings(view);
		view.viewSettings = JSON.stringify(settings);
		await view.engine.request(settings).catch(() => {});
	}

	// After a resize or a change of appearance, open sessions re-render their views. A resize waits for
	// the next frame; a change of appearance goes now, ahead of any command typed after it, since a view
	// built with the old theme can keep its colours.
	#reconfigureViews({ now = false } = {}) {
		const apply = () => {
			for (const view of this.sessions) {
				const settings = JSON.stringify(this.viewSettings(view));
				if (view.ready && view.engine.alive && view.viewSettings !== settings) this.configureViews(view);
			}
		};
		if (now) return apply();
		if (this.viewsScheduled) return;
		this.viewsScheduled = true;
		requestAnimationFrame(() => {
			this.viewsScheduled = false;
			apply();
		});
	}

	/** Where the keyboard goes when an interaction closes, or a conversation comes back: the last one open, or the composer. */
	focusAfterInteraction(view) {
		if (this.active !== view) return;
		const last = view.interactions.entries.filter((entry) => !entry.closing).at(-1);
		if (last) last.panel.focus();
		else if (!$("composer").hidden) $("input").focus();
	}

	recordRender(ms, chars) {
		this.renderTimes.push([ms, chars]);
		if (this.renderTimes.length > 2000) this.renderTimes.shift();
	}

	confirmLink(url) {
		const dialog = $("link-dialog");
		$("link-url").textContent = url;
		dialog.returnValue = "";
		dialog.onclose = () => {
			if (dialog.returnValue !== "open") return;
			// On the phone, Android opens the link (MainActivity.kt): the PC is not where the user is looking.
			if (window.PrismAndroid?.openUrl) window.PrismAndroid.openUrl(url);
			else invoke("open_external", { url }).catch((error) => this.toast(String(error), "error"));
		};
		dialog.showModal();
	}

	// ---------------------------------------------------------------------------------------------
	// Composer

	// Enter on an empty composer does nothing, as in the terminal: it used to stop the run, so a habitual
	// Enter while a permission question waited aborted the whole turn. Stopping takes the Stop button or Esc.
	async submit({ fromKey = false, behavior } = {}) {
		this.completion.close();
		const view = this.active;
		const input = $("input");
		if (!view || !view.engine.alive || !view.ready) return;
		const text = input.value;
		const attachments = view.attachments ?? [];
		if (!text.trim() && !attachments.length) {
			if (view.streaming && !fromKey) await this.stop();
			// On the phone, with no Esc, the Stop button also cancels a running ! command (the terminal's order:
			// the reply first, then the command).
			else if (this.info?.remote && view.bash && !fromKey) await view.abortBash().catch((error) => this.toast(String(error?.message ?? error), "error"));
			return;
		}
		// The engine answers a command (or a ! command) only once it has run, which for a view is when it
		// closes: the composer empties now, as the terminal's editor does, and gets the text back if it was
		// not run. A command takes no attachments: they wait for the next message.
		const command = /^[/!]/.test(text.trim());
		if (command) {
			input.value = "";
			this.#grow();
		}
		const restore = () => {
			if (command && !this.composerOf(view)) this.setComposerText(text, view);
		};
		try {
			const sent = await view.prompt(text, { ...(behavior ? { behavior } : {}), ...(command ? {} : { attachments }) });
			if (sent === false) restore();
			else {
				if (!command) view.attachments = (view.attachments ?? []).filter((item) => !attachments.includes(item));
				if (text.trim()) view.remember(text);
				this.browsing = undefined;
				// Only the sent text: what was typed while the engine answered stays, in this conversation or another.
				if (!command && this.composerOf(view) === text) this.setComposerText("", view);
				if (view === this.active) this.followEnd();
			}
		} catch (error) {
			restore();
			this.toast(String(error?.message ?? error), "error");
		}
	}

	async stop() {
		const view = this.active;
		if (!view?.streaming) return;
		try {
			// As the terminal's Escape: the queued messages come back to the composer, then the reply stops.
			const queued = await view.dequeue();
			if (queued.length) this.#restoreQueued(view, queued);
			await view.abort();
		} catch (error) {
			this.toast(String(error?.message ?? error), "error");
		}
	}

	// The terminal editor's history: ↑ on the first line of an empty draft (or while browsing, or at its
	// start) shows the previous message sent in this conversation; ↓ on the last line goes back to the draft.
	#history(up) {
		const view = this.active;
		const input = $("input");
		const sent = view?.sent ?? [];
		const { value, selectionStart: start, selectionEnd: end } = input;
		if (start !== end || !sent.length) return false;
		const index = this.browsing?.index ?? -1;
		if (up) {
			const firstLine = !value.slice(0, start).includes("\n");
			if (!firstLine || !(value === "" || index > -1 || start === 0) || index + 1 >= sent.length) return false;
			this.browsing = { index: index + 1, draft: index === -1 ? value : this.browsing.draft };
			input.value = sent[index + 1];
			input.setSelectionRange(0, 0);
		} else {
			if (index === -1 || value.slice(end).includes("\n")) return false;
			const draft = this.browsing.draft;
			this.browsing = index - 1 === -1 ? undefined : { index: index - 1, draft };
			input.value = index - 1 === -1 ? draft : sent[index - 1];
			input.setSelectionRange(input.value.length, input.value.length);
		}
		this.#grow();
		return true;
	}

	// The terminal's paste key: copied files and a copied image (a screenshot) as attachments of the next message
	//. Text keeps the window's own paste. WebKitGTK does not always hand a
	// screenshot over (Ctrl+V did nothing): a paste without text, or the paste key without a paste event,
	// reads the system clipboard through the engine, as the terminal's paste key does.
	#paste(event) {
		this.pasted = true;
		const view = this.active;
		const data = event.clipboardData;
		if (!view?.ready || !data) return;
		const uris = (data.getData("text/uri-list") || "").split(/\r?\n/).filter((line) => line.startsWith("file://"));
		const image = [...data.items].find((item) => item.kind === "file" && item.type.startsWith("image/"));
		// On the phone, copied files are the phone's: the PC cannot attach them (pick.js reads files on the phone).
		if (uris.length && !this.info?.remote) {
			event.preventDefault();
			// Attached only if the system clipboard holds the same files: the page cannot attach a path it made up.
			// Otherwise (the clipboard cannot be read), the paths, as the terminal pasted them before.
			const paths = uris.map((uri) => decodeURIComponent(new URL(uri).pathname));
			this.#addAttachments(view, view.engine.request({ type: "clipboard_files", paths }), () => this.#insertPaths(view, paths));
			return;
		}
		// Copied files that are not images (a PDF from the phone's file manager) go to the PC to be attached (transfer.js).
		const others = this.info?.remote ? [...(data.files ?? [])].filter((file) => !file.type.startsWith("image/")) : [];
		if (others.length) {
			event.preventDefault();
			void this.#attachFromPhone(view, others);
			return;
		}
		if (image) {
			event.preventDefault();
			imageAttachment({ blob: image.getAsFile() })
				.then((item) => this.#addAttachment(view, item))
				.catch((error) => this.toast(String(error?.message ?? error), "error"));
			return;
		}
		if (data.getData("text/plain")) return;
		event.preventDefault();
		this.#pasteFromSystem(view);
	}

	// The paste key pressed: if the web view sends no paste event (nothing it can paste), the system clipboard.
	#pasteKey(view) {
		this.pasted = false;
		setTimeout(() => {
			if (!this.pasted && this.active === view) this.#pasteFromSystem(view);
		}, 300);
	}

	async #pasteFromSystem(view) {
		// On the phone the engine's system clipboard is the PC's, not the one the user pasted from.
		if (this.info?.remote) return;
		try {
			const image = await view.engine.request({ type: "clipboard_image" });
			if (image?.data) this.#addAttachment(view, await imageAttachment(image));
		} catch (error) {
			this.toast(String(error?.message ?? error), "error");
		}
	}

	// The attach button: files chosen in the system's picker, anywhere, attached by the engine (attach.rs).
	async #attach() {
		const view = this.active;
		if (!view?.ready) return;
		try {
			// On the phone, the files are the phone's: the page reads them, the engine on the PC could not.
			if (this.info?.remote) {
				await this.#attachFromPhone(view, await pickOnPhone());
				return;
			}
			const paths = await invoke("pick_files", { start: view.cwd });
			if (paths.length) await this.#addAttachments(view, view.engine.attachPicked(paths));
		} catch (error) {
			this.toast(String(error?.message ?? error), "error");
		}
		$("input").focus();
	}

	// Files of the phone, as `phoneAttachment` made them (or the Files of a paste): what the page can build itself is
	// attached at once; the rest is sent to the PC, which attaches it as it attaches a file the window's picker returned.
	async #attachFromPhone(view, chosen) {
		const items = await Promise.all(chosen.map((item) => (item instanceof File ? phoneAttachment(item) : item)));
		const sent = [];
		for (const item of items) {
			if (item.kind === "error") this.toast(item.error, "error");
			else if (item.kind === "upload") sent.push(item.file);
			else this.#addAttachment(view, item);
		}
		if (!sent.length) return;
		try {
			const paths = [];
			for (const file of sent) {
				this.toast(t("phoneSending", file.name));
				paths.push(await uploadToPc(file));
			}
			await this.#addAttachments(view, view.engine.attachPicked(paths));
		} catch (error) {
			this.toast(String(error?.message ?? error), "error");
		}
	}

	// The engine's answer for files: each an attachment, or a toast that says why it cannot be one.
	async #addAttachments(view, answer, none) {
		try {
			const { attachments } = await answer;
			if (!attachments.length) none?.();
			for (const item of attachments) {
				if (item.kind === "error") this.toast(item.error, "error");
				else this.#addAttachment(view, item);
			}
		} catch (error) {
			this.toast(String(error?.message ?? error), "error");
		}
	}

	#addAttachment(view, item) {
		view.attachments = [...(view.attachments ?? []), item];
		// A model without images gets a note in their place (pi-ai): said now, not after the message is sent.
		const input = view.state?.model?.input;
		if (item.kind === "image" && Array.isArray(input) && !input.includes("image")) this.toast(t("attachNoVision"), "warning");
		this.render();
	}

	#removeAttachment(view, index) {
		view.attachments = (view.attachments ?? []).filter((_, i) => i !== index);
		this.render();
		$("input").focus();
	}

	// The terminal's jump between prompts: the previous or next message of the user at the top of the view. The
	// transcript's entries are read, not the page, which holds only those around the view (transcript-list.js).
	#jumpToPrompt(direction) {
		const list = this.active?.list;
		const offsets = list?.offsets();
		if (!offsets) return;
		const prompts = list.entries.map((entry, index) => [entry, offsets[index]]).filter(([entry]) => entry.kind === "user");
		const target = direction < 0 ? prompts.findLast(([, offset]) => offset < -1) : prompts.find(([, offset]) => offset > 1);
		if (!target) return;
		this.stick = false;
		list.scrollToEntry(target[0], 0);
	}

	// Files dropped on the window (the host's drop event): attachments of the next message, as with the button.
	dropped(paths) {
		const view = this.active;
		if (!view?.ready || !paths.length) return;
		$("input").focus();
		this.#addAttachments(view, view.engine.attachPicked(paths));
	}

	#insertPaths(view, paths) {
		// In a ! command each path is one shell word, as in the terminal: `;`, `|` or `*` in a name stay its own.
		const bash = this.composerOf(view).trimStart().startsWith("!");
		const text = bash ? paths.map(shellQuote).join(" ") : paths.join("\n");
		// Pasted in a conversation the user has left since: at the end of its draft, not in the one on screen.
		if (view !== this.active) {
			const draft = view.draft ?? "";
			view.draft = draft && !/\s$/.test(draft) ? `${draft} ${text}` : `${draft}${text}`;
			return;
		}
		this.#insert(text);
	}

	// At the composer's cursor, apart from the words around it.
	#insert(text) {
		const input = $("input");
		const { selectionStart: start, selectionEnd: end, value } = input;
		const before = value[start - 1];
		const after = value[end];
		const lead = before && !/\s/.test(before) ? " " : "";
		const trail = after && !/\s/.test(after) ? " " : "";
		input.setRangeText(`${lead}${text}${trail}`, start, end, "end");
		this.#grow();
	}

	#grow() {
		const input = $("input");
		const scroller = $("scroller");
		// The welcome is read from its top, never pinned at its end (see transcript-list.js, reconcile).
		const atEnd = $("welcome").hidden && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
		// QA-006: a taller composer (Shift+Enter) takes room from the transcript; read at its end, the end stays in
		// view instead of sliding behind the composer. Read higher up, the lines shown stay where they are.
		if (atEnd) scroller.scrollTop = scroller.scrollHeight;
		this.render();
	}

	// ---------------------------------------------------------------------------------------------
	// Rendering

	render() {
		if (this.renderScheduled) return;
		this.renderScheduled = true;
		requestAnimationFrame(() => {
			this.renderScheduled = false;
			this.#render();
		});
	}

	/** "Link a phone": a button in the settings' Window section, and a step of the welcome until linked or put off. */
	async #offerPhoneLink() {
		const state = await phoneLinkState();
		if (!state) return;
		const open = () => {
			if ($("settings").open) $("settings").close();
			const view = this.active;
			if (view) view.interactions.run("phone-link", () => phoneLinkScreen(view)).catch((error) => this.toast(String(error?.message ?? error), "error"));
		};
		const host = $("settings-link");
		// The linked phones, listed here with a revoke button each; read again when the settings open and after a removal.
		const phones = h("div", { class: "settings-link-phones" });
		const drawPhones = (paired) =>
			phones.replaceChildren(
				h("h4", { class: "link-phone-heading", text: t("phoneLinkPhones") }),
				phonesList(paired, {
					onRevoke: (fingerprint) =>
						revokePhone(fingerprint)
							.catch((error) => this.toast(String(error?.message ?? error), "error"))
							.then(refreshPhones),
				}),
			);
		const refreshPhones = async () => {
			const latest = await phoneLinkState();
			if (latest) drawPhones(latest.paired ?? []);
		};
		drawPhones(state.paired ?? []);
		new MutationObserver(() => {
			if ($("settings").open) void refreshPhones();
		}).observe($("settings"), { attributes: true, attributeFilter: ["open"] });
		host.replaceChildren(
			h("h3", { class: "pair-heading", text: t("phoneLinkTitle") }),
			h("p", { class: "panel-text muted", text: t("phoneLinkSettingsHelp") }),
			phones,
			h("button", { type: "button", text: t("phoneLinkOpen"), onclick: open }),
		);
		host.hidden = false;
		const prefs = loadPrefs();
		if (state.paired.length > 0 || prefs.phoneLater) return;
		const step = $("welcome-phone");
		const appQr = await androidAppQr();
		step.replaceChildren(
			h("p", {}, h("strong", { text: t("phoneLinkWelcomeTitle") }), " ", t("phoneLinkWelcomeBody")),
			appQr && h("div", { class: "welcome-phone-app" }, h("img", { class: "link-phone-qr small", alt: t("phoneAppQrAlt"), src: appQr }), h("p", { class: "muted", text: t("phoneAppWelcome") })),
			h(
				"div",
				{ class: "link-phone-row" },
				h("button", { type: "button", text: t("phoneLinkOpen"), onclick: () => {
					step.hidden = true;
					open();
				} }),
				h("button", { type: "button", class: "ghost", text: t("phoneLinkLater"), onclick: () => {
					savePrefs({ ...loadPrefs(), phoneLater: true });
					step.hidden = true;
				} }),
			),
		);
		step.hidden = false;
	}

	/** Tells the conversation's engine whether the window is in front (rpc-builtins.ts, window_focus). */
	reportFocus(view) {
		if (!view.ready || !view.engine.alive) return;
		view.engine.request({ type: "window_focus", focused: document.hasFocus() }).catch(() => {});
	}

	#render() {
		this.inbox.update();
		const view = this.active;
		const state = view?.state;
		const ready = Boolean(view?.engine.alive && state);
		// Without any configured model the engine still reports a placeholder ("unknown"): the list of
		// available models is what tells whether one can be used.
		const hasModel = Boolean(state?.model) && (view?.models.length ?? 0) > 0;
		const empty = !view || view.el.childElementCount === 0;
		// The engine of this view is still starting (spawn, then its opening requests).
		const starting = Boolean(view && !view.error && !view.exit && !view.ready);

		const title = $("session-title");
		title.textContent = view ? view.title : "";
		title.disabled = !ready;
		title.title = ready ? t("renameHelp") : "";
		invoke("set_title", { title: view && !empty ? `${view.title} — Prism` : "Prism" }).catch(() => {});
		// The magnifier says its keyboard shortcut, as the terminal binds it.
		const searchKey = view?.keys?.bindings?.["tui.altScreen.search"]?.keys[0];
		const searchButton = document.getElementById("search-button");
		if (searchButton) searchButton.title = searchKey ? `${t("searchTranscript")} (${keyText(searchKey)})` : t("searchTranscript");

		// Sidebar: the conversations' view (the search view finds the others); the other views follow the conversation
		// on screen.
		const openRows = [];
		for (const s of this.sessions) {
			// Open on a phone and not running here: the phone's (its engine runs for it).
			const mark = s.suspended && s.onPhone
				? "phone"
				: s.suspended
				? "asleep"
				: s.exit || s.error
					? "error"
					: s.dialogs.size
						? "empty"
						: s.streaming
							? "half"
							: "full";
			const item = h(
				"li",
				{ class: s === this.active ? "current" : "" },
				h(
					"button",
					{ type: "button", class: "session-link", "aria-current": s === this.active ? "true" : undefined, onclick: () => this.activate(s) },
					h("span", { class: `state ${mark}`, "aria-hidden": "true", title: mark === "phone" ? t("openOnPhone") : s.suspended ? t("asleep") : undefined }),
					h("span", { class: "label", text: s.title }),
					...inboxDot(this.inbox.kindOf(s)),
				),
				h("button", {
					type: "button",
					class: "ghost icon close",
					"aria-label": `${t("closeSession")} ${s.title}`,
					title: t("closeSession"),
					text: "×",
					onclick: () => this.closeSession(s),
				}),
			);
			openRows.push(item);
		}
		show($("open-list"), openRows, this.sessions);
		const historyRows = [];
		const openPaths = new Set(this.sessions.map((s) => s.path));
		const past = (this.history ?? []).filter((s) => !openPaths.has(s.path));
		if (past.length === 0 && this.history) historyRows.push(h("li", { class: "muted", text: t("noHistory") }));
		for (const s of past.slice(0, 200)) {
			const when = new Date(s.modified);
			historyRows.push(
				h(
					"li",
					{},
					h(
						"button",
						{ type: "button", class: "session-link", title: s.path, onclick: () => this.openSession(s.path) },
						h("span", { class: "label", text: s.name || s.firstMessage || t("untitled") }),
						h("span", { class: "meta", text: when.toLocaleDateString(document.documentElement.lang, { day: "numeric", month: "short" }) }),
					),
				),
			);
		}

		show($("history-list"), historyRows);
		this.sideMenu.update();

		// Model and reasoning: what the turn will use, each a button that opens its picker.
		const models = view?.models ?? [];
		const model = state?.model;
		$("model-label").textContent = model ? model.name || model.id : t("noModel");
		$("model-meta").textContent = model ? model.provider : "";
		const modelButton = $("model-button");
		modelButton.disabled = !ready || models.length === 0 || view.streaming;
		// While the engine starts, no "No model": the model is not known yet, not missing.
		modelButton.hidden = !ready && !model;
		modelButton.title = this.withKey(t("modelHelp"), "app.model.select");
		const levels = view?.levels ?? [];
		const level = state?.thinkingLevel ?? "";
		$("thinking-label").textContent = level ? levelName(level) : "";
		const thinkingButton = $("thinking-button");
		thinkingButton.hidden = levels.length <= 1;
		thinkingButton.disabled = !ready || view.streaming;
		thinkingButton.title = this.withKey(t("thinkingHelp"), "app.thinking.cycle");
		modelButton.setAttribute("aria-expanded", String(Boolean(view?.interactions.of("model").length)));
		thinkingButton.setAttribute("aria-expanded", String(Boolean(view?.interactions.of("thinking").length)));
		this.#modeSwitches(view, ready);

		// Welcome and empty states
		// A new conversation shows its welcome at once, while its engine starts: switching never goes
		// through a blank or "starting" screen. A reopened session waits for its transcript.
		const showWelcome = empty && (view?.ready ? hasModel : starting && !view.initialPath);
		$("welcome").hidden = !showWelcome;
		// A saved conversation that is opening says so, under its own name: it is never shown as a new one.
		$("loading").hidden = !(starting && view.initialPath && empty);
		$("empty-model").hidden = !(view?.ready && !hasModel);
		this.scene.setVisible(showWelcome);
		$("backdrop").hidden = themeName() !== "prism";
		document.body.dataset.working = String(Boolean(view?.streaming));

		// Banners: engine failure or end
		if (view?.error) this.#banner(t("engineFailed"), view.error, view);
		else if (view?.exit) {
			const how = view.exit.signal ? `signal ${view.exit.signal}` : `code ${view.exit.code ?? "?"}`;
			this.#banner(t("engineStopped"), t("engineStoppedBody", how), view, view.exit.stderr);
			// With no conversation open, an engine that cannot start at all stays said (it was hidden by the next render).
		} else if (!view && this.info.engineError) this.#banner(t("engineFailed"), this.info.engineError);
		else $("banner").hidden = true;

		// Composer
		const input = $("input");
		const send = $("send");
		// While the engine starts, the composer already accepts text; sending waits for the engine.
		const canType = ready && hasModel;
		input.disabled = !canType && !starting;
		$("hint").textContent = starting ? t("engineStarting") : "";
		send.title = t("sendHelp");
		$("composer").dataset.starting = starting ? "true" : "false";
		const placeholder = view?.streaming ? t("composerPlaceholderBusy") : t("composerPlaceholder");
		if (input.placeholder !== placeholder) {
			input.placeholder = placeholder;
			// An empty composer is as tall as its placeholder: the longer one shown while Prism works wraps on a
			// narrow window or a phone, and was cut at the height the short one had.
			if (!input.value) this.#grow();
		}
		const attachments = view?.attachments ?? [];
		const nothingToSend = input.value.trim() === "" && !attachments.length;
		const stopsBash = Boolean(this.info?.remote && view?.bash && !view.streaming);
		const stopMode = Boolean(view?.streaming || stopsBash) && nothingToSend;
		send.textContent = stopMode ? (view.stopping && !stopsBash ? t("stopping") : t("stop")) : t("send");
		send.classList.toggle("primary", !stopMode);
		send.disabled = !canType || (stopMode ? Boolean(view.stopping && !stopsBash) : nothingToSend);
		const attach = $("attach-button");
		attach.disabled = !canType;
		attach.title = t("attachHelp");
		attach.setAttribute("aria-label", t("attach"));
		const chips = $("attachments");
		// Rebuilt only when the list changed: each chip of an image holds its whole picture.
		if (chips.list !== attachments) {
			chips.list = attachments;
			clear(chips);
			chips.append(...draftChips(attachments, (i) => this.#removeAttachment(view, i)));
			chips.hidden = attachments.length === 0;
		}
		$("composer").dataset.busy = view?.streaming ? "true" : "false";

		// The interaction surface: the open panels, views and questions of the conversation on screen. A view
		// in the editor's place (not an overlay) replaces the composer while it is open, as in the terminal.
		this.surface.place(view);

		// Widgets written by extensions (status panels), after the state of a resumed, interrupted session
		const widgets = $("widgets");
		const stopped = view?.sessionState && h("section", { class: "widget session-state", "data-key": "session-state", "aria-label": t("inspector.state") }, ...sessionStateBody(view.sessionState));
		show(widgets, [stopped, this.#queueTray(view), ...[...(view?.widgets ?? [])].map(([key, lines]) => h("pre", { class: "widget", "data-key": key, text: lines.join("\n") }))].filter(Boolean));
		widgets.hidden = widgets.childElementCount === 0;

		// Status bar
		const bar = document.createDocumentFragment();
		const cwd = view?.cwd ?? this.info?.cwd ?? "";
		const home = this.info?.home;
		bar.append(h("button", { type: "button", class: "cwd ghost", title: `${t("chooseProject")}\n${cwd}`, text: home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd, disabled: !ready, onclick: () => this.chooseProject() }));
		$("info-folder").textContent = cwd;
		// The terminal's footer buttons after the statuses: the pinned commands, then more….
		const run = (work) =>
			Promise.resolve()
				.then(work)
				.catch((error) => this.toast(String(error?.message ?? error), "error"));
		const usable = view?.ready && view.engine.alive;
		for (const [key, text] of view?.statuses ?? []) bar.append(...statusChips(key, text, usable && ((line) => run(() => view.prompt(line, { toggle: true })))));
		if (usable) {
			for (const [index, name] of (view.pinned ?? []).entries()) {
				const pin = h("button", { type: "button", class: "footer-action", dataset: { pinned: "" }, text: `/${name}`, onclick: () => run(() => view.prompt(`/${name}`)) });
				// As the last fit left it, so that an unchanged footer is not rebuilt (fitFooter).
				pin.hidden = index >= this.footerFit;
				bar.append(pin);
			}
			bar.append(h("button", { type: "button", class: "footer-action", text: t("more"), title: t("moreHelp"), onclick: () => run(() => view.footerMenu("more_menu")) }));
		}
		const stats = view?.stats;
		const usage = [];
		if (stats?.tokens?.total) usage.push(t("tokens", formatNumber(stats.tokens.total)));
		if (stats?.cost) usage.push(formatCost(stats.cost));
		const context =
			stats?.contextUsage?.percent != null &&
			h("button", {
				type: "button",
				class: "context-gauge",
				style: `--fill: ${Math.min(100, Math.round(stats.contextUsage.percent))}%`,
				"data-high": stats.contextUsage.percent > 80,
				text: t("context", Math.round(stats.contextUsage.percent)),
				title: t("contextHelp"),
				disabled: !usable,
				// the gauge opens /context, which also offers to compact.
				onclick: () => run(() => view.prompt("/context")),
			});
		if (usage.length || context) bar.append(h("span", { class: "usage" }, usage.join("  ") + (context && usage.length ? "  " : ""), context || undefined));
		show($("statusbar"), [...bar.children], [view]);
		this.fitFooter();
	}

	/**
	 * The pinned commands that do not fit in the footer stay in more…, as in the terminal: the last ones give way
	 * first (at 560 px a pinned /help pushed the context gauge out of the window).
	 */
	fitFooter() {
		const bar = $("statusbar");
		const pinned = [...bar.querySelectorAll(".footer-action[data-pinned]")];
		for (const el of pinned) el.hidden = false;
		let shown = pinned.length;
		while (shown > 0 && bar.scrollWidth > bar.clientWidth) pinned[--shown].hidden = true;
		this.footerFit = shown;
	}

	/** The footer's pinned commands are a global setting: every session reads them again. */
	async footerChanged() {
		await Promise.all(this.sessions.filter((view) => view.ready && view.engine.alive).map((view) => view.refreshFooter()));
		this.render();
	}

	#banner(title, body, view, details, kind = "error") {
		const banner = $("banner");
		clear(banner);
		banner.className = `banner ${kind}`;
		banner.append(h("strong", { text: title }));
		if (body) banner.append(h("span", { text: body }));
		if (details) banner.append(h("details", {}, h("summary", { text: t("errorPrefix") }), h("pre", { text: details })));
		if (view) {
			if (view.path)
				banner.append(h("button", { type: "button", class: "primary", text: t("reopen"), onclick: () => this.reopen(view) }));
			banner.append(h("button", { type: "button", text: t("closeSession"), onclick: () => this.closeSession(view) }));
		}
		banner.hidden = false;
	}

	// ---------------------------------------------------------------------------------------------
	// Preferences

	// The engine's texts and the window's in one language: the window's choice, or else the terminal's
	// `language` setting as the engine resolves it (set_language).
	async engineLanguage(view) {
		const data = await view.engine.request({ type: "set_language", language: this.prefs.language }).catch(() => undefined);
		return data?.language;
	}

	/** The language of the active conversation's engine, which the window's "as the terminal" follows. */
	languageShown(view) {
		if (this.active !== view || !view.language || view.language === this.shownLanguage) return;
		this.shownLanguage = view.language;
		this.#applyPrefs();
	}

	#applyPrefs() {
		setThemePreference(this.prefs.theme);
		setLanguage(this.prefs.language, this.shownLanguage ?? this.info?.locale);
		const animate = this.prefs.animations === "on" || (this.prefs.animations === "system" && !this.reducedMotion.matches);
		document.documentElement.dataset.motion = animate ? "on" : "off";
		this.scene.setAnimated(animate);
		for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
		for (const el of document.querySelectorAll("[data-i18n-label]")) el.setAttribute("aria-label", t(el.dataset.i18nLabel));
		for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
		// The rail's icons have no text: their name is also their tooltip.
		for (const el of document.querySelectorAll(".rail-button")) el.title = el.getAttribute("aria-label");
		this.sideMenu?.languageChanged();
		this.redrawLink?.();
		$("pref-theme").value = this.prefs.theme;
		$("pref-language").value = this.prefs.language;
		$("pref-animations").value = this.prefs.animations;
		$("info-folder").textContent = this.info?.cwd ?? "";
		$("info-version").textContent = this.info?.version ?? "";
		this.render();
	}

	async #languageChanged() {
		await Promise.all(
			this.sessions
				.filter((view) => view.ready && view.engine.alive)
				.map(async (view) => {
					view.language = await this.engineLanguage(view);
					// What was worded in the old language: commands' and keys' descriptions, then the transcript's
					// labels and turn summaries, rebuilt unless a reply or a question is under way.
					await view.refreshResources();
					if (!view.streaming && view.interactions.entries.length === 0 && view.dialogs.size === 0) await view.reload();
				}),
		);
		this.shownLanguage = undefined;
		if (this.active?.language) this.languageShown(this.active);
		else this.#applyPrefs();
	}

	/**
	 * The terminal's Plan, Goal and Files switches, shown when their module has its command: Plan and Goal on
	 * (● in ink) as their status says, each with its key. A click runs what the key runs.
	 */
	#modeSwitches(view, ready) {
		const el = $("mode-switches");
		const has = (name) => view?.commands?.some((c) => c.name === name && c.source === "extension");
		const firstKey = (id) => view?.keys?.bindings?.[id]?.keys?.[0];
		const plan = view?.statuses.get("plan-mode");
		const goal = view?.statuses.get("goal");
		const run = (work) =>
			Promise.resolve()
				.then(work)
				.catch((error) => this.toast(String(error?.message ?? error), "error"));
		const entries = [
			has("plan") && {
				name: "plan",
				// The engine's words for "on", in both languages, as the terminal reads them.
				on: (view.keys?.planOn ?? []).includes(plan),
				key: view.keys?.planKey,
				work: () => view.togglePlan(),
			},
			has("goal") && {
				name: "goal",
				// The engine's words for a finished goal, in both languages.
				on: goal !== undefined && !(view.keys?.goalDone ?? ["complete"]).includes(goal),
				key: firstKey("app.goal.menu"),
				work: () => view.prompt("/goal", { toggle: true }),
			},
			has("files") && { name: "files", key: firstKey("app.files.browse"), work: () => view.prompt("/files", { toggle: true }) },
		].filter(Boolean);
		const switches = entries.map((entry) =>
				h(
					"button",
					{
						type: "button",
						class: "mode-switch",
						dataset: { mode: entry.name },
						"aria-pressed": entry.on === undefined ? undefined : String(entry.on),
						title: entry.key ? `${t(entry.name)} (${keyText(entry.key)})` : t(entry.name),
						disabled: !ready,
						onclick: () => run(entry.work),
					},
					entry.on === undefined ? undefined : h("span", { class: "dot", "aria-hidden": "true", text: "●" }),
					h("span", { class: "label", text: t(entry.name) }),
					entry.key ? h("kbd", { text: keyText(entry.key) }) : undefined,
				),
		);
		show(el, switches, [view]);
		el.hidden = entries.length === 0;
	}

	// A key of the terminal on the active conversation; true when it was used.
	#terminalKey(event) {
		const view = this.active;
		if (!view?.ready || !view.keys) return false;
		const input = $("input");
		const bindings = view.keys.bindings ?? {};
		const commandKeys = Object.keys(bindings).filter((id) => bindings[id].command);
		const found = boundAction(view.keys, [...KEYS, ...commandKeys], event);
		if (!found) return false;
		const run = (work) =>
			Promise.resolve()
				.then(work)
				.catch((error) => this.toast(String(error?.message ?? error), "error"));
		if (found.shortcut) {
			run(() => view.runShortcut(found.shortcut.key));
			return true;
		}
		const { id, binding } = found;
		if (COMPOSER_KEYS.includes(id) && document.activeElement !== input) return false;
		if (binding.command) {
			// As in the terminal, the key does nothing when the module that has the command is off.
			if (view.commands.some((c) => c.name === binding.command)) run(() => view.prompt(`/${binding.command}`, { toggle: true }));
			return true;
		}
		switch (id) {
			case "app.panel.close": {
				const entry = view.interactions.entries.findLast((entry) => !entry.closing);
				if (!entry || !entry.panel.el.contains(event.target) || event.target.closest("input, textarea, select, button, a, [contenteditable='true'], [role='button'], [role='checkbox']")) return false;
				entry.panel.cancel();
				return true;
			}
			case "app.interrupt": {
				// The terminal's order: the reply first, then a running ! command.
				if (view.streaming) this.stop();
				else if (view.bash) run(() => view.abortBash());
				else if (document.activeElement !== input) return false;
				// Then the editor's own: a ! command is dropped, and twice on an empty composer opens /tree or
				// /fork (doubleEscapeAction).
				else if (input.value.trimStart().startsWith("!")) this.setComposerText("");
				else {
					const action = view.keys.doubleEscapeAction;
					if (input.value.trim() || !action || action === "none") return false;
					const now = Date.now();
					if (now - this.lastEscape >= 500) {
						this.lastEscape = now;
						return false;
					}
					this.lastEscape = 0;
					run(() => builtin(action)(view));
				}
				return true;
			}
			case "tui.altScreen.search":
				this.search.toggle();
				return true;
			case "tui.altScreen.previousPrompt":
			case "tui.altScreen.nextPrompt":
				this.#jumpToPrompt(id === "tui.altScreen.previousPrompt" ? -1 : 1);
				return true;
			case "app.message.followUp":
				this.submit({ fromKey: true, behavior: "followUp" });
				return true;
			case "app.message.dequeue":
				run(async () => {
					const queued = await view.dequeue();
					if (!queued.length) return this.toast(t("nothingQueued"));
					this.#restoreQueued(view, queued);
					this.toast(t("restoredQueued", queued.length));
				});
				return true;
			case "app.thinking.cycle":
				run(async () => {
					const level = await view.cycleThinking();
					this.toast(level ? t("thinkingLevelIs", levelName(level)) : t("thinkingUnsupported"));
				});
				return true;
			case "app.model.cycleForward":
			case "app.model.cycleBackward":
				run(async () => {
					await view.cycleModel(id === "app.model.cycleBackward" ? "backward" : "forward");
					if (view.state?.model) this.toast(t("modelIs", view.state.model.name ?? view.state.model.id));
				});
				return true;
			case "app.model.select":
				this.#openPicker("model");
				return true;
			case "app.tools.expand":
				view.toggleTools();
				this.toast(t(view.toolsExpanded ? "toolsExpanded" : "toolsCollapsed"));
				return true;
			case "app.thinking.toggle":
				view.toggleThinking();
				return true;
			case "app.message.copy":
				// "Copy selection or last assistant message": a selection keeps the window's copy (or cut).
				if (String(window.getSelection()) || input.selectionStart !== input.selectionEnd) return false;
				run(() => builtin("copy")(view));
				return true;
			case "app.session.new":
				this.openSession(undefined);
				return true;
			case "app.session.fork":
				run(() => builtin("fork")(view));
				return true;
			case "app.session.resume":
				run(() => builtin("resume")(view));
				return true;
			case "app.session.tree":
				run(() => builtin("tree")(view));
				return true;
		}
		return false;
	}

	#bind() {
		const input = $("input");
		$("composer").addEventListener("submit", (event) => {
			event.preventDefault();
			this.submit();
		});
		this.search = new TranscriptSearch(this);
		$("search-button").addEventListener("click", () => this.search.toggle());
		this.completion = new Completion(this, input, $("completion"));
		// A click beside the interaction surface closes what the user opened there. Buttons and fields are left to
		// themselves: a command's own button toggles it, and closing first would open it again.
		document.addEventListener(
			"pointerdown",
			(event) => {
				const target = event.target;
				if (event.button !== 0 || !(target instanceof Element)) return;
				if (target.closest("#surface, #completion, dialog, #toasts, button, a, select, input, label, [role='button']")) return;
				this.active?.interactions.dismissOpened();
			},
			true,
		);
		input.addEventListener("input", (event) => {
			this.browsing = undefined; // an edit leaves the history, as in the terminal's editor
			this.#grow();
			this.completion.edited(event);
		});
		input.addEventListener("keydown", (event) => {
			if (this.completion.key(event)) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			// Enter with a modifier is a key of the terminal (Alt+Enter: follow-up), handled with the others.
			const modified = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
			if (event.key === "Enter" && !modified && !event.isComposing) {
				event.preventDefault();
				this.submit({ fromKey: true });
			}
			if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !modified && this.#history(event.key === "ArrowUp"))
				event.preventDefault();
			const view = this.active;
			const paste = view?.keys?.bindings?.["app.clipboard.pasteImage"];
			if (view?.ready && paste?.keys.some((key) => matches(event, key))) this.#pasteKey(view);
		});
		input.addEventListener("paste", (event) => this.#paste(event));
		$("attach-button").addEventListener("click", () => this.#attach());
		$("scroller").addEventListener("scroll", () => {
			const s = $("scroller");
			const own = this.ownScroll !== undefined && Math.abs(s.scrollTop - this.ownScroll) < 0.5;
			this.ownScroll = undefined;
			// The transcript's own move (transcript-list.js) is not the reader's: following stays as it was.
			if (!own) {
				this.stick = !this.#readerScrolledUp() && s.scrollHeight - s.scrollTop - s.clientHeight < 48;
				this.#seen(s);
			}
			this.active?.list.schedule();
		});
		// A taller or shorter view (a panel, the composer) has room for more or fewer of the transcript's entries.
		new ResizeObserver(() => this.active?.list.schedule()).observe($("scroller"));
		$("new-session").addEventListener("click", () => this.openSession(undefined));
		$("choose-project").addEventListener("click", () => this.chooseProject());
		// Narrow windows: the sidebar is an overlay; a click beside it closes it.
		document.querySelector(".main").addEventListener("pointerdown", (event) => {
			if (document.body.classList.contains("sidebar-open") && !$("toggle-sidebar").contains(event.target)) {
				document.body.classList.remove("sidebar-open");
				$("toggle-sidebar").setAttribute("aria-expanded", "false");
			}
		});
		$("settings-button").addEventListener("click", () => this.settingsDialog.open());
		$("toggle-sidebar").addEventListener("click", () => this.sideMenu.fold(!this.sideMenu.shown));
		$("session-title").addEventListener("click", () => this.editTitle());
		$("model-button").addEventListener("click", () => this.#openPicker("model"));
		$("thinking-button").addEventListener("click", () => this.#openPicker("thinking"));
		for (const [id, key] of [
			["pref-theme", "theme"],
			["pref-language", "language"],
			["pref-animations", "animations"],
		]) {
			$(id).addEventListener("change", (event) => {
				this.prefs[key] = event.target.value;
				savePrefs(this.prefs);
				this.#applyPrefs();
				if (key === "language") this.#languageChanged();
				this.#reconfigureViews({ now: true });
			});
		}
		this.reducedMotion.addEventListener("change", () => this.#applyPrefs());
		window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
			this.render();
			this.#reconfigureViews({ now: true });
		});
		// The window's size, never the transcript's: the surface changes the transcript's height (surface.js).
		new ResizeObserver(() => {
			this.surface.resize();
			this.#reconfigureViews();
			this.fitFooter();
		}).observe(document.querySelector(".main"));
		// A panel opening or closing moves the floor of the toasts' band.
		const toasts = new ResizeObserver(() => this.fitToasts());
		toasts.observe($("surface"));
		toasts.observe($("composer"));
		document.addEventListener("keydown", (event) => {
			if (document.querySelector("dialog[open]") || event.defaultPrevented || event.isComposing) return;
			if (this.#terminalKey(event)) {
				event.preventDefault();
				return;
			}
			const mod = event.ctrlKey || event.metaKey;
			if (mod && event.key.toLowerCase() === "n") {
				event.preventDefault();
				this.openSession(undefined);
			} else if (mod && event.key === ",") {
				event.preventDefault();
				this.settingsDialog.open();
			}
		});
		window.addEventListener("beforeunload", () => {
			for (const s of this.sessions) s.engine.stop();
		});
	}

	/**
	 * the messages waiting for the reply, above the composer, each with when it
	 * goes (at the next step, or after the reply), and a button that takes them back to edit, as the terminal's key.
	 */
	#queueTray(view) {
		const { steering = [], followUp = [] } = view?.queueParts ?? {};
		if (steering.length + followUp.length === 0) return undefined;
		const item = (text, kind) =>
			h("li", { class: "queue-item", dataset: { kind } }, h("span", { class: "queue-kind", text: t(kind === "steer" ? "queueSteer" : "queueFollowUp") }), h("span", { class: "queue-text", text }));
		const edit = h("button", {
			type: "button",
			class: "ghost small",
			text: t("queueEdit"),
			title: t("queueEditHelp"),
			onclick: async () => {
				const queued = await view.dequeue().catch(() => []);
				if (queued.length) this.#restoreQueued(view, queued);
				if (view === this.active) $("input").focus();
			},
		});
		return h(
			"section",
			{ class: "widget queue-tray", "data-key": "queue", "aria-label": t("queueTitle", steering.length + followUp.length) },
			h("div", { class: "queue-head" }, h("span", { class: "queue-title", text: t("queueTitle", steering.length + followUp.length) }), edit),
			h("ul", { class: "queue-list" }, ...steering.map((text) => item(text, "steer")), ...followUp.map((text) => item(text, "followUp"))),
		);
	}

	chooseProject() {
		const view = this.active;
		if (!view?.ready) return;
		view.interactions.run("project", () => projectScreen(view), { toggle: true }).catch((error) => this.toast(String(error?.message ?? error), "error"));
	}
}

// The statuses the terminal's footer makes clickable (fork/prism/footer.ts): the permission mode opens /perm,
// the init status runs /init. Their text is the engine's ("perm: ask · sandbox"), parsed as the terminal does,
// and worded here in the window's language. Other statuses are shown as they are written.
const PERM_STATUS = "permissions";
const INIT_STATUS = "project-continuity";
const BACKGROUND_STATUS = "background";
const AGENTS_STATUS = "agents";

/** The footer's elements for one status; `open(line)` runs a command, or is false when the engine cannot. */
function statusChips(key, text, open) {
	const button = (cls, label, title, line, data = {}) =>
		h("button", {
			type: "button",
			class: `status-chip ext-status ${cls}`,
			"data-key": key,
			dataset: data,
			text: label,
			title,
			disabled: !open,
			onclick: () => open?.(line),
		});
	const perm = key === PERM_STATUS ? /(?:^|\s)perm: (\w+)(.*)$/.exec(text) : null;
	if (perm) {
		const [, mode, rest] = perm;
		const name = t(`perm.${mode}`) === `perm.${mode}` ? mode : t(`perm.${mode}`);
		const shown = rest.includes("(read-only)") ? `${name} (${t("readOnly")})` : name;
		const chips = [button("perm", t("permChip", shown), t("permHelp", shown), "/perm", { mode })];
		if (rest.includes("sandbox not working")) chips.push(button("sandbox broken", t("sandboxBroken"), t("sandboxHelp"), "/sandbox"));
		else if (rest.includes("sandbox")) chips.push(button("sandbox", t("sandboxChip"), t("sandboxHelp"), "/sandbox"));
		return chips;
	}
	if (key === INIT_STATUS) return [button("init", t("initChip"), t("initHelp"), "/init")];
	// the running background tasks open their list.
	if (key === BACKGROUND_STATUS) return [button("background", text, t("backgroundHelp"), "/bg")];
	// the agents running in the background open /agents, where one can be stopped.
	if (key === AGENTS_STATUS) return [button("agents", text, t("agentsRunningHelp"), "/agents")];
	return [h("span", { class: "ext-status", "data-key": key, text, title: text })];
}

/** A reasoning level in the window's language ("medium" → "moyenne"), or as the engine names it. */
function levelName(level) {
	const name = t(`level.${level}`);
	return name === `level.${level}` ? level : name;
}

/** What tells a model apart in the picker: its id when the name hides it, context, reasoning, images. */
function modelFacts(model) {
	const tokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
	return [
		model.name && model.name !== model.id ? model.id : undefined,
		model.contextWindow ? t("modelContext", tokens(model.contextWindow)) : undefined,
		model.reasoning ? t("modelReasoning") : undefined,
		Array.isArray(model.input) && model.input.includes("image") ? t("modelImages") : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

const app = new App();
window.prismApp = app;
app.init()
	.then(() => runDrive(app))
	.catch((error) => {
	document.body.append(h("pre", { class: "fatal", text: String(error?.stack ?? error) }));
});

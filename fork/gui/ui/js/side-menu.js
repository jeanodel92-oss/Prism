// The side menu: a rail of icons, each opening its view
// in the panel beside it. The conversations' view is drawn by app.js; this module switches views, folds the panel and
// draws the views that are its own. Each view reads the conversation on screen: its engine lists and searches.

import { agentTranscriptScreen } from "./agent-transcript-screen.js";
import { Segmented } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";
import { scheduleScreen } from "./schedule-screen.js";

const $ = (id) => document.getElementById(id);
const SHOWN = 100;
const LOGS_SHOWN = 60;
const narrow = () => window.matchMedia("(max-width: 760px)").matches;
const has = (view, command) => Boolean(view?.commands?.some((entry) => entry.name === command));

// When an icon shows: the scheduled tasks and the memory when their module is on, the sub-agents when
// the conversation has run one, the logs in the advanced display only. Chat and search always. The trace, split from
// the logs by the maintainer on 2026-11-12, shows with them.
const VISIBLE = {
	schedule: (view) => has(view, "schedule"),
	agents: (view, menu) => has(view, "agents") && menu.agents.view === view && menu.agents.runs.length > 0,
	memory: (view) => has(view, "memory"),
	trace: (view) => view?.display?.interfaceMode === "advanced",
	logs: (view) => view?.display?.interfaceMode === "advanced",
};

/** Whether `text` holds every word of `filter`, ignoring case: the chat view's filter. */
export function matchesFilter(filter, text) {
	const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
	const haystack = text.toLowerCase();
	return words.every((word) => haystack.includes(word));
}

export class SideMenu {
	constructor(app) {
		this.app = app;
		this.current = "chat";
		this.search = { scope: "here", sessions: [], excerpts: new Map(), loaded: undefined, timer: undefined, failed: "", searches: 0 };
		for (const button of document.querySelectorAll(".rail-button[data-view]"))
			button.addEventListener("click", () => this.choose(button.dataset.view));
		$("side-search").addEventListener("input", () => {
			this.#drawSearch();
			clearTimeout(this.search.timer);
			this.search.timer = setTimeout(() => this.#findInText(), 250);
		});
		this.scope = new Segmented({
			label: t("viewSearch"),
			value: "here",
			options: [
				{ value: "here", label: t("sessionsHere") },
				{ value: "all", label: t("sessionsAll") },
			],
			onChange: (value) => {
				this.search.scope = value;
				this.search.loaded = undefined;
				this.#loadSearch();
			},
		});
		$("side-search-scope").append(this.scope.el);
		$("side-schedule-new").addEventListener("click", () => this.#openSchedule({ create: true }));
		$("side-trace-open").addEventListener("click", () => this.#runCommand("/trace"));
		// fork: an icon that runs its command rather than opening a view, shown with its module.
		for (const button of document.querySelectorAll(".rail-button[data-command]"))
			button.addEventListener("click", () => this.#runCommand(`/${button.dataset.command}`));
		this.loaded = { view: undefined, stats: undefined, name: undefined };
		// The sub-agents of the conversation on screen: read after each turn and each change of their status.
		this.agents = { view: undefined, key: undefined, runs: [] };
		this.#mark();
	}

	/** Whether the panel is on screen: unfolded beside the rail, or the narrow window's overlay open. */
	get shown() {
		return narrow() ? document.body.classList.contains("sidebar-open") : !document.body.classList.contains("sidebar-collapsed");
	}

	/** Shows or folds the panel; the rail stays (a narrow window's overlay holds both). */
	fold(shown) {
		if (narrow()) document.body.classList.toggle("sidebar-open", shown);
		else document.body.classList.toggle("sidebar-collapsed", !shown);
		$("toggle-sidebar").setAttribute("aria-expanded", String(shown));
	}

	/** A click on an icon: its view in the panel; on the icon of the view shown, the panel folds. */
	choose(name) {
		if (name === this.current && this.shown) this.fold(false);
		else this.show(name);
	}

	/** Shows the panel on that view. */
	show(name) {
		this.current = name;
		this.#mark();
		this.fold(true);
		if (name === "search") {
			this.#loadSearch();
			$("side-search").focus();
		} else this.#loadView(true);
	}

	#mark() {
		for (const section of document.querySelectorAll(".side-view")) section.hidden = section.dataset.view !== this.current;
		for (const button of document.querySelectorAll(".rail-button[data-view]")) {
			const on = button.dataset.view === this.current;
			button.classList.toggle("current", on);
			button.setAttribute("aria-pressed", String(on));
		}
	}

	/** The conversation on screen changed: the icons follow its modules and display, a view that follows it is drawn again. */
	update() {
		const view = this.app.active;
		this.#showIcons(view);
		this.#loadAgents(view);
		if (this.current === "search" && this.search.loaded !== this.#engineKey()) this.#loadSearch();
		else this.#loadView(false);
	}

	#showIcons(view) {
		for (const button of document.querySelectorAll(".rail-button[data-view]")) {
			const visible = VISIBLE[button.dataset.view];
			if (visible) button.hidden = !visible(view, this);
		}
		for (const button of document.querySelectorAll(".rail-button[data-command]")) button.hidden = !has(view, button.dataset.command);
		if (VISIBLE[this.current] && !VISIBLE[this.current](view, this)) {
			this.current = "chat";
			this.#mark();
		}
	}

	languageChanged() {
		for (const [index, label] of [t("sessionsHere"), t("sessionsAll")].entries()) this.scope.buttons[index].textContent = label;
		this.scope.el.setAttribute("aria-label", t("viewSearch"));
		if (this.current === "search") this.#drawSearch();
		else this.#loadView(true);
	}

	// ------------------------------------------------------------------------------------------- search

	/** The engine that answers for the conversation on screen, once it is ready. */
	#engine() {
		const view = this.app.active;
		return view?.ready && view.engine.alive ? view.engine : undefined;
	}

	#engineKey() {
		const view = this.app.active;
		// fork: the engine too: two conversations of one folder may store their sessions apart.
		return view?.ready ? `${view.engine.id}\n${view.cwd}\n${this.search.scope}` : undefined;
	}

	async #loadSearch() {
		const engine = this.#engine();
		const key = this.#engineKey();
		this.search.failed = "";
		if (!engine) {
			this.search.loaded = undefined;
			this.#drawSearch();
			return;
		}
		try {
			const answer = await engine.request({ type: "sessions_list", all: this.search.scope === "all" });
			if (key !== this.#engineKey()) return;
			this.search.sessions = answer.sessions ?? [];
			this.search.loaded = key;
		} catch (error) {
			if (key !== this.#engineKey()) return;
			this.search.failed = String(error?.message ?? error);
		}
		await this.#findInText();
	}

	/** The text of the sessions, searched by the engine after the names: what it found is shown under each name. */
	async #findInText() {
		const engine = this.#engine();
		// fork: an earlier search (another scope, engine or text) never replaces a later one.
		const request = ++this.search.searches;
		const key = this.#engineKey();
		const query = $("side-search").value.trim();
		let hits = [];
		let failed = "";
		if (engine && query) {
			try {
				hits = (await engine.request({ type: "sessions_search", query, all: this.search.scope === "all" })).hits ?? [];
			} catch (error) {
				failed = String(error?.message ?? error);
			}
		}
		if (request !== this.search.searches || key !== this.#engineKey() || $("side-search").value.trim() !== query) return;
		if (failed) this.search.failed = failed;
		this.search.excerpts.clear();
		for (const hit of hits) if (!this.search.excerpts.has(hit.path)) this.search.excerpts.set(hit.path, hit.text);
		this.#drawSearch();
	}

	#drawSearch() {
		const list = $("side-search-list");
		const query = $("side-search").value;
		const { sessions, excerpts, scope } = this.search;
		clear(list);
		if (this.search.failed) {
			list.append(h("li", { class: "muted", text: this.search.failed }));
			return;
		}
		if (!this.search.loaded) {
			list.append(h("li", { class: "muted", text: t("engineStarting") }));
			return;
		}
		const open = new Set(this.app.sessions.map((session) => session.path));
		const found = sessions.filter(
			(session) => excerpts.has(session.path) || matchesFilter(query, `${session.name ?? ""} ${session.firstMessage ?? ""} ${session.cwd ?? ""}`),
		);
		if (found.length === 0) list.append(h("li", { class: "muted", text: t(query.trim() ? "sideNoMatch" : "sessionsNone") }));
		for (const session of found.slice(0, SHOWN)) {
			const when = new Date(session.modified).toLocaleDateString(document.documentElement.lang, { day: "numeric", month: "short" });
			const folder = scope === "all" && session.cwd ? session.cwd.split("/").filter(Boolean).at(-1) : "";
			list.append(
				h(
					"li",
					{ class: open.has(session.path) ? "open" : "" },
					h(
						"button",
						{
							type: "button",
							class: "session-link result",
							title: session.cwd ? `${session.cwd}\n${session.path}` : session.path,
							onclick: () => this.#open(session),
						},
						h("span", { class: "label", text: session.name || session.firstMessage || t("untitled") }),
						h("span", { class: "meta", text: [folder, when].filter(Boolean).join(" · ") }),
						excerpts.has(session.path) && h("span", { class: "excerpt", text: excerpts.get(session.path) }),
					),
				),
			);
		}
		if (found.length > SHOWN) list.append(h("li", { class: "muted", text: t("sessionsMore", found.length - SHOWN) }));
	}

	// ---------------------------------------------------------------- scheduled tasks, memory, trace, logs

	/**
	 * Draws the scheduled tasks, the memory, the trace or the logs of the conversation on screen. They are read again
	 * when it changes and after each of its turns (its statistics are read then), or at once (`force`).
	 */
	async #loadView(force) {
		const name = this.current;
		const load = {
			schedule: () => this.#loadSchedule(),
			agents: () => this.#drawAgents(),
			memory: () => this.#loadMemory(),
			trace: () => this.#loadTrace(),
		}[name];
		const view = this.app.active;
		// The engine's output is kept by the window: shown while the engine starts and after it failed, the cases it is
		// there for.
		if (name === "logs") {
			if (view?.engine) this.#drawOutput(view);
			else $("side-logs-output").textContent = t("sideLogsOutputNone");
			return;
		}
		if (!load) return;
		if (!view?.ready || !view.engine.alive) {
			this.loaded = { view: undefined, stats: undefined, name: undefined };
			this.#drawNote(name, t("engineStarting"));
			return;
		}
		if (!force && this.loaded.view === view && this.loaded.stats === view.stats && this.loaded.name === name) return;
		this.loaded = { view, stats: view.stats, name };
		try {
			await load();
		} catch (error) {
			if (this.current === name && this.app.active === view) this.#drawNote(name, String(error?.message ?? error));
		}
	}

	#drawNote(name, text) {
		const target = { schedule: "side-schedule-list", agents: "side-agents-list", memory: "side-memory", trace: "side-trace-list" }[name];
		const element = $(target);
		clear(element);
		if (name === "trace") $("side-trace-state").textContent = "";
		element.append(h(element.tagName === "UL" ? "li" : "p", { class: "muted", text }));
	}

	async #loadSchedule() {
		const view = this.app.active;
		const { state } = await view.engine.request({ type: "schedule_get" });
		if (this.current !== "schedule" || this.app.active !== view) return;
		const list = $("side-schedule-list");
		clear(list);
		$("side-schedule-new").disabled = Boolean(state.unsafe);
		if (state.unsafe) list.append(h("li", { class: "muted side-note warning", text: state.unsafe }));
		else if (state.tasks.length === 0) list.append(h("li", { class: "muted", text: t("scheduleNone") }));
		for (const task of state.tasks)
			list.append(
				h(
					"li",
					{},
					h(
						"button",
						{ type: "button", class: "session-link result", dataset: { task: task.id }, title: task.cwd, onclick: () => this.#openSchedule({ task: task.id }) },
						h("span", { class: "label", text: task.id }),
						h("span", { class: "meta", text: task.active ? task.when : `${task.when} · ${state.labels.paused}` }),
						h("span", { class: "excerpt", text: task.prompt }),
					),
				),
			);
	}

	// /schedule's screen on that task, or on the form that creates one; the list is read again once it closes.
	async #openSchedule(options) {
		const view = this.app.active;
		if (!view?.ready || !view.engine.alive) return;
		const open = () => scheduleScreen(view, "", options);
		try {
			if (view.interactions.command?.name === "schedule") await view.interactions.run("schedule", open, { toggle: true });
			await view.interactions.run("schedule", open);
		} catch (error) {
			this.app.toast(String(error?.message ?? error), "error");
		}
		if (this.current === "schedule") this.#loadView(true);
	}

	// The runs of the conversation's sub-agents (agents_get), which decide whether their icon shows.
	async #loadAgents(view) {
		const key = view?.ready && view.engine.alive && has(view, "agents") ? [view.stats, view.statuses?.get("agents")] : undefined;
		if (this.agents.view === view && key && this.agents.key && key.every((part, index) => part === this.agents.key[index])) return;
		if (!key) {
			this.agents = { view, key: undefined, runs: [] };
			return;
		}
		this.agents.key = key;
		this.agents.view = view;
		let runs = [];
		try {
			runs = (await view.engine.request({ type: "agents_get" })).runs ?? [];
		} catch {
			// The module was turned off meanwhile: no icon.
		}
		if (this.agents.view !== view) return;
		this.agents.runs = runs;
		this.#showIcons(this.app.active);
		if (this.current === "agents") this.#drawAgents();
	}

	#drawAgents() {
		const list = $("side-agents-list");
		clear(list);
		const view = this.app.active;
		const runs = [...this.agents.runs].reverse();
		runs.sort((a, b) => Number(b.state === "running") - Number(a.state === "running"));
		for (const run of runs)
			list.append(
				h(
					"li",
					{},
					h(
						"button",
						{
							type: "button",
							class: "session-link result agent-run",
							dataset: { run: run.id, state: run.state },
							disabled: !run.session,
							title: run.session ? "" : t("agentTranscriptNone"),
							onclick: () => this.#openAgent(view, run),
						},
						h("span", { class: "label", text: `${run.agent} (${run.id})` }),
						h("span", { class: "meta", text: run.state === "running" ? run.step || t("agentRunning") : t(`agentState.${run.state}`) }),
						h("span", { class: "excerpt", text: run.task }),
					),
				),
			);
	}

	async #openAgent(view, run) {
		if (!view?.ready || !view.engine.alive) return;
		try {
			const open = () => agentTranscriptScreen(view, run);
			// Another run's transcript is open: closed first, as a click on a scheduled task does.
			if (view.interactions.command?.name === "agent-transcript") await view.interactions.run("agent-transcript", open, { toggle: true });
			await view.interactions.run("agent-transcript", open);
		} catch (error) {
			this.app.toast(String(error?.message ?? error), "error");
		}
	}

	async #loadMemory() {
		const view = this.app.active;
		const memory = await view.engine.request({ type: "memory_get" });
		if (this.current !== "memory" || this.app.active !== view) return;
		const box = $("side-memory");
		clear(box);
		const part = (title, file, actions) =>
			h(
				"div",
				{ class: "side-memory-part" },
				h("h3", { class: "side-subtitle", text: title, title: file.path }),
				file.text.trim() ? h("div", { class: "side-text", text: file.text.trim() }) : h("p", { class: "muted", text: t("memoryEmpty") }),
				h("div", { class: "side-actions" }, ...actions),
			);
		const button = (label, onclick) => h("button", { type: "button", class: "ghost small", text: label, onclick });
		box.append(
			part(t("memoryGlobal"), memory.global, [
				button(t("memoryEdit"), () => this.#runCommand("/memory-edit")),
				button(t("memoryUpdate"), () => this.#compose("/memory ")),
			]),
		);
		if (memory.project) box.append(part(t("memoryProject"), memory.project, [button(t("memoryUpdate"), () => this.#compose("/memory-project "))]));
		else box.append(h("p", { class: "side-note", text: t("memoryUntrusted") }));
	}

	async #loadTrace() {
		const view = this.app.active;
		let data;
		try {
			data = await view.engine.request({ type: "get_trace_report" });
		} catch {
			data = { enabled: false, records: [] };
		}
		if (this.current !== "trace" || this.app.active !== view) return;
		const list = $("side-trace-list");
		clear(list);
		$("side-trace-state").textContent = !data.enabled ? t("inspector.traceOff") : data.failed ? t("inspector.traceFailed") : "";
		const records = (data.records ?? []).slice(-LOGS_SHOWN).reverse();
		if (data.enabled && records.length === 0) list.append(h("li", { class: "muted", text: t("sideTraceNone") }));
		for (const record of records) {
			const when = record.timestamp ? new Date(record.timestamp).toLocaleTimeString(document.documentElement.lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
			list.append(
				h(
					"li",
					{},
					h(
						"button",
						{ type: "button", class: "session-link result log", dataset: { state: record.state }, onclick: () => this.#runCommand("/trace") },
						h("span", { class: "label", text: record.toolName ?? record.name }),
						h("span", { class: "meta", text: when }),
						h("span", { class: "excerpt", text: record.label ?? record.state }),
					),
				),
			);
		}
	}

	/** The engine's technical output, drawn again as it grows while the logs are on screen. */
	#drawOutput(view) {
		const box = $("side-logs-output");
		view.engine.onOutput = () => {
			if (this.current === "logs" && this.app.active === view) this.#drawOutput(view);
		};
		const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
		box.textContent = view.engine.output.length ? view.engine.output.join("\n") : t("sideLogsOutputNone");
		box.classList.toggle("muted", view.engine.output.length === 0);
		if (atEnd) box.scrollTop = box.scrollHeight;
	}

	#runCommand(line) {
		const view = this.app.active;
		if (view?.ready && view.engine.alive) view.prompt(line).catch((error) => this.app.toast(String(error?.message ?? error), "error"));
	}

	#compose(text) {
		this.app.setComposerText(text);
		const input = $("input");
		input.focus();
		input.setSelectionRange(text.length, text.length);
	}

	// An open conversation is shown, a saved one opened (app.js placeSession).
	#open(session) {
		this.app.openSession(session.path, session.name || undefined, session.cwd);
	}
}

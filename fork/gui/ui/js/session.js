// The view of one session: its transcript, its pending questions and its status, built only from what
// the engine sends (get_messages on open, then events). The window keeps no session state of its own:
// reopening a session rebuilds it from the engine.

import { promptWith, sentChips, splitFiles } from "./attachments.js";
import { builtin, screen } from "./builtins.js";
import { ListBox, Panel } from "./components.js";
import { closestCommand } from "./completion.js";
import { agentStepCount, agentStepLines, customText } from "./custom-message.js";
import { clear, copyText, formatDuration, h, stripAnsi } from "./dom.js";
import { Engine } from "./engine.js";
import { renderDocument, setAnswerable } from "./generated-ui.js";
import { t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { Interactions, UNASKED_OWNERS } from "./surface.js";
import { TranscriptList } from "./transcript-list.js";
import { TerminalView } from "./view.js";

const OUTPUT_PREVIEW_LINES = 12;
// Engine commands the window does not offer: /llama stays in the terminal. Typed, it
// is refused as a terminal command. The engine leaves them out of the completion (WINDOW_HIDDEN_COMMANDS).
const HIDDEN_COMMANDS = new Set(["llama"]);
const offered = (commands) => (commands ?? []).filter((command) => !HIDDEN_COMMANDS.has(command.name));
// The events that draw the transcript. While a session opens they are kept, then played over what the engine said it
// holds (#catchUp): the engine may be in the middle of a turn (a session the other screen started, an engine the PC
// kept), and an event applied before that reading is shown would be wiped by it. The host gives a screen that
// attaches during a reply that reply's start and fragments so far (fork/host, `Progress`): they are kept like the rest.
const TRANSCRIPT_EVENTS = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"ui_preview",
	"bash_execution_start",
	"bash_execution_update",
	"bash_execution_end",
]);
/** What names a message in the engine's reading of the session and in its events alike. */
const messageKey = (message) => (message?.timestamp === undefined ? undefined : `${message.role}:${message.timestamp}`);

export class SessionView {
	constructor(app, sessionPath, savedTitle, cwd) {
		this.app = app;
		this.cwd = cwd;
		this.initialPath = sessionPath;
		this.savedTitle = savedTitle; // a saved conversation's name, until its engine has loaded it
		this.state = undefined;
		this.models = [];
		this.levels = [];
		this.commands = [];
		this.statuses = new Map();
		this.widgets = new Map();
		this.dialogs = new Map();
		this.heldNotices = []; // information said before the conversation shows anything (showHeldNotices)
		this.views = new Map(); // views of the engine (view.js), in opening order
		this.interactions = new Interactions(this); // what shows on the interaction surface (surface.js)
		this.tools = new Map();
		this.sent = []; // what was sent, newest first: the composer's history (↑), as the terminal editor's
		this.bash = undefined; // the ! command running, as a tool card
		this.bashRuns = 0;
		this.streaming = false;
		this.ready = false; // opening requests answered: the session can be used
		this.closed = false; // closed by the user: its engine is shutting down and is no longer shown
		this.suspended = false; // asleep (lifecycle.js): no engine, the transcript kept; it wakes when opened
		this.lastActive = performance.now();
		this.keptGrants = undefined; // the in-memory session grants kept while asleep (sleep, wake)
		this.footerMenuOpen = false; // a footer menu (more…, context) is waiting for its answer
		this.exit = undefined;
		this.stats = undefined;
		this.current = undefined; // the assistant message being streamed
		this.held = undefined; // the transcript's events kept while the session opens (#holds, #catchUp)
		this.snapshot = new Set(); // the messages the engine's last reading of the session held (messageKey)
		this.started = new Set(); // the messages shown since, as they started
		this.el = h("div", { class: "transcript", role: "log", "aria-live": "polite", "aria-relevant": "additions" });
		// Only the entries around the view are in the page (transcript-list.js).
		this.list = new TranscriptList(this.el, {
			scroller: () => document.getElementById("scroller"),
			active: () => this.app.active === this,
			following: () => this.app.following(),
			moved: (delta, placed) => this.app.transcriptMoved(delta, placed),
			dropped: (entry, el) => this.#dropped(entry, el),
		});
		this.toolEntries = new Map(); // the entry of each tool call read from the session, by call id
		this.toolExpanded = new Map(); // tool calls the reader opened or closed, by id (their cards are rebuilt)
		// A block the reader opens or closes keeps its entry, which a rebuild would draw as the conversation's default.
		this.el.addEventListener(
			"toggle",
			(event) => {
				const details = event.target;
				if (!(details instanceof HTMLDetailsElement)) return;
				const shown = details.classList.contains("thinking") ? Boolean(this.thinkingShown) : false;
				const entry = this.list.entryOf(details);
				if (entry && details.open !== shown) this.list.pin(entry);
			},
			true,
		);
		this.engine = this.#newEngine();
		this.renderQueued = new Set();
		this.frame = 0;
		// Opening steps, in ms since the view was created (start-up measurements, drive.js "timings").
		this.timing = { created: performance.now() };
	}

	mark(step) {
		this.timing[step] ??= Math.round(performance.now() - this.timing.created);
	}

	// Engine notices name their conversation when it is not the one on screen.
	/** The information held while the conversation was empty, once it shows something (app.js render). */
	showHeldNotices() {
		if (this.el.childElementCount === 0) return;
		for (const notice of this.heldNotices.splice(0)) this.toast(...notice);
	}

	toast(text, kind, options) {
		if (this.closed) return;
		this.app.toast(this.app.active === this || !text ? text : `${this.title} — ${text}`, kind, options);
	}

	get title() {
		return this.state?.sessionName || this.firstMessage || this.savedTitle || t("untitled");
	}

	get path() {
		return this.state?.sessionFile ?? this.initialPath;
	}

	async open() {
		// What the engine's extensions show and its queue come again from the host (what an engine already running
		// said that still holds) or from the engine as it starts: what this view kept of them may no longer hold.
		this.statuses.clear();
		this.widgets.clear();
		this.queue = undefined;
		this.queueParts = undefined;
		this.windowTitle = undefined;
		this.sessionState = undefined;
		this.held = [];
		try {
			await this.#open();
		} catch (error) {
			this.held = undefined;
			throw error;
		}
	}

	async #open() {
		if (this.initialPath) this.#preview();
		const resume = this.resumeEngine;
		this.resumeEngine = undefined;
		await this.engine.start(this.initialPath, this.cwd, resume);
		// The PC kept it (same number): its turn went on meanwhile, and what it allowed "in this session" stands.
		const resumed = resume !== undefined && this.engine.id === resume;
		this.mark("spawned");
		await this.refreshState();
		this.mark("state");
		// The language first: the turn summaries, the keys' descriptions and the commands' come worded in it.
		const language = await this.app.engineLanguage(this);
		const [{ messages }, turns, resources] = await Promise.all([
			this.engine.request({ type: "get_messages" }),
			this.#turns(),
			this.#fetchResources(),
		]);
		this.language = language;
		this.#display(resources.display);
		if (this.app.active === this) this.app.languageShown(this);
		// Extension views (/perm, /bg…) are shown before the session is usable, at the window's size.
		await this.app.configureViews(this);
		this.#keepResources(resources);
		this.#show(messages, turns);
		this.#catchUp();
		this.ready = true;
		if (resumed) this.keptGrants = undefined;
		// The questions already open when this side attached (the link was down, or the other screen opened the session
		// first), after the transcript so a tool's question finds its card; the host gives each one once.
		await this.engine.replay().catch(() => {});
		this.app.reportFocus(this);
		this.mark("ready");
		this.refreshStats();
		this.app.sessionChanged(this);
	}

	// A saved conversation's transcript, read by an engine already running, shown while this one starts (seconds on "Opening the conversation…" for short ones)
	// . Its own engine's messages replace it.
	async #preview() {
		const peer = this.app.sessions.find((s) => s !== this && s.ready && s.engine.alive && !s.closed);
		if (!peer) return;
		const preview = await peer.engine.request({ type: "session_preview", path: this.initialPath }).catch(() => ({}));
		if (!preview.messages || this.ready || this.closed || this.list.size > 0) return;
		this.#show(preview.messages, preview.turns);
		this.mark("preview");
		this.app.sessionChanged(this);
	}

	// The messages, each turn's closing line after the message it follows in the session (the engine says
	// which). A line whose message is no longer shown (compacted) goes before the next one placed.
	// Each is an entry of the list, drawn only around the view (transcript-list.js); what reading a message changes
	// (the composer's history, the title, the question that can be answered) is done here for all of them.
	#show(messages, turns = []) {
		const wasEmpty = this.list.size === 0;
		this.tools.clear();
		this.toolEntries = new Map();
		this.toolExpanded = new Map();
		this.closeQuestion();
		this.historyQuestion = undefined;
		// A reply streamed into the transcript just replaced is no longer on screen (a kept engine taken back mid-turn).
		this.current = undefined;
		this.snapshot = new Set(messages.map(messageKey).filter((key) => key !== undefined));
		this.started = new Set();
		// Another screen's ! command shown in the transcript just replaced: its card is gone.
		if (this.bash?.remote) this.bash = undefined;
		this.sent = [];
		const entries = [];
		let question; // the last generated UI with no user message after it: the one that can be answered
		// Where each turn's line goes: the first line not placed yet that follows this message (by role and time).
		const anchors = new Map();
		for (const [index, turn] of turns.entries()) {
			const key = `${turn.role}:${turn.after}`;
			if (!anchors.has(key)) anchors.set(key, []);
			anchors.get(key).push(index);
		}
		let next = 0;
		const closeTurns = (until) => {
			while (next < until) {
				const text = turns[next++].text;
				const entry = { kind: "turn" };
				entry.build = () => {
					const line = turnLine(this, text);
					offerCopy(line, this.list, entry);
					return line;
				};
				entries.push(entry);
			}
		};
		for (const message of messages) {
			const entry = this.#historyEntry(message);
			if (entry) entries.push(entry);
			if (message.role === "user") question = undefined;
			if (message.role === "toolResult" && message.toolName === "show_ui" && !message.isError && message.details?.document)
				question = message.toolCallId;
			const anchored = anchors.get(`${message.role}:${message.timestamp}`)?.find((index) => index >= next);
			if (anchored !== undefined) closeTurns(anchored + 1);
		}
		closeTurns(turns.length);
		// The generated UI that can be answered keeps its card (and what is typed in it) wherever the view goes.
		this.historyQuestion = question;
		this.list.reset(entries);
		const entry = question && this.toolEntries.get(question);
		if (entry) this.list.pin(entry);
		if (wasEmpty && entries.length) this.app.sessionChanged(this);
	}

	/**
	 * A message read from the session: what reading it changes, now, and its entry, drawn when the view comes near it.
	 * A tool's result goes in its call's card (the entry of the reply that made the call), or a card of its own.
	 */
	#historyEntry(message) {
		switch (message.role) {
			case "user":
				this.#userSeen(message);
				return { kind: "user", build: () => this.#userEl(message) };
			case "assistant": {
				const entry = { kind: "assistant", message, results: [], toolIds: [] };
				for (const part of message.content ?? []) {
					if (part?.type !== "toolCall") continue;
					entry.toolIds.push(part.id);
					this.toolEntries.set(part.id, entry);
				}
				entry.build = () =>
					this.#rebuilding(() => {
						const view = new AssistantView(this, message);
						for (const result of entry.results) this.tools.get(result.toolCallId)?.setResult(result, result.isError);
						return view.el;
					});
				return entry;
			}
			case "toolResult": {
				const call = this.toolEntries.get(message.toolCallId);
				if (call) {
					call.results.push(message);
					return undefined;
				}
				// A call the transcript has not shown (resume in the middle of a run): its card, here.
				const entry = { kind: "tool", toolIds: [message.toolCallId], results: [message] };
				entry.build = () =>
					this.#rebuilding(() => {
						const tool = new ToolView(this, { id: message.toolCallId, name: message.toolName, arguments: {} });
						this.tools.set(tool.id, tool);
						tool.setResult(message, message.isError);
						return tool.el;
					});
				this.toolEntries.set(message.toolCallId, entry);
				return entry;
			}
			case "bashExecution": {
				const id = `bash-${++this.bashRuns}`;
				return { kind: "tool", toolIds: [id], build: () => this.#bashEl(message, id) };
			}
			case "custom":
				if (message.display === false) return undefined;
				return { kind: "other", build: () => this.#customEl(message) };
			case "compactionSummary":
			case "branchSummary":
				return { kind: "other", build: () => h("div", { class: "notice", text: t("compacted") }) };
		}
		return undefined;
	}

	/** Builds an entry read from the session: only the generated UI that can be answered becomes the question. */
	#rebuilding(build) {
		const before = this.rebuilding;
		this.rebuilding = true;
		try {
			return build();
		} finally {
			this.rebuilding = before;
		}
	}

	/** An entry's element is no longer kept: its tools no longer take the engine's events (it is built again for them). */
	#dropped(entry, el) {
		for (const id of entry.toolIds ?? []) {
			const tool = this.tools.get(id);
			if (tool && el.contains(tool.el)) this.tools.delete(id);
		}
	}

	/** A tool call's card: drawn and kept from now on when it was read from the session and is not drawn. */
	#toolView(id) {
		const tool = this.tools.get(id);
		if (tool) return tool;
		const entry = this.toolEntries.get(id);
		if (!entry) return undefined;
		this.list.pin(entry);
		return this.tools.get(id);
	}

	// The terminal's end-of-turn lines on the current branch after `since` (the engine words them).
	async #turns(since) {
		try {
			const result = await this.engine.request({ type: "get_turns", ...(since ? { since } : {}) });
			this.lastEntry = result.last;
			return result.turns;
		} catch {
			return [];
		}
	}

	// A turn has ended: its line goes here, before what settling adds (a ! command's output), once the
	// engine has recorded it.
	async #closeTurn(slot) {
		const turns = await this.#turns(this.lastEntry);
		const turn = turns.at(-1);
		if (turn) {
			const line = turnLine(this, turn.text);
			line.classList.add("enter");
			this.list.replace(slot, line);
			offerCopy(line, this.list);
		} else this.list.remove(slot);
		this.#scroll();
	}

	// After /reload: what the engine read again (commands, keys, models, the drawing settings).
	/** The commands pinned to the terminal's footer that this session has. */
	async refreshFooter() {
		const footer = await this.engine.request({ type: "get_footer" }).catch(() => undefined);
		this.pinned = footer?.pinned ?? [];
	}

	/**
	 * The terminal's footer menu "more…" (`more_menu`): the engine asks it with its dialogs; a chosen command runs as if typed, a changed pin list shows in every session.
	 */
	async footerMenu(type) {
		// one menu at a time; a click while it is open does not open another.
		if (this.footerMenuOpen) return;
		this.footerMenuOpen = true;
		try {
			const { line, pinned } = await this.engine.request({ type });
			if (pinned) await this.app.footerChanged();
			if (line) await this.prompt(line);
		} finally {
			this.footerMenuOpen = false;
		}
	}

	/** The models, thinking levels, commands, keys and drawing settings the engine offers; the footer refreshed too. */
	async #fetchResources() {
		const [models, levels, commands, keys, display] = await Promise.all([
			this.engine.request({ type: "get_available_models" }).catch(() => ({ models: [] })),
			this.engine.request({ type: "get_available_thinking_levels" }).catch(() => ({ levels: [] })),
			this.engine.request({ type: "get_commands" }).catch(() => ({ commands: [] })),
			this.engine.request({ type: "get_keys" }).catch(() => ({ bindings: {}, shortcuts: [] })),
			this.engine.request({ type: "get_display" }).catch(() => undefined),
			this.refreshFooter(),
		]);
		return { models, levels, commands, keys, display };
	}

	#keepResources({ models, levels, commands, keys }) {
		this.models = models.models ?? [];
		this.levels = levels.levels ?? [];
		this.commands = offered(commands.commands);
		this.keys = keys;
	}

	async refreshResources() {
		const resources = await this.#fetchResources();
		this.#display(resources.display);
		this.#keepResources(resources);
		await this.refreshState();
	}

	/** After each change in the Settings dialog: the drawing settings. */
	async refreshDisplay() {
		this.#display(await this.engine.request({ type: "get_display" }).catch(() => undefined));
	}

	// How the terminal's settings draw the conversation (get_display): thinking shown or hidden, as Ctrl+T then
	// changes it; Mermaid diagrams; the completion list's height (completion.js).
	#display(display) {
		if (!display) return;
		const before = this.display;
		this.display = display;
		if (before?.interfaceMode !== display.interfaceMode) this.app.sideMenu?.update(); // the logs' and trace's icons (side-menu.js)
		if (before?.hideThinkingBlock !== display.hideThinkingBlock) {
			this.thinkingShown = !display.hideThinkingBlock;
			for (const block of this.list.querySelectorAll("details.thinking")) block.open = this.thinkingShown;
			if (before) this.app.search?.changed();
		}
		if (before && before.mermaidRendering !== display.mermaidRendering) {
			for (const el of this.list.querySelectorAll(".msg.assistant .text")) el.block?.redraw();
		}
	}

	// After the engine moved to another session file (fork, clone): its state and messages again.
	async reload() {
		await this.refreshState();
		const [{ messages }, turns] = await Promise.all([this.engine.request({ type: "get_messages" }), this.#turns()]);
		this.#show(messages, turns);
		this.refreshStats();
		this.app.sessionChanged(this);
		this.app.refreshHistory();
	}

	async refreshState() {
		this.state = await this.engine.request({ type: "get_state" });
		this.streaming = this.state.isStreaming;
		this.app.sessionChanged(this);
	}

	async refreshStats() {
		try {
			this.stats = await this.engine.request({ type: "get_session_stats" });
			this.app.sessionChanged(this);
		} catch {
			// Stats are informative only.
		}
	}

	// The follow-up key: after the reply, as in the terminal; without a reply running, an ordinary send.
	// `toggle`: a switch or a key ran the command; run again while open, it closes it (surface.js).
	// `attachments`: the composer's (attachments.js), sent with a message, never with a command.
	async prompt(text, { behavior = "steer", toggle = false, attachments = [] } = {}) {
		const message = text.trim();
		if (!message && !attachments.length) return;
		const command = /^\/([^\s]+)/.exec(message)?.[1];
		const args = command ? message.slice(command.length + 1).trim() : "";
		const listed = command && this.commands.find((c) => c.name === command);
		// Always-on shipped factories have "inline" provenance; optional shipped modules have "builtin".
		const integrated = ["builtin", "inline"].includes(listed?.sourceInfo?.source);
		const permissionSource = this.commands.find((c) => c.name === "perm")?.sourceInfo;
		if (command === "sandbox" && (!listed || integrated) && permissionSource && !["builtin", "inline"].includes(permissionSource.source)) {
			this.toast(t("customPermissions", permissionSource.path), "warning");
			return true;
		}
		const run = command ? (listed ? (integrated ? screen(command, args) : undefined) : builtin(command)) : undefined;
		if (run) {
			await this.interactions.run(command, () => run(this, args), { toggle });
			return true;
		}
		// ! and !! (out of the model's context): the engine's bash command, as the terminal's editor runs them,
		// so the user_bash hooks (sandbox, permissions) apply the same way.
		const bash = /^(!!?)\s*(.*)$/s.exec(message);
		if (bash?.[2]) return this.#runBash(bash[2], bash[1] === "!!");
		// Built-in terminal commands are not commands of the engine: sent as a prompt, they would go to
		// the model as text. Only commands the engine lists are sent.
		if (command && !this.commands.some((c) => c.name === command)) {
			await this.#refuseCommand(command);
			return false;
		}
		// Until the engine accepted a message, the next one waits in the composer: two prompts sent before the
		// first started both get "started" and the engine runs only the first (fork9-defauts-moteur-gui.md § 4).
		// A command is answered only once it has run (a view, when it closes), so it does not hold messages.
		if (!command && this.sending) return false;
		if (!command) this.sending = true;
		try {
			const prompt = promptWith(message, command ? [] : attachments);
			const send = () =>
				this.engine.request({
					type: "prompt",
					message: prompt.message,
					...(prompt.images.length ? { images: prompt.images } : {}),
					...(this.streaming ? { streamingBehavior: behavior } : {}),
				});
			// A command owns the panels, views and questions it opens until the engine answers it.
			const { disposition } = command ? await this.interactions.run(command, send, { toggle }).then((r) => r ?? {}) : await send();
			// The engine is busy from here, before its agent_start reaches the window: a message sent now is
			// a steer, not a second prompt.
			if (disposition === "started") {
				this.streaming = true;
				this.app.sessionChanged(this);
			}
		} finally {
			if (!command) this.sending = false;
		}
		return true;
	}

	/**
	 * A command the window does not run: one of the terminal's, or one that does not exist. Audit of 2026-11-23
	 * a typo such as /zzz was said to be "available in the terminal only".
	 */
	async #refuseCommand(command) {
		if (HIDDEN_COMMANDS.has(command)) return this.toast(t("terminalOnly", command), "warning");
		// Every command the "/" list offers (the engine's completion, the terminal's built-ins included): one listed here
		// that the window cannot run is the terminal's; anything else does not exist.
		const listed = await this.engine
			.request({ type: "complete", text: "/", cursor: 1, open: "regular" })
			.then((data) => (data?.items ?? []).map((item) => item.value), () => []);
		if (listed.includes(command)) return this.toast(t("terminalOnly", command), "warning");
		const near = closestCommand(command, [...listed, ...this.commands.map((c) => c.name)]);
		this.toast(near ? t("unknownCommandNear", command, near) : t("unknownCommand", command), "warning");
	}

	async #runBash(command, excluded) {
		if (this.bash) {
			this.toast(t("bashRunning"), "warning");
			return false;
		}
		const view = this.#bashCard(command, excluded);
		try {
			const result = await this.engine.request({ type: "bash", command, excludeFromContext: excluded });
			view.setBashResult(result);
		} catch (error) {
			view.setResult({ content: [{ type: "text", text: String(error?.message ?? error) }] }, true);
		} finally {
			this.bash = undefined;
			this.app.sessionChanged(this);
		}
		// The engine records a command run during a reply after the reply (agent_end); so does the transcript.
		if (this.streaming) this.pendingBash = [...(this.pendingBash ?? []), view.el];
		return true;
	}

	/** The card of a ! command that runs, at the end of the transcript. */
	#bashCard(command, excluded) {
		const view = new ToolView(this, { id: `bash-${++this.bashRuns}`, name: "$", arguments: { command } });
		view.el.classList.add("user-bash");
		// !! is left out of the model's context: dimmed, as the terminal's border.
		if (excluded) view.el.classList.add("excluded");
		view.setRunning();
		this.registerTool(view);
		this.list.append(view.el);
		this.bash = view;
		this.app.sessionChanged(this);
		return view;
	}

	/** A ! command that another screen of this session runs: shown here as there, until the engine says it ended. */
	#bashStarted({ command, excludeFromContext }) {
		if (this.bash) return; // this screen's own, which #runBash shows
		this.#bashCard(command, excludeFromContext).remote = true;
	}

	/** The end of a ! command, with the message the engine recorded for it (none when it could not run). */
	#bashEnded(message) {
		const view = this.bash;
		if (view && !view.remote) return; // this screen's own: the answer to its request ends it
		// The engine's reading of the session already shows it (an event kept while the session opened).
		const read = this.snapshot.has(messageKey(message));
		let el = view?.el;
		if (view) {
			this.bash = undefined;
			if (read) {
				this.list.remove(view.el);
				this.tools.delete(view.id);
			} else if (message) view.setBashResult(message);
			else view.setResult({ content: [] }, true);
			this.app.sessionChanged(this);
		} else if (message && !read) {
			// Its start was not seen: an extension ran it, or it ended before this screen attached.
			this.#appendMessage(message);
			el = this.list.lastEl();
		}
		// The engine records a command run during a reply after the reply (agent_end); so does the transcript.
		if (el && !read && this.streaming) this.pendingBash = [...(this.pendingBash ?? []), el];
	}

	/** A sent text for the composer's history: newest first, no repeat in a row, 100 at most, as the terminal. */
	remember(text) {
		const trimmed = text.trim();
		if (!trimmed || this.sent[0] === trimmed) return;
		this.sent.unshift(trimmed);
		this.sent.length = Math.min(this.sent.length, 100);
	}

	abortBash() {
		return this.engine.request({ type: "abort_bash" });
	}

	/** The queued messages, taken out of the queue (the terminal's dequeue key and Escape give them back). */
	async dequeue() {
		const { steering = [], followUp = [] } = await this.engine.request({ type: "clear_queue" });
		return [...steering, ...followUp];
	}

	async cycleModel(direction) {
		const result = await this.engine.request({ type: "cycle_model", direction });
		if (!result) return;
		await this.setModel(result.model.provider, result.model.id);
	}

	async cycleThinking() {
		const result = await this.engine.request({ type: "cycle_thinking_level" });
		await this.refreshState();
		return result?.level;
	}

	// The composer's Plan switch: the plan module's own toggle; /plan when that module has not loaded.
	async togglePlan() {
		const { toggled } = await this.engine.request({ type: "toggle_plan" });
		if (!toggled) await this.prompt("/plan");
	}

	runShortcut(key) {
		return this.engine.request({ type: "run_shortcut", key });
	}

	// The terminal's tool output key: every tool's whole output, or its last lines, in this conversation.
	toggleTools() {
		this.toolsExpanded = !this.toolsExpanded;
		// Every call, those not drawn too: they are built in that state.
		this.toolExpanded.clear();
		for (const tool of this.tools.values()) tool.setExpanded(this.toolsExpanded);
		this.app.search?.changed();
	}

	toggleThinking() {
		this.thinkingShown = !this.thinkingShown;
		for (const block of this.list.querySelectorAll("details.thinking")) block.open = this.thinkingShown;
		this.app.search?.changed();
	}

	async abort() {
		this.stopping = true;
		this.app.sessionChanged(this);
		try {
			await this.engine.request({ type: "abort" });
		} finally {
			this.stopping = false;
			this.app.sessionChanged(this);
		}
	}

	async setModel(provider, modelId) {
		await this.engine.request({ type: "set_model", provider, modelId });
		await this.refreshState();
		const levels = await this.engine.request({ type: "get_available_thinking_levels" }).catch(() => ({ levels: [] }));
		this.levels = levels.levels ?? [];
		this.app.sessionChanged(this);
	}

	/** The engine's set_session_name (as /name); the name it kept, and where the conversation is listed, shown. */
	async rename(name) {
		await this.engine.request({ type: "set_session_name", name });
		await this.refreshState();
		const kept = this.state?.sessionName ?? name;
		if (kept !== name) this.app.toast(t("nameNormalized", name, kept), "warning");
		else this.app.toast(t("sessionNameSet", kept));
		this.app.refreshHistory();
		this.app.sessionChanged(this);
	}

	async setThinking(level) {
		await this.engine.request({ type: "set_thinking_level", level });
		await this.refreshState();
	}

	// ---------------------------------------------------------------------------------------------
	// Engine events

	#event(record) {
		this.lastActive = performance.now();
		this.mark("firstLine");
		if (this.closed) return;
		if (this.held && this.#holds(record)) return;
		switch (record.type) {
			case "agent_start":
				this.streaming = true;
				this.question?.refresh();
				this.app.sessionChanged(this);
				break;
			case "agent_end":
				this.turnSlot = h("div", { class: "turn-slot" });
				this.list.append(this.turnSlot);
				break;
			case "agent_settled":
				if (this.turnSlot) this.#closeTurn(this.turnSlot);
				this.turnSlot = undefined;
				for (const el of this.pendingBash ?? []) this.list.moveToEnd(el);
				this.pendingBash = undefined;
				this.streaming = false;
				this.current = undefined;
				this.question?.refresh();
				this.refreshState();
				this.refreshStats();
				break;
			case "message_start":
				this.#messageStart(record.message);
				break;
			case "message_update":
				this.#messageUpdate(record.assistantMessageEvent);
				break;
			case "message_end":
				this.#messageEnd(record.message);
				// Each reply and tool result of a turn moves the context gauge, as in the terminal's footer; it waited
				// for the end of the turn.
				this.refreshStats();
				break;
			case "tool_execution_start":
				this.#tool(record.toolCallId, record.toolName, record.args).setRunning();
				break;
			case "bash_execution_start":
				this.#bashStarted(record);
				break;
			case "bash_execution_update":
				this.bash?.appendOutput(record.delta);
				break;
			case "bash_execution_end":
				this.#bashEnded(record.message);
				break;
			case "ui_preview":
				// A generated UI while the model writes it: its complete blocks, validated by the engine.
				this.#toolView(record.toolCallId)?.setPreview(record.document);
				break;
			case "tool_execution_update":
				this.#toolView(record.toolCallId)?.setPartial(record.partialResult);
				break;
			case "tool_execution_end":
				this.#toolView(record.toolCallId)?.setResult(record.result, record.isError);
				break;
			case "queue_update": {
				const queued = [...(record.steering ?? []), ...(record.followUp ?? [])];
				this.queue = queued;
				this.queueParts = { steering: record.steering ?? [], followUp: record.followUp ?? [] };
				this.app.sessionChanged(this);
				break;
			}
			case "auto_retry_start":
				this.notice(t("retrying", record.attempt, record.maxAttempts, record.errorMessage), "warning");
				break;
			case "compaction_start":
				this.notice(t("compacting"));
				break;
			case "compaction_end":
				if (record.errorMessage) this.notice(record.errorMessage, "error");
				else if (!record.aborted) this.notice(t("compacted"));
				break;
			case "session_info_changed":
			case "thinking_level_changed":
				this.refreshState();
				break;
			case "extension_ui_request":
				this.#uiRequest(record);
				break;
			case "extension_ui_dismissed":
				this.#dismissed(record.id, record.reason);
				break;
			case "view_open":
				this.#viewOpen(record);
				break;
			case "view_frame":
				this.views.get(record.id)?.frame(record.columns, record.lines, record.menu);
				break;
			case "view_closed":
				this.#viewClosed(record.id, record.reason);
				break;
			case "session_state":
				// A resumed session whose last turn was cut short: the window's card, until the next prompt.
				this.sessionState = record.state ?? undefined;
				this.app.sessionChanged(this);
				break;
			case "open_tutorial":
				// /onboarding's « Start the tutorial »: the window's tutorial, not the terminal's view.
				void this.prompt("/tutorial");
				break;
			case "footer_changed":
				// The pinned commands are a global setting: every conversation's footer reads them again.
				this.app.footerChanged();
				break;
			case "extension_error":
				this.toast(`${record.extensionPath}: ${record.error}`, "error");
				break;
			case "response":
				// A response to a command this window did not track (or an unparsable command).
				if (!record.success) this.toast(record.error, "error");
				break;
		}
	}

	/**
	 * While the session opens: keeps an event of the transcript, or a question about a tool call (it goes in that
	 * call's card, which the reading of the session draws). Anything else is handled as it comes.
	 */
	#holds(record) {
		const held = this.held;
		const asked = (id) => held.some((kept) => kept.type === "extension_ui_request" && kept.id === id);
		const kept =
			TRANSCRIPT_EVENTS.has(record.type) ||
			(record.type === "extension_ui_request" && record.toolCallId !== undefined) ||
			(record.type === "extension_ui_dismissed" && asked(record.id));
		if (!kept) return false;
		// A tool's update carries its whole output so far: only the latest is needed.
		const last = held.at(-1);
		if (record.type === "tool_execution_update" && last?.type === record.type && last.toolCallId === record.toolCallId) held[held.length - 1] = record;
		else held.push(record);
		return true;
	}

	/**
	 * The events kept while the session opened, in the engine's order, over the transcript just read. The engine's
	 * reading holds every message whose end it had written, and may hold one whose end comes just after: the message
	 * events skip what the reading holds (`snapshot`), so nothing shows twice and nothing is dropped.
	 */
	#catchUp() {
		const held = this.held ?? [];
		this.held = undefined;
		for (const record of held) {
			this.#event(record);
			// It started before this screen caught up: no duration is shown rather than a wrong one.
			if (record.type === "tool_execution_start") {
				const tool = this.#toolView(record.toolCallId);
				if (tool) tool.startedAt = undefined;
			}
		}
	}

	/**
	 * An engine whose events reach this view only while it is the view's engine: a sleeping conversation's engine that
	 * reports its exit after the woken one replaced it must not mark the new one stopped.
	 */
	#newEngine() {
		const engine = new Engine(
			(record) => {
				if (engine === this.engine) this.#event(record);
			},
			(exit) => {
				if (engine === this.engine) this.#exited(exit);
			},
		);
		return engine;
	}

	/** Stops the engine of an idle conversation; its transcript stays, and `wake` starts it again. */
	async sleep() {
		// Two reclaims at once (the minute's check, a conversation starting) can pick the same one.
		if (this.suspended) return;
		this.suspended = true;
		// Nothing is sent to an engine about to stop: a prompt typed while its grants are exported would be lost.
		this.ready = false;
		// The engine this sleep stops, whatever `wake` puts in its place meanwhile; `wake` waits for it.
		const engine = this.engine;
		const sleeping = (async () => {
			// The dangerous actions and hosts allowed "in this session" live in the engine only (never saved): kept
			// here while it sleeps, given back when it wakes (perm_export / perm_import). false: the engine did not hand
			// them over, so they end, and the conversation says so when it wakes.
			this.keptGrants = await Promise.race([
				engine.request({ type: "perm_export" }).then((data) => data?.grants ?? undefined),
				new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
			]).catch(() => false);
			await engine.stop().catch(() => {});
		})();
		this.sleeping = sleeping;
		await sleeping;
		if (this.sleeping === sleeping) this.sleeping = undefined;
	}

	/** Starts the engine again from the session file, then shows what it holds; one wake at a time. */
	wake() {
		this.waking ??= this.#wake().finally(() => {
			this.waking = undefined;
		});
		return this.waking;
	}

	async #wake() {
		// Opened while it was going to sleep: the old engine stops first, and its grants come back to the new one.
		await this.sleeping;
		const asleep = this.path;
		// fork: an engine cut from the phone runs on a few minutes on the PC; ask for it back.
		if (this.lostLink) this.resumeEngine = this.engine.id;
		this.lostLink = false;
		this.suspended = false;
		this.ready = false;
		this.exit = undefined;
		this.initialPath = asleep;
		this.engine = this.#newEngine();
		this.app.sessionChanged(this);
		await this.open();
		this.app.refreshHistory();
		const grants = this.keptGrants;
		this.keptGrants = undefined;
		if (grants === undefined) return;
		const given = grants && (await this.engine.request({ type: "perm_import", grants }).catch(() => undefined));
		if (!given?.imported) this.toast(t("wokeUp"), "info");
	}

	#exited(exit) {
		// On the phone, an engine that ended with the connection to the PC (fork/android/phone) sleeps instead: it
		// starts again from its session file once the link is back (phone/link-watch.js). What was allowed "in this
		// session" could not be kept, and waking says so (keptGrants false).
		if (exit?.lost && !this.closed) {
			this.suspended = true;
			this.lostLink = true;
			this.keptGrants = false;
		}
		// Put to sleep or closed on purpose: not an engine that stopped (closing flashed the banner).
		else if (!this.suspended && !this.closed) this.exit = exit;
		this.streaming = false;
		if (this.bash?.remote) this.bash = undefined;
		for (const dialog of this.dialogs.values()) dialog.close(t("interrupted"));
		this.dialogs.clear();
		for (const id of [...this.views.keys()]) this.#viewClosed(id);
		this.interactions.dismissAll();
		this.app.sessionChanged(this);
	}

	#scroll() {
		this.app.followTranscript();
	}

	notice(text, kind = "info") {
		this.list.append(h("div", { class: `notice ${kind}`, text: stripAnsi(text) }));
		this.#scroll();
	}

	// ---------------------------------------------------------------------------------------------
	// Messages

	#appendMessage(message) {
		// The first message ends the welcome state and names the session: the window must re-render then,
		// not at the next status change (with a slow model, only when the turn settled).
		if (this.list.size === 0) this.app.sessionChanged(this);
		switch (message.role) {
			case "user":
				this.#userSeen(message);
				this.list.append(this.#userEl(message));
				break;
			case "assistant": {
				const view = new AssistantView(this, message);
				this.list.append(view.el);
				return view;
			}
			case "toolResult":
				this.#tool(message.toolCallId, message.toolName).setResult(message, message.isError);
				break;
			case "bashExecution":
				this.list.append(this.#bashEl(message, `bash-${++this.bashRuns}`));
				break;
			case "custom":
				if (message.display === false) break;
				this.list.append(this.#customEl(message));
				break;
			case "compactionSummary":
			case "branchSummary":
				this.list.append(h("div", { class: "notice", text: t("compacted") }));
				break;
		}
		this.#scroll();
		return undefined;
	}

	/** What a user message changes: the question it answers is closed, the composer's history, the title. */
	#userSeen(message) {
		this.closeQuestion();
		const { text, files } = splitFiles(textOf(message.content));
		this.remember(text);
		this.firstMessage ??= (text || files[0]?.split("/").pop() || t("attachImage")).split("\n")[0].slice(0, 80);
	}

	#userEl(message) {
		// fork.10 (LIV-08): the files and images the message carried, as chips under its text.
		const { text, files } = splitFiles(textOf(message.content));
		const images = Array.isArray(message.content)
			? message.content.filter((part) => part?.type === "image" && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType ?? ""))
			: [];
		const chips = sentChips(images, files);
		return h(
			"section",
			{ class: "msg user" },
			h("div", { class: "bubble" }, text && h("div", { class: "bubble-text", text }), chips.length > 0 && h("div", { class: "attachments sent" }, ...chips)),
		);
	}

	#bashEl(message, id) {
		const view = new ToolView(this, { id, name: "$", arguments: { command: message.command } });
		view.el.classList.add("user-bash");
		if (message.excludeFromContext) view.el.classList.add("excluded");
		view.setBashResult(message);
		this.registerTool(view);
		return view.el;
	}

	#customEl(message) {
		// an agent's answer message opens on its task and steps, folded under their count.
		const steps = message.customType === "agent-answer" && Array.isArray(message.details?.steps) && message.details.steps.length
			? h("details", { class: "agent-steps" }, h("summary", { text: agentStepCount(message.details.steps) || t("agentTask") }), h("pre", { text: agentStepLines(message.details).join("\n") }))
			: undefined;
		return h("section", { class: "msg custom" }, steps, renderMarkdown(customText(message, textOf(message.content)), this.app.markdownOptions));
	}

	#messageStart(message) {
		if (message.role === "system") return;
		const key = messageKey(message);
		// The engine's reading of the session already held it (an event kept while the session opened).
		if (this.snapshot.has(key)) return;
		if (key !== undefined) this.started.add(key);
		if (message.role === "assistant") {
			// The events fill it: this message shares its content with the stream, so the first delta may already be
			// in it and would show twice until the reply ends.
			this.current = this.#appendMessage({ ...message, content: [] });
			this.list.lastEl()?.classList.add("enter");
			return;
		}
		if (message.role === "toolResult") return; // shown by message_end
		this.#appendMessage(message);
		this.list.lastEl()?.classList.add("enter");
	}

	#messageUpdate(event) {
		const view = this.current;
		if (!view || !event) return;
		view.update(event);
		this.#scroll();
	}

	#messageEnd(message) {
		if (message.role === "assistant" && this.current) {
			this.current.finish(message);
			this.#scroll();
		} else if (message.role === "assistant") {
			// Its start came while the phone was away (an engine kept by the PC, taken back mid-reply): shown whole,
			// unless the engine's reading of the session already held it (its end was written just after).
			if (!this.snapshot.has(messageKey(message))) this.#appendMessage(message);
		} else if (message.role === "toolResult") {
			this.#tool(message.toolCallId, message.toolName).setResult(message, message.isError);
		} else if (message.role === "user") {
			// Its start came before this screen was attached and its end after the reading of the session.
			const key = messageKey(message);
			if (key !== undefined && !this.snapshot.has(key) && !this.started.has(key)) this.#messageStart(message);
		}
	}

	#tool(id, name, args) {
		let tool = this.#toolView(id);
		if (!tool) {
			// A call the transcript has not shown yet (resume in the middle of a run).
			tool = new ToolView(this, { id, name, arguments: args ?? {} });
			this.tools.set(id, tool);
			this.list.append(tool.el);
		}
		return tool;
	}

	registerTool(view) {
		this.tools.set(view.id, view);
	}

	// ---------------------------------------------------------------------------------------------
	// Generated UI (show_ui): only the latest one, with no user message after it, can be answered, as the
	// engine checks again (ui_submit).

	setQuestion(view) {
		// A card read from the session, drawn again as the view comes near it: only the last generated UI can be answered.
		if (this.rebuilding && view.id !== this.historyQuestion) return;
		if (this.question !== view) this.closeQuestion();
		this.question = view;
	}

	closeQuestion() {
		const question = this.question;
		this.question = undefined;
		question?.refresh();
	}

	canAnswer(view) {
		return this.question === view && !this.streaming && !this.answering;
	}

	async submitAnswer(view, answer) {
		if (!this.canAnswer(view)) return;
		this.answering = true;
		view.refresh();
		try {
			const { disposition } = await this.engine.request({ type: "ui_submit", toolCallId: view.id, ...answer });
			if (disposition === "started") {
				this.streaming = true;
				this.app.sessionChanged(this);
			}
			if (this.question === view) this.closeQuestion();
		} catch (error) {
			this.toast(error.message, "error");
		} finally {
			this.answering = false;
			view.refresh();
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Questions and notices from the engine (extension UI)

	#uiRequest(request) {
		switch (request.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor": {
				// A question about a tool call goes in that call's card, where the terminal asks it; any other
				// (a command's menu, an extension's question) on the interaction surface, never in the transcript.
				const tool = request.toolCallId ? this.#toolView(request.toolCallId) : undefined;
				const dialog = tool ? new ToolQuestion(this, request) : new QuestionPanel(this, request, this.interactions.owner());
				this.dialogs.set(request.id, dialog);
				if (tool) {
					tool.attachDialog(dialog);
					dialog.offerFocus();
					this.#scroll();
				} else dialog.show();
				break;
			}
			case "notify": {
				// A notice of several lines is a set of instructions to follow (/browser setup): it stays until closed,
				// rather than going after a few seconds.
				const message = stripAnsi(request.message);
				const notice = [message, request.notifyType ?? "info", { sticky: message.includes("\n") }];
				// Audit of 2026-11-23, FIN-19 (owner): nothing floats over the welcome. Information sent while the
				// conversation shows nothing yet (the engine's start-up notes) waits for its first message; a warning
				// or an error shows at once.
				if (notice[1] === "info" && this.el.childElementCount === 0) this.heldNotices.push(notice);
				else this.toast(...notice);
				break;
			}
			case "setStatus":
				if (request.statusText) this.statuses.set(request.statusKey, stripAnsi(request.statusText));
				else this.statuses.delete(request.statusKey);
				// the agent has the user's desktop (user_desktop) as long as this status is set.
				if (request.statusKey === "desktop-user") this.app.agentHasDesktop(Boolean(request.statusText));
				this.app.sessionChanged(this);
				break;
			case "setWidget":
				if (request.widgetLines?.length) this.widgets.set(request.widgetKey, request.widgetLines.map(stripAnsi));
				else this.widgets.delete(request.widgetKey);
				this.app.sessionChanged(this);
				break;
			case "setTitle":
				this.windowTitle = stripAnsi(request.title);
				this.app.sessionChanged(this);
				break;
			case "set_editor_text":
				this.app.setComposerText(request.text, this);
				break;
		}
	}

	// A view opened by a command the user just ran takes the keyboard, as in the terminal. One opened
	// during a turn (a question about a tool) follows the rule of questions: never while typing.
	#viewOpen({ id, overlay, nativeMenu }) {
		// The window's Settings dialog draws the engine's settings it asked for (settings-dialog.js).
		const hosted = nativeMenu ? this.viewHost?.(id) : undefined;
		if (hosted) {
			this.views.set(id, hosted);
			return;
		}
		const owner = this.interactions.owner();
		const view = new TerminalView(this, id, overlay, owner);
		this.views.set(id, view);
		view.entry = {
			panel: view.panel,
			nativeMenu,
			owner,
			replacesComposer: !overlay,
			focus: !this.streaming || !this.app.isTyping(),
			onDismiss: () => this.closeView(view),
		};
		this.interactions.open(view.entry);
	}

	#viewClosed(id, reason) {
		const view = this.views.get(id);
		if (!view) return;
		this.views.delete(id);
		view.close();
		if (!view.entry) return;
		this.interactions.close(view.entry, { linger: view.entry.nativeMenu && reason === "done" && this.interactions.command?.name === view.entry.owner });
	}

	closeView(view) {
		this.engine.request({ type: "view_close", viewId: view.id }).catch(() => this.#viewClosed(view.id));
	}

	#dismissed(id, reason) {
		const dialog = this.dialogs.get(id);
		if (!dialog) return;
		this.dialogs.delete(id);
		dialog.close(reason === "timeout" ? t("questionExpired") : reason === "answered" ? t("questionAnsweredElsewhere") : t("questionAborted"));
	}

	/** Answers a question; `shown` is what the tool's card keeps of the answer (permission questions only). */
	answer(dialog, response, shown, { force = false } = {}) {
		// A click or key that lands just as a question appears was not meant for it.
		if (!force && performance.now() < dialog.armedAt) return;
		if (!this.dialogs.has(dialog.id)) return;
		this.dialogs.delete(dialog.id);
		dialog.close(shown, { answered: true });
		this.engine.answer(dialog.id, response).catch((error) => this.toast(error.message, "error"));
	}

	cancelDialogs() {
		for (const dialog of [...this.dialogs.values()]) this.answer(dialog, { cancelled: true }, t("cancelled"), { force: true });
	}

	/**
	 * Shows a panel of the window's own (a built-in command's) on the interaction surface, owned by `owner`.
	 * Resolves with the value the panel is closed with (`panel.done(value)`), undefined when cancelled.
	 */
	showPanel(owner, panel, { focus = true } = {}) {
		return new Promise((resolve) => {
			const entry = { panel, owner, focus, onDismiss: () => finish(undefined) };
			const finish = (value) => {
				this.interactions.close(entry);
				resolve(value);
			};
			panel.onCancel = () => finish(undefined);
			panel.done = finish;
			this.interactions.open(entry);
		});
	}
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text")
		.map((part) => part.text)
		.join("\n");
}

// -------------------------------------------------------------------------------------------------

class AssistantView {
	constructor(session, message) {
		this.session = session;
		this.el = h("section", { class: "msg assistant" });
		this.blocks = [];
		this.message = message;
		this.el.answerText = answerText(message);
		for (const [index, part] of (message.content ?? []).entries()) this.#ensure(index, part);
		this.#footer(message);
	}

	#ensure(index, part) {
		let block = this.blocks[index];
		if (block) return block;
		if (part.type === "text") block = new TextBlock(this.session, part.text ?? "", Boolean(this.message.stopReason));
		else if (part.type === "thinking") {
			block = new ThinkingBlock(part.thinking ?? "");
			block.el.open = this.session.thinkingShown ?? false;
		}
		else if (part.type === "toolCall") {
			block = new ToolView(this.session, part);
			this.session.registerTool(block);
		} else block = { el: h("div"), set() {} };
		this.blocks[index] = block;
		this.el.append(block.el);
		return block;
	}

	update(event) {
		const index = event.contentIndex;
		switch (event.type) {
			case "text_start":
				this.#ensure(index, { type: "text", text: "" });
				break;
			case "text_delta":
				this.#ensure(index, { type: "text", text: "" }).append(event.delta);
				break;
			case "thinking_start":
				this.#ensure(index, { type: "thinking", thinking: "" });
				break;
			case "thinking_delta":
				this.#ensure(index, { type: "thinking", thinking: "" }).append(event.delta);
				break;
			case "toolcall_start":
				this.#ensure(index, { type: "toolCall", id: event.id, name: event.toolName, arguments: {} }).el.classList.add("enter");
				break;
			case "toolcall_end":
				this.#ensure(index, event.toolCall).setCall(event.toolCall);
				break;
		}
	}

	finish(message) {
		this.message = message;
		this.el.answerText = answerText(message);
		for (const [index, part] of (message.content ?? []).entries()) {
			const block = this.#ensure(index, part);
			if (part.type === "text") block.set(part.text ?? "", true);
			else if (part.type === "thinking") block.set(part.thinking ?? "");
			else if (part.type === "toolCall") block.setCall(part);
		}
		this.#footer(message);
	}

	#footer(message) {
		this.el.querySelector(".msg-error")?.remove();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			const text =
				message.stopReason === "aborted"
					? t("interrupted")
					: t("errorLine", message.errorMessage ?? "");
			this.el.append(h("div", { class: `msg-error ${message.stopReason}`, role: "status", text }));
		}
	}
}

class TextBlock {
	constructor(session, text, final = false) {
		this.session = session;
		this.text = text;
		// The reply is complete: Mermaid's "final" mode draws its diagrams from here.
		this.final = final;
		this.el = h("div", { class: "text" });
		this.el.block = this;
		this.scheduled = false;
		this.#render();
	}

	append(delta) {
		this.text += delta ?? "";
		this.#schedule();
	}

	set(text, final = this.final) {
		if (text === this.text && final === this.final) return;
		this.text = text;
		this.final = final;
		this.#schedule();
	}

	/** Drawn again: the Mermaid setting changed. */
	redraw() {
		this.#schedule();
	}

	// One Markdown pass per frame at most, however fast the deltas arrive.
	#schedule() {
		if (this.scheduled) return;
		this.scheduled = true;
		requestAnimationFrame(() => {
			this.scheduled = false;
			this.#render();
		});
	}

	#render() {
		const started = performance.now();
		// Replaced in one step: a layout on an empty block would pull the transcript's scroll back.
		const diagrams = { mermaid: this.session.display?.mermaidRendering, final: this.final };
		this.el.replaceChildren(renderMarkdown(this.text, { ...this.session.app.markdownOptions, ...diagrams }));
		this.session.app.recordRender?.(performance.now() - started, this.text.length);
	}
}

class ThinkingBlock {
	constructor(text) {
		this.text = text;
		this.body = h("div", { class: "thinking-body", text });
		this.el = h(
			"details",
			{ class: "thinking" },
			h("summary", {}, h("span", { class: "state half", "aria-hidden": "true" }), t("thinkingLabel")),
			this.body,
		);
	}

	append(delta) {
		this.text += delta ?? "";
		this.body.textContent = this.text;
	}

	set(text) {
		this.text = text;
		this.body.textContent = text;
	}
}

function toolTarget(name, args = {}) {
	// A generated UI shows its document, not its arguments; its title, as the terminal's call line.
	if (name === "show_ui") return typeof args.title === "string" ? args.title : "";
	// A custom agent: its name; its task opens the card's detail.
	if (name === "agent" && typeof args.agent === "string") return args.agent;
	if (typeof args.command === "string") return args.command;
	if (typeof args.path === "string") return args.path;
	if (typeof args.file_path === "string") return args.file_path;
	if (typeof args.pattern === "string") return args.pattern;
	if (typeof args.query === "string") return args.query;
	if (Array.isArray(args.urls)) return args.urls.join(" ");
	const json = JSON.stringify(args);
	return json === "{}" ? "" : json;
}

class ToolView {
	constructor(session, call) {
		this.session = session;
		this.id = call.id;
		this.name = call.name;
		this.args = call.arguments ?? {};
		this.status = "pending";
		this.startedAt = undefined;
		this.expanded = session.toolExpanded?.get(call.id) ?? session.toolsExpanded ?? false;
		this.output = "";
		this.images = [];
		this.dot = h("span", { class: "state", "aria-hidden": "true" });
		this.label = h("span", { class: "tool-state" });
		this.target = h("span", { class: "tool-target" });
		this.time = h("span", { class: "tool-time" });
		this.summary = h("span", { class: "tool-summary" });
		this.outputEl = h("div", { class: "tool-output" });
		this.dialogSlot = h("div", { class: "tool-dialog" });
		// The header opens and closes the call's detail (what was written, the diff, the whole output) when
		// there is more of it than the card shows; Ctrl+O does it for every call of the conversation.
		this.head = h(
			"header",
			{},
			this.dot,
			h("span", { class: "tool-name", text: this.name || t("unknownTool") }),
			this.target,
			this.summary,
			this.label,
			this.time,
		);
		this.head.addEventListener("click", (event) => {
			if (this.head.getAttribute("role") === "button" && !String(window.getSelection())) this.#toggle();
			event.stopPropagation();
		});
		this.head.addEventListener("keydown", (event) => {
			if (this.head.getAttribute("role") !== "button" || (event.key !== "Enter" && event.key !== " ")) return;
			event.preventDefault();
			this.#toggle();
		});
		this.el = h("section", { class: "tool", dataset: { status: "pending" } }, this.head, this.dialogSlot, this.outputEl);
		this.#header();
	}

	setCall(call) {
		this.name = call.name ?? this.name;
		this.args = call.arguments ?? this.args;
		this.el.querySelector(".tool-name").textContent = this.name;
		this.#header();
	}

	// A generated UI: the engine's validated document once it has run, its validated preview before.
	#generated() {
		return this.name === "show_ui";
	}

	setPreview(document) {
		this.preview = document;
		this.#renderOutput();
	}

	refresh() {
		if (this.#generated()) this.#renderOutput();
	}

	setRunning() {
		if (this.status === "awaiting") return;
		this.status = "running";
		this.startedAt ??= Date.now();
		this.#header();
	}

	attachDialog(dialog) {
		this.status = "awaiting";
		this.dialog = dialog;
		this.dialogSlot.append(dialog.el);
		// What was answered stays as the call's state (its decision), not as a closed question.
		dialog.onClose = (outcome) => {
			if (this.status === "awaiting") this.status = "running";
			this.decision = outcome;
			this.#header();
		};
		this.#header();
	}

	setExpanded(expanded) {
		this.expanded = expanded;
		this.#renderOutput();
	}

	/** The reader opens or closes this call: its card, drawn again later (transcript-list.js), stays so. */
	#toggle() {
		this.setExpanded(!this.expanded);
		this.session.toolExpanded?.set(this.id, this.expanded);
	}

	setPartial(result) {
		this.#setOutput(result);
	}

	// A ! command's output arrives as text deltas; its end as the engine's BashResult (or recorded message).
	appendOutput(delta) {
		this.output += delta;
		this.#renderOutput();
	}

	setBashResult(result) {
		const failed = result.cancelled || (result.exitCode !== 0 && result.exitCode != null);
		this.setResult({ content: [{ type: "text", text: (result.output ?? "").trimEnd() }] }, failed);
		// The terminal's status: (cancelled), (exit N), and where the whole output is when it was cut.
		const notes = [];
		if (result.cancelled) notes.push(t("bashCancelled"));
		else if (failed) notes.push(t("exitCode", result.exitCode));
		if (result.truncated && result.fullOutputPath) notes.push(t("fullOutputAt", result.fullOutputPath));
		this.label.textContent = notes.join(" · ");
	}

	setResult(result, isError) {
		this.status = isError ? "error" : "done";
		this.endedAt = Date.now();
		this.#setOutput(result);
		this.#header();
	}

	#setOutput(result) {
		this.details = result?.details;
		this.document = result?.details?.document;
		if (this.#generated() && this.document && this.status === "done") this.session.setQuestion(this);
		const content = result?.content ?? [];
		this.output = textOf(content);
		this.images = Array.isArray(content) ? content.filter((part) => part?.type === "image") : [];
		this.#renderOutput();
	}

	#header() {
		this.el.dataset.status = this.status;
		this.target.textContent = toolTarget(this.name, this.args);
		this.target.title = this.target.textContent;
		const labels = {
			pending: t("pending"),
			awaiting: t("awaitingPermission"),
			running: t("running"),
			done: "",
			error: t("failed"),
		};
		this.label.textContent = [labels[this.status], this.decision].filter(Boolean).join(" · ");
		this.dot.className = `state ${{ pending: "empty", awaiting: "empty", running: "half", done: "full", error: "full" }[this.status]}`;
		this.time.textContent =
			this.startedAt && this.endedAt ? formatDuration(this.endedAt - this.startedAt) : "";
	}

	/**
	 * What the card shows of the call, as the terminal's renderers do (core/tools/renderers): the diff of an
	 * edit, the content of a write, a read's content (collapsed to nothing, as there), else the output. A
	 * failed call shows its error.
	 */
	#detail() {
		const ok = this.status !== "error";
		const count = (text) => {
			const n = text.split("\n").length;
			return n === 1 ? t("oneLine") : t("lineCount", n);
		};
		if (ok && this.name === "edit" && typeof this.details?.diff === "string" && this.details.diff) {
			const lines = this.details.diff.split("\n");
			const added = lines.filter((line) => line.startsWith("+")).length;
			const removed = lines.filter((line) => line.startsWith("-")).length;
			return { text: this.details.diff, kind: "diff", from: "start", summary: `+${added} −${removed}` };
		}
		if (ok && this.name === "write" && typeof this.args.content === "string" && this.args.content) {
			const text = this.args.content.replace(/\n+$/, "");
			return { text, kind: "code", from: "start", summary: count(text) };
		}
		if (ok && this.name === "read" && this.output && this.images.length === 0) {
			const text = this.output.replace(/\n+$/, "");
			return { text, kind: "code", from: "start", preview: 0, summary: count(text) };
		}
		// what a custom agent does, live: the task, each tool it calls on what and
		// whether it worked, what it says between calls, then its answer (agent-activity.ts sends the steps).
		// an agent started in the background answers in a message later.
		if (ok && this.name === "agent" && this.details?.started) return { text: t("agentStarted", this.details.id ?? ""), kind: "", from: "start" };
		if (this.name === "agent" && Array.isArray(this.details?.steps)) {
			const lines = agentStepLines(this.details);
			return { text: [...lines, "", this.output].join("\n").trim(), kind: "agent", from: "end", summary: agentStepCount(this.details.steps) };
		}
		// a generated UI the engine refused shows why, not the document it was
		// sent again (a hundred lines of JSON) nor the examples of each block; the model still gets the whole message.
		if (!ok && this.#generated() && this.output) {
			return { text: this.output.split(/\n\nReceived arguments:\n|\nEach block, by type:\n/)[0], kind: "", from: "start" };
		}
		return this.output ? { text: this.output, kind: "", from: "end" } : undefined;
	}

	#renderOutput() {
		if (this.#generated() && this.status !== "error") {
			const document = this.status === "done" ? this.document : this.preview;
			// The same document (the tool's end and its message both carry it): only whether it can be answered
			// changes, and the form keeps what was typed.
			const key = JSON.stringify(document ?? null);
			if (key !== this.shown) {
				this.shown = key;
				clear(this.outputEl);
				const answer = this.status === "done" ? (value) => this.session.submitAnswer(this, value) : undefined;
				if (document) this.outputEl.append(renderDocument(document, answer));
			}
			const root = this.outputEl.firstElementChild;
			if (root) setAnswerable(root, this.status === "done" && this.session.canAnswer(this));
			this.el.classList.toggle("preview", this.status !== "done");
			return;
		}
		clear(this.outputEl);
		const detail = this.#detail();
		this.summary.textContent = detail?.summary ?? "";
		const lines = detail ? detail.text.split("\n") : [];
		const limit = detail?.preview ?? OUTPUT_PREVIEW_LINES;
		const long = lines.length > limit;
		if (long) {
			this.head.setAttribute("role", "button");
			this.head.setAttribute("tabindex", "0");
			this.head.setAttribute("aria-expanded", String(this.expanded));
		} else for (const name of ["role", "tabindex", "aria-expanded"]) this.head.removeAttribute(name);
		if (lines.length === 0 && this.images.length === 0) return;
		// Collapsed: the start of what was written or read, the end of an output (where a command's result is).
		const shown = !long || this.expanded ? lines : detail.from === "start" ? lines.slice(0, limit) : lines.slice(-limit);
		const toggle =
			long &&
			limit > 0 &&
			h("button", {
				class: "ghost small tool-more",
				type: "button",
				text: this.expanded ? t("showLess") : `${t("showAll")} (${lines.length})`,
				onclick: () => this.#toggle(),
			});
		if (toggle && detail.from !== "start") this.outputEl.append(toggle);
		if (shown.length) {
			const pre = h("pre", { class: detail.kind });
			for (const line of shown) {
				const kind = detail.kind === "diff" && /^[+-]/.test(line) ? (line[0] === "+" ? "add" : "del") : "";
				pre.append(h("span", { class: `line ${kind}`, text: `${line}\n` }));
			}
			this.outputEl.append(pre);
		}
		if (toggle && detail.from === "start") this.outputEl.append(toggle);
		for (const image of this.images) {
			// Images from tools are local data; a data: URL loads nothing from the network.
			if (/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType ?? ""))
				this.outputEl.append(h("img", { class: "tool-image", alt: "", src: `data:${image.mimeType};base64,${image.data}` }));
		}
	}
}

// A question from the engine (extension_ui_request: select, confirm, input, editor). The engine decides
// everything; these only show it and send back the answer. Two places, two components with the same
// controls: in the card of the tool call it is about (permissions), or on the interaction surface.

/** The controls of a question: its options (select), yes/no (confirm) or a field (input, editor). */
export function questionControls(session, dialog, { list = false } = {}) {
	const { request } = dialog;
	const answer = (response, shown) => session.answer(dialog, response, shown);
	const cancel = h("button", { type: "button", class: "option ghost", text: t("cancel") });
	cancel.addEventListener("click", () => answer({ cancelled: true }, t("cancelled")));
	if (request.method === "select") {
		const options = request.options.map((option) => stripAnsi(option));
		// On the surface, a list the keyboard and the wheel move through; in a tool's card, a row of buttons.
		if (list) {
			const box = new ListBox({
				items: request.options.map((value, i) => ({ label: options[i], value })),
				onChoose: (item) => answer({ value: item.value }, item.label),
			});
			return { body: box.el, actions: [] };
		}
		const buttons = request.options.map((option, i) =>
			h("button", {
				type: "button",
				class: i === 0 ? "option first" : "option",
				text: options[i],
				onclick: () => answer({ value: option }, options[i]),
			}),
		);
		return { body: undefined, actions: [...buttons, cancel] };
	}
	if (request.method === "confirm") {
		const yes = h("button", { type: "button", class: "option primary", text: t("yes"), onclick: () => answer({ confirmed: true }, t("yes")) });
		const no = h("button", { type: "button", class: "option", text: t("no"), onclick: () => answer({ confirmed: false }, t("no")) });
		return { body: undefined, actions: [yes, no, cancel] };
	}
	const field =
		request.method === "editor"
			? h("textarea", { class: "field", rows: "6", dataset: { autofocus: "" } })
			: h("input", { class: "field", type: request.secret ? "password" : "text", autocomplete: "off", placeholder: request.placeholder ?? "", dataset: { autofocus: "" } });
	if (request.prefill) field.value = request.prefill;
	const ok = h("button", { type: "button", class: "option primary", text: t("ok"), onclick: () => answer({ value: field.value }, t("ok")) });
	field.addEventListener("keydown", (event) => {
		// fork: the Enter that confirms an input method's candidate is the IME's,
		// not an answer; the next Enter sends the whole text.
		if (event.isComposing) return;
		if (event.key === "Enter" && (request.method === "input" || event.ctrlKey)) ok.click();
	});
	return { body: field, actions: [ok, cancel] };
}

/** The question's own text: its title's first line, then the rest of the title and a confirm's message. */
function questionText(request) {
	const [head, ...rest] = String(request.title ?? "").split("\n");
	const body = [rest.join("\n").trim(), request.method === "confirm" ? request.message : ""].filter(Boolean).map(stripAnsi).join("\n");
	return { title: stripAnsi(head), body };
}

/** The risk the answer accepts (`warning` of the engine's question), in red under the title; nothing without one. */
function questionWarning(request, tag = "div", extra = "") {
	return request.warning ? h(tag, { class: `dialog-warning${extra}`, text: stripAnsi(String(request.warning)) }) : undefined;
}

/** A question about a tool call, in its card: what was decided stays as the card's state, not as a trace. */
export class ToolQuestion {
	constructor(session, request) {
		this.session = session;
		this.id = request.id;
		this.request = request;
		this.onClose = undefined;
		this.closed = false;
		// A question that appears under the pointer or the keyboard ignores them for a moment.
		this.armedAt = performance.now() + 400;
		const { title, body } = questionText(request);
		const { body: field, actions } = questionControls(session, this);
		this.countdown = h("div", { class: "dialog-countdown" });
		this.el = h(
			"div",
			{ class: `dialog permission${request.tone === "warning" ? " warning" : ""}`, role: "group", tabindex: "-1", "aria-label": title },
			h("div", { class: "dialog-title", text: title }),
			questionWarning(request),
			body ? h("div", { class: "dialog-body", text: body }) : undefined,
			field,
			h("div", { class: "dialog-actions" }, actions),
			this.countdown,
		);
		this.el.addEventListener("keydown", (event) => this.#keys(event));
		startCountdown(this);
	}

	#keys(event) {
		// fork: keys of a composition (Escape cancels it) belong to the IME.
		if (event.isComposing) return;
		const buttons = [...this.el.querySelectorAll(".dialog-actions button")];
		const index = buttons.indexOf(document.activeElement);
		if (event.key === "ArrowDown" || event.key === "ArrowRight") {
			buttons[(index + 1) % buttons.length]?.focus();
			event.preventDefault();
		} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
			buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
			event.preventDefault();
		} else if (event.key === "Escape") {
			this.session.answer(this, { cancelled: true }, t("cancelled"));
			event.stopPropagation();
			event.preventDefault();
		}
	}

	// The question takes the focus only when the user is not typing in the composer, so a key meant
	// for the message can never answer a permission question.
	offerFocus() {
		if (this.session.app.isTyping()) return;
		const target = this.el.querySelector(".field") ?? this.el.querySelector(".dialog-actions button");
		target?.focus();
	}

	close(outcome) {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		const hadFocus = this.el.contains(document.activeElement);
		this.el.remove();
		this.onClose?.(outcome);
		if (hadFocus || document.activeElement === document.body) this.session.app.focusAfterInteraction(this.session);
		this.session.app.render();
	}
}

/**
 * A question on the interaction surface. One asked by a command the user ran (a menu of several screens:
 * /goal, /plan…) is not armed, and leaves its place to the next screen for a moment; one that comes on
 * its own (an extension, a turn) is armed like a permission question and does not take the keyboard
 * from the composer.
 */
class QuestionPanel {
	constructor(session, request, owner) {
		this.session = session;
		this.id = request.id;
		this.request = request;
		this.owner = owner;
		this.closed = false;
		this.fromCommand = !UNASKED_OWNERS.has(owner);
		this.armedAt = this.fromCommand ? 0 : performance.now() + 400;
		const { title, body } = questionText(request);
		this.panel = new Panel({
			title,
			kind: "question",
			onCancel: () => session.answer(this, { cancelled: true }, undefined, { force: true }),
		});
		const { body: control, actions } = questionControls(session, this, { list: true });
		this.countdown = h("div", { class: "dialog-countdown" });
		this.panel.setBody(questionWarning(request, "p", " panel-text"), body ? h("p", { class: "panel-text", text: body }) : undefined, control, this.countdown);
		this.panel.setActions(actions);
		startCountdown(this);
	}

	show() {
		this.entry = {
			panel: this.panel,
			owner: this.owner,
			// an empty composer is not typing; the keys go to the question.
			focus: this.fromCommand || !this.session.app.isTyping() || !document.getElementById("input")?.value.trim(),
			onDismiss: () => this.session.answer(this, { cancelled: true }, undefined, { force: true }),
		};
		this.session.interactions.open(this.entry);
	}

	close(_outcome, { answered = false } = {}) {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		// An answered screen of a command's menu keeps its place for the next screen (surface.js).
		this.session.interactions.close(this.entry, { linger: answered && this.fromCommand });
	}
}

function startCountdown(dialog) {
	if (!dialog.request.timeout) return;
	const deadline = Date.now() + dialog.request.timeout;
	const tick = () => {
		const left = deadline - Date.now();
		dialog.countdown.textContent = left > 0 ? t("timeLeft", formatDuration(left)) : "";
	};
	dialog.timer = setInterval(tick, 1000);
	tick();
}

const firstLine = (text) => String(text ?? "").split("\n")[0];

/** The text of a reply of the model, without its thinking and tool calls. */
const answerText = (message) =>
	(message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n\n")
		.trim();

/**
 * The model's last reply with text in the turn that `line` closes: back to the user's message that started it. The
 * transcript's entries are read, not the page, which holds only those around the view (transcript-list.js).
 */
function finalAnswer(list, line, entry = list.entryOf(line)) {
	const entries = list.entries;
	for (let i = entries.indexOf(entry) - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind === "user" || entry.kind === "turn") break;
		const text = entry.el?.answerText ?? (entry.kind === "assistant" && entry.message ? answerText(entry.message) : "");
		if (text) return text;
	}
	return "";
}

/**
 * The terminal's line at the end of a turn: its figures between two hairlines, and
 *  a button that copies the model's final answer, shown once the line is in place (`offerCopy`).
 */
function turnLine(session, text) {
	const copy = h("button", {
		type: "button",
		class: "turn-copy ghost",
		text: t("copy"),
		title: t("copyAnswer"),
		"aria-label": t("copyAnswer"),
		hidden: true,
		onclick: async () => {
			const answer = finalAnswer(session.list, copy.parentElement);
			if (answer && (await copyText(answer))) session.toast(t("entryCopied"));
		},
	});
	return h("div", { class: "turn-summary" }, h("span", { text }), copy);
}

/** Shows the copy button of a turn's line when the turn has an answer to copy; `entry`: the line's, while it is built. */
function offerCopy(line, list, entry) {
	const copy = line.querySelector(".turn-copy");
	if (copy) copy.hidden = !finalAnswer(list, line, entry);
}

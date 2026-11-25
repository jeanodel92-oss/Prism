// The terminal's built-in commands (/new, /name, /fork…) are not commands of the engine: the terminal runs
// them itself (interactive-mode.ts). Here each one is the engine's RPC command that does the same thing; the
// window only asks what the terminal's selector would ask and shows the result. A built-in without such a
// command stays refused (session.js).

import { bgScreen } from "./bg-screen.js";
import { desktopScreen } from "./desktop-screen.js";
import { agentsScreen } from "./agents-screen.js";
import { budgetScreen } from "./budget-screen.js";
import { changelogScreen } from "./changelog-screen.js";
import { checkpointsScreen } from "./checkpoints-screen.js";
import { docsScreen } from "./docs-screen.js";
import { filesScreen } from "./files-screen.js";
import { inspectorScreen } from "./inspector-screen.js";
import { lspSetupScreen } from "./lsp-setup-screen.js";
import { phoneLinkScreen } from "./phone-link.js";
import { permScreen } from "./perm-screen.js";
import { sandboxScreen } from "./sandbox-screen.js";
import { scheduleScreen } from "./schedule-screen.js";
import { sessionsScreen } from "./sessions-screen.js";
import { tutorialScreen } from "./tutorial-screen.js";
import { facts, ListBox, Panel } from "./components.js";
import { clear, h } from "./dom.js";
import { formatCost, formatNumber, t } from "./i18n.js";
import { contextScreen, doctorScreen, modelSettingsScreen, treeScreen } from "./screens.js";


// What a command reports goes to a toast, never into the transcript: the transcript holds the
// conversation. A path or a link to copy stays until it is closed.
const builtins = {
	async new(view) {
		await view.app.openSession(undefined);
	},

	// /name renames as the title does; without a name, the title becomes the field. What changed is a toast:
	// nothing of it goes into the transcript.
	async name(view, args) {
		if (!args) return view.app.editTitle(view);
		await view.rename(args);
	},

	// The terminal's /session report, as a panel of facts (not a notice in the transcript).
	async session(view) {
		const stats = await view.engine.request({ type: "get_session_stats" });
		const { input, output, cacheRead, cacheWrite, total } = stats.tokens;
		const panel = new Panel({ title: t("sessionInfo"), kind: "report" });
		panel.setBody(
			facts([
				view.state?.sessionName && [t("nameLabel"), view.state.sessionName],
				[t("fileLabel"), stats.sessionFile ?? t("inMemory")],
				["ID", stats.sessionId],
				[t("messagesLabel"), `${stats.totalMessages} (${stats.userMessages} / ${stats.assistantMessages})`],
				[t("toolsLabel"), stats.toolCalls],
				[t("tokensLabel"), `${formatNumber(input + cacheRead + cacheWrite)} ${t("inLabel")} · ${formatNumber(output)} ${t("outLabel")} · ${formatNumber(total)} ${t("totalLabel")}`],
				stats.cost > 0 && [t("costLabel"), formatCost(stats.cost)],
			]),
		);
		await view.showPanel("session", panel);
	},

	async compact(view, args) {
		await view.engine.request({ type: "compact", ...(args ? { customInstructions: args } : {}) });
	},

	async export(view, args) {
		const { path } = await view.engine.request({ type: "export_html", ...(args ? { outputPath: args } : {}) });
		view.app.toast(t("exported", path), "info", { sticky: true });
	},

	async copy(view) {
		const { text } = await view.engine.request({ type: "get_last_assistant_text" });
		if (!text) {
			view.app.toast(t("nothingToCopy"), "warning");
			return;
		}
		await navigator.clipboard.writeText(text);
		view.app.toast(t("copied"));
	},

	// The terminal's /import: its question, then the engine replaces this conversation's session.
	async import(view, args) {
		// The path as the terminal reads it: quoted, or up to the first space.
		const path = /^(["'])(.*?)\1/.exec(args)?.[2] ?? args.split(/\s/)[0];
		const { imported, message } = await view.engine.request({ type: "import_session", path });
		if (imported) await view.reload();
		view.app.toast(message, imported ? "info" : "warning");
	},

	// The terminal's /share: its upload and progress in the engine; the link comes back as a toast that stays.
	async share(view) {
		const { message, error } = await view.engine.request({ type: "share" });
		if (message) view.app.toast(message, error ? "error" : "info", { sticky: true });
	},

	async clone(view) {
		const { cancelled } = await view.engine.request({ type: "clone" });
		if (!cancelled) await view.reload();
	},

	async fork(view) {
		const { messages } = await view.engine.request({ type: "get_fork_messages" });
		if (!messages.length) {
			view.app.toast(t("nothingToFork"), "warning");
			return;
		}
		// The maintainer's decision of 2026-11-05: /clone is the last entry of /fork, as in the terminal.
		const whole = "prism:fork-whole-conversation";
		const entryId = await view.app.choose(view, "fork", t("forkTitle"), [
			...messages.map((m) => ({ value: m.entryId, label: m.text })),
			{ value: whole, label: t("forkWhole"), description: t("forkWholeDetail") },
		]);
		if (!entryId) return;
		if (entryId === whole) return builtins.clone(view);
		const { text, cancelled } = await view.engine.request({ type: "fork", entryId });
		if (cancelled) return;
		await view.reload();
		// As in the terminal, the chosen message comes back in the composer to be edited and sent again.
		view.app.setComposerText(text);
	},

	async model(view, args) {
		if (!args) return view.app.modelPicker(view);
		const wanted = args.toLowerCase();
		const match =
			view.models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === wanted) ??
			view.models.find((m) => m.id.toLowerCase() === wanted);
		if (!match) {
			view.app.toast(t("noSuchModel", args), "warning");
			return;
		}
		await view.setModel(match.provider, match.id);
	},

	async thinking(view, args) {
		if (!args) return view.app.thinkingPicker(view);
		if (!view.levels.includes(args)) {
			view.app.toast(t("noSuchLevel", args, view.levels.join(", ")), "warning");
			return;
		}
		await view.setThinking(args);
	},

	// the terminal's session selector (search, all folders, rename, delete) as the window's own screen.
	resume: sessionsScreen,
	// /sessions is the session-search module's command when it is on, and an alias of /resume otherwise (command-aliases.ts).
	sessions: sessionsScreen,

	// The terminal's help entries (the engine's, translated), in a filterable list: a key and what it does,
	// most frequent first. A command chosen in it comes back to the composer, as in the terminal.
	async help(view) {
		const { title, entries } = await view.engine.request({ type: "get_help" });
		const panel = new Panel({ title, kind: "help" });
		const list = new ListBox({
			items: entries.map((entry) => ({
				label: entry.action,
				meta: entry.key,
				description: [entry.state, entry.detail].filter(Boolean).join(" · "),
				value: entry.command,
				disabled: !entry.command,
			})),
			filter: "fuzzy",
			placeholder: t("filterHelp"),
			empty: t("noMatch"),
			onChoose: (item) => panel.done(item.value),
		});
		panel.setBody(list.el);
		const command = await view.showPanel("help", panel);
		if (command) view.app.setComposerText(`${command} `);
	},

	changelog: changelogScreen,

	async trust(view) {
		const { message } = await view.engine.request({ type: "trust" });
		if (message) view.app.toast(message);
	},

	tree: treeScreen,

	// The terminal's /settings in the window's Settings dialog, beside the window's own (settings-dialog.js).
	async settings(view) {
		view.app.settingsDialog.open();
	},

	// The terminal's /scoped-models as the engine's native screens (scoped-models-native.ts): each change applies
	// to the session's Ctrl+P cycle at once.
	async "scoped-models"(view) {
		await view.engine.request({ type: "scoped_models" });
	},

	// The terminal's /login and /logout as the engine's native screens (login-native.ts): the same menus, sign-in,
	// model chosen after it and checklist of the provider's models. Then the models and the state again: a login
	// adds models and may choose one, a logout may remove them.
	// From the phone app, `away`: a sign-in that needs the PC's browser only says to do it at the PC.
	async login(view, args) {
		const away = document.documentElement.dataset.device === "phone";
		await view.engine.request({ type: "login", ...(args ? { provider: args } : {}), ...(away ? { away: true } : {}) });
		await view.refreshResources();
	},

	async logout(view) {
		await view.engine.request({ type: "logout" });
		await view.refreshResources();
	},

	// Thinking and tool output together; expanded unless both already are (interactive-mode.ts, toggleExpandAll).
	async expand(view) {
		const expand = !view.toolsExpanded || !view.thinkingShown;
		if (Boolean(view.toolsExpanded) !== expand) view.toggleTools();
		if (Boolean(view.thinkingShown) !== expand) view.toggleThinking();
		view.app.toast(t(expand ? "expandedAll" : "collapsedAll"));
	},

	async quit(view) {
		await view.app.closeWindow();
	},

	// The terminal's /reload: the engine reads its settings, extensions, skills, prompts, themes and context
	// files again, in the same session (refused during a reply, as there); then what the window shows of them.
	async reload(view) {
		const { message, error } = await view.engine.request({ type: "reload" });
		await view.refreshResources();
		if (error) view.app.toast(error, "warning");
		view.app.toast(message);
	},
};

// Engine commands the window draws with its own screen, from the engine's data (screens.js), for the arguments
// it handles: /doctor export <path> and anything else still go to the engine.
const screens = {
	agents: (args) => (view) => agentsScreen(view, args),
	"lsp-setup": (args) => (view) => lspSetupScreen(view, args === "all"),
	checkpoints: () => (view) => checkpointsScreen(view),
	undo: () => (view) => checkpointsScreen(view, true),
	sent: (args) => (!args ? (view) => inspectorScreen(view, "sent") : undefined),
	// The terminal's /phone is the window's "Link a phone"; the phone app has no such screen.
	phone: () => (document.documentElement.dataset.device === "phone" ? undefined : (view) => phoneLinkScreen(view)),
	trace: (args) => (!args ? (view) => inspectorScreen(view, "trace") : undefined),
	// The engine's /state ignores its arguments: any of them opens the inspector.
	state: () => (view) => inspectorScreen(view, "state"),
	lsp: (args) => (!args || args === "all" ? (view) => inspectorScreen(view, "lsp") : undefined),
	docs: () => docsScreen,
	// Only /doctor export <path> runs in the engine; any other argument shows its report, as the engine does.
	doctor: (args) => (/^export\s+\S/.test(args) ? undefined : doctorScreen),
	"model-settings": () => modelSettingsScreen,
	context: () => contextScreen,
	// /perm and /perm window open the window's permissions screen; /perm scope opens it on what is in
	// effect, where the task scope is set. Other subcommands (mode, allow…) still run in the engine.
	bg: () => bgScreen,
	// the agent's desktop, live; /desktop stop still runs in the engine.
	desktop: (args) => (!args ? desktopScreen : undefined),
	files: () => (view) => filesScreen(view),
	sandbox: (args) => (!args ? (view) => sandboxScreen(view) : undefined),
	tutorial: () => tutorialScreen,
	schedule: () => scheduleScreen,
	sessions: () => sessionsScreen,
	// /budget time 30 and the like still run in the engine, and say the result in a toast.
	budget: (args) => (!args ? budgetScreen : undefined),
	// The engine reads only the first word: /perm help extra is /perm help.
	perm: (args) => {
		const sub = args.split(/\s+/)[0];
		return !sub || sub === "window" ? (view) => permScreen(view) : sub === "scope" ? (view) => permScreen(view, "active") : sub === "help" ? (view) => permScreen(view, "help") : undefined;
	},
};

/** The window's screen for an engine command run with `args`, or undefined to run it in the engine. */
export function screen(name, args) {
	return Object.hasOwn(screens, name) ? screens[name](args) : undefined;
}

/** The window's version of a terminal built-in, or undefined when it has none. */
export function builtin(name) {
	return Object.hasOwn(builtins, name) ? builtins[name] : undefined;
}

/**
 * fork: `/help`, the shortcuts and common actions in one filterable list, most
 * frequent first.
 *
 * There is no telemetry, so "most frequent" is an order set by hand: what a user does in every
 * session comes first (send, new line, interrupt, commands), then what they do daily (model,
 * thinking, tool output, copy, paste), then occasional actions and the editing details.
 */
import type { Keybinding, SelectItem } from "@earendil-works/pi-tui";
import { SelectSubmenu } from "../modes/interactive/components/settings-submenu.ts";
import { commandModule, type FeatureState, helpState } from "./feature-state.ts";
import { t } from "./i18n/index.ts";

/** One help entry: a key (or a command) and what it does. */
export interface HelpEntry {
	/** Key as displayed, or a typed prefix such as `/` or `!`. */
	key: string;
	action: string;
	/** Optional detail shown after the action. */
	detail?: string;
	/** Slash command put in the editor when the entry is chosen. */
	command?: string;
	/** fork: the state of the command's module when it is not on, shown before the action. */
	state?: string;
}

/** Key display for a keybinding id (`app.*` or `tui.*`). */
export type KeyDisplay = (id: Keybinding) => string;

/**
 * Entries in hand-set frequency order. `hasCommand` drops commands that do not exist in this session. fork
 * with `stateOf`, a command of a module that is off, unavailable or not supported by the model stays
 * listed, its detail saying which (for example `/undo` with the checkpoints module off).
 */
export function helpEntries(
	key: KeyDisplay,
	hasCommand: (name: string) => boolean,
	stateOf?: (module: string) => FeatureState,
): HelpEntry[] {
	const feature = (name: string, entry: HelpEntry): HelpEntry | false => {
		const module = commandModule(name);
		const state = module && stateOf ? helpState(stateOf(module)) : undefined;
		if (state) return { ...entry, state: state.label, detail: state.hint };
		return hasCommand(name) && entry;
	};
	const entries: (HelpEntry | false)[] = [
		// Every session.
		{ key: key("tui.input.submit"), action: "Send the message" },
		{ key: key("tui.input.newLine"), action: "New line in the message" },
		{ key: key("app.interrupt"), action: "Stop the agent", detail: "also closes menus and autocomplete" },
		{ key: "/", action: "Commands", detail: "type / to list them" },
		{ key: key("tui.input.tab"), action: "Complete a path or a command" },
		{
			key: `${key("tui.editor.cursorUp")} / ${key("tui.editor.cursorDown")}`,
			action: "Previous messages",
			detail: "in an empty editor",
		},
		{
			key: `${key("tui.editor.selectLeft")} / ${key("tui.editor.selectRight")}`,
			action: "Select text in the message",
			detail: "typing replaces it",
		},
		// Daily.
		{ key: key("app.model.select"), action: "Choose the model", command: "/model" },
		feature("bg", { key: key("app.background.tasks"), action: "Show background tasks", command: "/bg" }),
		{
			key: key("app.thinking.cycle"),
			action: "Change the thinking level",
			detail: "or click the level under the editor",
		},
		{ key: key("app.thinking.toggle"), action: "Show or hide thinking" },
		{ key: key("app.tools.expand"), action: "Show or hide tool output" },
		{ key: "/expand", action: "Expand thinking and tool output together", command: "/expand" },
		{ key: key("app.message.copy"), action: "Copy the selection or the last answer" },
		{ key: key("app.clipboard.pasteImage"), action: "Paste an image or files from the clipboard" },
		{ key: "!", action: "Run a shell command", detail: "its output goes to the agent; !! keeps it out" },
		{ key: key("app.message.followUp"), action: "Queue a message for when the agent is done" },
		feature("undo", {
			key: "/undo",
			action: "Undo the last turn's file changes",
			command: "/undo",
		}),
		{
			key: "/settings",
			action: "Settings, by domain; Tools opens permissions, models, language servers",
			command: "/settings",
		},
		// fork: the documentation, in Prism.
		hasCommand("docs") && { key: "/docs", action: "Read the documentation", command: "/docs" },
		hasCommand("perm") && {
			key: "/perm",
			action: "Choose when actions need your permission: ask, safe, broad or unrestricted",
			detail: "checks action patterns; does not isolate files or commands",
			command: "/perm",
		},
		// fork: Plan and Goal, also switched by clicking them under the editor.
		feature("plan", {
			key: "alt+p",
			action: "Plan mode on or off: explore and plan without changing files",
			detail: "or click plan under the editor",
			command: "/plan",
		}),
		feature("goal", {
			key: key("app.goal.menu"),
			action: "Goal: let the agent work until a goal is done",
			detail: "or click goal under the editor",
			command: "/goal",
		}),
		feature("files", {
			key: key("app.files.browse"),
			action: "Browse the project's files and add them to your message",
			detail: "or click files under the editor",
			command: "/files",
		}),
		{ key: "/resume", action: "Reopen a previous session", command: "/resume" },
		{ key: "/new", action: "Start a new session", command: "/new" },
		{ key: "/login", action: "Connect a model service or a local server", command: "/login" },
		// fork: the bottom bar's figures, abbreviated in the advanced interface.
		{ key: "↑ ↓", action: "Bottom bar: tokens sent to the model and received from it in this session" },
		{
			key: "R W",
			action: "Bottom bar: tokens read from and written to the provider's cache",
			detail: "advanced interface",
		},
		{
			key: "CH",
			action: "Bottom bar: share of the last request read from the cache",
			detail: "cheaper and faster when high",
		},
		{
			key: "12%/200k",
			action: "Bottom bar: how full the model's context is, out of its size",
			detail: "the tick on the gauge is where older messages get summarized",
		},
		{ key: "auto", action: "Bottom bar: older messages are summarized automatically", command: "/settings" },
		// Occasional.
		{ key: key("app.editor.external"), action: "Write the message in your editor" },
		{
			key: `${key("app.model.cycleForward")} / ${key("app.model.cycleBackward")}`,
			action: "Next or previous model",
		},
		{ key: key("app.message.dequeue"), action: "Take back queued messages" },
		{ key: "/tree", action: "Go back to an earlier point of the session", command: "/tree" },
		{
			key: "/compact",
			action: "Summarize older messages to make room within the model's limit",
			command: "/compact",
		},
		{ key: "/export", action: "Export the session (HTML)", command: "/export" },
		{ key: key("app.clear"), action: "Clear the editor", detail: "twice: exit" },
		{ key: key("app.exit"), action: "Exit", detail: "with an empty editor" },
		{ key: key("app.suspend"), action: "Suspend to the shell" },
		// Editing details.
		{
			key: `${key("tui.editor.cursorWordLeft")} / ${key("tui.editor.cursorWordRight")}`,
			action: "Move by word",
		},
		{ key: key("tui.editor.cursorLineStart"), action: "Start of line" },
		{ key: key("tui.editor.cursorLineEnd"), action: "End of line" },
		{ key: key("tui.editor.deleteWordBackward"), action: "Delete the previous word" },
		{ key: key("tui.editor.deleteWordForward"), action: "Delete the next word" },
		{ key: key("tui.editor.deleteToLineStart"), action: "Delete to the start of the line" },
		{ key: key("tui.editor.deleteToLineEnd"), action: "Delete to the end of the line" },
		{ key: key("tui.editor.undo"), action: "Undo in the editor" },
		{ key: key("tui.editor.redo"), action: "Redo in the editor" },
		{ key: key("tui.editor.yank"), action: "Paste the last deleted text" },
		{ key: key("tui.editor.yankPop"), action: "Cycle through deleted text after pasting" },
		{ key: key("tui.editor.jumpForward"), action: "Jump forward to a character" },
		{ key: key("tui.editor.jumpBackward"), action: "Jump backward to a character" },
		{ key: `${key("tui.editor.pageUp")} / ${key("tui.editor.pageDown")}`, action: "Scroll by page" },
	];
	return entries.filter((entry): entry is HelpEntry => entry !== false && entry.key.trim() !== "");
}

/** Select items for the list: the key on the left, the action and its detail on the right, in the interface language. */
export function helpItems(entries: HelpEntry[]): SelectItem[] {
	return entries.map((entry, index) => ({
		value: String(index),
		label: entry.key,
		description: `${entry.state ? `${t(entry.state)} · ` : ""}${entry.detail ? `${t(entry.action)} (${t(entry.detail)})` : t(entry.action)}`,
	}));
}

/** The /help list: choosing an entry gives its index, Escape cancels. */
export function helpSelector(
	entries: HelpEntry[],
	onChoose: (index: number) => void,
	onCancel: () => void,
): SelectSubmenu {
	return new SelectSubmenu(
		t("Help"), // fork: t()
		t("Most frequent first. Type to filter; Enter on a command puts it in the editor."),
		helpItems(entries),
		"",
		(value) => onChoose(Number(value)),
		onCancel,
		undefined,
		{
			searchable: true,
			// fork: a long action wraps under itself rather than being cut; column and height stay put.
			layout: { minPrimaryColumnWidth: 28, maxPrimaryColumnWidth: 28, wrapDescription: true },
			selectedDescription: true,
			stableHeight: true,
		},
	);
}

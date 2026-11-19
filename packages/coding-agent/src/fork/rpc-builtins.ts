/**
 * fork: the terminal's built-in commands that open a terminal component, for an RPC client.
 *
 * `/help`, `/changelog`, `/trust`, `/tree`, `/resume`, `/import` and `/share` are not commands of the engine: the interactive mode opens
 * its own selectors for them. Here the same components run in the engine through the views bridge
 * (`rpc-views.ts`), and what the user chose goes through the same engine calls as in the terminal
 * (`ProjectTrustStore`, `navigateTree`, the session's labels). Questions the terminal asks with its own
 * selectors (summarize the branch?) are asked with the session's dialogs, so the client shows them as any
 * other question. `clipboard_image` reads the image the system clipboard holds, as the terminal's paste key does,
 * for a window whose web view does not hand a pasted screenshot over.
 *
 * Commands: `show_help` → `{command?}`, `get_help` → `{title, entries: [{key, action, detail?, command?, state?}]}`
 * (the same entries as data, translated, for a client that draws its own list), `show_changelog`, `get_changelog` →
 * `{versions: [{title, markdown}]}` (its notes as data), `trust` → `{message?}`, `show_sessions` → `{path?}`,
 * `tree {entryId?}` → `{navigated, editorText?, message}`, `import_session {path}` → `{imported, message}`,
 * `share` → `{message, error?}`,
 * `get_scoped_models` → `{models: [{provider, id}]}` (the models of /scoped-models, in their Ctrl+P order, which the
 * window's model picker shows first as the terminal's does; empty when none is chosen),
 * `get_display` → `{hideThinkingBlock, mermaidRendering, autocompleteMaxVisible, interfaceMode}` (the settings of how the
 * conversation is drawn, which the window applies as the terminal does), `set_language {language?}` →
 * `{language}` (the language of the engine's texts: "en" or "fr" as the window chose, otherwise the
 * `language` setting as the terminal resolves it; for this process only, nothing is saved),
 * `ui_submit {toolCallId, choice | values}` → `{disposition}` (the answer to a generated UI, sent as the
 * `prompt` command sends a message; generated-ui.ts),
 * `files_read {path, offset?, length?}` → `{name, size, mtimeMs, offset, length, data, eof}` (a piece of a project, produced
 * or exported file, base64, for a client that is not on this machine; see `readForClient`),
 * `clipboard_image` → `{data, mimeType} | {}` (base64; `{}` when the clipboard holds no image),
 * `attach_files {paths}` and `clipboard_files {paths}` → `{attachments}` (file-attachments.ts: each an image, a
 * text, a path for the agent or an error; `clipboard_files` only for the files the system clipboard holds),
 * `get_turns {since?}` → `{turns: [{id, after, role, text}], last}` (the line the terminal draws at the end of each
 * turn, from the figures the Prism pack keeps in the session, on the current branch after the entry `since`;
 * `after` and `role` are the timestamp and role of the message the line follows in the session, `last` the branch's last entry,
 * the next `since`),
 * `session_preview {path}` → `{messages, turns} | {}` (another saved session's messages and turn lines, read without
 * opening it, for a client that shows it while its own engine starts; `{}` for a file it does not read as is),
 * `memory_get` → `{global: {path, text}, project: {path, text} | null}` (the memory files; the project's only in a trusted project),
 * `recent_projects` → `{folders}` (the project folders of the saved sessions, most recently used first, without this one),
 * `reload` → `{message, error?}` (the terminal's /reload: the same session reads its settings, extensions,
 * skills, prompts, themes and context files again; refused while a reply or a compaction runs, as there),
 * `get_footer` → `{pinned}` (the commands pinned to the terminal's footer that this session has),
 * `more_menu` → `{line?, pinned?}` (the footer's "more…" menu, asked with the session's dialogs: the chosen
 * command line for the client to run as typed, or the new pinned list after "Footer buttons…"),
 * `settings {domain?, item?, open?, layout?}` → `{line?, reloaded?}` (the terminal's /settings as native screens of the Prism
 * window, settings-native.ts: the command line a row ran, for the client to run as typed; `reloaded` after modules
 * turned on or off; `layout: "sections"` for the window's Settings dialog, which lists the domains itself).
 * `scoped_models` → `{}` (/scoped-models as native screens, scoped-models-native.ts),
 * `login {provider?, away?}`, `logout` → `{}` (/login and /logout as native screens, login-native.ts: the sign-in, the model
 * chosen after it and the checklist of the provider's models; what they tell goes to the session's notifications;
 * `away`: asked from the phone app, where a sign-in that needs this computer's browser only says so).
 * `sandbox_get`, `sandbox_set {setting, value}`, `sandbox_list {setting, action, text, key?, where?}`, `sandbox_check` →
 * `{state, error?}` (the settings of /settings › Permissions & sandbox as data, sandbox-panel.ts).
 * `sessions_list {all?}` → `{current, sessions}`, `sessions_search {query, all?}` → `{hits}`, `sessions_rename {path, name}`, `sessions_delete {path}` → `{method?, error?}`,
 * `schedule_get`, `schedule_preview {form}`, `schedule_create {form, fingerprint}`, `schedule_pause {task, paused}`, `schedule_remove {task}` →
 * `{state, summary?, fingerprint?, error?}` (/schedule as data, schedule-command.ts; `schedule_create` creates only the
 * task of the preview whose `fingerprint` it sends),
 * `budget_get`, `budget_set {kind, value | null}` → `{state, error?}` (/budget's limits as data, budgets.ts),
 * `tutorial_get` → `{state}`, `tutorial_progress {done, skipped}` → `{progress}` (/tutorial's modules as data, tutorial.ts).
 * `desktop_frame` → `{running: false} | {running: true, width, height, data, mimeType, pointer?}` (the agent's
 * desktop now, for the window's live view; it never starts it), `desktop_stop` → `{stopped}` (/desktop stop; desktop/index.ts).
 * `window_focus {focused}` → `{}` (whether the window is in front: desktop notifications only when it is not; notify.ts).
 * `sessions_stamp` → `{stamp}` (the folder's session file names in short: the phone's home reads `list_sessions` again
 * only when it changes).
 * The data of /tree and /doctor for a client's own screens: rpc-inspect.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Container, type EditorComponent, type TUI } from "@earendil-works/pi-tui";
import { APP_NAME, getSessionsDir } from "../config.ts";
import type { AgentSession } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../core/session-cwd.ts";
import { CURRENT_SESSION_VERSION, loadEntriesFromFile, SessionManager } from "../core/session-manager.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import { keyDisplayText } from "../modes/interactive/components/keybinding-hints.ts";
import { deleteSessionFile, SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { TreeSelectorComponent } from "../modes/interactive/components/tree-selector.ts";
import { TrustSelectorComponent } from "../modes/interactive/components/trust-selector.ts";
import { type ShareLoader, shareSession } from "../modes/interactive/session-share.ts";
import { getLanguageFromPath, highlightCode } from "../modes/interactive/theme/theme.ts";
import { getChangelogPath, normalizeChangelogLinks, parseChangelog } from "../utils/changelog.ts";
import { copyToClipboard, readClipboardFilePaths } from "../utils/clipboard.ts";
import { readClipboardImage } from "../utils/clipboard-image.ts";
import { openBrowser } from "../utils/open-browser.ts";
import { backgroundControl, backgroundStatusLabel, backgroundTasks, tail } from "./background.ts";
import { openRegularSync, readFdBounded } from "./bounded-read.ts";
import { IS_BRANDED_BUILD } from "./brand.ts";
import { budgetPanel } from "./budgets.ts";
import { CHANGELOG_READER_OVERLAY, changelogReader, getPrismChangelogPath, unwrapChangelog } from "./changelog.ts";
import { desktopView } from "./desktop/index.ts";
import { previewDocument } from "./document-preview.ts";
import { sessionFeatureStates } from "./feature-state.ts";
import { type Attachment, attachFile, attachTarget, fileNote } from "./file-attachments.ts";
import { exportedFilesOf, exportFile, listDirectory, openRefusal, producedFilesOf } from "./file-browser.ts";
import { submitAnswer } from "./generated-ui.ts";
import { saveGlobalSetting } from "./global-settings.ts";
import { helpEntries, helpSelector } from "./help.ts";
import { fill, getLanguage, resolveLanguage, setLanguage, t } from "./i18n/index.ts";
import { hasNativeMenus } from "./interactive-client.ts";
import { showNativeLogin, showNativeLogout } from "./login-native.ts";
import { memorySnapshot } from "./memory.ts";
import { setClientFocused } from "./notify.ts";
import { within } from "./path-within.ts";
import {
	exportSessionGrants,
	importSessionGrants,
	type Mode,
	type PermissionRuleChange,
	permissionsPanel,
} from "./permissions.ts";
import { customizeFooter, FOOTER_ACTIONS_SETTING, readFooterActions } from "./prism/footer-actions.ts";
import { CUSTOMIZE_FOOTER, chooseFromMoreMenu, moreMenuEntries } from "./prism/more-menu.ts";
import { TURN_ENTRY, type TurnFigures, turnText } from "./prism/turn-summary.ts";
import { producedState } from "./produced-files.ts";
import { realPath } from "./real-path.ts";
import { recentProjects } from "./recent-projects.ts";
import { documentationData } from "./rpc-docs.ts";
import { handleInspectCommand, INSPECT_COMMANDS } from "./rpc-inspect.ts";
import type { RpcViews } from "./rpc-views.ts";
import { changeSandboxList, sandboxPanelState, setSandboxField } from "./sandbox-panel.ts";
import { type ScheduleForm, schedulePanel } from "./schedule-command.ts";
import { showNativeScopedModels } from "./scoped-models-native.ts";
import { scopedModelsOperations } from "./scoped-models-operations.ts";
import { searchSessions } from "./session-search.ts";
import { runNativeSettings } from "./settings-native.ts";
import { shareNative } from "./share-native.ts";
import { chooseTrustNative } from "./trust-native.ts";
import { saveTutorialProgress, tutorialPanel } from "./tutorial.ts";

type Command = { id?: string; type: string; [key: string]: unknown };

const COMMANDS = new Set([
	"show_help",
	"recent_projects",
	"get_help",
	"show_changelog",
	"get_changelog",
	"get_docs",
	"trust",
	"tree",
	"show_sessions",
	"import_session",
	"share",
	"get_display",
	"memory_get",
	"get_scoped_models",
	"set_language",
	"ui_submit",
	"clipboard_image",
	"attach_files",
	"clipboard_files",
	"get_turns",
	"session_preview",
	"perm_export",
	"perm_import",
	"perm_get",
	"perm_mode",
	"perm_revoke",
	"perm_rule",
	"perm_sandbox",
	"perm_scope",
	"perm_scope_end",
	"sandbox_get",
	"sandbox_set",
	"sandbox_list",
	"sandbox_check",
	"tutorial_get",
	"tutorial_progress",
	"budget_get",
	"budget_set",
	"schedule_get",
	"schedule_preview",
	"schedule_create",
	"schedule_pause",
	"schedule_remove",
	"sessions_list",
	"sessions_stamp",
	"sessions_search",
	"sessions_rename",
	"sessions_delete",
	"bg_list",
	"bg_log",
	"bg_stop",
	"bg_clear",
	"desktop_frame",
	"desktop_stop",
	"window_focus",
	"files_list",
	"files_produced",
	"files_preview",
	"files_open",
	"files_export",
	"files_read",
	"reload",
	"get_footer",
	"more_menu",
	"settings",
	"scoped_models",
	"login",
	"logout",
]);

/** The session files of a folder, by name: changes when a conversation is created or deleted. */
function sessionsStamp(dir: string): string {
	try {
		const names = fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
		return `${names.length}:${names.at(-1) ?? ""}:${names[0] ?? ""}`;
	} catch {
		return "";
	}
}

/** The fork's built-in commands; `undefined` for any other command. */
export function handleBuiltinCommand(
	command: Command,
	session: AgentSession,
	host: Pick<AgentSessionRuntime, "services" | "importFromJsonl">,
	views: RpcViews,
	reload: () => Promise<void>,
): Promise<object> | undefined {
	if (!COMMANDS.has(command.type) && !INSPECT_COMMANDS.has(command.type)) return undefined;
	const respond = (data?: object) => ({
		id: command.id,
		type: "response",
		command: command.type,
		success: true,
		...(data ? { data } : {}),
	});
	const run = async (): Promise<object | undefined> => {
		if (INSPECT_COMMANDS.has(command.type)) return handleInspectCommand(command, session);
		switch (command.type) {
			case "show_help":
				return showHelp(session, views);
			case "get_help":
				return helpList(session);
			case "show_changelog":
				return showChangelog(views);
			case "get_changelog":
				return { versions: changelogVersions() };
			case "get_docs":
				return documentationData(command);
			case "trust":
				return showTrust(session, host.services.agentDir, views);
			case "tree":
				return showTree(session, views, typeof command.entryId === "string" ? command.entryId : undefined);
			case "show_sessions":
				return showSessions(session, views);
			case "import_session":
				return importSession(session, host, command);
			case "share":
				return share(session, views);
			case "reload":
				return reloadSession(session, reload);
			case "get_footer":
				return { pinned: pinnedCommands(session) };
			case "more_menu":
				return moreMenu(session, views);
			case "settings":
				return showSettings(session, reload, command);
			case "scoped_models":
				return showScopedModels(session);
			case "login":
				return showLogin(
					session,
					typeof command.provider === "string" ? command.provider : undefined,
					command.away === true,
				);
			case "logout":
				return showLogout(session);
			case "get_turns":
				return turns(
					session.sessionManager,
					session,
					typeof command.since === "string" ? command.since : undefined,
				);
			case "session_preview":
				return sessionPreview(session, command.path);
			// the window's "Choose a project folder" lists the folders worked in lately.
			case "recent_projects":
				return {
					folders: await recentProjects(path.join(host.services.agentDir, "sessions"), {
						exclude: session.sessionManager.getCwd(),
					}),
				};
			// the window keeps the session's in-memory grants while the engine sleeps (permissions.ts).
			case "perm_export":
				return { grants: exportSessionGrants(session.sessionManager) ?? null };
			case "perm_import":
				return { imported: importSessionGrants(session.sessionManager, command.grants) };
			// the window's permissions screen (permissions.ts, PermissionsPanel); each answer is the new state.
			case "perm_get":
			case "perm_mode":
			case "perm_revoke":
			case "perm_rule":
			case "perm_sandbox":
			case "perm_scope":
			case "perm_scope_end":
				return permissionsCommand(session, command);
			// the window's sandbox screen (sandbox-panel.ts); each answer is the new state.
			case "sandbox_get":
			case "sandbox_set":
			case "sandbox_list":
			case "sandbox_check":
				return await sandboxCommand(session, command);
			// the window's tutorial (tutorial.ts).
			case "tutorial_get":
				return { state: tutorialPanel(session.extensionRunner.createContext()) ?? null };
			case "tutorial_progress":
				return {
					progress: saveTutorialProgress({ done: command.done, skipped: command.skipped }),
				};
			// the window's budget screen (budgets.ts); each answer is the new state.
			case "budget_get":
			case "budget_set":
				return budgetCommand(session, command);
			// the window's scheduled tasks screen (schedule-command.ts); each answer is the new state.
			case "schedule_get":
			case "schedule_preview":
			case "schedule_create":
			case "schedule_pause":
			case "schedule_remove":
				return scheduleCommand(session, command);
			// the window's sessions screen: what the terminal's selector lists, renames and deletes.
			// fork: the phone's home asks often whether a conversation appeared or went away, which
			// only the folder's file names tell; reading every session file (`list_sessions`) is kept for when they change.
			case "sessions_stamp":
				return { stamp: sessionsStamp(session.sessionManager.getSessionDir()) };
			case "sessions_list":
			case "sessions_search":
			case "sessions_rename":
			case "sessions_delete":
				return sessionsCommand(session, command);
			// the window's background task screen (background.ts).
			case "bg_list":
			case "bg_log":
			case "bg_stop":
			case "bg_clear":
				return backgroundCommand(command);
			// the window's live view of the agent's desktop.
			case "desktop_frame":
			case "desktop_stop": {
				const view = desktopView();
				if (!view) throw new Error(t("The agent's desktop is off."));
				return command.type === "desktop_frame" ? view.frame() : { stopped: view.stop() };
			}
			// fork: desktop notifications only while the window is not in front (notify.ts).
			case "window_focus":
				setClientFocused(command.focused === true);
				return {};
			// the window's file explorer (file-browser.ts).
			case "files_list":
			case "files_produced":
			case "files_preview":
			case "files_open":
			case "files_export":
			case "files_read":
				return filesCommand(session, command);
			case "ui_submit":
				return submitAnswer(
					session,
					command.toolCallId,
					typeof command.choice === "number"
						? { choice: command.choice }
						: { values: command.values as Record<string, unknown> },
				);
			case "set_language": {
				const chosen = command.language;
				setLanguage(
					chosen === "en" || chosen === "fr" ? chosen : resolveLanguage(session.settingsManager.getLanguage()),
				);
				return { language: getLanguage() };
			}
			// files added to a message (file-attachments.ts). The window's host sends attach_files itself,
			// with the paths its file picker or a drop returned; the page cannot send it (attach.rs).
			case "attach_files":
				if (!Array.isArray(command.paths) || !command.paths.every((p) => typeof p === "string"))
					throw new Error("paths is required");
				return { attachments: command.paths.map((p) => forPage(attachFile(p, sessionTarget(session)))) };
			case "clipboard_files": {
				// The files a paste showed the page, attached only if the system clipboard holds the same ones.
				const seen = Array.isArray(command.paths) ? command.paths : [];
				const copied = (await readClipboardFilePaths()) ?? [];
				if (!seen.length || seen.length !== copied.length || seen.some((p, i) => p !== copied[i]))
					return { attachments: [] };
				return { attachments: copied.map((p) => forPage(attachFile(p, sessionTarget(session)))) };
			}
			case "get_scoped_models":
				// the window's picker listed every model, whatever /scoped-models chose.
				return { models: session.scopedModels.map(({ model }) => ({ provider: model.provider, id: model.id })) };
			// the window's side menu shows what the memory module adds to the prompt (memory.ts).
			case "memory_get":
				return memorySnapshot(
					session.sessionManager.getCwd(),
					session.extensionRunner.createContext().isProjectTrusted(),
				);
			case "get_display": {
				const settings = session.settingsManager;
				return {
					hideThinkingBlock: settings.getHideThinkingBlock(),
					mermaidRendering: settings.getMermaidRenderingMode(),
					autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
					// the window's side menu shows its logs view in the Advanced interface only.
					interfaceMode: settings.getInterfaceMode(),
				};
			}
			default:
				return clipboardImage();
		}
	};
	return run().then(respond);
}

async function showHelp(session: AgentSession, views: RpcViews): Promise<object> {
	const entries = sessionHelpEntries(session);
	const index = await views.custom<number | undefined>(
		(_tui, _theme, _keybindings, done) =>
			helpSelector(
				entries,
				(chosen) => done(chosen),
				() => done(undefined),
			),
		undefined,
	);
	// As in the terminal, a chosen command goes to the editor, not straight to the engine.
	const chosen = index === undefined ? undefined : entries[index]?.command;
	return chosen ? { command: chosen } : {};
}

function sessionHelpEntries(session: AgentSession) {
	return helpEntries(
		keyDisplayText,
		(name) => session.extensionRunner.getCommand(name) !== undefined,
		sessionFeatureStates(session),
	);
}

/** The help's entries as data, in the engine's language: the window draws them with its own list. */
function helpList(session: AgentSession): object {
	return {
		title: t("Help"),
		entries: sessionHelpEntries(session).map((entry) => ({
			key: entry.key,
			action: t(entry.action),
			...(entry.detail ? { detail: t(entry.detail) } : {}),
			...(entry.command ? { command: entry.command } : {}),
			...(entry.state ? { state: t(entry.state) } : {}),
		})),
	};
}

/** The release notes the terminal's reader shows (interactive-mode.ts, handleChangelogCommand), as text. */
function changelogTexts(): string[] {
	return parseChangelog(IS_BRANDED_BUILD ? getPrismChangelogPath() : getChangelogPath()).map((entry) =>
		IS_BRANDED_BUILD ? unwrapChangelog(entry.content) : normalizeChangelogLinks(entry.content, entry),
	);
}

/** the same notes for the window's own screen, one item per version: its heading and the rest. */
function changelogVersions(): Array<{ title: string; markdown: string }> {
	return parseChangelog(getPrismChangelogPath()).map((entry) => {
		const text = unwrapChangelog(entry.content);
		const [heading = "", ...rest] = text.split("\n");
		return { title: heading.replace(/^#+\s*/, "").replace(/[[\]]/g, ""), markdown: rest.join("\n").trim() };
	});
}

async function showChangelog(views: RpcViews): Promise<undefined> {
	const texts = changelogTexts();
	const markdown = texts.length > 0 ? texts.join("\n\n") : t("No changelog entries found.");
	await views.custom<void>(
		(tui, _theme, _keybindings, done) => changelogReader(markdown, tui, () => done(undefined)),
		{
			overlay: true,
			overlayOptions: CHANGELOG_READER_OVERLAY,
		},
	);
	return undefined;
}

async function showTrust(session: AgentSession, agentDir: string, views: RpcViews): Promise<object> {
	const cwd = session.sessionManager.getCwd();
	const trustStore = new ProjectTrustStore(agentDir);
	const savedDecision = trustStore.getEntry(cwd);
	const projectTrusted = session.settingsManager.isProjectTrusted();
	const ctx = session.extensionRunner.createContext();
	let trusted: boolean | undefined;
	if (hasNativeMenus(ctx)) {
		// the Prism window shows the same options as a native list.
		const selection = await chooseTrustNative(ctx, { cwd, savedDecision, projectTrusted });
		if (selection) {
			trustStore.setMany(selection.updates);
			trusted = selection.trusted;
		}
	} else
		trusted = await views.custom<boolean | undefined>(
			(_tui, _theme, _keybindings, done) =>
				new TrustSelectorComponent({
					cwd,
					savedDecision,
					projectTrusted,
					onSelect: (selection) => {
						trustStore.setMany(selection.updates);
						done(selection.trusted);
					},
					onCancel: () => done(undefined),
				}),
			undefined,
		);
	if (trusted === undefined) return {};
	return {
		message: fill(
			"Saved trust decision: {0}. Restart {1} for this to take effect.",
			t(trusted ? "trusted" : "untrusted"),
			APP_NAME,
		),
	};
}

/**
 * The terminal's /tree (interactive-mode.ts, showTreeSelector): the same selector, the same summary
 * question, then `navigateTree`. The client reloads the transcript when `navigated` is true.
 */
async function showTree(session: AgentSession, views: RpcViews, initialSelectedId?: string): Promise<object> {
	const sessionManager = session.sessionManager;
	const tree = sessionManager.getTree();
	if (tree.length === 0) return { navigated: false, message: t("No entries in session") };
	const ui = session.extensionRunner.createContext().ui;
	let selectedId = initialSelectedId;
	while (true) {
		const entryId = await views.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
			const selector = new TreeSelectorComponent(
				tree,
				sessionManager.getLeafId(),
				views.rows,
				(id) => done(id),
				() => done(undefined),
				(id, label) => sessionManager.appendLabelChange(id, label),
				selectedId,
				session.settingsManager.getTreeFilterMode(),
			);
			selector.onCopy = (text) => {
				if (!text) ui.notify(t("Selected entry has no text to copy"), "error");
				else
					copyToClipboard(text).then(
						() => ui.notify(t("Copied selected message to clipboard"), "info"),
						(error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"),
					);
			};
			return selector;
		}, undefined);
		if (entryId === undefined) return { navigated: false };
		if (entryId === sessionManager.getLeafId()) return { navigated: false, message: t("Already at this point") };
		selectedId = entryId;

		let summarize = false;
		let customInstructions: string | undefined;
		let back = false;
		if (!session.settingsManager.getBranchSummarySkipPrompt()) {
			const options = [t("No summary"), t("Summarize"), t("Summarize with custom prompt")];
			while (true) {
				const choice = await ui.select(t("Summarize branch?"), options);
				if (choice === undefined) {
					back = true; // Escape goes back to the tree, as in the terminal.
					break;
				}
				summarize = choice !== options[0];
				if (choice === options[2]) {
					customInstructions = await ui.editor(t("Custom summarization instructions"));
					if (customInstructions === undefined) continue;
				}
				break;
			}
		}
		if (back) continue;

		// The user committed to navigating: stop the active response first, as the terminal does.
		if (session.isStreaming) await session.abort();
		const result = await session.navigateTree(entryId, { summarize, customInstructions });
		if (result.aborted) {
			ui.notify(t("Branch summarization cancelled"), "info");
			continue;
		}
		if (result.cancelled) return { navigated: false, message: t("Navigation cancelled") };
		return {
			navigated: true,
			...(result.editorText ? { editorText: result.editorText } : {}),
			message: t("Navigated to selected point"),
		};
	}
}

/**
 * The terminal's /resume (interactive-mode.ts, showSessionSelector): the same selector, with its search,
 * all folders, renaming and deleting. The client opens the chosen session; the selector's quit key closes
 * the selector, the window has its own close.
 */
/** The saved sessions the screen acts on: only a file listed there can be renamed or deleted. */
async function sessionsCommand(session: AgentSession, command: Command): Promise<object> {
	const manager = session.sessionManager;
	const everywhere = () =>
		manager.usesDefaultSessionDir() ? SessionManager.listAll() : SessionManager.listAll(manager.getSessionDir());
	if (command.type === "sessions_list") {
		const sessions = await (command.all === true
			? everywhere()
			: SessionManager.list(manager.getCwd(), manager.getSessionDir()));
		return {
			current: manager.getSessionFile() ?? null,
			sessions: sessions.map((info) => ({
				path: info.path,
				cwd: info.cwd,
				name: info.name,
				firstMessage: info.firstMessage,
				modified: info.modified.toISOString(),
				messageCount: info.messageCount,
			})),
		};
	}
	if (command.type === "sessions_search") {
		const scope = command.all === true ? "all" : "project";
		// fork: the storage the list above reads, default or chosen.
		// An in-memory session has no folder of its own (""): the default storage, as SessionManager.listAll reads it.
		const sessionDir = manager.usesDefaultSessionDir() ? undefined : manager.getSessionDir() || undefined;
		const query = String(command.query ?? "");
		const { hits } = await searchSessions(query, scope, manager.getCwd(), 50, undefined, undefined, sessionDir);
		return { hits: hits.map((hit) => ({ path: hit.file.path, text: hit.text.replace(/\s+/g, " ").trim() })) };
	}
	const target = String(command.path ?? "");
	if (!(await everywhere()).some((info) => info.path === target))
		return { error: t("This session no longer exists.") };
	if (command.type === "sessions_rename") {
		const name = String(command.name ?? "").trim();
		if (!name) return { error: t("Type a name.") };
		SessionManager.open(target).appendSessionInfo(name);
		return {};
	}
	if (target === manager.getSessionFile()) return { error: t("This session is open: it cannot be deleted.") };
	const result = await deleteSessionFile(target);
	if (!result.ok) return { error: result.error ?? "Unknown error" };
	return { method: result.method };
}

async function showSessions(session: AgentSession, views: RpcViews): Promise<object> {
	const sessionManager = session.sessionManager;
	const sessionPath = await views.custom<string | undefined>(
		(tui, _theme, keybindings, done) =>
			new SessionSelectorComponent(
				(onProgress, signal) =>
					SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir(), onProgress, signal),
				(onProgress, signal) =>
					sessionManager.usesDefaultSessionDir()
						? SessionManager.listAll(onProgress, signal)
						: SessionManager.listAll(sessionManager.getSessionDir(), onProgress, signal),
				(chosen) => done(chosen),
				() => done(undefined),
				() => done(undefined),
				() => tui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						SessionManager.open(sessionFilePath).appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings,
				},
				sessionManager.getSessionFile(),
			),
		undefined,
	);
	return sessionPath ? { path: sessionPath } : {};
}

/**
 * The terminal's /import (interactive-mode.ts, handleImportCommand): the same question, then
 * `importFromJsonl`, which replaces the session of this engine. The client reloads when `imported`.
 */
async function importSession(
	session: AgentSession,
	host: Pick<AgentSessionRuntime, "importFromJsonl">,
	command: Command,
): Promise<object> {
	if (typeof command.path !== "string" || !command.path) throw new Error(t("Usage: /import <path.jsonl>"));
	const inputPath = command.path;
	const ui = session.extensionRunner.createContext().ui;
	const cancelled = { imported: false, message: t("Import cancelled") };
	if (!(await ui.confirm(t("Import session"), fill("Replace current session with {0}?", inputPath)))) return cancelled;
	let result: { cancelled: boolean };
	try {
		result = await host.importFromJsonl(inputPath);
	} catch (error) {
		// A missing file comes back as the command's error (SessionImportFileNotFoundError), as in the terminal.
		if (!(error instanceof MissingSessionCwdError)) throw error;
		if (!(await ui.confirm(t("Session cwd not found"), formatMissingSessionCwdPrompt(error.issue)))) return cancelled;
		result = await host.importFromJsonl(inputPath, error.issue.fallbackCwd);
	}
	if (result.cancelled) return cancelled;
	return { imported: true, message: fill("Session imported from: {0}", inputPath) };
}

/**
 * The terminal's /share (session-share.ts): the same upload, its progress and its cancel key in a view
 * that stands for the terminal's editor area. It answers with the terminal's last status or error line.
 */
async function share(session: AgentSession, views: RpcViews): Promise<object> {
	let result: { message: string; error?: true } = { message: "" };
	// Where the terminal puts its editor back when the upload ends: nothing to type into here.
	const editor: EditorComponent = {
		render: () => [],
		invalidate() {},
		getText: () => "",
		setText() {},
		handleInput() {},
	};
	const upload = (ui: TUI, editorContainer: Container, createLoader?: (message: string) => ShareLoader) =>
		shareSession({
			session,
			ui,
			editorContainer,
			editor,
			createLoader,
			showStatus: (message) => {
				result = {
					message: message
						.split("\n")
						.map((line) => t(line))
						.join("\n"),
				};
			},
			showError: (message) => {
				result = { message: t(message), error: true };
			},
		});
	const ctx = session.extensionRunner.createContext();
	if (hasNativeMenus(ctx)) {
		// The panel stands for the loader: no terminal to focus or draw.
		const ui = { setFocus() {}, requestRender() {} } as unknown as TUI;
		await shareNative(ctx, (createLoader) => upload(ui, new Container(), createLoader));
		return result;
	}
	await views.custom<void>((tui, _theme, _keybindings, done) => {
		const editorContainer = new Container();
		void upload(tui, editorContainer).finally(() => done(undefined));
		return editorContainer;
	}, undefined);
	return result;
}

const sessionTarget = (session: AgentSession) => attachTarget(session.sessionManager);

/** An attachment for the window, a file given as a path with the note its message carries. */
const forPage = (attachment: Attachment) =>
	attachment.kind === "file" ? { ...attachment, note: fileNote(attachment) } : attachment;

async function clipboardImage(): Promise<object> {
	const image = await readClipboardImage();
	return image ? { data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType } : {};
}

/**
 * The end-of-turn lines of the current branch, worded as the terminal words them (interface mode, language),
 * each with the message it follows: a ! command run during a reply is recorded after the turn's line but
 * started before it, so the messages' times alone do not place it.
 */
const extensionCommands = (session: AgentSession) =>
	new Set(session.extensionRunner.getRegisteredCommands().map((command) => command.name));

/** The pinned commands, in their order, that the "more…" menu offers in this session (as the footer shows them). */
function pinnedCommands(session: AgentSession): string[] {
	const available = new Set(moreMenuEntries(extensionCommands(session)).map((entry) => entry.command));
	return readFooterActions().filter((name) => available.has(name));
}

async function moreMenu(session: AgentSession, views: RpcViews): Promise<object> {
	const ui = session.extensionRunner.createContext().ui;
	const select = (title: string, options: string[]) => ui.select(title, options);
	const line = await chooseFromMoreMenu(select, extensionCommands(session));
	if (line !== CUSTOMIZE_FOOTER) return line ? { line } : {};
	await customizeFooter(select, extensionCommands(session), readFooterActions(), (names) => {
		try {
			saveGlobalSetting([FOOTER_ACTIONS_SETTING], names);
			// a pin shows in the footer at once, not only once the menu is closed.
			views.footerChanged(pinnedCommands(session));
			return true;
		} catch (error) {
			ui.notify(
				fill("Could not save the footer buttons: {0}", error instanceof Error ? error.message : String(error)),
				"error",
			);
			return false;
		}
	});
	return { pinned: pinnedCommands(session) };
}

/** The background tasks screen: the list, a task's output, stop, forget those that ended. */
function backgroundCommand(command: Command): object {
	const tasks = backgroundTasks();
	const control = backgroundControl();
	if (!tasks || !control) throw new Error(t("Background tasks are off."));
	let error: string | undefined;
	if (command.type === "bg_log") {
		const task = tasks.find((entry) => entry.id === command.task);
		if (!task) throw new Error(fill("No such task: {0}", String(command.task)));
		return { id: task.id, log: tail(task.logPath, BG_LOG_BYTES, t("(no output yet)")) };
	}
	if (command.type === "bg_stop") error = control.stop(String(command.task));
	if (command.type === "bg_clear") control.clear();
	return {
		tasks: (backgroundTasks() ?? []).map((task) => ({
			id: task.id,
			command: task.command,
			cwd: task.cwd,
			status: task.status,
			statusLabel: backgroundStatusLabel(task.status),
			exitCode: task.exitCode,
			startedAt: task.startedAt,
			endedAt: task.endedAt,
			timeoutSeconds: task.timeoutSeconds,
		})),
		...(error ? { error } : {}),
	};
}
/** The most entries a folder lists in the file explorer; the rest is counted. */
const FILES_MAX_ENTRIES = 2000;
/** The preview each session's file screen is waiting for. */
const stalePreviews = new WeakMap<AgentSession, AbortController>();

/**
 * The file explorer: the project's folders, the files produced in this session, a preview, opening with the
 * system's application (never a program or a script), a copy into a folder. Paths are the project's or produced.
 */
async function filesCommand(session: AgentSession, command: Command): Promise<object> {
	const ctx = session.extensionRunner.createContext();
	const root = path.resolve(ctx.cwd);
	const produced = producedFilesOf(ctx);
	const reachable = (target: unknown, exported = false): string => {
		if (typeof target !== "string" || target === "") throw new Error("No path.");
		const abs = path.resolve(root, target);
		// Real paths: a link in the project does not lead the explorer out of it.
		if (
			!within(realPath(abs), realPath(root)) &&
			!produced.some((file) => file.path === abs) &&
			!(exported && exportedFilesOf(ctx).includes(abs))
		)
			throw new Error(t("Only the project's files and the files Prism produced can be opened here."));
		return abs;
	};
	switch (command.type) {
		case "files_list": {
			const dir = reachable(typeof command.dir === "string" && command.dir !== "" ? command.dir : ".");
			const all = listDirectory(dir);
			const entries = all.slice(0, FILES_MAX_ENTRIES).map((entry) => {
				let size: number | undefined;
				let mtimeMs: number | undefined;
				try {
					const stat = fs.lstatSync(path.join(dir, entry.name));
					size = entry.dir ? undefined : stat.size;
					mtimeMs = stat.mtimeMs;
				} catch {
					// Gone since the listing: shown without its figures.
				}
				return { ...entry, size, mtimeMs };
			});
			return {
				root,
				dir: path.relative(root, dir).split(path.sep).join("/"),
				entries,
				more: Math.max(0, all.length - entries.length),
			};
		}
		case "files_produced":
			return {
				root,
				files: produced.map((file) => ({
					...file,
					state: producedState(file),
					relative: within(file.path, root) ? path.relative(root, file.path).split(path.sep).join("/") : undefined,
				})),
			};
		case "files_preview": {
			// fork: the screen shows one preview; a newer one stops the older's extraction.
			stalePreviews.get(session)?.abort();
			const controller = new AbortController();
			stalePreviews.set(session, controller);
			try {
				const preview = await previewDocument(reachable(command.path), { signal: controller.signal });
				const language = getLanguageFromPath(preview.path);
				// shortcut: colour files up to 64 KiB; use incremental highlighting for larger previews.
				const highlighted =
					preview.kind === "text" && language && preview.text !== undefined && preview.text.length <= 64_000
						? highlightCode(preview.text, language)
						: undefined;
				return { preview, highlighted };
			} finally {
				if (stalePreviews.get(session) === controller) stalePreviews.delete(session);
			}
		}
		case "files_open": {
			const abs = reachable(command.path);
			const refusal = openRefusal(abs);
			if (refusal) return { error: t(refusal) };
			openBrowser(abs);
			return {};
		}
		case "files_read":
			return readForClient(reachable(command.path, true), root, command.offset, command.length);
		case "files_export": {
			const abs = reachable(command.path);
			const answer = typeof command.folder === "string" ? command.folder.trim() : "";
			const folder = answer === "" ? os.homedir() : path.resolve(root, answer.replace(/^~(?=$|\/)/, os.homedir()));
			const result = exportFile(abs, folder);
			return "copy" in result ? { copy: result.copy } : { error: `${t(result.problem)} ${folder}` };
		}
	}
	return {};
}

/** fork (phone): the largest file `files_read` sends, as many bytes as an attachment copy (file-attachments.ts). */
export const MAX_READ_BYTES = 100 * 1024 * 1024;
/** The most one `files_read` answer carries: its base64 stays well under the client's line limit. */
export const MAX_READ_CHUNK = 3 * 1024 * 1024;

/**
 * `files_read {path, offset?, length?}` → `{name, size, mtimeMs, offset, length, data, eof}`: a piece of a file the
 * explorer may reach (`reachable`), in base64, for a client on another machine (the phone downloads files with it:
 * its "Open" and "Export" cannot act on this machine). It reads the real file, a regular one only, of at most
 * MAX_READ_BYTES, and never more than MAX_READ_CHUNK at a time; `size` and `mtimeMs` let the client see the file change.
 */
function readForClient(abs: string, root: string, offsetArg: unknown, lengthArg: unknown): object {
	const offset = offsetArg === undefined ? 0 : offsetArg;
	const wanted = lengthArg === undefined ? MAX_READ_CHUNK : lengthArg;
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
		throw new Error("offset must be a whole number.");
	if (typeof wanted !== "number" || !Number.isSafeInteger(wanted) || wanted < 1)
		throw new Error("length must be a whole number.");
	const length = Math.min(wanted, MAX_READ_CHUNK);
	// The project's file is opened by its real path, a produced or exported one outside the project by its own; neither
	// is followed once more, so a link put in place after the check leads nowhere.
	const real = realPath(abs);
	const { fd, stat } = openRegularSync(within(real, realPath(root)) ? real : abs, false);
	try {
		if (stat.size > MAX_READ_BYTES) throw new Error(`This file is larger than ${MAX_READ_BYTES / 1024 / 1024} MiB.`);
		if (offset > stat.size) throw new Error("offset is past the end of the file.");
		const { data } = readFdBounded(fd, Math.min(length, stat.size - offset), offset);
		return {
			name: path.basename(abs),
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			offset,
			length: data.length,
			data: data.toString("base64"),
			eof: offset + data.length >= stat.size,
		};
	} finally {
		fs.closeSync(fd);
	}
}

/** How much of a task's output the screen shows: its end, as /bg does, but more of it. */
const BG_LOG_BYTES = 64_000;

const PERM_MODES = new Set<string>(["safe", "ask", "broad", "unrestricted"]);
const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
	allowed.find((entry) => entry === value);

/** The permissions screen's operations; every answer carries the state after it, or why it was refused. */
async function permissionsCommand(session: AgentSession, command: Command): Promise<object> {
	const ctx = session.extensionRunner.createContext();
	const panel = permissionsPanel(ctx);
	if (!panel) throw new Error("The permission system is not loaded.");
	let error: string | undefined;
	switch (command.type) {
		case "perm_mode": {
			if (typeof command.mode !== "string" || !PERM_MODES.has(command.mode)) throw new Error("Unknown mode.");
			if (!(await panel.setMode(command.mode as Mode, command.asDefault === true)))
				error = t("Unrestricted mode not enabled.");
			break;
		}
		case "perm_revoke":
			if (!panel.revoke(Number(command.index), String(command.what ?? "")))
				error = t("This permission has already ended.");
			break;
		case "perm_rule": {
			const change: PermissionRuleChange | undefined =
				typeof command.rule === "string"
					? {
							action: pick(command.action, ["add", "remove"] as const) ?? "add",
							effect: pick(command.effect, ["allow", "ask", "deny"] as const) ?? "allow",
							rule: command.rule,
							where: pick(command.where, ["session", "project", "global"] as const) ?? "session",
						}
					: undefined;
			error = change ? await panel.rule(change) : "No rule.";
			break;
		}
		case "perm_sandbox": {
			const mode = pick(command.mode, ["safe", "ask", "broad", "unrestricted"] as const);
			if (!mode) throw new Error("Unknown mode.");
			error = await panel.sandbox(mode, command.on === true);
			break;
		}
		case "perm_scope":
			await panel.scope();
			break;
		case "perm_scope_end":
			panel.endScope();
			break;
	}
	return { state: panel.snapshot(), ...(error ? { error } : {}) };
}

/** The scheduled tasks screen's operations; every answer carries the state after it, or why it was refused. */
function scheduleCommand(session: AgentSession, command: Command): object {
	const ctx = session.extensionRunner.createContext();
	const panel = schedulePanel(ctx);
	if (!panel) throw new Error("Scheduled tasks are not available here.");
	const form = (typeof command.form === "object" && command.form !== null ? command.form : {}) as ScheduleForm;
	const id = String(command.task ?? "");
	let error: string | undefined;
	let summary: string | undefined;
	let fingerprint: string | undefined;
	if (command.type === "schedule_preview") ({ summary, error, fingerprint } = panel.preview(ctx, form));
	else if (command.type === "schedule_create")
		error = panel.create(ctx, form, typeof command.fingerprint === "string" ? command.fingerprint : undefined);
	else if (command.type === "schedule_pause") error = panel.pause(id, command.paused === true);
	else if (command.type === "schedule_remove") error = panel.remove(id);
	return {
		state: panel.snapshot(ctx),
		...(summary ? { summary } : {}),
		...(fingerprint ? { fingerprint } : {}),
		...(error ? { error } : {}),
	};
}

/** The budget screen's operations; every answer carries the state after it, or why it was refused. */
function budgetCommand(session: AgentSession, command: Command): object {
	const ctx = session.extensionRunner.createContext();
	const panel = budgetPanel(ctx);
	if (!panel) throw new Error("Budgets are not loaded.");
	let error: string | undefined;
	if (command.type === "budget_set") {
		const kind = pick(command.kind, ["time", "tools", "tokens", "cost"] as const);
		if (!kind) throw new Error("Unknown budget.");
		if (command.value !== null && typeof command.value !== "number") throw new Error("Invalid budget.");
		error = panel.set(ctx, kind, command.value);
	}
	return { state: panel.snapshot(ctx), ...(error ? { error } : {}) };
}

/** The sandbox screen's operations; every answer carries the state after it, or why it was refused. */
async function sandboxCommand(session: AgentSession, command: Command): Promise<object> {
	const panel = permissionsPanel(session.extensionRunner.createContext());
	if (!panel) throw new Error("The permission system is not loaded.");
	const settings = panel.settings();
	let error: string | undefined;
	try {
		if (command.type === "sandbox_set") await setSandboxField(settings, command.setting, command.value);
		else if (command.type === "sandbox_check") await settings.checkSandbox();
		else if (command.type === "sandbox_list") {
			const action = pick(command.action, ["add", "remove"] as const);
			if (!action || typeof command.text !== "string") throw new Error("Invalid change.");
			error = await changeSandboxList(settings, command.setting, {
				action,
				text: command.text,
				key: typeof command.key === "string" ? command.key : undefined,
				where: typeof command.where === "string" ? command.where : undefined,
			});
		}
	} catch (failure) {
		error = failure instanceof Error ? failure.message : String(failure);
	}
	return { state: sandboxPanelState(settings), ...(error ? { error } : {}) };
}

function turns(manager: SessionManager, session: AgentSession, since: string | undefined) {
	const branch = manager.getBranch();
	const from = since === undefined ? 0 : branch.findIndex((entry) => entry.id === since) + 1;
	const advanced = session.settingsManager.getInterfaceMode() === "advanced";
	const lines: Array<{ id: string; after?: number; role?: string; text: string }> = [];
	let message: { timestamp: number; role: string } | undefined;
	branch.forEach((entry, index) => {
		if (entry.type === "message") message = entry.message;
		else if (index >= from && entry.type === "custom" && entry.customType === TURN_ENTRY && entry.data) {
			const text = turnText(entry.data as TurnFigures, advanced);
			lines.push({ id: entry.id, after: message?.timestamp, role: message?.role, text });
		}
	});
	return { turns: lines, last: branch.at(-1)?.id };
}

/**
 * fork.10 (short conversations took seconds to open): what a saved session shows, read by an
 * engine already running while the session's own engine starts (about 2.5 s, most of it the engine's start). Only a
 * session file of the sessions folder, already at the current format: opening an older one rewrites it, which its own
 * engine does at the same time. Nothing is written.
 */
function sessionPreview(session: AgentSession, target: unknown): object {
	const manager = session.sessionManager;
	const custom = !manager.usesDefaultSessionDir() && manager.getSessionDir();
	const root = custom || getSessionsDir();
	if (typeof target !== "string" || !target.endsWith(".jsonl") || !within(realPath(target), realPath(root))) return {};
	const header = loadEntriesFromFile(target)[0];
	if (header?.type !== "session" || header.version !== CURRENT_SESSION_VERSION) return {};
	const preview = SessionManager.open(target);
	return { messages: preview.buildSessionProjection().messages, turns: turns(preview, session, undefined).turns };
}

/** The terminal's /reload, with its refusals and its messages. */
/** `/settings` in the Prism window; the terminal opens its own view. */
function showSettings(session: AgentSession, reload: () => Promise<void>, command: Command): Promise<object> {
	const ctx = session.extensionRunner.createContext();
	if (!hasNativeMenus(ctx)) throw new Error(t("/settings opens in the terminal or the Prism window."));
	const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	return runNativeSettings(
		session,
		ctx,
		reload,
		{ domain: text(command.domain), item: text(command.item), open: command.open === true },
		command.layout === "sections" ? "sections" : undefined,
	);
}

/** `/scoped-models` in the Prism window; the terminal opens its own selector. */
async function showScopedModels(session: AgentSession): Promise<object> {
	const ctx = session.extensionRunner.createContext();
	if (!hasNativeMenus(ctx)) throw new Error(t("/scoped-models opens in the terminal or the Prism window."));
	const operations = scopedModelsOperations(session, session.settingsManager, () => {});
	await showNativeScopedModels(ctx, operations, () => ctx.ui.notify(t("Model selection saved to settings"), "info"));
	return {};
}

/** `/login [provider]` in the Prism window; the terminal opens its own dialogs. */
async function showLogin(session: AgentSession, provider: string | undefined, away: boolean): Promise<object> {
	const ctx = session.extensionRunner.createContext();
	if (!hasNativeMenus(ctx)) throw new Error(t("/login opens in the terminal or the Prism window."));
	await showNativeLogin(ctx, session, provider?.trim() || undefined, away);
	return {};
}

/** `/logout` in the Prism window. */
async function showLogout(session: AgentSession): Promise<object> {
	const ctx = session.extensionRunner.createContext();
	if (!hasNativeMenus(ctx)) throw new Error(t("/logout opens in the terminal or the Prism window."));
	await showNativeLogout(ctx, session);
	return {};
}

async function reloadSession(session: AgentSession, reload: () => Promise<void>): Promise<object> {
	if (session.isStreaming) throw new Error(t("Wait for the current response to finish before reloading."));
	if (session.isCompacting) throw new Error(t("Wait for compaction to finish before reloading."));
	await reload();
	const modelsError = session.modelRuntime.getError();
	return {
		message: t("Reloaded keybindings, extensions, skills, prompts, themes, and context files"),
		...(modelsError ? { error: fill("Could not load model settings from models.json: {0}", modelsError) } : {}),
	};
}

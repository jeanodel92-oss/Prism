/**
 * fork: the editor's "/" and "@" completion, shared by the terminal and RPC mode (the Prism window).
 *
 * The list was built inside interactive-mode.ts; it moved here unchanged so both interfaces complete the
 * same commands (built-in, prompt templates, extension commands, skills, aliases), the same arguments and
 * the same files. In RPC mode, `complete` returns the suggestions for a text and its cursor, and
 * `apply_completion` the text once an item is chosen, so the window keeps no completion logic of its own.
 * Extensions' `addAutocompleteProvider` wrappers apply in both interfaces.
 *
 * Commands: `complete {text, cursor, typed?, open?, tab?}` → `{items, prefix, selected, mode}`, or
 * `{applied: {text, cursor}}` when a Tab completes a single path; `apply_completion {text, cursor, item,
 * prefix}` → `{text, cursor}`.
 */
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	autocompleteBoundaryRegex,
	autocompleteSeparatorRegex,
	CombinedAutocompleteProvider,
	cjkBreakRegex,
	fuzzyFilter,
	type SlashCommand,
} from "@earendil-works/pi-tui";
import type { AgentSession } from "../core/agent-session.ts";
import type { AutocompleteProviderFactory } from "../core/extensions/types.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.ts";
import { getSyntheticPathSource, type SourceInfo } from "../core/source-info.ts";
import { getModelSearchText } from "../modes/interactive/model-search.ts";
import { parseGitUrl } from "../utils/git.ts";
import { ensureTool } from "../utils/tools-manager.ts";
import { byCommandOrder, commandAliases } from "./command-aliases.ts";
import { addSandboxWritable } from "./host-program.ts";
import { t } from "./i18n/index.ts";

export function createFuzzyAutocompleteItems<T>(
	items: T[],
	prefix: string,
	getSearchText: (item: T) => string,
	toAutocompleteItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
	const filtered = fuzzyFilter(items, prefix, getSearchText);
	if (filtered.length === 0) return null;
	return filtered.map(toAutocompleteItem);
}

export function getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
	// Built-in extension commands are untagged, like built-in commands; so are Prism's own, loaded inline
	// (/sandbox, /perm, /docs… read "[t]" at the bottom of the list).
	if (!sourceInfo || sourceInfo.source === "builtin" || sourceInfo.path.startsWith("<inline:")) {
		return undefined;
	}

	const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
	const source = sourceInfo.source.trim();

	if (source === "auto" || source === "local" || source === "cli") {
		return scopePrefix;
	}

	if (source.startsWith("npm:")) {
		return `${scopePrefix}:${source}`;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		const ref = gitSource.ref ? `@${gitSource.ref}` : "";
		return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
	}

	return scopePrefix;
}

function prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
	const sourceTag = getAutocompleteSourceTag(sourceInfo);
	if (!sourceTag) {
		return description;
	}
	return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
}

export interface SessionAutocompleteOptions {
	session: AgentSession;
	settingsManager: Pick<SettingsManager, "getEnableSkillCommands">;
	cwd: string;
	fdPath: string | undefined;
	/** Filled with the skill commands listed, by name, for the terminal to run them. */
	skillCommands?: Map<string, string>;
	/** Arguments of /login: the terminal's sign-in providers. */
	loginCompletions?: (prefix: string) => AutocompleteItem[] | null;
	/** Extension commands left out of the list (the Prism window's, WINDOW_HIDDEN_COMMANDS). */
	hiddenCommands?: ReadonlySet<string>;
}

/**
 * Extension commands the Prism window does not offer: /llama stays in the
 * terminal. The window leaves the same names out of its command list (fork/gui/ui/js/session.js).
 */
export const WINDOW_HIDDEN_COMMANDS: ReadonlySet<string> = new Set(["llama"]);

/**
 * Commands the "/" list leaves out, in the terminal and the window, that still run when typed
 * rarely needed, or covered elsewhere (/clone is the last entry of /fork). /hotkeys is
 * gone from the terminal and the window: /help lists the keys.
 */
export const UNLISTED_COMMANDS: ReadonlySet<string> = new Set(["copy", "expand", "trace", "files", "sent", "clone"]);

/** The editor's completion for a session, before the extensions' wrappers. */
export function createSessionAutocompleteProvider(options: SessionAutocompleteOptions): AutocompleteProvider {
	const { session, settingsManager, cwd, fdPath, skillCommands, loginCompletions, hiddenCommands } = options;
	// Define commands for autocomplete
	const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.filter(
		(command) => !UNLISTED_COMMANDS.has(command.name),
	).map((command) => ({
		name: command.name,
		description: command.description,
		...(command.argumentHint && { argumentHint: command.argumentHint }),
	}));

	const modelCommand = slashCommands.find((command) => command.name === "model");
	if (modelCommand) {
		modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			const models =
				session.scopedModels.length > 0
					? session.scopedModels.map((s) => s.model)
					: session.modelRuntime.getAvailableSnapshot();

			if (models.length === 0) return null;

			// Create items with provider/id format
			const items = models.map((m) => ({
				id: m.id,
				provider: m.provider,
				name: m.name,
				label: `${m.provider}/${m.id}`,
			}));

			return createFuzzyAutocompleteItems(items, prefix, getModelSearchText, (item) => ({
				value: item.label,
				label: item.id,
				description: item.provider,
			}));
		};
	}

	const thinkingCommand = slashCommands.find((command) => command.name === "thinking");
	if (thinkingCommand) {
		thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			return createFuzzyAutocompleteItems(
				session.getAvailableThinkingLevels(),
				prefix,
				(level) => level,
				(level) => ({
					value: level,
					label: level,
				}),
			);
		};
	}

	const loginCommand = slashCommands.find((command) => command.name === "login");
	if (loginCommand && loginCompletions) {
		loginCommand.getArgumentCompletions = loginCompletions;
	}

	// Convert prompt templates to SlashCommand format for autocomplete
	const templateCommands: SlashCommand[] = session.promptTemplates.map((cmd) => ({
		name: cmd.name,
		description: prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
		...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
	}));

	// Convert extension commands to SlashCommand format
	const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
	const extensionCommands: SlashCommand[] = session.extensionRunner
		.getRegisteredCommands()
		.filter(
			(cmd) =>
				!builtinCommandNames.has(cmd.name) &&
				!hiddenCommands?.has(cmd.name) &&
				// Only Prism's own commands are unlisted (no file behind them); a user's extension of the same name stays.
				!(UNLISTED_COMMANDS.has(cmd.name) && getSyntheticPathSource(cmd.sourceInfo.path) !== undefined),
		)
		.map((cmd) => ({
			name: cmd.invocationName,
			description: prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			getArgumentCompletions: cmd.getArgumentCompletions
				? async (prefix: string) =>
						(await cmd.getArgumentCompletions!(prefix))?.map((item) => ({
							...item,
							...(item.description ? { description: t(item.description) } : {}),
						})) ?? null
				: undefined,
		}));

	// Build skill commands from session.skills (if enabled)
	skillCommands?.clear();
	const skillCommandList: SlashCommand[] = [];
	if (settingsManager.getEnableSkillCommands()) {
		for (const skill of session.resourceLoader.getSkills().skills) {
			const commandName = `skill:${skill.name}`;
			skillCommands?.set(commandName, skill.filePath);
			skillCommandList.push({
				name: commandName,
				description: prefixAutocompleteDescription(skill.description, skill.sourceInfo),
			});
		}
	}

	// fork: aliases find commands in the "/" list (src/fork/command-aliases.ts).
	// fork: descriptions in the interface language, read when the list is shown (fork/i18n).
	const withAliases = (command: SlashCommand): SlashCommand => {
		const { description } = command;
		const aliases = commandAliases(command.name);
		const shown = aliases ? { ...command, aliases } : { ...command };
		return description === undefined
			? shown
			: Object.defineProperty(shown, "description", { get: () => t(description), enumerable: true });
	};
	return new CombinedAutocompleteProvider(
		byCommandOrder([...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList]).map(
			withAliases,
		),
		cwd,
		fdPath,
	);
}

/** Wraps the provider with the extensions' factories, in order, collecting their trigger characters. */
export function wrapAutocompleteProvider(
	provider: AutocompleteProvider,
	wrappers: AutocompleteProviderFactory[],
): AutocompleteProvider {
	const triggerCharacters: string[] = [];
	for (const wrapProvider of wrappers) {
		provider = wrapProvider(provider);
		triggerCharacters.push(...(provider.triggerCharacters ?? []));
	}
	if (triggerCharacters.length > 0) {
		provider.triggerCharacters = [...new Set(triggerCharacters)];
	}
	return provider;
}

// The editor's trigger rule (packages/tui/src/components/editor.ts: insertCharacter, buildTriggerPattern):
// "/" on the first line, or a token that starts with a trigger character ("@", "#" or an extension's).
const DEFAULT_TRIGGER_CHARACTERS = ["@", "#"];
const unquotedSuffix = `(?:(?!${autocompleteSeparatorRegex.source}).)*`;
const tokenStart = `${autocompleteBoundaryRegex.source}[([{<\`]*`;

function triggerCharacters(provider: AutocompleteProvider): string[] {
	const extra = (provider.triggerCharacters ?? []).filter(
		(c) => c.length === 1 && c !== "/" && !/\s/.test(c) && !DEFAULT_TRIGGER_CHARACTERS.includes(c),
	);
	return [...DEFAULT_TRIGGER_CHARACTERS, ...extra];
}

function triggerPattern(characters: string[]): RegExp {
	const escaped = characters.map((c) => c.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&")).join("");
	return new RegExp(`${tokenStart}(?:@"[^"]*|[${escaped}]${unquotedSuffix})$`, "u");
}

/**
 * Whether the editor would open the list: `typed` is the character just typed, undefined after a deletion
 * (editor.ts, insertCharacter and the deletions).
 */
function wouldTrigger(
	provider: AutocompleteProvider,
	beforeCursor: string,
	firstLine: boolean,
	typed?: string,
): boolean {
	const characters = triggerCharacters(provider);
	const slash = firstLine && beforeCursor.trimStart().startsWith("/");
	const symbol = triggerPattern(characters).test(beforeCursor);
	if (typed === undefined) return slash || symbol;
	if (typed === "/") return firstLine && (beforeCursor.trim() === "" || beforeCursor.trim() === "/");
	if (characters.includes(typed)) return symbol;
	if (/[a-zA-Z0-9.\-_]/.test(typed) || cjkBreakRegex.test(typed)) return slash || symbol;
	return false;
}

type Command = { id?: string; type: string; [key: string]: unknown };

function position(text: string, cursor: number): { lines: string[]; line: number; col: number } {
	const before = text.slice(0, cursor).split("\n");
	return { lines: text.split("\n"), line: before.length - 1, col: before[before.length - 1].length };
}

function flatten(result: { lines: string[]; cursorLine: number; cursorCol: number }): { text: string; cursor: number } {
	const cursor = result.lines.slice(0, result.cursorLine).reduce((n, l) => n + l.length + 1, 0) + result.cursorCol;
	return { text: result.lines.join("\n"), cursor };
}

// The item the editor highlights first: the exact value, else the first that starts with the prefix
// (editor.ts, getBestAutocompleteMatchIndex).
function bestMatch(items: AutocompleteItem[], prefix: string): number {
	if (!prefix) return 0;
	const exact = items.findIndex((item) => item.value === prefix);
	return exact >= 0
		? exact
		: Math.max(
				0,
				items.findIndex((item) => item.value.startsWith(prefix)),
			);
}

/** RPC mode's completion: the session's provider with the extensions' wrappers, as in the terminal. */
export class RpcCompletion {
	private wrappers: AutocompleteProviderFactory[] = [];
	private fdPath: Promise<string | undefined> | undefined;
	// The list's search under way: a newer one, or complete_cancel (the window closed its list), stops it and its fd
	// walk.
	private searching: AbortController | undefined;

	/** The extensions are bound again: they add their wrappers again. */
	reset(): void {
		this.wrappers = [];
	}

	add(factory: AutocompleteProviderFactory): void {
		this.wrappers.push(factory);
	}

	handleCommand(command: Command, session: AgentSession): Promise<object> | undefined {
		if (command.type === "complete_cancel") {
			this.searching?.abort();
			this.searching = undefined;
			return Promise.resolve({ id: command.id, type: "response", command: command.type, success: true });
		}
		if (command.type !== "complete" && command.type !== "apply_completion") return undefined;
		const respond = (data: object) => ({
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			data,
		});
		return this.run(command, session).then(respond);
	}

	private async run(command: Command, session: AgentSession): Promise<object> {
		if (typeof command.text !== "string" || typeof command.cursor !== "number")
			throw new Error("text and cursor are required");
		// As the terminal, which finds or installs fd when it starts (interactive-mode.ts, ensureTool), never in the
		// project its sandboxed commands write.
		if (!this.fdPath) addSandboxWritable([session.sessionManager.getCwd()]);
		this.fdPath ??= ensureTool("fd").catch(() => undefined);
		const provider = wrapAutocompleteProvider(
			createSessionAutocompleteProvider({
				session,
				settingsManager: session.settingsManager,
				cwd: session.sessionManager.getCwd(),
				fdPath: await this.fdPath,
				hiddenCommands: WINDOW_HIDDEN_COMMANDS,
			}),
			this.wrappers,
		);
		const { lines, line, col } = position(command.text, Math.max(0, Math.min(command.cursor, command.text.length)));
		if (command.type === "apply_completion") {
			const item = command.item as AutocompleteItem | undefined;
			if (typeof item?.value !== "string" || typeof command.prefix !== "string")
				throw new Error("item and prefix are required");
			return flatten(provider.applyCompletion(lines, line, col, item, command.prefix));
		}
		// `open`: the list is shown ("regular", or "force" after a Tab on a path) and follows every edit;
		// `tab`: Tab completes a command on the first word of "/", a path elsewhere (editor.ts, handleTabCompletion).
		const beforeCursor = (lines[line] ?? "").slice(0, col);
		const tab = command.tab === true;
		let force = command.open === "force";
		if (tab)
			force = !(line === 0 && beforeCursor.trimStart().startsWith("/") && !beforeCursor.trimStart().includes(" "));
		else if (!command.open) {
			const typed = typeof command.typed === "string" ? command.typed : undefined;
			if (!wouldTrigger(provider, beforeCursor, line === 0, typed)) return { items: [] };
		}
		if (force && provider.shouldTriggerFileCompletion && !provider.shouldTriggerFileCompletion(lines, line, col))
			return { items: [] };
		this.searching?.abort();
		const searching = new AbortController();
		this.searching = searching;
		let suggestions: Awaited<ReturnType<typeof provider.getSuggestions>>;
		try {
			suggestions = await provider.getSuggestions(lines, line, col, { signal: searching.signal, force });
		} finally {
			if (this.searching === searching) this.searching = undefined;
		}
		if (searching.signal.aborted || !suggestions?.items.length) return { items: [] };
		// A Tab with a single path completes it at once (editor.ts, runAutocompleteRequest).
		if (tab && force && suggestions.items.length === 1)
			return {
				items: [],
				applied: flatten(provider.applyCompletion(lines, line, col, suggestions.items[0], suggestions.prefix)),
			};
		// Plain values: a description may be a getter that translates it.
		return {
			items: suggestions.items.map(({ value, label, description }) => ({
				value,
				label,
				...(description ? { description } : {}),
			})),
			prefix: suggestions.prefix,
			selected: bestMatch(suggestions.items, suggestions.prefix),
			mode: force ? "force" : "regular",
		};
	}
}

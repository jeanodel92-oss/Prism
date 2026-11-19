/**
 * fork: the terminal's keys for an RPC client (the Prism window).
 *
 * `get_keys` returns the app keybindings as the terminal resolves them (defaults plus keybindings.json), the
 * extension shortcuts and what a double Escape opens (`doubleEscapeAction`), so a client binds the same keys
 * without a table of its own. `run_shortcut` runs an
 * extension shortcut's handler as the terminal's editor does: with the session's own context, so the handler
 * goes through the same permissions and dialogs, and without holding the response until it finishes.
 * `toggle_plan` → `{toggled}` is the composer's Plan switch: the toggle the terminal's switch runs (the plan mode
 * module's bridge), with the session's context; `toggled: false` when that module has not loaded, and the
 * client then runs `/plan`, as the terminal does.
 */
import type { KeyId } from "@earendil-works/pi-tui";
import type { AgentSession } from "../core/agent-session.ts";
import { type AppKeybinding, KeybindingsManager } from "../core/keybindings.ts";
import { COMMAND_KEYS } from "./command-keys.ts";
import { t } from "./i18n/index.ts";
import { planBridge } from "./prism/index.ts";
import { GOAL_DONE_STATUSES, PLAN_ON_STATUSES } from "./prism/modes.ts";

// The transcript keys of the terminal's alternate screen that a client's transcript has too: search and the
// jumps between prompts. The other tui.* keys are the editor's and the selectors', which the client has its own.
const TRANSCRIPT_KEYS = [
	"tui.altScreen.search",
	"tui.altScreen.searchNext",
	"tui.altScreen.searchPrevious",
	"tui.altScreen.searchClose",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
] as const;

export function handleKeysCommand(
	command: { id?: string; type: string; [key: string]: unknown },
	session: AgentSession,
): object | undefined {
	const respond = (success: boolean, data?: object, error?: string) => ({
		id: command.id,
		type: "response",
		command: command.type,
		success,
		...(data ? { data } : {}),
		...(error ? { error } : {}),
	});
	if (command.type === "toggle_plan") {
		const bridge = planBridge();
		bridge?.toggle(session.extensionRunner.createContext());
		return respond(true, { toggled: Boolean(bridge) });
	}
	if (command.type !== "get_keys" && command.type !== "run_shortcut") return undefined;
	// Read on each request, as keybindings.json can change while the client is open.
	const keybindings = KeybindingsManager.create();
	const shortcuts = session.extensionRunner.getShortcuts(keybindings.getEffectiveConfig());
	if (command.type === "get_keys") {
		const commands = new Map<string, string>(COMMAND_KEYS);
		const bindings: Record<string, { keys: KeyId[]; description: string; command?: string }> = {};
		for (const id of Object.keys(keybindings.getEffectiveConfig())) {
			if (!id.startsWith("app.")) continue;
			const keybinding = id as AppKeybinding;
			const description = keybindings.getDefinition(keybinding).description;
			bindings[id] = {
				keys: keybindings.getKeys(keybinding),
				description: description ? t(description) : id,
				// A key that opens a fork command (alt+g → /goal): the client runs the command, as the terminal does.
				...(commands.has(id) ? { command: commands.get(id) } : {}),
			};
		}
		for (const id of TRANSCRIPT_KEYS)
			bindings[id] = {
				keys: keybindings.getKeys(id),
				description: t(keybindings.getDefinition(id).description ?? id),
			};
		return respond(true, {
			bindings,
			doubleEscapeAction: session.settingsManager.getDoubleEscapeAction(),
			// The Plan switch's key, as the terminal shows it beside the switch.
			planKey: planBridge()?.shortcut,
			// The plan statuses that mean the switch is on (the plan module words them in the interface language).
			planOn: PLAN_ON_STATUSES,
			// fork: the goal statuses that mean the goal is finished (the switch is off), in both languages.
			goalDone: GOAL_DONE_STATUSES,
			shortcuts: [...shortcuts].map(([key, shortcut]) => ({
				key,
				description: shortcut.description ? t(shortcut.description) : shortcut.extensionPath,
			})),
		});
	}
	const shortcut = typeof command.key === "string" ? shortcuts.get(command.key.toLowerCase() as KeyId) : undefined;
	if (!shortcut) return respond(false, undefined, `No extension shortcut ${String(command.key)}`);
	const runner = session.extensionRunner;
	Promise.resolve()
		.then(() => shortcut.handler(runner.createContext()))
		.catch((error: unknown) =>
			runner.emitError({
				extensionPath: shortcut.extensionPath,
				event: "shortcut",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	return respond(true);
}

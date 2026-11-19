/**
 * fork: keys that open a fork command, configurable in keybindings.json
 * like the built-in keys. A key does nothing when the module that registers its command is off.
 */
import type { AppKeybinding } from "../core/keybindings.ts";

export const COMMAND_KEYS: ReadonlyArray<readonly [AppKeybinding, string]> = [
	["app.goal.menu", "goal"],
	["app.files.browse", "files"],
	// fork: alt+j ran session.prompt("/bg") unchecked, so with the module off "/bg" went to the model.
	["app.background.tasks", "bg"],
];

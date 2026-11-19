// The terminal's keys in the window. The engine sends them (get_keys: its keybindings, keybindings.json
// included, and the extension shortcuts), so the window keeps no table of its own; here a key id of the
// terminal ("alt+enter", "shift+ctrl+p") is matched against a key event.

import { t } from "./i18n.js";

// The terminal's keys the window acts on, with the keys the engine sends (keybindings.json included). The
// others keep the window's meaning (Ctrl+C copies, Ctrl+V pastes).
export const COMPOSER_KEYS = ["app.message.followUp", "app.message.dequeue", "app.thinking.cycle"];
export const KEYS = [
	"app.interrupt",
	"app.panel.close",
	...COMPOSER_KEYS,
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.message.copy",
	"app.session.new",
	"app.session.fork",
	"app.session.resume",
	"app.session.tree",
	"tui.altScreen.search",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
];

const NAMES = { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", " ": "space" };

export function matches(event, id) {
	const parts = id.toLowerCase().split("+");
	const key = parts.pop();
	const mods = new Set(parts);
	if (event.ctrlKey !== mods.has("ctrl") || event.altKey !== mods.has("alt")) return false;
	if (event.metaKey !== (mods.has("super") || mods.has("meta"))) return false;
	const name = NAMES[event.key.toLowerCase()] ?? event.key.toLowerCase();
	if (name !== key) return false;
	// A symbol typed with Shift ("?") has no shift in its id; a letter or a named key does.
	return event.shiftKey === mods.has("shift") || (key.length === 1 && !/[a-z0-9]/.test(key));
}

/**
 * Which of `ids` (the bindings the window acts on, in order) or which extension shortcut the event is, if
 * any. Only those ids: the terminal reuses a key inside its selectors (Ctrl+P there toggles the path).
 */
export function boundAction(keys, ids, event) {
	for (const id of ids) {
		const binding = keys.bindings?.[id];
		if (binding?.keys.some((key) => matches(event, key))) return { id, binding };
	}
	const shortcut = (keys.shortcuts ?? []).find((s) => matches(event, s.key));
	return shortcut ? { shortcut } : undefined;
}

/** A key id as shown to the user, its key names in the window's language ("shift+enter" → "Maj+Entrée"). */
export function keyText(id) {
	return id
		.split("+")
		.map((part) => {
			const name = t(`key.${part.toLowerCase()}`);
			return name.startsWith("key.") ? part.charAt(0).toUpperCase() + part.slice(1) : name;
		})
		.join("+");
}

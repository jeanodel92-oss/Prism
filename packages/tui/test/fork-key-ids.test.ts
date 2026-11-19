/**
 * fork: key identifiers that the types and docs accept but that never matched,
 * or matched the wrong key.
 * - "+" and "ctrl++" split into an empty last part and were refused before looking at the input.
 * - any modified F1-F12 ("ctrl+f5") was refused whatever the terminal sent.
 * - an unknown modifier ("ctl+c") was ignored, so the binding fired on the bare key.
 */
import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { Key, matchesKey, setKittyProtocolActive } from "../src/keys.ts";

describe("fork: key identifiers", () => {
	afterEach(() => setKittyProtocolActive(false));

	it("matches the plus key, alone and with modifiers", () => {
		assert.strictEqual(matchesKey("+", Key.plus), true);
		assert.strictEqual(matchesKey("\x1b[43u", "+"), true);
		assert.strictEqual(matchesKey("\x1b[43;5u", Key.ctrl("+")), true);
		assert.strictEqual(matchesKey("\x1b[43;5u", "ctrl++"), true);
		assert.strictEqual(matchesKey("\x1b[43;3u", "alt++"), true);
		assert.strictEqual(matchesKey("\x1b[43;7u", "ctrl+alt++"), true);
		// The plus key never matches another key, and a bare modifier list is still refused.
		assert.strictEqual(matchesKey("=", "+"), false);
		assert.strictEqual(matchesKey("\x1b[43u", "ctrl++"), false);
		assert.strictEqual(matchesKey("+", "ctrl+" as never), false);
		assert.strictEqual(matchesKey("+", "++" as never), false);
	});

	it("matches modified F1-F12 in the xterm and kitty forms", () => {
		assert.strictEqual(matchesKey("\x1b[15;5~", Key.ctrl("f5")), true);
		assert.strictEqual(matchesKey("\x1b[1;2P", "shift+f1"), true);
		assert.strictEqual(matchesKey("\x1b[13;3~", "alt+f3"), true);
		assert.strictEqual(matchesKey("\x1b[1;3R", "alt+f3"), true);
		assert.strictEqual(matchesKey("\x1b[24;7~", "ctrl+alt+f12"), true);
		// Caps Lock in the modifier does not change the key; a key press with event type 1 still matches.
		assert.strictEqual(matchesKey("\x1b[15;69~", "ctrl+f5"), true);
		assert.strictEqual(matchesKey("\x1b[15;5:1~", "ctrl+f5"), true);
		// Wrong modifier, wrong key, release and the unmodified form are not ctrl+f5.
		assert.strictEqual(matchesKey("\x1b[15;2~", "ctrl+f5"), false);
		assert.strictEqual(matchesKey("\x1b[17;5~", "ctrl+f5"), false);
		assert.strictEqual(matchesKey("\x1b[15;5:3~", "ctrl+f5"), false);
		assert.strictEqual(matchesKey("\x1b[15~", "ctrl+f5"), false);
		assert.strictEqual(matchesKey("\x1b[15~", "f5"), true);

		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+f5" });
		assert.strictEqual(keybindings.matches("\x1b[15;5~", "tui.select.cancel"), true);
	});

	it("refuses a binding with an unknown modifier instead of firing on the bare key", () => {
		assert.strictEqual(matchesKey("c", "ctl+c" as never), false);
		assert.strictEqual(matchesKey("\x03", "ctl+c" as never), false);
		assert.strictEqual(matchesKey("\r", "meta+enter" as never), false);
		// Valid modifiers in any order still match.
		assert.strictEqual(matchesKey("\x03", "ctrl+c"), true);
		assert.strictEqual(matchesKey("\x1b[112;6u", "shift+ctrl+p"), true);
		assert.strictEqual(matchesKey("\x1b[112;6u", "ctrl+shift+p"), true);

		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctl+c" as never });
		assert.strictEqual(keybindings.matches("c", "tui.select.cancel"), false);
	});
});

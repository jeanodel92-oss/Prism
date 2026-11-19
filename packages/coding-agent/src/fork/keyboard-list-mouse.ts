/**
 * fork: mouse for a menu that only reads keys, such as the menus of the bundled Goal
 * and Plan plug-ins (pi-tui-kit): Goal and a finished Plan opened with a click but then had to be
 * driven with the keyboard. The menu is left untouched and
 * gets keys instead: the wheel sends the arrows, one option per notch; a click on an option moves
 * the selection there with the arrows, then sends Enter. The options are read from the menu's
 * rendered rows: the selected one starts with "→ " (pi-tui's SelectList), the others with two
 * spaces at the same column.
 */
import {
	type Component,
	getKeybindings,
	type Keybinding,
	type KeyId,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { stripAnsi } from "../utils/ansi.ts";

/** Input for the key ids a list binding is likely set to; anything else is not synthesized. */
const NAMED: Record<string, string> = {
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	enter: "\r",
	return: "\r",
	tab: "\t",
	space: " ",
	escape: "\x1b",
	esc: "\x1b",
	home: "\x1b[H",
	end: "\x1b[F",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
};

function encode(key: KeyId): string | undefined {
	if (key in NAMED) return NAMED[key];
	if (/^ctrl\+[a-z]$/.test(key)) return String.fromCharCode(key.charCodeAt(5) - 96);
	if (key.length === 1) return key;
	return undefined;
}

/**
 * fork: the input for a list action as the user's key bindings set it. Fixed
 * arrows no longer moved a menu whose bindings were changed, and the Enter that followed confirmed the option
 * still selected, not the one clicked. Undefined when no bound key can be synthesized: then the mouse does nothing.
 */
function keyFor(binding: Keybinding): string | undefined {
	const bindings = getKeybindings();
	for (const key of bindings.getKeys(binding)) {
		const data = encode(key);
		if (data !== undefined && bindings.matches(data, binding)) return data;
	}
	return undefined;
}

const POSITION = /^\s*\((\d+)\/(\d+)\)\s*$/;

interface OptionRows {
	selected: number;
	first: number;
	last: number;
	/** 1-based index and count from a "(3/12)" line, when the list scrolls. */
	position?: { index: number; count: number };
}

export function optionRows(lines: readonly string[]): OptionRows | undefined {
	const plain = lines.map((line) => stripAnsi(line));
	const selected = plain.findIndex((line) => /^\s*→ /.test(line));
	if (selected < 0) return undefined;
	const column = plain[selected]!.indexOf("→");
	const isOption = (line: string | undefined) =>
		line !== undefined &&
		line.slice(0, column).trim() === "" &&
		line.startsWith("  ", column) &&
		/\S/.test(line.charAt(column + 2)) &&
		!POSITION.test(line);
	let first = selected;
	while (isOption(plain[first - 1])) first--;
	let last = selected;
	while (isOption(plain[last + 1])) last++;
	const info = plain.slice(last + 1).find((line) => POSITION.test(line));
	const match = info ? POSITION.exec(info) : null;
	const position = match ? { index: Number(match[1]), count: Number(match[2]) } : undefined;
	return { selected, first, last, ...(position ? { position } : {}) };
}

/** Handle `event` (in the menu's own rows) for a menu that has no mouse support of its own. */
export function keyboardListMouse(menu: Component, event: TuiMouseEvent): TuiMouseEventResult | undefined {
	const send = menu.handleInput?.bind(menu);
	if (!send) return undefined;
	const rows = optionRows(menu.render(event.width));
	if (!rows) return undefined;
	const up = keyFor("tui.select.up");
	const down = keyFor("tui.select.down");
	const enter = keyFor("tui.select.confirm");
	if (event.type === "wheel" && event.wheelDelta) {
		const key = event.wheelDelta > 0 ? down : up;
		if (key === undefined) return undefined;
		const downward = event.wheelDelta > 0;
		// The arrows wrap around at the ends of the list; the wheel stops there.
		const atEnd = rows.position
			? downward
				? rows.position.index >= rows.position.count
				: rows.position.index <= 1
			: downward
				? rows.selected >= rows.last
				: rows.selected <= rows.first;
		if (!atEnd) send(key);
		return { handled: true };
	}
	if (event.button !== "left" || event.y < rows.first || event.y > rows.last) return undefined;
	const steps = event.y - rows.selected;
	const move = steps > 0 ? down : up;
	if (enter === undefined || (steps !== 0 && move === undefined)) return undefined;
	if (event.type === "press") return { handled: true };
	if (event.type !== "click") return undefined;
	for (let step = 0; step < Math.abs(steps); step++) send(move as string);
	send(enter);
	return { handled: true };
}

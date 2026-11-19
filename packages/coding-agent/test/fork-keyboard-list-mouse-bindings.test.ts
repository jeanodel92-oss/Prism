// fork: the mouse drives a keyboard-only menu with the keys the user's bindings
// set for list actions, so a click never confirms an option other than the one clicked.
import { type Component, SelectList, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { keyboardListMouse } from "../src/fork/keyboard-list-mouse.ts";
import { getSelectListTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

/** A menu without mouse support whose list reads the configured bindings, as the kit's menus do. */
class KeyboardMenu implements Component {
	readonly list: SelectList;
	chosen: string | undefined;
	constructor(count: number) {
		const items = Array.from({ length: count }, (_, index) => ({ value: `item${index}`, label: `Item ${index}` }));
		this.list = new SelectList(items, count, getSelectListTheme());
		this.list.onSelect = (item) => {
			this.chosen = item.value;
		};
	}
	render(width: number): string[] {
		return ["Title", "", ...this.list.render(width)];
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
	}
	invalidate(): void {}
}

const click = (y: number) =>
	({ type: "click", button: "left", x: 4, y, width: 60, shift: false, alt: false, ctrl: false }) as never;
const wheel = (delta: number) =>
	({ type: "wheel", wheelDelta: delta, x: 4, y: 3, width: 60, shift: false, alt: false, ctrl: false }) as never;

describe("keyboard-only menu mouse with custom list bindings", () => {
	beforeAll(() => initTheme("prism"));
	afterEach(() => setKeybindings(new KeybindingsManager({})));

	it("moves with the bound keys, then confirms the clicked option", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.up": "ctrl+k", "tui.select.down": "ctrl+j" }));
		const menu = new KeyboardMenu(4);
		// Rows: Title, blank, then the options from row 2; item0 is selected.
		keyboardListMouse(menu, click(4));
		expect(menu.chosen).toBe("item2");
		keyboardListMouse(menu, wheel(-1));
		keyboardListMouse(menu, click(2));
		expect(menu.chosen).toBe("item0");
	});

	it("does nothing rather than confirm another option when a move cannot be sent", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.down": "shift+ctrl+alt+f12" }));
		const menu = new KeyboardMenu(4);
		expect(keyboardListMouse(menu, click(4))).toBeUndefined();
		expect(menu.chosen).toBeUndefined();
	});
});

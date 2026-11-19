/**
 * fork: a click outside an open menu closes it: the file browser opened with a click, but
 * a click elsewhere left it open. Applies to the overlays
 * (file browser, /docs) and to the menus shown in place of the editor (/settings, /perm, Goal,
 * Plan). The press is consumed and the menu gets Esc, so it closes or goes back exactly as with the
 * keyboard. Only in fullscreen mode: the regular mode has no mouse reporting.
 *
 * Fork.9 QA: a question the model is waiting on (a permission, above all) is not such a menu. A click elsewhere, to
 * copy something or by accident as the question appears, must not answer it; only its own keys do.
 */
import type { Component, Container, TuiAltScreen } from "@earendil-works/pi-tui";

const ESC = "\x1b";

export function closeMenusOnOutsidePress(
	ui: TuiAltScreen,
	slot: Container,
	editor: () => Component,
	questionPending: () => boolean,
): void {
	ui.onPressOutside = ({ overlayFocused, inLayout }) => {
		if (questionPending()) return false;
		const focused = ui.getFocusedComponent();
		if (overlayFocused && focused?.handleInput) {
			focused.handleInput(ESC);
			return true;
		}
		const menu = slot.children[0];
		if (!menu || menu === editor() || inLayout(slot)) return false;
		// A menu often hands the keyboard to an inner view (the settings list inside its selector).
		const target = focused && focused !== editor() ? focused : menu;
		if (!target.handleInput) return false;
		target.handleInput(ESC);
		return true;
	};
}

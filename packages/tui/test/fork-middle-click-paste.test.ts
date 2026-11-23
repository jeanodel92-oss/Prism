/**
 * fork: full screen captures the mouse, so the terminal's own middle-click
 * paste never happens; a middle-button press calls onMiddleClickPaste instead (once, not on release or with Shift).
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("fork: middle-click paste", () => {
	it("calls onMiddleClickPaste on a middle press only", () => {
		const terminal = new VirtualTerminal();
		let pastes = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onMiddleClickPaste: () => {
				pastes += 1;
			},
		});
		try {
			tui.start();
			terminal.sendInput("\x1b[<1;3;2M");
			terminal.sendInput("\x1b[<1;3;2m");
			assert.strictEqual(pastes, 1);
			terminal.sendInput("\x1b[<5;3;2M"); // Shift: the terminal's own selection keys
			terminal.sendInput("\x1b[<0;3;2M");
			terminal.sendInput("\x1b[<0;3;2m");
			assert.strictEqual(pastes, 1);
		} finally {
			tui.stop();
		}
	});
});

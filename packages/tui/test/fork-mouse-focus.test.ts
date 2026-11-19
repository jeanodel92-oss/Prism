import assert from "node:assert";
import { describe, it } from "node:test";
import type { OverlayHandle, TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// fork: /settings > "Modes and permissions in effect" opened with a click, then /perm closed,
// left the composer deaf to the keyboard until a click in it. The click on the menu item closed /settings, then the
// click's own result focused the closed menu again; /perm remembered it and gave it the focus back on closing.

class Input {
	focused = false;
	inputs: string[] = [];
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	render(): string[] {
		return ["input"];
	}
	invalidate(): void {}
}

/** A menu whose item closes the menu on click, as /settings does before running a command. */
class ClosingMenu extends Input {
	handle?: OverlayHandle;
	onClose?: () => void;
	handleMouse(event: TuiMouseEvent) {
		if (event.type === "click") {
			this.handle?.hide();
			this.onClose?.();
		}
		return { handled: true, capture: event.type === "press", focus: true };
	}
	override render(): string[] {
		return ["menu item"];
	}
}

describe("mouse focus", () => {
	it("does not give the focus back to a menu its own click closed", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TuiAltScreen(terminal);
		const composer = new Input();
		tui.addChild(composer);
		tui.setFocus(composer);
		tui.start();
		await terminal.waitForRender();

		const menu = new ClosingMenu();
		menu.handle = tui.showOverlay(menu, { anchor: "top-left", row: 0, col: 0, width: 20 });
		await terminal.waitForRender();
		assert.strictEqual(tui.getFocusedComponent(), menu);

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(tui.getFocusedComponent(), composer);
		terminal.sendInput("a");
		await terminal.waitForRender();
		assert.deepStrictEqual(composer.inputs, ["a"]);
		tui.stop();
	});

	it("gives the focus back to the composer when the window the click opened closes", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TuiAltScreen(terminal);
		const composer = new Input();
		tui.addChild(composer);
		tui.setFocus(composer);
		tui.start();
		await terminal.waitForRender();

		const menu = new ClosingMenu();
		const window = new Input();
		let windowHandle: OverlayHandle | undefined;
		// The command runs after the click is handled, as session.prompt() does.
		menu.onClose = () => {
			queueMicrotask(() => {
				windowHandle = tui.showOverlay(window);
			});
		};
		menu.handle = tui.showOverlay(menu, { anchor: "top-left", row: 0, col: 0, width: 20 });
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(tui.getFocusedComponent(), window);

		windowHandle?.hide();
		terminal.sendInput("b");
		await terminal.waitForRender();
		assert.deepStrictEqual(composer.inputs, ["b"]);
		assert.deepStrictEqual(window.inputs, []);
		tui.stop();
	});
});

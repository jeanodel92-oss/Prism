import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// fork: selecting text in French flashed the English "Copied!"; the host app translates it.

describe("fork: copy flash in the interface language", () => {
	it("flashes the host's translation after a mouse selection", async () => {
		const terminal = new VirtualTerminal(30, 4);
		const tui = new TuiAltScreen(terminal, false, undefined, {
			copySelection: async () => true,
			translateFlash: (message) => (message === "Copied!" ? "Copié !" : message),
		});
		tui.addChild(new Text("alpha\nbeta", 0, 0));
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 20));

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await new Promise((resolve) => setTimeout(resolve, 50));

		const viewport = await terminal.flushAndGetViewport();
		assert.ok(
			viewport.some((line) => line.includes("Copié !")),
			viewport.join("\n"),
		);
		assert.ok(viewport.every((line) => !line.includes("Copied!")));
		tui.stop();
	});
});

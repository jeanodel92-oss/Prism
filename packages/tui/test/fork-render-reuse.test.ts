// fork: TuiMainScreen reuses the reset output of rows unchanged since the previous
// frame, and tracks which rows hold a Kitty image instead of scanning every row.
import assert from "node:assert";
import { describe, it } from "node:test";
import { deleteKittyImage, encodeKitty } from "../src/terminal-image.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

async function renderFrame(tui: TUI, terminal: LoggingVirtualTerminal, component: TestComponent, lines: string[]) {
	component.lines = lines;
	tui.requestRender();
	await terminal.waitForRender();
}

describe("fork: TuiMainScreen row reuse", () => {
	it("keeps normalizing a row that did not change", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = ["a\tb", "first"];
		tui.start();
		await terminal.waitForRender();

		await renderFrame(tui, terminal, component, ["a\tb", "second"]);
		await renderFrame(tui, terminal, component, ["a\tb", "third", "fourth"]);

		const viewport = await terminal.flushAndGetViewport();
		assert.deepStrictEqual(viewport.slice(0, 3), ["a   b", "third", "fourth"]);
		tui.stop();
	});

	it("still finds an image on a row reused from earlier frames", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 91, moveCursor: false });
		component.lines = [image, "", "one"];
		tui.start();
		await terminal.waitForRender();

		// The image row is unchanged here, so its output and its image flag come from the previous frame.
		await renderFrame(tui, terminal, component, [image, "", "two"]);
		terminal.clearWrites();

		// A row reserved by the image changes: the image must be deleted, then drawn again.
		await renderFrame(tui, terminal, component, [image, "covered", "two"]);

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(91));
		const drawIndex = writes.indexOf(image);
		assert.ok(deleteIndex >= 0, "image should be deleted when a reserved row changes");
		assert.ok(drawIndex > deleteIndex, "image should be redrawn after its placement is deleted");
		tui.stop();
	});
});

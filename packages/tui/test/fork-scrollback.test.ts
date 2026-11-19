// fork: in the main screen, a change to a line scrolled out of view must not clear
// the scrollback (`\x1b[3J`), which throws a scrolled-back terminal to the bottom and drops
// the user's selection while the model streams.
import assert from "node:assert";
import { describe, it } from "node:test";
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

const rows = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

describe("TuiMainScreen scrollback", () => {
	it("keeps the scrollback when only lines above the viewport change", async () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = rows(12);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const changed = rows(12);
		changed[1] = "header frame 2";
		await renderFrame(tui, terminal, component, changed);
		assert.strictEqual(terminal.getWrites(), "", "an off-screen change writes nothing");

		tui.stop();
	});

	it("redraws from the viewport without clearing the scrollback while content grows", async () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = rows(12);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const next = [...rows(12), "streamed 12", "streamed 13"];
		next[3] = "tool block done";
		await renderFrame(tui, terminal, component, next);
		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\x1b[3J"), "the scrollback is not cleared");
		assert.ok(!writes.includes("\x1b[2J"), "the screen is not cleared");
		const viewport = await terminal.flushAndGetViewport();
		assert.deepStrictEqual(
			viewport.map((line) => line.trimEnd()),
			["line 9", "line 10", "line 11", "streamed 12", "streamed 13"],
		);

		tui.stop();
	});

	it("still redraws fully when lines above the viewport are removed", async () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = rows(12);
		tui.start();
		await terminal.waitForRender();
		const fullRedraws = tui.fullRedraws;
		terminal.clearWrites();

		await renderFrame(
			tui,
			terminal,
			component,
			rows(11).filter((_, i) => i !== 2),
		);
		assert.strictEqual(tui.fullRedraws, fullRedraws + 1);

		tui.stop();
	});
});

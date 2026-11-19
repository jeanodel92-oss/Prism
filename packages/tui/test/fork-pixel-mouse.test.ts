// fork: pixel mouse reports make the fullscreen scrollbar drag finer than one track cell.
import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { pixelMouseReply, toCellMouseReport } from "../src/fork/pixel-mouse.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const CELL = { widthPx: 10, heightPx: 20 };

/** A 10x10 fullscreen scroll view of 50 lines: track of 10 cells, thumb of 2, 5 lines per cell. */
async function setup() {
	const terminal = new RecordingTerminal(10, 10);
	const tui = new TuiAltScreen(terminal);
	const scrollView = new ScrollView(
		new Text(Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
		{ primary: true, scrollbar: "always" },
	);
	tui.setLayoutRoot(scrollView);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, scrollView };
}

describe("fork: pixel mouse reports", () => {
	it("rewrites a pixel report as a cell report and keeps the exact row", () => {
		assert.deepStrictEqual(toCellMouseReport("\x1b[<0;96;26M", CELL), { data: "\x1b[<0;10;2M", row: 1.25 });
		assert.deepStrictEqual(toCellMouseReport("\x1b[<64;1;1m", CELL), { data: "\x1b[<64;1;1m", row: 0 });
		assert.deepStrictEqual(toCellMouseReport("a", CELL), { data: "a" });
		assert.strictEqual(pixelMouseReply("\x1b[?1016;1$y"), true);
		assert.strictEqual(pixelMouseReply("\x1b[?1016;0$y"), false);
		assert.strictEqual(pixelMouseReply("\x1b[?1006;1$y"), undefined);
	});

	it("drags the scrollbar by less than one track cell once the terminal confirms pixel reports", async () => {
		const { terminal, tui, scrollView } = await setup();
		terminal.sendInput(`\x1b[6;${CELL.heightPx};${CELL.widthPx}t`);
		await terminal.waitForRender();
		assert.ok(terminal.writes.some((data) => data.includes("\x1b[?1016h\x1b[?1016$p")));
		terminal.sendInput("\x1b[?1016;1$y");

		// Press on the thumb (top two cells), a quarter cell down.
		terminal.sendInput("\x1b[<0;96;6M");
		// One cell lower: 5 lines.
		terminal.sendInput("\x1b[<32;96;26M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 5);
		// A fifth of a cell more: one line, which cell reports cannot express.
		terminal.sendInput("\x1b[<32;96;30M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 6);
		terminal.sendInput("\x1b[<0;96;30m");

		tui.stop();
		assert.ok(terminal.writes.some((data) => data.includes("\x1b[?1016l")));
	});

	it("keeps cell reports when the terminal does not take pixel reports", async () => {
		const { terminal, tui, scrollView } = await setup();
		terminal.sendInput(`\x1b[6;${CELL.heightPx};${CELL.widthPx}t`);
		terminal.sendInput("\x1b[?1016;0$y");
		await terminal.waitForRender();
		assert.ok(terminal.writes.some((data) => data === "\x1b[?1016l"));

		terminal.sendInput("\x1b[<0;10;6M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 20);
		terminal.sendInput("\x1b[<0;10;6m");
		tui.stop();
	});

	// kitty reports a pointer above or left of the window with negative pixels.
	it("keeps a report from outside the window, on the edge cell", () => {
		assert.deepStrictEqual(toCellMouseReport("\x1b[<0;196;-120m", CELL), { data: "\x1b[<0;20;1m", row: 0 });
		assert.deepStrictEqual(toCellMouseReport("\x1b[<32;-15;26M", CELL), { data: "\x1b[<32;1;2M", row: 1.25 });
	});

	it("splits reports from outside the window into separate events, without waiting", () => {
		const buffer = new StdinBuffer({ timeout: 10_000 });
		const events: string[] = [];
		buffer.on("data", (sequence) => events.push(sequence));
		buffer.process("\x1b[<0;196;-120m\x1b[<288;196;-120M");
		assert.deepStrictEqual(events, ["\x1b[<0;196;-120m", "\x1b[<288;196;-120M"]);
		buffer.destroy();
	});

	it("stops a selection's auto-scroll when the button is released above the window", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		terminal.sendInput(`\x1b[6;${CELL.heightPx};${CELL.widthPx}t`);
		terminal.sendInput("\x1b[?1016;1$y");
		await terminal.waitForRender();
		const bottom = tui.viewportTop;

		// Press on the third row, drag to the top row, then out of the window, and release there.
		terminal.sendInput("\x1b[<0;5;46M");
		terminal.sendInput("\x1b[<32;5;6M");
		terminal.sendInput("\x1b[<32;5;-40M");
		await new Promise((resolve) => setTimeout(resolve, 130));
		terminal.sendInput("\x1b[<0;5;-40m");
		await terminal.waitForRender();
		const atRelease = tui.viewportTop;
		assert.ok(atRelease < bottom, `expected auto-scroll before the release, got ${atRelease}`);

		await new Promise((resolve) => setTimeout(resolve, 300));
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, atRelease);
		tui.stop();
	});
});

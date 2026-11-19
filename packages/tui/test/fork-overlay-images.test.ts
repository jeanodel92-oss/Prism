// fork: an inline image is not drawn over an open overlay (/context over a screenshot).
import assert from "node:assert";
import { describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { hideImagesUnderOverlays } from "../src/fork/overlay-images.ts";
import { encodeKitty, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const overlay = { render: () => ["overlay"], invalidate: () => {} };

describe("fork: images under overlays", () => {
	it("hides a Kitty image whose rows an overlay covers, and only that one", () => {
		const image = encodeKitty("AAAA", { columns: 2, rows: 3, imageId: 7, moveCursor: false });
		const lines = ["text", image, "", "", "after", image, "", ""];
		hideImagesUnderOverlays(lines, [{ start: 3, end: 4 }]);
		assert.strictEqual(lines[1], "", "the overlay covers the image's last row");
		assert.strictEqual(lines[5], image, "an image below the overlay stays");
	});

	it("hides an iTerm2 image drawn from the rows above its line", () => {
		const image = "\x1b[2A\x1b]1337;File=inline=1:AAAA\x07";
		const lines = ["", "", image, "below"];
		hideImagesUnderOverlays(lines, [{ start: 0, end: 1 }]);
		assert.strictEqual(lines[2], "");
	});

	it("deletes the image while the overlay is open and places it again once it closes", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const image = new Image(
				"A".repeat(64),
				"image/png",
				{ fallbackColor: (v) => v },
				{},
				{ widthPx: 10, heightPx: 10 },
			);
			tui.setLayoutRoot(
				new VStack([
					{ component: new Text("header", 0, 0), basis: "auto" },
					{ component: image, basis: "auto" },
				]),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.writes.join("").includes("\x1b_Ga=T"), "the image is drawn");

			let from = terminal.writes.length;
			const handle = tui.showOverlay(overlay, { anchor: "top-left", row: 1, col: 0, width: 10 });
			await terminal.waitForRender();
			const opened = terminal.writes.slice(from).join("");
			assert.ok(opened.includes("\x1b_Ga=d"), "its placement is deleted");
			assert.ok(!/\x1b_Ga=[pT]/.test(opened), "and not placed again under the overlay");

			from = terminal.writes.length;
			handle.hide();
			await terminal.waitForRender();
			assert.ok(/\x1b_Ga=[pT]/.test(terminal.writes.slice(from).join("")), "placed again once the overlay closes");
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});
});

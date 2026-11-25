// fork: a Container rebuilds its render from its first changed child, and the main screen skips the
// unchanged leading lines in its line resets and diff.
import assert from "node:assert";
import { describe, it } from "node:test";
import { Spacer } from "../src/components/spacer.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Returns the same array until set(), as a cached component does. */
class Cached implements Component {
	lines: string[];
	constructor(...lines: string[]) {
		this.lines = lines;
	}
	set(...lines: string[]): void {
		this.lines = lines;
	}
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

const long = (name: string) => [1, 2, 3, 4, 5, 6].map((n) => `${name}${n}`);

describe("fork: Container render prefix", () => {
	it("reuses the lines before the first changed child", () => {
		const container = new Container();
		const a = new Cached(...long("a"));
		const b = new Cached(...long("b"));
		const c = new Cached("c1");
		for (const child of [a, new Spacer(1), b, new Spacer(1), c]) container.addChild(child);

		const first = container.render(40);
		assert.strictEqual(container.renderPrefix.stable, 0);
		first[0] = "changed by the caller";

		c.set("c2");
		assert.deepStrictEqual(container.render(40), [...long("a"), "", ...long("b"), "", "c2"]);
		assert.strictEqual(container.renderPrefix.stable, 14);

		b.set(...long("B"));
		assert.deepStrictEqual(container.render(40), [...long("a"), "", ...long("B"), "", "c2"]);
		assert.strictEqual(container.renderPrefix.stable, 7);

		assert.deepStrictEqual(container.render(40), [...long("a"), "", ...long("B"), "", "c2"]);
		assert.strictEqual(container.renderPrefix.stable, 15);
	});

	it("extends the prefix into a nested container", () => {
		const inner = new Container();
		const kept = new Cached(...long("k"));
		const live = new Cached("live 1");
		inner.addChild(kept);
		inner.addChild(live);
		const outer = new Container();
		outer.addChild(new Cached("header"));
		outer.addChild(inner);
		outer.addChild(new Cached("footer"));

		outer.render(40);
		live.set("live 2", "more");
		assert.deepStrictEqual(outer.render(40), ["header", ...long("k"), "live 2", "more", "footer"]);
		assert.strictEqual(outer.renderPrefix.stable, 7);

		// The inner container rendered by someone else in between: its prefix no longer describes our last render.
		live.set("live 3");
		inner.render(40);
		live.set("live 4");
		assert.deepStrictEqual(outer.render(40), ["header", ...long("k"), "live 4", "footer"]);
		assert.strictEqual(outer.renderPrefix.stable, 1);
	});

	it("sees a long array rebuilt in place, and a child added or removed", () => {
		const container = new Container();
		const a = new Cached(...long("a"));
		const b = new Cached("b");
		container.addChild(a);
		container.addChild(b);
		container.render(40);

		a.lines[0] = "edited";
		assert.deepStrictEqual(container.render(40), ["edited", ...long("a").slice(1), "b"]);
		assert.strictEqual(container.renderPrefix.stable, 0);

		a.lines.push("a7");
		assert.deepStrictEqual(container.render(40), ["edited", ...long("a").slice(1), "a7", "b"]);
		assert.strictEqual(container.renderPrefix.stable, 0);

		container.removeChild(a);
		assert.deepStrictEqual(container.render(40), ["b"]);
		assert.strictEqual(container.renderPrefix.stable, 0);
	});

	it("does not trust the prefix of a container whose render edits its lines", () => {
		// As the /login selector's shimmer does: super.render(), then one line replaced in place.
		class Shimmer extends Container {
			frame = 0;
			override render(width: number): string[] {
				const lines = super.render(width);
				lines[3] = `frame ${this.frame}`;
				return lines;
			}
		}
		const shimmer = new Shimmer();
		shimmer.addChild(new Cached(...long("s")));
		const outer = new Container();
		outer.addChild(shimmer);
		outer.addChild(new Cached("after"));
		outer.render(40);
		outer.render(40);
		shimmer.frame = 1;
		assert.strictEqual(outer.render(40)[3], "frame 1");
		assert.strictEqual(outer.renderPrefix.stable, 0);
	});

	it("starts over when the width changes", () => {
		const container = new Container();
		container.addChild(new Cached(...long("a")));
		container.render(40);
		container.render(40);
		assert.strictEqual(container.renderPrefix.stable, 6);
		container.render(30);
		assert.strictEqual(container.renderPrefix.stable, 0);
	});
});

describe("fork: main screen with a render prefix", () => {
	it("paints only what changed, and a change above the screen after an outside render", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TuiMainScreen(terminal);
		const history = new Cached(...Array.from({ length: 5 }, (_, i) => `old ${i}`));
		const live = new Cached("live 1");
		tui.addChild(history);
		tui.addChild(live);
		tui.start();
		await terminal.waitForRender();

		live.set("live 2");
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).slice(0, 6), [
			"old 0",
			"old 1",
			"old 2",
			"old 3",
			"old 4",
			"live 2",
		]);

		// A render outside the frame loop must not let the next frame skip the history it changed.
		history.set(...Array.from({ length: 5 }, (_, i) => `new ${i}`));
		tui.render(40);
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).slice(0, 6), [
			"new 0",
			"new 1",
			"new 2",
			"new 3",
			"new 4",
			"live 2",
		]);
		tui.stop();
	});

	it("repaints the rows an overlay covered once it closes", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Cached(...Array.from({ length: 5 }, (_, i) => `old ${i}`)));
		tui.addChild(new Cached("live"));
		tui.start();
		await terminal.waitForRender();

		const handle = tui.showOverlay(new Cached("OVERLAY"), { anchor: "top-left", row: 1, col: 0, width: 20 });
		await terminal.waitForRender();
		assert.ok((await terminal.flushAndGetViewport()).some((line) => line.includes("OVERLAY")));

		handle.hide();
		await terminal.waitForRender();
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).slice(0, 6), [
			"old 0",
			"old 1",
			"old 2",
			"old 3",
			"old 4",
			"live",
		]);
		tui.stop();
	});
});

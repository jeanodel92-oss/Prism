// fork: the scroll and search lines of a stack used an endless viewport,
// and the painter ignored a parent's horizontal clip.
import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getScrollViewBox, renderLayoutFrame } from "../src/layout.ts";
import { stripTerminalSequences } from "../src/utils.ts";

const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

describe("fork: scroll lines and clipping follow the painted layout", () => {
	it("leaves out of the search lines an entry the layout hides at this height", () => {
		const scrollView = new ScrollView(
			new VStack([
				{ component: new Text("tall only", 0, 0), visible: (viewport) => viewport.height >= 100 },
				new Text("always", 0, 0),
			]),
		);
		const short = renderLayoutFrame(scrollView, 20, 24, () => {});
		assert.deepStrictEqual(plain(getScrollViewBox(short, scrollView)!.scrollContentLines!), ["always"]);
		assert.deepStrictEqual(plain(short.lines).filter(Boolean), ["always"]);
		// After a resize to a tall terminal, both are shown and searchable.
		const tall = renderLayoutFrame(scrollView, 20, 120, () => {});
		assert.deepStrictEqual(plain(getScrollViewBox(tall, scrollView)!.scrollContentLines!), ["tall only", "always"]);
	});

	it("does not paint a non-shrinking child past its parent's columns", () => {
		const root = new HStack([
			{
				component: new HStack([{ component: new Text("ABCDEFGH\nIJKLMNOP", 0, 0), basis: 8, shrink: 0 }]),
				basis: 4,
				shrink: 0,
			},
			{ component: new Text("R", 0, 0), basis: 4, shrink: 0 },
		]);
		const frame = renderLayoutFrame(new VStack([{ component: root, basis: 2 }]), 8, 2, () => {});
		assert.deepStrictEqual(plain(frame.lines), ["ABCDR", "IJKL"]);
	});
});

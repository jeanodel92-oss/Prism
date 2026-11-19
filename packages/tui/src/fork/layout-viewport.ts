// fork: the layout chooses a stack's visible entries with the real
// viewport, but the scroll and search lines come from the stack's own render, which used an endless viewport. An entry
// shown only on a tall terminal was then searchable and copyable on a short one. While a frame is laid out, the stacks
// render with that frame's viewport.
import type { LayoutViewport } from "../layout-node.ts";

let current: LayoutViewport | undefined;

/** The viewport of the frame being laid out, if any. */
export function layoutViewport(): LayoutViewport | undefined {
	return current;
}

/** Run `layout` with `viewport` as the viewport stacks render with. */
export function withLayoutViewport<T>(viewport: LayoutViewport, layout: () => T): T {
	const previous = current;
	current = viewport;
	try {
		return layout();
	} finally {
		current = previous;
	}
}

// ctrl+o and ctrl+t unfold or fold the tool details and thinking blocks on screen, as a click
// does (prism/transitions.ts). A block whose first row is above the screen changes at once: on the main screen,
// a block that shrinks above the viewport makes the terminal redraw everything, scrollback included, at each
// frame.
import type { Component } from "@earendil-works/pi-tui";
import { renderHooks } from "./render-hooks.ts";

/**
 * Starts the transition of each block whose first row is between `top` (included) and `bottom` (excluded), in
 * rows of the transcript the blocks make, in order. Call it before the blocks change.
 */
export function unfoldOnScreen(
	blocks: readonly Component[],
	width: number,
	top: number,
	bottom: number,
	ids: readonly ("tools" | "thinking")[],
): void {
	const unfold = renderHooks.unfold;
	if (!unfold) return;
	let row = 0;
	for (const block of blocks) {
		if (row >= bottom) return;
		// Rendering records the block's rows before the change, which the transition starts from.
		const height = block.render(width).length;
		if (row >= top) for (const id of ids) unfold(block, id);
		row += height;
	}
}

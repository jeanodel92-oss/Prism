import type { Component } from "../tui.ts";

/** Renders up to this many lines are compared by their ends even when rebuilt each frame (Spacer, a one-line call). */
const SHORT_RENDER = 2;
/** Arrays passed to one concat call, well under the engine's argument limit. */
const CONCAT_CHUNK = 4096;

/**
 * fork: a Container's render, which also counts how many leading lines are unchanged since its last
 * render (`stable`). Every frame renders the whole transcript, and the main screen compared each of its lines with
 * the previous frame's; with this count, its line resets and diff skip the unchanged lead. Reusing the previous
 * lines array instead of rebuilding it was measured slower: the copies of whole arrays cost more than the loop.
 *
 * A child counts as unchanged when it returns the same array as last time, with the same length and ends (a cached
 * render), or a short render with the same lines. A component that edits a middle line of the array it returned,
 * in place, is not seen: return a new array instead.
 */
export class RenderPrefix {
	/**
	 * The render whose lines `stable` describes (Container's own). A child whose render is another one (a subclass or
	 * an instance that edits what it returns) is judged by its lines only, never by its prefix.
	 */
	readonly plainRender: Component["render"];
	/** Bumped by each render. */
	serial = 0;
	/** How many leading lines of the last render equal those of the render before it (serial - 1). */
	stable = 0;
	private width = -1;
	// What each child returned at the last render, in parallel arrays overwritten in place each frame.
	private components: Component[] = [];
	private arrays: string[][] = [];
	private lengths: number[] = [];
	private firsts: Array<string | undefined> = [];
	private lasts: Array<string | undefined> = [];
	/** The child Container's own serial after that render, -1 for another component. */
	private serials: number[] = [];

	constructor(plainRender: Component["render"]) {
		this.plainRender = plainRender;
	}

	/** The returned heights are this object's own array: read them before the next render. */
	render(children: readonly Component[], width: number): { lines: string[]; heights: readonly number[] } {
		const count = children.length;
		let stable = 0;
		let open = width === this.width;
		for (let i = 0; i < count; i++) {
			const component = children[i]!;
			const own = (component as { renderPrefix?: RenderPrefix }).renderPrefix;
			const prefix = own && component.render === own.plainRender ? own : undefined;
			const serialBefore = prefix ? prefix.serial : -1;
			const lines = component.render(width);
			const length = lines.length;
			const first = lines[0];
			const last = lines[length - 1];
			const serial = prefix ? prefix.serial : -1;
			if (open) {
				if (this.components[i] !== component) {
					open = false;
				} else {
					const previousLength = this.lengths[i]!;
					const sameEnds = length === previousLength && first === this.firsts[i] && last === this.lasts[i];
					// A child Container rendered once since, by us: its own unchanged lead counts.
					const previousSerial = this.serials[i]!;
					const lead =
						prefix && previousSerial >= 0 && serialBefore === previousSerial && serial === previousSerial + 1
							? Math.min(prefix.stable, length, previousLength)
							: 0;
					if (
						(sameEnds && (lines === this.arrays[i] || length <= SHORT_RENDER)) ||
						(lead === length && lead === previousLength)
					) {
						stable += length;
					} else {
						open = false;
						stable += lead;
					}
				}
			}
			this.components[i] = component;
			this.arrays[i] = lines;
			this.lengths[i] = length;
			this.firsts[i] = first;
			this.lasts[i] = last;
			this.serials[i] = serial;
		}
		this.components.length = count;
		this.arrays.length = count;
		this.lengths.length = count;
		this.firsts.length = count;
		this.lasts.length = count;
		this.serials.length = count;

		// One builtin concat per chunk copies the lines faster than pushing them one by one.
		let out: string[] = [];
		for (let i = 0; i < count; i += CONCAT_CHUNK) out = out.concat(...this.arrays.slice(i, i + CONCAT_CHUNK));
		this.width = width;
		this.stable = stable;
		this.serial++;
		return { lines: out, heights: this.lengths };
	}
}

/** fork: a Container's mouse layout, built only when a mouse event reads it rather than on each frame. */
export function lazyMouseLayout(
	width: number,
	components: Component[],
	heights: number[],
): { width: number; children: Array<{ component: Component; height: number }> } {
	let children: Array<{ component: Component; height: number }> | undefined;
	return {
		width,
		get children() {
			children ??= components.map((component, index) => ({ component, height: heights[index]! }));
			return children;
		},
	};
}

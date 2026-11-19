// fork: light transitions of panels and of the blocks a click shows or hides.
//   • a panel shown over the screen (/settings, /files, /perm, /doctor, /docs, …) or in place of the editor (the
//     Goal and Plan menus, …) opens from its middle out and folds back before it goes, under the "menus" switch
//   • a tool's details or a thinking block shown or hidden by a click unfolds or folds, under the "tools" and
//     "thinking" switches
// A transition runs one 16 ms timer for its length only; none is armed, and nothing is recorded, while its
// switch is off. The global toggles (ctrl+o, ctrl+t) unfold the blocks on screen only (fork/unfold-on-screen.ts).
import type { Component } from "@earendil-works/pi-tui";
import { reveal } from "../animation-frames.ts";
import type { AnimationId } from "../animations.ts";
import type { RenderHooks } from "../render-hooks.ts";
import type { PrismState } from "./lib/state.ts";

export const PANEL_OPEN_MS = 180;
export const PANEL_CLOSE_MS = 120;
export const UNFOLD_MS = 180;

const ease = (p: number) => 1 - (1 - Math.max(0, p)) ** 3;

/** A panel `p` of the way open: its first and last rows, then the rows between them, from its middle out. */
export function curtain(lines: readonly string[], p: number): string[] {
	if (p >= 1) return [...lines];
	const keep = Math.min(lines.length, Math.max(2, Math.round(lines.length * ease(p))));
	const top = Math.ceil(keep / 2);
	return [...lines.slice(0, top), ...lines.slice(lines.length - (keep - top))];
}

/**
 * A block `p` of the way from `from` to `to`: the rows both share at the top and bottom stay, the rows between
 * grow or shrink from the old count to the new one.
 */
export function unfold(from: readonly string[], to: readonly string[], p: number): string[] {
	if (p >= 1) return [...to];
	let head = 0;
	while (head < from.length && head < to.length && from[head] === to[head]) head++;
	let tail = 0;
	while (
		tail < from.length - head &&
		tail < to.length - head &&
		from[from.length - 1 - tail] === to[to.length - 1 - tail]
	)
		tail++;
	const was = from.slice(head, from.length - tail);
	const now = to.slice(head, to.length - tail);
	const rows = Math.round(was.length + (now.length - was.length) * ease(p));
	return [
		...to.slice(0, head),
		...(now.length >= was.length ? now : was).slice(0, rows),
		...to.slice(to.length - tail),
	];
}

type TransitionHooks = Pick<RenderHooks, "panel" | "unfold" | "unfolding">;

export function transitionHooks(state: PrismState): TransitionHooks {
	let timer: ReturnType<typeof setInterval> | undefined;
	let until = 0;
	/** Redraws every 16 ms for `ms`, then once more so the last frame is the finished one. */
	const frames = (ms: number) => {
		until = Math.max(until, Date.now() + ms);
		if (timer) return;
		timer = setInterval(() => {
			state.requestRender();
			if (Date.now() < until) return;
			clearInterval(timer);
			timer = undefined;
		}, 16);
	};

	const drawn = new WeakMap<Component, { id: AnimationId; lines: string[] }>();
	const moving = new WeakMap<Component, { from: string[]; at: number }>();

	return {
		panel: (component, open) => {
			if (!state.animates("menus")) return undefined;
			const render = component.render.bind(component);
			let at = open ? Date.now() - PANEL_OPEN_MS : Date.now();
			let last: string[] = [];
			let closing = false;
			const draw = (lines: string[], p: number) => {
				const style = state.animationStyle("menus");
				return style === "wipe" || style === "slide" ? reveal(lines, p, style) : curtain(lines, p);
			};
			component.render = (width) => {
				const age = Date.now() - at;
				// Closing, the component may be disposed already: the panel folds its last rows.
				if (closing) return state.animates("menus") ? draw(last, 1 - age / PANEL_CLOSE_MS) : last;
				last = render(width);
				return age >= PANEL_OPEN_MS || !state.animates("menus") ? last : draw(last, age / PANEL_OPEN_MS);
			};
			if (!open) frames(PANEL_OPEN_MS);
			// fork: while it opens, the panel draws fewer or shifted rows than its
			// component lays out, so a click would act on another row than the one under the pointer: the mouse waits
			// for the opening to end. A press taken then is ignored up to its release and click, even after the end.
			const handleMouse = component.handleMouse?.bind(component);
			if (!open && handleMouse) {
				let ignoredPress = false;
				const opening = () => !closing && Date.now() - at < PANEL_OPEN_MS && state.animates("menus");
				component.handleMouse = (event) => {
					if (event.type === "press") ignoredPress = opening();
					const ofIgnoredPress =
						ignoredPress && (event.type === "drag" || event.type === "release" || event.type === "click");
					if (ofIgnoredPress || opening()) return { handled: true };
					return handleMouse(event);
				};
			}
			return {
				close: (hide) => {
					closing = true;
					at = Date.now();
					// A click on a panel that is going does nothing, not even a second press of the row that closed it.
					component.handleMouse = () => ({ handled: true });
					frames(PANEL_CLOSE_MS);
					setTimeout(hide, PANEL_CLOSE_MS);
				},
			};
		},
		unfold: (component, id) => {
			const before = drawn.get(component);
			if (!before || before.id !== id || !state.animates(id)) return;
			moving.set(component, { from: before.lines, at: Date.now() });
			frames(UNFOLD_MS);
		},
		unfolding: (component, id, lines) => {
			if (!state.animates(id)) {
				drawn.delete(component);
				return lines;
			}
			drawn.set(component, { id, lines });
			const move = moving.get(component);
			if (!move) return lines;
			const age = Date.now() - move.at;
			if (age < UNFOLD_MS) return unfold(move.from, lines, age / UNFOLD_MS);
			moving.delete(component);
			return lines;
		},
	};
}

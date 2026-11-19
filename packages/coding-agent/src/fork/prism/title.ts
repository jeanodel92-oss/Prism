// Terminal/tab title spinner while the agent works. Whatever title pi or other
// extensions set is remembered and only prefixed, then restored.

import { basename } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { APP_TITLE } from "../../config.ts";
import { indicator } from "../animation-frames.ts";
import type { PrismState } from "./lib/state.ts";

/** fork: exported for the preview in /settings. */
export const FRAMES = ["◐", "◓", "◑", "◒"];
const HOOKED = Symbol.for("pi-prism.title-hook");

export function createTitleSpinner(state: PrismState) {
	let terminal: Pick<Terminal, "setTitle"> | undefined;
	let setRaw: ((title: string) => void) | undefined;
	let last: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const fallback = () => {
		const sm = state.ctx?.sessionManager;
		const cwd = basename(sm?.getCwd?.() ?? state.ctx?.cwd ?? process.cwd());
		const name = sm?.getSessionName?.();
		return name ? `${APP_TITLE} - ${name} - ${cwd}` : `${APP_TITLE} - ${cwd}`;
	};

	return {
		attach(tui: { terminal: Pick<Terminal, "setTitle"> }) {
			const t = tui?.terminal as (Pick<Terminal, "setTitle"> & { [HOOKED]?: (title: string) => void }) | undefined;
			if (!t || typeof t.setTitle !== "function" || t === terminal) return;
			terminal = t;
			const original = t[HOOKED] ?? t.setTitle.bind(t);
			t[HOOKED] = original;
			setRaw = original;
			t.setTitle = (title: string) => {
				last = title;
				if (!timer) original(title);
			};
		},
		start() {
			if (!setRaw || timer || !state.animates("title")) return;
			let i = 0;
			const base = () => last ?? fallback();
			timer = setInterval(() => {
				if (!state.animates("title")) {
					setRaw?.(base());
					return;
				}
				const style = state.animationStyle("title");
				setRaw?.(`${style === "dots" ? indicator(style, Date.now()) : FRAMES[i++ % FRAMES.length]} ${base()}`);
			}, 160);
		},
		stop() {
			if (!timer) return;
			clearInterval(timer);
			timer = undefined;
			setRaw?.(last ?? fallback());
		},
	};
}

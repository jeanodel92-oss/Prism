// Welcome header: the pixel-art Prism logo
// , session facts
// on the right and key hints as text separated by ·.
// Implements setExpanded() so ctrl+o still toggles the full startup help.

import {
	backgroundAnsi,
	foregroundAnsi,
	rgbColor,
	sanitizeTerminalLabel,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { APP_NAME, VERSION } from "../../config.ts";
import { keyText } from "../../modes/interactive/components/index.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { AnimationStyle } from "../animations.ts";
import { APP_DISPLAY_NAME } from "../brand.ts";
import { t as translate } from "../i18n/index.ts";
import { pasteTargets } from "../paste-hint.ts";
import { homeRelative } from "../path-within.ts";
import { artPixel, LOGO_LARGE, LOGO_MINI, LOGO_SMALL, pixelKind } from "./art.ts";
import { isLightTheme, mix, paint, type RGB, tok } from "./lib/palette.ts";
import type { PrismState } from "./lib/state.ts";
import { renderHalfBlocks } from "./logo.ts";

// V2.34 intro, about 800 ms, then nothing moves: the glass fades in,
// the beam traces itself from the left, the entry point flashes, the edges light up from it, and the fan
// opens column by column, each pixel settling from white to its dark colour.
const GLASS_MS = 260;
const BEAM_FROM_MS = 120;
const BEAM_TO_MS = 400;
const SPARKLE_MS = 400;
const EDGE_FROM_MS = 400;
const EDGE_TO_MS = 640;
const SPECTRUM_FROM_MS = 520;
const SPECTRUM_TO_MS = 760;
export const INTRO_MS = 820;
/** A pixel that just appeared starts white and settles to its colour. */
const GLOW_MS = 140;

const WHITE: RGB = [255, 255, 255];

/** The logo for a header `width`: large from 100 columns, small from 64, mini below. */
export function logoFor(width: number): readonly string[] {
	return width >= 100 ? LOGO_LARGE : width >= 64 ? LOGO_SMALL : LOGO_MINI;
}

/** First and last column of each pixel kind in `map`, for the intro sweeps. */
function spans(map: readonly string[]) {
	const span = { beam: [Infinity, -1], spectrum: [Infinity, -1] };
	map.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) {
			const k = pixelKind(map, x, y);
			if (k !== "beam" && k !== "spectrum") continue;
			span[k][0] = Math.min(span[k][0]!, x);
			span[k][1] = Math.max(span[k][1]!, x);
		}
	});
	return span;
}

/** Where the beam enters the glass: the sparkle pixel, or the map's left middle without one. */
function entryOf(map: readonly string[]): [number, number] {
	for (let y = 0; y < map.length; y++) {
		const x = map[y]!.indexOf("x");
		if (x >= 0) return [x, y];
	}
	return [0, map.length / 2];
}

/** Distance in pixels from `from` to pixel (x, y), for the edges lighting up from the entry point. */
function distance(from: [number, number], x: number, y: number): number {
	return Math.hypot(x - from[0], y - from[1]);
}

/** The logo at `t` ms into the intro; past INTRO_MS, the final image. fork: also the preview in /settings. */
export function logoFrame(
	theme: Theme,
	map: readonly string[],
	t: number,
	style: AnimationStyle = "default",
): string[] {
	const light = isLightTheme(theme);
	const mode = theme.getColorMode();
	const ansi = ([r, g, b]: RGB, background: boolean) =>
		(background ? backgroundAnsi : foregroundAnsi)(rgbColor(Math.round(r), Math.round(g), Math.round(b)), mode);
	const done = t >= INTRO_MS;
	const span = spans(map);
	const entry = entryOf(map);
	const reach = done ? 1 : Math.max(1, ...map.flatMap((row, y) => [...row].map((_c, x) => distance(entry, x, y))));
	const page: RGB = light ? [255, 255, 255] : [0, 0, 0];
	// Pixels appear at `at` ms and glow white for GLOW_MS.
	const arrive = (c: RGB, at: number): RGB | undefined => {
		const age = t - at;
		if (age < 0) return undefined;
		return age < GLOW_MS ? mix(c, light ? c : WHITE, 1 - age / GLOW_MS) : c;
	};
	const sweep = (x: number, [from, to]: number[], start: number, end: number) =>
		start + ((x - from!) / Math.max(1, to! - from!)) * (end - start);
	const pixel = (x: number, y: number): RGB | undefined => {
		const c = artPixel(map, x, y, light);
		if (!c || done) return c;
		if (style === "wipe") return x / Math.max(1, map[y]!.length - 1) <= t / INTRO_MS ? c : undefined;
		if (style === "dissolve") return ((x * 17 + y * 31) % 101) / 101 <= t / INTRO_MS ? c : undefined;
		switch (pixelKind(map, x, y)) {
			case "glass":
				return t >= GLASS_MS ? c : mix(page, c, t / GLASS_MS);
			case "beam":
				return arrive(c, sweep(x, span.beam, BEAM_FROM_MS, BEAM_TO_MS));
			case "edge":
				return arrive(c, EDGE_FROM_MS + (distance(entry, x, y) / reach) * (EDGE_TO_MS - EDGE_FROM_MS));
			case "spectrum":
				return arrive(c, sweep(x, span.spectrum, SPECTRUM_FROM_MS, SPECTRUM_TO_MS));
			case "sparkle":
				return arrive(c, SPARKLE_MS);
			default:
				return c;
		}
	};
	return renderHalfBlocks(
		map,
		pixel,
		(c) => ansi(c, false),
		(c) => ansi(c, true),
	);
}

/** `animate` false draws the final logo at once, without a timer. */
export function createHeaderFactory(state: PrismState, animate: boolean) {
	return (tui: Pick<TUI, "requestRender">) => new PrismHeader(tui, state, animate);
}

class PrismHeader {
	private expanded = false;
	private readonly born = Date.now();
	private timer?: ReturnType<typeof setInterval>;

	private readonly tui: Pick<TUI, "requestRender">;
	private readonly state: PrismState;

	private readonly animate: boolean;

	constructor(tui: Pick<TUI, "requestRender">, state: PrismState, animate: boolean) {
		this.tui = tui;
		this.state = state;
		this.animate = animate;
		if (!animate) return;
		this.timer = setInterval(() => {
			if (Date.now() - this.born > INTRO_MS) this.stop();
			this.tui.requestRender();
		}, 33);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	dispose(): void {
		this.stop();
	}

	private stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	render(width: number): string[] {
		const theme = this.state.theme;
		if (!theme) return [];
		const t = this.animate ? Date.now() - this.born : INTRO_MS;
		const map = logoFor(width);
		const logoW = map[0]!.length;
		const logo = this.logo(map, t);
		const info = this.info(width - logoW - 4);
		// Info lines centred against the logo's height.
		const top = Math.max(0, Math.floor((logo.length - info.length) / 2));
		const lines: string[] = [];
		const rows = Math.max(logo.length, top + info.length);
		for (let i = 0; i < rows; i++) {
			const left = ` ${logo[i] ?? " ".repeat(logoW)}   `;
			lines.push(truncateToWidth(left + (info[i - top] ?? ""), width, ""));
		}
		lines.push("");
		if (this.expanded) {
			lines.push(...this.fullHelp(width));
			lines.push("");
		} else {
			lines.push(
				...this.note(
					translate(`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`),
					width,
				),
			);
		}
		lines.push(
			...this.note(
				translate(
					`${APP_DISPLAY_NAME} can explain its own features and look up its docs. Ask it how to use or extend ${APP_DISPLAY_NAME}.`,
				),
				width,
			),
		);
		return lines;
	}

	private note(text: string, width: number): string[] {
		const theme = this.state.theme!;
		return wrapTextWithAnsi(text, Math.max(1, width - 2)).map((l) => ` ${theme.fg("dim", l)}`);
	}

	private logo(map: readonly string[], t: number): string[] {
		return logoFrame(this.state.theme!, map, t, this.state.animationStyle("intro"));
	}

	private info(width: number): string[] {
		const theme = this.state.theme!;
		let model: NonNullable<PrismState["ctx"]>["model"];
		try {
			model = this.state.ctx?.model;
		} catch {}
		// The session's placeholder when no model is configured is not a model to show.
		if (model?.provider === "unknown" && model.id === "unknown") model = undefined;
		const home = process.env.HOME ?? "";
		const cwd = homeRelative(this.state.ctx?.cwd ?? process.cwd(), home);
		const branch = this.state.branch();

		// the name in ink, the facts in ink 2 and ink 3, no colour.
		// fork: model id, folder and branch come from outside Prism.
		const ink2 = (s: string) => theme.fg("thinkingText", sanitizeTerminalLabel(s));
		const dot = theme.fg("dim", " · ");
		const title = `${paint(tok(theme, "text"), APP_NAME, { bold: true })}${theme.fg("dim", `  ${VERSION}`)}`;
		let modelLine = ink2(model?.id ?? translate("no model"));
		if (model?.provider) modelLine += dot + theme.fg("dim", sanitizeTerminalLabel(model.provider));
		if (model?.reasoning) modelLine += dot + theme.fg("dim", translate(this.state.thinkingLevel || "off"));
		let where = `${theme.fg("dim", "\uf07b")} ${ink2(cwd)}`;
		if (branch) where += `  ${theme.fg("dim", "\ue0a0")} ${ink2(branch)}`;
		// two hints as text, keys in ink and labels in ink 3, like the line under the site's install command.
		const hints = [this.hint("/", "commands"), this.hint(keyText("app.tools.expand"), "more")];
		// fork: hints that do not fit go to a second row instead of being dropped.
		const rows: string[] = [];
		for (const hint of hints) {
			const last = rows.length - 1;
			if (last >= 0 && visibleWidth(`${rows[last]}${dot}${hint}`) <= width) rows[last] += `${dot}${hint}`;
			else rows.push(hint);
		}
		return [title, modelLine, where, "", ...rows].map((l) => truncateToWidth(l, Math.max(1, width), "…"));
	}

	private hint(key: string, label: string): string {
		const theme = this.state.theme!;
		return `${theme.fg("text", key)} ${theme.fg("muted", translate(label))}`;
	}

	private fullHelp(width: number): string[] {
		const theme = this.state.theme!;
		const k = keyText;
		const entries: Array<[string, string]> = [
			[k("app.interrupt"), "to interrupt"],
			[k("app.clear"), "to clear"],
			[`${k("app.clear")} ${translate("twice")}`, "to exit"],
			[k("app.exit"), "to exit (empty)"],
			[k("app.suspend"), "to suspend"],
			[k("tui.editor.deleteToLineEnd"), "to delete to end"],
			[k("app.thinking.cycle"), "to change thinking level"],
			[`${k("app.model.cycleForward")}/${k("app.model.cycleBackward")}`, "to cycle models"],
			[k("app.model.select"), "to select model"],
			[k("app.tools.expand"), "to show or hide action details"],
			[k("app.thinking.toggle"), "to expand thinking"],
			[k("app.editor.external"), "for external editor"],
			["/", "for commands"],
			["!", "to run a terminal command and share its output with the agent"],
			["!!", "to run a terminal command without sharing its output with the agent"],
			[k("app.message.followUp"), "to queue follow-up"],
			[k("app.message.dequeue"), "to edit all queued messages"],
			[k("app.clipboard.pasteImage"), `${translate("to paste")} ${translate(pasteTargets())}`],
			[translate("drop files"), "to attach"],
		].map(([key, label]) => [key!, translate(label!)]);
		const keyW = Math.max(...entries.map(([key]) => visibleWidth(key)));
		const cell = (key: string, label: string) =>
			`${theme.fg("text", key)}${" ".repeat(keyW - visibleWidth(key))}  ${theme.fg("muted", label)}`;
		const colW = keyW + 2 + Math.max(...entries.map(([, l]) => visibleWidth(l))) + 4;
		const cols = width - 2 >= colW * 2 ? 2 : 1;
		const perCol = Math.ceil(entries.length / cols);
		const lines: string[] = [];
		for (let r = 0; r < perCol; r++) {
			let line = " ";
			for (let c = 0; c < cols; c++) {
				const e = entries[c * perCol + r];
				if (!e) continue;
				const s = cell(e[0], e[1]);
				line += s + (c < cols - 1 ? " ".repeat(Math.max(1, colW - visibleWidth(s))) : "");
			}
			lines.push(truncateToWidth(line, width, "…"));
		}
		return lines;
	}
}

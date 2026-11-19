// Colour math and truecolor painting helpers. Every colour is derived from the
// active theme's tokens, so the chrome follows /theme switches. Two sets are fixed here
// the dark spectrum, kept for the working indicator (the logo's
// fan has its own colours, in art.ts), and the pale tool-family hues, whose lightness follows the theme.

import { colorToRgb, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeToken } from "../../../modes/interactive/theme/theme.ts";

export type RGB = readonly [number, number, number];

const FALLBACK: RGB = [180, 180, 190];

export function tok(theme: Theme, token: ThemeToken): RGB {
	try {
		const c = colorToRgb(theme.colors[token]);
		return [c.r, c.g, c.b];
	} catch {
		return FALLBACK;
	}
}

export const fgRGB = ([r, g, b]: RGB) => `\x1b[38;2;${r | 0};${g | 0};${b | 0}m`;
export const bgRGB = ([r, g, b]: RGB) => `\x1b[48;2;${r | 0};${g | 0};${b | 0}m`;
export const RESET = "\x1b[0m";
export const FG_OFF = "\x1b[39m";
export const BG_OFF = "\x1b[49m";

export function paint(rgb: RGB, text: string, opts: { bold?: boolean; italic?: boolean } = {}): string {
	if (!text) return "";
	const on = (opts.bold ? "\x1b[1m" : "") + (opts.italic ? "\x1b[3m" : "");
	const off = (opts.bold ? "\x1b[22m" : "") + (opts.italic ? "\x1b[23m" : "");
	return `${on}${fgRGB(rgb)}${text}${FG_OFF}${off}`;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
	const k = Math.max(0, Math.min(1, t));
	return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Sample a gradient. `cyclic` wraps the last stop back to the first. */
export function sample(stops: readonly RGB[], t: number, cyclic = false): RGB {
	if (stops.length === 1) return stops[0];
	if (cyclic) {
		const u = ((t % 1) + 1) % 1;
		const x = u * stops.length;
		const i = Math.floor(x);
		return mix(stops[i % stops.length], stops[(i + 1) % stops.length], x - i);
	}
	const u = Math.max(0, Math.min(1, t)) * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(u));
	return mix(stops[i], stops[i + 1], u - i);
}

/**
 * fork: the site's dispersion, red to violet, dark and desaturated.
 * `depth` 0 is the light leaving the prism, 1 and 2 fainter. Only the working indicator uses it now (the
 * logo's fan has its own colours, in art.ts): colour marks an event, it does not classify.
 */
export function spectrumRamp(light: boolean, depth: 0 | 1 | 2 = 0): RGB[] {
	const L = (light ? [0.56, 0.66, 0.78] : [0.62, 0.5, 0.4])[depth]!;
	const C = (light ? [0.075, 0.06, 0.045] : [0.07, 0.06, 0.05])[depth]!;
	return SPECTRUM_HUES.map((h) => oklch(L, C, h));
}
const SPECTRUM_HUES = [30, 70, 125, 175, 250, 310];

/** The spectrum for the active theme's appearance. */
export function spectrum(theme: Theme): RGB[] {
	return spectrumRamp(isLightTheme(theme));
}

/**
 * fork: a pale tint of `hue` (OKLCH degrees) at a readable lightness for the theme, for the tool
 * families (keep their colours, sober and readable). At least 8:1 on the dark surfaces and
 * 5.5:1 on the light ones (computed).
 */
export function tint(theme: Theme, hue: number, chroma = 0.06): RGB {
	return oklch(isLightTheme(theme) ? 0.45 : 0.78, chroma, hue);
}

/** fork: the second surface, between the tile and the selection band (code blocks). */
export function surface2(theme: Theme): RGB {
	return mix(tok(theme, "userMessageBg"), tok(theme, "selectedBg"), 0.4);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(text: string): string[] {
	return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Per-grapheme gradient over plain text. */
export function gradient(
	text: string,
	stops: readonly RGB[],
	opts: { phase?: number; span?: number; cyclic?: boolean; bold?: boolean; italic?: boolean } = {},
): string {
	const gs = graphemes(text);
	if (gs.length === 0) return "";
	const span = opts.span ?? Math.max(1, gs.length - 1);
	let out = (opts.bold ? "\x1b[1m" : "") + (opts.italic ? "\x1b[3m" : "");
	gs.forEach((g, i) => {
		if (g === " ") {
			out += g;
			return;
		}
		out += fgRGB(sample(stops, i / span + (opts.phase ?? 0), opts.cyclic)) + g;
	});
	return out + FG_OFF + (opts.bold ? "\x1b[22m" : "") + (opts.italic ? "\x1b[23m" : "");
}

/** A highlight band sweeping across `text` (base → peak → base). `pos` is in graphemes. */
export function shimmer(text: string, base: RGB, peak: RGB, pos: number, radius = 4): string {
	const gs = graphemes(text);
	let out = "";
	gs.forEach((g, i) => {
		const d = Math.abs(i - pos);
		const k = d >= radius ? 0 : (Math.cos((d / radius) * Math.PI) + 1) / 2;
		out += fgRGB(mix(base, peak, k)) + g;
	});
	return out + FG_OFF;
}

/**
 * Give a rendered line a solid background: re-assert it after every reset
 * that would clear it, and pad to `width` columns.
 */
export function onBg(line: string, bg: RGB, width: number): string {
	const on = bgRGB(bg);
	const body = line.replace(/\x1b\[(0|49)?m/g, (m) => m + on);
	const pad = Math.max(0, width - visibleWidth(line));
	return `${on}${body}${" ".repeat(pad)}${BG_OFF}`;
}

export function hexToRgb(hex: string): RGB {
	const h = hex.replace("#", "");
	return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

// fork: OKLab steps, for pixel-art ramps and tile surfaces.
const toLinear = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function toOklab([r, g, b]: RGB): RGB {
	const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function fromOklab([L, a, b]: RGB): RGB {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const c = (v: number) => Math.round(Math.max(0, Math.min(255, fromLinear(v))));
	return [
		c(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		c(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		c(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	];
}

/**
 * A lighter (`k` > 0) or darker (`k` < 0) step of `c` in OKLab, with the pixel-art hue shift:
 * lights drift warm, shadows drift cool. One step is 0.045 of OKLab lightness.
 */
export function step(c: RGB, k: number): RGB {
	const [L, a, b] = toOklab(c);
	const n = Math.abs(k);
	return fromOklab([L + k * 0.045, a + (k > 0 ? 0.002 : 0.004) * n, b + (k > 0 ? 0.004 : -0.008) * n]);
}

/** A colour from OKLCH: lightness 0 to 1, chroma, hue in degrees. */
export function oklch(L: number, C: number, hue: number): RGB {
	const h = (hue * Math.PI) / 180;
	return fromOklab([L, C * Math.cos(h), C * Math.sin(h)]);
}

/** OKLCH chroma: 0 for a grey, about 0.04 for the site's syntax tints, 0.1 and more for a saturated colour. */
export function chroma(c: RGB): number {
	const [, a, b] = toOklab(c);
	return Math.hypot(a, b);
}

/** OKLab lightness, 0 (black) to 1 (white). */
export function lightness(c: RGB): number {
	return toOklab(c)[0];
}

/** Whether the theme is meant for a light terminal background: its text colour is dark. */
export function isLightTheme(theme: Theme): boolean {
	return lightness(tok(theme, "text")) < 0.5;
}

/** fork: a pill, rounded at the pixel level: ▐ and ▌ in the pill's colour around the label. */
export function pill(label: string, fill: RGB, text: RGB): string {
	return `${fgRGB(fill)}▐${bgRGB(fill)}${fgRGB(text)}${label}${BG_OFF}${fgRGB(fill)}▌${FG_OFF}`;
}

/**
 * fork: text on the selected band (selectedBg) of a tiled menu. Accent text is three steps darker on
 * light themes, and dimmed labels (advanced settings) take the accent, so both keep 4.5:1 on the band (measured).
 */
export function onBand(theme: Theme, line: string): string {
	const accent = tok(theme, "accent");
	const text = fgRGB(isLightTheme(theme) ? step(accent, -3) : accent);
	return line.replaceAll(theme.getFgAnsi("accent"), text).replaceAll(theme.getFgAnsi("dim"), text);
}

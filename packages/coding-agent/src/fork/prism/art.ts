// fork: Prism's pixel-art logo. One letter per pixel, two
// pixel rows per text row (half blocks). The small and mini sizes are redrawn, not scaled down. The large one
// follows the maintainer's reference of 2026-10-14: a symmetric prism, black glass lit from the upper right, the
// left edge in ink and the right one in ink 2 over a grey bevel, a grey base with lit corners, a thin beam
// rising into the left edge in regular steps and the fan opening from the right face. It is generated from
// its geometry, not drawn by hand: apex centred, both edges 3 pixels out every 5 rows; the fan's band
// thicknesses are mirrored around its middle. The fan covers whole text rows: a lone half block next to a
// coloured cell leaves a dark seam in some terminals, so its top sits on an
// even pixel row and its bottom on an odd one. Tests check all three. The small and mini sizes are the
// site's mark: the triangle in outline and the beam reaching it from the left, in ink, without colour.

import { oklch, type RGB } from "./lib/palette.ts";

/** 38 x 14 pixels, 7 text rows: the header from 100 columns. */
export const LOGO_LARGE = [
	"                 *                    ",
	"                EpR                   ",
	"                EpR             000000",
	"               ETSpR            000000",
	"               ETSpR       00000111111",
	"              ETFSSpR      11111111111",
	"             ETFFSSSpR 000011111222222",
	"             ETFFFSSpR 111122222222222",
	"            EKFFFFFSSpR222222222333333",
	"        BBBBxKKFFFFSSpR333333333333333",
	"    wwww   EKKKFFFFFSSpR44433333444444",
	"uuuu      EKKKKKFFFFFFSpR5544444444444",
	"          EKKKKKKFFFFFFpR  44444555555",
	"         EOOOOOOOOOOOOOOOR 55555555555",
];

/** 16 x 8 pixels, 4 text rows: the header from 64 to 99 columns. */
export const LOGO_SMALL = [
	"          *     ",
	"         E E    ",
	"         E E    ",
	"        E   E   ",
	"        E   E   ",
	"wwBBBBBx     E  ",
	"       E     E  ",
	"      EEEEEEEEE ",
];

/** 8 x 4 pixels, 2 text rows: narrow headers, /settings and the fallback header. */
export const LOGO_MINI = ["     *  ", "    E E ", "wBBx   E", "   EEEEE"];

const hex = (h: string): RGB => [
	Number.parseInt(h.slice(1, 3), 16),
	Number.parseInt(h.slice(3, 5), 16),
	Number.parseInt(h.slice(5, 7), 16),
];

/**
 * The fan, red to violet (letters 0 to 5): livelier than the chrome's spectrum but short of a saturated
 * rainbow, lighter toward yellow like a real spectrum.
 */
function fan(light: boolean): Record<string, RGB> {
	const bands: Array<[hue: number, dark: number, pale: number]> = [
		[25, 0.64, 0.58],
		[60, 0.7, 0.64],
		[100, 0.77, 0.7],
		[150, 0.7, 0.62],
		[240, 0.64, 0.56],
		[300, 0.58, 0.5],
	];
	return Object.fromEntries(bands.map(([hue, dark, pale], i) => [String(i), oklch(light ? pale : dark, 0.105, hue)]));
}

/** Fixed colours: the logo is an image and keeps them on every dark theme. Greys are the site's inks and lines. */
const DARK: Record<string, RGB> = {
	// Glass: near-black, darkest toward the lower left, lighter toward the upper right.
	K: hex("#111111"), // shadow
	F: hex("#161615"), // glass
	S: hex("#1e1e1d"), // lit glass
	T: hex("#262625"), // bevel under the lit edge
	p: hex("#3a3a38"), // bevel under the right edge
	// Edges: ink for the lit one, ink 2 for the right one, ink 3 spare, the strong line for the base.
	E: hex("#f0f0ee"),
	R: hex("#b2b2ae"),
	G: hex("#8a8a86"),
	O: hex("#505050"),
	"*": hex("#ffffff"), // glint at the apex
	// Beam and its fading tail.
	B: hex("#f0f0ee"),
	w: hex("#8a8a86"),
	u: hex("#505050"),
	x: hex("#ffffff"), // the entry point, flashed once by the intro
	...fan(false),
};

/** On a light background the roles are inverted: pale glass, edges and beam in dark ink. */
const LIGHT: Record<string, RGB> = {
	K: hex("#ececea"),
	F: hex("#e6e6e3"),
	S: hex("#dededa"),
	T: hex("#d6d6d2"),
	p: hex("#b8b8b5"),
	E: hex("#111111"),
	R: hex("#4a4a47"),
	G: hex("#62625e"),
	O: hex("#a6a6a5"),
	"*": hex("#000000"),
	B: hex("#111111"),
	w: hex("#62625e"),
	u: hex("#a6a6a5"),
	x: hex("#000000"),
	...fan(true),
};

export type PixelKind = "glass" | "edge" | "beam" | "spectrum" | "sparkle";

/** What a pixel belongs to, for the intro animation; undefined for an empty pixel. */
export function pixelKind(map: readonly string[], x: number, y: number): PixelKind | undefined {
	const ch = map[y]?.[x];
	if (ch === undefined || ch === " ") return undefined;
	if (ch === "B" || ch === "w" || ch === "u") return "beam";
	if (ch === "x") return "sparkle";
	if ("ERGO*".includes(ch)) return "edge";
	if ("KFSTp".includes(ch)) return "glass";
	return "spectrum";
}

/** Colour of one pixel, undefined for an empty pixel. */
export function artPixel(map: readonly string[], x: number, y: number, light: boolean): RGB | undefined {
	const ch = map[y]?.[x];
	if (ch === undefined || ch === " ") return undefined;
	return (light ? LIGHT : DARK)[ch];
}

/** Letters the maps may use: tests check every map against it. */
export const ART_LETTERS = Object.keys(DARK).join("");

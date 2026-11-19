// fork: pixel tiles. A tile is a solid surface whose top
// and bottom edges are half rows in the same colour, with corners cut by one quadrant: ▗▄▄▖ above, ▝▀▀▘ below.
// The edges use the surface colour only: lighter or darker edge rows read as stripes.

import { FG_OFF, fgRGB, onBg, type RGB } from "./palette.ts";

/** The top or bottom edge of a tile `width` columns wide, drawn on the page background. */
export function tileEdge(width: number, fill: RGB, side: "top" | "bottom"): string {
	if (width <= 0) return "";
	if (width === 1) return `${fgRGB(fill)}${side === "top" ? "▄" : "▀"}${FG_OFF}`;
	const [left, mid, right] = side === "top" ? ["▗", "▄", "▖"] : ["▝", "▀", "▘"];
	return `${fgRGB(fill)}${left}${mid.repeat(width - 2)}${right}${FG_OFF}`;
}

/** Body lines on the tile's surface, each padded to `width`, between the two edges. */
export function tile(body: readonly string[], width: number, fill: RGB): string[] {
	return [
		tileEdge(width, fill, "top"),
		...body.map((line) => onBg(line, fill, width)),
		tileEdge(width, fill, "bottom"),
	];
}

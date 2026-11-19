// fork: the half-block renderer for the pixel-art logo (the maps are in art.ts).
// Each text row packs two pixel rows: ▀ takes the top pixel as foreground and the bottom one as background.

import type { RGB } from "./lib/palette.ts";

/**
 * Renders a pixel map with half blocks. `pixel` gives each pixel's color; `fg` and `bg` turn a color
 * into an escape sequence, so callers choose truecolor or the terminal's color mode.
 */
export function renderHalfBlocks(
	map: readonly string[],
	pixel: (x: number, y: number) => RGB | undefined,
	fg: (rgb: RGB) => string,
	bg: (rgb: RGB) => string,
): string[] {
	const reset = "\x1b[0m";
	const width = map[0]?.length ?? 0;
	const out: string[] = [];
	for (let y = 0; y < map.length; y += 2) {
		let line = "";
		for (let x = 0; x < width; x++) {
			const top = pixel(x, y);
			const bottom = pixel(x, y + 1);
			if (top && bottom) line += `${fg(top)}${bg(bottom)}▀${reset}`;
			else if (top) line += `${fg(top)}▀${reset}`;
			else if (bottom) line += `${fg(bottom)}▄${reset}`;
			else line += " ";
		}
		out.push(line);
	}
	return out;
}

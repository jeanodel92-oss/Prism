// fork: an inline image under an open overlay. The terminal draws an image above the text,
// so compositing the overlay's text into the image's rows left the image on top of the overlay (/context over
// a screenshot). An image is left out of the frame while an overlay covers one of its rows; the renderers
// delete an image whose line is gone and place it again when the overlay closes.
import { isImageLine } from "../terminal-image.ts";

/** Rows `[start, end)` of the frame. */
export interface RowRange {
	start: number;
	end: number;
}

/** The rows an image line draws over: a Kitty image from its row down, an iTerm2 one from the rows above it. */
function imageRows(line: string, index: number): RowRange {
	const kitty = /\x1b_G([^;\x1b]*)/.exec(line);
	if (kitty) {
		const rows = Number(/(?:^|,)r=(\d+)/.exec(kitty[1]!)?.[1] ?? 1);
		return { start: index, end: index + Math.max(1, rows) };
	}
	const above = Number(/\x1b\[(\d+)A/.exec(line)?.[1] ?? 0);
	return { start: index - above, end: index + 1 };
}

/** Empties, in place, every image line of `lines` whose image shares a row with one of `overlays`. */
export function hideImagesUnderOverlays(lines: string[], overlays: readonly RowRange[]): void {
	if (overlays.length === 0) return;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!isImageLine(line)) continue;
		const image = imageRows(line, i);
		if (overlays.some((overlay) => overlay.start < image.end && image.start < overlay.end)) lines[i] = "";
	}
}

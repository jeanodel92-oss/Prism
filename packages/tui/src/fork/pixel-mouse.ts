// fork: pixel-precise mouse reports (SGR-Pixels, DEC mode 1016) for the fullscreen
// scrollbar. With cell reports, dragging the scrollbar moved the view by whole cells of the
// track: with a long transcript, one cell is hundreds of lines, so the view jumped by large
// sections. Terminals that report their cell size in pixels
// (CSI 16 t, already asked when they support images) get mode 1016; every pixel report is
// rewritten as the usual cell report before anything parses it, and the exact pointer row
// is kept for the scrollbar.

export const ENABLE_PIXEL_MOUSE = "\x1b[?1016h";
export const DISABLE_PIXEL_MOUSE = "\x1b[?1016l";
/** DECRQM: asks whether the terminal took mode 1016; a terminal that ignores it keeps cell reports. */
export const QUERY_PIXEL_MOUSE = "\x1b[?1016$p";

/** The DECRQM reply for mode 1016: true when set, false when not, undefined for other input. */
export function pixelMouseReply(data: string): boolean | undefined {
	const match = /^\x1b\[\?1016;(\d)\$y$/.exec(data);
	if (!match) return undefined;
	return match[1] === "1" || match[1] === "3";
}

export interface CellSize {
	widthPx: number;
	heightPx: number;
}

// Kitty reports a pointer above or left of the window with negative pixels:
// dropping them lost the release that ends a selection dragged out of the window.
const SGR_MOUSE = /^\x1b\[<(\d+);(-?\d+);(-?\d+)([Mm])$/;

/**
 * A pixel SGR mouse report as a cell report, plus the pointer's row as a fraction of cells
 * (0-based). Anything else is returned unchanged, without `row`.
 */
export function toCellMouseReport(data: string, cell: CellSize): { data: string; row?: number } {
	const match = SGR_MOUSE.exec(data);
	if (!match) return { data };
	// Pixel reports count from 1, like cell reports.
	const xPx = Math.max(0, Number(match[2]) - 1);
	const yPx = Math.max(0, Number(match[3]) - 1);
	const column = Math.floor(xPx / cell.widthPx) + 1;
	const row = yPx / cell.heightPx;
	return { data: `\x1b[<${match[1]};${column};${Math.floor(row) + 1}${match[4]}`, row };
}

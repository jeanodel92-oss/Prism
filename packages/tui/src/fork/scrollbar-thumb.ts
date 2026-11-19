// fork: the scrollbar thumb drawn to an eighth of a cell. Drawn to whole cells, it stayed
// still for dozens of wheel notches on a long session, then jumped
// ; the maintainer chose full-block glyphs for this precision.

const LOWER = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * The thumb's glyph in the track cell `row`, for a thumb spanning rows [start, end): a lower
 * block when the thumb starts inside the cell, a reversed lower block (the cell's top part)
 * when it ends inside it, a full block when it covers the cell. Undefined: track only.
 */
export function thumbCell(row: number, start: number, end: number): { glyph: string; reverse: boolean } | undefined {
	const coverage = Math.max(0, Math.min(row + 1, end) - Math.max(row, start));
	const eighths = Math.round(coverage * 8);
	if (eighths <= 0) return undefined;
	if (eighths >= 8) return { glyph: LOWER[8], reverse: false };
	if (start > row) return { glyph: LOWER[eighths], reverse: false };
	// Only lower blocks exist at every eighth: draw the uncovered bottom in reverse video.
	return { glyph: LOWER[8 - eighths], reverse: true };
}

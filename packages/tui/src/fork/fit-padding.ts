// fork: components added their side padding even when it filled the whole
// width, so a line could be wider than the width it was given and stop the renderer.

/** The side padding that still leaves one column of content, or none at width 0. */
export function fitPadding(width: number, paddingX: number): number {
	return Math.max(0, Math.min(paddingX, Math.floor((width - 1) / 2)));
}

/**
 * fork: keyboard text selection for the prompt editor.
 *
 * Pure helpers over the editor's `lines` array, kept out of editor.ts so the upstream file only
 * carries small hooks. Positions are logical (line index, UTF-16 column), as in the editor state.
 */

export interface TextPosition {
	line: number;
	col: number;
}

export interface TextRange {
	start: TextPosition;
	end: TextPosition;
}

/** Selected part of one rendered chunk, in chunk-relative columns; `newline` marks a selected line break. */
export interface ChunkSelection {
	start: number;
	end: number;
	newline: boolean;
}

const SELECTION_ON = "\x1b[7m";
const SELECTION_OFF = "\x1b[27m";

function comparePositions(a: TextPosition, b: TextPosition): number {
	return a.line === b.line ? a.col - b.col : a.line - b.line;
}

function clampPosition(lines: readonly string[], position: TextPosition): TextPosition {
	const line = Math.max(0, Math.min(position.line, lines.length - 1));
	const col = Math.max(0, Math.min(position.col, (lines[line] ?? "").length));
	return { line, col };
}

/** Ordered, clamped range between the anchor and the cursor, or undefined when nothing is selected. */
export function getSelectionRange(
	lines: readonly string[],
	anchor: TextPosition | null,
	cursor: TextPosition,
): TextRange | undefined {
	if (!anchor) return undefined;
	const a = clampPosition(lines, anchor);
	const b = clampPosition(lines, cursor);
	const order = comparePositions(a, b);
	if (order === 0) return undefined;
	return order < 0 ? { start: a, end: b } : { start: b, end: a };
}

/** Text covered by a range; lines are joined with "\n". */
export function getRangeText(lines: readonly string[], range: TextRange): string {
	const { start, end } = range;
	if (start.line === end.line) return (lines[start.line] ?? "").slice(start.col, end.col);
	const parts = [(lines[start.line] ?? "").slice(start.col)];
	for (let line = start.line + 1; line < end.line; line++) parts.push(lines[line] ?? "");
	parts.push((lines[end.line] ?? "").slice(0, end.col));
	return parts.join("\n");
}

/** Lines with the range removed; the cursor goes to the range start. */
export function deleteRange(lines: readonly string[], range: TextRange): string[] {
	const { start, end } = range;
	const head = (lines[start.line] ?? "").slice(0, start.col);
	const tail = (lines[end.line] ?? "").slice(end.col);
	return [...lines.slice(0, start.line), head + tail, ...lines.slice(end.line + 1)];
}

/**
 * Selected columns of the chunk [chunkStart, chunkEnd) of logical line `line`. The line break is
 * shown as selected on the line's last chunk when the range continues on the next line.
 */
export function getChunkSelection(
	range: TextRange | undefined,
	line: number,
	chunkStart: number,
	chunkEnd: number,
	isLastChunk: boolean,
): ChunkSelection | undefined {
	if (!range || line < range.start.line || line > range.end.line) return undefined;
	const from = line === range.start.line ? range.start.col : 0;
	const to = line === range.end.line ? range.end.col : Number.POSITIVE_INFINITY;
	const start = Math.min(Math.max(from, chunkStart), chunkEnd) - chunkStart;
	const end = Math.min(Math.max(to, chunkStart), chunkEnd) - chunkStart;
	const newline = isLastChunk && line < range.end.line;
	return { start, end: Math.max(start, end), newline };
}

/**
 * Render a chunk with its selected part in inverse video, as the mouse selection of the alternate
 * screen does. `marker` (the hardware cursor marker, may be "") goes at `cursorPos` when given.
 * Returns the extra visible width added (1 for a selected line break, else 0).
 */
export function renderSelectedChunk(
	text: string,
	selection: ChunkSelection,
	cursorPos: number | undefined,
	marker: string,
): { text: string; extraWidth: number } {
	const insertions = new Map<number, string>();
	const add = (index: number, value: string) => insertions.set(index, (insertions.get(index) ?? "") + value);
	if (cursorPos !== undefined) add(Math.min(cursorPos, text.length), marker);
	if (selection.end > selection.start) {
		add(selection.start, SELECTION_ON);
		add(selection.end, SELECTION_OFF);
	}
	let result = "";
	let previous = 0;
	for (const index of [...insertions.keys()].sort((a, b) => a - b)) {
		result += text.slice(previous, index) + insertions.get(index);
		previous = index;
	}
	result += text.slice(previous);
	if (!selection.newline) return { text: result, extraWidth: 0 };
	return { text: `${result}${SELECTION_ON} ${SELECTION_OFF}`, extraWidth: 1 };
}

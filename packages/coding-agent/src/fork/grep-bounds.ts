/**
 * fork: grep's limits, applied before the work they limit.
 *
 * - `context` was any number. `context: 1e9` made grep note a billion line numbers before reading anything.
 *   It is now a whole number of at most {@link MAX_GREP_CONTEXT} lines, more than the output budget can ever show.
 * - ripgrep's JSON event for a match holds the whole matching line, and `readline` gathered it whole before
 *   grep cut it to 500 characters: a file of one 1 GB line cost gigabytes. Events are now split by
 *   {@link readJsonLines}, which keeps at most {@link MAX_EVENT_BYTES} of a line; a longer match event keeps its
 *   head and its tail, enough for its path, the start of its line and, most of the time, its line number.
 */
import type { Readable } from "node:stream";

/** Above any output grep can show: 50 KB of output holds about 10 000 short lines. */
export const MAX_GREP_CONTEXT = 10_000;

/** `context` as a count of lines: 0 for anything that is not a positive number, never above the maximum. */
export function grepContext(context: number | undefined): number {
	if (context === undefined || !Number.isFinite(context) || context <= 0) return 0;
	return Math.min(Math.floor(context), MAX_GREP_CONTEXT);
}

/** The longest ripgrep event read whole: a match line of about a megabyte. */
export const MAX_EVENT_BYTES = 1024 * 1024;
/** What is kept of each end of a longer event. */
const KEPT_BYTES = 64 * 1024;

/**
 * Splits `input` into lines without ever holding more than {@link MAX_EVENT_BYTES} of one: `onLine` gets each line
 * up to that size, `onOversize` the first and last {@link KEPT_BYTES} of a longer one.
 */
export function readJsonLines(
	input: Readable,
	onLine: (line: string) => void,
	onOversize: (head: Buffer, tail: Buffer) => void,
): void {
	let parts: Buffer[] = [];
	let size = 0;
	let head: Buffer | undefined;
	let tail = Buffer.alloc(0);
	const append = (piece: Buffer) => {
		if (head) {
			tail = Buffer.concat([tail, piece.subarray(Math.max(0, piece.length - KEPT_BYTES))]);
			tail = tail.subarray(Math.max(0, tail.length - KEPT_BYTES));
			return;
		}
		parts.push(piece);
		size += piece.length;
		if (size <= MAX_EVENT_BYTES) return;
		const whole = Buffer.concat(parts, size);
		head = whole.subarray(0, KEPT_BYTES);
		tail = Buffer.from(whole.subarray(whole.length - KEPT_BYTES));
		parts = [];
		size = 0;
	};
	const end = () => {
		if (head) onOversize(head, tail);
		else if (size > 0) onLine(Buffer.concat(parts, size).toString("utf8"));
		parts = [];
		size = 0;
		head = undefined;
		tail = Buffer.alloc(0);
	};
	input.on("data", (chunk: Buffer) => {
		let from = 0;
		for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, from)) {
			append(chunk.subarray(from, at));
			end();
			from = at + 1;
		}
		if (from < chunk.length) append(chunk.subarray(from));
	});
	input.on("end", end);
}

/** What can be read of a match event too long to parse: its path, the start of its line, its line number. */
export interface OversizeMatch {
	path?: { text?: string; bytes?: string };
	lineStart?: string;
	lineNumber?: number;
}

/** Reads {@link OversizeMatch} from the ends of a ripgrep match event (fields in ripgrep's own order). */
export function oversizeMatch(head: Buffer, tail: Buffer): OversizeMatch | undefined {
	const start = head.toString("utf8");
	if (!start.startsWith('{"type":"match"')) return undefined;
	const result: OversizeMatch = {};
	const path = /"path":(\{"(?:text|bytes)":"(?:[^"\\]|\\.)*"\})/.exec(start);
	if (path) result.path = JSON.parse(path[1]) as OversizeMatch["path"];
	const lines = /"lines":\{"text":"((?:[^"\\]|\\.)*)/.exec(start);
	if (lines) {
		// The string is cut, maybe inside an escape (`\u00`): drop up to five characters until it decodes.
		for (let drop = 0; drop <= 5 && result.lineStart === undefined; drop++) {
			try {
				result.lineStart = JSON.parse(`"${lines[1].slice(0, lines[1].length - drop)}"`) as string;
			} catch {}
		}
	}
	// Only the real key matches: inside the line's JSON string, every quote is escaped.
	const numbers = [...tail.toString("utf8").matchAll(/"line_number":(\d+),"absolute_offset"/g)];
	const last = numbers.at(-1);
	if (last) result.lineNumber = Number(last[1]);
	return result;
}

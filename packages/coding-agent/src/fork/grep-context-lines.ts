/**
 * fork: grep with `context` read each matching file whole to show a few lines around
 * each match: a 257 MB file cost 248 MB of memory, and over 512 MB the read failed and every match
 * of the file printed "(unable to read file)". For a large local file, the lines around the
 * matches are now read in one streamed pass. They fill grep's own line cache as a sparse array, so
 * the upstream formatting is unchanged; `test/fork-grep-context.test.ts` compares both paths.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { LARGE_TEXT_BYTES } from "./large-text-read.ts";

export interface GrepContextOptions {
	/** Defaults to LARGE_TEXT_BYTES; tests lower it to compare with the upstream path. */
	thresholdBytes?: number;
	/** Stream chunk size; tests lower it to split lines and UTF-8 sequences across chunks. */
	chunkBytes?: number;
	/** fork: stops reading the context when the search is cancelled. */
	signal?: AbortSignal;
}

/**
 * Puts in `fileCache` the lines grep's `formatBlock` will show for each large file: a sparse array
 * as long as the upstream `split("\n")` array, holding only the lines around the matches, or an
 * empty array when the file cannot be read (as the upstream path does). Small files are left alone.
 */
export async function cacheLargeFileContext(
	matches: ReadonlyArray<{ filePath: string; lineNumber: number }>,
	context: number,
	fileCache: Map<string, string[]>,
	options: GrepContextOptions = {},
): Promise<void> {
	// fork: the lines around each match as ranges, never one entry per line.
	const needed = new Map<string, Array<[number, number]>>();
	for (const { filePath, lineNumber } of matches) {
		const ranges = needed.get(filePath) ?? [];
		needed.set(filePath, ranges);
		ranges.push([Math.max(1, lineNumber - context), lineNumber + context]);
	}
	for (const [filePath, ranges] of needed) {
		if (options.signal?.aborted) return;
		const lines = lineSet(ranges);
		try {
			if ((await stat(filePath)).size <= (options.thresholdBytes ?? LARGE_TEXT_BYTES)) continue;
			fileCache.set(filePath, await readLines(filePath, lines, options.chunkBytes ?? 1024 * 1024, options.signal));
		} catch {
			fileCache.set(filePath, []);
		}
	}
}

/** Whether a line number falls in one of `ranges`, asked in increasing order (one pass over the file). */
function lineSet(ranges: Array<[number, number]>): { has(line: number): boolean } {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	let index = 0;
	return {
		has(line: number) {
			while (index < sorted.length && sorted[index][1] < line) index++;
			for (let at = index; at < sorted.length && sorted[at][0] <= line; at++) if (sorted[at][1] >= line) return true;
			return false;
		},
	};
}

/** More of one line than grep ever shows (500 characters), so a giant line is not gathered whole. */
const KEPT_LINE_CHARS = 4096;

/**
 * Lines numbered from 1 as ripgrep numbers them: only `\n` ends a line. A `\r`
 * stays in its line; grep's formatting removes it for display.
 */
async function readLines(
	filePath: string,
	needed: { has(line: number): boolean },
	chunkBytes: number,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const lines: string[] = [];
	let lineNumber = 1;
	let parts: string[] = [];
	let kept = 0;
	let wanted = needed.has(lineNumber);
	const add = (text: string) => {
		if (text.length === 0 || !wanted || kept >= KEPT_LINE_CHARS) return;
		parts.push(text.slice(0, KEPT_LINE_CHARS - kept));
		kept += Math.min(text.length, KEPT_LINE_CHARS - kept);
	};
	const endLine = () => {
		if (wanted) lines[lineNumber - 1] = parts.join("");
		parts = [];
		kept = 0;
		lineNumber++;
		wanted = needed.has(lineNumber);
	};
	const consume = (text: string) => {
		let from = 0;
		for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", from)) {
			add(text.slice(from, index));
			endLine();
			from = index + 1;
		}
		add(text.slice(from));
	};
	const decoder = textDecoder();
	for await (const chunk of createReadStream(filePath, { highWaterMark: chunkBytes })) {
		if (signal?.aborted) throw new Error("Operation aborted");
		consume(decoder.write(chunk as Buffer));
	}
	consume(decoder.end());
	endLine();
	lines.length = lineNumber - 1;
	return lines;
}

/**
 * fork: ripgrep decodes a file that starts with a UTF-16 byte order mark before it
 * searches it, so its line numbers count the decoded text. The context lines are decoded the same way; any other
 * file is read as UTF-8, as before.
 */
export function textDecoder(): { write(chunk: Buffer): string; end(): string } {
	let head: Buffer = Buffer.alloc(0);
	let decoder: StringDecoder | undefined;
	let bigEndian = false;
	let oddByte: Buffer | undefined;
	const decode = (bytes: Buffer): string => {
		if (!bigEndian) return decoder!.write(bytes);
		const joined = oddByte ? Buffer.concat([oddByte, bytes]) : bytes;
		const even = joined.length - (joined.length % 2);
		oddByte = even < joined.length ? joined.subarray(even) : undefined;
		return decoder!.write(Buffer.from(joined.subarray(0, even)).swap16());
	};
	const start = (): string => {
		const le = head[0] === 0xff && head[1] === 0xfe;
		bigEndian = head[0] === 0xfe && head[1] === 0xff;
		decoder = new StringDecoder(le || bigEndian ? "utf16le" : "utf8");
		return decode(head.subarray(le || bigEndian ? 2 : 0));
	};
	return {
		write(chunk) {
			if (decoder) return decode(chunk);
			head = Buffer.concat([head, chunk]);
			return head.length < 2 ? "" : start();
		},
		end() {
			return (decoder ? "" : start()) + decoder!.end();
		},
	};
}

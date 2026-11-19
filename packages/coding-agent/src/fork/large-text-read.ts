/**
 * fork: `read` on a large text file scans it as a stream and keeps only what it shows.
 * The upstream path loads the whole file, decodes it and splits it into lines: a 257 MB file cost
 * 1 GB of memory to show 50 KB, and a file over 512 MB failed with "Cannot create a string longer
 * than 0x1fffffe8 characters", whatever the offset. The output is the one the upstream path gives
 * (same messages, same truncation details); `test/fork-large-read.test.ts` checks both side by side.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "../core/tools/truncate.ts";

/** Files above this size take the streaming path; smaller ones keep the upstream path. */
export const LARGE_TEXT_BYTES = 16 * 1024 * 1024;

export interface LargeTextRead {
	text: string;
	details: { truncation: TruncationResult } | undefined;
}

export interface LargeTextReadOptions {
	/** Defaults to LARGE_TEXT_BYTES; tests lower it to compare with the upstream path. */
	thresholdBytes?: number;
	/** Stream chunk size; tests lower it to split lines and UTF-8 sequences across chunks. */
	chunkBytes?: number;
	/** fork: stops the scan, and closes the file, when the read is cancelled. */
	signal?: AbortSignal;
}

/**
 * Reads the text file the way the read tool does, or returns undefined when it is not larger than
 * the threshold. `displayPath` is the path as the model wrote it, used in the bash hint.
 */
export async function readLargeText(
	absolutePath: string,
	displayPath: string,
	offset: number | undefined,
	limit: number | undefined,
	options: LargeTextReadOptions = {},
): Promise<LargeTextRead | undefined> {
	if ((await stat(absolutePath)).size <= (options.thresholdBytes ?? LARGE_TEXT_BYTES)) return undefined;
	const maxLines = DEFAULT_MAX_LINES;
	const maxBytes = DEFAULT_MAX_BYTES;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const endLine = limit !== undefined ? startLine + limit : Number.POSITIVE_INFINITY;

	// Lines of the file are numbered as `text.split("\n")` numbers them.
	let line = 0;
	// Selected lines (startLine <= line < endLine): count, decoded bytes, and the kept head. A line is
	// kept while the head stays within truncateHead's limits; past them only its size matters.
	let selected = 0;
	let selectedBytes = 0;
	let firstLineBytes = 0;
	let lastSelectedEmpty = false;
	const kept: string[] = [];
	let keptBytes = 0;
	let keeping = true;
	let current: string[] = [];
	let currentBytes = 0;

	const inSelection = () => line >= startLine && line < endLine;
	const addToLine = (piece: string) => {
		if (!inSelection() || piece.length === 0) return;
		currentBytes += Buffer.byteLength(piece, "utf-8");
		const separator = kept.length > 0 ? 1 : 0;
		if (keeping && kept.length <= maxLines && keptBytes + currentBytes + separator <= maxBytes) current.push(piece);
		else current = [];
	};
	const endLineHere = () => {
		if (inSelection()) {
			const separator = selected > 0 ? 1 : 0;
			if (selected === 0) firstLineBytes = currentBytes;
			selectedBytes += currentBytes + separator;
			lastSelectedEmpty = currentBytes === 0;
			const keptSeparator = kept.length > 0 ? 1 : 0;
			if (keeping && kept.length <= maxLines && keptBytes + currentBytes + keptSeparator <= maxBytes) {
				kept.push(current.join(""));
				keptBytes += currentBytes + keptSeparator;
			} else {
				keeping = false;
			}
			selected++;
		}
		current = [];
		currentBytes = 0;
		line++;
	};

	const decoder = new StringDecoder("utf8");
	const consume = (text: string) => {
		let from = 0;
		for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", from)) {
			addToLine(text.slice(from, newline));
			endLineHere();
			from = newline + 1;
		}
		addToLine(text.slice(from));
	};
	for await (const chunk of createReadStream(absolutePath, { highWaterMark: options.chunkBytes ?? 1024 * 1024 })) {
		if (options.signal?.aborted) throw new Error("Operation aborted");
		consume(decoder.write(chunk as Buffer));
	}
	consume(decoder.end());
	endLineHere();
	const fileLines = line;

	if (startLine >= fileLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${fileLines} lines total)`);
	}
	const userLimitedLines = limit !== undefined ? Math.min(startLine + limit, fileLines) - startLine : undefined;
	const startLineDisplay = startLine + 1;

	// truncateHead over the selected content, from the counts and the kept head.
	const totalLines = selected - (selected > 0 && lastSelectedEmpty ? 1 : 0);
	const totalBytes = selectedBytes;
	const base = { totalLines, totalBytes, lastLinePartial: false, maxLines, maxBytes };
	let truncation: TruncationResult;
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		const content = kept.join("\n");
		truncation = {
			...base,
			content,
			truncated: false,
			truncatedBy: null,
			outputLines: totalLines,
			outputBytes: totalBytes,
			firstLineExceedsLimit: false,
		};
	} else if (firstLineBytes > maxBytes) {
		truncation = {
			...base,
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 0,
			outputBytes: 0,
			firstLineExceedsLimit: true,
		};
	} else {
		// truncateHead stops on bytes at the first line that does not fit, otherwise on lines.
		const fitting = Math.min(totalLines, maxLines);
		const output = kept.slice(0, fitting);
		const truncatedBy = output.length < fitting ? "bytes" : "lines";
		const content = output.join("\n");
		truncation = {
			...base,
			content,
			truncated: true,
			truncatedBy,
			outputLines: output.length,
			outputBytes: Buffer.byteLength(content, "utf-8"),
			firstLineExceedsLimit: false,
		};
	}

	// Same messages as the upstream read tool.
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(firstLineBytes);
		return {
			text: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${displayPath} | head -c ${DEFAULT_MAX_BYTES}]`,
			details: { truncation },
		};
	}
	if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		const notice =
			truncation.truncatedBy === "lines"
				? `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${fileLines}. Use offset=${nextOffset} to continue.]`
				: `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${fileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		return { text: `${truncation.content}\n\n${notice}`, details: { truncation } };
	}
	if (userLimitedLines !== undefined && startLine + userLimitedLines < fileLines) {
		const remaining = fileLines - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		return {
			text: `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`,
			details: undefined,
		};
	}
	return { text: truncation.content, details: undefined };
}

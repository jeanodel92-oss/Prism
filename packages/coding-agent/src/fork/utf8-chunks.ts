/**
 * fork: stdout and stderr of a shell feed one callback, and its readers decode
 * that callback's bytes with a single UTF-8 decoder. A character split across two stdout chunks, with stderr
 * written in between, was decoded as the start of one character followed by stderr's bytes. Each stream goes
 * through its own `wholeCharacters`, which holds back the bytes of an unfinished character until the next chunk
 * of that stream: every chunk passed on ends on a character boundary. The bytes themselves are not changed.
 */

/** The length of the unfinished UTF-8 character at the end of `chunk`, 0 when it ends on a boundary. */
export function unfinishedTail(chunk: Buffer): number {
	for (let back = 1; back <= Math.min(4, chunk.length); back++) {
		const byte = chunk[chunk.length - back]!;
		if ((byte & 0xc0) === 0x80) continue;
		const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return length > back ? back : 0;
	}
	return 0;
}

export function wholeCharacters(onData: (data: Buffer) => void): { write: (chunk: Buffer) => void; end: () => void } {
	let held: Buffer | undefined;
	return {
		write: (chunk) => {
			const data = held ? Buffer.concat([held, chunk]) : chunk;
			const tail = unfinishedTail(data);
			held = tail > 0 ? data.subarray(data.length - tail) : undefined;
			if (data.length > tail) onData(data.subarray(0, data.length - tail));
		},
		end: () => {
			if (held) onData(held);
			held = undefined;
		},
	};
}

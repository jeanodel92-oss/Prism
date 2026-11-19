/**
 * fork: the lines of a server-sent event stream, split in linear time and bounded.
 *
 * The Anthropic reader appended every chunk to one buffer and searched the whole buffer for a line break again on
 * each chunk: a 32 MiB line took 5 s, and 64 MiB without a line break ran the process out of heap. Here only the
 * new chunk is searched, and an event (its lines together, the unfinished one included) over the bound ends the
 * stream with an error instead of growing without limit.
 */

/** Characters one event may hold. Real events are deltas of a few KiB; a few MiB leaves a wide margin. */
export const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;

const LINE_BREAK = /\r\n|\r|\n/g;

export class SseLineSplitter {
	/** The start of a line whose break has not arrived yet. */
	private pending = "";
	/** Characters of the event being read, in its finished lines. */
	private eventChars = 0;
	/** The previous chunk ended with CR: an LF opening the next one belongs to the same break. */
	private afterCarriageReturn = false;

	/** The lines this chunk finishes. Throws when the event being read goes over the bound. */
	push(text: string): string[] {
		const lines: string[] = [];
		let start = this.afterCarriageReturn && text.startsWith("\n") ? 1 : 0;
		this.afterCarriageReturn = false;
		LINE_BREAK.lastIndex = start;
		for (let match = LINE_BREAK.exec(text); match; match = LINE_BREAK.exec(text)) {
			const line = this.pending + text.slice(start, match.index);
			this.pending = "";
			this.eventChars = line === "" ? 0 : this.eventChars + line.length;
			this.check(0);
			lines.push(line);
			start = match.index + match[0].length;
			this.afterCarriageReturn = match[0] === "\r" && start === text.length;
		}
		this.check(text.length - start);
		this.pending += text.slice(start);
		return lines;
	}

	/** The last line, when the stream ends without a break after it. */
	end(): string | undefined {
		const line = this.pending;
		this.pending = "";
		return line.length > 0 ? line : undefined;
	}

	private check(incoming: number): void {
		if (this.eventChars + this.pending.length + incoming > MAX_SSE_EVENT_CHARS) {
			throw new Error(
				`The provider sent a stream event over ${MAX_SSE_EVENT_CHARS / 1024 / 1024} MiB; the response was refused.`,
			);
		}
	}
}

/**
 * fork: whole events, their lines
 * joined by "\n", split by an empty line. Same linear time and bound as SseLineSplitter; any line break counts.
 */
export class SseEventSplitter {
	private readonly lines = new SseLineSplitter();
	private event: string[] = [];

	/** The events this chunk finishes. Throws when the event being read goes over the bound. */
	push(text: string): string[] {
		const events: string[] = [];
		for (const line of this.lines.push(text)) {
			if (line !== "") this.event.push(line);
			else if (this.event.length > 0) {
				events.push(this.event.join("\n"));
				this.event = [];
			}
		}
		return events;
	}

	/** The last event, when the stream ends without an empty line after it. */
	end(): string | undefined {
		const last = this.lines.end();
		if (last !== undefined) this.event.push(last);
		const raw = this.event.join("\n");
		this.event = [];
		return raw.length > 0 ? raw : undefined;
	}
}

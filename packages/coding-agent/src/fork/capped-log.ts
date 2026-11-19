/**
 * fork: the file that keeps a command's full output, capped. A command looping forever once
 * wrote a 5.5 GB log into /tmp, a tmpfs held in memory. Up to the cap the file is the output as it comes; past it,
 * the file keeps the first half as written and the last half in memory, written after a line that says how much was
 * left out when the command ends, is cancelled, or when Prism exits while it runs. Memory stays bounded by half the
 * cap and one chunk. Writes are synchronous, so that the end can still be written from the process's exit event;
 * after SIGKILL it is lost.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { unfinishedTail } from "./utf8-chunks.ts";

/** 32 MiB per log. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;

const isContinuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

/** Logs not yet closed, whose kept end is written if Prism exits first. */
const open = new Set<CappedLog>();
let exitHooked = false;

export class CappedLog {
	private fd: number | undefined;
	private readonly maxBytes: number;
	private readonly headMax: number;
	private tailMax: number;
	private headBytes = 0;
	/** The head is written up to its last whole character, and nothing is added to it after. */
	private headDone = false;
	/** The start of a character whose other bytes have not been written yet. */
	private carry: Buffer | undefined;
	private tail: Buffer[] = [];
	private tailBytes = 0;
	private omitted = 0;
	/** fork: why the file could not be opened or stopped being written. */
	private failure: string | undefined;

	constructor(path: string, maxBytes = MAX_LOG_BYTES) {
		this.maxBytes = maxBytes;
		this.headMax = Math.floor(maxBytes / 2);
		this.tailMax = maxBytes - this.headMax;
		try {
			// fork: a command's output is private to the user, even in a shared /tmp.
			this.fd = openSync(path, "w", 0o600);
		} catch (error) {
			// The output still reaches the model; only the file is missing.
			this.failure = error instanceof Error ? error.message : String(error);
			return;
		}
		open.add(this);
		if (!exitHooked) {
			exitHooked = true;
			process.once("exit", () => {
				for (const log of open) log.close();
			});
		}
	}

	write(data: Buffer | string): void {
		if (this.fd === undefined) return;
		// fork: a character split between two writes is kept until its last
		// byte arrives, so the head's limit and the start of the kept end fall between two characters.
		const chunk = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
		const bytes = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
		const unfinished = unfinishedTail(bytes);
		this.carry = unfinished > 0 ? bytes.subarray(bytes.length - unfinished) : undefined;
		this.take(bytes.subarray(0, bytes.length - unfinished));
	}

	private take(data: Buffer): void {
		// fork: empty pieces were kept in the end's list without ever counting toward it.
		if (data.length === 0) return;
		let bytes = data;
		if (!this.headDone) {
			let room = this.headMax - this.headBytes;
			if (bytes.length <= room) {
				this.put(bytes);
				this.headBytes += bytes.length;
				return;
			}
			// Cut between two characters, so that the head stays valid UTF-8.
			while (room > 0 && isContinuation(bytes[room])) room--;
			this.put(bytes.subarray(0, room));
			this.headBytes += room;
			this.headDone = true;
			// What the cut left out of the head goes to the end, so that output within the cap is kept whole.
			this.tailMax = this.maxBytes - this.headBytes;
			bytes = bytes.subarray(room);
		}
		this.tail.push(bytes);
		this.tailBytes += bytes.length;
		while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= this.tailMax) {
			const dropped = this.tail.shift()!;
			this.tailBytes -= dropped.length;
			this.omitted += dropped.length;
		}
	}

	/** Why the file is missing or incomplete; undefined while it holds the output. */
	get error(): string | undefined {
		return this.failure;
	}

	/** Writes the kept end of the output, then closes the file; again, does nothing. */
	end(): Promise<void> {
		this.close();
		return Promise.resolve();
	}

	private put(data: Buffer | string): void {
		const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
		try {
			for (let done = 0; this.fd !== undefined && done < bytes.length; ) {
				done += writeSync(this.fd, bytes, done);
			}
		} catch (error) {
			// A full disk: the file keeps what it has.
			this.failure = error instanceof Error ? error.message : String(error);
			this.release();
		}
	}

	private release(): void {
		const fd = this.fd;
		this.fd = undefined;
		this.tail = [];
		open.delete(this);
		if (fd === undefined) return;
		try {
			closeSync(fd);
		} catch {}
	}

	private close(): void {
		if (this.fd === undefined) return;
		if (this.carry) this.take(this.carry);
		this.carry = undefined;
		let first = this.tail[0];
		if (first && this.tailBytes > this.tailMax) {
			let skip = this.tailBytes - this.tailMax;
			while (skip < first.length && isContinuation(first[skip])) skip++;
			first = first.subarray(skip);
			this.tail[0] = first;
			this.tailBytes -= skip;
			this.omitted += skip;
		}
		const tail = this.tail;
		this.tail = [];
		if (this.omitted > 0) {
			this.put(
				`\n\n[... ${this.omitted} bytes omitted: this log keeps the first and last ${Math.round(this.headMax / 1024 / 1024)} MiB of the output ...]\n\n`,
			);
		}
		for (const chunk of tail) this.put(chunk);
		this.release();
	}
}

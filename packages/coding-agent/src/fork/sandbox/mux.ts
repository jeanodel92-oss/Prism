/**
 * fork: several byte streams over one pair of pipes, between the relay inside the sandbox
 * and Prism's proxy outside it. The sandbox cannot open a Unix socket (seccomp) and has no network, so
 * the pipes, opened before the sandbox starts, are its only way out.
 *
 * Frame: type (u8), stream id (u32 BE), payload length (u32 BE), payload. Only the relay opens streams.
 *
 * fork: each stream has its own window. A side sends at most
 * {@link WINDOW} bytes of a stream that the other side has not yet handed to its reader; the reader's side grants
 * more (a CREDIT frame) as its reader takes them. Before, a full stream paused the shared pipe and any other stream's
 * read resumed it, so the full stream's buffer grew without bound; and one stuck stream could not stall the others
 * without that. A peer that sends past its window is broken or hostile: the whole channel closes.
 */

import { Duplex, type Readable, type Writable } from "node:stream";

const OPEN = 1;
const DATA = 2;
const END = 3;
const CLOSE = 4;
const CREDIT = 5;
const HEADER = 9;
/** Larger frames mean a broken or hostile peer; the whole channel closes. */
const MAX_PAYLOAD = 1 << 20;
/** The most of one stream held for a reader that does not read: the bound of each stream's buffer. */
export const WINDOW = 256 * 1024;
/**
 * fork: the most streams open at once on one channel. Each holds up to {@link WINDOW}, so this
 * bounds the channel's buffers (256 MiB), far above what a command's connections need. An OPEN past it is refused
 * (CLOSE for that stream); the channel and its other streams go on.
 */
export const MAX_STREAMS = 1024;

/** What a stream may still send, and what it has received and granted back. */
interface Flow {
	stream: Duplex;
	/** Bytes this side may still send. */
	credit: number;
	/** A write waiting for credit: what is left of it, and its callback. */
	waiting?: { rest: Buffer; callback: (error?: Error | null) => void };
	/** Bytes received, and bytes granted back to the sender (received minus what is still unread, at most). */
	received: number;
	granted: number;
}

export class Mux {
	private readonly streams = new Map<number, Flow>();
	private nextId = 1;
	private buffered: Buffer = Buffer.alloc(0);
	private closed = false;
	private readonly output: Writable;
	private readonly onOpen: ((stream: Duplex) => void) | undefined;

	constructor(input: Readable, output: Writable, onOpen?: (stream: Duplex) => void) {
		this.output = output;
		this.onOpen = onOpen;
		input.on("data", (chunk: Buffer) => this.receive(chunk));
		input.on("end", () => this.close());
		input.on("error", () => this.close());
		output.on("error", () => this.close());
	}

	/** A new stream to the other side. */
	open(): Duplex {
		const id = this.nextId++;
		const stream = this.stream(id);
		this.send(OPEN, id);
		return stream;
	}

	/** Closes every stream; the pipes are left to their owner. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const flow of this.streams.values()) flow.stream.destroy();
		this.streams.clear();
	}

	private send(type: number, id: number, payload: Buffer = Buffer.alloc(0)): boolean {
		if (this.closed) return true;
		const header = Buffer.alloc(HEADER);
		header.writeUInt8(type, 0);
		header.writeUInt32BE(id, 1);
		header.writeUInt32BE(payload.length, 5);
		return this.output.write(payload.length ? Buffer.concat([header, payload]) : header);
	}

	/** Sends what the stream's credit allows of `chunk`; the rest waits for a CREDIT frame. */
	private sendData(id: number, flow: Flow, chunk: Buffer, callback: (error?: Error | null) => void): void {
		let ok = true;
		let offset = 0;
		while (offset < chunk.length && flow.credit > 0 && !this.closed) {
			const size = Math.min(chunk.length - offset, flow.credit, MAX_PAYLOAD);
			ok = this.send(DATA, id, chunk.subarray(offset, offset + size)) && ok;
			flow.credit -= size;
			offset += size;
		}
		if (offset < chunk.length && !this.closed) {
			flow.waiting = { rest: chunk.subarray(offset), callback };
			return;
		}
		if (ok || this.closed) callback();
		else this.output.once("drain", () => callback());
	}

	/**
	 * Grants back what the reader has taken: always when it asks for more (`asked`, from `read()`, which Node calls
	 * once until the next push), otherwise once it is worth a frame or the reader has taken everything.
	 */
	private grant(id: number, flow: Flow, asked: boolean): void {
		if (this.streams.get(id) !== flow) return;
		const taken = flow.received - flow.stream.readableLength;
		const more = taken - flow.granted;
		if (more <= 0 || (!asked && more < WINDOW / 4 && flow.stream.readableLength > 0)) return;
		flow.granted += more;
		const payload = Buffer.alloc(4);
		payload.writeUInt32BE(more, 0);
		this.send(CREDIT, id, payload);
	}

	private stream(id: number): Duplex {
		let flow: Flow;
		const stream = new Duplex({
			write: (chunk: Buffer, _encoding, callback) => this.sendData(id, flow, chunk, callback),
			final: (callback) => {
				this.send(END, id);
				callback();
			},
			// On the next tick: Node calls read() before it takes the bytes being read out of the buffer.
			read: () => process.nextTick(() => this.grant(id, flow, true)),
			destroy: (error, callback) => {
				// fork: END lets the peer drain buffered data; CLOSE would discard it.
				if (this.streams.delete(id) && !(stream.readableEnded && stream.writableFinished)) this.send(CLOSE, id);
				flow.waiting = undefined;
				callback(error);
			},
		});
		flow = { stream, credit: WINDOW, received: 0, granted: 0 };
		this.streams.set(id, flow);
		return stream;
	}

	private receive(chunk: Buffer): void {
		this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
		while (this.buffered.length >= HEADER && !this.closed) {
			const type = this.buffered.readUInt8(0);
			const id = this.buffered.readUInt32BE(1);
			const length = this.buffered.readUInt32BE(5);
			if (length > MAX_PAYLOAD || type < OPEN || type > CREDIT || (type === CREDIT && length !== 4)) {
				this.close();
				return;
			}
			if (this.buffered.length < HEADER + length) return;
			const payload = this.buffered.subarray(HEADER, HEADER + length);
			this.buffered = this.buffered.subarray(HEADER + length);
			const flow = this.streams.get(id);
			if (type === OPEN) {
				if (flow || !this.onOpen) {
					this.close();
					return;
				}
				if (this.streams.size >= MAX_STREAMS) {
					this.send(CLOSE, id);
					continue;
				}
				this.onOpen(this.stream(id));
			} else if (type === DATA) {
				if (!flow) continue;
				flow.received += payload.length;
				// More than granted: the peer ignores its window.
				if (flow.received - flow.granted > WINDOW) {
					this.close();
					return;
				}
				// Copied: the frame buffer is reused by later frames.
				flow.stream.push(Buffer.from(payload));
				this.grant(id, flow, false);
			} else if (type === CREDIT) {
				if (!flow) continue;
				flow.credit += payload.readUInt32BE(0);
				const waiting = flow.waiting;
				if (waiting) {
					flow.waiting = undefined;
					this.sendData(id, flow, waiting.rest, waiting.callback);
				}
			} else if (type === END) {
				flow?.stream.push(null);
			} else if (flow) {
				this.streams.delete(id);
				flow.stream.destroy();
			}
		}
	}
}

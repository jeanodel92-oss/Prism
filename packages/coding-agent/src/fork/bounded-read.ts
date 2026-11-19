/**
 * fork: reads that check before they read. Opening a named pipe with no writer
 * blocks the engine's only thread before any check runs, and a "read it all, then keep
 * the start" allocates the whole file first. Here the open never blocks (O_NONBLOCK), the
 * descriptor is checked to be a regular file, and at most `max` bytes are read, whatever the file grows to meanwhile.
 */

import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	openSync,
	readSync,
	type Stats,
	unlinkSync,
	writeSync,
} from "node:fs";
import { open } from "node:fs/promises";

/** What a non-regular file is, for the refusal; undefined for a regular file. */
function specialKind(stat: Stats): string | undefined {
	if (stat.isFile()) return undefined;
	if (stat.isFIFO()) return "a named pipe (FIFO)";
	if (stat.isCharacterDevice()) return "a character device";
	if (stat.isBlockDevice()) return "a block device";
	if (stat.isSocket()) return "a socket";
	if (stat.isDirectory()) return "a directory";
	return "not a regular file";
}

/** A read refused before it started: not a regular file, or above its limit. */
export class ReadRefused extends Error {
	readonly reason: "special" | "too-large";
	constructor(reason: "special" | "too-large", message: string) {
		super(message);
		this.name = "ReadRefused";
		this.reason = reason;
	}
}

export interface BoundedReadOptions {
	/** Follow a final symbolic link (default true). */
	follow?: boolean;
	/** Above `max`: "throw" (default) refuses, "truncate" returns the first `max` bytes. */
	over?: "throw" | "truncate";
}

const flags = (follow: boolean) => constants.O_RDONLY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW);

function refuseSpecial(path: string, stat: Stats): void {
	const kind = specialKind(stat);
	if (kind) throw new ReadRefused("special", `${path} is ${kind}, not a regular file`);
}

const tooLarge = (path: string, max: number) => new ReadRefused("too-large", `${path} is larger than ${max} bytes`);

/** Opens `path` without blocking and checks, on the descriptor, that it is a regular file. The caller closes it. */
export function openRegularSync(path: string, follow = true): { fd: number; stat: Stats } {
	const fd = openSync(path, flags(follow));
	try {
		const stat = fstatSync(fd);
		refuseSpecial(path, stat);
		return { fd, stat };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

/** Reads at most `max` bytes of an open regular file from `position` (default: the start); one more says "over". */
export function readFdBounded(fd: number, max: number, position = 0): { data: Buffer; over: boolean } {
	const chunks: Buffer[] = [];
	let total = 0;
	while (total <= max) {
		const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total));
		const read = readSync(fd, chunk, 0, chunk.length, position + total);
		if (read === 0) break;
		chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read));
		total += read;
	}
	const data = Buffer.concat(chunks, total);
	return total > max ? { data: data.subarray(0, max), over: true } : { data, over: false };
}

/** Reads the regular file `path`, at most `max` bytes, without ever blocking on its open. */
export function readBoundedSync(path: string, max: number, options: BoundedReadOptions = {}): Buffer {
	const { fd, stat } = openRegularSync(path, options.follow ?? true);
	try {
		if (stat.size > max && options.over !== "truncate") throw tooLarge(path, max);
		const { data, over } = readFdBounded(fd, max);
		if (over && options.over !== "truncate") throw tooLarge(path, max);
		return data;
	} finally {
		closeSync(fd);
	}
}

/** The last `max` bytes of the regular file `path` (a log), never the whole file; `cut` when it was longer. */
export function readTailSync(path: string, max: number): { data: Buffer; cut: boolean } {
	const { fd, stat } = openRegularSync(path);
	try {
		const start = Math.max(0, stat.size - max);
		return { data: readFdBounded(fd, max, start).data, cut: start > 0 };
	} finally {
		closeSync(fd);
	}
}

/** The asynchronous `readBoundedSync`, for readers on the engine's hot paths. */
export async function readBounded(path: string, max: number, options: BoundedReadOptions = {}): Promise<Buffer> {
	const handle = await open(path, flags(options.follow ?? true));
	try {
		const stat = await handle.stat();
		refuseSpecial(path, stat);
		if (stat.size > max && options.over !== "truncate") throw tooLarge(path, max);
		const chunks: Buffer[] = [];
		let total = 0;
		while (total <= max) {
			const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, max + 1 - total));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
			if (bytesRead === 0) break;
			chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
		const data = Buffer.concat(chunks, total);
		if (total <= max) return data;
		if (options.over !== "truncate") throw tooLarge(path, max);
		return data.subarray(0, max);
	} finally {
		await handle.close();
	}
}

/**
 * Copies the regular file `source` into the open descriptor `fd`, at most `max` bytes; returns `source`'s status as
 * opened. It stops at the file's end as it reads it, never at the size seen first: Node's copyFileSync loops forever
 * on a source truncated meanwhile.
 */
export function copyBoundedInto(source: string, fd: number, max: number): Stats {
	const { fd: input, stat } = openRegularSync(source);
	try {
		if (stat.size > max) throw tooLarge(source, max);
		const chunk = Buffer.allocUnsafe(1024 * 1024);
		for (let total = 0; ; ) {
			const read = readSync(input, chunk, 0, chunk.length, total);
			if (read === 0) return stat;
			total += read;
			if (total > max) throw tooLarge(source, max);
			for (let done = 0; done < read; ) done += writeSync(fd, chunk, done, read - done);
		}
	} finally {
		closeSync(input);
	}
}

/**
 * `copyFileSync(source, target, COPYFILE_EXCL)` through {@link copyBoundedInto}: `target` must not exist (`EEXIST`),
 * gets `source`'s permissions, and is removed when the copy fails.
 */
export function copyFileExclusive(source: string, target: string, max: number): void {
	const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		fchmodSync(fd, copyBoundedInto(source, fd, max).mode & 0o7777);
	} catch (error) {
		closeSync(fd);
		unlinkSync(target);
		throw error;
	}
	closeSync(fd);
}

/** A small metadata file (a Git HEAD, a `.git` pointer): its text, refused when not a regular file of at most 64 KiB. */
export const readSmallTextSync = (path: string): string => readBoundedSync(path, 64 * 1024).toString("utf8");

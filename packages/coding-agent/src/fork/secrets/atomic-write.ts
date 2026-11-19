/**
 * fork: auth.json is replaced, never rewritten in place, so a crash or a
 * full disk cannot leave it truncated. The new content goes to a temporary file in the same folder, created with
 * mode 0600 and given the old file's mode, written whole, synced, then renamed over the file; the folder is synced
 * last. A link is followed: its target is replaced and the link stays.
 *
 * The caller holds auth.json's lock (FileAuthStorageBackend), so a temporary file whose process is gone is left
 * from an interrupted write and is removed here. ACLs and the maintainer of the old file are not carried over.
 */

import { randomBytes } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	ftruncateSync,
	openSync,
	readdirSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Test points: before the rename (a failure leaves the old file) and after it (the new file is in place). */
export const atomicWriteHooks: { beforeRename?: (temp: string) => void; afterRename?: () => void } = {};

const STALE_MS = 10 * 60_000;

/** fork: files whose writer holds a lock, by real path, with whether it may be lost. */
const holds = new Map<string, () => boolean>();

/** While the returned function is not called, a write to `target` is refused once `lost()` says so. */
export function holdForWrite(target: string, lost: () => boolean): () => void {
	holds.set(target, lost);
	return () => {
		if (holds.get(target) === lost) holds.delete(target);
	};
}

function prefix(target: string): string {
	return `.${basename(target)}.`;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Temporary files of earlier writes whose process died (or that are old), under the caller's lock. */
function removeStale(target: string): void {
	const folder = dirname(target);
	const start = prefix(target);
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return;
	}
	for (const name of names) {
		const match = name.startsWith(start) ? /^(\d+)\.[0-9a-f]+\.tmp$/.exec(name.slice(start.length)) : null;
		if (!match) continue;
		const path = join(folder, name);
		try {
			if (alive(Number(match[1])) && Date.now() - statSync(path).mtimeMs < STALE_MS) continue;
			unlinkSync(path);
		} catch {}
	}
}

/** Rewrites the existing `target` through its own descriptor: content from the start, then cut to its length. */
function writeInPlace(target: string, data: string | Uint8Array): void {
	const bytes = typeof data === "string" ? Buffer.from(data) : data;
	const fd = openSync(target, constants.O_WRONLY | constants.O_NOFOLLOW);
	try {
		let written = 0;
		while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, written);
		ftruncateSync(fd, bytes.length);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function writeFileAtomicSync(path: string, data: string | Uint8Array, options: { mode?: number } = {}): void {
	let target = path;
	try {
		target = realpathSync(path);
	} catch {}
	if (holds.get(target)?.())
		throw new Error(
			`${path} was not written: its lock may have passed to another writer while this one waited. Nothing was changed; try again.`,
		);
	// fork: a file the user made read-only is refused, as a write in place refused it.
	try {
		accessSync(target, constants.W_OK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	removeStale(target);
	let mode = options.mode ?? 0o600;
	try {
		mode = statSync(target).mode & 0o7777;
	} catch {}
	const temp = join(dirname(target), `${prefix(target)}${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	let fd: number | undefined = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		if (mode !== 0o600) fchmodSync(fd, mode);
		writeFileSync(fd, data);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		atomicWriteHooks.beforeRename?.(temp);
		renameSync(temp, target);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
		try {
			unlinkSync(temp);
		} catch {}
		// fork: a file mounted on its own (`docker -v auth.json:…`, a bind mount)
		// cannot be renamed over: EBUSY, or EXDEV across mounts. It is written in place instead, as edit and write do;
		// that write is not atomic.
		const code = fd === undefined ? (error as NodeJS.ErrnoException).code : undefined;
		if (code !== "EBUSY" && code !== "EXDEV") throw error;
		writeInPlace(target, data);
		return;
	}
	// The new content is in place: from here a failure only weakens durability, so nothing is thrown.
	try {
		atomicWriteHooks.afterRename?.();
		const folder = openSync(dirname(target), constants.O_RDONLY);
		try {
			fsyncSync(folder);
		} finally {
			closeSync(folder);
		}
	} catch {}
}

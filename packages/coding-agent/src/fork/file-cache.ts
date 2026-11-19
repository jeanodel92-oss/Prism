// fork: cache parsed configuration, never filesystem failures.
import { type Stats, statSync } from "node:fs";

/**
 * fork: how long after a change a file's stamp is not trusted. Linux before 6.13
 * (Debian 13, Ubuntu 24.04) dates a change at the scheduler tick, a few milliseconds: two changes in one tick, the
 * second taking the inode the first freed, leave the same stamp, and a cache keyed by it served the older content
 * (measured on Linux 6.12: 485 times in 500). As Git does with its "racily clean" entries, a file changed this
 * recently is read again rather than recognised by its stamp. Two seconds also cover a filesystem dated to the
 * even second (FAT).
 */
export const RACY_MS = 2_000;

/** Whether a change at `ctimeMs` is too recent for the file's stamp to tell its version (see {@link RACY_MS}). */
export function isRacy(ctimeMs: number, now = Date.now()): boolean {
	return now - ctimeMs < RACY_MS;
}

function stampOf(stat: Stats): string {
	return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
}

/**
 * What tells one version of a file from another: device, inode, modification and change times, size. The
 * modification time alone misses a file replaced with the same one (an editor's rename, a restored mtime);
 * the change time cannot be set back. Throws when the file cannot be read. Not enough on its own for a file
 * changed less than {@link RACY_MS} ago: {@link isRacy}.
 */
export function fileStamp(path: string): string {
	return stampOf(statSync(path));
}

/** The stamp of `path`, and whether it is too recent to be trusted ({@link isRacy}). Throws like {@link fileStamp}. */
export function fileVersion(path: string): { stamp: string; racy: boolean } {
	const stat = statSync(path);
	return { stamp: stampOf(stat), racy: isRacy(stat.ctimeMs) };
}

/**
 * Values must be cloneable: callers keep the same ownership as with a fresh JSON read. `fresh` reads the file
 * without the cache, for a read-modify-write under a lock, which must see the last writer's version.
 */
export function cacheFile<T>(
	read: (path: string) => T,
	valid: (value: T) => boolean = () => true,
): ((path: string) => T) & { fresh: (path: string) => T } {
	const entries = new Map<string, { stamp: string; value: T }>();
	const cached = (path: string): T => {
		let version: { stamp: string; racy: boolean };
		try {
			version = fileVersion(path);
		} catch {
			entries.delete(path);
			return read(path);
		}
		const entry = entries.get(path);
		if (!version.racy && entry?.stamp === version.stamp) return structuredClone(entry.value);
		entries.delete(path);
		const value = read(path);
		// A racy version is not kept: a later change in the same tick could give the same stamp.
		if (!version.racy && valid(value)) entries.set(path, { stamp: version.stamp, value: structuredClone(value) });
		return value;
	};
	return Object.assign(cached, { fresh: read });
}

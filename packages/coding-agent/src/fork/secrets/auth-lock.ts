/**
 * fork: one lock threshold for every writer of auth.json, and a write refused
 * when the lock may have been lost.
 *
 * proper-lockfile keeps a lock fresh from a timer, every `staleMs / 2`; another process takes a lock older than its
 * own `staleMs` as abandoned. Two failures followed:
 *
 * - the synchronous lock used proper-lockfile's default threshold (10 s) and the asynchronous one 30 s, renewed every
 *   15 s: a synchronous writer could take a lock an asynchronous one still held;
 * - a holder whose event loop was blocked (synchronous `secret-tool` calls, 4 × 9 s) renewed nothing: another writer
 *   took its lock after 30 s and wrote, then the holder wrote over it. Its own compromise check runs from the same
 *   blocked timer, after the write.
 *
 * The keyring calls are asynchronous now (`keyring.ts`); this module is what remains: the shared threshold, a watch
 * that refuses the write when the holder's loop stopped long enough for the lock to go stale, and a release that then
 * leaves the lock in place: proper-lockfile removes it without checking it is still the holder's, which would free
 * the lock of the writer that took it over.
 */

import * as nodeFs from "node:fs";

/** Tests lower it (proper-lockfile's minimum is 2 s); everything else reads it at each lock. */
export const authLockTiming = { staleMs: 30_000 };

export interface LockWatch {
	/** Whether the holder's event loop stopped long enough for another process to take the lock as stale. */
	lost(): boolean;
	stop(): void;
}

/**
 * Watches the event loop from the moment a lock is taken. The lock is renewed every `staleMs / 2`, so it can go stale
 * only if the loop stops for about `staleMs / 2`; a stop that long counts as lost, with a step of margin.
 */
export function watchLockHold(staleMs = authLockTiming.staleMs): LockWatch {
	const step = Math.min(1_000, staleMs / 8);
	let last = Date.now();
	let longest = 0;
	const timer = setInterval(() => {
		const now = Date.now();
		longest = Math.max(longest, now - last);
		last = now;
	}, step);
	timer.unref();
	return {
		lost: () => Math.max(longest, Date.now() - last) >= staleMs / 2 - step,
		stop: () => clearInterval(timer),
	};
}

export function lockLostError(): Error {
	return new Error(
		"auth.json was not written: its lock may have passed to another writer while this one waited. Nothing was changed; try again.",
	);
}

/**
 * proper-lockfile's file system (its `fs` option), whose removal of the lock is skipped once `keep()` says so: a lock
 * that may be another writer's now is left to go stale like an abandoned one, so others wait at most `staleMs`.
 */
export function lockFileSystem(keep: () => boolean): typeof nodeFs {
	// proper-lockfile calls `rmdir(path, callback)` and `rmdirSync(path)` only.
	const rmdir = (path: nodeFs.PathLike, callback: nodeFs.NoParamCallback) => {
		if (keep()) callback(null);
		else nodeFs.rmdir(path, callback);
	};
	const rmdirSync = (path: nodeFs.PathLike) => {
		if (!keep()) nodeFs.rmdirSync(path);
	};
	return { ...nodeFs, rmdir: rmdir as typeof nodeFs.rmdir, rmdirSync };
}

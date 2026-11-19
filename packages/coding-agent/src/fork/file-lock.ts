import { setTimeout as pause } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { realPath } from "./real-path.ts";
import { holdForWrite } from "./secrets/atomic-write.ts";
import { lockFileSystem, watchLockHold } from "./secrets/auth-lock.ts";

/** proper-lockfile's own threshold: a lock not renewed for this long is taken by the next writer. */
const STALE_MS = 10_000;

/**
 * Run an update under the same cross-process lock, yielding between acquisition attempts.
 *
 * fork: the lock is the file's real path's, so two names of one file share it;
 * and while `fn` runs, an atomic write to that file is refused once the lock may have gone stale (a blocked event loop
 * renews nothing), then the lock is left for the writer that took it.
 */
export async function lockForkFile<T>(
	path: string,
	fn: () => T | Promise<T>,
	retry: { attempts: number; delayMs: number } = { attempts: 500, delayMs: 10 },
): Promise<T> {
	const target = realPath(path);
	for (let attempt = 0; attempt < retry.attempts; attempt++) {
		let release: () => void;
		const watch = watchLockHold(STALE_MS);
		try {
			release = lockfile.lockSync(target, {
				realpath: false,
				stale: STALE_MS,
				fs: lockFileSystem(() => watch.lost()),
			});
		} catch (error) {
			watch.stop();
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === retry.attempts - 1) throw error;
			await pause(retry.delayMs);
			continue;
		}
		const unhold = holdForWrite(target, () => watch.lost());
		try {
			return await fn();
		} finally {
			unhold();
			watch.stop();
			release();
		}
	}
	throw new Error("Could not acquire Prism file lock");
}

import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { realPath } from "../../fork/real-path.ts";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

// fork: the file the path leads to, also before it exists (a linked parent, a dangling
// final link): the key stays the same once the write creates it.
// fork: a file with several names (hard links) is one file under each: keyed by its
// identity. A file with one name keeps its path's key, the one it had before it existed.
async function getMutationQueueKey(filePath: string): Promise<string> {
	const real = realPath(resolve(filePath));
	const stat = await lstat(real).catch(() => undefined);
	return stat?.isFile() && stat.nlink > 1 ? `inode:${stat.dev}:${stat.ino}` : real;
}

/**
 * fork: holds the file's queue until the returned function is called, for a read whose
 * checks and bytes must come from one state of the file.
 */
export function holdFileMutationQueue(filePath: string): Promise<() => void> {
	return new Promise((held, failed) => {
		withFileMutationQueue(filePath, () => new Promise<void>((release) => held(release))).catch(failed);
	});
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}

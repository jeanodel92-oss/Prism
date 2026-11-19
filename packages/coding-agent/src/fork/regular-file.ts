/**
 * fork: read, edit and write refuse named pipes, devices and sockets. Opening a FIFO
 * blocks until a peer opens the other end, so the tool hangs; a character device such as /dev/zero
 * never ends, and `readFile` buffers it until memory runs out.
 * Directories and missing paths keep the tools' own errors.
 */
import { stat } from "node:fs/promises";

/** fork: `edit` reads the whole file into memory; above this, the model is sent to bash. */
export const MAX_EDITABLE_FILE_SIZE = 32 * 1024 * 1024;

/** Throws when the file is larger than the edit tool's in-memory size limit. */
export async function assertEditableSize(absolutePath: string, limit = MAX_EDITABLE_FILE_SIZE): Promise<void> {
	const stats = await stat(absolutePath);
	if (stats.size > limit) {
		throw new Error(
			`${absolutePath} is ${stats.size} bytes, above the edit limit of ${limit} bytes. The file was not changed. Use bash to edit this file instead, for example with sed -i, awk, perl -pi, or a short python3 script. View the relevant parts first with head, tail, grep -n, or sed -n 'X,Yp'.`,
		);
	}
}

/** Throws when `absolutePath` exists and is a FIFO, a device or a socket. */
export async function assertNotSpecialFile(absolutePath: string): Promise<void> {
	const stats = await stat(absolutePath).catch(() => undefined);
	if (!stats) return;
	const kind = stats.isFIFO()
		? "a named pipe (FIFO)"
		: stats.isCharacterDevice()
			? "a character device"
			: stats.isBlockDevice()
				? "a block device"
				: stats.isSocket()
					? "a socket"
					: undefined;
	if (kind) {
		throw new Error(
			`${absolutePath} is ${kind}, not a regular file. Use bash to work with it, with a bound such as head -c.`,
		);
	}
}

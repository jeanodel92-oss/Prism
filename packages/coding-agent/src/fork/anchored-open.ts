/**
 * fork: open the file a decision judged, not whatever its name leads to later.
 *
 * Node has no `openat`. Each directory of a physical path (links already resolved when it was judged) is opened
 * from its parent's descriptor through `/proc/self/fd/<fd>/<name>`, with `O_NOFOLLOW`: a link put on the path after
 * the decision makes the open fail instead of being followed. Linux only; elsewhere callers keep opening by name.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fchownSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	type Stats,
	unlinkSync,
	writeSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { atomicWriteHooks } from "./secrets/atomic-write.ts";

export const anchoredOpenSupported = process.platform === "linux";

/** A file's identity on its file system: the same object under any of its names. */
export interface FileIdentity {
	dev: number;
	ino: number;
}

export const identityOf = (stat: Pick<Stats, "dev" | "ino">): FileIdentity => ({ dev: stat.dev, ino: stat.ino });
export const sameIdentity = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;

/**
 * - `read`: an existing file, read only.
 * - `write`: created if missing (`O_EXCL`), never truncated by the open: the caller checks what it opened first.
 * - `update`: an existing file, read and written by the same descriptor (`edit`).
 */
export type AnchoredMode = "read" | "write" | "update";

export interface AnchoredFile {
	fd: number;
	stat: Stats;
	/** The open created the file. */
	created: boolean;
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * Why an open failed, said for the user: a link on the path, or the system's own reason, naming `physical` and not
 * the `/proc/self/fd/<fd>/<name>` it was opened through.
 */
function reason(error: unknown, physical: string): Error {
	const failed = error as NodeJS.ErrnoException;
	const code = failed.code;
	if (code === "ELOOP" || code === "ENOTDIR" || code === "EMLINK")
		return new Error(
			`${physical}: a symbolic link on this path was not followed, since it is not the file that was allowed (${code}). Nothing was read or written.`,
		);
	if (!(error instanceof Error)) return new Error(String(error));
	if (typeof failed.path !== "string" || !failed.path.startsWith("/proc/self/fd/")) return error;
	const told: NodeJS.ErrnoException = new Error(error.message.split(failed.path).join(physical));
	told.code = code;
	told.errno = failed.errno;
	told.syscall = failed.syscall;
	told.path = physical;
	return told;
}

/**
 * The directory that holds `physical`'s last component, opened from `/` without following any link, and that
 * component. `parents`, a mode, creates the missing directories one by one through the same descriptors.
 */
function openParent(physical: string, parents: number | false): { dir: number; name: string } {
	if (!isAbsolute(physical)) throw new Error(`${physical}: not an absolute path`);
	const parts = physical.split("/").filter((part) => part !== "" && part !== ".");
	const name = parts.pop();
	if (!name || name === ".." || parts.includes("..")) throw new Error(`${physical}: not a file path`);
	let dir = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		for (const part of parts) {
			const at = `/proc/self/fd/${dir}/${part}`;
			let next: number;
			try {
				next = openSync(at, DIRECTORY);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parents === false) throw reason(error, physical);
				try {
					mkdirSync(at, parents);
				} catch (made) {
					if ((made as NodeJS.ErrnoException).code !== "EEXIST") throw reason(made, physical);
				}
				try {
					next = openSync(at, DIRECTORY);
				} catch (again) {
					throw reason(again, physical);
				}
			}
			closeSync(dir);
			dir = next;
		}
		return { dir, name };
	} catch (error) {
		closeSync(dir);
		throw error;
	}
}

/**
 * Opens `physical`, an absolute path without links, walking from `/` and following none. `parents` creates the
 * missing directories (write). The file is a regular file or the open fails.
 */
export function openAnchored(physical: string, mode: AnchoredMode, parents: number | false = false): AnchoredFile {
	const { dir, name } = openParent(physical, parents);
	try {
		const at = `/proc/self/fd/${dir}/${name}`;
		const access = mode === "read" ? constants.O_RDONLY : mode === "write" ? constants.O_WRONLY : constants.O_RDWR;
		// O_NONBLOCK: a FIFO put there must not block the open; it is refused below.
		const flags = access | constants.O_NOFOLLOW | constants.O_NONBLOCK;
		let fd: number | undefined;
		let created = false;
		if (mode === "write") {
			try {
				fd = openSync(at, flags | constants.O_CREAT | constants.O_EXCL, 0o666);
				created = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw reason(error, physical);
			}
		}
		try {
			fd ??= openSync(at, flags);
		} catch (error) {
			throw reason(error, physical);
		}
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			closeSync(fd);
			throw new Error(`${physical}: not a regular file`);
		}
		return { fd, stat, created };
	} finally {
		closeSync(dir);
	}
}

/**
 * Writes `content` to `physical` through no link, for a file Prism writes itself with no decision before (a restore,
 * an attachment, a handoff stamp): a file with another name (hard link) is refused, its other name may be anywhere.
 */
export function writeWithoutLinks(physical: string, content: string | Uint8Array, mode?: number): void {
	const { fd, stat, created } = openAnchored(physical, "write", 0o777);
	try {
		if (stat.nlink > 1) throw new Error(`${physical}: this file has other names (hard links); it was not written.`);
		// fork: a file created again gets the permissions it had, not the umask's.
		if (created && mode !== undefined) fchmodSync(fd, mode);
		replaceAnchored(fd, content);
	} finally {
		closeSync(fd);
	}
}

/**
 * Creates `physical`, which must not exist (`EEXIST` otherwise), its directories made and reached through no link;
 * returns its descriptor, open for writing.
 */
export function createWithoutLinks(physical: string, mode = 0o600): number {
	const { dir, name } = openParent(physical, 0o700);
	try {
		return openSync(
			`/proc/self/fd/${dir}/${name}`,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			mode,
		);
	} catch (error) {
		throw reason(error, physical);
	} finally {
		closeSync(dir);
	}
}

/** Removes `physical`'s last component (a link itself, never what it leads to), its parents reached through no link. */
export function removeWithoutLinks(physical: string): void {
	const { dir, name } = openParent(physical, false);
	try {
		unlinkSync(`/proc/self/fd/${dir}/${name}`);
	} catch (error) {
		throw reason(error, physical);
	} finally {
		closeSync(dir);
	}
}

/** Reads the whole file through `fd`, from its start. */
export const readAnchored = (fd: number): Buffer => readFileSync(fd);

/**
 * fork: replaces the file `fd` holds at `physical` with `content`. An ordinary file with
 * one name, owned by the user, gets a complete new version renamed over it: a full disk or a crash leaves the old one
 * whole. Any other file (other names, another owner, a group the user cannot give) is written in place as before,
 * since a rename would cut its other names or change its owner. ACLs and extended attributes are not carried over.
 */
export function publishAnchored(fd: number, physical: string, content: string | Uint8Array): void {
	const stat = fstatSync(fd);
	if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) {
		replaceAnchored(fd, content);
		return;
	}
	const { dir, name } = openParent(physical, false);
	const at = (entry: string) => `/proc/self/fd/${dir}/${entry}`;
	const temporary = `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let out: number | undefined;
	let inPlace = false;
	try {
		try {
			out = openSync(
				at(temporary),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			fchownSync(out, stat.uid, stat.gid);
		} catch {
			// No room for the temporary name, or the group cannot be given: in place, as before.
			if (out !== undefined) {
				closeSync(out);
				out = undefined;
				unlinkSync(at(temporary));
			}
			inPlace = true;
		}
		if (inPlace || out === undefined) {
			inPlace = true;
			closeSync(dir);
			replaceAnchored(fd, content);
			return;
		}
		const temp = out;
		fchmodSync(temp, stat.mode & 0o7777);
		const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
		for (let done = 0; done < data.length; ) done += writeSync(temp, data, done, data.length - done, done);
		fsyncSync(temp);
		closeSync(temp);
		out = undefined;
		const now = lstatSync(at(name), { throwIfNoEntry: false });
		if (!now || !sameIdentity(identityOf(now), identityOf(stat)))
			throw new Error(`${physical}: another file was put under this name meanwhile; it was not replaced.`);
		atomicWriteHooks.beforeRename?.(at(temporary));
		try {
			renameSync(at(temporary), at(name));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EBUSY" && code !== "EXDEV") throw error;
			// fork: a file mounted on its own (a container's `-v file:file`, bwrap
			// `--bind f f`) cannot be renamed over; it is written in place.
			unlinkSync(at(temporary));
			inPlace = true;
			closeSync(dir);
			replaceAnchored(fd, content);
			return;
		}
	} catch (error) {
		if (out !== undefined) closeSync(out);
		if (!inPlace) {
			try {
				unlinkSync(at(temporary));
			} catch {}
			closeSync(dir);
		}
		throw error;
	}
	try {
		fsyncSync(dir);
	} catch {
		// The new content is in place; only durability is weaker.
	} finally {
		closeSync(dir);
	}
}

/** Writes `content` to `physical` (links followed now), through {@link publishAnchored}; a new file is just written. */
export function publishFile(physical: string, content: string | Uint8Array): void {
	const { fd, created } = openAnchored(physical, "write", 0o777);
	try {
		if (created) replaceAnchored(fd, content);
		else publishAnchored(fd, physical, content);
	} finally {
		closeSync(fd);
	}
}

/** Replaces the file's content through `fd`: truncated only now, after the caller checked what it opened. */
export function replaceAnchored(fd: number, content: string | Uint8Array): void {
	ftruncateSync(fd, 0);
	const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
	// Positional writes: a read through the same descriptor left its offset at the old end.
	for (let done = 0; done < data.length; ) done += writeSync(fd, data, done, data.length - done, done);
}

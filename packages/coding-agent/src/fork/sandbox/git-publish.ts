/**
 * fork: publishes the Git changes a sandboxed command made in its private layer to the
 * real Git folder, with Git's own lock files. Nothing here runs Git, and nothing here validates the changes: the
 * caller passes only what its validation accepted.
 *
 * Objects are only added, never replaced nor removed. Every other file is locked (`<file>.lock`, created
 * exclusively, as Git does), compared under the lock to what it was before the command, then renamed over: a
 * concurrent host Git is stopped by our locks as by another Git, and a file it changed meanwhile makes the whole
 * publication refused. Ref logs are the exception: lines the host appended are kept, ours follow. Some locks only
 * guard: Git appends to a ref's log under the ref's lock, not the log's, and a ref created as a file would hide a
 * new value the host put in `packed-refs`.
 *
 * A journal in Prism's folder records each lock once taken, with the lock's identity, then the commit before the
 * renames, so that `recoverGitPublications` can finish or undo a publication cut by a crash, touching only locks
 * that are provably ours. Every path is opened from the Git folder's descriptor, one component at a time, without
 * following links (`/proc/self/fd/<n>/<name>` with O_NOFOLLOW): a folder swapped for a link is not followed.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	futimesSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { type ProcessStamp, processStamp, stampAlive } from "../process-lock.ts";
import { type GitFile, gitFileStream } from "./git-files.ts";

export interface GitChange {
	/** Relative to the Git folder, `/`-separated. */
	path: string;
	/** The file before the command; null if it did not exist. */
	before: Buffer | null;
	/** The file the command left; null if it deleted it. */
	after: Buffer | GitFile | null;
	/** An index's time in the copy, in whole seconds: the published index gets it (`indexSeconds`). */
	seconds?: number;
}

/**
 * Git trusts an index entry whose size and time match the file, to the second, unless the file is as recent as the
 * index itself. An index rewritten later than Git wrote it would hide a same-size change made in that second, so a
 * copied or published index keeps Git's time. Rounded down: an older index only makes Git check more files.
 */
export function indexSeconds(path: string, mtimeNs: () => bigint): number | undefined {
	return path === "index" || /^worktrees\/[^/]+\/index$/.test(path) ? Number(mtimeNs() / 1_000_000_000n) : undefined;
}

/** What the publication needs of the Git folder as it was when the command started: see `captureGitStart`. */
export interface GitStart {
	identity: FileIdentity;
	packedRefs: Buffer | null;
}

export type GitPublication =
	| { published: true; paths: string[] }
	| { published: false; reason: string; conflicts: string[] };

export interface PublishOptions {
	/** Attempts while a host Git holds a lock, 20 ms apart. */
	lockAttempts?: number;
	/** Tests only: called after each step, to crash there. */
	afterStep?: (step: "objects" | "intent" | "locked" | "commit" | "renamed") => void;
}

interface FileIdentity {
	dev: string;
	ino: string;
	birth: string;
}

interface JournalEntry {
	path: string;
	/** Write: renamed over the file; delete: the file removed; guard: only held. */
	action: "write" | "delete" | "guard";
	/** The lock's identity, once taken. */
	lock?: FileIdentity;
}

interface Journal {
	gitDir: string;
	identity: FileIdentity;
	/** fork: the publishing process; its journal is recovered only once it is gone. */
	owner?: ProcessStamp;
	state: "intent" | "commit";
	entries: JournalEntry[];
}

const LOOSE = /^objects\/[0-9a-f]{2}\/(?:[0-9a-f]{38}|[0-9a-f]{62})$/;
const PACK = /^objects\/pack\/pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.(pack|idx)$/;
const LOG = /^logs\/(HEAD|refs\/.+)$/;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const same = (a: Buffer | null, b: Buffer | null) => (a === null ? b === null : b !== null && a.equals(b));
const isObject = (path: string) => LOOSE.test(path) || PACK.test(path);
// A pack before its index, as Git writes them: an index without its pack is a broken repository.
const objectOrder = (path: string) => (LOOSE.test(path) ? 0 : PACK.exec(path)?.[1] === "pack" ? 1 : 2);
const identityOf = (fd: number): FileIdentity => {
	const stat = fstatSync(fd, { bigint: true });
	return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) };
};
const sameIdentity = (a: FileIdentity | undefined, b: FileIdentity) =>
	a !== undefined && a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;

/** The components of a path relative to the Git folder; throws on an empty, `.` or `..` component, or a lock. */
function components(path: string): string[] {
	const parts = path.split("/");
	for (const part of parts) {
		if (!part || part === "." || part === ".." || part.includes("\0"))
			throw new Error(`invalid path in the Git folder: ${path}`);
	}
	if (parts.at(-1)!.endsWith(".lock")) throw new Error(`a lock file is not a change: ${path}`);
	return parts;
}

/** The value of each ref in a `packed-refs` file. */
function packedValues(bytes: Buffer | null): Map<string, string> {
	const values = new Map<string, string>();
	for (const line of bytes?.toString("utf8").split("\n") ?? []) {
		const match = /^([0-9a-f]{40,64}) (refs\/\S+)$/.exec(line);
		if (match) values.set(match[2]!, match[1]!);
	}
	return values;
}

/** Descriptors of the Git folder and its subfolders, opened from it without following links. */
class Anchor {
	private readonly folders = new Map<string, number>();
	readonly identity: FileIdentity;

	constructor(gitDir: string) {
		const fd = openSync(gitDir, DIRECTORY);
		this.folders.set("", fd);
		this.identity = identityOf(fd);
	}

	/** Paths, through the descriptor of its folder, to the entry `path` and its siblings; makes missing folders. */
	entry(path: string): { at: (name: string) => string; name: string } {
		const parts = components(path);
		const name = parts.pop()!;
		let key = "";
		let fd = this.folders.get("")!;
		for (const part of parts) {
			key = key ? `${key}/${part}` : part;
			let next = this.folders.get(key);
			if (next === undefined) {
				const at = `/proc/self/fd/${fd}/${part}`;
				try {
					next = openSync(at, DIRECTORY);
				} catch (error) {
					if (code(error) !== "ENOENT") throw error;
					try {
						mkdirSync(at, 0o755);
					} catch (made) {
						if (code(made) !== "EEXIST") throw made;
					}
					next = openSync(at, DIRECTORY);
				}
				this.folders.set(key, next);
			}
			fd = next;
		}
		return { at: (entry) => `/proc/self/fd/${fd}/${entry}`, name };
	}

	/** Opens the file read-only, undefined if absent; throws on anything but a regular file. */
	open(path: string, suffix = ""): number | undefined {
		const { at, name } = this.entry(path);
		let fd: number;
		try {
			fd = openSync(at(name + suffix), READ);
		} catch (error) {
			if (code(error) === "ENOENT") return undefined;
			throw error;
		}
		if (!fstatSync(fd).isFile()) {
			closeSync(fd);
			throw new Error(`not a regular file in the Git folder: ${path}${suffix}`);
		}
		return fd;
	}

	read(path: string): Buffer | null {
		const fd = this.open(path);
		if (fd === undefined) return null;
		try {
			return readFileSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	sync(): void {
		for (const fd of this.folders.values()) fsyncSync(fd);
	}

	close(): void {
		for (const fd of this.folders.values()) closeSync(fd);
		this.folders.clear();
	}
}

function writeAll(fd: number, bytes: Buffer): void {
	for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done);
	fsyncSync(fd);
}

function syncFolder(path: string): void {
	const fd = openSync(path, DIRECTORY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function writeJournal(journalDir: string, file: string, journal: Journal): void {
	const temporary = `${file}.tmp`;
	const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
	try {
		writeAll(fd, Buffer.from(JSON.stringify(journal)));
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, file);
	syncFolder(journalDir);
}

/** Adds an object; one already there is kept as it is. */
async function addObject(anchor: Anchor, path: string, bytes: Buffer | GitFile): Promise<void> {
	const { at, name } = anchor.entry(path);
	const temporary = `tmp_obj_prism_${randomUUID()}`;
	const fd = await open(at(temporary), CREATE, 0o444);
	try {
		if (Buffer.isBuffer(bytes)) {
			await fd.writeFile(bytes);
			await fd.sync();
		} else {
			const stream = fd.createWriteStream({ autoClose: false });
			try {
				await pipeline(gitFileStream(bytes), stream);
				await fd.sync();
			} finally {
				stream.destroy();
			}
		}
	} finally {
		await fd.close();
	}
	try {
		linkSync(at(temporary), at(name));
	} catch (error) {
		if (code(error) !== "EEXIST") throw error;
	} finally {
		unlinkSync(at(temporary));
	}
}

/** What the lock gets: the command's file, or a ref log with the host's new lines then ours; undefined on conflict. */
function lockContents(change: GitChange, current: Buffer | null): Buffer | null | undefined {
	if (change.after && !Buffer.isBuffer(change.after)) throw new Error(`not a metadata change: ${change.path}`);
	if (same(current, change.before) || same(current, change.after)) return change.after;
	const { before, after } = change;
	if (
		LOG.test(change.path) &&
		current &&
		before &&
		after &&
		current.subarray(0, before.length).equals(before) &&
		after.subarray(0, before.length).equals(before)
	) {
		return Buffer.concat([current, after.subarray(before.length)]);
	}
	return undefined;
}

/** The identity of the Git folder and its `packed-refs`, read when the command starts. */
export function captureGitStart(gitDir: string): GitStart {
	const anchor = new Anchor(gitDir);
	try {
		return { identity: anchor.identity, packedRefs: anchor.read("packed-refs") };
	} finally {
		anchor.close();
	}
}

/**
 * Publishes `changes` to `gitDir`, all or nothing apart from the objects. `journalDir` is Prism's own folder for
 * this journal, never writable by the sandbox.
 */
export async function publishGitChanges(
	gitDir: string,
	start: GitStart,
	changes: GitChange[],
	journalDir: string,
	options: PublishOptions = {},
): Promise<GitPublication> {
	let anchor: Anchor;
	try {
		anchor = new Anchor(gitDir);
	} catch (error) {
		return { published: false, reason: `the Git folder cannot be opened: ${String(error)}`, conflicts: [] };
	}
	const held: { at: string; lock: string; action: JournalEntry["action"] }[] = [];
	let journalFile: string | undefined;
	// Once the commit is in the journal, the locks and the journal stay until every rename is done: an error then
	// leaves them for `recoverGitPublications`, which finishes the publication.
	let committed = false;
	try {
		if (!sameIdentity(start.identity, anchor.identity))
			return { published: false, reason: "the Git folder was replaced during the command", conflicts: [] };
		for (const change of changes) components(change.path);
		const objects = changes
			.filter((change) => isObject(change.path))
			.sort((a, b) => objectOrder(a.path) - objectOrder(b.path));
		// An object the command deleted (`git gc` packing it) stays: the host's own gc removes it later.
		for (const change of objects) if (change.after) await addObject(anchor, change.path, change.after);
		anchor.sync();
		options.afterStep?.("objects");

		const files = new Map(changes.filter((change) => !isObject(change.path)).map((change) => [change.path, change]));
		if (files.size === 0) return { published: true, paths: objects.map((change) => change.path) };
		const guards = new Set<string>();
		for (const path of files.keys()) {
			const ref = LOG.exec(path)?.[1];
			if (ref && !files.has(ref)) guards.add(ref);
		}
		const refs = [...files.keys()].filter((path) => path.startsWith("refs/"));
		if (refs.length && !files.has("packed-refs")) guards.add("packed-refs");
		const entries: JournalEntry[] = [...files.keys(), ...guards]
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
			.map((path) => ({ path, action: guards.has(path) ? "guard" : files.get(path)!.after ? "write" : "delete" }));

		mkdirSync(journalDir, { recursive: true, mode: 0o700 });
		journalFile = join(journalDir, `${randomUUID()}.json`);
		const journal: Journal = { gitDir, identity: anchor.identity, owner: processStamp(), state: "intent", entries };
		writeJournal(journalDir, journalFile, journal);
		options.afterStep?.("intent");

		const conflicts: string[] = [];
		for (const entry of entries) {
			const { at, name } = anchor.entry(entry.path);
			const lock = at(`${name}.lock`);
			let fd: number | undefined;
			for (let attempt = 1; fd === undefined; attempt++) {
				try {
					fd = openSync(lock, CREATE, 0o644);
				} catch (error) {
					if (code(error) !== "EEXIST") throw error;
					if (attempt >= (options.lockAttempts ?? 10))
						return {
							published: false,
							reason: `${entry.path} is locked by another Git`,
							conflicts: [entry.path],
						};
					await sleep(20);
				}
			}
			held.push({ at: at(name), lock, action: entry.action });
			try {
				entry.lock = identityOf(fd);
				writeJournal(journalDir, journalFile, journal);
				const currentFd = anchor.open(entry.path);
				let current: Buffer | null;
				try {
					current = currentFd === undefined ? null : await readFile(`/proc/self/fd/${currentFd}`);
				} finally {
					if (currentFd !== undefined) closeSync(currentFd);
				}
				if (entry.path === "packed-refs" && entry.action === "guard") {
					// A ref the command made a file of must not hide a value the host packed meanwhile.
					const [then, now] = [packedValues(start.packedRefs), packedValues(current)];
					if (refs.some((ref) => then.get(ref) !== now.get(ref))) conflicts.push(entry.path);
				} else if (entry.action !== "guard") {
					const change = files.get(entry.path)!;
					const contents = lockContents(change, current);
					if (contents === undefined) conflicts.push(entry.path);
					else if (contents) {
						const writer = await open(`/proc/self/fd/${fd}`, constants.O_WRONLY);
						try {
							await writer.writeFile(contents);
							await writer.sync();
						} finally {
							await writer.close();
						}
						if (change.seconds !== undefined) futimesSync(fd, change.seconds, change.seconds);
					}
				}
			} finally {
				closeSync(fd);
			}
		}
		anchor.sync();
		options.afterStep?.("locked");
		if (conflicts.length) return { published: false, reason: "changed on the host during the command", conflicts };

		journal.state = "commit";
		writeJournal(journalDir, journalFile, journal);
		committed = true;
		options.afterStep?.("commit");
		for (const { at, lock, action } of held) {
			if (action === "write") renameSync(lock, at);
			else {
				if (action === "delete") {
					try {
						unlinkSync(at);
					} catch (error) {
						if (code(error) !== "ENOENT") throw error;
					}
				}
				unlinkSync(lock);
			}
		}
		anchor.sync();
		options.afterStep?.("renamed");
		unlinkSync(journalFile);
		committed = false;
		syncFolder(journalDir);
		held.length = 0;
		journalFile = undefined;
		return { published: true, paths: changes.map((change) => change.path) };
	} catch (error) {
		if (committed && journalFile) {
			// fork: no longer running, so the next recovery finishes it, in this process too.
			try {
				const kept = JSON.parse(readFileSync(journalFile, "utf8")) as Journal;
				delete kept.owner;
				writeJournal(journalDir, journalFile, kept);
			} catch {}
		}
		if (committed) {
			return {
				published: false,
				reason: `interrupted after its commit (${String(error)}); the journal is kept and the next recovery finishes it`,
				conflicts: [],
			};
		}
		return { published: false, reason: String(error), conflicts: [] };
	} finally {
		if (committed) held.length = 0;
		for (const { lock } of held) {
			try {
				unlinkSync(lock);
			} catch {}
		}
		if (journalFile && !committed) {
			try {
				unlinkSync(journalFile);
			} catch {}
		}
		anchor.close();
	}
}

/**
 * Finishes the publications a crash cut after their commit, and removes the locks of those cut before it. Only a
 * lock with the identity the journal recorded is touched: any other is another Git's. Returns what it did, for
 * `/sandbox`.
 */
export function recoverGitPublications(journalDir: string): string[] {
	let files: string[];
	try {
		files = readdirSync(journalDir).filter((file) => file.endsWith(".json"));
	} catch (error) {
		if (code(error) === "ENOENT") return [];
		throw error;
	}
	const done: string[] = [];
	for (const file of files) {
		const path = join(journalDir, file);
		let journal: Journal;
		try {
			journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
		} catch {
			done.push(`${file}: unreadable journal left in place`);
			continue;
		}
		// A publication still running in another session (or this one) holds its locks: not a crash.
		if (journal.owner && stampAlive(journal.owner)) continue;
		let anchor: Anchor | undefined;
		try {
			anchor = new Anchor(journal.gitDir);
			if (!sameIdentity(journal.identity, anchor.identity)) {
				done.push(`${journal.gitDir}: another folder now, journal dropped`);
				unlinkSync(path);
				continue;
			}
			for (const entry of journal.entries) {
				const fd = anchor.open(entry.path, ".lock");
				if (fd === undefined) continue;
				// Taken just before the crash, before the journal recorded it, or another Git's: Git names it in
				// its refusal; removing it here could break a running Git.
				if (!entry.lock) {
					closeSync(fd);
					done.push(`${journal.gitDir}: ${entry.path}.lock left in place, maybe Prism's`);
					continue;
				}
				let ours: boolean;
				try {
					ours = sameIdentity(entry.lock, identityOf(fd));
				} finally {
					closeSync(fd);
				}
				if (!ours) continue;
				const { at, name } = anchor.entry(entry.path);
				if (journal.state === "commit" && entry.action === "write") renameSync(at(`${name}.lock`), at(name));
				else {
					if (journal.state === "commit" && entry.action === "delete") {
						try {
							unlinkSync(at(name));
						} catch (error) {
							if (code(error) !== "ENOENT") throw error;
						}
					}
					unlinkSync(at(`${name}.lock`));
				}
			}
			anchor.sync();
			done.push(`${journal.gitDir}: ${journal.state === "commit" ? "publication finished" : "publication undone"}`);
			unlinkSync(path);
			syncFolder(journalDir);
		} catch (error) {
			done.push(`${journal.gitDir}: not recovered (${String(error)})`);
		} finally {
			anchor?.close();
		}
	}
	return done;
}

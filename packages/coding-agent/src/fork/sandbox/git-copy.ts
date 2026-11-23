/**
 * fork: the private copy of a repository's Git metadata a sandboxed
 * command works in. The command sees an ordinary, writable Git folder: a copy of the real one without its objects,
 * whose existing objects it reads from the real folder, read-only, through `objects/info/alternates`. The real
 * folder stays out of its reach for the whole command. Afterwards Prism reads what changed in the copy, checks new
 * packs (`git-packs.ts`), validates every change (`git-validate.ts`) and publishes them with Git's locks
 * (`git-publish.ts`). A copy whose changes cannot be published is kept, for the user to recover from (Q-G5).
 *
 * The copy is read and written in full at each command, so its size is bounded: a repository whose metadata is
 * larger, or that the copy does not cover yet (alternates, links in its Git folder, formats the validation does not
 * know), keeps the protection it had before (read-only configuration and hooks). Linked worktrees' registrations are
 * in the copy; their `.git` files, in the working trees, stay read-only (Q-G4). Each submodule's Git folder under
 * `modules` gets a copy of its own, validated and published as its own repository; a submodule the copy cannot
 * cover leaves the whole repository on the earlier protection.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	futimesSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { readFdBounded } from "../bounded-read.ts";
import type { GitFile } from "./git-files.ts";
import { type HooksQuestion, hooksQuestion } from "./git-hooks.ts";
import { type CopyOrigin, copyReadHint, writeAlternates, writeKept, writeOrigin } from "./git-orphans.ts";
import { type PackSandbox, verifyPacks } from "./git-packs.ts";
import { captureGitStart, type GitChange, type GitStart, indexSeconds, publishGitChanges } from "./git-publish.ts";
import {
	type ConfigChange,
	gitObjectFormat,
	gitObjectStore,
	type HashFormat,
	parseGitConfig,
	type Refusal,
	unsupportedGitFormat,
	validateGitChanges,
} from "./git-validate.ts";
import { within } from "./path-within.ts";
import { shellQuote } from "./shell-quote.ts";

/** What is copied before a command. */
const MAX_COPY_FILES = 20_000;
const MAX_COPY_BYTES = 64 * 1024 * 1024;
/** What is read after it, new objects included. */
const MAX_RESULT_FILES = 100_000;
const MAX_RESULT_BYTES = 512 * 1024 * 1024;

const ALTERNATES = "objects/info/alternates";
const OLD = ".old";

/** Removes the copies a Prism that ended left half removed; kept copies stay. */
export function removeOldGitCopies(folder: string): void {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return;
	}
	for (const name of names) if (name.endsWith(OLD)) rmSync(join(folder, name), { recursive: true, force: true });
}

export interface GitCopy {
	/** The real Git folder. */
	gitDir: string;
	/** Prism's folder for this copy, out of the sandbox's sight. */
	folder: string;
	/** The copy, bound at `gitDir` in the sandbox. */
	metadata: string;
	/** Where the sandbox sees the real objects, read-only: a folder of its private /tmp. */
	objectsAt: string;
	/** That folder on the host, made before the command. */
	objectsMount: string;
	base: Map<string, Buffer>;
	/** The identity of each file of the copy as written: one the command did not write keeps it. */
	written: Map<string, string>;
	/** The copy's folders before the command. */
	folders: string[];
	alternates: Buffer;
	format: HashFormat;
	start: GitStart;
	/** The submodules' Git folders under `modules`, each with a copy of its own. */
	submodules: string[];
}

class Unsupported extends Error {}

const ANCHORED = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

type Entry = { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };

/** The entries of a folder, typed by `readdir` itself; an entry it cannot type is asked about. */
function entries(folder: string): Entry[] {
	return readdirSync(folder, { withFileTypes: true }).map((entry) => {
		if (entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()) return entry;
		const stat = lstatSync(join(folder, entry.name));
		return {
			name: entry.name,
			isFile: () => stat.isFile(),
			isDirectory: () => stat.isDirectory(),
			isSymbolicLink: () => stat.isSymbolicLink(),
		};
	});
}

/** What identifies a file's content between two looks: a write changes its change time, which nothing sets back. */
const identity = (stat: { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
	`${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

/**
 * fork: at most `max` bytes, refused with `tooLarge` before anything is read when the
 * file is larger, and while reading when it grows meanwhile: a large file is never loaded whole to be refused after.
 */
function readRegular(
	path: string,
	label: string,
	max: number,
	tooLarge = `${label} is larger than ${max} bytes`,
): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Unsupported(`${label} is not a regular file`);
		if (stat.size > max) throw new Unsupported(tooLarge);
		const { data, over } = readFdBounded(fd, max);
		if (over) throw new Unsupported(tooLarge);
		return data;
	} finally {
		closeSync(fd);
	}
}

/** The largest pointer file read whole (`commondir`, a working tree's `.git`). */
const MAX_POINTER_BYTES = 64 * 1024;

/** What a repository's copies, its submodules' included, have read so far. */
interface Budget {
	files: number;
	bytes: number;
}

/**
 * Copies the Git folder `gitDir`, objects excepted, into `metadata`, reading each file once without following links;
 * returns what it read, the identity of each file written, and its submodules' Git folders under `modules`, left
 * empty: each gets a copy of its own, mounted there (`prepareGitCopies`). Without `metadata`, only checks the
 * entries and their sizes, reading the configuration alone.
 */
function copyMetadata(gitDir: string, metadata: string | undefined, budget: Budget) {
	checkGitFolder(gitDir);
	if (metadata) mkdirSync(metadata, { recursive: true, mode: 0o700 });
	const files = new Map<string, Buffer>();
	const written = new Map<string, string>();
	const folders: string[] = [];
	const submodules: string[] = [];
	const walk = (relative: string, depth: number) => {
		if (depth > 64) throw new Unsupported("its Git folder is nested too deeply");
		for (const entry of entries(join(gitDir, relative))) {
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			if (++budget.files > MAX_COPY_FILES)
				throw new Unsupported(`its Git metadata holds over ${MAX_COPY_FILES} files, its submodules' included`);
			if (entry.isDirectory()) {
				folders.push(path);
				if (metadata) mkdirSync(join(metadata, path));
				// A submodule's Git folder is found as in `layout.ts`, by its HEAD or config file (a submodule named
				// `a/b` is in `modules/a/b`), here without following links.
				const submodule =
					path.startsWith("modules/") &&
					["HEAD", "config"].some((name) =>
						lstatSync(join(gitDir, path, name), { throwIfNoEntry: false })?.isFile(),
					);
				if (submodule) submodules.push(path);
				else if (path !== "objects") walk(path, depth + 1);
				continue;
			}
			if (!entry.isFile()) throw new Unsupported(`${path} in its Git folder is not a regular file`);
			const overBudget = `its Git metadata holds over ${MAX_COPY_BYTES / 1024 / 1024} MiB, its submodules' included`;
			const content =
				metadata || path === "config"
					? readRegular(
							join(gitDir, path),
							`${path} in its Git folder`,
							Math.max(0, MAX_COPY_BYTES - budget.bytes),
							overBudget,
						)
					: undefined;
			budget.bytes += content?.length ?? lstatSync(join(gitDir, path)).size;
			if (budget.bytes > MAX_COPY_BYTES) throw new Unsupported(overBudget);
			if (content) files.set(path, content);
			if (!metadata || !content) continue;
			// Hooks keep their mode, to run in the sandbox as they would outside it.
			const mode = relative === "hooks" ? lstatSync(join(gitDir, path)).mode & 0o777 : 0o644;
			const seconds = indexSeconds(path, () => lstatSync(join(gitDir, path), { bigint: true }).mtimeNs);
			const fd = openSync(join(metadata, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
			try {
				for (let done = 0; done < content.length; ) done += writeSync(fd, content, done);
				if (seconds !== undefined) futimesSync(fd, seconds, seconds);
				written.set(path, identity(fstatSync(fd, { bigint: true })));
			} finally {
				closeSync(fd);
			}
		}
	};
	walk("", 0);
	const config = parseGitConfig(files.get("config") ?? Buffer.alloc(0));
	if (!config) throw new Unsupported("its configuration is not one Git reads");
	const unsupported = unsupportedGitFormat(config);
	if (unsupported) throw new Unsupported(unsupported);
	return { files, written, folders, submodules, config };
}

function checkGitFolder(gitDir: string): void {
	const top = lstatSync(gitDir);
	if (!top.isDirectory()) throw new Unsupported("its Git folder is not a folder");
	// `.` is the reserve the earlier protection writes (`prepareLayout`), which Git reads as this folder itself.
	const commondir = join(gitDir, "commondir");
	if (
		lstatSync(commondir, { throwIfNoEntry: false }) &&
		readRegular(commondir, "commondir", MAX_POINTER_BYTES).toString() !== ".\n"
	)
		throw new Unsupported("it is a linked worktree");
	for (const [path, what] of [
		[ALTERNATES, "it borrows objects from another repository (objects/info/alternates)"],
		["objects/info/http-alternates", "it borrows objects from another repository (http-alternates)"],
	] as const) {
		if (lstatSync(join(gitDir, path), { throwIfNoEntry: false })) throw new Unsupported(what);
	}
	if (!lstatSync(join(gitDir, "objects"), { throwIfNoEntry: false })?.isDirectory())
		throw new Unsupported("its Git folder has no objects folder");
}

const copyRefusal = (error: unknown) =>
	error instanceof Unsupported
		? error.message
		: `its Git folder could not be copied (${(error as NodeJS.ErrnoException).code ?? String(error)})`;

/** Whether the repository and all its submodules can use a copy, without writing or walking the objects. */
export function gitCopyRefusal(gitDir: string): string | undefined {
	const budget = { files: 0, bytes: 0 };
	const pending = [gitDir];
	for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
		try {
			const { submodules } = copyMetadata(next, undefined, budget);
			pending.push(...submodules.map((path) => join(next, path)));
		} catch (error) {
			const reason = copyRefusal(error);
			return next === gitDir ? reason : `its submodule ${next} cannot be copied: ${reason}`;
		}
	}
	return undefined;
}

/** Removes copies made for a command that will not run. */
function removeCopies(copies: GitCopy[]): void {
	for (const copy of copies) {
		rmSync(copy.folder, { recursive: true, force: true });
		rmSync(copy.objectsMount, { recursive: true, force: true });
	}
}

/**
 * Private copies of `gitDir` and of its submodules' Git folders for one command, the repository's first, each
 * submodule's after the copy it is mounted in; or why this repository keeps the protection it had. `folder` is
 * Prism's own; `tmp` is the session's private /tmp on the host, where the real objects are shown; `origin`, the
 * command, recorded with each copy (`git-orphans.ts`).
 */
export function prepareGitCopies(
	gitDir: string,
	options: { folder: string; tmp: string; origin: CopyOrigin },
): GitCopy[] | { reason: string } {
	const copies: GitCopy[] = [];
	const budget = { files: 0, bytes: 0 };
	const pending = [gitDir];
	for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
		const copy = prepareGitCopy(next, options, budget);
		if ("reason" in copy) {
			removeCopies(copies);
			return next === gitDir ? copy : { reason: `its submodule ${next} cannot be copied: ${copy.reason}` };
		}
		copies.push(copy);
		pending.push(...copy.submodules.map((path) => join(next, path)));
	}
	return copies;
}

function prepareGitCopy(
	gitDir: string,
	options: { folder: string; tmp: string; origin: CopyOrigin },
	budget: Budget,
): GitCopy | { reason: string } {
	const id = randomUUID();
	const folder = join(options.folder, id);
	// Where the copy comes from is written first, in a folder named `.<id>` until then: a copy is never without it.
	const pending = join(options.folder, `.${id}`);
	try {
		mkdirSync(pending, { recursive: true, mode: 0o700 });
		writeOrigin(pending, gitDir, options.origin);
		renameSync(pending, folder);
		const metadata = join(folder, "metadata");
		// The copy is written from the bytes read, never by reading the folder twice: a host Git writing meanwhile
		// cannot make it differ from what is validated against.
		const { files, written, folders, submodules, config } = copyMetadata(gitDir, metadata, budget);
		// What the command sees of `packed-refs` is the copy's: a value the host packs after this read is a change.
		const start: GitStart = {
			identity: captureGitStart(gitDir).identity,
			packedRefs: files.get("packed-refs") ?? null,
		};
		const objectsAt = `/tmp/.prism-git/${id}`;
		const objectsMount = join(options.tmp, ".prism-git", id);
		mkdirSync(objectsMount, { recursive: true, mode: 0o700 });
		const alternates = Buffer.from(`${objectsAt}\n`);
		mkdirSync(join(metadata, "objects", "info"), { recursive: true });
		writeFileSync(join(metadata, ALTERNATES), alternates, { mode: 0o644 });
		written.set(ALTERNATES, identity(lstatSync(join(metadata, ALTERNATES), { bigint: true })));
		return {
			gitDir,
			folder,
			metadata,
			objectsAt,
			objectsMount,
			base: files,
			written,
			folders,
			alternates,
			format: gitObjectFormat(config),
			start,
			submodules,
		};
	} catch (error) {
		rmSync(pending, { recursive: true, force: true });
		rmSync(folder, { recursive: true, force: true });
		return { reason: copyRefusal(error) };
	}
}

/** What a hooks folder's private layer holds at most. */
const MAX_LAYER_FILES = 1_000;
const MAX_LAYER_BYTES = 16 * 1024 * 1024;

/**
 * fork: a private layer of the hooks folder `path` that `core.hooksPath` names in a copied repository's
 * working tree, made in the copy's folder and removed with it, never published: Git in the sandbox may rewrite the
 * hooks (Husky's install does), the real folder keeps its own. Undefined when the folder holds links or other
 * entries than files and folders, or is too large: it then stays read-only.
 */
export function hooksLayer(copy: GitCopy, path: string, index: number): string | undefined {
	const layer = join(copy.folder, `hooks-${index}`);
	let count = 0;
	let bytes = 0;
	const walk = (relative: string, depth: number) => {
		if (depth > 16) throw new Unsupported("nested too deeply");
		mkdirSync(join(layer, relative), { mode: 0o755 });
		for (const entry of entries(join(path, relative))) {
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (++count > MAX_LAYER_FILES) throw new Unsupported("too many files");
			if (entry.isDirectory()) {
				walk(name, depth + 1);
				continue;
			}
			if (!entry.isFile()) throw new Unsupported(`${name} is not a regular file`);
			const content = readRegular(join(path, name), name, MAX_LAYER_BYTES - bytes, "too large");
			bytes += content.length;
			if (bytes > MAX_LAYER_BYTES) throw new Unsupported("too large");
			writeFileSync(join(layer, name), content, { flag: "wx", mode: lstatSync(join(path, name)).mode & 0o777 });
		}
	};
	try {
		walk("", 0);
		return layer;
	} catch {
		rmSync(layer, { recursive: true, force: true });
		return undefined;
	}
}

/** bubblewrap's arguments for a copy, after the writable folders: the copy over the real folder, its objects aside. */
export function gitCopyArgs(copy: GitCopy): string[] {
	return ["--bind", copy.metadata, copy.gitDir, "--ro-bind", join(copy.gitDir, "objects"), copy.objectsAt];
}

/** What the command changed in its copy: the files whose identity changed are read, the others are not. */
export async function gitCopyChanges(
	copy: GitCopy,
): Promise<{ changes: GitChange[]; removedFolders: string[]; removedWorktrees: Set<string> } | { reason: string }> {
	const changed = new Map<string, Buffer | GitFile>();
	const times = new Map<string, bigint>();
	const seen = new Set<string>();
	const folders = new Set<string>();
	let count = 0;
	let bytes = 0;
	const tooLarge = () =>
		new Unsupported(`the command wrote over ${MAX_RESULT_BYTES / 1024 / 1024} MiB of Git metadata`);
	const walk = async (relative: string, depth: number): Promise<void> => {
		if (depth > 64) throw new Unsupported("the command's Git folder is nested too deeply");
		for (const entry of await readdir(join(copy.metadata, relative), { withFileTypes: true })) {
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			const full = join(copy.metadata, path);
			if (++count > MAX_RESULT_FILES)
				throw new Unsupported(`the command's Git folder holds over ${MAX_RESULT_FILES} files`);
			const stat = await lstat(full, { bigint: true });
			// As in entries(), ask lstat when the filesystem leaves the directory entry's type unknown.
			const kind = entry.isFile() || entry.isDirectory() || entry.isSymbolicLink() ? entry : stat;
			if (kind.isDirectory()) {
				folders.add(path);
				await walk(path, depth + 1);
				continue;
			}
			if (!kind.isFile()) throw new Unsupported(`${path} in the command's Git folder is not a regular file`);
			seen.add(path);
			if (copy.written.get(path) === identity(stat)) continue;
			times.set(path, stat.mtimeNs);
			const input = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const opened = await input.stat();
				if (!opened.isFile()) throw new Unsupported(`${path} in the command's Git folder is not a regular file`);
				if (bytes + opened.size > MAX_RESULT_BYTES) throw tooLarge();
				// The repository's own objects, which publication streams (git-publish.ts `isObject`); a new submodule's
				// (`modules/<name>/objects/...`) are published as metadata, from bytes, as before.
				const object = /^objects\/(?:[0-9a-f]{2}\/[0-9a-f]+|pack\/pack-[0-9a-f]+\.(pack|idx))$/.test(path);
				if (object) {
					const folder = join(copy.folder, "snapshot");
					await mkdir(folder, { recursive: true, mode: 0o700 });
					const file = join(folder, randomUUID());
					const output = await open(file, "wx", 0o600);
					const stream = output.createWriteStream({ autoClose: false });
					try {
						// Count streamed bytes too: a surviving command may append after stat.
						await pipeline(
							input.createReadStream(),
							async function* (source: AsyncIterable<Buffer>) {
								for await (const chunk of source) {
									bytes += chunk.length;
									if (bytes > MAX_RESULT_BYTES) throw tooLarge();
									yield chunk;
								}
							},
							stream,
						);
						changed.set(path, { file, size: (await output.stat()).size });
					} finally {
						stream.destroy();
						await output.close();
					}
				} else {
					const chunks: Buffer[] = [];
					for await (const chunk of input.createReadStream()) {
						bytes += chunk.length;
						if (bytes > MAX_RESULT_BYTES) throw tooLarge();
						chunks.push(chunk);
					}
					changed.set(path, Buffer.concat(chunks));
				}
			} finally {
				await input.close();
			}
		}
	};
	try {
		await walk("", 0);
	} catch (error) {
		return {
			reason:
				error instanceof Unsupported
					? error.message
					: `the command's Git folder could not be read (${String(error)})`,
		};
	}
	const alternates = changed.get(ALTERNATES);
	if (!seen.has(ALTERNATES) || (alternates && (!Buffer.isBuffer(alternates) || !alternates.equals(copy.alternates))))
		return { reason: `the command changed ${ALTERNATES}, which Prism wrote` };
	changed.delete(ALTERNATES);
	const changes: GitChange[] = [];
	for (const [path, after] of changed) {
		const before = copy.base.get(path) ?? null;
		if (!Buffer.isBuffer(after) || !before?.equals(after))
			changes.push({ path, before, after, seconds: indexSeconds(path, () => times.get(path)!) });
	}
	for (const [path, before] of copy.base) if (!seen.has(path)) changes.push({ path, before, after: null });
	// Deepest first. `objects` is not walked before the command, so its subfolders are not in the list.
	const removedFolders = copy.folders.filter((path) => !folders.has(path)).sort((a, b) => b.length - a.length);
	const removedWorktrees = new Set(
		removedFolders.filter((path) => /^worktrees\/[^/]+$/.test(path)).map((path) => path.slice("worktrees/".length)),
	);
	return { changes, removedFolders, removedWorktrees };
}

export interface FinishOptions {
	sandbox: PackSandbox;
	/** Prism's journal of publications (`git-publish.ts`). */
	journalDir: string;
	/** The folders sandboxed commands may write (a remote given as a local path must lead into one). */
	writable: string[];
	/**
	 * fork (SEC-08): asks the user whether a change to `core.hooksPath` may be applied; true to apply it. Without it,
	 * the change is refused.
	 */
	askHooks?: (question: HooksQuestion) => Promise<boolean | undefined>;
	/**
	 * fork: asks the user whether changes to remotes or identity may be applied; true to
	 * apply them. Without it, they are refused.
	 */
	askGitConfig?: (question: GitConfigQuestion) => Promise<boolean | undefined>;
	/** fork: repositories the command made whose hooks or configuration run programs (`nested-git.ts`). */
	newRepositories?: string[];
	/** fork: the repositories whose hooks or configuration run programs now (`riskyRepositories`). */
	riskyRepositories?: () => string[];
}

/** fork (H4): what a command changed in a repository's configuration that acts later, outside Prism. */
export interface GitConfigQuestion {
	/** The repository's working tree, or its Git folder when it has none Prism can tell. */
	repository: string;
	changes: ConfigChange[];
}

/**
 * Keeps a copy for the user, with why (/sandbox lists it): its objects then come from the real folder, as on the
 * host.
 */
function keep(copy: GitCopy, reasons: string[]): string {
	writeAlternates(copy.metadata, join(copy.gitDir, "objects"));
	rmSync(copy.objectsMount, { recursive: true, force: true });
	writeKept(copy.folder, reasons);
	const shown = reasons.slice(0, 8).map((reason) => `- ${reason}`);
	if (reasons.length > 8) shown.push(`- and ${reasons.length - 8} more`);
	return [
		`Prism: this command's Git changes were not applied to ${copy.gitDir}:`,
		...shown,
		`The files of the project are as the command left them; its Git state (commits, stashes, branches) is kept in ${copy.metadata}.`,
		...copyReadHint(copy.metadata, copy.gitDir),
		"The next command starts again from the real repository.",
	].join("\n");
}

const describe = ({ path, reason }: Refusal) => `${path} ${reason}`;

/** What a new repository's template writes and Git does not need: never published. */
const TEMPLATE = /^(description|info\/exclude|hooks\/[^/]+\.sample)$/;

/**
 * The Git folders of submodules the command added under `modules` (`git submodule add`, `submodule update --init`),
 * validated as repositories it created: their objects, refs and index as any repository's, their configuration by
 * the closed list with the keys `git clone` writes, no hook, nothing borrowed from another repository. Their files
 * are then published with the repository's own changes, as new files under Git's locks. `rest` is what remains of
 * the repository's changes.
 */
async function newSubmodules(
	copy: GitCopy,
	changes: GitChange[],
	options: FinishOptions,
): Promise<{ accepted: GitChange[]; rest: GitChange[] } | { refused: Refusal[] }> {
	const existing = new Set([...copy.folders, ...copy.submodules]);
	const made = new Set(changes.filter(({ before, after }) => before === null && after).map(({ path }) => path));
	// A new Git folder is a new folder under `modules` where the command wrote HEAD and config (`logs/HEAD` is not
	// one); one under another's `modules` is that one's submodule.
	const roots: string[] = [];
	for (const path of [...made].sort((a, b) => a.length - b.length)) {
		const root = /^(modules\/.+)\/HEAD$/.exec(path)?.[1];
		if (!root || existing.has(root) || !made.has(`${root}/config`)) continue;
		// Strict descendants only; equality remains excluded.
		const parent = roots.findLast((other) => within(root, `${other}/`));
		if (!parent || root.slice(parent.length + 1).startsWith("modules/")) roots.push(root);
	}
	if (roots.length === 0) return { accepted: [], rest: changes };
	const owner = (path: string) =>
		roots.filter((root) => within(path, `${root}/`)).sort((a, b) => b.length - a.length)[0];
	const accepted: GitChange[] = [];
	const refused: Refusal[] = [];
	for (const root of roots) {
		const own = changes
			.filter((change) => owner(change.path) === root)
			.map((change) => ({ ...change, path: change.path.slice(root.length + 1) }))
			.filter((change) => !TEMPLATE.test(change.path));
		const refuse = (path: string, reason: string) => refused.push({ path: `${root}/${path}`, reason });
		const before = own.find((change) => change.before !== null);
		if (before) {
			refuse(before.path, "is in a new submodule's Git folder, yet existed before the command");
			continue;
		}
		const configBytes = own.find((change) => change.path === "config")?.after;
		const config = parseGitConfig(Buffer.isBuffer(configBytes) ? configBytes : Buffer.alloc(0));
		const unsupported = config ? unsupportedGitFormat(config) : "its configuration is not one Git reads";
		if (!config || unsupported) {
			refuse("config", unsupported ?? "is not a configuration Git reads");
			continue;
		}
		const format = gitObjectFormat(config);
		const scratch = join(copy.folder, "packs");
		mkdirSync(scratch, { recursive: true, mode: 0o700 });
		const packs = await verifyPacks({
			sandbox: options.sandbox,
			packs: own
				.filter((change) => change.after && /^objects\/pack\/pack-[0-9a-f]+\.pack$/.test(change.path))
				.map((change) => ({ path: change.path, bytes: change.after! })),
			stores: [],
			loose: join(copy.metadata, root, "objects"),
			format,
			scratch,
		});
		const validation = await validateGitChanges({
			changes: own,
			format,
			existing: { type: () => undefined },
			packs: packs.packs,
			loose: { sandbox: options.sandbox, stores: [], scratch },
			writable: options.writable,
			created: true,
			gitDir: join(copy.gitDir, root),
		});
		rmSync(scratch, { recursive: true, force: true });
		for (const { path, reason } of [...packs.refused, ...validation.refused]) refuse(path, reason);
		accepted.push(...validation.accepted.map((change) => ({ ...change, path: `${root}/${change.path}` })));
	}
	if (refused.length > 0) return { refused };
	return { accepted, rest: changes.filter((change) => owner(change.path) === undefined) };
}

/**
 * Publishes what the command changed in its copy, or keeps the copy and says why; removes the copy once its changes
 * are in the real folder. Returns a note for the command's output, if any.
 */
export async function finishGitCopy(copy: GitCopy, options: FinishOptions): Promise<string | undefined> {
	const collected = await gitCopyChanges(copy);
	if ("reason" in collected) return keep(copy, [collected.reason]);
	// Out of the command's way: its result does not wait for thousands of files to go. Renamed first, so that
	// what a Prism ended meanwhile leaves is known for garbage (`removeOldGitCopies`), never for a kept copy.
	const remove = () => {
		rmSync(copy.objectsMount, { recursive: true, force: true });
		const old = `${copy.folder}${OLD}`;
		try {
			renameSync(copy.folder, old);
		} catch {
			return;
		}
		rm(old, { recursive: true, force: true }).catch(() => {});
	};
	if (collected.changes.length === 0) {
		remove();
		return undefined;
	}
	const added = await newSubmodules(copy, collected.changes, options);
	if ("refused" in added) return keep(copy, added.refused.map(describe));
	const scratch = join(copy.folder, "packs");
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	const packs = await verifyPacks({
		sandbox: options.sandbox,
		packs: collected.changes
			.filter((change) => change.after && /^objects\/pack\/pack-[0-9a-f]+\.pack$/.test(change.path))
			.map((change) => ({ path: change.path, bytes: change.after! })),
		stores: [join(copy.gitDir, "objects")],
		loose: join(copy.metadata, "objects"),
		format: copy.format,
		scratch,
	});
	const existing = gitObjectStore(join(copy.gitDir, "objects"), copy.format);
	let validation: Awaited<ReturnType<typeof validateGitChanges>>;
	try {
		validation = await validateGitChanges({
			changes: added.rest,
			format: copy.format,
			existing,
			packs: packs.packs,
			loose: { sandbox: options.sandbox, stores: [join(copy.gitDir, "objects")], scratch },
			writable: options.writable,
			gitDir: copy.gitDir,
			removedWorktrees: collected.removedWorktrees,
			askHooksPath: options.askHooks !== undefined,
			askConfigChanges: options.askGitConfig !== undefined,
			sparseCheckout: sparseCheckout(copy.base.get("config")),
			newRepositories: options.newRepositories,
			riskyRepositories: options.riskyRepositories,
			readWorkTreeFile: (path) => {
				try {
					return readRegular(path, path, MAX_POINTER_BYTES);
				} catch {
					return undefined;
				}
			},
		});
	} finally {
		await existing.close();
		rmSync(scratch, { recursive: true, force: true });
	}
	const refused = [...packs.refused, ...validation.refused];
	if (refused.length > 0) return keep(copy, refused.map(describe));
	// fork: the hooks folder is published only once the user allows it.
	if (validation.hooksPath && options.askHooks) {
		const linked = [...copy.base.keys()].some((path) => path.startsWith("worktrees/"));
		const question = hooksQuestion(copy.gitDir, validation.hooksPath, options.writable, linked);
		if (typeof question === "string") return keep(copy, [question]);
		const allowed = await options.askHooks(question);
		if (!allowed) {
			const shown = `core.hooksPath=${question.change.after ?? "(unset)"}`;
			return keep(copy, [
				allowed === false
					? `${shown}: the user did not allow this hooks folder`
					: `${shown}: no answer to the question about this hooks folder, so it was not applied`,
			]);
		}
	}
	// fork: remotes and identity are published only once the user allows them.
	if (validation.configChanges && options.askGitConfig) {
		const repository = basename(copy.gitDir) === ".git" ? dirname(copy.gitDir) : copy.gitDir;
		const allowed = await options.askGitConfig({ repository, changes: validation.configChanges });
		if (!allowed) {
			const shown = validation.configChanges.map(({ key }) => key).join(", ");
			return keep(copy, [
				allowed === false
					? `${shown}: the user did not allow these Git configuration changes`
					: `${shown}: no answer to the question about these Git configuration changes, so they were not applied`,
			]);
		}
	}
	const accepted = [...validation.accepted, ...added.accepted];
	if (accepted.length === 0) {
		remove();
		return undefined;
	}
	const publication = await publishGitChanges(copy.gitDir, copy.start, accepted, options.journalDir);
	if (!publication.published) {
		const conflicts = publication.conflicts.length > 0 ? ` (${publication.conflicts.join(", ")})` : "";
		return keep(copy, [`${publication.reason}${conflicts}`]);
	}
	// A folder the command removed, once empty: Git takes an empty `rebase-merge` for a rebase in progress.
	for (const path of collected.removedFolders) {
		try {
			rmdirSync(join(copy.gitDir, path));
		} catch {}
	}
	remove();
	// fork: said in the command's output, where the model reads why its flag went.
	const flags = validation.clearedIndexFlags?.length
		? `Prism: cleared the "assume unchanged" or "skip worktree" flag this command set on ${validation.clearedIndexFlags.join(", ")}: such a flag hides a file's changes from git status, so it is kept only when it was there before the command.`
		: undefined;
	const removed = [...collected.removedWorktrees].flatMap((name) =>
		finishWorktreeRemoval(copy, name, options.writable),
	);
	if (removed.length === 0) return flags;
	const folders = removed.map((entry) => entry.folder);
	const message = `Prism: finished removing the linked worktree${folders.length > 1 ? "s" : ""} ${folders.join(", ")}: Git could not delete ${folders.length > 1 ? "their" : "its"} .git file, which is read-only in the sandbox.`;
	// Some Gits (2.43) stop at that file, before the worktree's own files: Prism leaves those to the command.
	const left = removed.filter((entry) => entry.left).map((entry) => entry.folder);
	const worktrees =
		left.length === 0
			? message
			: `${message} Git stopped before deleting the files of ${left.join(", ")}, which are still there: rm -r ${left.map(shellQuote).join(" ")} removes them.`;
	return flags ? `${flags}\n${worktrees}` : worktrees;
}

/** fork: whether a configuration (the repository's, before the command) turns `core.sparseCheckout` on. */
function sparseCheckout(config: Buffer | undefined): boolean {
	const entries = config ? parseGitConfig(config) : undefined;
	const value = entries?.findLast((entry) => entry.key.toLowerCase() === "core.sparsecheckout")?.value;
	return value === undefined
		? entries?.some((entry) => entry.key.toLowerCase() === "core.sparsecheckout") === true
		: /^(true|yes|on|1)$/i.test(value.trim());
}

/**
 * fork: a linked worktree's `.git` file stays read-only in the sandbox, so `git worktree remove` deletes
 * its files and its registration but fails on that file. Once the registration's removal is published, the file names
 * a registration that no longer exists: Prism removes it, and the worktree's folder if it is then empty. Only a
 * regular file whose whole content names that registration, in a folder the sandbox may write, reached from that
 * folder one component at a time without following a link (a sandboxed task may still be renaming things); returns
 * its folder when it removed it.
 */
function finishWorktreeRemoval(
	copy: GitCopy,
	name: string,
	writable: string[],
): Array<{ folder: string; left: boolean }> {
	const registration = join(copy.gitDir, "worktrees", name);
	const pointer = copy.base.get(`worktrees/${name}/gitdir`)?.toString("utf8");
	if (!pointer || !/^[^\x00-\x1f]+\n?$/.test(pointer) || lstatSync(registration, { throwIfNoEntry: false })) return [];
	const gitfile = resolve(registration, pointer.replace(/\n$/, ""));
	const folder = dirname(gitfile);
	// Keep equality excluded: removal opens the parent before walking to the worktree.
	const root = writable.find((path) => within(folder, `${path}/`));
	if (basename(gitfile) !== ".git" || !root) return [];
	const opened: number[] = [];
	try {
		opened.push(openSync(root, constants.O_RDONLY | constants.O_DIRECTORY));
		for (const part of folder.slice(root.length + 1).split("/"))
			opened.push(openSync(`/proc/self/fd/${opened.at(-1)}/${part}`, ANCHORED));
		const at = `/proc/self/fd/${opened.at(-1)}/.git`;
		const fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		let text: string;
		try {
			if (!fstatSync(fd).isFile() || fstatSync(fd).size > 4096) return [];
			const { data, over } = readFdBounded(fd, 4096);
			if (over) return [];
			text = data.toString("utf8");
		} finally {
			closeSync(fd);
		}
		if (text.replace(/\r?\n$/, "") !== `gitdir: ${registration}`) return [];
		unlinkSync(at);
		try {
			rmdirSync(`/proc/self/fd/${opened.at(-2)}/${basename(folder)}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return [{ folder, left: true }];
		}
		return [{ folder, left: false }];
	} catch {
		return [];
	} finally {
		for (const fd of opened) closeSync(fd);
	}
}

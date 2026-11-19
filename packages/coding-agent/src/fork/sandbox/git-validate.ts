/**
 * fork: which changes a sandboxed command made to a repository's Git folder may be
 * published (`git-publish.ts`). A closed list: objects, refs, reflogs, the index, the state of an operation in
 * progress and a few configuration keys, each with its format checked; everything else is refused with a line that
 * names it, so that nothing Git would later run outside the sandbox (hooks, programs, filters, helpers, includes,
 * a rebase `exec` line) reaches the real repository. Objects are hashed again, and the objects a published ref or
 * object names must exist with the right type, so a well-formed ref cannot leave the repository unusable.
 *
 * Only `git config` runs on the host, reading configuration from standard input. New loose objects also pass
 * Git's full fsck in the pack sandbox, from the exact bytes to publish (`git-packs.ts`).
 *
 * One repository at a time: a linked worktree's state (`worktrees/<name>/...`) shares its objects and is checked
 * here; a submodule's Git folder (`modules/...`) is a repository of its own, which the caller checks separately.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflate, inflateSync, constants as zlib } from "node:zlib";
import { hostProgram } from "../host-program.ts";
import { type GitFile, gitFileStream } from "./git-files.ts";
import { type PackSandbox, submodulesInCommits, verifyLooseObjects } from "./git-packs.ts";
import type { GitChange } from "./git-publish.ts";
import { within } from "./path-within.ts";

export type ObjectType = "blob" | "tree" | "commit" | "tag";
export type HashFormat = "sha1" | "sha256";

/** The objects of the real repository, before the command. */
export interface ObjectLookup {
	type(oid: string): ObjectType | undefined | Promise<ObjectType | undefined>;
}

export interface Refusal {
	path: string;
	reason: string;
}

export interface ValidationInput {
	changes: GitChange[];
	/** The repository's object format, read before the command: never learned from what the command wrote. */
	format: HashFormat;
	existing: ObjectLookup;
	/** New packs a confined `git index-pack --strict` verified, by path of the `.pack`: its objects and its index. */
	packs?: Map<string, { objects: Map<string, ObjectType>; idx: Buffer }>;
	/** Confined fsck of the loose bytes, after the checks below, with only the real object stores as alternates. */
	loose?: { sandbox: PackSandbox; stores: string[]; scratch: string };
	/** Folders sandboxed commands may write: a remote given as a local path must lead into one. */
	writable: string[];
	/** A repository the command created: the inert keys `git init` and `git clone` write are accepted too. */
	created?: boolean;
	realpath?: (path: string) => string;
	/** The real Git folder, which a linked worktree's `.git` file must name. */
	gitDir?: string;
	/** Linked worktrees whose whole registration (`worktrees/<name>/`) the command removed. */
	removedWorktrees?: Set<string>;
	/** Reads a file of a working tree, never through a link; undefined when it is not a regular file. */
	readWorkTreeFile?: (path: string) => Buffer | undefined;
	/** fork (SEC-08): a change to `core.hooksPath` alone is returned in `hooksPath` for the user, not refused. */
	askHooksPath?: boolean;
	/** fork: the changes of `ConfigChange` are returned in `configChanges` for the user. */
	askConfigChanges?: boolean;
	/** fork (AS-022): `core.sparseCheckout` was on before the command: Git sets "skip worktree" itself there. */
	sparseCheckout?: boolean;
	/**
	 * fork: repositories the command made whose hooks or configuration run
	 * programs. An index that lists one as a submodule is refused: `git status` enters a submodule with its own
	 * configuration, and ran its `core.fsmonitor` on the host.
	 */
	newRepositories?: string[];
	/**
	 * fork: the repositories whose hooks or configuration run programs now,
	 * whichever command made them. An index or a new commit that adds one as a submodule is refused; read only then.
	 */
	riskyRepositories?: () => string[];
}

/**
 * fork: a change whose effect comes later, outside Prism: where a host `git push` or
 * `git fetch` goes (`remote.<name>.url`, a new remote), what it pushes (`remote.<name>.push`, a forced or deleting
 * refspec), and the identity of the user's next commits (`user.name`, `user.email`). Values in file order.
 */
export interface ConfigChange {
	key: string;
	before: string[];
	after: string[];
}

/** fork (SEC-08): `core.hooksPath` before and after the command, its last value in each; undefined when unset. */
export interface HooksPathChange {
	before: string | undefined;
	after: string | undefined;
}

export interface Validation {
	/** What to publish when nothing is refused: the accepted changes, the index rewritten without its caches. */
	accepted: GitChange[];
	/** Neither published nor refused: lock files of interrupted commands and files Git rebuilds. */
	dropped: string[];
	refused: Refusal[];
	/** fork (SEC-08): the command's change to `core.hooksPath`, which may be published only once the user allows it. */
	hooksPath?: HooksPathChange;
	/** fork (H4): the command's changes to remotes and identity, which may be published only once the user allows them. */
	configChanges?: ConfigChange[];
	/** fork (AS-022): files of an index whose "assume unchanged" or "skip worktree" flag the command set, cleared. */
	clearedIndexFlags?: string[];
}

/** Bounds on what one command may publish, so that validation stays bounded in memory and time. */
const MAX_LOOSE_OBJECT = 64 * 1024 * 1024;
const MAX_STRUCTURED_OBJECT = 32 * 1024 * 1024;
const MAX_BLOB = 1024 * 1024 * 1024;
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 1_000_000;
const MAX_PACKED_REFS = 64 * 1024 * 1024;

const STRATEGIES = new Set(["ort", "recursive", "resolve", "octopus", "ours", "subtree"]);

const hexLength = (format: HashFormat) => (format === "sha256" ? 64 : 40);

/**
 * Git's rules for a reference name (`git check-ref-format`): components that neither start with `.` nor end with
 * `.lock`, no `..`, `@{`, `//`, control character, space, `~ ^ : ? * [ \`, no trailing `/` or `.`, not `@`.
 */
export function validRefName(name: string): boolean {
	if (!name || name === "@" || name.endsWith("/") || name.endsWith(".") || name.startsWith("/")) return false;
	if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
	if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
	return name.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

const validRef = (name: string) => name.startsWith("refs/") && validRefName(name);

/** The type a ref may name: a branch, HEAD and the stash name commits; other refs any object. */
function refTarget(ref: string): ObjectType | undefined {
	if (
		ref === "HEAD" ||
		ref.startsWith("refs/heads/") ||
		ref.startsWith("refs/remotes/") ||
		ref === "refs/stash" ||
		ref.startsWith("refs/notes/")
	)
		return "commit";
	return undefined;
}

const textReason = (bytes: Buffer, what: string) =>
	bytes.length > MAX_TEXT ? `${what} is too large` : bytes.includes(0) ? `${what} holds a NUL byte` : undefined;

const oneLine = (value: string) => !/[\x00-\x1f\x7f]/.test(value);

/** Lines of `text` without the last empty one. */
const lines = (bytes: Buffer) => {
	const all = bytes.toString("utf8").split("\n");
	if (all.at(-1) === "") all.pop();
	return all;
};

interface Parsed {
	type: ObjectType;
	/** Objects it names, with the type each must have. */
	names: Array<{ oid: string; type: ObjectType | undefined }>;
}

/**
 * A loose object: zlib-compressed `<type> <size>\0<body>`, whose hash is its name. Blobs are hashed as they
 * inflate, without keeping them; trees, commits and tags are kept to read the objects they name.
 */
async function looseObject(oid: string, bytes: Buffer | GitFile, format: HashFormat): Promise<Parsed | string> {
	if ((Buffer.isBuffer(bytes) ? bytes.length : bytes.size) > MAX_LOOSE_OBJECT) return "Loose object is too large";
	const hash = createHash(format === "sha256" ? "sha256" : "sha1");
	const kept: Buffer[] = [];
	let header: { type: ObjectType; size: number; at: number } | undefined;
	let total = 0;
	let failure: string | undefined;
	const inflate = createInflate();
	const done = new Promise<void>((resolveDone) => {
		inflate.on("data", (chunk: Buffer) => {
			if (failure) return;
			total += chunk.length;
			hash.update(chunk);
			if (!header) {
				kept.push(chunk);
				const head = Buffer.concat(kept);
				const nul = head.indexOf(0);
				if (nul < 0) {
					if (head.length > 64) failure = "Invalid loose object header";
					return;
				}
				const match = /^(blob|tree|commit|tag) (0|[1-9][0-9]{0,11})$/.exec(head.toString("latin1", 0, nul));
				if (!match) {
					failure = "Invalid loose object header";
					return;
				}
				header = { type: match[1] as ObjectType, size: Number(match[2]), at: nul + 1 };
				if (header.size > (header.type === "blob" ? MAX_BLOB : MAX_STRUCTURED_OBJECT))
					failure = "Object is too large";
				if (header.type === "blob") kept.length = 0;
				else kept.splice(0, kept.length, head);
			} else if (header.type !== "blob") kept.push(chunk);
			if (total > header.at + header.size) failure = "Object is longer than its header says";
		});
		inflate.on("error", () => {
			failure ??= "Corrupt compressed object";
			resolveDone();
		});
		inflate.on("end", resolveDone);
	});
	if (Buffer.isBuffer(bytes)) inflate.end(bytes);
	else {
		await pipeline(gitFileStream(bytes), inflate).catch(() => {
			failure ??= "Corrupt compressed object";
		});
	}
	await done;
	if (failure) return failure;
	if (!header || total !== header.at + header.size) return "Object is shorter than its header says";
	if (hash.digest("hex") !== oid) return "Object hash does not match its name";
	if (header.type === "blob") return { type: "blob", names: [] };
	const body = Buffer.concat(kept).subarray(header.at);
	const names = objectNames(header.type, body, format);
	return typeof names === "string" ? names : { type: header.type, names };
}

/** The objects a tree, commit or tag names, or why its content is not one Git writes. */
function objectNames(type: Exclude<ObjectType, "blob">, body: Buffer, format: HashFormat): Parsed["names"] | string {
	const hex = hexLength(format);
	const names: Parsed["names"] = [];
	if (type === "tree") {
		const seen = new Set<string>();
		for (let cursor = 0; cursor < body.length; ) {
			const space = body.indexOf(32, cursor);
			const nul = space < 0 ? -1 : body.indexOf(0, space + 1);
			if (space < 0 || nul < 0 || nul + 1 + hex / 2 > body.length) return "Malformed tree entry";
			const mode = body.toString("latin1", cursor, space);
			if (!/^(40000|100644|100755|120000|160000)$/.test(mode)) return "Invalid tree entry mode";
			// fork: a name is bytes, as Git compares it. latin1 maps each byte to
			// one character, so two names that are not UTF-8 stay distinct; UTF-8 is only for the message.
			const name = body.toString("latin1", space + 1, nul);
			const text = body.toString("utf8", space + 1, nul);
			const shown = JSON.stringify(text);
			// Names Git itself refuses (fsck): they would reach the .git folder or escape the tree at checkout.
			if (!name || name === "." || name === ".." || name.includes("/") || name.toLowerCase() === ".git")
				return `Unsafe tree entry name ${shown}`;
			if (mode === "120000" && /^\.git(modules|attributes|ignore)$/i.test(name)) return `${text} as a symbolic link`;
			if (seen.has(name)) return `Duplicate tree entry ${shown}`;
			seen.add(name);
			const oid = body.toString("hex", nul + 1, nul + 1 + hex / 2);
			// A submodule's commit is in the submodule's repository, not this one.
			if (mode !== "160000") names.push({ oid, type: mode === "40000" ? "tree" : "blob" });
			cursor = nul + 1 + hex / 2;
		}
		return names;
	}
	const separator = body.indexOf("\n\n");
	const fields = (separator < 0 ? body : body.subarray(0, separator)).toString("utf8").split("\n");
	if (separator < 0 && fields.at(-1) !== "") return `Malformed ${type} header`;
	if (fields.some((field) => field.includes("\0"))) return `NUL in ${type} header`;
	const oid = `[0-9a-f]{${hex}}`;
	if (type === "commit") {
		const tree = new RegExp(`^tree (${oid})$`).exec(fields[0] ?? "");
		if (!tree) return "Commit does not start with its tree";
		names.push({ oid: tree[1]!, type: "tree" });
		let index = 1;
		for (; fields[index]?.startsWith("parent "); index++) {
			const parent = new RegExp(`^parent (${oid})$`).exec(fields[index]!);
			if (!parent) return "Malformed commit parent";
			names.push({ oid: parent[1]!, type: "commit" });
		}
		const person = /^ .+ <[^<>\n]*> [0-9]+ [+-][0-9]{4}$/;
		if (!fields[index]?.startsWith("author") || !person.test(fields[index]!.slice(6)))
			return "Malformed commit author";
		if (!fields[index + 1]?.startsWith("committer") || !person.test(fields[index + 1]!.slice(9)))
			return "Malformed commit committer";
		return names;
	}
	const object = new RegExp(`^object (${oid})$`).exec(fields[0] ?? "");
	const target = /^type (blob|tree|commit|tag)$/.exec(fields[1] ?? "");
	if (!object || !target || !/^tag [^\n]+$/.test(fields[2] ?? "")) return "Malformed tag header";
	names.push({ oid: object[1]!, type: target[1] as ObjectType });
	return names;
}

/**
 * fork: the entries an index marks "assume unchanged" (`0x8000`) or "skip
 * worktree" (extended `0x4000`), by path as bytes read as latin1. Git's status and diff no longer look at them.
 */
export interface IndexFlags {
	assumeUnchanged: Set<string>;
	skipWorktree: Set<string>;
}

/**
 * The index without its extensions, with a new checksum. Extensions are caches Git rebuilds; a cache tree that
 * does not match the entries would make the user's next commit record a tree that `git status` does not show.
 * Versions 2 to 4. A split index (`link`) and a sparse index (`sdir`) are refused.
 *
 * fork: with `keep`, the flags that hide a file from `git status` are cleared
 * on each entry that did not have them before the command (`keep.flags`, the index before it); "skip worktree" is
 * kept too in a sparse checkout, where Git sets it itself. A command that ran `git update-index --assume-unchanged`
 * on a file it changed hid that change from the user's `git status`. `cleared` names those entries.
 */
export function sanitizedIndex(
	bytes: Buffer,
	format: HashFormat,
	keep?: { flags: IndexFlags; sparse: boolean },
):
	| {
			index: Buffer;
			blobs: string[];
			flags: IndexFlags;
			cleared: string[];
			/** Paths of its submodule entries (mode 160000), as UTF-8. */
			gitlinks: string[];
			reason?: undefined;
	  }
	| { reason: string } {
	const hashBytes = hexLength(format) / 2;
	if (bytes.length < 12 + hashBytes || bytes.toString("latin1", 0, 4) !== "DIRC") return { reason: "Invalid index" };
	const end = bytes.length - hashBytes;
	const algorithm = format === "sha256" ? "sha256" : "sha1";
	if (!createHash(algorithm).update(bytes.subarray(0, end)).digest().equals(bytes.subarray(end)))
		return { reason: "Invalid index checksum" };
	const version = bytes.readUInt32BE(4);
	if (version < 2 || version > 4) return { reason: `Index version ${version} is not supported` };
	const count = bytes.readUInt32BE(8);
	if (count > MAX_INDEX_ENTRIES) return { reason: "Too many index entries" };
	const blobs: string[] = [];
	const flagged: IndexFlags = { assumeUnchanged: new Set(), skipWorktree: new Set() };
	/** Byte offsets of the flags to clear in the rewritten entries, with their bit, and the entries they belong to. */
	const clear: Array<{ at: number; bit: number }> = [];
	const cleared: string[] = [];
	const gitlinks: string[] = [];
	let offset = 12;
	// fork: the previous name is kept as bytes, since a v4 entry removes bytes
	// from it; decoded, a name that is not UTF-8 grows and the wrong bytes were removed.
	let previous: Buffer = Buffer.alloc(0);
	for (let entry = 0; entry < count; entry++) {
		const start = offset;
		if (offset + 42 + hashBytes > end) return { reason: "Truncated index entry" };
		const mode = bytes.readUInt32BE(offset + 24);
		if (![0o100644, 0o100755, 0o120000, 0o160000].includes(mode)) return { reason: "Invalid index entry mode" };
		const oid = bytes.toString("hex", offset + 40, offset + 40 + hashBytes);
		const flags = bytes.readUInt16BE(offset + 40 + hashBytes);
		offset += 42 + hashBytes;
		let intentToAdd = false;
		let skipWorktreeAt: number | undefined;
		if (flags & 0x4000) {
			if (version < 3 || offset + 2 > end) return { reason: "Invalid extended index flags" };
			const extended = bytes.readUInt16BE(offset);
			// fork: Git reads only intent-to-add (0x2000) and skip-worktree (0x4000) and stops
			// on any other bit ("unknown index entry format"); such an index must not replace the user's.
			if (extended & ~0x6000) return { reason: "Unsupported extended index flags" };
			intentToAdd = (extended & 0x2000) !== 0;
			if (extended & 0x4000) skipWorktreeAt = offset;
			offset += 2;
		}
		let raw: Buffer;
		if (version === 4) {
			// The number of bytes to remove from the previous path, then the rest of this one.
			let strip = 0;
			let byte: number;
			let shift = 0;
			do {
				if (offset >= end || shift > 28) return { reason: "Invalid index path prefix" };
				byte = bytes[offset++]!;
				// fork: arithmetic, not 32-bit shifts, which turned a long prefix negative.
				strip = shift === 0 ? byte & 0x7f : (strip + 1) * 128 + (byte & 0x7f);
				shift += 7;
			} while (byte & 0x80);
			const nul = bytes.indexOf(0, offset);
			if (nul < 0 || nul >= end || strip > previous.length) return { reason: "Invalid index path" };
			raw = Buffer.concat([previous.subarray(0, previous.length - strip), bytes.subarray(offset, nul)]);
			offset = nul + 1;
		} else {
			const nul = bytes.indexOf(0, offset);
			if (nul < 0 || nul >= end) return { reason: "Unterminated index path" };
			raw = bytes.subarray(offset, nul);
			offset = start + Math.ceil((nul + 1 - start) / 8) * 8;
		}
		// Checked as bytes (latin1: one character per byte), shown as UTF-8.
		const path = raw.toString("latin1");
		// A split index (core.splitIndex) marks entries it replaces by an empty path.
		if (!path) return { reason: "Split index (core.splitIndex) is not supported in the sandbox" };
		if (path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))
			return { reason: `Unsafe index path ${JSON.stringify(raw.toString("utf8"))}` };
		previous = raw;
		if (mode !== 0o160000 && !intentToAdd) blobs.push(oid);
		if (mode === 0o160000) gitlinks.push(raw.toString("utf8"));
		let hidden = false;
		if (flags & 0x8000) {
			flagged.assumeUnchanged.add(path);
			if (keep && !keep.flags.assumeUnchanged.has(path)) {
				clear.push({ at: start + 40 + hashBytes, bit: 0x8000 });
				hidden = true;
			}
		}
		if (skipWorktreeAt !== undefined) {
			flagged.skipWorktree.add(path);
			if (keep && !keep.sparse && !keep.flags.skipWorktree.has(path)) {
				clear.push({ at: skipWorktreeAt, bit: 0x4000 });
				hidden = true;
			}
		}
		if (hidden) cleared.push(raw.toString("utf8"));
	}
	for (let at = offset; at < end; ) {
		if (at + 8 > end) return { reason: "Truncated index extension" };
		const signature = bytes.toString("latin1", at, at + 4);
		if (signature === "link") return { reason: "Split index (core.splitIndex) is not supported in the sandbox" };
		if (signature === "sdir") return { reason: "Sparse index (index.sparse) is not supported in the sandbox" };
		if (!/^[A-Z]{4}$/.test(signature)) return { reason: `Unknown mandatory index extension ${signature}` };
		at += 8 + bytes.readUInt32BE(at + 4);
		if (at > end) return { reason: "Index extension exceeds the file" };
	}
	const entries = Buffer.from(bytes.subarray(0, offset));
	// The extended flags word stays, at 0 when skip-worktree was its only bit: Git reads it so, and the entry keeps
	// its length (and a version 2 or 3 entry its padding).
	for (const { at, bit } of clear) entries.writeUInt16BE(entries.readUInt16BE(at) & ~bit, at);
	return {
		index: Buffer.concat([entries, createHash(algorithm).update(entries).digest()]),
		blobs,
		flags: flagged,
		cleared,
		gitlinks,
	};
}

export interface ConfigEntry {
	key: string;
	/** Undefined for a key without `=`, which Git reads as true. */
	value: string | undefined;
}

/** The entries of a configuration, read by Git; undefined when Git cannot parse it. */
export function parseGitConfig(bytes: Buffer): ConfigEntry[] | undefined {
	// fork: Git from PATH, never from where the sandbox writes.
	const git = hostProgram("git");
	if (!git) return undefined;
	try {
		return execFileSync(git, ["config", "--file", "-", "--null", "--list", "--no-includes"], {
			input: bytes,
			encoding: "utf8",
			timeout: 2000,
			maxBuffer: MAX_TEXT * 2,
			stdio: ["pipe", "pipe", "ignore"],
			env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
		})
			.split("\0")
			.filter(Boolean)
			.map((record) => {
				const newline = record.indexOf("\n");
				return newline < 0
					? { key: record, value: undefined }
					: { key: record.slice(0, newline), value: record.slice(newline + 1) };
			});
	} catch {
		return undefined;
	}
}

const BOOLEAN = /^(true|false|yes|no|on|off|1|0)?$/i;

/**
 * Whether a remote URL is one a host `git fetch` or `git push` may use: HTTPS, SSH or Git's protocol, or a local
 * repository inside a folder sandboxed commands may write, since a push to another of the user's repositories
 * would write there. Never a transport helper (`ext::`, `fd::`).
 */
function remoteUrlReason(value: string, input: ValidationInput): string | undefined {
	if (!value || !oneLine(value) || value.includes("::")) return "is not an allowed remote URL";
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
	if (scheme && ["https", "ssh", "git", "git+ssh", "ssh+git"].includes(scheme)) {
		try {
			const url = new URL(value);
			return url.hostname.startsWith("-") ? "names a host that starts with -" : undefined;
		} catch {
			return "is not a valid URL";
		}
	}
	let path: string | undefined;
	if (scheme === "file") {
		try {
			const url = new URL(value);
			if (url.host) return "names a remote host for file://";
			path = decodeURIComponent(url.pathname);
		} catch {
			return "is not a valid URL";
		}
	} else if (scheme) return `uses the ${scheme}:// transport`;
	else if (/^[^/:]+:/.test(value)) {
		// scp-like SSH: [user@]host:path, where the host must not start an option.
		return value.startsWith("-") ? "names a host that starts with -" : undefined;
	} else path = value;
	// Git resolves it from wherever it runs, so where a host `git push` writes cannot be checked: absolute only.
	if (!isAbsolute(path)) return "is a relative local path, which the sandbox does not publish: give the absolute path";
	let real: string;
	try {
		real = (input.realpath ?? realpathSync)(path);
	} catch {
		return "is a local path that does not exist";
	}
	// Preserve the former writable-root prefix: / matches itself, its children require //.
	const inside = input.writable.some((folder) => real === folder || within(real, `${folder}/`));
	return inside ? undefined : "is a local repository outside the folders the sandbox may write";
}

/**
 * Why a linked worktree's `gitdir` (the path of its `.git` file) may not be published: it must name a `.git` file in a
 * folder the sandbox may write, and that file must name this registration back, as `git worktree add` writes them.
 */
function worktreeGitdirReason(name: string, bytes: Buffer, input: ValidationInput): string | undefined {
	const text = bytes.toString("utf8");
	if (!/^[^\x00-\x1f]+\n?$/.test(text)) return "is not a path";
	if (!input.gitDir || !input.readWorkTreeFile) return "is a worktree registration the sandbox cannot check";
	const registration = join(input.gitDir, "worktrees", name);
	const gitfile = resolve(registration, text.replace(/\n$/, ""));
	if (basename(gitfile) !== ".git") return "does not name a worktree's .git file";
	let real: string;
	try {
		real = (input.realpath ?? realpathSync)(dirname(gitfile));
	} catch {
		return "names a worktree folder that does not exist";
	}
	if (!input.writable.some((folder) => real === folder || within(real, `${folder}/`)))
		return "names a worktree outside the folders the sandbox may write";
	const pointer = /^gitdir: ([^\x00-\x1f]+)\n?$/.exec(input.readWorkTreeFile(gitfile)?.toString("utf8") ?? "");
	if (!pointer || resolve(dirname(gitfile), pointer[1]!) !== registration)
		return `names ${gitfile}, which is not a .git file naming this worktree`;
	return undefined;
}

const REMOTE = "[A-Za-z0-9._-]+";
const REFSPEC = /^\^?\+?[^\s:\\]*(:[^\s:\\]*)?$/;

/** Why a configuration entry may not be published, or undefined. The closed list of sandbox.md § 10.4. */
function configKeyReason(entry: ConfigEntry, input: ValidationInput): string | undefined {
	const { key, value } = entry;
	const text = value ?? "";
	const branch = /^branch\.(.+)\.(remote|merge|rebase|pushremote)$/.exec(key);
	const remote = new RegExp(`^remote\\.(${REMOTE})\\.(url|fetch|push)$`).exec(key);
	const submodule = /^submodule\.(.+)\.(active|url)$/.exec(key);
	if (branch) {
		if (!validRefName(`refs/heads/${branch[1]}`)) return "names an invalid branch";
		if (branch[2] === "merge") return validRef(text) ? undefined : "is not a ref";
		if (branch[2] === "rebase")
			return /^(true|false|yes|no|on|off|1|0|merges|interactive|m|i)$/i.test(text)
				? undefined
				: "is not a rebase mode";
		return text === "." || new RegExp(`^${REMOTE}$`).test(text) ? undefined : "is not a remote name";
	}
	if (remote) {
		if (remote[2] === "url") return remoteUrlReason(text, input);
		return REFSPEC.test(text) && oneLine(text) ? undefined : "is not a refspec";
	}
	if (submodule) {
		if (!oneLine(submodule[1]!)) return "names an invalid submodule";
		return submodule[2] === "active"
			? BOOLEAN.test(text)
				? undefined
				: "is not a boolean"
			: remoteUrlReason(text, input);
	}
	if (key === "user.name" || key === "user.email") return oneLine(text) ? undefined : "is not one line";
	if (input.created) {
		if (key === "core.repositoryformatversion") return /^[01]$/.test(text) ? undefined : "is not 0 or 1";
		if (/^core\.(filemode|bare|logallrefupdates|ignorecase|symlinks)$/.test(key))
			return BOOLEAN.test(text) ? undefined : "is not a boolean";
		if (key === "extensions.objectformat") return /^(sha1|sha256)$/i.test(text) ? undefined : "is not a known format";
		// A submodule's Git folder names its working tree, as `git submodule add` and `update --init` write it. Git
		// runs nothing from it; it must lead into a folder the sandbox may write.
		if (key === "core.worktree") {
			if (!oneLine(text) || text.startsWith("~") || !input.gitDir)
				return "is not a working tree the sandbox can check";
			const worktree = resolve(input.gitDir, text);
			return input.writable.some((folder) => worktree === folder || within(worktree, `${folder}/`))
				? undefined
				: "names a working tree outside the folders the sandbox may write";
		}
	}
	return "is not a key the sandbox may change";
}

/**
 * A changed configuration: the entries outside the closed list must stay the same, in the same order, and each
 * entry of the list the command added or changed must have a valid value. Git's parser reads both versions.
 */
/** Keys whose change acts later, outside Prism: asked about, never published silently (H4). */
const DELAYED_KEY = new RegExp(`^(remote\\.${REMOTE}\\.(url|push)|user\\.(name|email))$`);

/** The delayed-effect keys whose values differ between the two versions. */
function configChanges(old: ConfigEntry[], next: ConfigEntry[]): ConfigChange[] {
	const keys = new Set([...old, ...next].map(({ key }) => key).filter((key) => DELAYED_KEY.test(key)));
	const values = (entries: ConfigEntry[], key: string) =>
		entries.filter((entry) => entry.key === key).map((entry) => entry.value ?? "");
	return [...keys].flatMap((key) => {
		const before = values(old, key);
		const after = values(next, key);
		return before.length === after.length && before.every((value, index) => value === after[index])
			? []
			: [{ key, before, after }];
	});
}

function configReason(
	before: Buffer | null,
	after: Buffer,
	input: ValidationInput,
	hooks?: (change: HooksPathChange) => void,
	delayed?: (changes: ConfigChange[]) => void,
): string | undefined {
	const old = before ? parseGitConfig(before) : [];
	const next = parseGitConfig(after);
	if (!old) return "could not be read as it was before the command";
	if (!next) return "is not a configuration Git can parse";
	const isHooks = (entry: ConfigEntry) => hooks !== undefined && entry.key === "core.hookspath";
	const others = (entries: ConfigEntry[]) => entries.filter((entry) => !inList(entry.key, input) && !isHooks(entry));
	const kept = others(old);
	const now = others(next);
	const length = Math.max(kept.length, now.length);
	for (let index = 0; index < length; index++) {
		const a = kept[index];
		const b = now[index];
		if (a?.key !== b?.key || a?.value !== b?.value) {
			const key = (b ?? a)!.key;
			// fork: Husky's first install sets it; refused, with a warning and no workaround.
			if (key === "core.hookspath")
				return "core.hooksPath: a hooks folder set in the sandbox is not applied, since Git outside Prism would run its hooks unconfined, and Prism does not set it for you. Warning: setting it outside Prism (for Husky, `npx husky`) runs code installed or changed in the project, possibly by the sandbox, outside the sandbox, as do the hooks it enables. Check the installed tool and the hooks folder before running anything outside the sandbox; once the key is set, the sandbox runs those hooks";
			return `${key}: not a key the sandbox may change (added, changed or removed)`;
		}
	}
	// fork: the hooks folder is asked about, once the rest is valid.
	if (hooks) {
		const values = (entries: ConfigEntry[]) => entries.filter(isHooks).map((entry) => entry.value);
		const was = values(old);
		const now = values(next);
		if (was.length !== now.length || was.some((value, index) => value !== now[index])) {
			const value = now.at(-1);
			if (now.length > 0 && (value === undefined || value === "" || !oneLine(value)))
				return "core.hooksPath has no single-line value";
			if (value?.includes("%(") || (value?.startsWith("~") && !value.startsWith("~/")))
				return `core.hooksPath=${value} is not a path the sandbox can check`;
			hooks({ before: was.at(-1) ?? undefined, after: value });
		}
	}
	const present = new Set(old.map(({ key, value }) => `${key}\0${value ?? "\u0001"}`));
	for (const entry of next) {
		if (!inList(entry.key, input) || present.has(`${entry.key}\0${entry.value ?? "\u0001"}`)) continue;
		const reason = configKeyReason(entry, input);
		if (reason) return `${entry.key} ${reason}`;
	}
	// fork: a repository the command made has no user's remote to redirect.
	if (!input.created) {
		const changes = configChanges(old, next);
		if (changes.length > 0) {
			if (!delayed)
				return `${changes[0]!.key}: a change to where or how Git outside Prism publishes, or to the identity of your commits, is applied only once you allow it, and no question can be asked here`;
			delayed(changes);
		}
	}
	return undefined;
}

/**
 * Why the configuration of a repository Prism did not see made may not stay as it is: the closed list, with the inert
 * keys `git init` and `git clone` write (`nested-git.ts`).
 */
export function createdConfigReason(bytes: Buffer, writable: string[], gitDir: string): string | undefined {
	return configReason(null, bytes, {
		changes: [],
		format: "sha1",
		existing: { type: () => undefined },
		writable,
		created: true,
		gitDir,
	});
}

/** Whether a key belongs to the closed list at all, whatever its value. */
function inList(key: string, input: ValidationInput): boolean {
	return (
		/^branch\..+\.(remote|merge|rebase|pushremote)$/.test(key) ||
		new RegExp(`^remote\\.${REMOTE}\\.(url|fetch|push)$`).test(key) ||
		/^submodule\..+\.(active|url)$/.test(key) ||
		key === "user.name" ||
		key === "user.email" ||
		(input.created === true &&
			/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|symlinks|worktree)|extensions\.objectformat)$/.test(
				key,
			))
	);
}

/**
 * A line of a rebase or cherry-pick to-do list. `exec` is refused: `git rebase --continue` outside the sandbox
 * would run the command the sandbox wrote. So is an unknown command.
 */
function todoReason(line: string): string | undefined {
	if (!line.trim() || line.startsWith("#")) return undefined;
	if (!oneLine(line.replace(/\t/g, " "))) return "holds a control character";
	const [command = "", ...rest] = line.trim().split(/\s+/);
	if (command === "exec" || command === "x")
		return "holds an exec line, which `git rebase --continue` outside Prism would run";
	const oid = /^[0-9a-f]{4,64}$/;
	switch (command) {
		case "pick":
		case "p":
		case "reword":
		case "r":
		case "edit":
		case "e":
		case "squash":
		case "s":
		case "drop":
		case "d":
		case "revert":
			return oid.test(rest[0] ?? "") ? undefined : `names no commit: ${line}`;
		case "fixup":
		case "f": {
			const at = rest[0] === "-C" || rest[0] === "-c" ? 1 : 0;
			return oid.test(rest[at] ?? "") ? undefined : `names no commit: ${line}`;
		}
		case "merge":
		case "m": {
			const at = rest[0] === "-C" || rest[0] === "-c" ? 2 : 0;
			if (at && !oid.test(rest[1] ?? "")) return `names no commit: ${line}`;
			return rest[at] ? undefined : `names no label: ${line}`;
		}
		case "label":
		case "l":
		case "reset":
		case "t":
			return rest[0] ? undefined : `names no label: ${line}`;
		case "update-ref":
		case "u":
			return validRef(rest[0] ?? "") ? undefined : `names no ref: ${line}`;
		case "break":
		case "b":
		case "noop":
			return undefined;
		default:
			return `holds an unknown command: ${command}`;
	}
}

/** `GIT_AUTHOR_NAME='…'` lines, shell-quoted as Git writes them, read by Git without a shell. */
function authorScriptReason(bytes: Buffer): string | undefined {
	const quoted = "'(?:[^'\\n]|'\\\\'')*'";
	const line = new RegExp(`^GIT_AUTHOR_(NAME|EMAIL|DATE)=${quoted}$`);
	return lines(bytes).every((entry) => line.test(entry)) ? undefined : "is not an author script Git writes";
}

/**
 * The state of a rebase, `git am` or cherry-pick in progress, file by file, so that a conflict is resolved in a
 * later command; everything that could name a program is checked (a strategy is one of Git's own).
 */
/** The options `git am` passes to `git apply` that only choose how a patch applies, never where Git writes. */
const APPLY_OPTION =
	/^(?:--whitespace=(?:nowarn|warn|fix|error|error-all|strip)|--ignore-whitespace|--ignore-space-change|--reject|-p[0-9]+|-C[0-9]+|--(?:exclude|include)=[^\n\0]*)$/;

/**
 * fork: `rebase-apply/apply-opt` holds the options `git am --continue` or `--retry`
 * passes to `git apply` later, outside Prism. `--build-fake-ancestor=<path>` there would write an index to a path of
 * the host. Read as Git writes it (` 'word'` each, a quote as `'\''`); an option that is not one of those `git am`
 * itself takes and Prism can judge is refused, so is a `--directory` that leaves the working tree.
 */
function applyOptReason(text: string): string | undefined {
	const body = text.replace(/\n$/, "");
	const word = / '((?:[^'\n]|'\\[!']')*)'/y;
	let at = 0;
	while (at < body.length) {
		word.lastIndex = at;
		const match = word.exec(body);
		if (!match) return "is not a list of options as Git writes it";
		at = word.lastIndex;
		const option = match[1]!.replace(/'\\(['!])'/g, "$1");
		const directory = /^--directory=(.*)$/.exec(option)?.[1];
		if (directory !== undefined) {
			if (isAbsolute(directory) || directory.split("/").includes("..") || /[\n\0]/.test(directory))
				return "names a folder outside the working tree for git am";
			continue;
		}
		if (!APPLY_OPTION.test(option))
			return `holds the git am option ${JSON.stringify(option)}, which Prism does not let a command leave for later`;
	}
	return undefined;
}

function stateReason(path: string, bytes: Buffer, input: ValidationInput): string | undefined {
	const hex = hexLength(input.format);
	const [folder, name = ""] = path.split("/", 2);
	const text = bytes.toString("utf8");
	const oids = () =>
		lines(bytes).every((entry) => new RegExp(`^[0-9a-f]{${hex}}$`).test(entry)) ? undefined : "is not object names";
	const inert = () => textReason(bytes, path);
	const flag = () =>
		bytes.length <= 256 && oneLine(text.replace(/\n$/, "")) ? undefined : "is not a flag Git writes";
	if (path.split("/").length !== 2) return "is not a file Git writes for an operation in progress";
	if (folder === "rebase-merge" || folder === "sequencer") {
		if (name === "git-rebase-todo" || name === "todo") {
			for (const entry of lines(bytes)) {
				const reason = todoReason(entry);
				if (reason) return reason;
			}
			return inert();
		}
		// Lists of what was done, and the list as last edited: Git reads them, never runs them.
		if (name === "done" || name === "git-rebase-todo.backup") return inert();
	}
	if (folder === "rebase-merge" || folder === "rebase-apply") {
		if (
			[
				"onto",
				"orig-head",
				"stopped-sha",
				"squash-onto",
				"amend",
				"autostash",
				"original-commit",
				"abort-safety",
			].includes(name)
		)
			return oids();
		if (name === "head-name")
			return text === "detached HEAD\n" || text === "detached HEAD" || validRef(text.replace(/\n$/, ""))
				? undefined
				: "is not a branch";
		if (["msgnum", "end", "next", "last"].includes(name))
			return /^[0-9]+\n?$/.test(text) ? undefined : "is not a number";
		if (name === "author-script") return authorScriptReason(bytes);
		if (folder === "rebase-apply" && name === "apply-opt") return applyOptReason(text);
		if (name === "strategy")
			return STRATEGIES.has(text.trim()) ? undefined : "names a merge strategy that is not Git's own";
		if (name === "gpg_sign_opt")
			return /^(-S[^\n]*|--no-gpg-sign)?\n?$/.test(text) && oneLine(text.replace(/\n$/, ""))
				? undefined
				: "is not a signing option";
		if (
			[
				"message",
				"message-squash",
				"message-fixup",
				"patch",
				"rewritten-list",
				"rewritten-pending",
				"current-fixups",
				"update-refs",
				"strategy_opts",
				"info",
				"msg",
				"msg-clean",
				"final-commit",
				"rewritten",
			].includes(name) ||
			(folder === "rebase-apply" && /^[0-9]{4,}$/.test(name))
		)
			return inert();
		if (
			[
				"interactive",
				"quiet",
				"verbose",
				"signoff",
				"drop_redundant_commits",
				"keep_redundant_commits",
				"no-reschedule-failed-exec",
				"reschedule-failed-exec",
				"allow_rerere_autoupdate",
				"committer-date-is-author-date",
				"ignore-date",
				"cdate_is_adate",
				"keep",
				"messageid",
				"scissors",
				"quoted-cr",
				"threeway",
				"sign",
				"utf8",
				"keepcr",
				"rebasing",
				"applying",
				"dirtyindex",
			].includes(name)
		)
			return flag();
	}
	if (folder === "sequencer") {
		if (name === "head" || name === "abort-safety") return oids();
		if (name === "opts") {
			const entries = parseGitConfig(bytes);
			if (!entries) return "is not a configuration Git can parse";
			for (const { key, value } of entries) {
				if (key === "options.strategy" && !STRATEGIES.has(value ?? ""))
					return "names a merge strategy that is not Git's own";
				if (
					!/^options\.(no-commit|edit|allow-empty|allow-empty-message|drop-redundant-commits|keep-redundant-commits|signoff|record-origin|allow-ff|mainline|strategy|strategy-option|gpg-sign|allow-rerere-auto|default-msg-cleanup)$/.test(
						key,
					) ||
					!oneLine(value ?? "")
				)
					return `holds ${key}, which is not an option Git writes`;
			}
			return undefined;
		}
	}
	return "is not a file Git writes for an operation in progress";
}

const LOCK = /\.lock$/;
const DERIVED =
	/^objects\/(info\/(commit-graph|commit-graphs\/.+|packs)|pack\/(pack-[0-9a-f]+\.(bitmap|rev|mtimes)|tmp_.+)|tmp_obj_.+|incoming-.+)$/;
const MAINTENANCE =
	"is Git maintenance (git gc, repack, prune, maintenance run), which works on the repository's objects, which the sandbox only reads: run it outside Prism";

/**
 * Validates every change; `refused` empty means `accepted` may be published as a whole. The object checks run
 * once every file is classified, since a ref may name an object of the same command.
 */
export async function validateGitChanges(input: ValidationInput): Promise<Validation> {
	const hex = hexLength(input.format);
	const accepted: GitChange[] = [];
	const dropped: string[] = [];
	const refused: Refusal[] = [];
	const refuse = (path: string, reason: string) => refused.push({ path, reason });
	let hooksPath: HooksPathChange | undefined;
	let delayedChanges: ConfigChange[] | undefined;
	const clearedIndexFlags: string[] = [];
	/** New objects, by name, with their type. */
	const created = new Map<string, ObjectType>();
	/** Objects that must exist once published: the name, the type it must have (any if undefined), who names it. */
	const needed: Array<{ oid: string; type: ObjectType | undefined; by: string }> = [];
	const objects: Array<{ change: GitChange; oid: string }> = [];
	const packFiles = new Set<string>();
	const oid = new RegExp(`^[0-9a-f]{${hex}}$`);
	// fork (AS-026): the main worktree's root is the Git folder's parent; a linked worktree's is unknown here.
	const worktreeRoot = input.gitDir && basename(input.gitDir) === ".git" ? dirname(input.gitDir) : undefined;
	let risky: string[] | undefined;
	const riskyRepositories = () => {
		risky ??= (input.riskyRepositories?.() ?? []).filter((folder) => folder !== worktreeRoot);
		return risky;
	};
	const refValue = (path: string, ref: string, bytes: Buffer): string | undefined => {
		const value = bytes.toString("utf8").replace(/\n$/, "");
		if (value.startsWith("ref: ")) {
			const target = value.slice(5);
			if (!validRef(target)) return "is a symbolic ref to an invalid name";
			if (ref === "HEAD" && !target.startsWith("refs/heads/")) return "HEAD must name a branch or a commit";
			return undefined;
		}
		if (!oid.test(value)) return "is not an object name or a symbolic ref";
		if (/^0+$/.test(value)) return "names the null object";
		needed.push({ oid: value, type: refTarget(ref), by: path });
		return undefined;
	};
	for (const change of input.changes) {
		const { path } = change;
		// Only object files have snapshots; metadata validators below require bytes.
		const after = change.after && (Buffer.isBuffer(change.after) ? change.after : Buffer.alloc(0));
		if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
			refuse(path, "is not a safe path");
			continue;
		}
		if (LOCK.test(path) || DERIVED.test(path)) {
			dropped.push(path);
			continue;
		}
		if (path.startsWith("modules/")) {
			refuse(path, "is in a submodule's Git folder, which is validated as its own repository");
			continue;
		}
		const worktree = /^worktrees\/[^/]+\//.exec(path)?.[0];
		const local = worktree ? path.slice(worktree.length) : path;
		const common = !worktree;
		const worktreeName = worktree?.slice("worktrees/".length, -1);
		let published = change;
		const reason = await (async (): Promise<string | undefined> => {
			if (worktreeName !== undefined) {
				if (worktreeName.startsWith(".")) return "is not a worktree registration Git writes";
				// `git worktree remove` and `prune` remove a registration as a whole.
				if (!after && input.removedWorktrees?.has(worktreeName)) return undefined;
				if (local === "commondir") return after?.toString("utf8") === "../..\n" ? undefined : "must be ../..";
				if (local === "gitdir") return after ? worktreeGitdirReason(worktreeName, after, input) : "removes gitdir";
				if (local === "locked") return after ? textReason(after, path) : undefined;
				if (local === "config.worktree")
					return "is a worktree's own configuration, which the sandbox does not publish";
			}
			if (common && new RegExp(`^objects/[0-9a-f]{2}/[0-9a-f]{${hex - 2}}$`).test(local)) {
				if (!after) return MAINTENANCE;
				objects.push({ change, oid: local.slice(8, 10) + local.slice(11) });
				return undefined;
			}
			// What only maintenance writes: the server information `git gc` and `repack` update, a multi-pack index.
			if (common && (local === "info/refs" || local.startsWith("objects/pack/multi-pack-index"))) return MAINTENANCE;
			const pack = /^objects\/pack\/(pack-[0-9a-f]+)\.(pack|idx|keep|promisor)$/.exec(local);
			if (common && pack) {
				if (!after) return MAINTENANCE;
				if (pack[2] === "promisor") return "is a partial clone's promisor pack, which the sandbox does not support";
				if (pack[2] === "keep") return "is a pack kept by an interrupted transfer";
				const verified = input.packs?.get(`objects/pack/${pack[1]}.pack`);
				if (!verified) return "is a pack the sandbox did not verify";
				// A fetch brings objects the repository lacks; a pack of objects it has is a repack's.
				if (pack[2] === "pack") {
					let fetched = false;
					for (const name of verified.objects.keys()) {
						if (!(await input.existing.type(name))) {
							fetched = true;
							break;
						}
					}
					if (!fetched) return MAINTENANCE;
				}
				packFiles.add(path);
				if (pack[2] === "idx") published = { ...change, after: verified.idx };
				for (const [name, type] of verified.objects) created.set(name, type);
				return undefined;
			}
			if (local === "HEAD" || local.startsWith("refs/")) {
				if (local !== "HEAD" && !validRefName(local)) return "is not a valid ref name";
				if (!after) return local === "HEAD" ? "removes HEAD" : undefined;
				return refValue(path, local, after);
			}
			if (common && local === "packed-refs") {
				if (!after) return undefined;
				const before = new Set(change.before ? lines(change.before) : []);
				let peelable = false;
				for (const line of lines(after)) {
					if (line.startsWith("# pack-refs with:")) continue;
					const peeled = new RegExp(`^\\^(${oid.source.slice(1, -1)})$`).exec(line);
					if (peeled && peelable) {
						if (!before.has(line)) needed.push({ oid: peeled[1]!, type: undefined, by: path });
						peelable = false;
						continue;
					}
					const record = new RegExp(`^(${oid.source.slice(1, -1)}) (refs/.+)$`).exec(line);
					if (!record || !validRefName(record[2]!)) return `holds an invalid record: ${line.slice(0, 200)}`;
					if (/^0+$/.test(record[1]!)) return `names the null object for ${record[2]}`;
					if (!before.has(line)) needed.push({ oid: record[1]!, type: refTarget(record[2]!), by: path });
					peelable = true;
				}
				return after.length > MAX_PACKED_REFS ? "is too large" : after.includes(0) ? "holds a NUL byte" : undefined;
			}
			if (local === "logs/HEAD" || (local.startsWith("logs/refs/") && validRefName(local.slice(5)))) {
				if (!after) return undefined;
				const record = new RegExp(
					`^[0-9a-f]{${hex}} [0-9a-f]{${hex}} [^\\x00-\\x1f<>]* <[^\\x00-\\x1f<>]*> [0-9]+ [+-][0-9]{4}(\\t[^\\x00\\r\\n]*)?$`,
				);
				return lines(after).every((line) => record.test(line))
					? textReason(after, path)
					: "holds an invalid reflog record";
			}
			if (
				[
					"ORIG_HEAD",
					"REBASE_HEAD",
					"CHERRY_PICK_HEAD",
					"REVERT_HEAD",
					"MERGE_HEAD",
					"AUTO_MERGE",
					"MERGE_AUTOSTASH",
				].includes(local)
			) {
				if (!after) return undefined;
				for (const line of lines(after)) {
					if (!oid.test(line) || /^0+$/.test(line)) return "is not object names";
					needed.push({ oid: line, type: undefined, by: path });
				}
				return undefined;
			}
			if (common && local === "FETCH_HEAD") {
				if (!after) return undefined;
				const record = new RegExp(`^[0-9a-f]{${hex}}\\t(not-for-merge)?\\t[^\\x00\\r\\n]*$`);
				return lines(after).every((line) => record.test(line))
					? textReason(after, path)
					: "is not a FETCH_HEAD Git writes";
			}
			if (local === "MERGE_MODE")
				return !after || /^(no-ff)?\n?$/.test(after.toString("utf8")) ? undefined : "is not a merge mode";
			if (["COMMIT_EDITMSG", "MERGE_MSG", "SQUASH_MSG", "TAG_EDITMSG"].includes(local))
				return after ? textReason(after, path) : undefined;
			if (local === "index") {
				if (!after) return "removes the index";
				const old = change.before ? sanitizedIndex(change.before, input.format) : undefined;
				const index = sanitizedIndex(after, input.format, {
					flags:
						old && old.reason === undefined ? old.flags : { assumeUnchanged: new Set(), skipWorktree: new Set() },
					sparse: input.sparseCheckout === true,
				});
				if (index.reason !== undefined) return index.reason;
				// fork (AS-018): the main worktree's root is the Git folder's parent; a linked worktree's, unknown here,
				// is matched by the end of the path.
				const root = input.gitDir && basename(input.gitDir) === ".git" ? dirname(input.gitDir) : undefined;
				const made = index.gitlinks.find((link) =>
					input.newRepositories?.some((folder) =>
						worktreeName === undefined && root ? folder === join(root, link) : folder.endsWith(`/${link}`),
					),
				);
				if (made)
					return `adds ${made} as a submodule, a repository this command made whose hooks or configuration run programs: Git would run them at the next git status outside Prism`;
				// fork: a submodule this index adds, judged by its repository as it is
				// now, whichever command made it.
				const listed = new Set(old && old.reason === undefined ? old.gitlinks : []);
				const added = index.gitlinks.filter((link) => !listed.has(link));
				const runs =
					added.length > 0
						? added.find((link) =>
								riskyRepositories().some((folder) =>
									worktreeName === undefined && root
										? folder === join(root, link)
										: folder.endsWith(`/${link}`),
								),
							)
						: undefined;
				if (runs)
					return `adds ${runs} as a submodule, a repository whose hooks or configuration run programs: Git would run them at the next git status outside Prism`;
				published = { ...change, after: index.index };
				// A loop: an index holds up to a million entries, too many for a spread.
				for (const file of index.cleared)
					clearedIndexFlags.push(worktreeName !== undefined ? `${file} (worktree ${worktreeName})` : file);
				const known = new Set(old && old.reason === undefined ? old.blobs : []);
				for (const blob of index.blobs) if (!known.has(blob)) needed.push({ oid: blob, type: "blob", by: path });
				return undefined;
			}
			if (common && local === "config")
				return configReason(
					change.before,
					after ?? Buffer.alloc(0),
					input,
					input.askHooksPath
						? (found) => {
								hooksPath = found;
							}
						: undefined,
					input.askConfigChanges
						? (found) => {
								delayedChanges = found;
							}
						: undefined,
				);
			if (/^(rebase-merge|rebase-apply|sequencer)\//.test(local))
				return after ? stateReason(local, after, input) : undefined;
			if (common && local.startsWith("hooks/")) return "is a Git hook, which is never published from the sandbox";
			return "is not a Git file the sandbox publishes";
		})();
		if (reason) refuse(path, reason);
		else accepted.push(published);
	}
	// Objects of the same command first, then those they and the refs name.
	for (const { change, oid: name } of objects) {
		const parsed = await looseObject(name, change.after!, input.format);
		if (typeof parsed === "string") {
			refuse(change.path, parsed);
			continue;
		}
		if (await input.existing.type(name)) continue;
		created.set(name, parsed.type);
		for (const named of parsed.names) needed.push({ ...named, by: change.path });
	}
	const reported = new Set<string>();
	for (const { oid: name, type, by } of needed) {
		const found = created.get(name) ?? (await input.existing.type(name));
		const reason = !found
			? `names ${name}, which does not exist`
			: type && found !== type
				? `names ${name}, a ${found} where Git expects a ${type}`
				: undefined;
		if (reason && !reported.has(`${by}\0${reason}`)) {
			reported.add(`${by}\0${reason}`);
			refuse(by, reason);
		}
	}
	for (const path of packFiles) {
		const other = path.endsWith(".pack") ? `${path.slice(0, -5)}.idx` : `${path.slice(0, -4)}.pack`;
		if (!input.changes.some((change) => change.path === other))
			refuse(path, "is a pack without its index, or an index without its pack");
	}
	if (refused.length === 0 && objects.length > 0) {
		if (!input.loose) {
			for (const { change } of objects) refuse(change.path, "is a loose object the sandbox did not verify with Git");
		} else {
			refused.push(
				...(await verifyLooseObjects({
					...input.loose,
					format: input.format,
					objects: objects.map(({ change }) => change),
					packs: input.changes.flatMap(({ path, after }) => {
						const verified = path.endsWith(".pack") && input.packs?.get(path);
						return verified && after ? [{ path, bytes: after, verified }] : [];
					}),
				})),
			);
		}
	}
	// fork: a new commit that holds such a repository as a submodule,
	// even once the index no longer lists it. Each path is matched by its end, as in the index above.
	if (refused.length === 0 && input.loose && input.newRepositories?.length) {
		const commits = [...created].flatMap(([name, type]) => (type === "commit" ? [name] : []));
		const paths = new Set<string>();
		for (const folder of input.newRepositories) {
			const parts = folder.split("/").filter(Boolean);
			for (let start = 0; start < parts.length; start++) paths.add(parts.slice(start).join("/"));
		}
		const found = await submodulesInCommits({
			...input.loose,
			format: input.format,
			objects: objects.map(({ change }) => change),
			packs: input.changes.flatMap(({ path, after }) => {
				const verified = path.endsWith(".pack") && input.packs?.get(path);
				return verified && after ? [{ path, bytes: after, verified }] : [];
			}),
			commits,
			paths: [...paths],
		});
		if (typeof found === "string")
			refuse("objects", `holds new commits Prism could not check for a submodule the command made: ${found}`);
		else
			for (const entry of found)
				refuse(
					"objects",
					`adds ${entry} as a submodule, a repository this command made whose hooks or configuration run programs: Git would run them after a checkout of that commit, at the next git status outside Prism`,
				);
	}
	// fork: a submodule a new commit adds (absent from its first parent), judged by
	// its repository as it is now, whichever command made it. Matched by the end of the path, as above.
	const newCommits = [...created].flatMap(([name, type]) => (type === "commit" ? [name] : []));
	if (refused.length === 0 && input.loose && newCommits.length > 0 && riskyRepositories().length > 0) {
		const paths = new Set<string>();
		for (const folder of riskyRepositories()) {
			const parts = folder.split("/").filter(Boolean);
			for (let start = 0; start < parts.length; start++) paths.add(parts.slice(start).join("/"));
		}
		const found = await submodulesInCommits({
			...input.loose,
			format: input.format,
			objects: objects.map(({ change }) => change),
			packs: input.changes.flatMap(({ path, after }) => {
				const verified = path.endsWith(".pack") && input.packs?.get(path);
				return verified && after ? [{ path, bytes: after, verified }] : [];
			}),
			commits: newCommits,
			paths: [...paths],
			added: true,
		});
		if (typeof found === "string")
			refuse("objects", `holds new commits Prism could not check for a submodule they add: ${found}`);
		else
			for (const entry of found)
				refuse(
					"objects",
					`adds ${entry} as a submodule, a repository whose hooks or configuration run programs: Git would run them after a checkout of that commit, at the next git status outside Prism`,
				);
	}
	return {
		accepted: refused.length ? [] : accepted,
		dropped,
		refused,
		...(hooksPath && !refused.length ? { hooksPath } : {}),
		...(delayedChanges && !refused.length ? { configChanges: delayedChanges } : {}),
		...(clearedIndexFlags.length && !refused.length ? { clearedIndexFlags } : {}),
	};
}

/**
 * Why the sandbox cannot isolate this repository's Git folder, from its configuration before the command; its
 * metadata then stays read-only, as without isolation. Formats: SHA-1 and SHA-256, refs in files, no partial clone.
 */
export function unsupportedGitFormat(config: ConfigEntry[]): string | undefined {
	for (const { key, value } of config) {
		const text = (value ?? "").toLowerCase();
		if (key === "core.repositoryformatversion" && !/^[01]$/.test(text))
			return `repository format version ${value} is not supported`;
		if (key === "core.splitindex" && /^(true|yes|on|1)?$/.test(text))
			return "a split index (core.splitIndex) is not supported";
		if (key === "index.sparse" && /^(true|yes|on|1)?$/.test(text))
			return "a sparse index (index.sparse) is not supported";
		if (!key.startsWith("extensions.")) continue;
		const name = key.slice(11);
		if (name === "objectformat" && (text === "sha1" || text === "sha256")) continue;
		if (name === "refstorage" && text === "files") continue;
		if (name === "worktreeconfig" || name === "preciousobjects" || name === "noop") continue;
		if (name === "refstorage") return `ref storage ${value} (reftable) is not supported`;
		if (name === "partialclone") return "a partial clone is not supported";
		return `extensions.${name} is not supported`;
	}
	return undefined;
}

/** The repository's object format, from its configuration before the command. */
export function gitObjectFormat(config: ConfigEntry[]): HashFormat {
	const format = config.findLast((entry) => entry.key === "extensions.objectformat")?.value?.toLowerCase();
	return format === "sha256" ? "sha256" : "sha1";
}

/**
 * The objects of a real repository, read without Git: loose objects by their header, packed ones through each
 * pack's index, a delta by the type of its base. Repositories with alternates are not isolated (the caller refuses
 * them), so the folder holds every object.
 */
export function gitObjectStore(objectsDir: string, format: HashFormat): ObjectLookup & { close(): Promise<void> } {
	const hashBytes = hexLength(format) / 2;
	let packs: Array<{ idx: FileHandle; pack: FileHandle; count: number; fanout: Buffer }> | undefined;
	const readAt = async (fd: FileHandle, length: number, position: number) => {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await fd.read(buffer, 0, length, position);
		return buffer.subarray(0, bytesRead);
	};
	const openObject = (path: string) => open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	const loadPacks = async () => {
		packs = [];
		let names: string[] = [];
		try {
			names = (await readdir(join(objectsDir, "pack"))).filter((name) => /^pack-[0-9a-f]+\.idx$/.test(name));
		} catch {}
		for (const name of names) {
			let idx: FileHandle | undefined;
			try {
				idx = await openObject(join(objectsDir, "pack", name));
				const header = await readAt(idx, 8 + 1024, 0);
				if (header.length < 8 + 1024 || header.readUInt32BE(0) !== 0xff744f63 || header.readUInt32BE(4) !== 2)
					throw new Error("unsupported pack index");
				const fanout = header.subarray(8);
				const pack = await openObject(join(objectsDir, "pack", `${name.slice(0, -4)}.pack`));
				packs.push({ idx, pack, count: fanout.readUInt32BE(1020), fanout });
			} catch {
				await idx?.close();
			}
		}
		return packs;
	};
	/** The entry's offset in its pack, or undefined. */
	const find = async (entry: NonNullable<typeof packs>[number], name: Buffer): Promise<number | undefined> => {
		const first = name[0]!;
		let low = first === 0 ? 0 : entry.fanout.readUInt32BE((first - 1) * 4);
		let high = entry.fanout.readUInt32BE(first * 4);
		while (low < high) {
			const middle = (low + high) >>> 1;
			const compared = (await readAt(entry.idx, hashBytes, 8 + 1024 + middle * hashBytes)).compare(name);
			if (compared === 0) {
				const base = 8 + 1024 + entry.count * (hashBytes + 4);
				const small = (await readAt(entry.idx, 4, base + middle * 4)).readUInt32BE(0);
				if (!(small & 0x80000000)) return small;
				const large = await readAt(entry.idx, 8, base + entry.count * 4 + (small & 0x7fffffff) * 8);
				return Number(large.readBigUInt64BE(0));
			}
			if (compared < 0) low = middle + 1;
			else high = middle;
		}
		return undefined;
	};
	const TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
	const packedType = async (name: string): Promise<ObjectType | undefined> => {
		const wanted = Buffer.from(name, "hex");
		for (const entry of packs ?? (await loadPacks())) {
			let offset = await find(entry, wanted);
			// A delta's type is its base's; Git allows chains up to 4095 deep.
			for (let hops = 0; offset !== undefined && hops < 5000; hops++) {
				const header = await readAt(entry.pack, 16 + hashBytes, offset);
				if (header.length === 0) return undefined;
				const kind = (header[0]! >> 4) & 7;
				if (TYPES[kind]) return TYPES[kind];
				let at = 1;
				while (at < header.length && header[at - 1]! & 0x80) at++;
				if (kind === 6) {
					let byte = header[at++]!;
					let distance = byte & 0x7f;
					while (byte & 0x80 && at < header.length) {
						byte = header[at++]!;
						// fork: arithmetic, not a 32-bit `|`, which made a base more than 2 GiB
						// back a negative distance, read after the delta.
						distance = (distance + 1) * 128 + (byte & 0x7f);
					}
					if (!Number.isSafeInteger(distance) || distance <= 0 || distance > offset) return undefined;
					offset = offset - distance;
				} else if (kind === 7) {
					const base = header.subarray(at, at + hashBytes).toString("hex");
					return gitObjectStoreType(base);
				} else return undefined;
			}
			if (offset !== undefined) return undefined;
		}
		return undefined;
	};
	const looseType = async (name: string): Promise<ObjectType | undefined> => {
		let fd: FileHandle | undefined;
		try {
			fd = await openObject(join(objectsDir, name.slice(0, 2), name.slice(2)));
			if (!(await fd.stat()).isFile()) return undefined;
			const head = inflateSync(await readAt(fd, 512, 0), { finishFlush: zlib.Z_SYNC_FLUSH });
			const match = /^(blob|tree|commit|tag) /.exec(head.toString("latin1", 0, 16));
			return match ? (match[1] as ObjectType) : undefined;
		} catch {
			return undefined;
		} finally {
			await fd?.close();
		}
	};
	const cache = new Map<string, ObjectType | undefined>();
	const gitObjectStoreType = async (name: string): Promise<ObjectType | undefined> => {
		if (cache.has(name)) return cache.get(name);
		cache.set(name, undefined);
		const type = (await looseType(name)) ?? (await packedType(name));
		cache.set(name, type);
		return type;
	};
	const valid = new RegExp(`^[0-9a-f]{${hashBytes * 2}}$`);
	return {
		type: (name) => (valid.test(name) ? gitObjectStoreType(name) : undefined),
		close: async () => {
			for (const entry of packs ?? []) {
				await entry.idx.close();
				await entry.pack.close();
			}
			packs = undefined;
		},
	};
}

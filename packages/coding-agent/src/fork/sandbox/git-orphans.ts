/**
 * fork: the private Git copies (`git-copy.ts`) that no Prism will
 * finish. Each copy's folder records where it comes from (`origin.json`), the background task working in it
 * (`holder.json`) and, once its changes were refused, why (`kept.json`). A copy whose Prism and task have both ended
 * without finishing it (stopped, killed, crashed) is reported once at the next start and listed in /sandbox with its
 * state and how to read it. Nothing here publishes, removes or resumes a copy: the user decides.
 */

import {
	closeSync,
	constants,
	type Dirent,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { sanitizeTerminalLabel } from "@earendil-works/pi-tui";
import { fill, labelled, t } from "../i18n/index.ts";
import { shellQuote } from "./shell-quote.ts";

const ORIGIN = "origin.json";
const HOLDER = "holder.json";
const KEPT = "kept.json";
const REPORTED = "reported";
const ALTERNATES = "objects/info/alternates";
/** What a copy's record or a ref file holds at most. */
const MAX_RECORD = 64 * 1024;
const MAX_PACKED_REFS = 16 * 1024 * 1024;
const MAX_REFS = 10_000;
/** What a report or /sandbox shows at most. */
const SHOWN_COPIES = 20;
const SHOWN_REFS = 8;
const usageReported = new WeakMap<object, string>();

/** Warns once per session when refused copies exceed 10 copies or 1 GiB; never follows links or reads file contents. */
export function keptGitCopiesWarning(folder: string, session: object, sessionTmp = ""): string | undefined {
	if (usageReported.get(session) === sessionTmp) return undefined;
	let copies: KeptCopy[];
	try {
		copies = keptGitCopies(folder).filter((copy) => copy.state === "kept");
	} catch {
		return undefined;
	}
	let bytes = 0;
	const pending = copies.map((copy) => copy.folder);
	while (copies.length <= 10 && bytes <= 1024 ** 3 && pending.length > 0) {
		const path = pending.pop()!;
		try {
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (stat?.isFile()) bytes += stat.size;
			else if (stat?.isDirectory()) {
				for (const name of readdirSync(path)) pending.push(join(path, name));
			}
		} catch {
			// Unreadable entries stay untouched, as in the copy listing.
		}
	}
	if (copies.length <= 10 && bytes <= 1024 ** 3) return undefined;
	usageReported.set(session, sessionTmp);
	return `Kept Git copies exceed ${copies.length > 10 ? "10 copies" : "1 GiB"} in ${folder}. Nothing was deleted. /sandbox lists them; after recovering what you need, remove each kept folder with rm -r -- <folder>.`;
}

/** What the caller knows of the command a copy is made for. */
export interface CopyOrigin {
	cwd: string;
	command: string;
	/** A background task, which may outlive Prism. */
	task: boolean;
}

/** A process, with its start time where the system gives it: a pid can be reused by another process. */
interface Owner {
	pid: number;
	start?: string;
}

interface Origin extends CopyOrigin {
	gitDir: string;
	prism: Owner;
	created: string;
}

/** The start time of process `pid`, in clock ticks since boot (Linux), or undefined. */
export function processStart(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The fields after the command's name, which may hold spaces and parentheses; the 22nd field is the start.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

function alive(owner: Owner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		// EPERM: the process exists under another user.
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	return owner.start === undefined || processStart(owner.pid) === owner.start;
}

const owner = (pid: number): Owner => ({ pid, start: processStart(pid) });

/** Records where a copy comes from, before anything else is in its folder. */
export function writeOrigin(folder: string, gitDir: string, origin: CopyOrigin): void {
	const record: Origin = {
		gitDir,
		cwd: origin.cwd,
		command: origin.command.slice(0, 500),
		task: origin.task,
		prism: owner(process.pid),
		created: new Date().toISOString(),
	};
	writeFileSync(join(folder, ORIGIN), JSON.stringify(record), { flag: "wx", mode: 0o600 });
}

/** Records the background task working in a copy, which may outlive this Prism. */
export function writeHolder(folder: string, pid: number): void {
	try {
		writeFileSync(join(folder, HOLDER), JSON.stringify(owner(pid)), { mode: 0o600 });
	} catch {}
}

/** Records why a copy's changes were not published. */
export function writeKept(folder: string, reasons: string[]): void {
	try {
		writeFileSync(join(folder, KEPT), JSON.stringify({ at: new Date().toISOString(), reasons }), { mode: 0o600 });
	} catch {}
}

/**
 * Points a copy's `objects/info/alternates` at `objects`, the real repository's, so that Git reads the copy with the
 * objects it borrows. The sandbox could write the copy: each folder is opened without following a link and the
 * file is made anew, never written through what the command left there. Nothing is written when that fails.
 */
export function writeAlternates(metadata: string, objects: string): void {
	const opened: number[] = [];
	const folder = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	try {
		opened.push(openSync(metadata, folder));
		for (const part of ["objects", "info"]) opened.push(openSync(`/proc/self/fd/${opened.at(-1)}/${part}`, folder));
		const at = `/proc/self/fd/${opened.at(-1)}/alternates`;
		try {
			unlinkSync(at);
		} catch {}
		const fd = openSync(at, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
		try {
			writeSync(fd, `${objects}\n`);
		} finally {
			closeSync(fd);
		}
	} catch {
	} finally {
		for (const fd of opened) closeSync(fd);
	}
}

/** A regular file's bytes, read without following a link; undefined when absent, not a file or over `max`. */
function readSmall(path: string, max: number): Buffer | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		return stat.isFile() && stat.size <= max ? readFileSync(fd) : undefined;
	} finally {
		closeSync(fd);
	}
}

function readJson(path: string): unknown {
	const bytes = readSmall(path, MAX_RECORD);
	if (!bytes) return undefined;
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		return undefined;
	}
}

const isOwner = (value: unknown): value is Owner =>
	typeof value === "object" &&
	value !== null &&
	Number.isSafeInteger((value as Owner).pid) &&
	(value as Owner).pid > 0 &&
	["string", "undefined"].includes(typeof (value as Owner).start);

function readOrigin(folder: string): Origin | undefined {
	const value = readJson(join(folder, ORIGIN)) as Partial<Origin> | undefined;
	if (
		typeof value?.gitDir !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.command !== "string" ||
		typeof value.task !== "boolean" ||
		typeof value.created !== "string" ||
		!isOwner(value.prism)
	)
		return undefined;
	return value as Origin;
}

const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/**
 * Removes the folders of copies a Prism that ended was making, named `.<id>` until their origin is written, so that
 * they hold nothing else. One holding anything else, or whose origin cannot be read, stays.
 */
export function removeUnstartedGitCopies(folder: string): void {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(".")) continue;
		const pending = join(folder, name);
		const origin = readOrigin(pending);
		if (!origin || alive(origin.prism)) continue;
		try {
			if (readdirSync(pending).some((entry) => entry !== ORIGIN)) continue;
		} catch {
			continue;
		}
		rmSync(pending, { recursive: true, force: true });
	}
}

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A repository's HEAD and refs, each with its commit or `ref: <name>`, read as files; undefined when unreadable. */
function readRefs(gitDir: string): Map<string, string> | undefined {
	if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) return undefined;
	const refs = new Map<string, string>();
	const packed = readSmall(join(gitDir, "packed-refs"), MAX_PACKED_REFS);
	for (const line of packed?.toString("utf8").split("\n") ?? []) {
		const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[\x21-\x7e]+)$/.exec(line);
		if (match && refs.size < MAX_REFS) refs.set(match[2]!, match[1]!);
	}
	const value = (path: string) => {
		const text = readSmall(path, MAX_RECORD)?.toString("utf8").trim();
		return text && (HASH.test(text) || /^ref: refs\/[\x21-\x7e]+$/.test(text)) ? text : undefined;
	};
	const walk = (relative: string, depth: number) => {
		if (depth > 16) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(join(gitDir, relative), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (refs.size >= MAX_REFS) return;
			const name = `${relative}/${entry.name}`;
			if (!/^[\x21-\x7e]+$/.test(entry.name)) continue;
			if (entry.isDirectory()) walk(name, depth + 1);
			else if (entry.isFile()) {
				const ref = value(join(gitDir, name));
				if (ref) refs.set(name, ref);
			}
		}
	};
	walk("refs", 0);
	const head = value(join(gitDir, "HEAD"));
	if (head) refs.set("HEAD", head);
	return refs;
}

/** A word the shell reads as it is. */

/**
 * How to read a copy kept for its repository `gitDir`: the refs that differ from the repository's, and a command that
 * reads the copy's commits with the repository's own configuration. Git run on the copy itself would read the
 * configuration the sandboxed command wrote, whose pager, for one, runs outside the sandbox.
 */
export function copyReadHint(metadata: string, gitDir: string): string[] {
	const copy = readRefs(metadata);
	if (!copy) return [];
	const real = readRefs(gitDir);
	if (!real) return [`The repository ${gitDir} is no longer there.`];
	const names = [...new Set([...copy.keys(), ...real.keys()])]
		.filter((name) => copy.get(name) !== real.get(name))
		.sort((a, b) => (a === "HEAD" ? -1 : b === "HEAD" ? 1 : a.localeCompare(b)));
	if (names.length === 0) return ["No ref differs from the repository's: its commits are there already."];
	const short = (value: string | undefined) =>
		value === undefined ? "absent" : value.startsWith("ref: ") ? value : value.slice(0, 12);
	const shown = names
		.slice(0, SHOWN_REFS)
		.map((name) => `${name}: ${short(copy.get(name))} in the copy, ${short(real.get(name))} in the repository`);
	if (names.length > SHOWN_REFS) shown.push(`and ${names.length - SHOWN_REFS} more`);
	const commit = names.map((name) => copy.get(name)).find((value) => value !== undefined && HASH.test(value));
	const lines = [`Refs that differ: ${shown.join("; ")}.`];
	if (commit)
		lines.push(
			`Read it with the repository's own configuration, not the copy's: GIT_ALTERNATE_OBJECT_DIRECTORIES=${shellQuote(join(metadata, "objects"))} git --no-pager --git-dir=${shellQuote(gitDir)} log ${commit}`,
		);
	return lines;
}

export interface KeptCopy {
	folder: string;
	origin?: Origin;
	/**
	 * kept: its changes were refused; unfinished: its Prism and task ended before checking them; outlived: a task
	 * still works in it, whose Prism ended; unreadable: where it comes from cannot be read.
	 */
	state: "kept" | "unfinished" | "outlived" | "unreadable";
	why: string[];
}

/** The copies no running Prism will finish, oldest first. Copies in use by a running Prism are left out. */
export function keptGitCopies(folder: string): KeptCopy[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return [];
	}
	const found: KeptCopy[] = [];
	for (const name of names) {
		// `.<id>`: being made; `<id>.old`: published, being removed.
		if (name.startsWith(".") || name.endsWith(".old")) continue;
		const copy = join(folder, name);
		if (!lstatSync(copy, { throwIfNoEntry: false })?.isDirectory()) continue;
		const origin = readOrigin(copy);
		if (!origin) {
			const why = exists(join(copy, ORIGIN)) ? `its ${ORIGIN} is unreadable` : `it has no ${ORIGIN}`;
			found.push({ folder: copy, state: "unreadable", why: [why] });
			continue;
		}
		if (exists(join(copy, KEPT))) {
			const reasons = (readJson(join(copy, KEPT)) as { reasons?: unknown } | undefined)?.reasons;
			const why =
				Array.isArray(reasons) && reasons.every((reason) => typeof reason === "string")
					? reasons
					: [`its ${KEPT} is unreadable`];
			found.push({ folder: copy, origin, state: "kept", why });
			continue;
		}
		if (alive(origin.prism)) continue;
		const holder = readJson(join(copy, HOLDER));
		if (isOwner(holder) && alive(holder)) {
			found.push({
				folder: copy,
				origin,
				state: "outlived",
				why: [
					`background task ${holder.pid} still works in it; its Prism ended, so its Git changes will not be published when it ends`,
				],
			});
			continue;
		}
		found.push({
			folder: copy,
			origin,
			state: "unfinished",
			why: [
				origin.task
					? "its Prism ended before this background task did, so its Git changes were not checked"
					: "its Prism ended (stopped, killed or crashed) before this command did, so its Git changes were not checked",
			],
		});
	}
	const created = (copy: KeptCopy) => copy.origin?.created ?? "";
	return found.sort((a, b) => created(a).localeCompare(created(b)));
}

const when = (origin: Origin) => `${origin.created.slice(0, 16).replace("T", " ")} UTC`;
const what = (origin: Origin) =>
	fill(
		'{0} "{1}"',
		t(origin.task ? "background task" : "command"),
		origin.command.length > 80 ? `${origin.command.slice(0, 80)}…` : origin.command,
	);

/**
 * At the start: the copies no Prism will finish that were not reported yet, one line each, then marked as reported.
 * A copy left unfinished reads its objects from its repository from then on, as a refused one does.
 */
export function reportGitCopies(folder: string, session: object = {}, sessionTmp = ""): string[] {
	removeUnstartedGitCopies(folder);
	const fresh = keptGitCopies(folder).filter(
		(copy) => (copy.state === "unfinished" || copy.state === "unreadable") && !exists(join(copy.folder, REPORTED)),
	);
	const lines: string[] = [];
	for (const copy of fresh) {
		const metadata = join(copy.folder, "metadata");
		if (copy.origin && copy.state === "unfinished") {
			// Only the line Prism wrote is replaced: the command's own would be part of what it left.
			const alternates = join(metadata, ALTERNATES);
			if (readSmall(alternates, MAX_RECORD)?.toString() === `/tmp/.prism-git/${basename(copy.folder)}\n`)
				writeAlternates(metadata, join(copy.origin.gitDir, "objects"));
		}
		try {
			writeFileSync(join(copy.folder, REPORTED), "", { flag: "wx" });
		} catch {}
		if (lines.length >= SHOWN_COPIES) continue;
		if (!copy.origin) {
			lines.push(`- ${copy.folder}: ${copy.why.map(t).join("; ")}`);
			continue;
		}
		const refs = copyReadHint(metadata, copy.origin.gitDir)[0];
		lines.push(
			`- ${copy.origin.gitDir}: ${what(copy.origin)}, ${when(copy.origin)}; ${copy.why.map(t).join("; ")}.${refs ? ` ${refs}` : ""}`,
		);
	}
	if (fresh.length > SHOWN_COPIES)
		lines.push(`- ${fill("and {0} more in {1}", String(fresh.length - SHOWN_COPIES), folder)}`);
	const warning = keptGitCopiesWarning(folder, session, sessionTmp);
	if (warning) lines.push(warning);
	// fork: the command and the paths come from the copy's folder; the report
	// goes to stderr as is.
	return lines.map(sanitizeTerminalLabel);
}

const LABELS: Record<KeptCopy["state"], string> = {
	kept: "kept, its changes were refused",
	unfinished: "not checked",
	outlived: "in use by a background task",
	unreadable: "provenance unreadable",
};

/** /sandbox: the copies no running Prism will finish, with where they come from, their state and how to read them. */
export function describeGitCopies(folder: string): string[] {
	const copies = keptGitCopies(folder);
	if (copies.length === 0) return [labelled("Kept Git copies", t("(none)"))];
	const lines = [
		fill(
			"Kept Git copies: {0}, not applied to their repositories. Prism never publishes, removes or resumes them: remove a folder once read.",
			String(copies.length),
		),
	];
	for (const copy of copies.slice(-SHOWN_COPIES)) {
		const metadata = join(copy.folder, "metadata");
		lines.push(`  ${copy.origin?.gitDir ?? copy.folder}: ${t(LABELS[copy.state])}: ${copy.why.map(t).join("; ")}`);
		if (copy.origin)
			lines.push(
				`    ${fill("From: {0} in {1}, {2}, Prism {3}", what(copy.origin), copy.origin.cwd, when(copy.origin), String(copy.origin.prism.pid))}`,
				...copyReadHint(metadata, copy.origin.gitDir).map((line) => `    ${line}`),
			);
		lines.push(`    ${labelled("Folder", copy.folder)}`);
	}
	if (copies.length > SHOWN_COPIES)
		lines.push(`  ${fill("and {0} older ones in {1}", String(copies.length - SHOWN_COPIES), folder)}`);
	return lines.map(sanitizeTerminalLabel);
}

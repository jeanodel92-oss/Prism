/**
 * a file the user adds to a message. An image goes as an image and a short text as its
 * content (the message carries them); a file of the project stays a path the agent already reaches; any other file
 * (a PDF, a document, an archive, a long text) is copied into the session's private /tmp, where the agent's tools
 * read and change it like the project, without a permission question, and the message gives the copy's path. The
 * original is never changed and its folder never opened to the agent. The copies are also kept next to the session
 * file and come back into the private /tmp when the session is resumed (that /tmp ends with the session).
 */
import {
	closeSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { detectSupportedImageMimeType } from "../utils/mime.ts";
import { anchoredOpenSupported, createWithoutLinks, openAnchored, writeWithoutLinks } from "./anchored-open.ts";
import { copyBoundedInto, copyFileExclusive, readFdBounded } from "./bounded-read.ts";
import { fill } from "./i18n/index.ts";
import { attachPastedImage } from "./image-attachments.ts";
import { within } from "./path-within.ts";
import { realPath } from "./real-path.ts";
import { sessionSandbox, sessionTmpDir } from "./sandbox/runtime.ts";

/** An image sent as an image; the engine resizes it. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** A text sent whole with the message (64k tokens or so). */
export const MAX_TEXT_BYTES = 256 * 1024;
/** A file copied for the agent: the private /tmp is often in memory (tmpfs). */
export const MAX_COPY_BYTES = 100 * 1024 * 1024;

export type Attachment =
	| { kind: "image"; name: string; mimeType: string; data: string }
	| { kind: "text"; name: string; path: string; text: string }
	/** `path` as the agent's tools see it; `copied` when it is a copy in the private /tmp. */
	| { kind: "file"; name: string; path: string; size: number; copied: boolean }
	| { kind: "error"; name: string; error: string };

/** The session a file is added to. */
export interface AttachTarget {
	cwd: string;
	sessionId: string;
	/** Undefined for a session that is not saved: its copies are not kept. */
	sessionFile?: string;
	/** The session manager, which keys the session's sandbox. */
	session: object;
}

const FOLDER = "attachments";

const storeOf = (sessionFile: string) => `${sessionFile.replace(/\.jsonl$/, "")}.attachments`;

/**
 * fork: copies `source` under a free name of `dir`, the agent's private /tmp folder: the
 * name is taken by an exclusive creation, and neither `dir` nor the name is followed if the agent made it a link.
 */
function copyToFreeName(source: string, dir: string, name: string, store?: string): string {
	const ext = extname(name);
	const stem = ext ? name.slice(0, -ext.length) : name;
	for (let i = 1; ; i++) {
		const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
		// fork: the name is free in the session's kept copies too, taken there by an
		// exclusive copy first; an earlier attachment whose working copy is gone keeps its saved one.
		if (store) {
			try {
				// fork: a copy that ends at the end it reads, never stuck on a truncated source.
				copyFileExclusive(source, join(store, candidate), MAX_COPY_BYTES);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw error;
			}
		}
		if (copyWithoutLinks(source, join(dir, candidate))) return candidate;
		if (store) unlinkSync(join(store, candidate));
	}
}

/** Copies `source` to `target` if it is free; false when something is already there. */
function copyWithoutLinks(source: string, target: string): boolean {
	if (!anchoredOpenSupported) {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		if (existsSync(target)) return false;
		copyFileExclusive(source, target, MAX_COPY_BYTES);
		return true;
	}
	let fd: number;
	try {
		fd = createWithoutLinks(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		copyBoundedInto(source, fd, MAX_COPY_BYTES);
	} finally {
		closeSync(fd);
	}
	return true;
}

function text(bytes: Buffer): string | undefined {
	if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/** A file the user chose, ready to go with the message, or why it cannot. Never throws. */
export function attachFile(path: string, target: AttachTarget, { inlineText = true } = {}): Attachment {
	const name = basename(path);
	try {
		const real = realpathSync(path);
		const stat = statSync(real);
		if (!stat.isFile()) return { kind: "error", name, error: fill("{0} is not a file", name) };
		const bytes = stat.size <= MAX_IMAGE_BYTES ? readFileSync(real) : undefined;
		const mimeType = bytes && detectSupportedImageMimeType(bytes);
		if (bytes && mimeType) return { kind: "image", name, mimeType, data: bytes.toString("base64") };
		const content = inlineText && bytes ? text(bytes) : undefined;
		if (content !== undefined) return { kind: "text", name, path: real, text: content };
		if (within(real, realpathSync(target.cwd)))
			return { kind: "file", name, path: real, size: stat.size, copied: false };
		if (stat.size > MAX_COPY_BYTES)
			return { kind: "error", name, error: fill("{0} is larger than {1} MB", name, String(MAX_COPY_BYTES >> 20)) };
		const tmp = join(realPath(sessionTmpDir(target.sessionId)), FOLDER);
		const store = target.sessionFile ? storeOf(target.sessionFile) : undefined;
		if (store) mkdirSync(store, { recursive: true, mode: 0o700 });
		const copy = copyToFreeName(real, tmp, name, store);
		// Sandboxed commands see the private /tmp at /tmp; without the sandbox, the folder itself.
		const shown = sessionSandbox(target.session) ? `/tmp/${FOLDER}/${copy}` : join(tmp, copy);
		return { kind: "file", name, path: shown, size: stat.size, copied: true };
	} catch (error) {
		return { kind: "error", name, error: `${name}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * The terminal's paste of copied files: an image as an image placeholder, a file of the project as its path, any
 * other file as the path of its copy for the agent. A file it cannot attach keeps its path, as before.
 */
export function pastedFiles(paths: string[], target: () => AttachTarget): string[] {
	let where: AttachTarget;
	try {
		where = target();
	} catch {
		return paths;
	}
	return paths.map((path) => {
		const attached = attachFile(path, where, { inlineText: false });
		if (attached.kind === "image") return attachPastedImage(Buffer.from(attached.data, "base64"), attached.mimeType);
		return attached.kind === "file" ? attached.path : path;
	});
}

/** What the model reads about a file it gets as a path (in the message, after the user's text). */
export function fileNote(file: { path: string; size: number; copied: boolean }): string {
	const size =
		file.size < 1024 * 1024
			? `${Math.max(1, Math.round(file.size / 1024))} KB`
			: `${(file.size / 1048576).toFixed(1)} MB`;
	const where = file.copied
		? "a copy the user attached; read or change it with your tools, the original is not reachable"
		: "a file of the project the user attached";
	return `<file name="${file.path}">\n[${size}, ${where}]\n</file>\n`;
}

/** Puts a resumed session's copies back into its new private /tmp. */
export function restoreAttachments(target: AttachTarget): void {
	if (!target.sessionFile) return;
	const store = storeOf(target.sessionFile);
	if (!existsSync(store)) return;
	const tmp = join(realPath(sessionTmpDir(target.sessionId)), FOLDER);
	for (const name of readdirSync(store)) copyWithoutLinks(join(store, name), join(tmp, name));
}

/**
 * fork: before the session's private /tmp is removed, the copies the agent
 * changed there replace their saved version, so a resumed session gets them as they were left. Only the names already
 * saved are looked at, each read through no link (the agent writes in that folder) and refused when it has other
 * names or is larger than a copy may be. Linux only, where the folder can be read through no link.
 */
export function keepChangedAttachments(target: AttachTarget): void {
	if (!target.sessionFile || !anchoredOpenSupported) return;
	const store = storeOf(target.sessionFile);
	if (!existsSync(store)) return;
	const tmp = join(realPath(sessionTmpDir(target.sessionId)), FOLDER);
	const saved = realPath(store);
	for (const name of readdirSync(store)) {
		let data: Buffer;
		try {
			const { fd, stat } = openAnchored(join(tmp, name), "read");
			try {
				if (stat.nlink > 1 || stat.size > MAX_COPY_BYTES) continue;
				const read = readFdBounded(fd, MAX_COPY_BYTES);
				if (read.over) continue;
				data = read.data;
			} finally {
				closeSync(fd);
			}
		} catch {
			continue; // gone, or not a plain file: the saved copy stays
		}
		if (!data.equals(readFileSync(join(saved, name)))) writeWithoutLinks(join(saved, name), data, 0o600);
	}
}

/**
 * fork: a duplicated or forked session is a new session file with its own store
 * and private /tmp. The saved copies its messages name (`attachments/<name>`) are copied from the session it was made
 * from into its own store, before they are put back into its /tmp; a name already in its store is left alone.
 */
export function inheritAttachments(previousSessionFile: string, target: AttachTarget, entriesText: string): void {
	if (!target.sessionFile || target.sessionFile === previousSessionFile) return;
	const from = storeOf(previousSessionFile);
	if (!existsSync(from)) return;
	const store = storeOf(target.sessionFile);
	for (const name of readdirSync(from)) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (!new RegExp(`attachments/${escaped}(?![\\w.-])`).test(entriesText)) continue;
		mkdirSync(store, { recursive: true, mode: 0o700 });
		try {
			copyFileExclusive(join(from, name), join(store, name), MAX_COPY_BYTES);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

/** Every string under `value` passed through `change`; the same object when none changed. Image data is skipped. */
function mapStrings<T>(value: T, change: (text: string) => string): T {
	if (typeof value === "string") return change(value) as T;
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		let changed = false;
		const items = value.map((item) => {
			const next = mapStrings(item, change);
			if (next !== item) changed = true;
			return next;
		});
		return (changed ? items : value) as T;
	}
	if ((value as { type?: unknown }).type === "image") return value;
	let copy: Record<string, unknown> | undefined;
	for (const [key, item] of Object.entries(value)) {
		const next = mapStrings(item, change);
		if (next === item) continue;
		copy ??= { ...(value as Record<string, unknown>) };
		copy[key] = next;
	}
	return (copy ?? value) as T;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * fork: without the sandbox, a copy's path is the host path of the
 * session's private /tmp, a new folder for each run (`prism-tmp-<pid>-…`). A resumed, duplicated or forked session
 * still names the folder of the run that attached the file, removed with that run. Those paths are given this run's
 * folder in what the model is sent; the session file keeps them as written. With the sandbox, the path is
 * `/tmp/attachments/<name>` in every run and nothing changes. Undefined when no message names another run's folder.
 */
export function currentAttachmentPaths(messages: AgentMessage[], target: AttachTarget): AgentMessage[] | undefined {
	const roots = [...new Set([tmpdir(), realPath(tmpdir())])].map(escapeRegExp).join("|");
	const other = new RegExp(`(?:${roots})/prism-tmp-\\d+-[^/\\s"'<>]+/${FOLDER}/`, "g");
	let current: string | undefined;
	const change = (text: string) => {
		if (!text.includes(`/${FOLDER}/`)) return text;
		return text.replace(other, () => {
			current ??= sessionSandbox(target.session)
				? `/tmp/${FOLDER}/`
				: `${join(realPath(sessionTmpDir(target.sessionId)), FOLDER)}/`;
			return current;
		});
	};
	const rewritten = mapStrings(messages, change);
	return rewritten === messages ? undefined : rewritten;
}

/** The session of a session manager (the one its sandbox is keyed by). */
export const attachTarget = (sessionManager: {
	getCwd(): string;
	getSessionId(): string;
	getSessionFile(): string | undefined;
}): AttachTarget => ({
	cwd: sessionManager.getCwd(),
	sessionId: sessionManager.getSessionId(),
	sessionFile: sessionManager.getSessionFile(),
	session: sessionManager,
});

export default function fileAttachments(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		try {
			const target = attachTarget(ctx.sessionManager);
			if (event.reason === "fork" && event.previousSessionFile) {
				inheritAttachments(event.previousSessionFile, target, JSON.stringify(ctx.sessionManager.getEntries()));
			}
			restoreAttachments(target);
		} catch (error) {
			ctx.ui.notify(
				fill("Could not restore the attached files: {0}", error instanceof Error ? error.message : String(error)),
				"warning",
			);
		}
	});

	pi.on("context", (event, ctx) => {
		const messages = currentAttachmentPaths(event.messages, attachTarget(ctx.sessionManager));
		return messages ? { messages } : undefined;
	});
}

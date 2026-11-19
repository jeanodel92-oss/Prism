/**
 * fork: a file tool's call opens the object its permission judged.
 *
 * The permission judges a path when the call arrives; the tool opens it later, after the mutation queue and any
 * question. In between, a background command can put a link on the path. The decision records here the physical
 * path it judged (links resolved then, so a link already there when judged is followed) and the file's identity;
 * the tool opens that path without following any link and refuses another file under the same name.
 */
import { closeSync, lstatSync } from "node:fs";
import { withFileMutationQueue } from "../core/tools/file-mutation-queue.ts";
import {
	type AnchoredFile,
	type AnchoredMode,
	anchoredOpenSupported,
	type FileIdentity,
	identityOf,
	openAnchored,
	publishAnchored,
	readAnchored,
	replaceAnchored,
	sameIdentity,
} from "./anchored-open.ts";
import { realPath } from "./real-path.ts";

export interface FileBinding {
	/** The path the call names, as the tool resolves it. */
	path: string;
	/** The file the decision judged, links resolved. */
	physical: string;
	/** Its identity when it existed. */
	identity?: FileIdentity;
	/** Its names (hard links) then. */
	links: number;
}

const bindings = new Map<string, FileBinding>();
/** Calls a later extension blocked never take theirs: the oldest go. */
const KEPT = 256;

/** The object `path` designates now, as a decision judges it. */
export function judgedFile(path: string): FileBinding {
	const physical = realPath(path);
	try {
		const stat = lstatSync(physical);
		if (stat.isFile()) return { path, physical, identity: identityOf(stat), links: stat.nlink };
	} catch {
		// Not there yet: the tool creates it.
	}
	return { path, physical, links: 0 };
}

/** Records the object judged for one call. */
export function bindFileCall(toolCallId: string, path: string): void {
	if (!anchoredOpenSupported) return;
	bindings.delete(toolCallId);
	bindings.set(toolCallId, judgedFile(path));
	if (bindings.size > KEPT) bindings.delete(bindings.keys().next().value as string);
}

/** The object judged for this call, when it was judged under this same path; taken once. */
export function takeFileBinding(toolCallId: string | undefined, path: string): FileBinding | undefined {
	if (toolCallId === undefined) return undefined;
	const binding = bindings.get(toolCallId);
	bindings.delete(toolCallId);
	return binding?.path === path ? binding : undefined;
}

/** Opens the judged object, or fails: a link on its path, another file under its name, a new hard link. */
export function openBound(binding: FileBinding, mode: AnchoredMode): AnchoredFile {
	const file = openAnchored(binding.physical, mode, mode === "write" ? 0o777 : false);
	const refuse = (why: string): never => {
		closeSync(file.fd);
		throw new Error(`${binding.path}: ${why}; it was not opened. Nothing was read or written.`);
	};
	if (binding.identity && !file.created && !sameIdentity(binding.identity, identityOf(file.stat)))
		refuse("another file was put under this name after it was allowed");
	// a write through one name changes every other name of the file, outside the project too.
	if (mode !== "read" && file.stat.nlink > Math.max(1, binding.links))
		refuse("this file got another name (a hard link) after it was allowed");
	return file;
}

const opened = new WeakMap<FileBinding, number>();

/** {@link openBound}, kept open until {@link closeBound}: one descriptor for a read and the write after it. */
export function openBoundOnce(binding: FileBinding, mode: AnchoredMode): number {
	const { fd } = openBound(binding, mode);
	opened.set(binding, fd);
	return fd;
}

export function closeBound(binding: FileBinding | undefined): void {
	const fd = binding && opened.get(binding);
	if (binding && fd !== undefined) {
		opened.delete(binding);
		closeSync(fd);
	}
}

/**
 * `call` in the write queue of the judged object (or of `path` without a binding), then the descriptor
 * {@link openBoundOnce} kept for it closed.
 */
export function withBoundFileQueue<T>(
	binding: FileBinding | undefined,
	path: string,
	call: () => Promise<T>,
): Promise<T> {
	return withFileMutationQueue(binding?.physical ?? path, async () => {
		try {
			return await call();
		} finally {
			closeBound(binding);
		}
	});
}

export const readBoundFile = readAnchored;

/** fork: the edited content replaces the judged file whole when it can, see publishAnchored. */
export function replaceBoundFile(binding: FileBinding, fd: number, content: string): void {
	publishAnchored(fd, binding.physical, content);
}

export function writeBound(binding: FileBinding, content: string): void {
	const { fd, created } = openBound(binding, "write");
	try {
		if (created) replaceAnchored(fd, content);
		else publishAnchored(fd, binding.physical, content);
	} finally {
		closeSync(fd);
	}
}

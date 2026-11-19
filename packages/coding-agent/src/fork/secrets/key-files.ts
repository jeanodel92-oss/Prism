/**
 * a file that received a key (reveal.ts) is hidden from
 * the agent until the end of the session. The masking finds a key only as it is: once such a file was written, a
 * command that printed it with a space after each character (`sed 's/./& /g'`, no question) gave the key to the model.
 *
 * So the file is refused to the file tools that read its content (reveal-question.ts: read, grep, and edit unless the
 * edit names each of its keys by its label), and hidden from the session's sandboxed commands like the settings'
 * hidden paths (sandbox/runtime.ts asks {@link keyFiles} before each command). Its name stays listed (ls, find).
 * Kept by session, by the session manager the sandbox is kept by.
 */

import { realPath } from "../real-path.ts";
import { within } from "../sandbox/path-within.ts";

/** Session to the real path of each file that received a key, with the names of the keys it received. */
const sessions = new WeakMap<object, Map<string, Set<string>>>();

/** Records that the file `path` receives the keys `names` in this session. */
export function addKeyFile(session: object, path: string, names: Iterable<string>): void {
	let files = sessions.get(session);
	if (!files) {
		files = new Map();
		sessions.set(session, files);
	}
	const real = realPath(path);
	files.set(real, new Set([...(files.get(real) ?? []), ...names]));
}

/** Forgets the session's files: a new session starts, which rebuilds its own. */
export function forgetKeyFiles(session: object): void {
	sessions.delete(session);
}

/** The real paths of the files that received a key in this session: hidden from its commands. */
export function keyFiles(session: object): string[] {
	return [...(sessions.get(session)?.keys() ?? [])];
}

/** The file that received a key that a read of `path`, or a search from it, reaches, and the keys' names. */
export function keyFileAt(session: object, path: string): { file: string; names: ReadonlySet<string> } | undefined {
	const files = sessions.get(session);
	if (!files) return undefined;
	const real = realPath(path);
	for (const [file, names] of files) if (within(file, real)) return { file, names };
	return undefined;
}

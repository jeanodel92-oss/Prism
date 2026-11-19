// fork: shared lexical containment of resolved paths. In this folder because the programs the
// sandbox runs (relay.ts, git-ssh-client.ts, git-sign-client.ts) see only this folder of Prism's code when commands
// may read only the project: their imports must stay in it (fork-sandbox-imports.test.ts).
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

/** `path` is `root` or below it; the filesystem root contains every absolute path. */
export function within(path: string, root: string): boolean {
	if (path === root) return true;
	return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * `path` relative to `root` when it is below it, else undefined (also for `root` itself). Only a first segment that is
 * exactly `..` leads out: a file or folder named `..notes` is inside.
 */
export function relativeInside(root: string, path: string): string | undefined {
	const inside = relative(root, path);
	if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) return undefined;
	return inside;
}

/** `path` as the user reads it: the home folder written `~`, a path below it `~/…`; any other path unchanged. */
export function homeRelative(path: string, home = homedir()): string {
	if (!home) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

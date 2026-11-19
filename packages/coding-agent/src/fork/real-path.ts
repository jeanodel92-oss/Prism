// fork: the file a path really designates once symlinks are followed.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { within } from "./path-within.ts";

/**
 * The file a tool really touches once symlinks are followed, also for a file that does not exist
 * yet (its parent is resolved) and for a dangling link (writing it creates the target). A symlink
 * loop stops after 40 hops, like the kernel, on the last path reached. Only links count as hops:
 * a deep path below a link must still be followed through it.
 */
export function realPath(abs: string, hops = 0): string {
	if (hops > 40) return abs;
	try {
		return realpathSync(abs);
	} catch {}
	let link: string | undefined;
	try {
		if (lstatSync(abs).isSymbolicLink()) link = readlinkSync(abs);
	} catch {}
	if (link !== undefined) return realPath(resolve(dirname(abs), link), hops + 1);
	const parent = dirname(abs);
	return parent === abs ? abs : join(realPath(parent, hops), basename(abs));
}

/**
 * The real file behind `abs` when a symlink leads elsewhere, else undefined. A project reached
 * through a symlink (the cwd itself) does not count: only links inside the path do.
 */
export function symlinkTarget(abs: string, cwd: string): string | undefined {
	const real = realPath(abs);
	if (real === abs) return undefined;
	// Preserve the strict prefix: the project itself is excluded, and / requires //.
	const inProject = within(abs, cwd + sep);
	if (inProject && real === join(realPath(cwd), relative(cwd, abs))) return undefined;
	return real;
}

/**
 * fork: the file the kernel reaches for `path` from `base`. Each
 * component is followed before the next one, so `link/../access` is `access` next to where `link` leads, not next to
 * `link` as `resolve` makes it.
 */
export function physicalPath(base: string, path: string): string {
	let current = path.startsWith("/") ? "/" : realPath(base);
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		current = part === ".." ? dirname(current) : realPath(join(current, part));
	}
	return current;
}

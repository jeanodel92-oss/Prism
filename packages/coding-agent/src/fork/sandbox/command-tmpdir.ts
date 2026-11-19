// fork: only sandboxed commands replace an unusable inherited TMPDIR.

import { accessSync, constants, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SandboxLayout } from "./layout.ts";
import { within } from "./path-within.ts";

interface DirectoryMount {
	source: string;
	destination: string;
}

/** Follow links in the command's namespace, including links inside the remapped project cache. */
function directoryPath(path: string, mount: DirectoryMount | undefined, reachable: (path: string) => boolean): string {
	const pending = path.split("/");
	let target = "/";
	let links = 0;
	for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
		if (!part || part === ".") continue;
		if (part === "..") {
			target = dirname(target);
			continue;
		}
		const next = join(target, part);
		if (!reachable(next)) throw new Error("TMPDIR traverses a hidden path");
		const source =
			mount && within(next, mount.destination) ? `${mount.source}${next.slice(mount.destination.length)}` : next;
		let link: string | undefined;
		try {
			link = readlinkSync(source);
		} catch {}
		if (link === undefined) {
			// bubblewrap creates missing parents of the cache mount; other missing components remain absent.
			if ((!mount || !within(mount.destination, next)) && !statSync(source).isDirectory()) {
				throw new Error("TMPDIR traverses a non-directory path");
			}
			target = next;
			continue;
		}
		if (++links > 40) throw new Error("Too many symbolic links in TMPDIR");
		if (isAbsolute(link)) target = "/";
		pending.unshift(...link.split("/"));
	}
	return target;
}

/** Existing, searchable and writable directory, with links resolved as for layout binds. */
export function writableDirectory(
	path: string,
	mount?: DirectoryMount,
	reachable?: (path: string) => boolean,
): string | undefined {
	try {
		const real = mount || reachable ? directoryPath(path, mount, reachable ?? (() => true)) : realpathSync(path);
		const source =
			mount && within(real, mount.destination) ? `${mount.source}${real.slice(mount.destination.length)}` : real;
		if (!statSync(source).isDirectory()) return undefined;
		accessSync(source, constants.W_OK | constants.X_OK);
		return real;
	} catch {
		return undefined;
	}
}

/** Pure decision; directory supplies filesystem facts, without changing the environment or creating paths. */
export function commandTmpDir(
	tmpdir: string | undefined,
	layout: SandboxLayout,
	directory: typeof writableDirectory,
): string | undefined {
	if (tmpdir === undefined || layout.tmp === undefined) return tmpdir;
	// Do not expand ~, or collapse link/.. before following links.
	const absolute = isAbsolute(tmpdir) ? tmpdir : `${layout.cwd}/${tmpdir}`;
	const visible = resolve(absolute);
	if (absolute === "/tmp" || /^\/tmp\/+$/u.test(absolute)) return tmpdir;
	if (visible !== "/tmp" && within(visible, "/tmp")) return "/tmp";
	const home = layout.home;
	const cache = home ? join(home.path, ".cache") : undefined;
	const writable = (path: string) => {
		if (path === "/tmp") return true;
		if (within(path, "/tmp")) return false;
		if (
			[...layout.hidden, ...layout.readOnly, ...(layout.copies ?? []).map(([, path]) => path)].some((root) =>
				within(path, root),
			)
		)
			return false;
		return layout.writable.some((root) => within(path, root)) || (cache !== undefined && within(path, cache));
	};
	// A link must itself be reachable through the limited home or an explicitly hidden mount.
	if (layout.hidden.some((root) => within(visible, root))) return "/tmp";
	if (
		home &&
		[home.path, ...home.hiddenOutside].some((root) => within(visible, root)) &&
		![...home.read, ...layout.writable, cache!].some((root) => within(visible, root))
	)
		return "/tmp";
	const real = directory(absolute, home && cache ? { source: home.cache, destination: cache } : undefined, (path) => {
		if (path !== "/tmp" && within(path, "/tmp")) return false;
		if (layout.hidden.some((root) => within(path, root))) return false;
		return (
			!home ||
			![home.path, ...home.hiddenOutside].some((root) => within(path, root)) ||
			[...home.read, ...layout.writable, cache!].some((root) => within(path, root) || within(root, path))
		);
	});
	if (real === undefined) return "/tmp";
	return writable(real) ? tmpdir : "/tmp";
}

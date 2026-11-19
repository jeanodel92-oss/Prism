/**
 * fork: the package caches a command may write, created before it when they are absent. The
 * home folder is read-only in the sandbox and only existing caches are mounted writable, so on a new home folder
 * `npm install`, `cargo build`, uv and Go failed.
 *
 * Only the caches of the tools found in the PATH, and only those the sandbox mounts writable anyway: creating one
 * never widens what commands may write. Nothing existing is replaced, no link is followed, and nothing is created in
 * a hidden path; such a cache is left absent, as before.
 */

import { lstatSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { DEFAULT_HIDDEN_HOME_PATHS, DEFAULT_WRITABLE_HOME_PATHS, type SandboxSettings } from "./layout.ts";
import { within } from "./path-within.ts";
import { TOOL_RESOURCES } from "./read-limit.ts";

/** Each cache, relative to the home folder, with the commands that use it; none: any command may (`~/.cache`). */
export const TOOL_CACHES: readonly { path: string; commands: readonly string[] }[] = [
	{ path: ".npm", commands: ["npm"] },
	{ path: ".cargo/registry", commands: ["cargo"] },
	{ path: ".cargo/git", commands: ["cargo"] },
	{ path: ".bun/install/cache", commands: ["bun"] },
	{ path: "go/pkg", commands: ["go"] },
	// uv, pip and Go's build cache; with reading limited, ~/.cache is the project's own cache, made by Prism.
	{ path: ".cache", commands: [] },
];

const isFolder = (path: string): boolean | undefined => {
	try {
		// lstat: a link, even to a folder, is not one.
		return lstatSync(path).isDirectory();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : false;
	}
};

const inPath = (command: string, path: string) =>
	path.split(delimiter).some((dir) => {
		if (!dir) return false;
		try {
			return lstatSync(join(dir, command)) !== undefined;
		} catch {
			return false;
		}
	});

/** Creates the folders of `relativePath` under `home` one at a time; false at the first entry that is not a folder. */
function makeFolders(home: string, relativePath: string): boolean {
	let current = home;
	for (const part of relativePath.split("/")) {
		current = join(current, part);
		const folder = isFolder(current);
		if (folder) continue;
		if (folder === false) return false;
		try {
			mkdirSync(current);
		} catch {
			// Made meanwhile by someone else: only a folder will do.
			if (!isFolder(current)) return false;
		}
	}
	return true;
}

/** Creates the absent caches of the tools found in `path`; returns the folders made. */
export function createToolCaches(
	settings: SandboxSettings,
	cwd: string,
	home = homedir(),
	path = process.env.PATH ?? "",
): string[] {
	const writable =
		settings.read.limit === "project"
			? TOOL_RESOURCES.filter((tool) => !settings.read.toolsOff.includes(tool.tool)).flatMap((tool) => tool.write)
			: DEFAULT_WRITABLE_HOME_PATHS;
	const hidden = [
		...DEFAULT_HIDDEN_HOME_PATHS.map((entry) => join(home, entry)),
		...settings.hide.map((entry) =>
			resolve(cwd, entry === "~" ? home : entry.startsWith("~/") ? join(home, entry.slice(2)) : entry),
		),
	];
	// The home folder itself may be a link (/home -> /var/home); what is below it may not.
	try {
		if (!statSync(home).isDirectory()) return [];
	} catch {
		return [];
	}
	const made: string[] = [];
	for (const cache of TOOL_CACHES) {
		const target = join(home, cache.path);
		if (!writable.includes(cache.path) || isFolder(target) !== undefined) continue;
		if (hidden.some((folder) => within(target, folder))) continue;
		if (cache.commands.length > 0 && !cache.commands.some((command) => inPath(command, path))) continue;
		if (makeFolders(home, cache.path)) made.push(target);
	}
	return made;
}

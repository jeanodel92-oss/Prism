/**
 * the window's "Choose a project folder" offers the folders worked in lately, so a
 * project used often is one click away instead of browsed to at each launch. They are read from the saved sessions:
 * one folder of `sessions/` per project, the newest session file of each giving its date and, in its header, the
 * project's path. Only the first line of one file per project is read.
 */
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readBounded } from "./bounded-read.ts";

/** How many recent folders the window lists. */
export const RECENT_PROJECTS_LIMIT = 8;

/** A session header is one short JSON line; more than this is not one. */
const HEADER_BYTES = 64 * 1024;

async function firstLine(path: string): Promise<string | undefined> {
	// fork: a FIFO among the sessions is refused, never waited on.
	const text = (await readBounded(path, HEADER_BYTES, { over: "truncate" })).toString("utf-8");
	const end = text.indexOf("\n");
	return end < 0 ? undefined : text.slice(0, end);
}

/** A throwaway folder of `prism` started in the home folder (`newWorkFolder`): not a project to come back to. */
function isThrowaway(cwd: string): boolean {
	return dirname(cwd) === resolve(tmpdir()) && basename(cwd).startsWith("prism-work-");
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** The project folders of the saved sessions under `sessionsDir`, most recently used first, without `exclude`. */
export async function recentProjects(
	sessionsDir: string,
	{ exclude, limit = RECENT_PROJECTS_LIMIT }: { exclude?: string; limit?: number } = {},
): Promise<string[]> {
	let entries: string[];
	try {
		entries = (await readdir(sessionsDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const newest = await Promise.all(
		entries.map(async (name) => {
			const dir = join(sessionsDir, name);
			try {
				const files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl"));
				// fork: a session removed during the scan, or a dangling link, is
				// skipped alone; the project keeps its other sessions.
				const dated = await Promise.all(
					files.map(async (file) => {
						try {
							const info = await stat(join(dir, file));
							return info.isFile() ? { path: join(dir, file), modified: info.mtimeMs } : undefined;
						} catch {
							return undefined;
						}
					}),
				);
				return dated.filter((entry) => entry !== undefined).sort((a, b) => b.modified - a.modified)[0];
			} catch {
				return undefined;
			}
		}),
	);
	const excluded = exclude ? resolve(exclude) : undefined;
	const seen = new Set<string>();
	const found: string[] = [];
	for (const session of newest.filter((entry) => entry !== undefined).sort((a, b) => b.modified - a.modified)) {
		if (found.length >= limit) break;
		let cwd: unknown;
		try {
			const line = await firstLine(session.path);
			const header = line ? JSON.parse(line) : undefined;
			cwd = header?.type === "session" ? header.cwd : undefined;
		} catch {
			continue;
		}
		if (typeof cwd !== "string" || cwd.length === 0) continue;
		const folder = resolve(cwd);
		if (folder === excluded || seen.has(folder) || isThrowaway(folder)) continue;
		seen.add(folder);
		if (await isDirectory(folder)) found.push(folder);
	}
	return found;
}

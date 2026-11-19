/**
 * fork: locks that name a process.
 *
 * A pid alone is reused by the system, so a process is named by its pid and its start time (field 22 of
 * `/proc/<pid>/stat`, Linux). A lock file is written whole, then linked into place: no other process ever reads it
 * empty. A stale lock is taken out of the way by a rename, which only one process can win, and is put back when it
 * turns out to be another process's fresh lock; never "check, then delete".
 */
import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** A process: its pid, and its start time when the system tells it (Linux). */
export interface ProcessStamp {
	pid: number;
	start?: string;
}

/** This process's stamp, or another's; undefined for a process that is not running. */
export function processStamp(pid = process.pid): ProcessStamp | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The program name, field 2, is in parentheses and may hold spaces: count from the last one (field 3 next).
		const start = stat
			.slice(stat.lastIndexOf(")") + 2)
			.split(" ")
			.at(22 - 3);
		return { pid, ...(start ? { start } : {}) };
	} catch {
		if (process.platform === "linux") return undefined;
		try {
			process.kill(pid, 0);
			return { pid };
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM" ? { pid } : undefined;
		}
	}
}

/** Whether the process a stamp names is still the one running under its pid. */
export function stampAlive(stamp: unknown): boolean {
	if (typeof stamp !== "object" || stamp === null) return false;
	const { pid, start } = stamp as { pid?: unknown; start?: unknown };
	if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
	const now = processStamp(pid as number);
	if (!now) return false;
	return typeof start !== "string" || now.start === undefined || now.start === start;
}

/** The stamp a lock file holds: `{pid, start}`, or a bare pid (written before this module). */
function stampIn(content: string): ProcessStamp | undefined {
	try {
		const parsed = JSON.parse(content) as unknown;
		if (typeof parsed === "number") return { pid: parsed };
		return parsed as ProcessStamp;
	} catch {
		return undefined;
	}
}

const unique = () => `${process.pid}.${randomBytes(6).toString("hex")}`;

/**
 * Removes `file` only if it still holds `content`. The rename moves aside whatever is under the name now; if that is
 * not the content judged stale, it is put back (unless a third process took the name meanwhile) and false returned.
 */
export function removeIfStill(file: string, content: string): boolean {
	const aside = `${file}.${unique()}.old`;
	try {
		renameSync(file, aside);
	} catch {
		return false;
	}
	let moved: string | undefined;
	try {
		moved = readFileSync(aside, "utf8");
	} catch {}
	if (moved !== content) {
		try {
			linkSync(aside, file);
		} catch {}
	}
	try {
		unlinkSync(aside);
	} catch {}
	return moved === content;
}

/**
 * Takes `file` for this process. Returns its release (which removes the file only while it is still this process's),
 * or undefined when a running process holds it. A lock whose process is gone is taken over.
 */
export function takeProcessLock(file: string): (() => void) | undefined {
	const content = JSON.stringify(processStamp() ?? { pid: process.pid });
	for (let attempt = 0; attempt < 3; attempt++) {
		const temporary = `${file}.${unique()}.new`;
		writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		try {
			linkSync(temporary, file);
			return () => void removeIfStill(file, content);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally {
			unlinkSync(temporary);
		}
		let held: string;
		try {
			held = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (stampAlive(stampIn(held))) return undefined;
		if (!removeIfStill(file, held)) return undefined;
	}
	return undefined;
}

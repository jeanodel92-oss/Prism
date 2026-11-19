/**
 * fork: the children Prism starts, held. Each runs in its own process group,
 * may have a time limit, and is stopped with SIGTERM to the whole group, then SIGKILL to it after a grace. Its end is
 * the group seen empty (`process.kill(-pgid, 0)` fails with ESRCH), not the first process's exit: a descendant left in
 * the group keeps it running. A descendant that leaves the group (`setsid`) is out of reach, as without a cgroup.
 *
 * Absorbs the line splitting and stderr tail of the former `child-output.ts`.
 */
import {
	type ChildProcess,
	type ChildProcessByStdio,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type StdioPipe,
	spawn,
} from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";

/** Maximum size of one child JSON line; assistant events can carry large content. */
export const MAX_CHILD_LINE_BYTES = 32 * 1024 * 1024;
/** Keep only recent diagnostics from a child process. */
export const MAX_CHILD_STDERR_BYTES = 64 * 1024;
/** Between SIGTERM and SIGKILL to a group. */
export const CHILD_KILL_GRACE_MS = 3000;
/** After SIGKILL, how long a stop waits to see the group empty before it reports the stop unconfirmed. */
export const KILL_CONFIRM_MS = 5000;
/** How often a stopping group is checked; a group left running after its first process closed, less often. */
const STOP_POLL_MS = 50;
const IDLE_POLL_MAX_MS = 1000;

/**
 * Splits a child's decoded stdout into lines. Each chunk is scanned once: rescanning the
 * unfinished line on every chunk took 1.2 s for a 16 MiB line.
 */
export class ChildLines {
	private parts: string[] = [];
	private bytes = 0;

	/** Lines completed by `chunk`, and whether one of them or the unfinished line passed the limit. */
	push(chunk: string): { lines: string[]; overflow: boolean } {
		const pieces = chunk.split("\n");
		const last = pieces.pop() ?? "";
		const lines: string[] = [];
		let overflow = false;
		for (const piece of pieces) {
			if (this.bytes + Buffer.byteLength(piece) > MAX_CHILD_LINE_BYTES) overflow = true;
			lines.push(this.parts.length > 0 ? this.parts.join("") + piece : piece);
			this.parts = [];
			this.bytes = 0;
		}
		if (last) {
			this.parts.push(last);
			this.bytes += Buffer.byteLength(last);
		}
		return { lines, overflow: overflow || this.bytes > MAX_CHILD_LINE_BYTES };
	}

	/** The unfinished last line. */
	rest(): string {
		return this.parts.join("");
	}
}

export function appendStderrTail(previous: Buffer, chunk: Buffer): Buffer {
	return Buffer.concat([previous, chunk]).subarray(-MAX_CHILD_STDERR_BYTES);
}

/** How a group's end was established. */
export type GroupEnd = {
	/** Every process of the group was seen gone; false when some still ran after SIGKILL and its wait. */
	confirmed: boolean;
};

/** Whether a process group still has a process. EPERM: it does, one Prism may not signal. */
export function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// Gone already, or not Prism's to signal: the checks that follow tell.
	}
}

/**
 * The process groups of `pid` and its descendants, other than Prism's own group, read from `/proc` (Linux; none
 * elsewhere). They include groups whose processes Prism may not signal (root's, under sudo), which `groupAlive` sees.
 */
export function descendantGroups(pid: number): number[] {
	if (process.platform !== "linux") return [];
	const children = new Map<number, number[]>();
	const groupOf = new Map<number, number>();
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			// After the command name, which may hold spaces and parentheses: state, ppid, pgrp.
			const [, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const id = Number(entry);
			groupOf.set(id, Number(pgrp));
			const siblings = children.get(Number(ppid));
			if (siblings) siblings.push(id);
			else children.set(Number(ppid), [id]);
		} catch {
			// Ended while listed.
		}
	}
	const own = groupOf.get(process.pid);
	const groups = new Set<number>();
	const queue = [pid];
	for (let index = 0; index < queue.length; index++) {
		const id = queue[index] as number;
		const group = groupOf.get(id);
		if (group !== undefined && group !== own) groups.add(group);
		queue.push(...(children.get(id) ?? []));
	}
	return [...groups];
}

/** A group being stopped: one per group, so a second stop waits for the first. */
const stopping = new Map<number, Promise<GroupEnd>>();

/**
 * Stops process group `pgid`: SIGTERM, then SIGKILL after `graceMs` unless the group was seen empty by then, and
 * resolves once it is seen empty. Once seen empty it is never signalled again (its number may then be another group's)
 * . Unconfirmed when processes remain `KILL_CONFIRM_MS` after SIGKILL (stuck in the kernel, or not Prism's).
 */
export function stopProcessGroup(pgid: number, graceMs = CHILD_KILL_GRACE_MS): Promise<GroupEnd> {
	const current = stopping.get(pgid);
	if (current) return current;
	const done = new Promise<GroupEnd>((resolve) => {
		const startedAt = Date.now();
		let killedAt: number | undefined;
		signalGroup(pgid, "SIGTERM");
		const check = () => {
			if (!groupAlive(pgid)) return resolve({ confirmed: true });
			const now = Date.now();
			if (killedAt === undefined && now - startedAt >= graceMs) {
				killedAt = now;
				signalGroup(pgid, "SIGKILL");
			}
			if (killedAt !== undefined && now - killedAt >= KILL_CONFIRM_MS) return resolve({ confirmed: false });
			setTimeout(check, STOP_POLL_MS).unref();
		};
		check();
	});
	stopping.set(pgid, done);
	void done.then(() => stopping.delete(pgid));
	return done;
}

export type LaunchOptions = Omit<SpawnOptions, "detached"> & {
	/** Stopped after this many milliseconds; none by default. */
	timeoutMs?: number;
	/** Between SIGTERM and SIGKILL. */
	graceMs?: number;
	/** Stopped when aborted. */
	signal?: AbortSignal;
	/** It outlives Prism (a background task); otherwise its group is killed when Prism exits, until seen empty. */
	outlivesPrism?: boolean;
};

export type Launched<C extends ChildProcess = ChildProcess> = {
	readonly child: C;
	/** Its process group: its pid. Undefined when the spawn failed. */
	readonly pgid: number | undefined;
	/** A stop was asked, by the caller, the signal or the time limit. */
	readonly stopping: boolean;
	/** The time limit stopped it. */
	readonly timedOut: boolean;
	/** Stops its group (see `stopProcessGroup`); resolves when the group is seen empty. Idempotent. */
	stop(): Promise<GroupEnd>;
	/** The child closed (exit and end of its output) and its group was seen empty, or a stop was unconfirmed. */
	readonly ended: Promise<GroupEnd>;
};

/** Starts `command` in its own process group, held as this module describes. */
export function launch(
	command: string,
	args: readonly string[],
	options: LaunchOptions & SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
): Launched<ChildProcessByStdio<Writable, Readable, Readable>>;
export function launch(command: string, args: readonly string[], options?: LaunchOptions): Launched;
export function launch(command: string, args: readonly string[], options: LaunchOptions = {}): Launched {
	const { timeoutMs, graceMs = CHILD_KILL_GRACE_MS, signal, outlivesPrism, ...spawnOptions } = options;
	// Windows has no process groups to signal: the child alone is stopped there, as before.
	const windows = process.platform === "win32";
	const child = spawn(command, args, { ...spawnOptions, detached: !windows });
	const pgid = windows ? undefined : child.pid;
	// Out of Prism's group, it no longer receives the terminal's signals: Prism's exit kills it instead.
	if (pgid !== undefined && !outlivesPrism) trackDetachedChildPid(pgid);
	let stopRequest: Promise<GroupEnd> | undefined;
	let timedOut = false;
	let closed = false;
	let over = false;
	let resolveEnded: (end: GroupEnd) => void = () => {};
	const ended = new Promise<GroupEnd>((resolve) => {
		resolveEnded = resolve;
	});
	const stop = (): Promise<GroupEnd> => {
		if (windows && !over && !stopRequest) {
			child.kill();
			stopRequest = ended;
		}
		// A group seen empty is never signalled again: its number may be another group's by now.
		if (pgid === undefined || over) return ended;
		stopRequest ??= stopProcessGroup(pgid, graceMs);
		return stopRequest;
	};
	const abort = () => void stop();
	const limit =
		timeoutMs !== undefined && timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					void stop();
				}, timeoutMs)
			: undefined;
	limit?.unref();
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const finish = (end: GroupEnd) => {
		over = true;
		if (pgid !== undefined && !outlivesPrism) untrackDetachedChildPid(pgid);
		if (limit) clearTimeout(limit);
		signal?.removeEventListener("abort", abort);
		resolveEnded(end);
	};
	// After its first process closed, the group is watched until empty: from the stop when there is one, else
	// polled less and less often.
	const watch = (delay: number) => {
		if (stopRequest) {
			void stopRequest.then(finish);
			return;
		}
		if (pgid === undefined || !groupAlive(pgid)) return finish({ confirmed: true });
		setTimeout(() => watch(Math.min(delay * 2, IDLE_POLL_MAX_MS)), delay).unref();
	};
	child.once("close", () => {
		closed = true;
		watch(STOP_POLL_MS);
	});
	child.once("error", () => {
		if (child.pid === undefined && !closed) {
			closed = true;
			finish({ confirmed: true });
		}
	});
	return {
		child,
		pgid,
		get stopping() {
			return stopRequest !== undefined;
		},
		get timedOut() {
			return timedOut;
		},
		stop,
		ended,
	};
}

/**
 * a session without a
 * network namespace of its own (no sandbox, or none available) runs its background tasks on the machine's loopback.
 * The browser tool opens `localhost:<port>` of such a task directly, without a relay: this module says whether a
 * process of one of the session's running tasks listens on that port, and on which loopback addresses. Linux only:
 * the listening sockets come from /proc/net/tcp{,6}, their owners from /proc/<pid>/fd and /proc/<pid>/stat.
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

interface Listener {
	/** The address as a URL host: `127.0.0.1`, `[::1]`, `0.0.0.0`, `[::]`. */
	host: string;
	inode: string;
}

/** A process tree is walked up this far at most, looking for a task. */
const MAX_DEPTH = 64;

/** Reads a /proc/net/tcp{,6} address (`0100007F:0D96`, little-endian words) as a URL host and a port. */
function parseAddress(text: string): { host: string; port: number } | undefined {
	const [hex = "", portHex = ""] = text.split(":");
	const port = Number.parseInt(portHex, 16);
	if (!Number.isInteger(port)) return undefined;
	const bytes: number[] = [];
	for (let word = 0; word < hex.length; word += 8)
		for (let byte = 6; byte >= 0; byte -= 2) bytes.push(Number.parseInt(hex.slice(word + byte, word + byte + 2), 16));
	if (bytes.length === 4) return { host: bytes.join("."), port };
	if (bytes.length !== 16 || bytes.some(Number.isNaN)) return undefined;
	// An IPv4 address mapped in IPv6 (::ffff:a.b.c.d).
	if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff)
		return { host: bytes.slice(12).join("."), port };
	if (bytes.every((b) => b === 0)) return { host: "[::]", port };
	if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return { host: "[::1]", port };
	return { host: "[other]", port };
}

/** The sockets listening on `port` that this machine's loopback reaches (any address or a loopback one). */
function loopbackListeners(port: number, proc: string): Listener[] {
	const found: Listener[] = [];
	for (const file of ["tcp", "tcp6"]) {
		let text: string;
		try {
			text = readFileSync(`${proc}/net/${file}`, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			// sl local_address rem_address st … inode: 0A is LISTEN.
			if (fields.length < 10 || fields[3] !== "0A") continue;
			const local = parseAddress(fields[1]!);
			if (!local || local.port !== port) continue;
			const reached =
				local.host === "0.0.0.0" ||
				local.host.startsWith("127.") ||
				local.host === "[::1]" ||
				local.host === "[::]";
			if (reached && fields[9] !== "0") found.push({ host: local.host, inode: fields[9]! });
		}
	}
	return found;
}

/** Every process's parent and group, from /proc/<pid>/stat. */
function processTable(proc: string): Map<number, { ppid: number; pgrp: number }> {
	const table = new Map<number, { ppid: number; pgrp: number }>();
	let names: string[];
	try {
		names = readdirSync(proc);
	} catch {
		return table;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		let stat: string;
		try {
			stat = readFileSync(`${proc}/${name}/stat`, "utf8");
		} catch {
			continue;
		}
		// After the command name, which may hold spaces and parentheses: state ppid pgrp …
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		table.set(Number(name), { ppid: Number(fields[1]), pgrp: Number(fields[2]) });
	}
	return table;
}

/** Whether `pid` belongs to one of `tasks`: in a task's process group, or a descendant of a task. */
function ofTask(pid: number, tasks: ReadonlySet<number>, table: Map<number, { ppid: number; pgrp: number }>): boolean {
	let current: number | undefined = pid;
	for (let depth = 0; current !== undefined && current > 1 && depth < MAX_DEPTH; depth++) {
		if (tasks.has(current)) return true;
		const entry = table.get(current);
		if (!entry) return false;
		if (tasks.has(entry.pgrp)) return true;
		current = entry.ppid;
	}
	return false;
}

/** What listens on a port of this machine's loopback, as far as the session's tasks are concerned. */
export interface TaskPort {
	/** The URL hosts at which a task's server answers on that port, 127.0.0.1 first. */
	hosts: string[];
	/** Whether something else listens there too, so that `localhost` could reach it instead. */
	shared: boolean;
}

/**
 * Where a process of one of the running tasks `tasks` (their process ids, each its process group's leader) listens on
 * `port` of this machine's loopback; undefined when none does. Cheap when nothing listens on the port: the process
 * table is read only when a socket listens there.
 */
export function taskPort(port: number, tasks: readonly number[], proc = "/proc"): TaskPort | undefined {
	if (tasks.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
	const listeners = loopbackListeners(port, proc);
	if (listeners.length === 0) return undefined;
	const inodes = new Set(listeners.map((listener) => listener.inode));
	const roots = new Set(tasks);
	const table = processTable(proc);
	const owned = new Set<string>();
	for (const pid of table.keys()) {
		if (!ofTask(pid, roots, table)) continue;
		let fds: string[];
		try {
			fds = readdirSync(`${proc}/${pid}/fd`);
		} catch {
			continue;
		}
		for (const fd of fds) {
			let target: string;
			try {
				target = readlinkSync(`${proc}/${pid}/fd/${fd}`);
			} catch {
				continue;
			}
			const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
			if (inode && inodes.has(inode)) owned.add(inode);
		}
	}
	const mine = listeners.filter((listener) => owned.has(listener.inode));
	if (mine.length === 0) return undefined;
	const hosts = new Set<string>();
	for (const { host } of mine) {
		if (host === "0.0.0.0") hosts.add("127.0.0.1");
		else if (host === "[::]") hosts.add("[::1]");
		else hosts.add(host);
	}
	const ordered = [...hosts].sort((a, b) => rank(a) - rank(b));
	return { hosts: ordered, shared: mine.length < listeners.length };
}

const rank = (host: string) => (host === "127.0.0.1" ? 0 : host.startsWith("127.") ? 1 : 2);

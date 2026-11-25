/**
 * a server a command or a background task of
 * the session started (`npm run dev`) listens on the session's own loopback (`session-net.ts`), which the user's
 * browser cannot reach. When the browser tool opens `localhost:<port>`, Prism relays that port to the machine's
 * loopback: a helper in the session's namespace (`port-bridge.ts`) serves it on a Unix socket, and Prism listens on
 * 127.0.0.1, on the same port when it is free so that the page's absolute links keep working. Only ports a server
 * of the session already listens on are relayed, only while it answers and while the session lasts.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getPackageDir } from "../../config.ts";
import { realPath } from "../real-path.ts";
import { sessionNetPrefix } from "./session-net.ts";

interface Bridge {
	hostPort: number;
	server: Server;
	child: ChildProcess;
	dir: string;
}

/** Ports relayed at once per session: each holds a Node helper. */
export const MAX_SESSION_PORTS = 8;
/** How often the helper checks that its server still answers; it ends after two checks without an answer. */
export const RELAY_PROBE_MS = 3_000;

/** By session (its private /tmp, as `session-net.ts` names it), then by the session's port. */
const bridges = new Map<string, Map<number, Bridge>>();
const pending = new Map<string, Promise<number | undefined>>();
/** Relays being opened, by session: they count against MAX_SESSION_PORTS before they are in `bridges`. */
const opening = new Map<string, number>();

function bridgePath(): string {
	const packageDir = getPackageDir();
	return existsSync(join(packageDir, "src"))
		? join(packageDir, "src", "fork", "sandbox", "port-bridge.ts")
		: join(packageDir, "dist", "fork", "sandbox", "port-bridge.js");
}

function pipeBoth(a: Socket, b: Socket): void {
	a.pipe(b).pipe(a);
	a.once("error", () => b.destroy());
	b.once("error", () => a.destroy());
	a.once("close", () => b.destroy());
	b.once("close", () => a.destroy());
}

function listen(server: Server, port: number): Promise<number | undefined> {
	return new Promise((resolve) => {
		const failed = () => resolve(undefined);
		server.once("error", failed);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", failed);
			const address = server.address();
			resolve(typeof address === "object" && address ? address.port : undefined);
		});
	});
}

function drop(session: string, port: number, bridge: Bridge): void {
	if (bridges.get(session)?.get(port) === bridge) bridges.get(session)?.delete(port);
	bridge.server.close();
	bridge.child.kill();
	rmSync(bridge.dir, { recursive: true, force: true });
}

/** Starts the helper; resolves once it serves the port, undefined when no server of the session listens there. */
function startHelper(session: string, port: number, socket: string): Promise<ChildProcess | undefined> {
	const prefix = sessionNetPrefix(session);
	if (prefix.length === 0) return Promise.resolve(undefined);
	const child = spawn(
		prefix[0]!,
		[...prefix.slice(1), realPath(process.execPath), bridgePath(), socket, String(port), String(RELAY_PROBE_MS)],
		{
			stdio: ["pipe", "pipe", "ignore"],
		},
	);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill();
			resolve(undefined);
		}, 10_000);
		const done = (value: ChildProcess | undefined) => {
			clearTimeout(timer);
			resolve(value);
		};
		child.once("error", () => done(undefined));
		child.once("exit", () => done(undefined));
		createInterface({ input: child.stdout! }).once("line", (line) => {
			if (line === "ready") done(child);
			else {
				child.kill();
				done(undefined);
			}
		});
	});
}

async function open(session: string, port: number): Promise<number | undefined> {
	const known = bridges.get(session)?.get(port);
	if (known && known.child.exitCode === null) return known.hostPort;
	if (known) drop(session, port, known);
	// In the shared map before the first await: two ports opened at once land in the same map and the same count.
	let relayed = bridges.get(session);
	if (!relayed) {
		relayed = new Map<number, Bridge>();
		bridges.set(session, relayed);
	}
	const starting = opening.get(session) ?? 0;
	if (relayed.size + starting >= MAX_SESSION_PORTS) return undefined;
	opening.set(session, starting + 1);
	const dir = mkdtempSync(join(tmpdir(), "prism-port-"));
	const socket = join(dir, "s");
	let child: ChildProcess | undefined;
	let server: Server | undefined;
	let hostPort: number | undefined;
	try {
		child = await startHelper(session, port, socket);
		if (child) {
			server = createServer((connection) => pipeBoth(connection, connect(socket)));
			hostPort = (await listen(server, port)) ?? (await listen(server, 0));
		}
	} finally {
		const left = (opening.get(session) ?? 1) - 1;
		if (left > 0) opening.set(session, left);
		else opening.delete(session);
	}
	// Not served, or the session ended meanwhile (closeSessionPorts dropped its map).
	if (!child || !server || hostPort === undefined || bridges.get(session) !== relayed) {
		server?.close();
		child?.kill();
		rmSync(dir, { recursive: true, force: true });
		return undefined;
	}
	const bridge: Bridge = { hostPort, server, child, dir };
	relayed.set(port, bridge);
	// Neither keeps Prism running: the helper ends when Prism closes its stdin.
	server.unref();
	child.unref();
	for (const stream of [child.stdin, child.stdout]) (stream as { unref?: () => void } | null)?.unref?.();
	// The helper ends when its server stops answering, with its namespace's last holder or a crash: the relay goes
	// with it, and its slot is free again.
	child.once("exit", () => drop(session, port, bridge));
	return hostPort;
}

/**
 * The machine's port that shows the session's `port` to the user's browser, relayed on first use; undefined when no
 * server of the session listens there, when the session has no network of its own, or past MAX_SESSION_PORTS.
 */
export function sessionPort(session: string, port: number): Promise<number | undefined> {
	const key = `${session}\0${port}`;
	const known = pending.get(key);
	if (known) return known;
	const opening = open(session, port).finally(() => pending.delete(key));
	pending.set(key, opening);
	return opening;
}

/** Whether `port` of the machine relays a session's port (a page the browser tool may follow there). */
export function relaysTo(session: string, hostPort: number): boolean {
	for (const bridge of bridges.get(session)?.values() ?? []) if (bridge.hostPort === hostPort) return true;
	return false;
}

/** Closes the session's relays, when the session ends. */
export function closeSessionPorts(session: string): void {
	for (const [port, bridge] of [...(bridges.get(session) ?? [])]) drop(session, port, bridge);
	bridges.delete(session);
}

/**
 * fork: runs inside the sandbox, in front of the command. It listens on 127.0.0.1, points
 * the proxy variables at itself, runs the command and forwards each connection to Prism's proxy over
 * the pipes on fds 4 (from Prism) and 5 (to Prism). A program that ignores the proxy variables has no
 * network. Usage: node relay.ts <alias> <ports> <command> [args...]
 *
 * fork: <ports> lists the ports of the machine the user allowed (`5432,3000`, or
 * `-`). The relay listens on each one and passes its connections to that port of the machine, so programs that
 * ignore the proxy reach it too. No other port of the machine is reachable.
 *
 * fork: it listens on <alias>, the address `host.prism.internal` names for this
 * command (its /etc/hosts), never on 127.0.0.1 or ::1: `localhost` is the sandbox's own, which the session's
 * commands share (`session-net.ts`), so a server the agent starts there is reachable and never meets the relay. A
 * port allowed while the command runs opens at once (the PRISM-PORTS stream); one taken back closes. Each listener
 * serves only the processes of this command, found by their socket in /proc: another command of the session shares
 * the loopback, not this command's permissions.
 *
 * fork: Git's SSH command is git-ssh-client.ts, next to this file, which passes Git over SSH
 * to Prism through the proxy. An `ssh` the command runs itself still has no network.
 *
 * fork: Git's signing programs are git-sign-client.ts, through a wrapper written in the command's
 * own temporary folder (Git runs them without a shell), which passes signing to Prism.
 *
 * fork: the Docker API, for `docker` and `podman --remote`, on a port of the sandbox's loopback
 * (`DOCKER_HOST`, `CONTAINER_HOST`); Prism answers it from the user's containers, read only (containers.ts). And
 * the system bus (`DBUS_SYSTEM_BUS_ADDRESS`), which Prism filters to reading the state of services (dbus.ts).
 */

import { spawn } from "node:child_process";
import {
	closeSync,
	constants,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server, Socket } from "node:net";
import { constants as osConstants } from "node:os";
import { dirname, extname, join } from "node:path";
import type { Duplex } from "node:stream";
import { Mux } from "./mux.ts";
import { shellQuote } from "./shell-quote.ts";

const [alias = "127.0.0.1", portList = "-", ...command] = process.argv.slice(2);
const ports = portList === "-" ? [] : portList.split(",").map(Number);

/** `a.b.c.d:port` as /proc/net/tcp writes it: the address in host byte order, both in hex. */
const procAddress = (address: string, port: number) =>
	`${address
		.split(".")
		.reverse()
		.map((part) => Number(part).toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase()}:${port.toString(16).padStart(4, "0").toUpperCase()}`;

/**
 * Whether the peer of an accepted connection is a process of this command: its socket is open in a process this
 * relay sees, in the command's own process namespace. Every listener here is IPv4; a client's IPv6 socket
 * reaches it by an IPv4-mapped address, which /proc/net/tcp6 lists.
 */
function ownPeer(client: Socket): boolean {
	const { remoteAddress, remotePort, localAddress, localPort } = client;
	if (!remoteAddress || !remotePort || !localAddress || !localPort) return false;
	const from = procAddress(remoteAddress.replace(/^::ffff:/, ""), remotePort);
	const to = procAddress(localAddress.replace(/^::ffff:/, ""), localPort);
	const mapped = "0000000000000000FFFF0000";
	let inode: string | undefined;
	for (const [table, prefix] of [
		["/proc/net/tcp", ""],
		["/proc/net/tcp6", mapped],
	] as const) {
		let lines: string[] = [];
		try {
			lines = readFileSync(table, "utf8").split("\n").slice(1);
		} catch {}
		for (const line of lines) {
			const fields = line.trim().split(/\s+/);
			if (fields[1] === prefix + from && fields[2] === prefix + to) inode = fields[9];
		}
		if (inode) break;
	}
	if (!inode || inode === "0") return false;
	const wanted = `socket:[${inode}]`;
	for (const pid of readdirSync("/proc")) {
		if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		for (const fd of fds) {
			try {
				if (readlinkSync(`/proc/${pid}/fd/${fd}`) === wanted) return true;
			} catch {}
		}
	}
	return false;
}

/** A listener's handler that first drops connections from other commands' processes. */
const guarded = (serve: (client: Socket) => void) => (client: Socket) => {
	let own = false;
	try {
		own = ownPeer(client);
	} catch {}
	if (own) serve(client);
	else client.destroy();
};
/**
 * the processes a command leaves running (`cmd &`, nohup) end with the sandbox when
 * it ends. Say which, on stderr, so the model does not believe them still running.
 */
function reportLeftRunning(): void {
	const stat = (pid: string) => {
		try {
			const text = readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
			return { state: fields[0], parent: fields[1] };
		} catch {
			return undefined;
		}
	};
	// This relay and bubblewrap above it are the sandbox, not the command's processes.
	const sandbox = new Set<string>();
	for (let pid = String(process.pid); pid !== "0" && !sandbox.has(pid); pid = stat(pid)?.parent ?? "0")
		sandbox.add(pid);
	const left: string[] = [];
	for (const pid of readdirSync("/proc")) {
		if (!/^\d+$/.test(pid) || sandbox.has(pid)) continue;
		const state = stat(pid)?.state;
		if (!state || state === "Z" || state === "X") continue;
		let command = "";
		try {
			command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
		} catch {}
		left.push(`${pid} ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`);
	}
	if (!left.length) return;
	const shown = left.slice(0, 5).join(", ") + (left.length > 5 ? `, and ${left.length - 5} more` : "");
	process.stderr.write(
		`\nPrism sandbox: stopped ${left.length} process(es) this command left running, as processes end with their command: ${shown}\n`,
	);
}

process.on("uncaughtException", (error) => {
	process.stderr.write(`prism sandbox relay: ${error.message}\n`);
	process.exit(125);
});

// Reopened so the command does not inherit the pipes: Node opens files close-on-exec.
const pipe = (fd: number, flags: number) => {
	const own = openSync(`/proc/self/fd/${fd}`, flags | constants.O_NONBLOCK);
	closeSync(fd);
	return own;
};
const input = new Socket({ fd: pipe(4, constants.O_RDONLY), readable: true, writable: false });
const output = new Socket({ fd: pipe(5, constants.O_WRONLY), readable: false, writable: true });
const mux = new Mux(input, output);

/**
 * Each side goes down with the other: an error on one, or one closing before it ended both ways, destroys the other.
 * A side that ended cleanly leaves the other to finish its answer.
 */
function tie(client: Socket, upstream: Duplex): void {
	client.on("error", () => upstream.destroy());
	upstream.on("error", () => client.destroy());
	client.on("close", () => {
		if (!client.readableEnded || !client.writableFinished) upstream.destroy();
	});
	upstream.on("close", () => {
		if (!upstream.readableEnded || !upstream.writableFinished) client.destroy();
	});
}

// fork: either peer may finish sending before the other finishes its response.
const server = createServer(
	{ allowHalfOpen: true },
	guarded((client) => {
		const upstream = mux.open();
		tie(client, upstream);
		client.pipe(upstream).pipe(client);
	}),
);

/** Passes a connection to an allowed port of the machine through Prism's proxy, as a CONNECT tunnel. */
const forward = (port: number) => (client: Socket) => {
	const upstream = mux.open();
	tie(client, upstream);
	let head: Buffer = Buffer.alloc(0);
	const onData = (chunk: Buffer) => {
		head = Buffer.concat([head, chunk]);
		const end = head.indexOf("\r\n\r\n");
		if (end < 0) return;
		upstream.off("data", onData);
		// Refused (the port was taken back) or unreachable: the program sees the connection close.
		if (!head.subarray(0, end).toString("latin1").startsWith("HTTP/1.1 200 ")) {
			client.destroy();
			upstream.destroy();
			return;
		}
		if (end + 4 < head.length) client.write(head.subarray(end + 4));
		client.pipe(upstream).pipe(client);
	};
	upstream.on("data", onData);
	// By the machine's explicit name: the proxy refuses `localhost`, the sandbox's own.
	upstream.write(`CONNECT host.prism.internal:${port} HTTP/1.1\r\n\r\n`);
};

/** The listeners of this machine's ports, by port. */
const forwarders = new Map<number, Server>();

/**
 * Listens on `port` at the alias. Skipped: a port below 1024, which the command, without privileges in the sandbox,
 * cannot be served on (the result note says so).
 */
const listen = (port: number) =>
	new Promise<void>((resolve) => {
		if (forwarders.has(port)) return resolve();
		const forwarder = createServer({ allowHalfOpen: true }, guarded(forward(port)));
		forwarders.set(port, forwarder);
		forwarder.once("error", (error: NodeJS.ErrnoException) => {
			forwarders.delete(port);
			if (!(port < 1024 && error.code === "EACCES")) {
				process.stderr.write(`prism sandbox relay: cannot serve port ${port} of the machine: ${error.message}\n`);
			}
			resolve();
		});
		forwarder.listen(port, alias, () => resolve());
	});

// The ports allowed at the start, before the command runs.
const forwarding = Promise.all(ports.map(listen));

// fork (SEC-07): then each change, from Prism (proxy.ts, PORTS_METHOD); open connections of a port taken back are
// closed by Prism itself.
const portChanges = mux.open();
portChanges.on("error", () => {});
let pending = "";
portChanges.on("data", (chunk: Buffer) => {
	pending += chunk.toString("latin1");
	for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
		const line = pending.slice(0, end);
		pending = pending.slice(end + 1);
		const now = line === "-" ? [] : line.split(",").map(Number);
		for (const [port, forwarder] of forwarders) {
			if (now.includes(port)) continue;
			forwarders.delete(port);
			forwarder.close();
		}
		for (const port of now) void listen(port);
	}
});
portChanges.write("PRISM-PORTS / HTTP/1.1\r\n\r\n");

/** A port whose connections Prism serves itself, by `method`: the container API, the system bus. */
const service = (method: string) =>
	new Promise<number>((resolve) => {
		const listener = createServer(
			{ allowHalfOpen: true },
			guarded((client) => {
				const upstream = mux.open();
				client.on("error", () => upstream.destroy());
				upstream.on("error", () => client.destroy());
				client.on("close", () => upstream.destroy());
				upstream.on("close", () => client.destroy());
				upstream.write(`${method} / HTTP/1.1\r\n\r\n`);
				client.pipe(upstream).pipe(client);
			}),
		);
		listener.listen(0, "127.0.0.1", () => {
			const address = listener.address();
			resolve(typeof address === "object" && address ? address.port : 0);
		});
	});

void Promise.all([forwarding, service("PRISM-CONTAINERS"), service("PRISM-DBUS")]).then(([, apiPort, busPort]) =>
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const proxyPort = typeof address === "object" && address ? address.port : 0;
		const proxy = `http://127.0.0.1:${proxyPort}`;
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
			env[name] = proxy;
			env[name.toLowerCase()] = proxy;
		}
		env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
		// Before the user's own core.sshCommand, which cannot reach the network here; the variant keeps Git's -p.
		const self = process.argv[1]!;
		const client = join(dirname(self), `git-ssh-client${extname(self)}`);
		env.GIT_SSH_COMMAND = [process.execPath, client, String(proxyPort)].map(shellQuote).join(" ");
		env.GIT_SSH_VARIANT = "ssh";
		// Command-line scope, above the user's files: Git signs through Prism, whatever program they configured.
		// The sandbox's own /tmp, the session's (layout.ts): a TMPDIR in the home folder may not be shown or writable here.
		const signing = mkdtempSync(join("/tmp", "prism-git-sign-"));
		const signer = join(signing, "sign");
		const signClient = join(dirname(self), `git-sign-client${extname(self)}`);
		writeFileSync(
			signer,
			`#!/bin/sh\nexec ${[process.execPath, signClient, String(proxyPort)].map(shellQuote).join(" ")} "$@"\n`,
			{
				mode: 0o755,
			},
		);
		const count = Number(env.GIT_CONFIG_COUNT ?? 0);
		let next = Number.isInteger(count) && count > 0 ? count : 0;
		for (const key of ["gpg.program", "gpg.openpgp.program", "gpg.ssh.program"]) {
			env[`GIT_CONFIG_KEY_${next}`] = key;
			env[`GIT_CONFIG_VALUE_${next++}`] = signer;
		}
		env.GIT_CONFIG_COUNT = String(next);
		env.DOCKER_HOST = env.CONTAINER_HOST = `tcp://127.0.0.1:${apiPort}`;
		env.DBUS_SYSTEM_BUS_ADDRESS = `tcp:host=127.0.0.1,port=${busPort}`;
		const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env });
		for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
		child.on("error", (error) => {
			process.stderr.write(`prism sandbox relay: ${error.message}\n`);
			process.exit(127);
		});
		child.on("exit", (code, signal) => {
			rmSync(signing, { recursive: true, force: true });
			reportLeftRunning();
			process.exit(code ?? 128 + (signal ? osConstants.signals[signal] : 0));
		});
	}),
);

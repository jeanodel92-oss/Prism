/**
 * runs in a session's network namespace,
 * outside bubblewrap, as Prism's own helper. It finds which loopback address a server of the session listens on for
 * <port>, then passes each connection of the Unix socket <socket> to it, so that Prism can show that server to the
 * user's browser, which lives on the machine's loopback. Prints `ready` or `closed` (no server on that port), and
 * ends when Prism closes its stdin, or when the server has not answered two checks <probe-ms> apart. Node built-ins
 * only. Usage: node port-bridge.ts <socket> <port> <probe-ms>
 */

import { connect, createServer, type Socket } from "node:net";

const [socketPath = "", portText = "", probeText = ""] = process.argv.slice(2);
const port = Number(portText);
const probeMs = Number(probeText) || 3_000;

function reachable(host: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connect({ host, port });
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => resolve(false));
	});
}

function pipeBoth(a: Socket, b: Socket): void {
	a.pipe(b).pipe(a);
	a.once("error", () => b.destroy());
	b.once("error", () => a.destroy());
	a.once("close", () => b.destroy());
	b.once("close", () => a.destroy());
}

// `localhost` resolves to either address depending on the server (Vite listens on ::1 on some systems).
const host = (await reachable("127.0.0.1")) ? "127.0.0.1" : (await reachable("::1")) ? "::1" : undefined;
if (!socketPath || !Number.isInteger(port) || host === undefined) {
	process.stdout.write("closed\n");
	process.exit(0);
}
const server = createServer((connection) => pipeBoth(connection, connect({ host, port })));
server.once("error", (error) => {
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
});
server.listen(socketPath, () => process.stdout.write("ready\n"));
// A server that stopped frees its relay (and Prism's slot for it); one missed check is allowed for a restart.
let missed = 0;
setInterval(async () => {
	missed = (await reachable(host)) ? 0 : missed + 1;
	if (missed >= 2) process.exit(0);
}, probeMs);
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();

// fork: answers initialize and starts a grandchild that ignores SIGTERM. "early": the server then
// exits while the grandchild holds its stdout and stderr; "eof": the server exits when stdin closes, the grandchild
// holding nothing; "setsid": as "early", the grandchild in its own session and group.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const mode = process.argv[2];
// The grandchild says on fd 3 once it ignores SIGTERM; the server announces it only then.
const grandchild = spawn(
	process.execPath,
	["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeSync(3, 'r'); setInterval(() => {}, 1000)"],
	{
		stdio: mode === "eof" ? ["ignore", "ignore", "ignore", "pipe"] : ["ignore", "inherit", "inherit", "pipe"],
		detached: mode === "setsid",
	},
);
const ready = new Promise((resolve) =>
	grandchild.stdio[3].once("data", () => {
		console.error(`grandchild ${grandchild.pid}`);
		grandchild.stdio[3].destroy();
		resolve();
	}),
);
grandchild.unref();

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method !== "initialize") return;
	const result = {
		protocolVersion: "2025-06-18",
		capabilities: {},
		serverInfo: { name: "quitting-fixture", version: "1.0.0" },
	};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`, () => {
		if (mode !== "eof") void ready.then(() => setTimeout(() => process.exit(0), 50));
	});
});
lines.on("close", () => process.exit(0));

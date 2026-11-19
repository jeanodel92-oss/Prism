/**
 * real clicks and keys in Firefox through WebDriver BiDi. `/browser firefox` restarts
 * Firefox with BiDi on a local port and records the port next to the hosts' sockets; the host that Firefox
 * starts for the extension reads it and holds the BiDi session. The sandbox proxy refuses this port to the
 * agent's commands (`isReservedBrowserPort`), since BiDi has no authentication.
 */
import { spawn, spawnSync } from "node:child_process";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { hostCommand } from "../host-program.ts";
import { processStamp, removeIfStill, stampAlive } from "../process-lock.ts";
import { writeFileAtomicSync } from "../secrets/atomic-write.ts";
import { browserSocketDir, ensurePrivateDir } from "./protocol.ts";

const PORT_FILE = "firefox-bidi.json";

/** Tests only: `/browser firefox` records the port with claimBidiPort. */
export function writeBidiPort(port: number, dir = browserSocketDir()): void {
	writeFileSync(join(dir, PORT_FILE), `${JSON.stringify({ port })}\n`, { mode: 0o600 });
}

export function readBidiPort(dir = browserSocketDir()): number | undefined {
	try {
		const port = (JSON.parse(readFileSync(join(dir, PORT_FILE), "utf8")) as { port?: unknown }).port;
		return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
	} catch {
		return undefined;
	}
}

/** A port of this machine that controls the user's browser: never opened to the agent's commands. */
export function isReservedBrowserPort(port: number | undefined, dir = browserSocketDir()): boolean {
	return port !== undefined && port === readBidiPort(dir);
}

interface Waiter {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** A minimal WebDriver BiDi client (commands only; events are ignored). */
export class BidiClient {
	private readonly socket: WebSocket;
	private readonly waiters = new Map<number, Waiter>();
	private sequence = 0;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.onmessage = (event) => {
			let message: { id?: number; type?: string; result?: unknown; error?: string; message?: string };
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (typeof message.id !== "number") return;
			const waiter = this.waiters.get(message.id);
			if (!waiter) return;
			this.waiters.delete(message.id);
			if (message.type === "error") waiter.reject(new Error(`${message.error}: ${message.message}`));
			else waiter.resolve(message.result);
		};
		socket.onclose = () => {
			for (const waiter of this.waiters.values()) waiter.reject(new Error("BiDi connection closed"));
			this.waiters.clear();
		};
	}

	static connect(port: number, timeoutMs = 3000): Promise<BidiClient> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error(`No BiDi answer on port ${port}`));
			}, timeoutMs);
			socket.onopen = () => {
				clearTimeout(timer);
				resolve(new BidiClient(socket));
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error(`No BiDi server on port ${port}`));
			};
		});
	}

	send(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				reject(new Error(`BiDi ${method} timed out`));
			}, timeoutMs);
			this.waiters.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close(): void {
		this.socket.close();
	}
}

/** Whether the user's Firefox runs: started again with the flag, it would only open a window in that instance. */
export function firefoxRunning(): boolean | undefined {
	const result = spawnSync(
		hostCommand("pgrep"),
		["-u", String(process.getuid?.() ?? ""), "-x", "firefox|firefox-bin"],
		{
			stdio: "ignore",
		},
	);
	if (result.error) return undefined;
	return result.status === 0;
}

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	if (!address || typeof address !== "object") throw new Error("No free local port");
	return address.port;
}

/**
 * fork: records `port` only if no running process holds the record, the Prism that is
 * starting Firefox or the Firefox it started: a second `/browser firefox` never replaces the port still listening.
 * Created whole (linked into place); a record whose process is gone is moved aside first.
 */
function claimBidiPort(port: number, dir: string): string {
	const file = join(dir, PORT_FILE);
	const content = `${JSON.stringify({ port, owner: processStamp() })}\n`;
	for (let attempt = 0; attempt < 3; attempt++) {
		const temporary = `${file}.${process.pid}.${port}.new`;
		writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		try {
			linkSync(temporary, file);
			return content;
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
		const record = (() => {
			try {
				return JSON.parse(held) as { port?: unknown; owner?: unknown };
			} catch {
				return {};
			}
		})();
		if (stampAlive(record.owner))
			throw new Error(`Firefox with remote control is already started on port ${String(record.port)}.`);
		removeIfStill(file, held);
	}
	throw new Error("Another Prism is starting Firefox with remote control.");
}

/** `/browser firefox`: starts the user's Firefox with BiDi on a free local port, recorded for the host. */
export async function launchFirefoxWithBidi(command = "firefox", dir = browserSocketDir()): Promise<number> {
	ensurePrivateDir(dir);
	// fork: checked again after the question; started now, it would only open a window
	// in the running Firefox, whose port is another.
	if (firefoxRunning()) throw new Error("Firefox runs already; close it first.");
	const port = await freePort();
	const claimed = claimBidiPort(port, dir);
	const file = join(dir, PORT_FILE);
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(hostCommand(command), [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore" });
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
	} catch (error) {
		removeIfStill(file, claimed);
		throw error;
	}
	child.unref();
	// From now on the record is Firefox's: kept while it runs, whatever this Prism does.
	const firefox = child.pid === undefined ? undefined : processStamp(child.pid);
	if (firefox) writeFileAtomicSync(file, `${JSON.stringify({ port, owner: firefox })}\n`);
	return port;
}

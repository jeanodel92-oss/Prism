/**
 * `prism browser-host`, the native messaging host the browser starts for the Prism
 * extension. It relays between the extension (stdin/stdout) and Prism sessions (a Unix socket in a
 * private folder), and ends when the browser closes its stdin.
 */
import { unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { BidiClient, readBidiPort } from "./bidi.ts";
import {
	type BrowserHostInfo,
	browserSocketDir,
	encodeNative,
	ensurePrivateDir,
	type HostReply,
	type HostRequest,
	LineReader,
	MAX_TO_EXTENSION,
	NativeReader,
} from "./protocol.ts";

/** How long a Prism hello waits for the extension's own hello. */
const HELLO_WAIT_MS = 3000;

export interface BrowserHostOptions {
	input: Readable;
	output: Writable;
	dir?: string;
	pid?: number;
	log?: (line: string) => void;
}

interface Pending {
	client: Socket;
	id: number;
}

/** Runs the host until the browser closes its input. Resolves with the socket path it served. */
export async function runBrowserHost(options: BrowserHostOptions): Promise<string> {
	const dir = options.dir ?? browserSocketDir();
	ensurePrivateDir(dir);
	const pid = options.pid ?? process.pid;
	const path = join(dir, `${pid}.sock`);
	const log = options.log ?? ((line: string) => process.stderr.write(`prism browser-host: ${line}\n`));
	let info: BrowserHostInfo | undefined;
	const helloWaiters: Array<() => void> = [];
	const pending = new Map<number, Pending>();
	const clients = new Set<Socket>();
	let sequence = 0;
	let bidi: BidiClient | undefined;
	let bidiStarting: Promise<void> | undefined;

	const reply = (client: Socket, message: HostReply | { event: string }) => {
		if (!client.destroyed) client.write(`${JSON.stringify(message)}\n`);
	};

	const toExtension = (message: unknown): boolean => {
		const frame = encodeNative(message);
		if (frame.length - 4 > MAX_TO_EXTENSION) return false;
		options.output.write(frame);
		return true;
	};

	const fromExtension = (message: unknown) => {
		if (!message || typeof message !== "object") return;
		const m = message as Record<string, unknown>;
		if (m.type === "hello") {
			info = {
				name: String(m.name ?? "browser"),
				version: String(m.version ?? ""),
				extension: String(m.extension ?? ""),
				build: String(m.build ?? ""),
				realInput: m.realInput === true,
				stopped: m.stopped === true,
				pid,
			};
			for (const wake of helloWaiters.splice(0)) wake();
			void ensureBidi(info);
			return;
		}
		if (m.type === "bidi" && typeof m.id === "number") {
			const id = m.id;
			if (!bidi) {
				toExtension({ type: "bidi-reply", id, ok: false, error: "No BiDi session" });
				return;
			}
			bidi.send(String(m.method), m.params ?? {}).then(
				(result) => toExtension({ type: "bidi-reply", id, ok: true, result }),
				(error: Error) => toExtension({ type: "bidi-reply", id, ok: false, error: error.message }),
			);
			return;
		}
		if (m.type === "event") {
			if (m.event === "stopped" && info) info.stopped = true;
			for (const client of clients) reply(client, { event: String(m.event) });
			return;
		}
		if (m.type === "reply" && typeof m.id === "number") {
			const target = pending.get(m.id);
			if (!target) return;
			pending.delete(m.id);
			if (m.ok === true && info && (m.result as { stopped?: unknown } | undefined)?.stopped === false) {
				info.stopped = false;
			}
			reply(target.client, {
				id: target.id,
				ok: m.ok === true,
				result: m.result,
				error: typeof m.error === "string" ? m.error : undefined,
				code: typeof m.code === "string" ? m.code : undefined,
			});
		}
	};

	/** F2: Firefox restarted by `/browser firefox` listens for BiDi on a recorded port; real input goes there. */
	const startBidi = async (current: BrowserHostInfo) => {
		const bidiPort = readBidiPort(dir);
		if (!bidiPort) return;
		try {
			const client = await BidiClient.connect(bidiPort);
			try {
				await client.send("session.new", { capabilities: {} });
			} catch (error) {
				client.close();
				throw error;
			}
			bidi = client;
			current.realInput = true;
			toExtension({ type: "bidi", available: true });
		} catch (error) {
			log(`no real input in Firefox: ${(error as Error).message}`);
		}
	};

	/** Firefox may still be starting its BiDi server when the extension says hello: each Prism hello retries. */
	const ensureBidi = (current: BrowserHostInfo): Promise<void> => {
		if (bidi || current.name !== "Firefox") return Promise.resolve();
		bidiStarting ??= startBidi(current).finally(() => {
			bidiStarting = undefined;
		});
		return bidiStarting;
	};

	const fromClient = async (client: Socket, request: HostRequest) => {
		if (typeof request.id !== "number" || typeof request.cmd !== "string") return;
		if (request.cmd === "hello") {
			if (!info) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, HELLO_WAIT_MS);
					helloWaiters.push(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			if (info) await ensureBidi(info);
			if (info) reply(client, { id: request.id, ok: true, result: info });
			else reply(client, { id: request.id, ok: false, error: "The extension has not said hello", code: "no_hello" });
			return;
		}
		const id = ++sequence;
		pending.set(id, { client, id: request.id });
		const sent = toExtension({ id, cmd: request.cmd, session: request.session ?? "", args: request.args ?? {} });
		if (!sent) {
			pending.delete(id);
			reply(client, { id: request.id, ok: false, error: "Request too large for the browser", code: "too_large" });
		}
	};

	try {
		unlinkSync(path);
	} catch {
		// No stale socket from an earlier host with the same pid.
	}
	const server: Server = createServer((client) => {
		clients.add(client);
		const lines = new LineReader();
		client.on("data", (chunk) => {
			for (const message of lines.push(chunk)) void fromClient(client, message as HostRequest);
		});
		const drop = () => {
			clients.delete(client);
			for (const [id, entry] of pending) if (entry.client === client) pending.delete(id);
		};
		client.on("close", drop);
		client.on("error", drop);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const reader = new NativeReader();
	await new Promise<void>((resolve) => {
		options.input.on("data", (chunk: Buffer) => {
			try {
				for (const message of reader.push(chunk)) fromExtension(message);
			} catch (error) {
				log(`bad message from the extension: ${(error as Error).message}`);
				resolve();
			}
		});
		options.input.on("end", resolve);
		options.input.on("close", resolve);
		options.input.on("error", resolve);
	});

	if (bidi) {
		await bidi.send("session.end", {}, 2000).catch(() => undefined);
		bidi.close();
	}
	for (const client of clients) client.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
	return path;
}

/** `prism browser-host [origin…]`: true when it handled the command. */
export async function runBrowserHostCommand(args: readonly string[]): Promise<boolean> {
	if (args[0] !== "browser-host") return false;
	try {
		await runBrowserHost({ input: process.stdin, output: process.stdout });
		process.exit(0);
	} catch (error) {
		process.stderr.write(`prism browser-host: ${(error as Error).message}\n`);
		process.exit(1);
	}
}

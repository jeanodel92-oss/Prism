/**
 * Prism's side of the browser module: finds the running hosts (one per browser with the
 * extension) by their sockets and sends them the tool's actions.
 */
import { readdirSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { type BrowserHostInfo, browserSocketDir, type HostReply, LineReader } from "./protocol.ts";

export class BrowserCommandError extends Error {
	readonly code: string | undefined;

	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

interface Waiter {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** One open connection to a host. */
export class BrowserHostConnection {
	readonly path: string;
	info: BrowserHostInfo | undefined;
	private readonly socket: Socket;
	private readonly waiters = new Map<number, Waiter>();
	private sequence = 0;
	private closed = false;
	private readonly listeners = new Set<(event: string) => void>();

	private constructor(path: string, socket: Socket) {
		this.path = path;
		this.socket = socket;
		const lines = new LineReader();
		socket.on("data", (chunk) => {
			for (const message of lines.push(chunk)) this.receive(message);
		});
		const end = () => this.fail(new BrowserCommandError("The browser disconnected", "disconnected"));
		socket.on("close", end);
		socket.on("error", end);
	}

	static open(path: string, timeoutMs = 1000): Promise<BrowserHostConnection> {
		return new Promise((resolve, reject) => {
			const socket = connect(path);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new BrowserCommandError(`No answer from ${path}`, "timeout"));
			}, timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				resolve(new BrowserHostConnection(path, socket));
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	get isOpen(): boolean {
		return !this.closed;
	}

	onEvent(listener: (event: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	request(
		cmd: string,
		session: string,
		args: Record<string, unknown> = {},
		timeoutMs = 60000,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.closed) return Promise.reject(new BrowserCommandError("The browser disconnected", "disconnected"));
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				reject(new BrowserCommandError(`The browser did not answer ${cmd} in time`, "timeout"));
			}, timeoutMs);
			const abort = () => {
				clearTimeout(timer);
				this.waiters.delete(id);
				reject(new BrowserCommandError("Aborted", "aborted"));
			};
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });
			this.waiters.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", abort);
					resolve(value);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", abort);
					reject(error);
				},
				timer,
			});
			this.socket.write(`${JSON.stringify({ id, cmd, session, args })}\n`);
		});
	}

	close(): void {
		this.closed = true;
		this.socket.destroy();
	}

	private receive(message: unknown): void {
		if (!message || typeof message !== "object") return;
		const event = (message as { event?: unknown }).event;
		if (typeof event === "string") {
			if (event === "stopped" && this.info) this.info.stopped = true;
			for (const listener of this.listeners) listener(event);
			return;
		}
		const reply = message as HostReply;
		const waiter = this.waiters.get(reply.id);
		if (!waiter) return;
		this.waiters.delete(reply.id);
		clearTimeout(waiter.timer);
		if (reply.ok) waiter.resolve(reply.result);
		else waiter.reject(new BrowserCommandError(reply.error ?? "The browser refused the action", reply.code));
	}

	private fail(error: Error): void {
		this.closed = true;
		for (const waiter of this.waiters.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters.clear();
	}
}

/**
 * The hosts that answer, keeping the connections already open. A socket nobody listens on is a host
 * that died without cleaning up: it is removed.
 */
export class BrowserHosts {
	private readonly dir: string;
	private readonly open = new Map<string, BrowserHostConnection>();

	constructor(dir = browserSocketDir()) {
		this.dir = dir;
	}

	async list(): Promise<BrowserHostConnection[]> {
		let names: string[];
		try {
			names = readdirSync(this.dir).filter((name) => name.endsWith(".sock"));
		} catch {
			names = [];
		}
		const paths = new Set(names.map((name) => join(this.dir, name)));
		for (const [path, connection] of this.open) {
			if (!paths.has(path) || !connection.isOpen) {
				connection.close();
				this.open.delete(path);
			}
		}
		await Promise.all(
			[...paths].map(async (path) => {
				if (this.open.has(path)) return;
				let connection: BrowserHostConnection;
				try {
					connection = await BrowserHostConnection.open(path);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ECONNREFUSED" || code === "ENOENT") {
						try {
							unlinkSync(path);
						} catch {
							// Someone else removed it.
						}
					}
					return;
				}
				try {
					connection.info = (await connection.request("hello", "", {}, 4000)) as BrowserHostInfo;
					this.open.set(path, connection);
				} catch {
					connection.close();
				}
			}),
		);
		return [...this.open.values()].filter((connection) => connection.isOpen);
	}

	close(): void {
		for (const connection of this.open.values()) connection.close();
		this.open.clear();
	}
}

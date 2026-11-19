import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import crossSpawn from "cross-spawn";
import { type JsonRpcMessage, McpConnectionClosedError, parseJsonRpcMessage } from "../protocol/jsonrpc.ts";
import { DEFAULT_MAX_MESSAGE_BYTES, type McpTransport, TransportEvents } from "./transport.ts";

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** How long a server gets to exit on its own after stdin closes, before it is sent SIGTERM. */
const STDIN_CLOSE_GRACE_MS = 500;
/**
 * fork: writes the server has not read yet, at most. Past this, or past
 * twice the message limit in bytes, the server is not reading its input: the transport fails and closes, instead of
 * queueing replies (and the requests waiting on them) without bound.
 */
const MAX_UNREAD_WRITES = 10_000;
const USE_PROCESS_GROUPS = process.platform !== "win32";
/** fork: how often a group being stopped is checked; after SIGKILL, how long it may take to empty. */
const GROUP_POLL_MS = 50;
const KILL_CONFIRM_MS = 5_000;

/** Process groups of running servers, killed if the host exits without closing them. */
const liveProcessGroups = new Set<number>();
let exitHookInstalled = false;

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (process.platform === "win32" && pid !== undefined) {
		if (child.exitCode !== null) return;
		// Windows has no graceful signals, and cross-spawn runs `.cmd` shims through cmd.exe; killing only
		// that would leave the server running.
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
			"error",
			() => {},
		);
		return;
	}
	if (USE_PROCESS_GROUPS && pid !== undefined) {
		try {
			// Negative pid: the whole group, so wrappers like `npx` or `uvx` do not leave the server behind.
			process.kill(-pid, signal);
			return;
		} catch {
			// The group is gone or was never created; fall back to the direct child.
		}
	}
	try {
		child.kill(signal);
	} catch {}
}

/** Whether a process group still has a process (EPERM: one this process may not signal). */
function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * fork: a server's group is followed until it is seen empty, not until
 * the server exits: a descendant it left keeps it. Once seen empty, the group is dropped and never signalled again.
 */
function watchGroup(pgid: number, delay = GROUP_POLL_MS): void {
	if (!liveProcessGroups.has(pgid)) return;
	if (!groupAlive(pgid)) {
		liveProcessGroups.delete(pgid);
		return;
	}
	setTimeout(() => watchGroup(pgid, Math.min(delay * 2, 1_000)), delay).unref();
}

/**
 * fork: SIGTERM to the server's group, SIGKILL after `graceMs` unless it was seen empty, and resolves
 * once it is (or `KILL_CONFIRM_MS` after SIGKILL). Done whether the server itself has exited or not.
 */
function stopGroup(pgid: number, graceMs: number): Promise<void> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		let killedAt: number | undefined;
		const check = () => {
			if (!groupAlive(pgid)) {
				liveProcessGroups.delete(pgid);
				return resolve();
			}
			const now = Date.now();
			if (killedAt === undefined && now - startedAt >= graceMs) {
				killedAt = now;
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {}
			}
			if (killedAt !== undefined && now - killedAt >= KILL_CONFIRM_MS) return resolve();
			setTimeout(check, GROUP_POLL_MS);
		};
		try {
			process.kill(-pgid, "SIGTERM");
		} catch {}
		check();
	});
}

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const pid of liveProcessGroups) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {}
		}
	});
}

export interface StdioTransportOptions {
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: Record<string, string>;
	inheritEnv?: boolean;
	stderr?: "pipe" | "inherit";
	onStderr?: (chunk: string) => void;
	maxMessageBytes?: number;
	maxStderrBytes?: number;
	/** Time to wait for the server to exit after SIGTERM before sending SIGKILL. Default: 2000. */
	closeTimeoutMs?: number;
}

export class StdioTransport extends TransportEvents implements McpTransport {
	readonly options: Readonly<StdioTransportOptions>;
	private child: ChildProcess | undefined;
	/** fork: the start of the current message, in `stdoutBuffer[0, stdoutLength)`. */
	private stdoutBuffer = Buffer.alloc(0);
	private stdoutLength = 0;
	private stderrBuffer = Buffer.alloc(0);
	/** Writes not yet handed to the server's stdin pipe. */
	private unreadWrites = 0;
	private started = false;
	private closed = false;

	constructor(options: StdioTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, args: options.args ? [...options.args] : undefined });
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get stderr(): string {
		return this.stderrBuffer.toString("utf8");
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP stdio transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
		const env = this.options.inheritEnv === false ? { ...this.options.env } : { ...process.env, ...this.options.env };
		const child = crossSpawn(this.options.command, this.options.args ?? [], {
			cwd: this.options.cwd,
			env,
			stdio: ["pipe", "pipe", this.options.stderr === "inherit" ? "inherit" : "pipe"],
			windowsHide: true,
			// Own process group, so closing the transport can terminate the server's children too.
			detached: USE_PROCESS_GROUPS,
		});
		this.child = child;
		const pid = child.pid;
		if (USE_PROCESS_GROUPS && pid !== undefined) {
			installExitHook();
			liveProcessGroups.add(pid);
			// fork: followed past the server's exit, while a descendant keeps its group. From "exit", not
			// "close": a descendant that left the group can hold the pipes, so "close" may never
			// come, and an empty group kept here would be signalled once its number is another group's.
			child.once("exit", () => watchGroup(pid));
		}
		child.stdout?.on("data", (chunk: Buffer | string) => this.handleStdout(chunk));
		child.stdout?.on("error", (error) => this.emitError(error));
		child.stdin?.on("error", (error) => {
			if (!this.closed) this.emitError(error);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => this.handleStderr(chunk));
		child.stderr?.on("error", (error) => this.emitError(error));
		child.on("close", () => {
			this.child = undefined;
			if (this.stdoutBuffer.toString("utf8", 0, this.stdoutLength).trim()) {
				this.emitError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
			}
			this.stdoutBuffer = Buffer.alloc(0);
			this.stdoutLength = 0;
			this.emitClose();
		});

		await new Promise<void>((resolve, reject) => {
			const onSpawn = () => {
				child.off("error", onError);
				resolve();
			};
			const onError = (error: Error) => {
				child.off("spawn", onSpawn);
				reject(error);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
		child.on("error", (error) => {
			if (!this.closed) this.emitError(error);
		});
	}

	async send(message: JsonRpcMessage): Promise<void> {
		const stdin = this.child?.stdin;
		if (!this.started || this.closed || !stdin?.writable) throw new McpConnectionClosedError();
		const payload = `${JSON.stringify(message)}\n`;
		const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		if (
			this.unreadWrites >= MAX_UNREAD_WRITES ||
			stdin.writableLength + Buffer.byteLength(payload) > 2 * maxMessageBytes
		) {
			const error = new McpConnectionClosedError("MCP stdio server is not reading its input");
			this.emitError(error);
			void this.close();
			throw error;
		}
		this.unreadWrites++;
		await new Promise<void>((resolve, reject) => {
			stdin.write(payload, (error) => {
				this.unreadWrites--;
				if (error) reject(error);
				else resolve();
			});
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const child = this.child;
		if (!child) {
			this.emitClose();
			return;
		}
		// Shutdown per the spec: close stdin and let the server exit, then SIGTERM, then SIGKILL.
		const closeTimeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		const pgid = child.pid;
		if (USE_PROCESS_GROUPS && pgid !== undefined) {
			// fork: the server's group is stopped and seen empty even when
			// the server already exited, or exits on stdin closing, leaving a descendant behind.
			const exited = child.exitCode !== null || child.signalCode !== null;
			const closedEvent = new Promise<void>((resolve) => child.once("close", () => resolve()));
			child.stdin?.end();
			if (!exited) {
				const grace = Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, grace);
					child.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			if (liveProcessGroups.has(pgid)) await stopGroup(pgid, closeTimeoutMs);
			// Its pipes close with the group, unless a descendant that left it holds them.
			await Promise.race([closedEvent, new Promise<void>((resolve) => setTimeout(resolve, closeTimeoutMs).unref())]);
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			child.stdin?.end();
			return;
		}
		await new Promise<void>((resolve) => {
			const timers: ReturnType<typeof setTimeout>[] = [];
			child.once("close", () => {
				for (const timer of timers) clearTimeout(timer);
				// Children of the server that ignored stdin closing would otherwise outlive it.
				killProcessTree(child, "SIGTERM");
				resolve();
			});
			const grace = Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);
			timers.push(setTimeout(() => killProcessTree(child, "SIGTERM"), grace));
			timers.push(setTimeout(() => killProcessTree(child, "SIGKILL"), grace + closeTimeoutMs));
			child.stdin?.end();
		});
	}

	/**
	 * fork: a message's pieces go into a buffer that doubles when full, so each
	 * byte is copied about once, and only the new piece is searched for the end of line. The whole buffer used to be copied and searched on every piece, and a
	 * message past the limit was dropped while reading went on: a server writing without end kept the engine at 100 %
	 * of a core until the request timed out (60 s). Now the first message past the limit fails and closes the
	 * transport, as the LSP client does.
	 */
	private handleStdout(chunk: Buffer | string): void {
		if (this.closed) return;
		let rest = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		while (rest.length > 0) {
			const newline = rest.indexOf(0x0a);
			const piece = newline < 0 ? rest : rest.subarray(0, newline);
			if (this.stdoutLength + piece.length > maxMessageBytes) {
				this.stdoutBuffer = Buffer.alloc(0);
				this.stdoutLength = 0;
				this.emitError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				void this.close();
				return;
			}
			if (newline < 0) {
				this.keepStdout(piece, maxMessageBytes);
				return;
			}
			let line = piece;
			if (this.stdoutLength > 0) {
				this.keepStdout(piece, maxMessageBytes);
				line = this.stdoutBuffer.subarray(0, this.stdoutLength);
			}
			rest = rest.subarray(newline + 1);
			const text = line.toString("utf8").replace(/\r$/, "");
			this.stdoutLength = 0;
			// A large message's buffer is not kept for the small ones after it.
			if (this.stdoutBuffer.length > 64 * 1024) this.stdoutBuffer = Buffer.alloc(0);
			if (!text.trim()) continue;
			try {
				this.emitMessage(parseJsonRpcMessage(JSON.parse(text)));
			} catch (error) {
				this.emitError(error);
			}
		}
	}

	/** Appends to the current message, doubling the buffer when it is full, up to the message limit. */
	private keepStdout(piece: Buffer, maxMessageBytes: number): void {
		const needed = this.stdoutLength + piece.length;
		if (needed > this.stdoutBuffer.length) {
			const size = Math.max(needed, Math.min(maxMessageBytes, Math.max(2 * this.stdoutBuffer.length, 4096)));
			const grown = Buffer.allocUnsafe(size);
			this.stdoutBuffer.copy(grown, 0, 0, this.stdoutLength);
			this.stdoutBuffer = grown;
		}
		piece.copy(this.stdoutBuffer, this.stdoutLength);
		this.stdoutLength = needed;
	}

	private handleStderr(chunk: Buffer | string): void {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const maxStderrBytes = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.stderrBuffer = Buffer.concat([this.stderrBuffer, buffer]);
		if (this.stderrBuffer.length > maxStderrBytes) this.stderrBuffer = this.stderrBuffer.subarray(-maxStderrBytes);
		this.options.onStderr?.(buffer.toString("utf8"));
	}
}

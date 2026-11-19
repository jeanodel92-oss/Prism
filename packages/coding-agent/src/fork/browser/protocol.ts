/**
 * the wire formats of the browser module.
 *
 * Browser extension <-> host: native messaging, each message a UTF-8 JSON body preceded by its length
 * (32-bit, native byte order: little-endian on the supported platforms).
 * Host <-> Prism: a Unix socket, one JSON object per line.
 */
import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** The native messaging host name the extension connects to. */
export const NATIVE_HOST_NAME = "space.odelserver.prism";
/**
 * The extension's id in Chromium-family browsers, fixed by the `key` of its manifest: the Chrome Web Store's public
 * key since 2026-11-12, so the store's extension and an unpacked one share it.
 */
export const CHROMIUM_EXTENSION_ID = "oinfdnajckegicaemkaobancehobeghe";
/** The extension's id in Firefox (`browser_specific_settings.gecko.id`). */
export const FIREFOX_EXTENSION_ID = "prism-browser@odelserver.space";

/** Chromium refuses messages above 1 MiB from the host; the extension's own are capped at 64 MiB. */
export const MAX_TO_EXTENSION = 1024 * 1024;
export const MAX_FROM_EXTENSION = 64 * 1024 * 1024;

export function encodeNative(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length, 0);
	return Buffer.concat([head, body]);
}

/**
 * Splits a native messaging stream into messages.
 *
 * fork: the chunks of a message are joined once it is whole, not with
 * every chunk: a 64 MiB screenshot in 64 KiB chunks copied about 32 GiB of prefixes before.
 */
export class NativeReader {
	private chunks: Buffer[] = [];
	private size = 0;
	/** Bytes the message being read needs before it is whole (0 while its length is unknown). */
	private needed = 0;
	private readonly limit: number;

	constructor(limit = MAX_FROM_EXTENSION) {
		this.limit = limit;
	}

	push(chunk: Buffer): unknown[] {
		this.chunks.push(chunk);
		this.size += chunk.length;
		const messages: unknown[] = [];
		if (this.size < Math.max(this.needed, 4)) return messages;
		let buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
		this.needed = 0;
		while (buffer.length >= 4) {
			const length = buffer.readUInt32LE(0);
			if (length > this.limit) throw new Error(`Native message of ${length} bytes exceeds the limit`);
			if (buffer.length < 4 + length) {
				this.needed = 4 + length;
				break;
			}
			messages.push(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
			buffer = buffer.subarray(4 + length);
		}
		this.chunks = buffer.length > 0 ? [buffer] : [];
		this.size = buffer.length;
		return messages;
	}
}

/** Splits a newline-delimited JSON stream into messages. */
export class LineReader {
	private pending = "";
	// one decoder for the whole stream keeps a character split across chunks.
	private readonly decoder = new StringDecoder("utf8");

	push(chunk: Buffer | string): unknown[] {
		const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.pending += text;
		// fork: only a chunk with a newline ends a line; the rest is not searched again.
		if (!text.includes("\n")) return [];
		const lines = this.pending.split("\n");
		this.pending = lines.pop() ?? "";
		const messages: unknown[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				messages.push(JSON.parse(line));
			} catch {
				// A malformed line is dropped; the requester times out.
			}
		}
		return messages;
	}
}

/**
 * The folder of the hosts' sockets: private to the user (0700), under the runtime directory, which the
 * agent's sandboxed shell does not see.
 */
export function browserSocketDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PRISM_BROWSER_SOCKET_DIR) return env.PRISM_BROWSER_SOCKET_DIR;
	if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "prism-browser");
	return join(tmpdir(), `prism-browser-${process.getuid?.() ?? "user"}`);
}

/** Creates the socket folder if needed and refuses one another user could reach. */
export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	const uid = process.getuid?.();
	if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
		throw new Error(`${dir} must be a directory private to the current user (mode 0700)`);
	}
}

/** What a host tells Prism about its browser. */
export interface BrowserHostInfo {
	name: string;
	version: string;
	extension: string;
	/** the build in the extension's prism-build.json (setup.ts `extensionBuild`); empty. */
	build: string;
	/** Real clicks and keys (chrome.debugger); false means clicks are dispatched by script. */
	realInput: boolean;
	/** The user stopped the control from the browser. */
	stopped: boolean;
	pid: number;
}

export interface HostRequest {
	id: number;
	cmd: string;
	session?: string;
	args?: Record<string, unknown>;
}

export interface HostReply {
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string;
	code?: string;
}

/**
 * Hyprland's request socket, as `hyprctl` uses it: one connection per request, the request written as
 * text, the answer read until the compositor closes. Used to drive the user's own desktop (user-desktop.ts).
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fill } from "../i18n/index.ts";

/** The socket of the Hyprland session Prism runs in, or undefined outside Hyprland. */
export function hyprlandSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const signature = env.HYPRLAND_INSTANCE_SIGNATURE;
	const runtime = env.XDG_RUNTIME_DIR;
	if (!signature || !runtime || signature.includes("/")) return undefined;
	const path = join(runtime, "hypr", signature, ".socket.sock");
	return existsSync(path) ? path : undefined;
}

export function hyprlandRequest(socket: string, request: string, timeout = 3000): Promise<string> {
	return new Promise((resolve, reject) => {
		const connection = connect(socket);
		let answer = "";
		const timer = setTimeout(() => {
			connection.destroy();
			reject(new Error(`Hyprland did not answer "${request.split(" ")[0]}".`));
		}, timeout);
		connection.setEncoding("utf8");
		connection.on("connect", () => connection.write(request));
		connection.on("data", (chunk: string) => {
			answer += chunk;
		});
		connection.on("end", () => {
			clearTimeout(timer);
			resolve(answer);
		});
		connection.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export async function hyprlandJson<T>(socket: string, what: string): Promise<T> {
	return JSON.parse(await hyprlandRequest(socket, `j/${what}`)) as T;
}

export interface HyprlandMonitor {
	name: string;
	/** Pixels. */
	width: number;
	height: number;
	/** Top left corner in the layout, in logical pixels. */
	x: number;
	y: number;
	scale: number;
	focused: boolean;
}

export interface HyprlandBind {
	modmask: number;
	key: string;
	submap?: string;
	/** The command of an exec bind (legacy config); a number for a Lua bind. */
	arg?: unknown;
}

/** Hyprland's modifier masks (xkb real modifiers). */
const MODMASK: Record<string, number> = { shift: 1, ctrl: 4, control: 4, alt: 8, super: 64, meta: 64, win: 64 };

export interface Shortcut {
	/** Modifiers as Hyprland names them: CTRL, SHIFT, ALT, SUPER. */
	mods: string[];
	modmask: number;
	key: string;
}

/** "ctrl+shift+q" -> CTRL SHIFT, Q. At least one modifier: a lone key would be taken from every program. */
export function parseShortcut(text: string): Shortcut {
	const parts = text
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	const key = parts.pop();
	if (!key || !/^[A-Za-z0-9]$|^F([1-9]|1[0-2])$/i.test(key)) {
		throw new Error(fill('"{0}" needs a letter, a digit or F1 to F12 as its key.', text));
	}
	let modmask = 0;
	const mods: string[] = [];
	for (const part of parts) {
		const mask = MODMASK[part.toLowerCase()];
		if (mask === undefined) throw new Error(fill('Unknown modifier "{0}" in "{1}".', part, text));
		if (modmask & mask) continue;
		modmask |= mask;
		mods.push({ 1: "SHIFT", 4: "CTRL", 8: "ALT", 64: "SUPER" }[mask]!);
	}
	if (!modmask) throw new Error(fill('"{0}" needs a modifier (ctrl, shift, alt or super).', text));
	return { mods, modmask, key: key.toUpperCase() };
}

/** A Lua string literal for `eval`; refuses control characters, which have no use here. */
export function luaString(text: string): string {
	if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error("Control characters are not allowed here.");
	return JSON.stringify(text);
}

/**
 * the user's own desktop, on their consent, under Hyprland. The helper
 * drives the screen the user is on through the virtual pointer and keyboard protocols. The user takes their desktop
 * back with a shortcut that Prism declares to Hyprland only while the agent has it, or by moving the mouse for about
 * two seconds. Keystrokes are not watched: Wayland does not tell the agent's virtual keyboard from the user's.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type HyprlandBind,
	type HyprlandMonitor,
	hyprlandJson,
	hyprlandRequest,
	luaString,
	parseShortcut,
	type Shortcut,
} from "./hyprland.ts";
import { DesktopError, HelperDesktop } from "./session.ts";

/** How often Prism looks at the pointer and the shortcut's flag file. */
const POLL_MS = 100;
/** How long the user moves the mouse before Prism gives the desktop back; a brief move does not. */
export const TAKE_BACK_MOVE_MS = 2000;
/** A pause longer than this ends a mouse movement. */
const MOVE_GAP_MS = 400;
/** Every this many polls, Prism checks that its shortcut is still declared (a reload of Hyprland's config drops it). */
const BIND_CHECK_POLLS = 10;

const UNBIND_LUA = "eval if _G.prism_take_back then _G.prism_take_back:unbind() _G.prism_take_back = nil end";

/**
 * fork: one Prism at a time has a Hyprland desktop. The take-back shortcut is
 * shared (one Lua name, one key combination): a second Prism that took it as a leftover cut the first one's shortcut
 * off, and either one stopping withdrew the other's. The owner is written next to Hyprland's socket, so it belongs to
 * that Hyprland instance and goes with its session.
 */
interface DesktopOwner {
	pid: number;
	/** The process's start time (/proc/<pid>/stat), so a reused pid is not taken for the maintainer. */
	started: string | undefined;
	token: string;
}

function ownerPath(socket: string): string {
	return join(dirname(socket), "prism-user-desktop.owner");
}

function processStart(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Fields after the command name, which may hold spaces and parentheses: starttime is field 22.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

function readOwner(path: string): DesktopOwner | undefined {
	try {
		const owner = JSON.parse(readFileSync(path, "utf8")) as Partial<DesktopOwner>;
		return typeof owner.pid === "number" && typeof owner.token === "string" ? (owner as DesktopOwner) : undefined;
	} catch {
		return undefined;
	}
}

function ownerAlive(owner: DesktopOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	return owner.started === undefined || processStart(owner.pid) === owner.started;
}

/** Takes the desktop for this Prism; refuses while another live one has it, replaces the record of a dead one. */
function claimDesktop(socket: string): string {
	const path = ownerPath(socket);
	const owner: DesktopOwner = { pid: process.pid, started: processStart(process.pid), token: randomUUID() };
	for (let attempt = 0; attempt < 2; attempt++) {
		let fd: number;
		try {
			fd = openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const current = readOwner(path);
			if (current && ownerAlive(current)) {
				throw new DesktopError(
					`Another Prism (process ${current.pid}) already has the user's desktop: it is free again once the user takes it back from that one.`,
				);
			}
			// Left by a Prism that ended without giving the desktop back.
			rmSync(path, { force: true });
			continue;
		}
		try {
			writeSync(fd, JSON.stringify(owner));
		} finally {
			closeSync(fd);
		}
		return owner.token;
	}
	throw new DesktopError("Another Prism is taking your desktop at the same time.");
}

/** Whether this Prism still holds the desktop it claimed with `token`. */
function holdsDesktop(socket: string, token: string): boolean {
	return readOwner(ownerPath(socket))?.token === token;
}

function releaseDesktop(socket: string, token: string): void {
	if (holdsDesktop(socket, token)) rmSync(ownerPath(socket), { force: true });
}

/** "desktop": the user ended the sharing from their desktop (portal). */
export type TakeBackReason = "shortcut" | "mouse" | "helper" | "desktop";

export interface UserDesktopOptions {
	helper: string;
	/** Hyprland's request socket (hyprland.ts). */
	socket: string;
	/** As the user writes it: ctrl+shift+q. */
	shortcut: string;
	/** Text of Hyprland's notification while the agent has the desktop. */
	notice: string;
	/** Called once when the user takes the desktop back. */
	onTakenBack: (reason: TakeBackReason) => void;
	parent?: string;
	timeout?: number;
	/** WAYLAND_DISPLAY and XDG_RUNTIME_DIR of the user's session (default: Prism's). */
	env?: NodeJS.ProcessEnv;
}

/** Hyprland names a virtual keyboard after the program that made it. */
export function helperKeyboardName(helper: string): string {
	return `hl-virtual-keyboard-${basename(helper)}`;
}

/**
 * Follows the pointer: the user is taking the desktop back when it moves away from where the agent put it, sample after
 * sample, for TAKE_BACK_MOVE_MS. Positions in Hyprland's layout (logical pixels).
 */
export class MouseWatch {
	private last: { x: number; y: number } | undefined;
	private movingSince: number | undefined;
	private lastMove = 0;

	/** True once the user has moved the mouse long enough. */
	sample(at: { x: number; y: number }, expected: { x: number; y: number } | undefined, now: number): boolean {
		const moved =
			this.last !== undefined && (Math.abs(at.x - this.last.x) > 0.5 || Math.abs(at.y - this.last.y) > 0.5);
		const away = expected === undefined || Math.abs(at.x - expected.x) > 1.5 || Math.abs(at.y - expected.y) > 1.5;
		this.last = at;
		if (!moved || !away) {
			if (now - this.lastMove > MOVE_GAP_MS) this.movingSince = undefined;
			return false;
		}
		if (this.movingSince === undefined || now - this.lastMove > MOVE_GAP_MS) this.movingSince = now;
		this.lastMove = now;
		return now - this.movingSince >= TAKE_BACK_MOVE_MS;
	}
}

export class UserDesktop extends HelperDesktop {
	readonly monitor: HyprlandMonitor;
	readonly shortcut: Shortcut;
	private readonly socket: string;
	private readonly lua: boolean;
	private readonly flag: string;
	/** This Prism's claim on the desktop. */
	private readonly token: string;
	private readonly onTakenBack: (reason: TakeBackReason) => void;
	private readonly watch = new MouseWatch();
	/** The pointer where the user left it, until the agent moves it. */
	private start: { x: number; y: number } | undefined;
	private timer: NodeJS.Timeout | undefined;
	private polls = 0;
	private polling = false;
	private released = false;
	/** fork: the workspace the user's screen showed when the agent took it. */
	private returnTo: string | undefined;
	/** The empty workspace Prism showed on the user's screen when the agent took it, if it could. */
	freeWorkspace: string | undefined;

	private constructor(
		runtimeDir: string,
		socket: string,
		monitor: HyprlandMonitor,
		shortcut: Shortcut,
		lua: boolean,
		token: string,
		onTakenBack: (reason: TakeBackReason) => void,
	) {
		super(runtimeDir);
		this.token = token;
		this.socket = socket;
		this.monitor = monitor;
		this.shortcut = shortcut;
		this.lua = lua;
		this.flag = join(runtimeDir, "taken-back");
		this.onTakenBack = onTakenBack;
	}

	/** The screen the user is on, the shortcut declared, the agent's keyboard kept from Hyprland's shortcuts, the helper. */
	static async start(options: UserDesktopOptions): Promise<UserDesktop> {
		const shortcut = parseShortcut(options.shortcut);
		const monitors = await hyprlandJson<HyprlandMonitor[]>(options.socket, "monitors");
		const monitor = monitors.find((m) => m.focused) ?? monitors[0];
		if (!monitor) throw new DesktopError("Hyprland shows no screen.");
		const lua = (await hyprlandRequest(options.socket, "eval return 1")).trim() === "ok";
		// fork: a Prism shortcut found below is a leftover only once no other live
		// Prism has this desktop; while one has it, it is refused and its shortcut kept.
		const token = claimDesktop(options.socket);
		let runtimeDir: string;
		try {
			// A Prism that ended without giving the desktop back left its shortcut: it is Prism's, not the user's.
			if (lua) await hyprlandRequest(options.socket, UNBIND_LUA);
			for (const bind of await hyprlandJson<HyprlandBind[]>(options.socket, "binds")) {
				if (isShortcut(bind, shortcut) && typeof bind.arg === "string" && /prism-user-desk-/.test(bind.arg)) {
					await hyprlandRequest(options.socket, `keyword unbind ${shortcut.mods.join(" ")}, ${shortcut.key}`);
				}
			}
			const taken = (await hyprlandJson<HyprlandBind[]>(options.socket, "binds")).some((bind) =>
				isShortcut(bind, shortcut),
			);
			if (taken) {
				throw new DesktopError(
					`${options.shortcut} is already one of your Hyprland shortcuts: choose another one to take your desktop back (desktopTakeBackKey in settings.json).`,
				);
			}
			runtimeDir = mkdtempSync(join(options.parent ?? tmpdir(), "prism-user-desk-"));
			// The path goes into a Hyprland command: nothing a shell or Lua would read twice.
			if (!/^[\w./-]+$/.test(runtimeDir)) {
				rmSync(runtimeDir, { recursive: true, force: true });
				throw new DesktopError(`The temporary folder ${runtimeDir} has characters Prism cannot pass to Hyprland.`);
			}
		} catch (error) {
			releaseDesktop(options.socket, token);
			throw error;
		}
		const desktop = new UserDesktop(runtimeDir, options.socket, monitor, shortcut, lua, token, options.onTakenBack);
		try {
			const keyboard = helperKeyboardName(options.helper);
			// Hyprland reads a virtual keyboard's keys through the user's layout to match its shortcuts: the agent's
			// typing could set off any of them. Its keyboard gets no shortcut at all.
			await desktop.command(
				lua
					? `eval hl.device({ name = ${luaString(keyboard)}, keybinds = false })`
					: `keyword device[${keyboard}]:keybinds false`,
			);
			await desktop.declareShortcut();
			const env = options.env ?? process.env;
			await desktop.startHelper(
				options.helper,
				{
					XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
					WAYLAND_DISPLAY: env.WAYLAND_DISPLAY,
					PRISM_DESKTOP_OUTPUT: monitor.name,
				},
				options.timeout ?? 10000,
			);
			const devices = await hyprlandJson<{ keyboards: Array<{ name: string }> }>(options.socket, "devices");
			if (!devices.keyboards.some((k) => k.name === keyboard)) {
				throw new DesktopError(`Hyprland does not show the agent's keyboard (${keyboard}).`);
			}
			// fork: the agent saw Prism's own window. Its screen shows an empty workspace,
			// apart from the user's windows; a switch that fails leaves the screen as it was.
			await desktop.moveToFreeWorkspace().catch(() => undefined);
			desktop.start = await hyprlandJson<{ x: number; y: number }>(options.socket, "cursorpos");
			await desktop.command(
				lua
					? `eval hl.notification.create({ text = ${luaString(options.notice)}, timeout = 6000 })`
					: `notify 1 6000 0 ${options.notice}`,
			);
		} catch (error) {
			await desktop.stop();
			throw error;
		}
		desktop.timer = setInterval(() => void desktop.poll(), POLL_MS);
		return desktop;
	}

	/** One request; an answer other than "ok" is an error. */
	private async command(request: string): Promise<void> {
		const answer = (await hyprlandRequest(this.socket, request)).trim();
		if (answer !== "ok") throw new DesktopError(`Hyprland refused "${request.split(" ")[0]}": ${answer}`);
	}

	/** The user's screen shows workspace `name` (a number, or a selector such as e+1). */
	private dispatchWorkspace(name: string): Promise<void> {
		// Under a Lua config the IPC `dispatch` takes a Lua dispatcher (measured on the maintainer's Hyprland 0.56.2:
		// "dispatch workspace 1" refused, hl.dsp.focus({ workspace = "1" }) obeyed).
		return this.command(
			this.lua ? `eval hl.dispatch(hl.dsp.focus({ workspace = ${luaString(name)} }))` : `dispatch workspace ${name}`,
		);
	}

	private async moveToFreeWorkspace(): Promise<void> {
		const monitors = await hyprlandJson<Array<{ name: string; activeWorkspace?: { id: number } }>>(
			this.socket,
			"monitors",
		);
		const shown = monitors.find((m) => m.name === this.monitor.name)?.activeWorkspace?.id;
		// A special workspace (negative id) is not one to come back to.
		this.returnTo = shown !== undefined && shown > 0 ? String(shown) : undefined;
		const used = new Set((await hyprlandJson<Array<{ id: number }>>(this.socket, "workspaces")).map((w) => w.id));
		let id = 1;
		while (used.has(id)) id++;
		await this.dispatchWorkspace(String(id));
		this.freeWorkspace = String(id);
	}

	/** The `workspace` action: the agent cannot press the user's own shortcuts (keybinds off), so Prism switches. */
	async showWorkspace(name: string): Promise<void> {
		if (!/^[\w+-]{1,32}$/.test(name)) {
			throw new DesktopError(`"${name}" is not a workspace: give its number, or a selector such as e+1.`);
		}
		if (!this.running) throw new DesktopError(this.exited ?? "The desktop is not running.");
		await this.dispatchWorkspace(name);
	}

	/** Back to the workspace the user's screen showed, when the agent gives the desktop back itself. */
	async returnToWorkspace(): Promise<void> {
		if (this.returnTo && !this.released) await this.dispatchWorkspace(this.returnTo).catch(() => undefined);
	}

	private declareShortcut(): Promise<void> {
		const { mods, key } = this.shortcut;
		return this.command(
			this.lua
				? `eval _G.prism_take_back = hl.bind(${luaString([...mods, key].join(" + "))}, hl.dsp.exec_cmd(${luaString(`touch ${this.flag}`)}))`
				: `keyword bind ${mods.join(" ")}, ${key}, exec, touch ${this.flag}`,
		);
	}

	private withdrawShortcut(): Promise<void> {
		const { mods, key } = this.shortcut;
		return this.command(this.lua ? UNBIND_LUA : `keyword unbind ${mods.join(" ")}, ${key}`);
	}

	/** The agent's pointer in Hyprland's layout: the helper's pixels are the screen's, the layout's are logical. */
	private expected(): { x: number; y: number } | undefined {
		if (!this.pointer) return this.start;
		const scale = this.monitor.scale || 1;
		return { x: this.monitor.x + this.pointer.x / scale, y: this.monitor.y + this.pointer.y / scale };
	}

	private async poll(): Promise<void> {
		if (this.polling || this.released) return;
		this.polling = true;
		try {
			if (!this.running) return this.takeBack("helper");
			if (existsSync(this.flag)) return this.takeBack("shortcut");
			const at = await hyprlandJson<{ x: number; y: number }>(this.socket, "cursorpos");
			if (this.watch.sample(at, this.expected(), Date.now())) return this.takeBack("mouse");
			if (++this.polls % BIND_CHECK_POLLS === 0) {
				const binds = await hyprlandJson<HyprlandBind[]>(this.socket, "binds");
				// fork: given back during the wait, the shortcut withdrawn stays so.
				// nor is it declared again once another Prism holds the desktop.
				if (
					!this.released &&
					holdsDesktop(this.socket, this.token) &&
					!binds.some((bind) => isShortcut(bind, this.shortcut))
				)
					await this.declareShortcut();
			}
		} catch {
			// Hyprland busy or restarting: the next poll tries again.
		} finally {
			this.polling = false;
		}
	}

	private async takeBack(reason: TakeBackReason): Promise<void> {
		if (this.released) return;
		this.exited ??=
			reason === "helper"
				? "The desktop helper stopped."
				: `The user took their desktop back (${reason === "shortcut" ? "shortcut" : "mouse"}).`;
		await this.stop();
		this.onTakenBack(reason);
	}

	/** Gives the desktop back: the helper ends, the shortcut is withdrawn. */
	async stop(): Promise<void> {
		if (this.released) return;
		this.released = true;
		this.exited ??= "The agent gave the desktop back.";
		clearInterval(this.timer);
		this.helper?.kill();
		// fork: the shortcut is withdrawn only while it is this Prism's.
		if (holdsDesktop(this.socket, this.token)) {
			try {
				await this.withdrawShortcut();
			} catch {
				// Hyprland gone: so is the shortcut.
			}
			releaseDesktop(this.socket, this.token);
		}
		rmSync(this.runtimeDir, { recursive: true, force: true });
	}
}

function isShortcut(bind: HyprlandBind, shortcut: Shortcut): boolean {
	return bind.modmask === shortcut.modmask && bind.key.toUpperCase() === shortcut.key && !bind.submap;
}

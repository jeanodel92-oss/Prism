/**
 * the agent's own desktop, a headless labwc started by Prism, and `prism-desktop-helper`, which
 * moves its pointer, types on its keyboard and captures its screen. The same helper
 * drives the user's own desktop on their consent (user-desktop.ts).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { hostCommand, hostProgram } from "../host-program.ts";
import { type DesktopWindow, parseElements } from "./elements.ts";

/**
 * labwc's configuration for the agent's desktop. labwc loads its default key bindings, which start a terminal,
 * when no binding is given: one harmless binding keeps them out, so nothing the agent types runs a program
 * outside Prism's sandbox. The menus are emptied for the same reason.
 */
export const LABWC_RC = `<?xml version="1.0"?>
<labwc_config>
  <keyboard>
    <keybind key="W-F24"><action name="None" /></keybind>
  </keyboard>
</labwc_config>
`;

export const LABWC_MENU = `<?xml version="1.0"?>
<openbox_menu>
  <menu id="root-menu" label="" />
  <menu id="client-menu" label="">
    <item label="Close"><action name="Close" /></item>
  </menu>
</openbox_menu>
`;

/**
 * the agent's desktop has its own D-Bus session bus and accessibility bus, so the accessibility tree the
 * agent reads holds the programs of its desktop only, never the user's. Nothing is
 * activated on them: a program that asks for the user's keyring, notifications or portals gets no answer there.
 */
const BUS_CONFIG = (socket: string) => `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${socket}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;

/** Where distributions install the accessibility registry (Fedora and Debian 12+, Arch, older Debian and Ubuntu). */
const REGISTRY_PATHS = [
	"/usr/libexec/at-spi2-registryd",
	"/usr/lib/at-spi2-registryd",
	"/usr/lib/at-spi2-core/at-spi2-registryd",
	"/usr/libexec/at-spi2-core/at-spi2-registryd",
];

export interface DesktopOptions {
	/** The helper's path. */
	helper: string;
	/** labwc's command (default: labwc on PATH). */
	labwc?: string;
	/** Parent of the desktop's runtime folder; short, since a socket path holds at most 108 bytes. */
	parent?: string;
	/** Milliseconds to wait for the desktop to start. */
	timeout?: number;
	/** For tests: labwc's own defaults instead of Prism's configuration. */
	labwcDefaults?: boolean;
	/** For tests: the PATH labwc runs programs from. */
	path?: string;
	/** For tests: the accessibility registry's path, or false for a desktop without one. */
	registry?: string | false;
}

export class DesktopError extends Error {}

/**
 * fork: how long one command may wait for the helper's answer. The
 * longest it should take is an elements listing (8 s walk, plus a second per blocked accessibility call). Past it,
 * the helper is taken as stuck and stopped: a late answer must never be read as the next command's.
 */
export const HELPER_REQUEST_TIMEOUT_MS = 30_000;
/** How long after the helper's end its last line is still waited for, when its output is not closed. */
const HELPER_LAST_WORDS_MS = 1000;

/** The keysyms of a text: Latin-1 as is, other characters as Unicode keysyms; line breaks and tabs as keys. */
export function textKeysyms(text: string): number[] {
	const keysyms: number[] = [];
	for (const char of text.replace(/\r\n?/g, "\n")) {
		const code = char.codePointAt(0)!;
		if (char === "\n") keysyms.push(0xff0d);
		else if (char === "\t") keysyms.push(0xff09);
		else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) keysyms.push(code);
		else if (code > 0xff) keysyms.push(0x01000000 + code);
		// Other control characters have no key.
	}
	return keysyms;
}

/** Modifier masks of the virtual keyboard (real modifiers of the keymap). */
const MODIFIERS: Record<string, number> = {
	shift: 1,
	ctrl: 4,
	control: 4,
	alt: 8,
	super: 64,
	meta: 64,
	win: 64,
};

/** Named keys, as X keysyms. */
const NAMED_KEYS: Record<string, number> = {
	enter: 0xff0d,
	return: 0xff0d,
	tab: 0xff09,
	escape: 0xff1b,
	esc: 0xff1b,
	backspace: 0xff08,
	delete: 0xffff,
	insert: 0xff63,
	home: 0xff50,
	end: 0xff57,
	pageup: 0xff55,
	pagedown: 0xff56,
	left: 0xff51,
	arrowleft: 0xff51,
	up: 0xff52,
	arrowup: 0xff52,
	right: 0xff53,
	arrowright: 0xff53,
	down: 0xff54,
	arrowdown: 0xff54,
	space: 0x20,
	menu: 0xff67,
};
for (let n = 1; n <= 12; n++) NAMED_KEYS[`f${n}`] = 0xffbd + n;

/** "ctrl+shift+t", "Enter", "alt+F4" -> the modifier mask and the keysym. */
export function parseKeyCombo(combo: string): { mods: number; keysym: number } {
	const parts = combo.split("+").map((part) => part.trim());
	// "ctrl++" names the plus key.
	if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") parts.splice(-2, 2, "+");
	const key = parts.pop();
	if (!key) throw new DesktopError(`No key in "${combo}"`);
	let mods = 0;
	for (const part of parts) {
		const mask = MODIFIERS[part.toLowerCase()];
		if (mask === undefined) throw new DesktopError(`Unknown modifier "${part}" in "${combo}"`);
		mods |= mask;
	}
	const named = NAMED_KEYS[key.toLowerCase()];
	if (named !== undefined) return { mods, keysym: named };
	const chars = [...key];
	if (chars.length !== 1) throw new DesktopError(`Unknown key "${key}"`);
	// With a modifier, applications expect the lower-case letter (ctrl+a), shift is the modifier.
	const keysyms = textKeysyms(mods ? key.toLowerCase() : key);
	if (keysyms.length !== 1) throw new DesktopError(`Unknown key "${key}"`);
	return { mods, keysym: keysyms[0]! };
}

function waitFor(check: () => boolean, timeout: number, failed: () => string | undefined): Promise<void> {
	const deadline = Date.now() + timeout;
	return new Promise((resolve, reject) => {
		const tick = () => {
			const failure = failed();
			if (failure) return reject(new DesktopError(failure));
			if (check()) return resolve();
			if (Date.now() > deadline) return reject(new DesktopError("The desktop did not start in time."));
			setTimeout(tick, 50);
		};
		tick();
	});
}

/** A screen driven by prism-desktop-helper: its pointer, its keyboard and its captures. */
export class HelperDesktop {
	/** Private folder: captures, logs. */
	readonly runtimeDir: string;
	width = 0;
	height = 0;
	protected helper: ChildProcess | undefined;
	private readonly answers: Array<(line: string) => void> = [];
	private queue: Promise<unknown> = Promise.resolve();
	protected exited: string | undefined;
	/** The helper's exit status, once it has ended. */
	protected exitCode: number | null | undefined;
	private captures = 0;
	/** See HELPER_REQUEST_TIMEOUT_MS. */
	requestTimeoutMs = HELPER_REQUEST_TIMEOUT_MS;
	/** Where the agent last put the pointer (screencopy leaves the cursor out). */
	pointer: { x: number; y: number } | undefined;

	protected constructor(runtimeDir: string) {
		this.runtimeDir = runtimeDir;
	}

	/** Starts the helper and waits for its first answer; returns that answer's values after the size. */
	protected async startHelper(path: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string[]> {
		const helper = spawn(path, [], { env, stdio: ["pipe", "pipe", "pipe"] });
		this.helper = helper;
		createInterface({ input: helper.stdout! }).on("line", (line) => this.answers.shift()?.(line));
		// Its last words on stderr say why it could not start (a missing library, for one).
		let log = "";
		helper.stderr!.on("data", (chunk: Buffer) => {
			log = (log + chunk.toString()).slice(-1000);
		});
		helper.on("error", (error) => {
			this.exited ??= `Could not start the desktop helper: ${error.message}`;
			for (const answer of this.answers.splice(0)) answer(`error ${this.exited}`);
		});
		// fork: a helper that says why it refuses, then ends ("error the
		// user declined to share their screen"), was seen ended before its last line was read, one time in five on
		// a busy machine, and its reason became "The desktop helper stopped.". The waiting commands now fail once
		// its output is read ("close"), or shortly after its end when something else holds the pipe.
		const fail = () => {
			for (const answer of this.answers.splice(0)) answer(`error ${this.exited}`);
		};
		helper.on("exit", (code) => {
			this.exitCode = code;
			const last = log.trim().split("\n").pop();
			this.exited ??= `The desktop helper stopped${last ? `: ${last}` : "."}`;
			setTimeout(fail, HELPER_LAST_WORDS_MS).unref();
		});
		helper.on("close", fail);
		const first = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new DesktopError("The desktop helper did not answer.")), timeout);
			this.answers.push((line) => {
				clearTimeout(timer);
				resolve(line);
			});
		});
		const words = this.parse(first);
		this.width = Number(words[0]);
		this.height = Number(words[1]);
		return words.slice(2);
	}

	private parse(line: string): string[] {
		if (line.startsWith("ok")) return line.slice(2).trim().split(" ").filter(Boolean);
		throw new DesktopError(line.startsWith("error ") ? line.slice(6) : `Unexpected answer: ${line}`);
	}

	/**
	 * Sends one command to the helper; commands run one after the other. A command aborted before its turn is never
	 * sent; aborted after, its caller is told at once and its answer, when it comes, is dropped. A helper that does not
	 * answer within requestTimeoutMs is stopped, which fails this command and those waiting behind it.
	 */
	request(command: string, signal?: AbortSignal): Promise<string[]> {
		const run = async (): Promise<string> => {
			if (signal?.aborted) throw new DesktopError("Cancelled.");
			if (this.exited) throw new DesktopError(this.exited);
			const helper = this.helper;
			if (!helper?.stdin?.writable) throw new DesktopError("The desktop helper is not running.");
			return await new Promise<string>((resolve) => {
				const timer = setTimeout(() => {
					this.exited ??= `The desktop helper did not answer within ${this.requestTimeoutMs / 1000} s and was stopped.`;
					helper.kill("SIGKILL");
					for (const answer of this.answers.splice(0)) answer(`error ${this.exited}`);
				}, this.requestTimeoutMs);
				timer.unref();
				this.answers.push((line) => {
					clearTimeout(timer);
					resolve(line);
				});
				helper.stdin!.write(`${command}\n`);
			});
		};
		const answered = this.queue.then(run, run);
		this.queue = answered.catch(() => undefined);
		const cancelled = signal
			? new Promise<never>((_, reject) => {
					const abort = () => reject(new DesktopError("Cancelled."));
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
					void answered.then(
						() => signal.removeEventListener("abort", abort),
						() => signal.removeEventListener("abort", abort),
					);
				})
			: undefined;
		cancelled?.catch(() => undefined);
		return (cancelled ? Promise.race([answered, cancelled]) : answered).then((line) => this.parse(line));
	}

	get running(): boolean {
		return this.exited === undefined;
	}

	/** Why the desktop stopped, once it has. */
	get stopReason(): string | undefined {
		return this.exited;
	}

	private point(x: number, y: number): string {
		const at = { x: Math.round(x), y: Math.round(y) };
		this.pointer = {
			x: Math.min(Math.max(at.x, 0), Math.max(this.width - 1, 0)),
			y: Math.min(Math.max(at.y, 0), Math.max(this.height - 1, 0)),
		};
		return `${at.x} ${at.y}`;
	}

	move(x: number, y: number, signal?: AbortSignal): Promise<string[]> {
		return this.request(`move ${this.point(x, y)}`, signal);
	}

	click(
		x: number,
		y: number,
		button: "left" | "right" | "middle" = "left",
		count = 1,
		signal?: AbortSignal,
	): Promise<string[]> {
		return this.request(`click ${this.point(x, y)} ${button} ${count}`, signal);
	}

	button(button: "left" | "right" | "middle", state: "down" | "up", signal?: AbortSignal): Promise<string[]> {
		return this.request(`button ${button} ${state}`, signal);
	}

	scroll(x: number, y: number, dx: number, dy: number, signal?: AbortSignal): Promise<string[]> {
		return this.request(`scroll ${this.point(x, y)} ${Math.round(dx)} ${Math.round(dy)}`, signal);
	}

	async type(text: string, signal?: AbortSignal): Promise<void> {
		const keysyms = textKeysyms(text);
		// The helper's keymap holds 240 keys: a long text goes in pieces.
		for (let start = 0; start < keysyms.length; start += 200) {
			const piece = keysyms.slice(start, start + 200);
			await this.request(`keys 0 ${piece.map((keysym) => keysym.toString(16)).join(" ")}`, signal);
		}
	}

	async key(combo: string, signal?: AbortSignal): Promise<void> {
		const { mods, keysym } = parseKeyCombo(combo);
		await this.request(`keys ${mods} ${keysym.toString(16)}`, signal);
	}

	/** The screen as RGBA pixels. */
	async capture(signal?: AbortSignal): Promise<{ width: number; height: number; rgba: Buffer }> {
		const path = join(this.runtimeDir, `capture-${++this.captures}.rgba`);
		try {
			const [width, height] = (await this.request(`capture ${path}`, signal)).map(Number);
			return { width: width!, height: height!, rgba: readFileSync(path) };
		} finally {
			rmSync(path, { force: true });
		}
	}
}

/** The agent's own desktop: a headless labwc in a private runtime folder, driven by the helper. */
export class AgentDesktop extends HelperDesktop {
	/** The compositor's socket: WAYLAND_DISPLAY for applications of this desktop. */
	readonly socket: string;
	private readonly compositor: ChildProcess;
	/** The desktop's own buses and accessibility registry. */
	private readonly services: ChildProcess[] = [];
	/**
	 * What programs started on this desktop get on top of its WAYLAND_DISPLAY: its session and accessibility buses,
	 * and the toolkit switches that turn accessibility on without a desktop session to ask. Its session bus alone
	 * without the registry; empty when no bus could start.
	 */
	programEnv: NodeJS.ProcessEnv = {};
	/** Why the accessibility tree is unavailable, when it is. */
	a11yMissing: string | undefined;
	private listings = 0;

	private constructor(runtimeDir: string, compositor: ChildProcess) {
		super(runtimeDir);
		this.socket = join(runtimeDir, "wayland-0");
		this.compositor = compositor;
	}

	/** Starts labwc without a screen in a private runtime folder, then the helper on it. */
	static async start(options: DesktopOptions): Promise<AgentDesktop> {
		const runtimeDir = mkdtempSync(join(options.parent ?? tmpdir(), "prism-desk-"));
		const config = join(runtimeDir, "labwc");
		mkdirSync(config, { mode: 0o700 });
		if (!options.labwcDefaults) {
			writeFileSync(join(config, "rc.xml"), LABWC_RC);
			writeFileSync(join(config, "menu.xml"), LABWC_MENU);
		}
		// No D-Bus or systemd address, another runtime folder: labwc leaves the user's session alone (man labwc).
		const env: NodeJS.ProcessEnv = {
			PATH: options.path ?? process.env.PATH,
			HOME: process.env.HOME,
			LANG: process.env.LANG,
			XDG_RUNTIME_DIR: runtimeDir,
			WLR_BACKENDS: "headless",
			WLR_LIBINPUT_NO_DEVICES: "1",
			WLR_RENDERER: "pixman",
		};
		const compositor = spawn(options.labwc ?? hostCommand("labwc"), ["-C", config], {
			env,
			stdio: ["ignore", "ignore", "pipe"],
		});
		const desktop = new AgentDesktop(runtimeDir, compositor);
		let log = "";
		compositor.stderr?.on("data", (chunk: Buffer) => {
			log = (log + chunk.toString()).slice(-2000);
		});
		compositor.on("error", (error) => {
			desktop.exited = `Could not start labwc: ${error.message}`;
		});
		compositor.on("exit", (code, signal) => {
			desktop.exited ??= `labwc stopped (${signal ?? code})${log ? `: ${log.trim().split("\n").pop()}` : ""}`;
			desktop.helper?.kill();
			desktop.stopServices();
		});
		try {
			await waitFor(
				() => existsSync(desktop.socket),
				options.timeout ?? 10000,
				() => desktop.exited,
			);
			const buses = await desktop.startBuses(env, options);
			const a11y = buses?.AT_SPI_BUS_ADDRESS ? buses : undefined;
			await desktop.startHelper(
				options.helper,
				{
					XDG_RUNTIME_DIR: desktop.runtimeDir,
					WAYLAND_DISPLAY: desktop.socket,
					...(a11y ? { PRISM_A11Y: "1", ...a11y } : {}),
				},
				options.timeout ?? 10000,
			);
			if (buses && !a11y) desktop.programEnv = { ...buses };
			if (a11y) {
				desktop.programEnv = { ...a11y, GNOME_ACCESSIBILITY: "1", QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1" };
				// Programs register with the registry when they start: it must answer before the first launch.
				try {
					await desktop.request("a11y-wait 3000");
				} catch (error) {
					desktop.a11yMissing = error instanceof Error ? error.message : String(error);
				}
			}
		} catch (error) {
			desktop.stop();
			throw error;
		}
		return desktop;
	}

	/** The windows of this desktop and their elements, from its accessibility tree (elements.ts). */
	async elements(signal?: AbortSignal): Promise<{ windows: DesktopWindow[]; truncated: boolean }> {
		if (this.a11yMissing) throw new DesktopError(`The accessibility tree is not available: ${this.a11yMissing}.`);
		const path = join(this.runtimeDir, `elements-${++this.listings}.tsv`);
		try {
			const answer = await this.request(`elements ${path}`, signal);
			return { windows: parseElements(readFileSync(path, "utf8")), truncated: answer.includes("truncated") };
		} finally {
			rmSync(path, { force: true });
		}
	}

	/** Runs an element's main action; returns its name (click, press…). */
	async act(ref: number, signal?: AbortSignal): Promise<string> {
		return (await this.request(`do ${ref}`, signal)).join(" ");
	}

	/** Replaces the whole text of an editable element, in any window, without the keyboard (prism-a11y.c, settext). */
	async setText(ref: number, text: string, signal?: AbortSignal): Promise<void> {
		// One command is one line: line breaks and backslashes are escaped for the helper.
		const escaped = text.replace(/\r\n?/g, "\n").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
		await this.request(`settext ${ref} ${escaped}`, signal);
	}

	/** Gives an element of the window in front the keyboard focus. */
	async focus(ref: number, signal?: AbortSignal): Promise<void> {
		await this.request(`focus ${ref}`, signal);
	}

	/**
	 * Starts the desktop's session bus, then its accessibility bus and registry. Without the registry, the session bus
	 * alone; the reason the tree is missing is
	 * kept. Undefined when no bus could start.
	 */
	private async startBuses(
		env: NodeJS.ProcessEnv,
		options: DesktopOptions,
	): Promise<{ DBUS_SESSION_BUS_ADDRESS: string; AT_SPI_BUS_ADDRESS?: string } | undefined> {
		const registry =
			options.registry === undefined
				? REGISTRY_PATHS.find((path) => existsSync(path))
				: options.registry || undefined;
		if (!registry) {
			this.a11yMissing = "the accessibility registry (at-spi2-registryd, package at-spi2-core) is not installed";
		}
		const sockets: Record<string, string> = { session: join(this.runtimeDir, "bus") };
		if (registry) sockets.a11y = join(this.runtimeDir, "a11y-bus");
		let failure: string | undefined;
		for (const [name, socket] of Object.entries(sockets)) {
			const config = join(this.runtimeDir, `${name}-bus.conf`);
			writeFileSync(config, BUS_CONFIG(socket));
			// fork: run at each session, never from where the sandbox writes.
			const program = hostProgram("dbus-daemon");
			if (!program) {
				failure ??= "dbus-daemon is not on PATH outside the folders sandboxed commands can write";
				break;
			}
			const daemon = spawn(program, ["--nofork", "--nopidfile", `--config-file=${config}`], {
				env,
				stdio: "ignore",
			});
			daemon.on("error", (error) => {
				failure ??= `dbus-daemon could not start: ${error.message}`;
			});
			this.services.push(daemon);
		}
		try {
			await waitFor(
				() => Object.values(sockets).every((socket) => existsSync(socket)),
				options.timeout ?? 10000,
				() => failure ?? this.exited,
			);
		} catch (error) {
			this.stopServices();
			this.a11yMissing ??= error instanceof Error ? error.message : String(error);
			return undefined;
		}
		const session = `unix:path=${sockets.session}`;
		if (!registry) return { DBUS_SESSION_BUS_ADDRESS: session };
		const buses = { DBUS_SESSION_BUS_ADDRESS: session, AT_SPI_BUS_ADDRESS: `unix:path=${sockets.a11y}` };
		const registryd = spawn(registry, [], { env: { ...env, ...buses }, stdio: "ignore" });
		registryd.on("error", () => {});
		this.services.push(registryd);
		return buses;
	}

	private stopServices(): void {
		for (const service of this.services.splice(0)) service.kill();
	}

	stop(): void {
		this.exited ??= "The desktop was stopped.";
		this.helper?.kill();
		this.compositor.kill();
		this.stopServices();
		rmSync(this.runtimeDir, { recursive: true, force: true });
	}
}

/**
 * the user's own desktop, on their consent, through the desktop portal (GNOME, KDE): screen sharing
 * with remote interaction, driven by `prism-portal-helper`. The desktop asks the user
 * the first time; the restore token it gives back, kept by Prism, spares the question next time. The user takes their
 * desktop back with the desktop's own stop-sharing control, with the take-back shortcut when the desktop binds it
 * (GlobalShortcuts portal), or by moving the mouse for about two seconds.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseShortcut } from "./hyprland.ts";
import { DesktopError, HelperDesktop, parseKeyCombo } from "./session.ts";
import { MouseWatch, type TakeBackReason } from "./user-desktop.ts";

/** How often Prism asks where the pointer is. */
const POLL_MS = 100;
/** The desktop's dialog waits for the user: as long as they need, within reason. */
const START_TIMEOUT_MS = 180_000;
/** Exit statuses of prism-portal-helper. */
const EXIT_SHARING_ENDED = 3;
const EXIT_TAKEN_BACK = 4;

/**
 * The app id under which Prism asks the portal: the window's (Tauri identifier). GNOME binds global shortcuts only
 * for an app with a desktop entry of that name.
 */
export const PORTAL_APP_ID = "space.odelserver.prism.gui";

export interface PortalDesktopOptions {
	helper: string;
	/** As the user writes it: ctrl+shift+q. */
	shortcut: string;
	/** Where the portal's restore token is kept between runs. */
	tokenFile: string;
	/** Registered with the portal when given. */
	appId?: string;
	/** Called once when the user takes the desktop back. */
	onTakenBack: (reason: TakeBackReason) => void;
	parent?: string;
	timeout?: number;
	/** XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS of the user's session (default: Prism's). */
	env?: NodeJS.ProcessEnv;
}

/** "ctrl+shift+q" in the portal's shortcut syntax: CTRL+SHIFT+q. */
export function portalTrigger(shortcut: string): string {
	const { mods, key } = parseShortcut(shortcut);
	const names = mods.map((mod) => (mod === "SUPER" ? "LOGO" : mod));
	return [...names, /^F\d+$/.test(key) ? key : key.toLowerCase()].join("+");
}

/** The shortcut as the desktop describes it ("Press <Shift><Control>q" on GNOME), as the user writes one. */
export function portalTriggerLabel(text: string): string {
	const names: Record<string, string> = {
		shift: "shift",
		control: "ctrl",
		ctrl: "ctrl",
		primary: "ctrl",
		alt: "alt",
		super: "super",
		meta: "super",
		logo: "super",
	};
	let rest = text.trim().replace(/^press\s+/i, "");
	const mods: string[] = [];
	for (let match = /^<(\w+)>/.exec(rest); match; match = /^<(\w+)>/.exec(rest)) {
		mods.push(names[match[1]!.toLowerCase()] ?? match[1]!.toLowerCase());
		rest = rest.slice(match[0].length);
	}
	return [...mods, rest].join("+").toLowerCase();
}

/** Whether this session can reach a desktop portal: a Wayland session with a session bus. */
export function portalSession(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.XDG_SESSION_TYPE !== "wayland" && !env.WAYLAND_DISPLAY) return false;
	return Boolean(
		env.DBUS_SESSION_BUS_ADDRESS || (env.XDG_RUNTIME_DIR && existsSync(join(env.XDG_RUNTIME_DIR, "bus"))),
	);
}

/** Whether a desktop entry named after the app id is installed, which GNOME needs to bind shortcuts. */
export function hasDesktopEntry(appId: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const home = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local/share");
	const dirs = [home, ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean)];
	return dirs.some((dir) => existsSync(join(dir, "applications", `${appId}.desktop`)));
}

/** Marks the entry Prism writes for the portal, so only that file is ever replaced or removed. */
export const PORTAL_ENTRY_MARK = "X-Prism-Portal=true";

/** A hidden entry: the portal finds Prism by it, the applications menu never shows it. */
export function portalDesktopEntry(exec: string): string {
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=Prism",
		"Comment=Lets the desktop recognise Prism when it shares your screen with the agent",
		`Exec=${exec}`,
		"NoDisplay=true",
		"Terminal=false",
		PORTAL_ENTRY_MARK,
		"",
	].join("\n");
}

/**
 * Writes the entry the first time the agent takes the user's desktop, so GNOME binds the
 * take-back shortcut. Returns whether an entry of that name is now installed; never replaces someone else's.
 */
export function ensureDesktopEntry(appId: string, exec: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (hasDesktopEntry(appId, env)) return true;
	const path = join(
		env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local/share"),
		"applications",
		`${appId}.desktop`,
	);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const partial = `${path}.${process.pid}.tmp`;
		writeFileSync(partial, portalDesktopEntry(exec), { mode: 0o644 });
		renameSync(partial, path);
		return true;
	} catch {
		return false;
	}
}

export class PortalUserDesktop extends HelperDesktop {
	/** The take-back shortcut as the desktop shows it, when the desktop bound one. */
	shortcutLabel: string | undefined;
	/** Key combinations the agent may not press: the user's take-back shortcut. */
	private readonly refused: Array<{ mods: number; keysym: number }> = [];
	private readonly onTakenBack: (reason: TakeBackReason) => void;
	private readonly watch = new MouseWatch();
	/** The pointer where the user left it, until the agent moves it. */
	private start: { x: number; y: number } | undefined;
	private timer: NodeJS.Timeout | undefined;
	private polling = false;
	private released = false;

	private constructor(runtimeDir: string, onTakenBack: (reason: TakeBackReason) => void) {
		super(runtimeDir);
		this.onTakenBack = onTakenBack;
	}

	private refuse(combo: string): void {
		try {
			this.refused.push(parseKeyCombo(combo));
		} catch {
			// A shortcut Prism cannot read: nothing to compare with.
		}
	}

	/** Asks the desktop for the screen, its pointer and keyboard (the user agrees in the desktop's dialog). */
	static async start(options: PortalDesktopOptions): Promise<PortalUserDesktop> {
		const trigger = portalTrigger(options.shortcut);
		let token: string | undefined;
		try {
			token = readFileSync(options.tokenFile, "utf8").trim() || undefined;
		} catch {
			// First time: the desktop asks.
		}
		const env = options.env ?? process.env;
		const runtimeDir = mkdtempSync(join(options.parent ?? tmpdir(), "prism-user-desk-"));
		const desktop = new PortalUserDesktop(runtimeDir, options.onTakenBack);
		let words: string[];
		try {
			// Its first answer comes once the user has answered the desktop's dialog.
			words = await desktop.startHelper(
				options.helper,
				{
					XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
					DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
					PRISM_TAKE_BACK_SHORTCUT: trigger,
					...(token ? { PRISM_PORTAL_RESTORE_TOKEN: token } : {}),
					...(options.appId ? { PRISM_PORTAL_APP_ID: options.appId } : {}),
				},
				options.timeout ?? START_TIMEOUT_MS,
			);
		} catch (error) {
			await desktop.stop();
			throw error;
		}
		const [newToken, ...shown] = words;
		if (newToken && newToken !== "-") {
			try {
				mkdirSync(dirname(options.tokenFile), { recursive: true, mode: 0o700 });
				writeFileSync(options.tokenFile, `${newToken}\n`, { mode: 0o600 });
				// The mode above applies only to a new file.
				chmodSync(options.tokenFile, 0o600);
			} catch {
				// Not kept: the desktop asks again next time.
			}
		}
		const described = shown.join(" ");
		if (described && described !== "-") {
			desktop.shortcutLabel = portalTriggerLabel(described);
			desktop.refuse(options.shortcut);
			desktop.refuse(desktop.shortcutLabel);
		}
		try {
			desktop.start = await desktop.cursor();
		} catch {
			// The desktop does not tell where the pointer is (no cursor metadata): no take-back by the mouse.
		}
		desktop.timer = setInterval(() => void desktop.poll(), POLL_MS);
		return desktop;
	}

	/** Where the pointer is, in pixels of the screen. */
	async cursor(): Promise<{ x: number; y: number }> {
		const [x, y] = (await this.request("cursor")).map(Number);
		return { x: x!, y: y! };
	}

	/** The agent pressing the user's take-back shortcut would end its own control: refused. */
	override async key(combo: string): Promise<void> {
		const { mods, keysym } = parseKeyCombo(combo);
		if (this.refused.some((shortcut) => shortcut.mods === mods && shortcut.keysym === keysym)) {
			throw new DesktopError(`${combo} is the user's shortcut to take their desktop back: not for the agent.`);
		}
		return super.key(combo);
	}

	private async poll(): Promise<void> {
		if (this.polling || this.released) return;
		this.polling = true;
		try {
			if (!this.running) {
				const reason: TakeBackReason =
					this.exitCode === EXIT_TAKEN_BACK
						? "shortcut"
						: this.exitCode === EXIT_SHARING_ENDED
							? "desktop"
							: "helper";
				return await this.takeBack(reason);
			}
			if (!this.start) return;
			const at = await this.cursor();
			if (this.watch.sample(at, this.pointer ?? this.start, Date.now())) return await this.takeBack("mouse");
		} catch {
			// The helper is busy or ending: the next poll sees it.
		} finally {
			this.polling = false;
		}
	}

	private async takeBack(reason: TakeBackReason): Promise<void> {
		if (this.released) return;
		this.exited =
			reason === "helper"
				? (this.exited ?? "The desktop helper stopped.")
				: reason === "desktop"
					? "The user stopped sharing their screen."
					: `The user took their desktop back (${reason === "shortcut" ? "shortcut" : "mouse"}).`;
		await this.stop();
		this.onTakenBack(reason);
	}

	/** Gives the desktop back: the helper ends, and with it the sharing. */
	async stop(): Promise<void> {
		if (this.released) return;
		this.released = true;
		this.exited ??= "The agent gave the desktop back.";
		clearInterval(this.timer);
		this.helper?.kill();
		rmSync(this.runtimeDir, { recursive: true, force: true });
	}
}

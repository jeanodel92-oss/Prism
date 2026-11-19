/**
 * Prism opens in the terminal or in its window.
 *
 * - `prism --gui` opens the window, `prism --tui` the terminal; a plain `prism` follows the global `openIn` setting.
 * - Unset, and the window can open here, Prism asks once (first launch after the update), then offers the
 *   applications-menu entry; `/settings` changes both later.
 * - The window is the release's `gui/prism-gui` (or `PRISM_GUI_BINARY`). Without it, without a display, or when it
 *   cannot start (no WebKitGTK), Prism says why and stays in the terminal.
 */
import { spawn } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { APP_NAME, getAgentDir, getPackageDir } from "../config.ts";
import { readBoundedSync } from "./bounded-read.ts";
import { APP_DISPLAY_NAME } from "./brand.ts";
import { fill, t } from "./i18n/index.ts";
import { windowPath } from "./shell-path.ts";

export type OpenIn = "terminal" | "window";

/** The window's program: `PRISM_GUI_BINARY`, else `gui/prism-gui` at the root of a release (next to `prism`). */
export function windowBinary(env: NodeJS.ProcessEnv = process.env, packageDir = getPackageDir()): string | undefined {
	return [env.PRISM_GUI_BINARY, resolve(packageDir, "../../../gui/prism-gui")].find(executable);
}

/** The Prism icon shipped next to the window, when there is one. */
export function windowIcon(binary: string): string | undefined {
	const icon = join(dirname(binary), `${APP_NAME}.png`);
	return existsSync(icon) ? icon : undefined;
}

export function hasDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);
}

/** Why the window cannot open here, or undefined when it can. */
export function windowProblem(env: NodeJS.ProcessEnv = process.env, packageDir = getPackageDir()): string | undefined {
	if (!windowBinary(env, packageDir)) return "This installation has no window: Prism opens in the terminal.";
	if (!hasDisplay(env)) return "No graphical display here: Prism opens in the terminal.";
	return undefined;
}

/** What the window prints on stdout once it has drawn its first frames (`window_ready` in its main.rs). */
export const READY_LINE = "prism-gui: ready";

/** How long Prism waits for that line at most; a window that is slower to start is left running. */
const READY_TIMEOUT_MS = 20_000;

/** Where the window's own messages go, for the launch that opened it: replaced at each launch. */
export const windowLogPath = () => join(getAgentDir(), "gui.log");

/**
 * Starts the window on `cwd`, detached, with this engine as its engine. Resolves to undefined once it has drawn its
 * first frames (or is still running after `timeoutMs`), or to why it stopped before that: its first error line
 * (e.g. a missing WebKitGTK library, a Wayland protocol error) and where its whole log is. Its messages keep going to
 * that log after the start (a window that stopped at its first draw used to be announced as open).
 */
export function openWindow(
	binary: string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	engine: string[] = launcherCommand(),
	{ log = windowLogPath(), timeoutMs = READY_TIMEOUT_MS } = {},
): Promise<string | undefined> {
	return new Promise((done) => {
		let fd: number;
		try {
			mkdirSync(dirname(log), { recursive: true });
			fd = openSync(log, "w", 0o600);
		} catch (error) {
			done(error instanceof Error ? error.message : String(error));
			return;
		}
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(binary, ["--cwd", cwd], {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", fd],
				env: { ...env, PRISM_GUI_ENGINE: engine[0], PRISM_GUI_ENGINE_ARGS: JSON.stringify(engine.slice(1)) },
			});
		} finally {
			closeSync(fd);
		}
		let output = "";
		let settled = false;
		const finish = (problem: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdout?.removeAllListeners("data");
			child.stdout?.destroy();
			child.removeAllListeners("exit");
			if (problem === undefined) child.unref();
			done(problem);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-4096);
			if (output.includes(READY_LINE)) finish(undefined);
		});
		child.on("error", (error) => finish(error.message));
		child.on("exit", (code, signal) => {
			let errors = "";
			try {
				// fork: the first diagnostic is near the start; never the whole log.
				errors = readBoundedSync(log, 64 * 1024, { over: "truncate" }).toString("utf8");
			} catch {}
			// A Rust panic says where before what: its "thread … panicked at" and "note: run with" lines are skipped.
			const lines = errors
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const first = (
				lines.find((line) => !/^thread '[^']*'.* panicked at |^note: run with `RUST_BACKTRACE/.test(line)) ??
				lines[0]
			)?.slice(0, 300);
			const why = first ?? fill("the window stopped ({0})", signal ?? fill("exit code {0}", String(code)));
			finish(first ? fill("{0}; whole log: {1}", why, log) : why);
		});
		const timer = setTimeout(() => finish(undefined), timeoutMs);
	});
}

export interface StartOptions {
	/** `--gui` or `--tui`. */
	flag: OpenIn | undefined;
	/** A plain launch: interactive, no message, file or session to resume. Only those follow the setting. */
	plain: boolean;
	/** stdin and stdout are a terminal: the terminal interface can run, and Prism can ask. */
	terminal: boolean;
	cwd: string;
	/**
	 * fork: this launch's arguments but `--gui` and `--tui`. The window starts its engine
	 * without them, so a launch with any (`--safe`, `--no-approve`, `--tools`…) stays in the terminal and says why,
	 * never opens a window that would drop them.
	 */
	launchArgs?: readonly string[];
	/**
	 * The folder the window opens on, from `cwd`. the applications-menu entry starts Prism in the home
	 * folder, where limited reading leaves no project and blocks every command; the terminal asks where to work there.
	 */
	windowFolder?: (cwd: string) => string;
	setting: { get(): OpenIn | undefined; set(value: OpenIn): void };
	ask<T>(title: string, options: Array<{ label: string; value: T }>): Promise<T | undefined>;
	say(message: string): void;
	env?: NodeJS.ProcessEnv;
	packageDir?: string;
	open?: typeof openWindow;
	/** The PATH for a window started without a terminal. */
	path?: typeof windowPath;
}

/**
 * Before the terminal interface starts: opens the window instead when the flag or the setting says so (asking once
 * when unset). Resolves to "window" when the window took over, "terminal" to go on, "failed" when `--gui` could not
 * open a window and there is no terminal to fall back to.
 */
export async function startInterface(options: StartOptions): Promise<OpenIn | "failed"> {
	const env = options.env ?? process.env;
	if (options.flag === "terminal") return "terminal";
	if (options.flag !== "window" && !(options.plain && options.terminal)) return "terminal";
	const problem = windowProblem(env, options.packageDir);
	if (problem) {
		if (options.flag !== "window") return "terminal";
		options.say(t(problem));
		return options.terminal ? "terminal" : "failed";
	}
	let choice = options.flag ?? options.setting.get();
	if (choice === undefined) {
		const answer = await options.ask(t("Prism now has a window. How should it open from now on?"), [
			{ label: t("In its window"), value: "window" as const },
			{ label: t("In the terminal"), value: "terminal" as const },
		]);
		// Esc: nothing is saved, and the question comes back at the next launch.
		if (answer === undefined) return "terminal";
		options.setting.set(answer);
		choice = answer;
		const binary = windowBinary(env, options.packageDir);
		// Choosing the window adds its applications-menu entry (owner, LIV-04); /settings › Interface removes it.
		if (answer === "window" && binary && !hasDesktopEntry(env)) {
			try {
				// fork: an entry of the same name that is not Prism's is kept.
				if (!writeDesktopEntry(launcherCommand(options.packageDir), windowIcon(binary), env)) {
					throw new Error(`${desktopEntryPath(env)} exists and was not written by Prism; it is kept`);
				}
				options.say(t("Prism is in the applications menu."));
			} catch (error) {
				options.say(
					fill(
						"Prism could not be added to the applications menu: {0}",
						error instanceof Error ? error.message : String(error),
					),
				);
			}
		}
		options.say(t("Change it in /settings › Interface; prism --tui or prism --gui choose for one launch."));
	}
	if (choice !== "window") return "terminal";
	const binary = windowBinary(env, options.packageDir);
	if (!binary) return "terminal";
	refreshDesktopEntry(env);
	const dropped = options.launchArgs ?? [];
	if (dropped.length > 0) {
		options.say(fill("The window does not take {0} yet: Prism opens in the terminal.", dropped.join(" ")));
		return options.terminal ? "terminal" : "failed";
	}
	const folder = options.windowFolder ? options.windowFolder(options.cwd) : options.cwd;
	// started from the applications menu, the window gets the login shell's PATH (src/fork/shell-path.ts).
	const windowEnv = options.terminal ? env : { ...env, PATH: await (options.path ?? windowPath)(env) };
	const failure = await (options.open ?? openWindow)(binary, folder, windowEnv);
	if (failure === undefined) {
		if (options.terminal) options.say(t("Prism opened in its window."));
		return "window";
	}
	options.say(fill("The window could not open ({0}): Prism opens in the terminal.", failure));
	// the one command that installs WebKitGTK on this distribution.
	const command = /libwebkit2gtk|libjavascriptcoregtk/.test(failure) ? webkitInstallCommand() : undefined;
	if (command) options.say(fill("Install WebKitGTK 4.1 with: {0}", command));
	return options.terminal ? "terminal" : "failed";
}

/** The WebKitGTK 4.1 install command for this distribution, from os-release's ID and ID_LIKE (install.sh too). */
export function webkitInstallCommand(osRelease?: string): string | undefined {
	let text = osRelease;
	if (text === undefined) {
		try {
			text = readFileSync("/etc/os-release", "utf8");
		} catch {
			return undefined;
		}
	}
	const field = (name: string) =>
		new RegExp(`^${name}=["']?([^"'\n]*)`, "m")
			.exec(text ?? "")?.[1]
			?.toLowerCase()
			.split(/\s+/) ?? [];
	for (const id of [...field("ID"), ...field("ID_LIKE")]) {
		if (["arch", "cachyos", "manjaro", "endeavouros"].includes(id)) return "sudo pacman -S --needed webkit2gtk-4.1";
		if (["fedora", "rhel", "centos"].includes(id)) return "sudo dnf install webkit2gtk4.1";
		if (["debian", "ubuntu"].includes(id)) return "sudo apt install libwebkit2gtk-4.1-0";
		if (id === "suse" || id.startsWith("opensuse")) return "sudo zypper install libwebkit2gtk-4_1-0";
	}
	return undefined;
}

// ---- The applications-menu entry (owner, LIV-04: added when the window is chosen, removable) ----

function dataHome(env: NodeJS.ProcessEnv): string {
	return env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local/share");
}

export function desktopEntryPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(dataHome(env), "applications", `${APP_NAME}.desktop`);
}

/** The icon copied into the user's icon theme: the release's own path changes with each update. */
export function desktopIconPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(dataHome(env), "icons/hicolor/256x256/apps", `${APP_NAME}.png`);
}

/** Quotes one argument of an `Exec` line (Desktop Entry Specification, "The Exec key"). */
export function execArgument(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["`$\\])/g, "\\$1")}"`;
}

/**
 * The whole value of an `Exec` key for these arguments. fork: a desktop file decodes the
 * value as a string first (`\\`, `\n`…), then its arguments; quoting the arguments alone left `\$`, which GLib
 * refuses, and a line break that ended the line. `%` is doubled, as field codes start with it.
 */
export function execValue(args: readonly string[]): string {
	return args
		.map(execArgument)
		.join(" ")
		.replace(/%/g, "%%")
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}

/**
 * fork: the line that marks the menu entry as Prism's. "--gui" anywhere in the file
 * (a comment of the user's own entry) made Prism take that entry for its own and delete it with its icon.
 */
const MENU_ENTRY_MARKER = "X-Prism-Menu=true";

/**
 * The window's Wayland app id (and X11 class) is its program's name, `prism-gui`: without this line, KDE and GNOME do
 * not tie the window to the entry and show a generic icon
 * .
 */
const STARTUP_WM_CLASS = "StartupWMClass=prism-gui";

export function desktopEntry(launcher: string[], icon: string | undefined): string {
	return [
		"[Desktop Entry]",
		"Type=Application",
		`Name=${APP_DISPLAY_NAME}`,
		"Comment=AI coding agent",
		`Exec=${execValue([...launcher, "--gui"])}`,
		...(icon ? [`Icon=${icon}`] : []),
		"Terminal=false",
		"Categories=Development;",
		"StartupNotify=true",
		STARTUP_WM_CLASS,
		MENU_ENTRY_MARKER,
		"",
	].join("\n");
}

/** Whether this text is a menu entry Prism wrote: with its marker, or, written before it, exactly Prism's lines. */
function isPrismMenuEntry(text: string): boolean {
	const lines = text.split("\n");
	if (lines.includes(MENU_ENTRY_MARKER)) return true;
	if (!lines.some((line) => line.startsWith("Exec=") && line.endsWith(" --gui"))) return false;
	// Entries of fork.10 had no marker: the same lines but their command and icon, untouched by the user.
	const shape = (all: string[]) =>
		all
			.filter((line) => !/^(Exec|Icon)=/.test(line) && line !== MENU_ENTRY_MARKER && line !== STARTUP_WM_CLASS)
			.join("\n");
	return shape(lines) === shape(desktopEntry([APP_NAME], undefined).split("\n"));
}

/** Whether the menu entry is Prism's (written by this module), so removing it never deletes someone else's file. */
export function hasDesktopEntry(env: NodeJS.ProcessEnv = process.env): boolean {
	try {
		return isPrismMenuEntry(readFileSync(desktopEntryPath(env), "utf8"));
	} catch {
		return false;
	}
}

/** Writes the menu entry; undefined, writing nothing, when an entry of that name exists and is not Prism's. */
export function writeDesktopEntry(launcher: string[], icon: string | undefined, env = process.env): string | undefined {
	const path = desktopEntryPath(env);
	if (existsSync(path) && !hasDesktopEntry(env)) return undefined;
	let name: string | undefined;
	if (icon) {
		const themed = desktopIconPath(env);
		mkdirSync(dirname(themed), { recursive: true });
		copyFileSync(icon, themed);
		name = APP_NAME;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, desktopEntry(launcher, name), { mode: 0o644 });
	return path;
}

/** An entry written before the window's class was named in it gets the line, so its icon shows. */
export function refreshDesktopEntry(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!hasDesktopEntry(env)) return false;
	const path = desktopEntryPath(env);
	try {
		const lines = readFileSync(path, "utf8").split("\n");
		if (lines.some((line) => line.startsWith("StartupWMClass="))) return false;
		const at = lines.indexOf("StartupNotify=true");
		lines.splice(at < 0 ? 1 : at + 1, 0, STARTUP_WM_CLASS);
		writeFileSync(path, lines.join("\n"), { mode: 0o644 });
		return true;
	} catch {
		return false;
	}
}

export function removeDesktopEntry(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!hasDesktopEntry(env)) return false;
	rmSync(desktopEntryPath(env), { force: true });
	rmSync(desktopIconPath(env), { force: true });
	return true;
}

function executable(path: string | undefined): path is string {
	if (!path) return false;
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The command that starts this Prism: the path the release's launcher was run by (`PRISM_LAUNCHER`, e.g. the
 * `~/.local/bin/prism` link, which survives updates), else the release's `prism`, else this Node and its script.
 */
export function launcherCommand(packageDir = getPackageDir(), env: NodeJS.ProcessEnv = process.env): string[] {
	if (executable(env.PRISM_LAUNCHER)) return [env.PRISM_LAUNCHER];
	const launcher = resolve(packageDir, "../../../prism");
	// From the sources, Node runs with loader flags (execArgv) the engine needs as well.
	return executable(launcher) ? [launcher] : [process.execPath, ...process.execArgv, process.argv[1] ?? ""];
}

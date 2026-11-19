// Prism opens in the terminal or in its window.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { APP_NAME } from "../src/config.ts";
import {
	desktopEntry,
	desktopEntryPath,
	desktopIconPath,
	hasDesktopEntry,
	launcherCommand,
	type OpenIn,
	openWindow,
	READY_LINE,
	refreshDesktopEntry,
	removeDesktopEntry,
	type StartOptions,
	startInterface,
	webkitInstallCommand,
	windowBinary,
	windowProblem,
	writeDesktopEntry,
} from "../src/fork/launch-interface.ts";
import { opensWholeHome, windowWorkFolder } from "../src/fork/sandbox/home-start.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "prism-launch-"));
	dirs.push(dir);
	return dir;
}

function script(dir: string, name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** A release layout: <root>/gui/prism-gui and <root>/node_modules/@earendil-works/pi-coding-agent. */
function release(): { root: string; packageDir: string; binary: string } {
	const root = temp();
	const packageDir = join(root, "node_modules/@earendil-works/pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(join(root, "gui"));
	const binary = script(join(root, "gui"), "prism-gui", "exit 0");
	writeFileSync(join(root, "gui", `${APP_NAME}.png`), "png");
	return { root, packageDir, binary };
}

const hasGlib = spawnSync("python3", ["-c", "from gi.repository import GLib"]).status === 0;
/** The Exec key as GLib's desktop app info reads it: the string value, then its arguments, `%%` as `%`. */
const GLIB_EXEC_ARGV = [
	"import json, sys",
	"from gi.repository import GLib",
	"k = GLib.KeyFile()",
	"data = sys.stdin.read()",
	"k.load_from_data(data, len(data.encode()), GLib.KeyFileFlags.NONE)",
	"value = k.get_string('Desktop Entry', 'Exec').replace('%%', '%')",
	"print(json.dumps(GLib.shell_parse_argv(value)[1]))",
].join("\n");

function start(overrides: Partial<StartOptions> & { saved?: OpenIn; answers?: unknown[] }) {
	const asked: string[] = [];
	const said: string[] = [];
	const opened: string[] = [];
	let saved = overrides.saved;
	const answers = [...(overrides.answers ?? [])];
	const options: StartOptions = {
		flag: undefined,
		plain: true,
		terminal: true,
		cwd: "/work",
		setting: {
			get: () => saved,
			set: (value) => {
				saved = value;
			},
		},
		ask: async <T>(title: string) => {
			asked.push(title);
			return answers.shift() as T | undefined;
		},
		say: (message) => said.push(message),
		open: async (binary) => {
			opened.push(binary);
			return undefined;
		},
		...overrides,
	};
	return { options, asked, said, opened, saved: () => saved };
}

describe("fork: where Prism opens", () => {
	it("parses --gui and --tui", () => {
		expect(parseArgs(["--gui"]).openIn).toBe("window");
		expect(parseArgs(["--tui"]).openIn).toBe("terminal");
		expect(parseArgs([]).openIn).toBeUndefined();
	});

	it("finds the window next to a release's package, or by PRISM_GUI_BINARY", () => {
		const { packageDir, binary } = release();
		expect(windowBinary({}, packageDir)).toBe(binary);
		const other = script(temp(), "gui", "exit 0");
		expect(windowBinary({ PRISM_GUI_BINARY: other }, packageDir)).toBe(other);
		expect(windowBinary({}, join(temp(), "a/b/c"))).toBeUndefined();
		expect(windowProblem({}, join(temp(), "a/b/c"))).toContain("no window");
		expect(windowProblem({}, packageDir)).toContain("No graphical display");
		expect(windowProblem({ WAYLAND_DISPLAY: "wayland-0" }, packageDir)).toBeUndefined();
	});

	it("asks once, saves the answer, adds the menu entry, then opens the window", async () => {
		const { packageDir, binary } = release();
		const data = temp();
		const env = { WAYLAND_DISPLAY: "wayland-0", XDG_DATA_HOME: data };
		const run = start({ env, packageDir, answers: ["window"] });
		expect(await startInterface(run.options)).toBe("window");
		// LIV-04: choosing the window adds the menu entry, without a second question.
		expect(run.asked).toEqual(["Prism now has a window. How should it open from now on?"]);
		expect(run.said).toContain("Prism is in the applications menu.");
		expect(run.saved()).toBe("window");
		expect(run.opened).toEqual([binary]);
		const entry = readFileSync(desktopEntryPath(env), "utf8");
		expect(entry).toContain("Exec=");
		expect(entry).toContain(" --gui");
		expect(entry).toContain(`Icon=${APP_NAME}\n`);
		expect(existsSync(desktopIconPath(env))).toBe(true);
		expect(removeDesktopEntry(env)).toBe(true);
		expect(existsSync(desktopIconPath(env))).toBe(false);
		// Next launch: no question.
		const again = start({ env, packageDir, saved: "window" });
		expect(await startInterface(again.options)).toBe("window");
		expect(again.asked).toEqual([]);
	});

	// the menu entry starts Prism in the home folder, where limited reading blocked every command.
	// it works in ~/Prism, the same folder at each launch, not a new /tmp one.
	it("opens the window on the folder windowFolder gives, ~/Prism for the home folder", async () => {
		const { packageDir } = release();
		const env = { WAYLAND_DISPLAY: "wayland-0", XDG_DATA_HOME: temp() };
		const home = temp();
		const folders: string[] = [];
		for (let launch = 0; launch < 2; launch++) {
			const run = start({
				env,
				packageDir,
				saved: "window",
				cwd: homedir(),
				windowFolder: (cwd) => (opensWholeHome(cwd, temp()) ? windowWorkFolder(home) : cwd),
				open: async (_binary, cwd) => {
					folders.push(cwd);
					return undefined;
				},
			});
			expect(await startInterface(run.options)).toBe("window");
		}
		expect(folders).toEqual([join(home, "Prism"), join(home, "Prism")]);
		expect(existsSync(folders[0]!)).toBe(true);
	});

	it("asks again next time after Esc, and stays in the terminal when chosen", async () => {
		const { packageDir } = release();
		const env = { DISPLAY: ":0", XDG_DATA_HOME: temp() };
		const escaped = start({ env, packageDir, answers: [undefined] });
		expect(await startInterface(escaped.options)).toBe("terminal");
		expect(escaped.saved()).toBeUndefined();
		const terminal = start({ env, packageDir, answers: ["terminal"] });
		expect(await startInterface(terminal.options)).toBe("terminal");
		expect(terminal.saved()).toBe("terminal");
		expect(terminal.asked).toHaveLength(1);
		expect(terminal.opened).toEqual([]);
		expect(existsSync(desktopEntryPath(env))).toBe(false);
	});

	it("says so when the menu entry cannot be written, and still opens the window", async () => {
		const { packageDir } = release();
		// The data folder is a file: the entry's folder cannot be made.
		const blocked = join(temp(), "data");
		writeFileSync(blocked, "");
		const run = start({ env: { DISPLAY: ":0", XDG_DATA_HOME: blocked }, packageDir, answers: ["window"] });
		expect(await startInterface(run.options)).toBe("window");
		expect(run.said.some((line) => line.startsWith("Prism could not be added to the applications menu: "))).toBe(
			true,
		);
		expect(run.saved()).toBe("window");
	});

	it("never asks or opens a window for --tui, a message, or where the window cannot open", async () => {
		const { packageDir } = release();
		const env = { DISPLAY: ":0" };
		for (const overrides of [
			{ flag: "terminal" as const, saved: "window" as const },
			{ plain: false, saved: "window" as const },
			{ plain: false },
			{ env: {} },
			{ packageDir: join(temp(), "a/b/c") },
		]) {
			const run = start({ env, packageDir, ...overrides });
			expect(await startInterface(run.options)).toBe("terminal");
			expect(run.asked).toEqual([]);
			expect(run.opened).toEqual([]);
		}
	});

	it("--gui says why it cannot open, and fails without a terminal to fall back to", async () => {
		const { packageDir } = release();
		const noDisplay = start({ env: {}, packageDir, flag: "window" });
		expect(await startInterface(noDisplay.options)).toBe("terminal");
		expect(noDisplay.said[0]).toContain("No graphical display");
		const fromMenu = start({
			env: { DISPLAY: ":0" },
			packageDir,
			flag: "window",
			terminal: false,
			open: async () => "error while loading shared libraries: libwebkit2gtk-4.1.so.0",
		});
		expect(await startInterface(fromMenu.options)).toBe("failed");
		expect(fromMenu.said[0]).toContain("libwebkit2gtk");
		expect(fromMenu.asked).toEqual([]);
	});

	it("names the WebKitGTK install command of the distribution", () => {
		expect(webkitInstallCommand("NAME=CachyOS\nID=cachyos\nID_LIKE=arch\n")).toBe(
			"sudo pacman -S --needed webkit2gtk-4.1",
		);
		expect(webkitInstallCommand("ID=fedora\nVERSION_ID=44\n")).toBe("sudo dnf install webkit2gtk4.1");
		expect(webkitInstallCommand('ID=linuxmint\nID_LIKE="ubuntu debian"\n')).toBe(
			"sudo apt install libwebkit2gtk-4.1-0",
		);
		expect(webkitInstallCommand('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n')).toBe(
			"sudo zypper install libwebkit2gtk-4_1-0",
		);
		expect(webkitInstallCommand("ID=nixos\n")).toBeUndefined();
	});

	it("starts the window with this engine, and reports a window that cannot start", async () => {
		const dir = temp();
		const seen = join(dir, "env");
		const log = join(dir, "logs", "gui.log");
		const running = script(
			dir,
			"running",
			`printf '%s\\n%s\\n' "$PRISM_GUI_ENGINE" "$PRISM_GUI_ENGINE_ARGS" > "${seen}"; echo 'Gtk-WARNING: noise' >&2; echo '${READY_LINE}'; sleep 3; echo 'later warning' >&2`,
		);
		const started = Date.now();
		expect(await openWindow(running, dir, {}, ["/opt/prism/prism"], { log })).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(2000);
		expect(readFileSync(seen, "utf8")).toBe("/opt/prism/prism\n[]\n");
		const broken = script(
			dir,
			"broken",
			"echo 'prism-gui: error while loading shared libraries: libwebkit2gtk-4.1.so.0' >&2; exit 127",
		);
		const problem = await openWindow(broken, dir, {}, ["/opt/prism/prism"], { log });
		expect(problem).toContain("libwebkit2gtk-4.1.so.0");
		expect(problem).toContain(`whole log: ${log}`);
		const panic = script(
			dir,
			"panic",
			"printf '%s\\n' \"thread 'main' (12) panicked at tao/src/event_loop.rs:219:53:\" 'Failed to initialize gtk backend!' 'note: run with \\`RUST_BACKTRACE=1\\` environment variable' >&2; exit 101",
		);
		expect(await openWindow(panic, dir, {}, ["/p"], { log })).toMatch(
			/^Failed to initialize gtk backend!; whole log/,
		);
		expect(await openWindow(script(dir, "silent", "exit 3"), dir, {}, ["/p"], { log })).toBe(
			"the window stopped (exit code 3)",
		);
	});

	it("waits for the first frames, not a fixed delay, and keeps the window's messages in its log", async () => {
		// on Hyprland with NVIDIA, the window stopped at its first draw, after the old 1.5 s check.
		const dir = temp();
		const log = join(dir, "gui.log");
		const late = script(
			dir,
			"late",
			"sleep 2; printf '%s\\n' 'wl_display: error 71 (Protocol error) dispatching to Wayland display.' >&2; exit 1",
		);
		const problem = await openWindow(late, dir, {}, ["/p"], { log, timeoutMs: 10_000 });
		expect(problem).toContain("error 71 (Protocol error)");
		// A window still starting when Prism stops waiting is left running, and its log keeps what it says after.
		const slow = script(dir, "slow", "sleep 1; echo 'after the start' >&2; sleep 2");
		expect(await openWindow(slow, dir, {}, ["/p"], { log, timeoutMs: 300 })).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(readFileSync(log, "utf8")).toContain("after the start");
	});

	it("runs the menu entry through the launcher's own path, which survives updates", () => {
		const { packageDir } = release();
		const link = script(temp(), "prism", "exit 0");
		expect(launcherCommand(packageDir, { PRISM_LAUNCHER: link })).toEqual([link]);
		expect(launcherCommand(packageDir, {})).toEqual([process.execPath, ...process.execArgv, process.argv[1] ?? ""]);
		const root = join(packageDir, "../../..");
		const shipped = script(root, "prism", "exit 0");
		expect(launcherCommand(packageDir, {})).toEqual([shipped]);
	});

	it("writes a menu entry that quotes its command, and removes only its own", () => {
		const entry = desktopEntry(["/home/me/My Apps/prism"], "/home/me/My Apps/gui/prism.png");
		expect(entry).toContain('Exec="/home/me/My Apps/prism" --gui');
		expect(entry).toContain("Icon=/home/me/My Apps/gui/prism.png");
		const env = { XDG_DATA_HOME: temp() };
		mkdirSync(join(env.XDG_DATA_HOME, "applications"));
		writeFileSync(desktopEntryPath(env), "[Desktop Entry]\nExec=someone-else\n");
		expect(hasDesktopEntry(env)).toBe(false);
		expect(removeDesktopEntry(env)).toBe(false);
		expect(existsSync(desktopEntryPath(env))).toBe(true);
	});

	// fork: "--gui" anywhere in the file made a user's own entry Prism's.
	it("keeps a user's own entry that only mentions --gui, and its icon, even when the window is chosen", async () => {
		const { packageDir } = release();
		const data = temp();
		const env = { WAYLAND_DISPLAY: "wayland-0", XDG_DATA_HOME: data };
		mkdirSync(join(data, "applications"));
		mkdirSync(join(data, "icons/hicolor/256x256/apps"), { recursive: true });
		const own =
			"[Desktop Entry]\nType=Application\nName=Prism\nComment=My wrapper around prism --gui\nExec=my-prism\n";
		writeFileSync(desktopEntryPath(env), own);
		writeFileSync(desktopIconPath(env), "my icon");
		expect(hasDesktopEntry(env)).toBe(false);
		expect(removeDesktopEntry(env)).toBe(false);
		expect(writeDesktopEntry(["/opt/prism/prism"], undefined, env)).toBeUndefined();
		const run = start({ env, packageDir, answers: ["window"] });
		expect(await startInterface(run.options)).toBe("window");
		expect(run.said.join("\n")).toMatch(
			/could not be added to the applications menu: .*not written by Prism; it is kept/,
		);
		expect(readFileSync(desktopEntryPath(env), "utf8")).toBe(own);
		expect(readFileSync(desktopIconPath(env), "utf8")).toBe("my icon");
	});

	it("recognises its entry by its marker, and an entry written before the marker", () => {
		const env = { XDG_DATA_HOME: temp() };
		expect(writeDesktopEntry(["/opt/prism/prism"], undefined, env)).toBe(desktopEntryPath(env));
		expect(readFileSync(desktopEntryPath(env), "utf8")).toContain("\nX-Prism-Menu=true\n");
		expect(hasDesktopEntry(env)).toBe(true);
		const legacy = desktopEntry(["/opt/prism/prism"], APP_NAME)
			.replace("X-Prism-Menu=true\n", "")
			.replace("StartupWMClass=prism-gui\n", "");
		writeFileSync(desktopEntryPath(env), legacy);
		expect(hasDesktopEntry(env)).toBe(true);
		// The same file edited by the user is theirs.
		writeFileSync(desktopEntryPath(env), legacy.replace("Comment=AI coding agent", "Comment=Mine"));
		expect(hasDesktopEntry(env)).toBe(false);
	});

	// KDE showed a generic icon for the window, whose Wayland app id is prism-gui.
	it("names the window's class, and adds it to an entry written before", () => {
		const env = { XDG_DATA_HOME: temp() };
		writeDesktopEntry(["/opt/prism/prism"], undefined, env);
		expect(readFileSync(desktopEntryPath(env), "utf8")).toContain("\nStartupWMClass=prism-gui\n");
		expect(refreshDesktopEntry(env)).toBe(false);
		const before = desktopEntry(["/opt/prism/prism"], APP_NAME).replace("StartupWMClass=prism-gui\n", "");
		writeFileSync(desktopEntryPath(env), before);
		expect(refreshDesktopEntry(env)).toBe(true);
		expect(readFileSync(desktopEntryPath(env), "utf8")).toBe(desktopEntry(["/opt/prism/prism"], APP_NAME));
		// Someone else's entry of that name is left alone.
		writeFileSync(desktopEntryPath(env), "[Desktop Entry]\nName=Mine\n");
		expect(refreshDesktopEntry(env)).toBe(false);
		expect(readFileSync(desktopEntryPath(env), "utf8")).toBe("[Desktop Entry]\nName=Mine\n");
	});
	it("stays in the terminal, and says so, when the window would drop this launch's arguments", async () => {
		const { packageDir } = release();
		const env = { WAYLAND_DISPLAY: "wayland-0", XDG_DATA_HOME: temp() };
		for (const launchArgs of [["--safe"], ["--no-approve"], ["--tools", "read"], ["fix the tests"]]) {
			const run = start({ env, packageDir, flag: "window", launchArgs });
			expect(await startInterface(run.options)).toBe("terminal");
			expect(run.opened).toEqual([]);
			expect(run.said.join("\n")).toContain(launchArgs.join(" "));
		}
		const plain = start({ env, packageDir, flag: "window", launchArgs: [] });
		expect(await startInterface(plain.options)).toBe("window");
	});

	it.skipIf(!hasGlib)("writes an Exec line GLib reads back as the launcher's own words", () => {
		for (const path of [
			"/home/u/apps/prism$work/prism",
			'/home/u/a"b/prism',
			"/home/u/a\\b/prism",
			"/home/u/a`b`/prism",
			"/home/u/100%/prism",
			"/home/u/line\nbreak/prism",
		]) {
			const entry = desktopEntry([path], undefined);
			const read = execFileSync("python3", ["-c", GLIB_EXEC_ARGV], { input: entry, encoding: "utf8" });
			expect(JSON.parse(read), path).toEqual([path, "--gui"]);
		}
	});
});

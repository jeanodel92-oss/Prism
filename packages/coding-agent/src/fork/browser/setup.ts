/**
 * `/browser setup`, the declarations that let a browser start Prism's native messaging host
 * for the Prism extension, and the launcher script they point to.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, getPackageDir, isBunBinary } from "../../config.ts";
import { hostCommand } from "../host-program.ts";
import { shellQuote } from "../sandbox/shell-quote.ts";
import { CHROMIUM_EXTENSION_ID, FIREFOX_EXTENSION_ID, NATIVE_HOST_NAME } from "./protocol.ts";

/**
 * Chromium-family browsers, by their folder under ~/.config; `hosts` is the folder whose NativeMessagingHosts it reads
 * when that is another one. Opera reads Chrome's.
 */
export const CHROMIUM_BROWSERS: ReadonlyArray<{ name: string; dir: string; hosts?: string }> = [
	{ name: "Chromium", dir: "chromium" },
	{ name: "Google Chrome", dir: "google-chrome" },
	{ name: "Google Chrome Beta", dir: "google-chrome-beta" },
	{ name: "Google Chrome Dev", dir: "google-chrome-unstable" },
	{ name: "Brave", dir: "BraveSoftware/Brave-Browser" },
	{ name: "Vivaldi", dir: "vivaldi" },
	{ name: "Microsoft Edge", dir: "microsoft-edge" },
	{ name: "Helium", dir: "net.imput.helium" },
	{ name: "Opera", dir: "opera", hosts: "google-chrome" },
];

/** Firefox-family browsers: found by one of `found` in the home folder, they read `hosts`. */
export const FIREFOX_BROWSERS: ReadonlyArray<{ name: string; found: readonly string[]; hosts: string }> = [
	// Firefox reads ~/.mozilla; recent versions keep their profiles under ~/.config/mozilla.
	{ name: "Firefox", found: [".mozilla", ".config/mozilla"], hosts: ".mozilla/native-messaging-hosts" },
	// fork: Zen 1.24 keeps its profiles under ~/.config/zen and, like Firefox, reads
	// ~/.mozilla (measured with zen-browser-bin 1.24.3b and ~/.mozilla present). Older versions use ~/.zen. The first
	// entry that matches a name wins.
	{ name: "Zen", found: [".config/zen"], hosts: ".mozilla/native-messaging-hosts" },
	{ name: "Zen", found: [".zen"], hosts: ".zen/native-messaging-hosts" },
	// fork: the folders a real LibreWolf and Waterfox read, probed in their Flatpak builds.
	{ name: "LibreWolf", found: [".librewolf"], hosts: ".librewolf/native-messaging-hosts" },
	{ name: "Waterfox", found: [".waterfox"], hosts: ".waterfox/native-messaging-hosts" },
];

/**
 * Flatpak browsers, by application id. `hosts` is under the app's own folder, ~/.var/app/<app>, which the sandbox
 * mounts at the same path: the launcher written there is visible inside, and leaves the sandbox through
 * `flatpak-spawn --host`, which needs the app to talk to org.freedesktop.Flatpak.
 */
export const FLATPAK_BROWSERS: ReadonlyArray<{
	name: string;
	app: string;
	family: "chromium" | "firefox";
	hosts: string;
	/**
	 * fork: recent Firefox-based Flatpaks (Zen 1.23) send native messaging through a portal
	 * this computer lacks, so the host declared under `hosts` is never read: "No such native application". With the
	 * pref `widget.use-xdg-desktop-portal.native-messaging` at 0 the browser reads `~/.mozilla/native-messaging-hosts`
	 * instead, which the sandbox only keeps when the app persists `.mozilla`.
	 */
	portalNativeMessaging?: boolean;
}> = [
	{
		name: "Chromium",
		app: "org.chromium.Chromium",
		family: "chromium",
		hosts: "config/chromium/NativeMessagingHosts",
	},
	{
		name: "Google Chrome",
		app: "com.google.Chrome",
		family: "chromium",
		hosts: "config/google-chrome/NativeMessagingHosts",
	},
	{
		name: "Brave",
		app: "com.brave.Browser",
		family: "chromium",
		hosts: "config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
	},
	{ name: "Vivaldi", app: "com.vivaldi.Vivaldi", family: "chromium", hosts: "config/vivaldi/NativeMessagingHosts" },
	{
		name: "Microsoft Edge",
		app: "com.microsoft.Edge",
		family: "chromium",
		hosts: "config/microsoft-edge/NativeMessagingHosts",
	},
	{ name: "Firefox", app: "org.mozilla.firefox", family: "firefox", hosts: ".mozilla/native-messaging-hosts" },
	{
		name: "Zen",
		app: "app.zen_browser.zen",
		family: "firefox",
		hosts: ".zen/native-messaging-hosts",
		portalNativeMessaging: true,
	},
	// fork: each probed in the real Flatpak with a host per candidate folder.
	{
		name: "LibreWolf",
		app: "io.gitlab.librewolf-community",
		family: "firefox",
		hosts: ".librewolf/native-messaging-hosts",
	},
	{ name: "Waterfox", app: "net.waterfox.waterfox", family: "firefox", hosts: ".waterfox/native-messaging-hosts" },
	{ name: "Opera", app: "com.opera.Opera", family: "chromium", hosts: "config/google-chrome/NativeMessagingHosts" },
	{
		name: "Ungoogled Chromium",
		app: "io.github.ungoogled_software.ungoogled_chromium",
		family: "chromium",
		hosts: "config/chromium/NativeMessagingHosts",
	},
];

/** The permission `flatpak-spawn --host` needs, as `flatpak override` and `flatpak info` write it. */
export const FLATPAK_HOST_ACCESS = "org.freedesktop.Flatpak=talk";

/** The unpacked extension shipped with Prism. */
export function browserExtensionDir(): string {
	return join(getPackageDir(), "browser-extension");
}

/** The command that starts this Prism: the installed launcher, the binary, or node with the entry script. */
export function prismCommand(env: NodeJS.ProcessEnv = process.env): string[] {
	if (env.PRISM_LAUNCHER) return [env.PRISM_LAUNCHER];
	if (isBunBinary) return [process.execPath];
	return [process.execPath, process.argv[1] ?? ""];
}

export function hostLauncherScript(command: readonly string[], flatpak = false): string {
	return [
		"#!/bin/sh",
		flatpak
			? "# Written by Prism (/browser setup): starts Prism's browser host outside the browser's Flatpak sandbox."
			: "# Written by Prism (/browser setup): starts Prism's browser host for the Prism extension.",
		`exec ${flatpak ? "flatpak-spawn --host " : ""}${command.map(shellQuote).join(" ")} browser-host "$@"`,
		"",
	].join("\n");
}

/** Whether a Flatpak app may run `flatpak-spawn --host`: its own permissions or the user's overrides. */
export function flatpakHasHostAccess(app: string, home = homedir()): boolean {
	const info = spawnSync(hostCommand("flatpak"), ["info", "--show-permissions", app], {
		encoding: "utf8",
		timeout: 5000,
	});
	if (info.status === 0 && info.stdout.includes(FLATPAK_HOST_ACCESS)) return true;
	try {
		return readFileSync(join(home, ".local/share/flatpak/overrides", app), "utf8").includes(FLATPAK_HOST_ACCESS);
	} catch {
		return false;
	}
}

/** `flatpak override --user`: lets the app start programs outside its sandbox. Only after the user agreed. */
export function grantFlatpakHostAccess(app: string, extra: readonly string[] = []): void {
	const result = spawnSync(
		hostCommand("flatpak"),
		["override", "--user", "--talk-name=org.freedesktop.Flatpak", ...extra, app],
		{
			encoding: "utf8",
			timeout: 10000,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `flatpak override exited with ${result.status}`);
}

/** The permissions of a Flatpak app as text: its own, then the user's overrides. */
export function flatpakPermissionText(app: string, home = homedir()): string {
	const info = spawnSync(hostCommand("flatpak"), ["info", "--show-permissions", app], {
		encoding: "utf8",
		timeout: 5000,
	});
	let overrides = "";
	try {
		overrides = readFileSync(join(home, ".local/share/flatpak/overrides", app), "utf8");
	} catch {
		// No override file: nothing granted by the user.
	}
	return `${info.status === 0 ? info.stdout : ""}\n${overrides}`;
}

/** Whether `permissions` (as `flatpak info --show-permissions` prints them) let the app write `dir` itself. */
function canWriteFolder(permissions: string, dir: string): boolean {
	return permissions
		.split("\n")
		.filter((line) => line.startsWith("filesystems="))
		.some((line) =>
			line
				.slice("filesystems=".length)
				.split(";")
				.some((entry) => entry === dir || entry === `${dir}:rw`),
		);
}

/**
 * The `flatpak override` arguments, beyond the host access, a Flatpak browser still needs: access to the extension
 * folder, and `.mozilla` kept for the portal case above.
 *
 * fork: the folder must be writable, not read only. Firefox's portal
 * file picker sends no `writable` option, so xdg-desktop-portal (1.22, file-chooser.c) asks for read and write; with
 * read-only access the document portal then shares a copy of manifest.json alone, under /run/user/<uid>/doc, and
 * Zen failed to load background.js. With read and write access it hands over the real path.
 */
export function flatpakExtraGrants(browser: FoundBrowser, permissions: string, extensionRoot: string): string[] {
	const grants: string[] = [];
	if (browser.family === "firefox" && !canWriteFolder(permissions, extensionRoot)) {
		grants.push(`--filesystem=${extensionRoot}`);
	}
	if (browser.extraHostsDir && !/persistent=[^\n]*\.mozilla/.test(permissions)) grants.push("--persist=.mozilla");
	return grants;
}

export interface BrowserSetupResult {
	launcher: string;
	/** Browser name -> the declaration written for it; `flatpak` for a browser in a Flatpak sandbox. */
	written: Array<{
		browser: string;
		path: string;
		flatpak?: { app: string; hostAccess: boolean; extra: string[] };
	}>;
	extensionDir: string;
	/** The Firefox copy, for Load Temporary Add-on: its manifest differs from the Chromium one. */
	firefoxExtensionDir: string;
}

export interface BrowserSetupOptions {
	home?: string;
	agentDir?: string;
	command?: readonly string[];
	/** For tests: whether a Flatpak app may leave its sandbox. */
	hostAccess?: (app: string) => boolean;
	/** For tests: the permissions of a Flatpak app, as text. */
	permissions?: (app: string) => string;
	/** Which browsers found count: the installed ones, as the guided setup lists them. */
	installed?: (browser: FoundBrowser) => boolean;
}

/** A browser found in the home folder: where its host declaration goes. */
export interface FoundBrowser {
	name: string;
	family: "chromium" | "firefox";
	/** The folder of its host declarations. */
	hostsDir: string;
	/** In a Flatpak sandbox: its application id. */
	flatpak?: string;
	/** Flatpak browser that needs the portal pref at 0: where it then reads the host declaration (`.mozilla`). */
	extraHostsDir?: string;
	/** Its folder under ~/.config (Chromium family, outside Flatpak). */
	configDir?: string;
}

/** The browsers found in the home folder, in the order /browser setup lists them. */
export function detectBrowsers(home = homedir()): FoundBrowser[] {
	const found: FoundBrowser[] = [];
	for (const browser of CHROMIUM_BROWSERS) {
		const config = join(home, ".config", browser.dir);
		if (existsSync(config)) {
			found.push({
				name: browser.name,
				family: "chromium",
				hostsDir: join(home, ".config", browser.hosts ?? browser.dir, "NativeMessagingHosts"),
				configDir: browser.dir,
			});
		}
	}
	for (const browser of FIREFOX_BROWSERS) {
		if (found.some((other) => other.name === browser.name)) continue;
		if (browser.found.some((dir) => existsSync(join(home, dir)))) {
			found.push({ name: browser.name, family: "firefox", hostsDir: join(home, browser.hosts) });
		}
	}
	for (const browser of FLATPAK_BROWSERS) {
		const appDir = join(home, ".var", "app", browser.app);
		if (!existsSync(appDir)) continue;
		found.push({
			name: `${browser.name} (Flatpak)`,
			family: browser.family,
			hostsDir: join(appDir, browser.hosts),
			flatpak: browser.app,
			...(browser.portalNativeMessaging
				? { extraHostsDir: join(appDir, ".mozilla", "native-messaging-hosts") }
				: {}),
		});
	}
	return found;
}

/**
 * fork: Firefox warned about `debugger` and `key` in the manifest, both Chromium's own. Firefox
 * loads a copy of the extension whose manifest has neither, and a background script instead of a service worker.
 */
export function firefoxManifest(manifest: Record<string, unknown>): Record<string, unknown> {
	const { key: _key, ...rest } = manifest;
	const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
	return {
		...rest,
		permissions: permissions.filter((permission) => permission !== "debugger"),
		background: { scripts: ["background.js"] },
	};
}

/**
 * fork: the folder a browser's "load unpacked" dialog must reach. A file picker (Zen's, a
 * Flatpak's portal) cannot paste a path or show hidden folders, so the copies of the extension live in `~/Prism`:
 * visible in any picker, short to type, stable across updates (the install folder changes with each version, and
 * `~/.prism` is hidden). Under a Flatpak browser the portal picker reads any folder the user picks.
 */
export function visibleExtensionRoot(home = homedir()): string {
	return join(home, "Prism");
}

const CHROMIUM_COPY = "browser-extension";
const FIREFOX_COPY = "browser-extension-firefox";

/**
 * the copies of the extension `/browser setup` writes. A browser loads them again at each start,
 * outside the sandbox, with the extension's rights; the sandbox keeps them read-only for commands (`layout.ts`).
 */
export function extensionCopies(home = homedir()): string[] {
	return [CHROMIUM_COPY, FIREFOX_COPY].map((name) => join(visibleExtensionRoot(home), name));
}

/**
 * the build of the extension Prism ships, a digest of its files. The
 * copy `/browser setup` writes carries it in `prism-build.json`, which the extension sends in its hello, so Prism
 * can say when the browser runs an extension from another version of Prism.
 */
export const EXTENSION_BUILD_FILE = "prism-build.json";
const builds = new Map<string, string>();
export function extensionBuild(source = browserExtensionDir()): string {
	const cached = builds.get(source);
	if (cached) return cached;
	const hash = createHash("sha256");
	const walk = (relative: string) => {
		for (const entry of readdirSync(join(source, relative), { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(path);
			else if (path !== EXTENSION_BUILD_FILE) hash.update(`${path}\0`).update(readFileSync(join(source, path)));
		}
	};
	walk("");
	const build = hash.digest("hex").slice(0, 16);
	builds.set(source, build);
	return build;
}

/** The version in the manifest of the extension this Prism ships: what a store install (AMO, Chrome Web Store) is compared by. */
export function shippedExtensionVersion(source = browserExtensionDir()): string {
	return String(
		(JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as { version?: unknown }).version ?? "",
	);
}

/** Replaces `dir` with a fresh copy of the extension, so a file Prism removed does not linger in an old copy. */
function freshCopy(source: string, dir: string): void {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	cpSync(source, dir, { recursive: true });
	writeFileSync(join(dir, EXTENSION_BUILD_FILE), `${JSON.stringify({ build: extensionBuild(source) })}\n`);
}

/** Copies the extension, manifest `key` included (it fixes the extension id), under `root`; its path. */
export function writeChromiumExtension(root = visibleExtensionRoot(), source = browserExtensionDir()): string {
	const dir = join(root, CHROMIUM_COPY);
	freshCopy(source, dir);
	return dir;
}

/** Writes the Firefox copy of the extension under `root`; its path, for Load Temporary Add-on. */
export function writeFirefoxExtension(root = visibleExtensionRoot(), source = browserExtensionDir()): string {
	const dir = join(root, FIREFOX_COPY);
	freshCopy(source, dir);
	const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as Record<string, unknown>;
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(firefoxManifest(manifest), null, "\t")}\n`);
	return dir;
}

/** The folder a browser of this family loads the extension from: a fresh copy, refreshed at each setup. */
export function extensionDirFor(family: "chromium" | "firefox", root?: string): string {
	return family === "firefox" ? writeFirefoxExtension(root) : writeChromiumExtension(root);
}

/**
 * The extension's page in the add-on store of a browser family, where `/browser setup` sends the user first: accepted
 * and published on addons.mozilla.org and the Chrome Web Store. The store install updates itself, survives a restart,
 * and needs no folder a Flatpak browser would have to reach.
 */
export function extensionStorePage(family: "chromium" | "firefox"): string {
	return family === "firefox"
		? "https://addons.mozilla.org/addon/prism-browser/"
		: `https://chromewebstore.google.com/detail/prism/${CHROMIUM_EXTENSION_ID}`;
}

/** The page where the user adds an unpacked or temporary extension. */
export function extensionsPage(family: "chromium" | "firefox"): string {
	return family === "firefox" ? "about:debugging#/runtime/this-firefox" : "chrome://extensions";
}

/** Program names of each browser, the first one on PATH starts it (Flatpak: flatpak run). */
const BROWSER_PROGRAMS: Readonly<Record<string, readonly string[]>> = {
	Chromium: ["chromium-browser", "chromium"],
	"Google Chrome": ["google-chrome", "google-chrome-stable"],
	"Google Chrome Beta": ["google-chrome-beta"],
	"Google Chrome Dev": ["google-chrome-unstable"],
	Brave: ["brave-browser", "brave"],
	Vivaldi: ["vivaldi", "vivaldi-stable"],
	"Microsoft Edge": ["microsoft-edge", "microsoft-edge-stable"],
	Helium: ["helium", "helium-browser"],
	Firefox: ["firefox"],
	Zen: ["zen", "zen-browser"],
	Opera: ["opera"],
	LibreWolf: ["librewolf"],
	Waterfox: ["waterfox"],
};

/**
 * /browser setup listed browsers whose folder stayed after they were removed.
 * Installed means: a Flatpak app installed for the user or the system; another browser's program on PATH, or named by
 * the Exec line of a desktop entry (a browser unpacked in /opt is often started that way).
 */
export function isInstalledBrowser(
	browser: FoundBrowser,
	options: { onPath: (program: string) => boolean; home?: string; dataDirs?: readonly string[] },
): boolean {
	const home = options.home ?? homedir();
	if (browser.flatpak) {
		return [join(home, ".local/share/flatpak/app"), "/var/lib/flatpak/app"].some((dir) =>
			existsSync(join(dir, browser.flatpak!)),
		);
	}
	const programs = BROWSER_PROGRAMS[browser.name] ?? [];
	// Each program alone: an onPath(command, path) given as is would take the index for its PATH.
	if (programs.some((program) => options.onPath(program))) return true;
	const dataDirs = options.dataDirs ?? [
		process.env.XDG_DATA_HOME || join(home, ".local/share"),
		...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean),
	];
	for (const dir of dataDirs) {
		let entries: string[];
		try {
			entries = readdirSync(join(dir, "applications")).filter((name) => name.endsWith(".desktop"));
		} catch {
			continue;
		}
		for (const entry of entries) {
			let text: string;
			try {
				text = readFileSync(join(dir, "applications", entry), "utf8");
			} catch {
				continue;
			}
			const exec = /^Exec=\s*(?:env\s+(?:\S+=\S+\s+)*)?"?([^"\s]+)/m.exec(text)?.[1];
			if (exec && programs.includes(basename(exec))) return true;
		}
	}
	return false;
}

/** The command that opens the browser, or undefined when Prism cannot find its program. */
export function browserCommand(browser: FoundBrowser, onPath: (program: string) => boolean): string[] | undefined {
	if (browser.flatpak) return onPath("flatpak") ? ["flatpak", "run", browser.flatpak] : undefined;
	const program = BROWSER_PROGRAMS[browser.name]?.find((name) => onPath(name));
	return program ? [program] : undefined;
}

/** Writes the launcher Prism's host runs through; its path. */
function writeLauncher(agentDir: string, command: readonly string[]): string {
	const launcherDir = join(agentDir, "browser");
	mkdirSync(launcherDir, { recursive: true });
	const launcher = join(launcherDir, "prism-browser-host");
	writeFileSync(launcher, hostLauncherScript(command));
	chmodSync(launcher, 0o755);
	return launcher;
}

/** Declares Prism's host to one browser; for a Flatpak one, with a launcher that leaves its sandbox. */
export function declareHost(
	browser: FoundBrowser,
	options: {
		agentDir?: string;
		command?: readonly string[];
		hostAccess?: (app: string) => boolean;
		permissions?: (app: string) => string;
		home?: string;
	} = {},
): BrowserSetupResult["written"][number] {
	const command = options.command ?? prismCommand();
	const launcher = writeLauncher(options.agentDir ?? getAgentDir(), command);
	const declare = (hostsDir: string): string => {
		mkdirSync(hostsDir, { recursive: true });
		let path = launcher;
		if (browser.flatpak) {
			// Inside the sandbox, the browser cannot run Prism: this launcher, next to the declaration, starts it outside.
			path = join(hostsDir, "prism-browser-host");
			writeFileSync(path, hostLauncherScript(command, true));
			chmodSync(path, 0o755);
		}
		const manifest = {
			name: NATIVE_HOST_NAME,
			description: "Prism browser host",
			path,
			type: "stdio",
			...(browser.family === "chromium"
				? { allowed_origins: [`chrome-extension://${CHROMIUM_EXTENSION_ID}/`] }
				: { allowed_extensions: [FIREFOX_EXTENSION_ID] }),
		};
		const file = join(hostsDir, `${NATIVE_HOST_NAME}.json`);
		writeFileSync(file, `${JSON.stringify(manifest, null, "\t")}\n`);
		return file;
	};
	const file = declare(browser.hostsDir);
	if (browser.extraHostsDir) declare(browser.extraHostsDir);
	const home = options.home ?? homedir();
	const hostAccess = options.hostAccess ?? ((app: string) => flatpakHasHostAccess(app, options.home));
	const permissions = options.permissions ?? ((app: string) => flatpakPermissionText(app, options.home));
	return {
		browser: browser.name,
		path: file,
		...(browser.flatpak
			? {
					flatpak: {
						app: browser.flatpak,
						hostAccess: hostAccess(browser.flatpak),
						extra: flatpakExtraGrants(browser, permissions(browser.flatpak), visibleExtensionRoot(home)),
					},
				}
			: {}),
	};
}

/** Writes the launcher and a host declaration for each browser found in the home folder. */
export function installNativeHosts(options: BrowserSetupOptions = {}): BrowserSetupResult {
	const home = options.home ?? homedir();
	const agentDir = options.agentDir ?? getAgentDir();
	const command = options.command ?? prismCommand();
	const launcher = writeLauncher(agentDir, command);
	const found = detectBrowsers(home).filter((browser) => options.installed?.(browser) ?? true);
	const written = found.map((browser) =>
		declareHost(browser, {
			agentDir,
			command,
			home,
			...(options.hostAccess ? { hostAccess: options.hostAccess } : {}),
			...(options.permissions ? { permissions: options.permissions } : {}),
		}),
	);
	return {
		launcher,
		written,
		extensionDir: writeChromiumExtension(join(home, "Prism")),
		firefoxExtensionDir: writeFirefoxExtension(join(home, "Prism")),
	};
}

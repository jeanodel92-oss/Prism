// fork: `/browser setup` failed at once with "path12.split is not a
// function": the list of installed browsers passed onPath(command, path) to Array.some, which gave it the index as its
// PATH. The wizard's own tests stubbed every dependency, so none ran the real ones. These run the real command of the
// browser module, with its real dependencies, in a throwaway home: browsers detected and filtered (installed, or only
// a folder left), host declarations, the Flatpak grant, the browser opened, the address and the folder copied, the
// extension folders, the wait for the extension, the end-to-end check through a fake host, the choice saved; in the
// terminal, in the window's native screens, at session start, and without an interactive client (print mode).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import browserExtension, { PREFERRED_BROWSER_SETTING } from "../src/fork/browser/index.ts";
import { CHROMIUM_EXTENSION_ID, FIREFOX_EXTENSION_ID, NATIVE_HOST_NAME } from "../src/fork/browser/protocol.ts";
import { extensionBuild, shippedExtensionVersion } from "../src/fork/browser/setup.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { setViewsClient } from "../src/fork/interactive-client.ts";

type Handler = (args: string, ctx: ExtensionContext) => Promise<void>;
type Listener = (event: { reason: string }, ctx: ExtensionContext) => Promise<void>;

let root: string;
let home: string;
let bin: string;
let log: string;
let socketDir: string;
let hostServer: Server | undefined;
/** Connections a session left open: closed with the fake host, which otherwise waits for them. */
const hostSockets: Socket[] = [];

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

function script(name: string, body: string): void {
	const path = join(bin, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

async function until(test: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!test()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** The browser module with a fake API: its command, its session_start listener. */
function load(): { command: Handler; sessionStart: Listener; shutdown: Listener } {
	let command: Handler | undefined;
	const listeners = new Map<string, Listener>();
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, options: { handler: Handler }) => {
			if (name === "browser") command = options.handler;
		},
		on: (event: string, listener: Listener) => listeners.set(event, listener),
	} as unknown as ExtensionAPI;
	browserExtension(pi);
	return {
		command: command!,
		sessionStart: listeners.get("session_start")!,
		shutdown: listeners.get("session_shutdown")!,
	};
}

/** A fake browser host: the extension in `name`, answering the setup's check (a tab opened, listed, closed). */
async function startHost(name: string, build?: string, extension?: string): Promise<void> {
	mkdirSync(socketDir, { recursive: true, mode: 0o700 });
	hostServer = createServer((socket) => {
		hostSockets.push(socket);
		let pending = "";
		socket.on("data", (chunk) => {
			pending += chunk.toString("utf8");
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines.filter(Boolean)) {
				const { id, cmd } = JSON.parse(line) as { id: number; cmd: string };
				const result =
					cmd === "hello"
						? { name, version: "140.0.1", extension, realInput: true, stopped: false, build }
						: cmd === "open"
							? { tab: 7 }
							: cmd === "tabs"
								? { tabs: [{ tab: 7 }] }
								: {};
				socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
			}
		});
	});
	await new Promise<void>((resolve) => hostServer!.listen(join(socketDir, "fake.sock"), resolve));
}

interface Shown {
	text: string;
	labels: string[];
}

/** A user: given a screen's text and choices, the label to pick, or undefined for Back/Escape. */
type User = (shown: Shown) => string | undefined | Promise<string | undefined>;

/** A terminal session whose dialogs a scripted user answers; what it showed and notified. */
function terminal(user: User) {
	const shown: Shown[] = [];
	const notes: Array<{ text: string; kind: string | undefined }> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: home,
		sessionManager: { getSessionId: () => "s1" },
		ui: {
			notify: (text: string, kind?: string) => notes.push({ text, kind }),
			confirm: async () => true,
			select: async (text: string, labels: string[], options?: { signal?: AbortSignal }) => {
				const screen = { text, labels };
				shown.push(screen);
				const signal = options?.signal;
				// The waiting screen closes itself when the check is done.
				if (labels.length === 1 && /Waiting for the Prism extension/.test(text) && signal) {
					const picked = await Promise.race([
						new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined))),
						Promise.resolve(user(screen)),
					]);
					return picked;
				}
				return user(screen);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, shown, notes };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "prism-browser-setup-"));
	home = join(root, "home");
	bin = join(root, "bin");
	log = join(root, "log");
	socketDir = join(root, "run", "prism-browser");
	mkdirSync(bin, { recursive: true });
	// Installed: Chromium (its program on PATH), Firefox (a desktop entry starting it from /opt), Zen's Flatpak.
	mkdirSync(join(home, ".config/chromium"), { recursive: true });
	mkdirSync(join(home, ".mozilla"), { recursive: true });
	mkdirSync(join(home, ".local/share/applications"), { recursive: true });
	writeFileSync(
		join(home, ".local/share/applications/firefox.desktop"),
		"[Desktop Entry]\nName=Firefox\nExec=/opt/firefox/firefox %u\n",
	);
	mkdirSync(join(home, ".var/app/app.zen_browser.zen"), { recursive: true });
	mkdirSync(join(home, ".local/share/flatpak/app/app.zen_browser.zen"), { recursive: true });
	// Removed, their folders left: Google Chrome and Brave, and Chromium's Flatpak.
	mkdirSync(join(home, ".config/google-chrome"), { recursive: true });
	mkdirSync(join(home, ".config/BraveSoftware/Brave-Browser"), { recursive: true });
	mkdirSync(join(home, ".var/app/org.chromium.Chromium"), { recursive: true });
	script("chromium", `echo "chromium $*" >> "${log}"`);
	script("flatpak", `if [ "$1" = info ]; then exit 1; fi\necho "flatpak $*" >> "${log}"`);
	script("wl-copy", `/usr/bin/cat > "${join(root, "clipboard")}"`);
	vi.stubEnv("HOME", home);
	// Only the fake programs: a real browser of this computer must not count, nor start.
	vi.stubEnv("PATH", bin);
	vi.stubEnv("XDG_DATA_HOME", join(home, ".local/share"));
	vi.stubEnv("XDG_DATA_DIRS", join(root, "share"));
	vi.stubEnv("XDG_RUNTIME_DIR", join(root, "run"));
	vi.stubEnv("PRISM_BROWSER_SOCKET_DIR", socketDir);
	vi.stubEnv("PRISM_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("WAYLAND_DISPLAY", "wayland-test");
	vi.stubEnv("DISPLAY", undefined);
	vi.stubEnv("PRISM_REMOTE_CLIENT", undefined);
	vi.stubEnv("PRISM_LAUNCHER", "/opt/prism/prism");
});

async function stopHost(): Promise<void> {
	for (const socket of hostSockets.splice(0)) socket.destroy();
	await new Promise<void>((resolve) => (hostServer ? hostServer.close(() => resolve()) : resolve()));
	hostServer = undefined;
}

afterEach(async () => {
	await stopHost();
	vi.unstubAllEnvs();
	setLanguage("en");
	rmSync(root, { recursive: true, force: true });
});

describe("fork: /browser setup, the real command in a throwaway home", () => {
	it("goes from the list to a linked browser in the terminal, each step done for real", async () => {
		const { command, shutdown } = load();
		const steps: string[] = [];
		const { ctx, shown, notes } = terminal(async ({ text, labels }) => {
			const step = steps.length;
			steps.push(labels.join(" | "));
			switch (step) {
				case 0:
					return "Chromium";
				case 1:
					return "Open the page in Chromium";
				case 2:
					await until(() => read(log).includes("chromium"));
					return "Copy the address";
				case 3:
					return "Load from a folder instead";
				case 4:
					return "Copy the folder path";
				case 5:
					await startHost("Chromium");
					return "It is added: check";
				case 6:
					// The waiting screen: never answered, the check ends it.
					return new Promise<undefined>(() => {});
				default:
					expect(text).toContain("Chromium is linked");
					return "Done";
			}
		});

		await command("setup", ctx);

		// Only the browsers installed are offered; the folders left by removed ones are not.
		expect(shown[0]!.labels).toEqual(["Chromium", "Firefox", "Zen (Flatpak)"]);
		expect(notes.filter((note) => note.kind === "error")).toEqual([]);
		// Step 2: Chromium's host declared, launched by Prism's launcher.
		const declaration = JSON.parse(
			read(join(home, ".config/chromium/NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`)),
		) as { path: string; allowed_origins: string[] };
		expect(declaration.allowed_origins).toEqual([`chrome-extension://${CHROMIUM_EXTENSION_ID}/`]);
		expect(read(declaration.path)).toContain("exec /opt/prism/prism browser-host");
		// The store first: its page opened in Chromium and its address copied. Then the folder, for a browser without
		// the store: the extensions page and the folder named, the folder copied.
		const store = `https://chromewebstore.google.com/detail/prism/${CHROMIUM_EXTENSION_ID}`;
		expect(shown[1]!.text).toContain(store);
		expect(shown[1]!.text).not.toContain("chrome://extensions");
		expect(read(log)).toContain(`chromium ${store}`);
		expect(shown[2]!.text).toContain("Chromium opened.");
		expect(shown[3]!.text).toContain(`${store} copied`);
		const extension = shown[4]!.text;
		expect(extension).toContain("chrome://extensions");
		const folder = /select this folder: (\S+)/.exec(extension)![1]!;
		expect(JSON.parse(read(join(folder, "manifest.json"))).manifest_version).toBe(3);
		expect(shown[5]!.text).toContain("Folder path copied.");
		expect(read(join(root, "clipboard"))).toBe(folder);
		// Step 3: the check went through the host, and Chromium is the browser the agent uses from now on.
		expect(shown.at(-1)!.text).toContain("Checked: Prism opened, read and closed a tab of its own");
		const settings = JSON.parse(read(join(root, "agent", "settings.json"))) as Record<string, unknown>;
		expect(settings[PREFERRED_BROWSER_SETTING]).toBe("Chromium");
		await shutdown({ reason: "quit" }, ctx);
	});

	it("sets up a Flatpak Zen: asks, grants, says to restart first, opens it through flatpak", async () => {
		const { command } = load();
		let folderAsked = false;
		let openedStore = false;
		let openedPlain = false;
		const { ctx, shown } = terminal(({ text, labels }) => {
			if (labels.includes("Zen (Flatpak)") && shown.length === 1) return "Zen (Flatpak)";
			if (labels.includes("Allow and continue")) {
				if (text.includes("--filesystem=")) folderAsked = true;
				return "Allow and continue";
			}
			if (labels.includes("Open the page in Zen (Flatpak)") && !openedStore) {
				openedStore = true;
				return "Open the page in Zen (Flatpak)";
			}
			if (labels.includes("Load from a folder instead") && !folderAsked) return "Load from a folder instead";
			if (labels.includes("Open Zen (Flatpak)") && !openedPlain) {
				openedPlain = true;
				return "Open Zen (Flatpak)";
			}
			return undefined;
		});

		await command("setup", ctx);
		await until(() => read(log).includes("flatpak run app.zen_browser.zen\n"));

		const grant = shown.find((screen) => screen.labels.includes("Allow and continue"))!;
		expect(grant.text).toContain("flatpak override --user --talk-name=org.freedesktop.Flatpak app.zen_browser.zen");
		// The store first: no folder grant for it, the AMO page opened in Zen.
		expect(grant.text).not.toContain("--filesystem=");
		expect(read(log)).toContain(
			"flatpak override --user --talk-name=org.freedesktop.Flatpak --persist=.mozilla app.zen_browser.zen\n",
		);
		expect(read(log)).toContain("flatpak run app.zen_browser.zen https://addons.mozilla.org/addon/prism-browser/");
		// The folder, when chosen, asks for its own grant.
		expect(read(log)).toMatch(
			/flatpak override --user --talk-name=org\.freedesktop\.Flatpak --filesystem=\S+\/Prism app\.zen_browser\.zen/,
		);
		expect(read(log)).toContain("flatpak run app.zen_browser.zen\n");
		const zen = join(home, ".var/app/app.zen_browser.zen");
		for (const dir of [".zen/native-messaging-hosts", ".mozilla/native-messaging-hosts"]) {
			const declaration = JSON.parse(read(join(zen, dir, `${NATIVE_HOST_NAME}.json`))) as {
				path: string;
				allowed_extensions: string[];
			};
			expect(declaration.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID]);
			expect(read(declaration.path)).toContain("exec flatpak-spawn --host /opt/prism/prism browser-host");
		}
		// The order of the maintainer's QA: the portal setting, then the restart, then the extension.
		const store = shown.find((screen) => screen.labels.includes("Open the page in Zen (Flatpak)"))!.text;
		expect(store.indexOf("then start it again")).toBeGreaterThan(store.indexOf("about:config"));
		expect(store.indexOf("https://addons.mozilla.org/addon/prism-browser/")).toBeGreaterThan(
			store.indexOf("then start it again"),
		);
		const steps = shown.find((screen) => screen.labels.includes("Open Zen (Flatpak)"))!.text;
		const at = (text: string) => steps.indexOf(text);
		expect(at("about:config")).toBeGreaterThan(-1);
		expect(at("then start it again")).toBeGreaterThan(at("about:config"));
		expect(at("about:debugging#/runtime/this-firefox")).toBeGreaterThan(at("then start it again"));
	});

	it("gives Firefox its own copy of the extension and the about:debugging steps", async () => {
		const { command } = load();
		const { ctx, shown } = terminal(({ labels }) => {
			if (shown.length === 1 && labels.includes("Firefox")) return "Firefox";
			if (shown.length === 2) return "Load from a folder instead";
			return undefined;
		});

		await command("setup", ctx);

		expect(shown[1]!.text).toContain("https://addons.mozilla.org/addon/prism-browser/");
		const steps = shown[2]!.text;
		expect(steps).toContain("about:debugging#/runtime/this-firefox");
		const folder = /select manifest\.json in this folder: (\S+)/.exec(steps)![1]!;
		const manifest = JSON.parse(read(join(folder, "manifest.json"))) as Record<string, unknown>;
		expect(JSON.stringify(manifest.permissions)).not.toContain("debugger");
		expect(read(join(home, ".mozilla/native-messaging-hosts", `${NATIVE_HOST_NAME}.json`))).toContain(
			FIREFOX_EXTENSION_ID,
		);
	});

	it("leaves the wait for the extension back to the steps (the diagnostics after 60 s are in fork-browser-wizard)", async () => {
		const { command } = load();
		let waited = 0;
		const { ctx, shown } = terminal(({ labels }) => {
			if (shown.length === 1) return "Chromium";
			if (labels.includes("It is added: check") && waited === 0) return "It is added: check";
			if (labels.length === 1 && labels[0] === "Back to the steps") {
				waited++;
				return "Back to the steps";
			}
			return undefined;
		});

		await command("setup", ctx);

		expect(waited).toBe(1);
		// Back on the steps after leaving the wait, then closed, then the list again.
		expect(shown.at(-2)!.labels).toContain("It is added: check");
		expect(shown.at(-1)!.labels).toEqual(["Chromium", "Firefox", "Zen (Flatpak)"]);
	});

	it("offers the setup once at startup when the module is on and no browser is linked", async () => {
		const { sessionStart } = load();
		const first = terminal(() => undefined);
		await sessionStart({ reason: "startup" }, first.ctx);
		await until(() => first.shown.length > 0);
		expect(first.shown[0]!.labels).toEqual(["Chromium", "Firefox", "Zen (Flatpak)"]);

		const again = terminal(() => undefined);
		await sessionStart({ reason: "startup" }, again.ctx);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(again.shown).toEqual([]);
	});

	// 2026-11-18: on the loaded CI, the settings lock stayed held past the claim's retries and ELOCKED came out of
	// session start. Not claimed: the session starts, without the setup.
	it("starts the session without the setup when the settings lock stays held", async () => {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const release = lockfile.lockSync(join(agentDir, "settings.json"), { realpath: false });
		try {
			const { sessionStart } = load();
			const { ctx, shown } = terminal(() => undefined);
			await sessionStart({ reason: "startup" }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(shown).toEqual([]);
		} finally {
			release();
		}
	});

	// fork.12.
	it("says at start and in /browser when a browser runs the extension of another Prism version", async () => {
		await startHost("Chromium", "from-another-prism");
		const old = load();
		const first = terminal(() => undefined);
		await old.sessionStart({ reason: "startup" }, first.ctx);
		expect(first.notes.map((note) => note.text)).toEqual([
			"The Prism extension in Chromium comes from another version of Prism: /browser setup updates it.",
		]);
		const status = terminal(() => undefined);
		await old.command("", status.ctx);
		expect(status.notes[0]!.text).toContain("Chromium 140: real clicks (extension out of date: /browser setup)");
	});

	// The extension from AMO or the Chrome Web Store carries no build: it is compared by its version.
	// An older store version gets no start warning: the store updates it once it publishes the new one.
	it("notes an older store version of the extension in /browser only, and nothing when it is the same", async () => {
		await startHost("Firefox", "", "0.0.9");
		const older = load();
		const first = terminal(() => undefined);
		await older.sessionStart({ reason: "startup" }, first.ctx);
		expect(first.notes).toEqual([]);
		const status = terminal(() => undefined);
		await older.command("", status.ctx);
		expect(status.notes[0]!.text).toContain(
			`Firefox 140: real clicks (extension 0.0.9, this Prism comes with ${shippedExtensionVersion()}: the store updates it)`,
		);
		await stopHost();
		await startHost("Firefox", "", shippedExtensionVersion());
		const same = terminal(() => undefined);
		await load().sessionStart({ reason: "startup" }, same.ctx);
		expect(same.notes).toEqual([]);
	});

	it("says nothing at start when the browser runs this Prism's extension", async () => {
		await startHost("Chromium", extensionBuild());
		const current = terminal(() => undefined);
		await load().sessionStart({ reason: "startup" }, current.ctx);
		expect(current.notes).toEqual([]);
	});

	it("declares the host to every browser found when nobody can answer (print mode)", async () => {
		const { command } = load();
		const { ctx, notes } = terminal(() => undefined);
		(ctx as { mode: string }).mode = "print";
		(ctx as { hasUI: boolean }).hasUI = false;

		await command("setup", ctx);

		expect(notes).toHaveLength(1);
		// Only the browsers installed, as in the guided setup.
		expect(notes[0]!.text).toContain("Host declared for: Chromium, Firefox, Zen (Flatpak)\n");
		expect(notes[0]!.text).toContain(
			`Chrome Web Store: https://chromewebstore.google.com/detail/prism/${CHROMIUM_EXTENSION_ID}`,
		);
		expect(notes[0]!.text).toContain("addons.mozilla.org: https://addons.mozilla.org/addon/prism-browser/");
		expect(existsSync(join(home, ".config/chromium/NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`))).toBe(true);
	});

	it("answers /browser, /browser resume and an unknown word without a linked browser", async () => {
		const { command } = load();
		const { ctx, notes } = terminal(() => undefined);
		await command("", ctx);
		await command("resume", ctx);
		await command("bogus", ctx);
		expect(notes.map((note) => note.kind)).toEqual(["warning", "warning", "error"]);
		expect(notes[0]!.text).toContain("No browser linked");
		expect(notes[2]!.text).toContain("Usage: /browser");
	});

	it("runs in French without an English line or a missing word", async () => {
		setLanguage("fr");
		const { command } = load();
		const { ctx, shown, notes } = terminal(({ labels }) => (shown.length === 1 ? labels[0] : undefined));
		await command("setup", ctx);
		expect(notes.filter((note) => note.kind === "error")).toEqual([]);
		expect(shown[1]!.text).toContain("Ajoutez l’extension Prism");
	});

	// Last: the window's flag cannot be turned off again in this process.
	it("goes through the same steps in the window's native screens", async () => {
		setViewsClient(true);
		const { command } = load();
		const screens: Array<{ title: string; lines: string[]; items: Array<{ id: string; label: string }> }> = [];
		const notes: string[] = [];
		const ctx = {
			hasUI: true,
			mode: "rpc",
			cwd: home,
			sessionManager: { getSessionId: () => "s1" },
			ui: {
				notify: (text: string) => notes.push(text),
				custom: async (
					factory: (
						tui: { requestRender(): void },
						theme: unknown,
						keys: unknown,
						done: () => void,
					) => {
						nativeMenu: {
							screenId: string;
							revision: number;
							title: string;
							lines: string[];
							items: Array<{ id: string; label: string }>;
						};
						handleNativeMenuInput(input: unknown): boolean;
					},
				) =>
					new Promise<void>((resolve) => {
						let lastRevision = -1;
						const component = factory(
							{
								requestRender: () =>
									queueMicrotask(() => {
										const menu = component.nativeMenu;
										if (menu.revision === lastRevision || menu.screenId === "loading") return;
										lastRevision = menu.revision;
										screens.push(menu);
										const pick = (label: string) => {
											const item = menu.items.find((entry) => entry.label === label)!;
											component.handleNativeMenuInput({
												kind: "activate",
												itemId: item.id,
												revision: menu.revision,
											});
										};
										if (screens.length === 1) pick("Chromium");
										else if (screens.length === 2) pick("Copy the address");
										else if (screens.length === 3) pick("Load from a folder instead");
										else if (screens.length === 4) pick("Copy the address");
										else component.handleNativeMenuInput({ kind: "back", revision: menu.revision });
									}),
							},
							undefined,
							undefined,
							() => resolve(),
						);
					}),
			},
		} as unknown as ExtensionContext;

		await command("setup", ctx);

		expect(notes).toEqual([]);
		expect(screens[0]!.items.map((item) => item.label)).toEqual(["Chromium", "Firefox", "Zen (Flatpak)"]);
		expect(screens[1]!.lines.join("\n")).toContain(
			`https://chromewebstore.google.com/detail/prism/${CHROMIUM_EXTENSION_ID}`,
		);
		expect(screens[2]!.lines.join("\n")).toContain(`/detail/prism/${CHROMIUM_EXTENSION_ID} copied`);
		expect(screens[3]!.lines.join("\n")).toContain("chrome://extensions");
		expect(read(join(root, "clipboard"))).toBe("chrome://extensions");
	});
});

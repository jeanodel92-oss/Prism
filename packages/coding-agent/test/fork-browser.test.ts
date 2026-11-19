// the browser module's relay, without a browser: native messaging framing, the host between a
// fake extension and Prism, the native host declarations, and the tool's text for the model.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { builtInExtensions } from "../src/extensions/index.ts";
import { readBidiPort, writeBidiPort } from "../src/fork/browser/bidi.ts";
import { BrowserHosts } from "../src/fork/browser/client.ts";
import { runBrowserHost } from "../src/fork/browser/host.ts";
import { formatResult } from "../src/fork/browser/index.ts";
import {
	CHROMIUM_EXTENSION_ID,
	encodeNative,
	ensurePrivateDir,
	FIREFOX_EXTENSION_ID,
	LineReader,
	NativeReader,
} from "../src/fork/browser/protocol.ts";
import { flatpakExtraGrants, hostLauncherScript, installNativeHosts } from "../src/fork/browser/setup.ts";
import { DEFAULT_NETWORK_SETTINGS, isDenied, localPortName } from "../src/fork/sandbox/proxy.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prism-browser-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("browser protocol", () => {
	it("reads native messages split across and joined in chunks", () => {
		const frames = Buffer.concat([encodeNative({ a: 1 }), encodeNative({ b: "é" })]);
		const reader = new NativeReader();
		const seen = [
			...reader.push(frames.subarray(0, 3)),
			...reader.push(frames.subarray(3, 9)),
			...reader.push(frames.subarray(9)),
		];
		expect(seen).toEqual([{ a: 1 }, { b: "é" }]);
	});

	it("refuses a native message above the limit", () => {
		const head = Buffer.alloc(4);
		head.writeUInt32LE(100, 0);
		expect(() => new NativeReader(10).push(head)).toThrow(/exceeds/);
	});

	it("reads JSON lines and drops malformed ones", () => {
		const reader = new LineReader();
		expect(reader.push('{"a":1}\nnot json\n{"b"')).toEqual([{ a: 1 }]);
		expect(reader.push(":2}\n")).toEqual([{ b: 2 }]);
	});

	it("refuses a socket folder other users can reach", () => {
		const dir = join(tempDir(), "sockets");
		ensurePrivateDir(dir);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		const open = tempDir();
		// mkdtemp gives 0700; widen it.
		chmodSync(open, 0o755);
		expect(() => ensurePrivateDir(open)).toThrow(/private/);
	});
});

/** A fake extension on the host's stdin/stdout: answers each command with its own name and arguments. */
function fakeExtension(hello: Record<string, unknown>) {
	const toHost = new PassThrough();
	const fromHost = new PassThrough();
	const reader = new NativeReader();
	const received: Array<Record<string, unknown>> = [];
	fromHost.on("data", (chunk: Buffer) => {
		for (const message of reader.push(chunk) as Array<Record<string, unknown>>) {
			received.push(message);
			if (message.cmd === "fail") {
				toHost.write(encodeNative({ type: "reply", id: message.id, ok: false, error: "nope", code: "page" }));
			} else {
				toHost.write(
					encodeNative({
						type: "reply",
						id: message.id,
						ok: true,
						result: { cmd: message.cmd, session: message.session, args: message.args },
					}),
				);
			}
		}
	});
	toHost.write(encodeNative({ type: "hello", ...hello }));
	return { toHost, fromHost, received };
}

describe("browser host", () => {
	it("relays between Prism and the extension, then removes its socket when the browser closes", async () => {
		const dir = join(tempDir(), "sockets");
		const extension = fakeExtension({ name: "Chromium", version: "156.0", extension: "0.1.0", realInput: true });
		const running = runBrowserHost({
			input: extension.toHost,
			output: extension.fromHost,
			dir,
			pid: 4242,
			log: () => {},
		});
		const hosts = new BrowserHosts(dir);
		let list = await hosts.list();
		for (let i = 0; list.length === 0 && i < 50; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			list = await hosts.list();
		}
		expect(list).toHaveLength(1);
		expect(list[0].info).toMatchObject({ name: "Chromium", realInput: true, stopped: false, pid: 4242 });
		const [first, second] = await Promise.all([
			list[0].request("click", "s1", { ref: "e3" }),
			list[0].request("snapshot", "s2", {}),
		]);
		expect(first).toEqual({ cmd: "click", session: "s1", args: { ref: "e3" } });
		expect(second).toEqual({ cmd: "snapshot", session: "s2", args: {} });
		await expect(list[0].request("fail", "s1")).rejects.toMatchObject({ message: "nope", code: "page" });
		// The host renumbers requests, so two Prism sessions cannot collide on ids.
		expect(new Set(extension.received.map((m) => m.id)).size).toBe(extension.received.length);

		const events: string[] = [];
		list[0].onEvent((event) => events.push(event));
		extension.toHost.write(encodeNative({ type: "event", event: "stopped" }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(events).toEqual(["stopped"]);
		expect(list[0].info?.stopped).toBe(true);

		extension.toHost.end();
		const path = await running;
		expect(path).toBe(join(dir, "4242.sock"));
		expect(() => statSync(path)).toThrow();
		await expect(list[0].request("tabs", "s1")).rejects.toMatchObject({ code: "disconnected" });
		expect(await hosts.list()).toHaveLength(0);
		hosts.close();
	});
});

describe("browser setup", () => {
	it("declares the host for the browsers found, pointing to a launcher of this Prism", () => {
		const home = tempDir();
		const agentDir = join(home, "agent");
		mkdirSync(join(home, ".config", "chromium"), { recursive: true });
		mkdirSync(join(home, ".mozilla"), { recursive: true });
		const result = installNativeHosts({ home, agentDir, command: ["/opt/prism it's/prism"] });
		expect(result.written.map((entry) => entry.browser)).toEqual(["Chromium", "Firefox"]);
		const chromium = JSON.parse(readFileSync(result.written[0].path, "utf8"));
		expect(chromium).toMatchObject({
			name: "space.odelserver.prism",
			type: "stdio",
			path: result.launcher,
			allowed_origins: [`chrome-extension://${CHROMIUM_EXTENSION_ID}/`],
		});
		const firefox = JSON.parse(readFileSync(result.written[1].path, "utf8"));
		expect(firefox.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID]);
		expect(statSync(result.launcher).mode & 0o111).not.toBe(0);
		expect(readFileSync(result.launcher, "utf8")).toBe(hostLauncherScript(["/opt/prism it's/prism"]));
		expect(hostLauncherScript(["/opt/prism it's/prism"])).toContain(
			`exec '/opt/prism it'\\''s/prism' browser-host "$@"`,
		);
	});

	it("declares Helium, Zen and Flatpak browsers; a Flatpak one gets a launcher that leaves its sandbox", () => {
		const home = tempDir();
		const agentDir = join(home, "agent");
		mkdirSync(join(home, ".config", "net.imput.helium"), { recursive: true });
		mkdirSync(join(home, ".zen"), { recursive: true });
		mkdirSync(join(home, ".var", "app", "app.zen_browser.zen"), { recursive: true });
		mkdirSync(join(home, ".var", "app", "org.chromium.Chromium"), { recursive: true });
		const asked: string[] = [];
		const result = installNativeHosts({
			home,
			agentDir,
			command: ["/opt/prism/prism"],
			hostAccess: (app) => {
				asked.push(app);
				return app === "org.chromium.Chromium";
			},
			permissions: () => "",
		});
		expect(result.written.map((entry) => entry.browser)).toEqual([
			"Helium",
			"Zen",
			"Chromium (Flatpak)",
			"Zen (Flatpak)",
		]);
		expect(asked).toEqual(["org.chromium.Chromium", "app.zen_browser.zen"]);
		const [helium, zen, chromiumFlatpak, zenFlatpak] = result.written;
		expect(helium.path).toBe(join(home, ".config/net.imput.helium/NativeMessagingHosts/space.odelserver.prism.json"));
		expect(JSON.parse(readFileSync(helium.path, "utf8")).path).toBe(result.launcher);
		expect(zen.path).toBe(join(home, ".zen/native-messaging-hosts/space.odelserver.prism.json"));
		expect(JSON.parse(readFileSync(zen.path, "utf8")).allowed_extensions).toEqual([FIREFOX_EXTENSION_ID]);
		expect(helium.flatpak).toBeUndefined();

		const appDir = join(home, ".var/app/app.zen_browser.zen");
		// Zen 1.23 reads ~/.mozilla (kept by --persist) once its portal pref is 0; a Firefox Flatpak needs the extension folder.
		expect(zenFlatpak.flatpak).toEqual({
			app: "app.zen_browser.zen",
			hostAccess: false,
			extra: [`--filesystem=${join(home, "Prism")}`, "--persist=.mozilla"],
		});
		expect(
			JSON.parse(readFileSync(join(appDir, ".mozilla/native-messaging-hosts/space.odelserver.prism.json"), "utf8"))
				.path,
		).toBe(join(appDir, ".mozilla/native-messaging-hosts/prism-browser-host"));
		expect(zenFlatpak.path).toBe(join(appDir, ".zen/native-messaging-hosts/space.odelserver.prism.json"));
		const zenManifest = JSON.parse(readFileSync(zenFlatpak.path, "utf8"));
		// The launcher sits in the app's own folder, which the sandbox mounts at the same path.
		expect(zenManifest.path).toBe(join(appDir, ".zen/native-messaging-hosts/prism-browser-host"));
		expect(zenManifest.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID]);
		expect(statSync(zenManifest.path).mode & 0o111).not.toBe(0);
		expect(readFileSync(zenManifest.path, "utf8")).toContain(
			`exec flatpak-spawn --host /opt/prism/prism browser-host "$@"`,
		);

		expect(chromiumFlatpak.flatpak).toEqual({ app: "org.chromium.Chromium", hostAccess: true, extra: [] });
		const chromiumManifest = JSON.parse(readFileSync(chromiumFlatpak.path, "utf8"));
		expect(
			chromiumFlatpak.path.startsWith(
				join(home, ".var/app/org.chromium.Chromium/config/chromium/NativeMessagingHosts/"),
			),
		).toBe(true);
		expect(chromiumManifest.allowed_origins).toEqual([`chrome-extension://${CHROMIUM_EXTENSION_ID}/`]);
		// The launcher outside any sandbox stays a plain one.
		expect(readFileSync(result.launcher, "utf8")).not.toContain("flatpak-spawn");
	});

	it("declares LibreWolf, Waterfox, Opera and Ungoogled Chromium in the folders they read", () => {
		const home = tempDir();
		for (const dir of [".librewolf", ".waterfox", ".config/opera"]) mkdirSync(join(home, dir), { recursive: true });
		for (const app of [
			"io.gitlab.librewolf-community",
			"com.opera.Opera",
			"io.github.ungoogled_software.ungoogled_chromium",
		]) {
			mkdirSync(join(home, ".var", "app", app), { recursive: true });
		}
		const result = installNativeHosts({
			home,
			agentDir: join(home, "agent"),
			command: ["/opt/prism/prism"],
			hostAccess: () => true,
			permissions: () => "",
		});
		const where = Object.fromEntries(
			result.written.map((entry) => [entry.browser, entry.path.slice(home.length + 1)]),
		);
		const file = "space.odelserver.prism.json";
		expect(where).toEqual({
			Opera: `.config/google-chrome/NativeMessagingHosts/${file}`,
			LibreWolf: `.librewolf/native-messaging-hosts/${file}`,
			Waterfox: `.waterfox/native-messaging-hosts/${file}`,
			"LibreWolf (Flatpak)": `.var/app/io.gitlab.librewolf-community/.librewolf/native-messaging-hosts/${file}`,
			"Opera (Flatpak)": `.var/app/com.opera.Opera/config/google-chrome/NativeMessagingHosts/${file}`,
			"Ungoogled Chromium (Flatpak)": `.var/app/io.github.ungoogled_software.ungoogled_chromium/config/chromium/NativeMessagingHosts/${file}`,
		});
		const opera = result.written.find((entry) => entry.browser === "Opera");
		expect(JSON.parse(readFileSync(opera?.path ?? "", "utf8")).allowed_origins).toEqual([
			`chrome-extension://${CHROMIUM_EXTENSION_ID}/`,
		]);
	});

	it("matches the extension's manifest: its key gives the declared id", () => {
		const manifest = JSON.parse(
			readFileSync(fileURLToPath(new URL("../browser-extension/manifest.json", import.meta.url)), "utf8"),
		);
		const der = Buffer.from(manifest.key, "base64");
		const hash = createHash("sha256").update(der).digest("hex").slice(0, 32);
		const id = [...hash].map((digit: string) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
		expect(id).toBe(CHROMIUM_EXTENSION_ID);
		expect(manifest.browser_specific_settings.gecko.id).toBe(FIREFOX_EXTENSION_ID);
	});

	// Zen (Flatpak) with ~/Prism read only failed to load background.js.
	// Firefox's portal picker asks for write access, so read only got it a copy of manifest.json alone.
	it("asks a Firefox Flatpak for read and write access to the extension folder, also over a read-only grant", () => {
		const zen = {
			name: "Zen (Flatpak)",
			family: "firefox" as const,
			hostsDir: "/h/zen",
			flatpak: "app.zen_browser.zen",
		};
		// The permissions of the maintainer's Zen, as flatpak info --show-permissions printed them.
		const readOnly =
			"[Context]\nfilesystems=xdg-download;/home/u/.themes;/home/u/Prism:ro;\npersistent=.zen;.mozilla;\n";
		expect(flatpakExtraGrants(zen, readOnly, "/home/u/Prism")).toEqual(["--filesystem=/home/u/Prism"]);
		expect(flatpakExtraGrants(zen, readOnly.replace("Prism:ro", "Prism"), "/home/u/Prism")).toEqual([]);
		expect(flatpakExtraGrants(zen, readOnly.replace("Prism:ro", "Prism:rw"), "/home/u/Prism")).toEqual([]);
		// A longer path that starts with the folder's is not the folder.
		expect(flatpakExtraGrants(zen, readOnly.replace("Prism:ro", "Prism2"), "/home/u/Prism")).toEqual([
			"--filesystem=/home/u/Prism",
		]);
		const chromium = {
			name: "Chromium (Flatpak)",
			family: "chromium" as const,
			hostsDir: "/h/c",
			flatpak: "org.chromium.Chromium",
		};
		expect(flatpakExtraGrants(chromium, "", "/home/u/Prism")).toEqual([]);
	});
});

describe("browser tool text", () => {
	it("lists a snapshot's elements by ref, with values, and says when text is cut", () => {
		const text = formatResult("snapshot", {
			tab: 7,
			url: "https://example.com/",
			title: "Example",
			text: "Hello",
			textLength: 20000,
			elements: [
				{ ref: "e1", role: "link", name: "More", href: "https://example.com/more" },
				{ ref: "e2", role: "text", name: "Search", value: "cats" },
				{ ref: "e3", role: "checkbox", name: "Remember", checked: false, offscreen: true },
			],
			totalElements: 400,
			viewport: { width: 1280, height: 720, scrollY: 0, scrollHeight: 3000 },
		});
		expect(text).toContain('[e1] link "More" -> https://example.com/more');
		expect(text).toContain('[e2] text "Search" value="cats"');
		expect(text).toContain('[e3] checkbox "Remember" unchecked (off screen)');
		expect(text).toContain("first 3 of 400");
		expect(text).toContain("first 5 of 20000 characters");
	});

	it("says when a click was dispatched by script and what covered the point", () => {
		const text = formatResult("click", {
			tab: 1,
			url: "https://example.com/",
			title: "Example",
			clicked: { x: 10.4, y: 20.6, target: 'button "OK"', covered: "div#cookie" },
			real: false,
		});
		expect(text).toContain('Clicked button "OK" at (10, 21) with a script click');
		expect(text).toContain("covered by div#cookie");
	});
});

describe("Firefox remote control port (F2)", () => {
	it("is refused to the agent's commands even when the user allows every port of this machine", () => {
		const dir = tempDir();
		const previous = process.env.PRISM_BROWSER_SOCKET_DIR;
		process.env.PRISM_BROWSER_SOCKET_DIR = dir;
		try {
			const settings = { ...DEFAULT_NETWORK_SETTINGS, allow: ["localhost"] };
			expect(isDenied(localPortName(45123), settings)).toBe(false);
			writeBidiPort(45123, dir);
			expect(statSync(join(dir, "firefox-bidi.json")).mode & 0o777).toBe(0o600);
			expect(readBidiPort(dir)).toBe(45123);
			expect(isDenied(localPortName(45123), settings)).toBe(true);
			expect(isDenied(localPortName(45124), settings)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PRISM_BROWSER_SOCKET_DIR;
			else process.env.PRISM_BROWSER_SOCKET_DIR = previous;
		}
	});
});

describe("browser module default", () => {
	it("is off until the user turns it on", () => {
		const entry = builtInExtensions.find(
			(extension) => typeof extension !== "function" && extension.name === "browser",
		);
		expect(entry && typeof entry !== "function" && entry.disabledByDefault).toBe(true);
	});
});

describe("setup offered once", () => {
	/** How many of 8 processes starting together would open the setup, with the given check; `lead` is the time they
	 * are given to be all started before they check. */
	async function opens(mode: "read" | "claim", lead = 1500): Promise<number> {
		const agentDir = tempDir();
		const child = fileURLToPath(new URL("./fixtures/claim-flag-child.ts", import.meta.url));
		const startAt = String(Date.now() + lead);
		const runs = Array.from({ length: 8 }, () =>
			promisify(execFile)(process.execPath, [child, mode, agentDir, startAt]),
		);
		const outputs = await Promise.all(runs);
		return outputs.filter((output) => output.stdout === "1").length;
	}

	// the setup opened twice on the first start. Reading the flag then saving it let every
	// engine started together read "not offered"; the check before the fix opens more than once.
	it("a read then a save lets several processes open it", async () => {
		// A race: a round can fall on one winner when the machine is busy, so a few rounds are tried. On a loaded
		// machine (the CI runner, where this failed twice) a process takes longer to start than the lead it was given
		// and checks alone, after the others: each round doubles the lead.
		let most = 0;
		for (let round = 0; round < 5 && most < 2; round++) most = Math.max(most, await opens("read", 1500 * 2 ** round));
		expect(most).toBeGreaterThan(1);
	}, 120000);

	it("an atomic claim lets exactly one process open it", async () => {
		expect(await opens("claim")).toBe(1);
	}, 30000);
});

// Store screenshots of the Prism browser extension, taken from the real extension
// driven by the real native host, in a throwaway Chromium or Firefox profile on a private headless labwc.
//
//   env -u WAYLAND_DISPLAY -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE \
//     node fork/tools/store-screenshots.ts chromium|firefox OUT_DIR [--dry-run]
//
// Chain: the browser loads the extension from packages/coding-agent/browser-extension (Chromium: --load-extension;
// Firefox: temporary add-on through the DevTools remote debugging protocol, which leaves no "remote control" mark in
// the toolbar), and starts `node packages/coding-agent/src/cli.ts browser-host` through native messaging, declared in
// the throwaway HOME only. This script then calls the host through Prism's own client (BrowserHosts), as the
// `browser` tool does, and captures the compositor's output with grim. Nothing from the maintainer's HOME, session bus or
// display is passed to the browser: its environment is built from scratch.
//
// Writes OUT_DIR/<browser>-tabs.png (the agent's tabs opened and grouped), <browser>-typing.png (the agent typed into
// the form, its pointer in the field) and <browser>-clicked.png (after its click on the button), 1280x800 PNG, no alpha.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserHostConnection, BrowserHosts } from "../../packages/coding-agent/src/fork/browser/client.ts";
import {
	installNativeHosts,
	writeChromiumExtension,
	writeFirefoxExtension,
} from "../../packages/coding-agent/src/fork/browser/setup.ts";

const browserName = process.argv[2];
const outDir = process.argv[3] ? resolve(process.argv[3]) : "";
const dryRun = process.argv.includes("--dry-run");
if ((browserName !== "chromium" && browserName !== "firefox") || !outDir) {
	console.error("usage: node fork/tools/store-screenshots.ts chromium|firefox OUT_DIR [--dry-run]");
	process.exit(2);
}
for (const name of ["WAYLAND_DISPLAY", "DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE"]) {
	if (process.env[name]) {
		console.error(`refusing to run with ${name} set: unset it so nothing can reach the owner's screen`);
		process.exit(2);
	}
}

const extensionDir = fileURLToPath(new URL("../../packages/coding-agent/browser-extension", import.meta.url));
const cli = fileURLToPath(new URL("../../packages/coding-agent/src/cli.ts", import.meta.url));
const WIDTH = 1280;
const HEIGHT = 800;

// ---------------------------------------------------------------------------------------------------------------
// The demo pages: the user's own web app on its dev server, its docs, and two pages of the user's own.

const favicon = (body: string) =>
	`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`)}">`;
const APP_ICON = favicon(
	'<rect width="32" height="32" rx="7" fill="#1c1c1a"/><path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="#f0f0ee" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
);
const DOC_ICON = favicon(
	'<rect x="5" y="3" width="22" height="26" rx="4" fill="#4a6fa5"/><path d="M10 11h12M10 16h12M10 21h8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
);
const NOTE_ICON = favicon(
	'<rect x="4" y="4" width="24" height="24" rx="5" fill="#d9a441"/><path d="M10 12h12M10 17h12M10 22h7" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
);
const DESIGN_ICON = favicon('<circle cx="16" cy="16" r="12" fill="#5f9e7a"/><circle cx="16" cy="16" r="5" fill="#fff"/>');

const BASE_CSS = `
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 Inter, "Noto Sans", Cantarell, system-ui, sans-serif; color: #1c1c1a; background: #f6f6f4; }
header { display: flex; align-items: center; gap: 28px; padding: 14px 40px; background: #fff; border-bottom: 1px solid #e4e4e0; }
header .brand { font-weight: 700; font-size: 17px; display: flex; align-items: center; gap: 10px; }
header .brand i { width: 22px; height: 22px; border-radius: 6px; background: #1c1c1a; display: inline-block; }
header nav { display: flex; gap: 20px; color: #6b6b66; font-size: 14px; }
header nav b { color: #1c1c1a; font-weight: 600; }
main { max-width: 880px; margin: 24px auto; padding: 0 24px; }
h1 { font-size: 24px; margin: 0 0 4px; }
.muted { color: #6b6b66; }
`;

const APP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tasklist</title>${APP_ICON}<style>${BASE_CSS}
.card { background: #fff; border: 1px solid #e4e4e0; border-radius: 12px; padding: 22px 24px; margin-top: 22px; }
.card h2 { font-size: 16px; margin: 0 0 14px; }
form { display: grid; grid-template-columns: 1fr 200px auto; gap: 12px; align-items: end; }
label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #3a3a36; }
input { width: 100%; font: inherit; padding: 10px 12px; border: 1px solid #cfcfca; border-radius: 8px; background: #fff; color: #1c1c1a; }
input:focus { outline: 2px solid #1c1c1a33; border-color: #8a8a84; }
button { font: inherit; font-weight: 600; padding: 10px 20px; border: 0; border-radius: 8px; background: #1c1c1a; color: #fff; cursor: pointer; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-top: 1px solid #efefeb; }
li:first-child { border-top: 0; }
li .box { width: 18px; height: 18px; border: 1.5px solid #b5b5af; border-radius: 5px; flex: none; }
li .who { margin-left: auto; font-size: 13px; color: #6b6b66; background: #f1f1ee; padding: 2px 10px; border-radius: 999px; }
li.new { background: #f3f7f1; border-radius: 8px; }
li.new .tag { font-size: 12px; color: #3f7a4f; font-weight: 600; }
</style></head><body>
<header><span class="brand"><i></i>Tasklist</span><nav><b>Tasks</b><span>Board</span><span>Team</span><span>Settings</span></nav></header>
<main>
<h1>Sprint 14</h1><div class="muted">Due Friday · <span id="count">3</span> open tasks</div>
<div class="card"><h2>New task</h2>
<form id="f"><div><label for="title">Title</label><input id="title" placeholder="What needs to be done?" autocomplete="off"></div>
<div><label for="who">Assignee</label><input id="who" placeholder="Name" autocomplete="off"></div>
<button type="submit">Add task</button></form></div>
<div class="card"><h2>Open tasks</h2><ul id="list">
<li><span class="box"></span>Write the onboarding email<span class="who">Grace</span></li>
<li><span class="box"></span>Update the pricing page copy<span class="who">Linus</span></li>
<li><span class="box"></span>Review the dark mode colours<span class="who">Ada</span></li>
</ul></div>
</main>
<script>
document.getElementById("f").addEventListener("submit", (event) => {
	event.preventDefault();
	const title = document.getElementById("title"), who = document.getElementById("who");
	if (!title.value.trim()) return;
	const li = document.createElement("li");
	li.className = "new";
	li.innerHTML = '<span class="box"></span><span></span><span class="tag">New</span><span class="who"></span>';
	li.children[1].textContent = title.value;
	li.children[3].textContent = who.value || "Unassigned";
	document.getElementById("list").prepend(li);
	document.getElementById("count").textContent = document.querySelectorAll("#list li").length;
	title.value = ""; who.value = "";
});
</script></body></html>`;

const DOCS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tasklist API reference</title>${DOC_ICON}<style>${BASE_CSS}
pre { background: #1c1c1a; color: #f0f0ee; padding: 16px 18px; border-radius: 10px; font: 13px/1.6 "JetBrains Mono", "Noto Sans Mono", monospace; }
</style></head><body>
<header><span class="brand"><i></i>Tasklist docs</span><nav><span>Guide</span><b>API</b><span>Changelog</span></nav></header>
<main><h1>Tasks API</h1><p class="muted">Create, list and complete tasks.</p>
<h2>Create a task</h2><pre>POST /api/tasks
{ "title": "Fix the sign-up button on mobile", "assignee": "Ada" }</pre>
<p>Returns the new task with its <code>id</code>. Titles are required; the assignee is optional.</p></main></body></html>`;

const NOTES = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Release checklist</title>${NOTE_ICON}<style>${BASE_CSS}</style></head><body>
<header><span class="brand"><i></i>Notes</span></header>
<main><h1>Release checklist</h1><ul><li>Run the test suite</li><li>Check the sign-up flow on mobile</li><li>Write the release notes</li></ul></main></body></html>`;

const DESIGN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Design review</title>${DESIGN_ICON}<style>${BASE_CSS}</style></head><body>
<header><span class="brand"><i></i>Design review</span></header>
<main><h1>Sprint 14 design review</h1><p class="muted">Comments on the new task form.</p></main></body></html>`;

const PAGES: Record<string, string> = { "/": APP, "/docs": DOCS, "/notes": NOTES, "/design": DESIGN };

// ---------------------------------------------------------------------------------------------------------------

const children: ChildProcess[] = [];
let server: Server | undefined;
let root = "";

function cleanup(): void {
	for (const child of children.reverse()) {
		if (!child.pid || child.exitCode !== null) continue;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}
	server?.closeAllConnections();
	server?.close();
	if (root) rmSync(root, { recursive: true, force: true });
}
process.on("SIGINT", () => {
	cleanup();
	process.exit(130);
});
process.on("SIGTERM", () => {
	cleanup();
	process.exit(143);
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor<T>(what: string, ms: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await probe();
		if (value !== undefined && value !== false) return value;
		await sleep(200);
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function freePort(preferred: number): Promise<number> {
	const tryPort = (port: number) =>
		new Promise<number | undefined>((done) => {
			const probe = createNetServer();
			probe.once("error", () => done(undefined));
			probe.listen(port, "127.0.0.1", () => {
				const address = probe.address();
				probe.close(() => done(typeof address === "object" && address ? address.port : undefined));
			});
		});
	return (await tryPort(preferred)) ?? ((await tryPort(0)) as number);
}

/** Installs a temporary add-on through Firefox's DevTools remote debugging protocol (length-prefixed JSON). */
async function installFirefoxAddon(port: number, addonPath: string): Promise<string> {
	const socket = await waitFor("Firefox's debugger server", 30000, () =>
		new Promise<ReturnType<typeof connect> | undefined>((done) => {
			const s = connect(port, "127.0.0.1");
			s.once("connect", () => done(s));
			s.once("error", () => done(undefined));
		}),
	);
	let buffer = Buffer.alloc(0);
	const queue: Array<Record<string, unknown>> = [];
	let wake: (() => void) | undefined;
	socket.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const colon = buffer.indexOf(":");
			if (colon < 0) break;
			const length = Number(buffer.subarray(0, colon).toString());
			if (buffer.length < colon + 1 + length) break;
			queue.push(JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString()));
			buffer = buffer.subarray(colon + 1 + length);
		}
		wake?.();
	});
	const next = async (match: (message: Record<string, unknown>) => boolean) => {
		const end = Date.now() + 20000;
		for (;;) {
			const index = queue.findIndex(match);
			if (index >= 0) return queue.splice(index, 1)[0];
			if (Date.now() > end) throw new Error("no answer from Firefox's debugger server");
			await new Promise<void>((done) => {
				wake = done;
				setTimeout(done, 500);
			});
		}
	};
	const send = (message: Record<string, unknown>) => {
		const json = Buffer.from(JSON.stringify(message));
		socket.write(`${json.length}:`);
		socket.write(json);
	};
	try {
		await next((message) => message.from === "root" && "applicationType" in message);
		send({ to: "root", type: "getRoot" });
		const rootForm = await next((message) => message.from === "root" && "addonsActor" in message);
		const addons = String(rootForm.addonsActor);
		send({ to: addons, type: "installTemporaryAddon", addonPath, openDevTools: false });
		const installed = await next((message) => message.from === addons);
		if (installed.error) throw new Error(`installTemporaryAddon: ${installed.error}: ${installed.message}`);
		// Firefox marks the window "under remote control" (striped address bar, robot icon) while a DevTools server
		// listens, and only re-checks when a window loads or a server starts listening. The add-on is installed: stop
		// the server's listener, then let the window re-check itself; the mark stays if anything still listens.
		send({ to: "root", type: "getProcess", id: 0 });
		const process0 = await next((message) => message.from === "root" && "processDescriptor" in message);
		const descriptor = String((process0.processDescriptor as { actor: string }).actor);
		send({ to: descriptor, type: "getTarget" });
		const target = await next((message) => message.from === descriptor && "process" in message);
		const consoleActor = String((target.process as { consoleActor: string }).consoleActor);
		send({
			to: consoleActor,
			type: "evaluateJSAsync",
			text: [
				// The command line's server lives in the distinct system principal loader (DevToolsStartup.sys.mjs).
				"const loaders = ChromeUtils.importESModule(",
				'  "resource://devtools/shared/loader/DistinctSystemPrincipalLoader.sys.mjs", { global: "shared" });',
				"const me = {};",
				"const loader = loaders.useDistinctSystemPrincipalLoader(me);",
				'loader.require("resource://devtools/server/devtools-server.js").DevToolsServer.closeAllSocketListeners();',
				"loaders.releaseDistinctSystemPrincipalLoader(me);",
				"setTimeout(() => {",
				"  gRemoteControl.updateVisualCue();",
				'  const cue = document.documentElement.getAttribute("remotecontrol") === "true";',
				'  IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "remote-cue.json"), JSON.stringify({ cue }));',
				"}, 1500);",
			].join("\n"),
		});
		// The answer may never come: the evaluation stopped the server this connection came through.
		await next((message) => message.from === consoleActor).catch(() => undefined);
		return String((installed.addon as { id?: string } | undefined)?.id);
	} finally {
		socket.destroy();
	}
}

async function main(): Promise<void> {
	mkdirSync(outDir, { recursive: true });
	root = mkdtempSync(join(tmpdir(), "prism-store-"));
	const home = join(root, "home");
	const runtime = join(root, "run");
	const sockets = join(root, "sockets");
	mkdirSync(home, { recursive: true });
	mkdirSync(runtime, { mode: 0o700 });
	chmodSync(runtime, 0o700);

	// The page server: the user's app on its dev server.
	const port = await freePort(5173);
	server = createServer((request, response) => {
		const page = PAGES[(request.url ?? "/").split("?")[0]];
		response.statusCode = page ? 200 : 404;
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(page ?? "not found");
	});
	await new Promise<void>((done) => server?.listen(port, "127.0.0.1", done));
	const base = `http://localhost:${port}`;

	// A private headless labwc: its own runtime folder, no session bus, every window maximized without a title bar.
	const labwcConfig = join(runtime, "labwc");
	mkdirSync(labwcConfig, { mode: 0o700 });
	writeFileSync(
		join(labwcConfig, "rc.xml"),
		`<?xml version="1.0"?>
<labwc_config>
  <core><decoration>client</decoration></core>
  <keyboard><keybind key="W-F24"><action name="None" /></keybind></keyboard>
  <windowRules>
    <windowRule identifier="*" serverDecoration="no"><action name="Maximize" /></windowRule>
  </windowRules>
</labwc_config>
`,
	);
	writeFileSync(join(labwcConfig, "menu.xml"), '<?xml version="1.0"?><openbox_menu><menu id="root-menu" label="" /></openbox_menu>\n');
	const display = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
		XDG_RUNTIME_DIR: runtime,
	};
	const labwc = spawn("labwc", ["-C", labwcConfig], {
		env: { ...display, WLR_BACKENDS: "headless", WLR_LIBINPUT_NO_DEVICES: "1", WLR_RENDERER: "pixman" },
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	children.push(labwc);
	let labwcLog = "";
	labwc.stderr?.on("data", (chunk: Buffer) => {
		labwcLog = (labwcLog + chunk.toString()).slice(-3000);
	});
	const socketPath = join(runtime, "wayland-0");
	await waitFor("labwc's socket", 10000, () => existsSync(socketPath)).catch((error: Error) => {
		throw new Error(`${error.message}\n${labwcLog}`);
	});
	const wayland = { ...display, WAYLAND_DISPLAY: "wayland-0" };
	const outputs = spawnSync("wlr-randr", [], { env: wayland, encoding: "utf8" });
	const output = outputs.stdout.split("\n")[0]?.split(" ")[0];
	if (!output) throw new Error(`no output: ${outputs.stderr}`);
	const mode = spawnSync("wlr-randr", ["--output", output, "--custom-mode", `${WIDTH}x${HEIGHT}`, "--scale", "1"], {
		env: wayland,
		encoding: "utf8",
	});
	if (mode.status !== 0) throw new Error(`wlr-randr: ${mode.stderr}`);

	// The browser's environment, from scratch: the private display only, the throwaway HOME, the host's socket folder.
	const browserEnv: NodeJS.ProcessEnv = {
		...wayland,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		PRISM_BROWSER_SOCKET_DIR: sockets,
		PRISM_CODING_AGENT_DIR: join(home, "agent"),
		PRISM_SECRET_SERVICE: "off",
		NO_AT_BRIDGE: "1",
		GTK_THEME: "Adwaita",
	};
	const dry = spawnSync(
		"sh",
		["-c", 'true && echo "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} DISPLAY=${DISPLAY:-} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-} HYPRLAND_INSTANCE_SIGNATURE=${HYPRLAND_INSTANCE_SIGNATURE:-} DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-}"'],
		{ env: browserEnv, encoding: "utf8" },
	);
	console.log(`dry run, browser environment: ${dry.stdout.trim()}`);
	console.log(`compositor: labwc pid ${labwc.pid}, output ${output}: ${spawnSync("wlr-randr", [], { env: wayland, encoding: "utf8" }).stdout.split("\n").filter((l) => /current|Scale/.test(l)).join(" | ").trim()}`);
	if (dryRun) return;

	mkdirSync(join(home, browserName === "chromium" ? ".config/chromium" : ".mozilla"), { recursive: true });
	installNativeHosts({ home, agentDir: join(home, "agent"), command: [process.execPath, cli] });

	let browser: ChildProcess;
	if (browserName === "chromium") {
		const copy = writeChromiumExtension(join(home, "Prism"), extensionDir);
		browser = spawn(
			"chromium-browser",
			[
				`--user-data-dir=${join(home, ".config", "chromium")}`,
				`--load-extension=${copy}`,
				`--disable-extensions-except=${copy}`,
				"--ozone-platform=wayland",
				"--force-device-scale-factor=1",
				`--window-size=${WIDTH},${HEIGHT}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--password-store=basic",
				"--disable-sync",
				"--disable-background-networking",
				"--disable-component-update",
				"--disable-default-apps",
				"--disable-search-engine-choice-screen",
				"--hide-crash-restore-bubble",
				"--disable-gpu",
				`${base}/notes`,
				`${base}/design`,
			],
			{ env: browserEnv, detached: true, stdio: ["ignore", "ignore", "pipe"] },
		);
	} else {
		const profile = join(home, "profile");
		mkdirSync(profile, { recursive: true });
		const rdpPort = await freePort(0);
		const prefs: Record<string, string | number | boolean> = {
			"devtools.debugger.remote-enabled": true,
			"devtools.chrome.enabled": true,
			"devtools.debugger.prompt-connection": false,
			"browser.shell.checkDefaultBrowser": false,
			"browser.startup.homepage_override.mstone": "ignore",
			"startup.homepage_welcome_url": "",
			"startup.homepage_welcome_url.additional": "",
			"browser.aboutwelcome.enabled": false,
			"browser.startup.firstrunSkipsHomepage": true,
			"datareporting.policy.dataSubmissionEnabled": false,
			"datareporting.policy.dataSubmissionPolicyBypassNotification": true,
			"datareporting.healthreport.uploadEnabled": false,
			"toolkit.telemetry.reportingpolicy.firstRun": false,
			"toolkit.telemetry.enabled": false,
			"browser.toolbars.bookmarks.visibility": "never",
			"browser.tabs.groups.enabled": true,
			"browser.tabs.firefox-view": false,
			"browser.translations.automaticallyPopup": false,
			"browser.uitour.enabled": false,
			"extensions.update.enabled": false,
			"extensions.getAddons.cache.enabled": false,
			"app.normandy.enabled": false,
			"app.shield.optoutstudies.enabled": false,
			"browser.safebrowsing.malware.enabled": false,
			"browser.safebrowsing.phishing.enabled": false,
			"browser.safebrowsing.downloads.enabled": false,
			"network.captive-portal-service.enabled": false,
			"network.connectivity-service.enabled": false,
			"browser.newtabpage.activity-stream.feeds.topsites": false,
			"browser.newtabpage.activity-stream.feeds.section.topstories": false,
			"extensions.pocket.enabled": false,
			"signon.rememberSignons": false,
			"browser.sessionstore.resume_from_crash": false,
			"layout.css.devPixelsPerPx": "1.0",
			"widget.use-xdg-desktop-portal.file-picker": 0,
			"widget.use-xdg-desktop-portal.native-messaging": 0,
		};
		writeFileSync(
			join(profile, "user.js"),
			Object.entries(prefs)
				.map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
				.join("\n"),
		);
		browser = spawn(
			"firefox",
			[
				"--no-remote",
				"--profile",
				profile,
				"--start-debugger-server",
				String(rdpPort),
				"--width",
				String(WIDTH),
				"--height",
				String(HEIGHT),
				`${base}/notes`,
				`${base}/design`,
			],
			{
				env: { ...browserEnv, MOZ_ENABLE_WAYLAND: "1", GDK_BACKEND: "wayland", MOZ_CRASHREPORTER_DISABLE: "1" },
				detached: true,
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		children.push(browser);
		const id = await installFirefoxAddon(rdpPort, writeFirefoxExtension(join(home, "Prism"), extensionDir));
		console.log(`temporary add-on installed: ${id}`);
		const cue = await waitFor("the remote control mark's re-check", 10000, () => {
			const file = join(profile, "remote-cue.json");
			return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { cue: boolean }) : undefined;
		});
		console.log(`remote control mark shown after the server stopped: ${cue.cue}`);
	}
	if (!children.includes(browser)) children.push(browser);
	let browserLog = "";
	browser.stderr?.on("data", (chunk: Buffer) => {
		browserLog = (browserLog + chunk.toString()).slice(-4000);
	});
	console.log(`browser pid ${browser.pid}`);

	const hosts = new BrowserHosts(sockets);
	try {
		const host: BrowserHostConnection = await waitFor("the extension to connect", 60000, async () => {
			const list = await hosts.list();
			return list[0];
		}).catch((error: Error) => {
			throw new Error(`${error.message}\nbrowser wrote:\n${browserLog}`);
		});
		console.log(`linked: ${JSON.stringify(host.info)}`);
		const call = (cmd: string, args: Record<string, unknown> = {}) =>
			host.request(cmd, "store", args, 60000) as Promise<Record<string, unknown>>;
		const shoot = async (name: string) => {
			await sleep(1500);
			const raw = join(root, `${name}.raw.png`);
			const shot = spawnSync("grim", ["-o", output, raw], { env: wayland, encoding: "utf8" });
			if (shot.status !== 0) throw new Error(`grim: ${shot.stderr}`);
			const file = join(outDir, `${browserName}-${name}.png`);
			// Flatten to RGB: the stores want no alpha channel. Pixels are unchanged (the output is opaque).
			const flat = spawnSync("magick", [raw, "-alpha", "off", `PNG24:${file}`], { encoding: "utf8" });
			if (flat.status !== 0) throw new Error(`magick: ${flat.stderr}`);
			console.log(`wrote ${file}`);
		};

		// The agent opens its own tabs: the docs in the background, then the app, in front.
		await call("open", { url: `${base}/docs` });
		const opened = await call("open", { url: `${base}/`, active: true });
		console.log(`opened ${opened.title}`);
		await shoot("tabs");

		const snapshot = await call("snapshot");
		const elements = snapshot.elements as Array<{ ref: string; role: string; name: string }>;
		const ref = (name: string) => {
			const found = elements.find((element) => element.name === name)?.ref;
			if (!found) throw new Error(`no element named ${name}: ${JSON.stringify(elements)}`);
			return found;
		};
		await call("type", { ref: ref("Title"), text: "Fix the sign-up button on mobile" });
		await sleep(400);
		await call("type", { ref: ref("Assignee"), text: "Ada" });
		await shoot("typing");
		const clicked = await call("click", { ref: ref("Add task") });
		console.log(`clicked at ${JSON.stringify(clicked.clicked)} (real input: ${clicked.real})`);
		await shoot("clicked");
		const tabs = await call("tabs");
		console.log(`agent tabs: ${JSON.stringify((tabs.tabs as Array<{ title: string }>).map((tab) => tab.title))}`);
	} finally {
		hosts.close();
	}
}

main()
	.then(() => {
		cleanup();
		process.exit(0);
	})
	.catch((error: Error) => {
		console.error(error.stack ?? error.message);
		cleanup();
		process.exit(1);
	});

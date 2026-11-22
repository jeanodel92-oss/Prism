// the agent's desktop end to end: a real headless labwc, the real helper, and Firefox and Chromium
// shown on it. Throwaway HOME and profiles; skipped when labwc, the helper's build
// tools or a browser are missing. Never run on the maintainer's own browsers or profiles.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import desktopExtension, { capturePng, desktopView } from "../src/fork/desktop/index.ts";
import { AgentDesktop } from "../src/fork/desktop/session.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { findBwrap, removeSessionTmpDir, sessionSandbox } from "../src/fork/sandbox/runtime.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult } from "./suite/harness.ts";
import { stubThrowawayHome } from "./suite/throwaway-home.ts";

function which(command: string): string | undefined {
	try {
		return execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

const labwc = which("labwc");
const firefox = which("firefox");
const chromium = which("chromium-browser") ?? which("chromium");
const buildScript = fileURLToPath(new URL("../../../fork/desktop-helper/build.sh", import.meta.url));

let helper: string | undefined;
let server: Server;
let base: string;
const events: string[] = [];

// Full-screen page: a button in a known place, an input that reports what it receives.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Desktop test</title>
<style>html,body{margin:0;height:100%}#b{position:fixed;left:100px;top:100px;width:200px;height:100px}
#q{position:fixed;left:100px;top:300px;width:400px;height:40px}</style>
<button id="b">Press</button><input id="q">
<script>
const report = (s) => fetch("/event?" + encodeURIComponent(s), { method: "POST" });
document.getElementById("b").addEventListener("click", (e) => report("click:" + e.isTrusted + ":" + e.screenX + "," + e.screenY + ":" + e.detail));
document.getElementById("b").addEventListener("contextmenu", (e) => { e.preventDefault(); report("context:" + e.isTrusted); });
const q = document.getElementById("q");
q.addEventListener("keydown", (e) => {
	if (e.key === "Enter") report("enter:" + e.isTrusted + ":" + q.value);
	if (e.key === "a" && e.ctrlKey) report("ctrl-a:" + e.isTrusted);
});
report("loaded");
</script>`;

// Two items of an HTML drag and drop, as on a web page whose list is sorted by dragging.
const DRAG_PAGE = `<!doctype html><meta charset="utf-8"><title>Drag test</title>
<style>html,body{margin:0}li{position:fixed;left:100px;width:300px;height:60px;list-style:none;background:#ccc}
#a{top:100px}#b{top:300px}</style>
<ul><li id="a" draggable="true">A</li><li id="b" draggable="true">B</li></ul>
<script>
const report = (s) => fetch("/event?" + encodeURIComponent(s), { method: "POST" });
for (const li of document.querySelectorAll("li")) {
	li.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", li.id); report("dragstart:" + li.id); });
	li.addEventListener("dragover", (e) => e.preventDefault());
	li.addEventListener("drop", (e) => { e.preventDefault(); report("drop:" + li.id + ":" + e.dataTransfer.getData("text/plain")); });
	li.addEventListener("dragend", () => report("dragend:" + li.id));
}
report("loaded");
</script>`;

beforeAll(async () => {
	if (labwc && which("gcc") && which("wayland-scanner")) {
		const out = mkdtempSync(join(tmpdir(), "prism-desktop-helper-"));
		try {
			execFileSync(buildScript, [out], { stdio: "pipe" });
			helper = join(out, "prism-desktop-helper");
		} catch {
			helper = undefined;
		}
	}
	server = createServer((request, response) => {
		if (request.method === "POST" && request.url?.startsWith("/event?")) {
			events.push(decodeURIComponent(request.url.slice(7)));
			response.end();
			return;
		}
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(request.url === "/drag" ? DRAG_PAGE : PAGE);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}, 60000);

afterAll(() => {
	server?.close();
});

async function until(check: () => boolean, timeout = 20000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out; events: ${events.join(" | ")}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const has = (prefix: string) => () => events.some((event) => event.startsWith(prefix));

/**
 * Stops a browser launched in its own process group, and waits until none of its processes is left. Killing the main
 * process alone left Chromium's helpers writing the profile while the test removed it: ENOTEMPTY in 2 runs of 10 under
 * load, and a profile folder written again after its removal in every run.
 */
async function stopBrowser(browser: ChildProcess, home: string): Promise<void> {
	const exited = browser.exitCode !== null || browser.signalCode !== null;
	const exit = exited ? Promise.resolve() : new Promise((resolve) => browser.once("exit", resolve));
	try {
		process.kill(-browser.pid!, "SIGKILL");
	} catch {
		browser.kill("SIGKILL");
	}
	await exit;
	// A helper that left the group (Chromium's crash handler) still names the profile on its command line.
	const usesHome = () =>
		readdirSync("/proc").some((pid) => {
			try {
				return /^\d+$/.test(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf-8").includes(home);
			} catch {
				return false;
			}
		});
	await until(() => !usesHome(), 10000);
}

async function scenario(launch: (desktop: AgentDesktop, home: string) => ChildProcess): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "prism-desktop-home-"));
	const desktop = await AgentDesktop.start({ helper: helper!, labwc });
	let browser: ChildProcess | undefined;
	try {
		expect(desktop.width).toBeGreaterThan(0);
		events.length = 0;
		browser = launch(desktop, home);
		await until(has("loaded"), 40000);
		// The page needs a moment to be shown after it loaded.
		await new Promise((resolve) => setTimeout(resolve, 1500));

		const shot = await desktop.capture();
		expect(shot.width).toBe(desktop.width);
		expect(shot.rgba.length).toBe(shot.width * shot.height * 4);
		const png = await capturePng(shot);
		expect(png.subarray(1, 4).toString()).toBe("PNG");

		await desktop.click(200, 150);
		await until(has("click:"));
		expect(events.find((event) => event.startsWith("click:"))).toMatch(/^click:true:\d+,\d+:1$/);

		await desktop.click(200, 150, "right");
		await until(has("context:"));
		expect(events).toContain("context:true");

		await desktop.click(300, 320);
		await desktop.type("hello é€ World");
		await desktop.key("Enter");
		await until(has("enter:"));
		expect(events).toContain("enter:true:hello é€ World");

		await desktop.key("ctrl+a");
		await until(has("ctrl-a:"));
		expect(events).toContain("ctrl-a:true");
	} finally {
		if (browser) await stopBrowser(browser, home);
		desktop.stop();
		rmSync(home, { recursive: true, force: true });
	}
	expect(desktop.running).toBe(false);
}

describe.skipIf(!labwc)("agent desktop", () => {
	it("runs nothing when the agent presses labwc's usual shortcuts or clicks its desktop", async (context) => {
		if (!helper) context.skip();
		// Stand-ins for what labwc's defaults start: terminals, launchers, volume and brightness tools. labwc starts
		// programs detached, so they are seen by what they leave, not as its children.
		const stubs = mkdtempSync(join(tmpdir(), "prism-desktop-stubs-"));
		const ran = join(stubs, "ran");
		for (const name of [
			"lab-sensible-terminal",
			"foot",
			"alacritty",
			"kitty",
			"xterm",
			"bemenu-run",
			"fuzzel",
			"wofi",
			"rofi",
			"amixer",
			"wpctl",
			"pactl",
			"brightnessctl",
			"xdg-open",
		]) {
			writeFileSync(join(stubs, name), `#!/bin/sh\necho "$0" >> '${ran}'\n`, { mode: 0o755 });
		}
		const press = async (desktop: AgentDesktop) => {
			for (const combo of ["super+Return", "alt+F3", "super+e", "alt+space"]) await desktop.key(combo);
			for (const keysym of ["1008ff13", "1008ff11", "1008ff12", "1008ff02", "1008ff03"]) {
				await desktop.request(`keys 0 ${keysym}`);
			}
			await desktop.click(640, 360, "right");
			await desktop.click(640, 360, "middle");
			await new Promise((resolve) => setTimeout(resolve, 1500));
		};
		const path = `${stubs}:${process.env.PATH}`;
		try {
			// Control: with labwc's defaults, the same keys start a program.
			const control = await AgentDesktop.start({ helper: helper!, labwc, path, labwcDefaults: true });
			try {
				await press(control);
			} finally {
				control.stop();
			}
			expect(existsSync(ran)).toBe(true);
			rmSync(ran);
			const desktop = await AgentDesktop.start({ helper: helper!, labwc, path });
			try {
				await press(desktop);
			} finally {
				desktop.stop();
			}
			expect(existsSync(ran) ? readFileSync(ran, "utf8") : "").toBe("");
		} finally {
			rmSync(stubs, { recursive: true, force: true });
		}
	}, 60000);

	it.skipIf(!firefox)(
		"drives Firefox shown on it, with real input",
		async (context) => {
			if (!helper) context.skip();
			await scenario((desktop, home) => {
				// Firefox refuses a profile folder that does not exist.
				mkdirSync(join(home, "profile"));
				return spawn(firefox!, ["--no-remote", "--profile", join(home, "profile"), "--kiosk", base], {
					env: {
						PATH: process.env.PATH,
						HOME: home,
						XDG_RUNTIME_DIR: desktop.runtimeDir,
						WAYLAND_DISPLAY: desktop.socket,
						MOZ_ENABLE_WAYLAND: "1",
					},
					stdio: "ignore",
					detached: true,
				});
			});
		},
		120000,
	);

	it.skipIf(!chromium)(
		"drives Chromium shown on it, with real input",
		async (context) => {
			if (!helper) context.skip();
			await scenario((desktop, home) =>
				spawn(
					chromium!,
					[
						"--ozone-platform=wayland",
						`--user-data-dir=${join(home, "profile")}`,
						"--no-first-run",
						"--no-default-browser-check",
						"--disable-gpu",
						"--kiosk",
						base,
					],
					{
						env: {
							PATH: process.env.PATH,
							HOME: home,
							XDG_RUNTIME_DIR: desktop.runtimeDir,
							WAYLAND_DISPLAY: desktop.socket,
						},
						stdio: "ignore",
						detached: true,
					},
				),
			);
		},
		120000,
	);
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Owner's choice B: the sandbox refuses Unix sockets, so sandboxed commands never reach the agent's
// desktop; the desktop tool's launch action starts programs on it outside the sandbox, after the user's approval even
// in broad mode, as a command excluded from the sandbox.
describe.skipIf(!labwc || !findBwrap())("agent desktop and the sandbox", () => {
	it("starts programs on the desktop outside the sandbox only with the user's approval", async (context) => {
		if (!helper) context.skip();
		const base = realpathSync(mkdtempSync("/var/tmp/prism-desktop-sandbox-"));
		const agentDir = join(base, "agent");
		mkdirSync(join(base, "home"), { recursive: true });
		mkdirSync(agentDir);
		stubThrowawayHome(join(base, "home"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("TMPDIR", base);
		vi.stubEnv("PRISM_DESKTOP_HELPER", helper!);
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "project" } } }));
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{ name: "desktop", factory: desktopExtension },
			],
		});
		const questions: string[] = [];
		const firstUse: string[] = [];
		let answer: "Allow" | "Deny" = "Deny";
		try {
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					select: async (title, options) => {
						// F-H5: broad mode asks once before the agent uses a desktop; the session answer covers the rest.
						if (!title.includes("outside the sandbox")) {
							firstUse.push(title);
							return options.find((option) => option.endsWith("in this session"));
						}
						questions.push(title);
						return options.find((option) => option.startsWith(answer));
					},
				}),
			});
			expect(sessionSandbox(harness.sessionManager)).toMatchObject({ bwrap: findBwrap() });
			// The helper is a Wayland client like any program: a copy in the project.
			copyFileSync(helper!, join(harness.tempDir, "client"));
			chmodSync(join(harness.tempDir, "client"), 0o755);
			const probe = `echo "display=$WAYLAND_DISPLAY"; echo size | ./client`;
			const call = async (tool: string, input: JsonObject) => {
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				return getToolResult(harness, tool);
			};
			const started = await call("desktop", { action: "start" });
			expect(started.isError, getMessageText(started)).not.toBe(true);
			// A sandboxed command is not sent to the agent's desktop.
			const boxed = getMessageText(await call("bash", { command: probe }));
			expect(boxed).not.toMatch(/prism-desk-\w+\/wayland-0/);
			expect(boxed).not.toContain("ok 1280 720");
			expect(questions).toEqual([]);

			const refused = await call("desktop", { action: "launch", command: probe });
			expect(questions.join("\n")).toContain("runs outside the sandbox");
			expect(getMessageText(refused)).not.toContain("ok 1280 720");

			answer = "Allow";
			const launched = getMessageText(await call("desktop", { action: "launch", command: probe }));
			expect(launched).toMatch(/display=\S*\/prism-desk-\w+\/wayland-0/);
			expect(launched).toContain("ok 1280 720");
			expect(launched).toContain("exited with code 0");
			// A program that keeps running is reported started, and ends with the desktop.
			const running = getMessageText(await call("desktop", { action: "launch", command: "sleep 60" }));
			const pid = Number(/Started \(process (\d+)\)/.exec(running)?.[1]);
			expect(pid, running).toBeGreaterThan(0);
			expect(() => process.kill(pid, 0)).not.toThrow();
			await call("desktop", { action: "stop" });
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && isAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
			expect(isAlive(pid)).toBe(false);
			expect(firstUse).toHaveLength(1);
		} finally {
			// A failed assertion before stop must not leave labwc running.
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			removeSessionTmpDir(harness.sessionManager.getSessionId());
			harness.cleanup();
			vi.unstubAllEnvs();
			rmSync(base, { recursive: true, force: true });
		}
	}, 120000);
});

// A drag sent at once ended before the browser's drag began: no drop in Firefox or Chromium.
/**
 * Removes the folder of a browser that is being stopped: the stop is not waited for, and the browser still writes
 * its profile while it closes. The wait is not rmSync's
 * own, which would hold the event loop that the stop needs.
 */
async function removeOnceQuiet(path: string): Promise<void> {
	for (let left = 100; ; left--) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!left) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}

describe.skipIf(!labwc)("agent desktop drag", () => {
	const browsers = [
		{ name: "Firefox", path: firefox, args: (profile: string) => `--no-remote --profile ${profile} --kiosk` },
		{
			name: "Chromium",
			path: chromium,
			args: (profile: string) =>
				`--ozone-platform=wayland --user-data-dir=${profile} --no-first-run --no-default-browser-check --disable-gpu --kiosk`,
		},
	];
	for (const browser of browsers) {
		it.skipIf(!browser.path)(
			`drops a web page's item dragged in ${browser.name}`,
			async (context) => {
				if (!helper) context.skip();
				const root = mkdtempSync(join(tmpdir(), "prism-desktop-drag-"));
				const profile = join(root, "profile");
				mkdirSync(profile);
				stubThrowawayHome(join(root, "home"));
				vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
				vi.stubEnv("PRISM_DESKTOP_HELPER", helper!);
				const harness = await createHarness({
					extensionFactories: [{ name: "desktop", factory: desktopExtension }],
				});
				try {
					await harness.session.bindExtensions({ uiContext: createTestUiContext() });
					const call = async (input: JsonObject) => {
						harness.setResponses([
							fauxAssistantMessage(fauxToolCall("desktop", input), { stopReason: "toolUse" }),
							fauxAssistantMessage("done"),
						]);
						await harness.session.prompt("go");
						return getToolResult(harness, "desktop");
					};
					events.length = 0;
					const command = `${browser.path} ${browser.args(profile)} ${base}/drag`;
					const launched = await call({ action: "launch", command });
					expect(launched.isError, getMessageText(launched)).not.toBe(true);
					await until(has("loaded"), 40000);
					await new Promise((resolve) => setTimeout(resolve, 1500));
					const dragged = await call({ action: "drag", x: 250, y: 130, x2: 250, y2: 330 });
					expect(dragged.isError, getMessageText(dragged)).not.toBe(true);
					await until(has("dragend:"));
					expect(events).toContain("drop:b:a");
				} finally {
					await emitSessionShutdownEvent(harness.session.extensionRunner, {
						type: "session_shutdown",
						reason: "quit",
					});
					harness.cleanup();
					vi.unstubAllEnvs();
					await removeOnceQuiet(root);
				}
			},
			120000,
		);
	}
});

// the window's live view (rpc-builtins.ts, desktop_frame and desktop_stop; desktop-screen.js).
describe.skipIf(!labwc)("agent desktop live view", () => {
	it("shows the running desktop and the agent's pointer, and never starts it", async (context) => {
		if (!helper) context.skip();
		const base = mkdtempSync(join(tmpdir(), "prism-desktop-live-"));
		stubThrowawayHome(join(base, "home"));
		vi.stubEnv(ENV_AGENT_DIR, join(base, "agent"));
		vi.stubEnv("PRISM_DESKTOP_HELPER", helper!);
		const harness = await createHarness({ extensionFactories: [{ name: "desktop", factory: desktopExtension }] });
		try {
			await harness.session.bindExtensions({ uiContext: createTestUiContext() });
			const call = async (input: JsonObject) => {
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("desktop", input), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("go");
				return getToolResult(harness, "desktop");
			};
			const view = desktopView()!;
			expect(await view.frame()).toEqual({ running: false });
			expect(await view.frame()).toEqual({ running: false });

			expect((await call({ action: "start" })).isError).not.toBe(true);
			const plain = await view.frame();
			expect(plain).toMatchObject({ running: true, width: 1280, height: 720, mimeType: "image/png" });
			expect(plain.running && Buffer.from(plain.data, "base64").subarray(1, 4).toString()).toBe("PNG");
			expect(plain.running && plain.pointer).toBeUndefined();
			await call({ action: "move", x: 300, y: 200 });
			expect(await view.frame()).toMatchObject({ running: true, pointer: { x: 300, y: 200 } });
			// Outside the screen, the pointer is drawn at its edge.
			await call({ action: "click", x: 5000, y: -10 });
			expect(await view.frame()).toMatchObject({ pointer: { x: 1279, y: 0 } });

			expect(view.stop()).toBe(true);
			expect(await view.frame()).toEqual({ running: false });
			expect(view.stop()).toBe(false);
		} finally {
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			harness.cleanup();
			vi.unstubAllEnvs();
			rmSync(base, { recursive: true, force: true });
		}
	}, 60000);
});

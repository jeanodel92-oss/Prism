// the user's own desktop under Hyprland, on their consent. A fake
// Hyprland answers on a Unix socket as hyprctl's does, and a fake helper stands for prism-desktop-helper: no real
// session is touched. The real thing is tried on a nested Hyprland by hand (bureau-separe.md, "Bureau de l'utilisateur").
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { emitSessionShutdownEvent } from "../src/core/extensions/runner.ts";
import { desktopSocket, setDesktopSocket } from "../src/fork/desktop/env.ts";
import { hyprlandSocketPath, luaString, parseShortcut } from "../src/fork/desktop/hyprland.ts";
import desktopExtension, { takeBackKey } from "../src/fork/desktop/index.ts";
import { AgentDesktop } from "../src/fork/desktop/session.ts";
import { helperKeyboardName, MouseWatch, type TakeBackReason, UserDesktop } from "../src/fork/desktop/user-desktop.ts";
import userDesktopExtension from "../src/fork/desktop/user-tool.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { loadPhoton } from "../src/utils/photon.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult } from "./suite/harness.ts";
import { stubThrowawayHome } from "./suite/throwaway-home.ts";

const SIGNATURE = "test_signature";

interface Bind {
	modmask: number;
	key: string;
	submap: string;
	arg: unknown;
}

class FakeHyprland {
	readonly requests: string[] = [];
	binds: Bind[] = [];
	cursor = { x: 10, y: 10 };
	lua = true;
	showKeyboard = true;
	helperName = "prism-desktop-helper";
	/** Workspaces that exist, and the one DP-2 shows. */
	workspaces = [1, 2, 4];
	shown = 2;
	readonly socket: string;
	private readonly server: Server;

	constructor(runtime: string) {
		mkdirSync(join(runtime, "hypr", SIGNATURE), { recursive: true });
		this.socket = join(runtime, "hypr", SIGNATURE, ".socket.sock");
		this.server = createServer((connection) => {
			connection.setEncoding("utf8");
			connection.once("data", (request: string) => connection.end(this.answer(request)));
		});
	}

	listen(): Promise<void> {
		return new Promise((resolve) => this.server.listen(this.socket, resolve));
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}

	private answer(request: string): string {
		this.requests.push(request);
		if (request === "j/monitors") {
			return JSON.stringify([
				{
					name: "eDP-1",
					width: 1920,
					height: 1080,
					x: 0,
					y: 0,
					scale: 1,
					focused: false,
					activeWorkspace: { id: 1 },
				},
				{
					name: "DP-2",
					width: 4,
					height: 2,
					x: 1920,
					y: 0,
					scale: 2,
					focused: true,
					activeWorkspace: { id: this.shown },
				},
			]);
		}
		if (request === "j/workspaces") return JSON.stringify(this.workspaces.map((id) => ({ id })));
		const lua = /^eval hl\.dispatch\(hl\.dsp\.focus\(\{ workspace = "([^"]+)" \}\)\)$/.exec(request);
		const legacy = /^dispatch workspace (\S+)$/.exec(request);
		if (lua || legacy) {
			if (lua ? !this.lua : this.lua) return "error: wrong dispatcher syntax for this config";
			this.shown = Number((lua ?? legacy)![1]);
			if (!this.workspaces.includes(this.shown)) this.workspaces.push(this.shown);
			return "ok";
		}
		if (request === "j/binds") return JSON.stringify(this.binds);
		if (request === "j/cursorpos") return JSON.stringify(this.cursor);
		if (request === "j/devices") {
			return JSON.stringify({
				keyboards: [
					{ name: "at-translated-set-2-keyboard" },
					...(this.showKeyboard ? [{ name: helperKeyboardName(this.helperName) }] : []),
				],
			});
		}
		if (request.startsWith("eval ")) {
			if (!this.lua) return "eval is only supported with the lua config manager";
			if (request.includes("hl.bind(")) this.binds.push({ modmask: 5, key: "Q", submap: "", arg: 1 });
			if (request.includes(":unbind()")) this.binds = this.binds.filter((b) => b.arg !== 1);
			return "ok";
		}
		if (request.startsWith("keyword ")) {
			if (this.lua) return "keyword can't work with non-legacy parsers. Use eval.";
			const bind = /^keyword bind CTRL SHIFT, Q, exec, (.*)$/.exec(request);
			if (bind) this.binds.push({ modmask: 5, key: "Q", submap: "", arg: bind[1] });
			if (request === "keyword unbind CTRL SHIFT, Q") {
				this.binds = this.binds.filter((b) => !(b.modmask === 5 && b.key === "Q"));
			}
			return "ok";
		}
		if (request.startsWith("notify ")) return "ok";
		return "unknown request";
	}

	/** The flag file the declared shortcut touches. */
	flag(): string {
		const declared = this.requests.find((r) => r.includes("hl.bind(") || r.startsWith("keyword bind"));
		const path = /touch ([^"\s)]+)/.exec(declared ?? "")?.[1];
		if (!path) throw new Error(`No shortcut declared: ${this.requests.join(" | ")}`);
		return path;
	}
}

/** Answers as the helper does, on a 4x2 screen; logs its screen and commands. */
function fakeHelper(dir: string, width = 4, height = 2): string {
	const path = join(dir, "prism-desktop-helper");
	writeFileSync(
		path,
		`#!/bin/sh
echo "$PRISM_DESKTOP_OUTPUT" > '${dir}/output'
echo "ok ${width} ${height}"
while read -r line; do
	echo "$line" >> '${dir}/commands'
	case "$line" in
		capture*) head -c ${width * height * 4} /dev/zero > "\${line#capture }"; echo "ok ${width} ${height}" ;;
		*) echo ok ;;
	esac
done
`,
		{ mode: 0o755 },
	);
	return path;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeout = 3000): Promise<void> {
	const end = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await sleep(20);
	}
}

describe("Hyprland helpers", () => {
	it("reads a shortcut as Hyprland writes it, and refuses one without a modifier", () => {
		expect(parseShortcut("ctrl+shift+q")).toEqual({ mods: ["CTRL", "SHIFT"], modmask: 5, key: "Q" });
		expect(parseShortcut("Super + Alt + F12")).toEqual({ mods: ["SUPER", "ALT"], modmask: 72, key: "F12" });
		expect(() => parseShortcut("q")).toThrow(/needs a modifier/);
		expect(() => parseShortcut("ctrl+hyper+q")).toThrow(/Unknown modifier/);
		expect(() => parseShortcut("ctrl+Return")).toThrow(/letter, a digit or F1 to F12/);
	});

	it("quotes Lua strings and refuses control characters", () => {
		expect(luaString(`touch /tmp/a "b"`)).toBe(`"touch /tmp/a \\"b\\""`);
		expect(() => luaString("a\nb")).toThrow();
	});

	it("finds Hyprland's socket only when the session has one", () => {
		const runtime = mkdtempSync(join(tmpdir(), "prism-hypr-path-"));
		try {
			expect(hyprlandSocketPath({ XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: SIGNATURE })).toBe(
				undefined,
			);
			mkdirSync(join(runtime, "hypr", SIGNATURE), { recursive: true });
			writeFileSync(join(runtime, "hypr", SIGNATURE, ".socket.sock"), "");
			expect(hyprlandSocketPath({ XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: SIGNATURE })).toBe(
				join(runtime, "hypr", SIGNATURE, ".socket.sock"),
			);
			expect(hyprlandSocketPath({ XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: "../x" })).toBe(undefined);
			expect(hyprlandSocketPath({ XDG_RUNTIME_DIR: runtime })).toBe(undefined);
		} finally {
			rmSync(runtime, { recursive: true, force: true });
		}
	});
});

describe("mouse watch", () => {
	it("gives the desktop back after two seconds of movement, not after a brief one", () => {
		const watch = new MouseWatch();
		const expected = { x: 100, y: 100 };
		let now = 0;
		const tick = () => {
			now += 100;
			return now;
		};
		// The pointer where the agent put it: nothing.
		for (let i = 0; i < 40; i++) expect(watch.sample(expected, expected, tick())).toBe(false);
		// One second of movement, then a pause.
		for (let i = 1; i <= 10; i++) expect(watch.sample({ x: 100 + i * 5, y: 100 }, expected, tick())).toBe(false);
		for (let i = 0; i < 10; i++) expect(watch.sample({ x: 150, y: 100 }, expected, tick())).toBe(false);
		// Two seconds of movement.
		const moves: boolean[] = [];
		for (let i = 1; i <= 21; i++) moves.push(watch.sample({ x: 150 + i * 5, y: 100 }, expected, tick()));
		expect(moves.slice(0, 20).some(Boolean)).toBe(false);
		expect(moves[20]).toBe(true);
	});

	it("does not count the agent's own moves", () => {
		const watch = new MouseWatch();
		let now = 0;
		const tick = () => {
			now += 100;
			return now;
		};
		for (let i = 0; i < 40; i++) {
			const at = { x: i * 10, y: 0 };
			expect(watch.sample(at, at, tick())).toBe(false);
		}
	});
});

describe("user desktop (fake Hyprland)", () => {
	let dir: string;
	let hypr: FakeHyprland;
	let helper: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "prism-user-desktop-"));
		hypr = new FakeHyprland(join(dir, "run"));
		await hypr.listen();
		helper = fakeHelper(dir);
	});

	afterEach(async () => {
		await hypr.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const start = (onTakenBack: (reason: TakeBackReason) => void = () => {}) =>
		UserDesktop.start({
			helper,
			socket: hypr.socket,
			shortcut: "ctrl+shift+q",
			notice: "Prism: the agent has your desktop.",
			onTakenBack,
			parent: dir,
		});

	it("drives the screen the user is on, keeps its keyboard from Hyprland's shortcuts, and stops on the shortcut", async () => {
		const reasons: TakeBackReason[] = [];
		const desktop = await start((reason) => reasons.push(reason));
		expect(desktop.monitor.name).toBe("DP-2");
		expect(readFileSync(join(dir, "output"), "utf8").trim()).toBe("DP-2");
		expect(hypr.requests).toContain(
			`eval hl.device({ name = "hl-virtual-keyboard-prism-desktop-helper", keybinds = false })`,
		);
		const declared = hypr.requests.find((r) => r.includes("hl.bind("));
		expect(declared).toMatch(
			/^eval _G\.prism_take_back = hl\.bind\("CTRL \+ SHIFT \+ Q", hl\.dsp\.exec_cmd\("touch /,
		);
		// The keyboard rule comes before the helper's keyboard exists.
		expect(hypr.requests.findIndex((r) => r.includes("keybinds = false"))).toBeLessThan(
			hypr.requests.indexOf("j/devices"),
		);
		expect(hypr.requests.some((r) => r.startsWith("eval hl.notification.create"))).toBe(true);
		await desktop.click(2, 1);
		expect(readFileSync(join(dir, "commands"), "utf8")).toContain("click 2 1 left 1");

		writeFileSync(hypr.flag(), "");
		await until(() => reasons.length > 0);
		expect(reasons).toEqual(["shortcut"]);
		expect(desktop.running).toBe(false);
		expect(desktop.stopReason).toContain("took their desktop back (shortcut)");
		expect(hypr.binds).toEqual([]);
		expect(existsSync(desktop.runtimeDir)).toBe(false);
		await expect(desktop.click(1, 1)).rejects.toThrow(/took their desktop back/);
	});

	it("gives the desktop back when the user moves the mouse for two seconds, not for a brief move", async () => {
		const reasons: TakeBackReason[] = [];
		const desktop = await start((reason) => reasons.push(reason));
		try {
			// The agent's pointer at (2, 1) of a screen at 1920,0 with scale 2: 1921, 0.5 in the layout.
			await desktop.move(2, 1);
			hypr.cursor = { x: 1921, y: 0.5 };
			await sleep(400);
			for (let i = 1; i <= 8; i++) {
				hypr.cursor = { x: 1921 + i * 3, y: 20 };
				await sleep(100);
			}
			await sleep(600);
			expect(reasons).toEqual([]);
			for (let i = 1; i <= 30 && reasons.length === 0; i++) {
				hypr.cursor = { x: 1000 + i * 3, y: 300 };
				await sleep(100);
			}
			expect(reasons).toEqual(["mouse"]);
			expect(hypr.binds).toEqual([]);
		} finally {
			await desktop.stop();
		}
	}, 15000);

	it("declares its shortcut again when a reload of Hyprland's config dropped it", async () => {
		const desktop = await start();
		try {
			hypr.binds = [];
			await until(() => hypr.binds.length === 1, 4000);
		} finally {
			await desktop.stop();
		}
		expect(hypr.binds).toEqual([]);
	});

	it("refuses a shortcut the user already has", async () => {
		hypr.binds = [{ modmask: 5, key: "q", submap: "", arg: "kitty" }];
		hypr.lua = false;
		await expect(start()).rejects.toThrow(/already one of your Hyprland shortcuts/);
		expect(hypr.requests.some((r) => r.startsWith("keyword bind") || r.includes("keybinds"))).toBe(false);
		expect(hypr.binds).toHaveLength(1);
	});

	it("uses keyword commands with a legacy config, and removes a shortcut a previous Prism left", async () => {
		hypr.lua = false;
		hypr.binds = [{ modmask: 5, key: "Q", submap: "", arg: "touch /tmp/prism-user-desk-old/taken-back" }];
		const reasons: TakeBackReason[] = [];
		const desktop = await start((reason) => reasons.push(reason));
		expect(hypr.requests).toContain("keyword device[hl-virtual-keyboard-prism-desktop-helper]:keybinds false");
		expect(hypr.binds).toEqual([
			{ modmask: 5, key: "Q", submap: "", arg: `touch ${join(desktop.runtimeDir, "taken-back")}` },
		]);
		expect(hypr.requests.some((r) => r.startsWith("notify 1 6000 0 Prism: the agent has your desktop."))).toBe(true);
		writeFileSync(hypr.flag(), "");
		await until(() => reasons.length > 0);
		expect(hypr.requests).toContain("keyword unbind CTRL SHIFT, Q");
		expect(hypr.binds).toEqual([]);
	});

	// fork: two Prism on one Hyprland took each other's take-back shortcut.
	it("refuses a second Prism while one has the desktop, and keeps the first one's shortcut", async () => {
		const reasons: TakeBackReason[] = [];
		const first = await start((reason) => reasons.push(reason));
		try {
			const before = hypr.requests.length;
			await expect(start()).rejects.toThrow(/Another Prism \(process \d+\) already has the user's desktop/);
			// The second one touched neither the shortcut nor the agent's keyboard.
			expect(hypr.requests.slice(before).filter((r) => !r.startsWith("j/") && r !== "eval return 1")).toEqual([]);
			expect(hypr.binds).toHaveLength(1);
			writeFileSync(hypr.flag(), "");
			await until(() => reasons.length > 0);
			expect(reasons).toEqual(["shortcut"]);
			expect(hypr.binds).toEqual([]);
		} finally {
			await first.stop();
		}
		// Once given back, another Prism may take it, and its stop withdraws its own shortcut.
		const second = await start();
		expect(hypr.binds).toHaveLength(1);
		await second.stop();
		expect(hypr.binds).toEqual([]);
		expect(existsSync(join(dirname(hypr.socket), "prism-user-desktop.owner"))).toBe(false);
	});

	it("takes over the shortcut of a Prism that ended without giving the desktop back", async () => {
		hypr.lua = false;
		const dead = spawnSync("true");
		writeFileSync(
			join(dirname(hypr.socket), "prism-user-desktop.owner"),
			JSON.stringify({ pid: dead.pid, started: "1", token: "old" }),
		);
		hypr.binds = [{ modmask: 5, key: "Q", submap: "", arg: "touch /tmp/prism-user-desk-old/taken-back" }];
		const desktop = await start();
		try {
			expect(hypr.binds).toEqual([
				{ modmask: 5, key: "Q", submap: "", arg: `touch ${join(desktop.runtimeDir, "taken-back")}` },
			]);
		} finally {
			await desktop.stop();
		}
		expect(hypr.binds).toEqual([]);
	});

	it("stops when Hyprland does not show the agent's keyboard, and withdraws the shortcut", async () => {
		hypr.showKeyboard = false;
		await expect(start()).rejects.toThrow(/does not show the agent's keyboard/);
		expect(hypr.binds).toEqual([]);
	});
});

describe("desktop tool on the user's desktop", () => {
	let dir: string;
	let hypr: FakeHyprland;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "prism-user-desktop-tool-"));
		hypr = new FakeHyprland(join(dir, "run"));
		await hypr.listen();
		stubThrowawayHome(join(dir, "home"));
		vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
		vi.stubEnv("TMPDIR", dir);
		vi.stubEnv("PRISM_DESKTOP_HELPER", fakeHelper(dir));
		vi.stubEnv("XDG_RUNTIME_DIR", join(dir, "run"));
		vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", SIGNATURE);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await hypr.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function session(confirm: boolean, answers: string[] = [], mode?: "safe") {
		if (mode) {
			// No sandbox: the refusal must not depend on bubblewrap here.
			mkdirSync(join(dir, "agent"), { recursive: true });
			writeFileSync(join(dir, "agent", "permissions.json"), JSON.stringify({ mode }));
			writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ sandbox: { modes: { [mode]: false } } }));
		}
		const harness = await createHarness({
			extensionFactories: [
				...(mode ? [{ name: "permissions", factory: permissionsExtension }] : []),
				{ name: "desktop", factory: desktopExtension },
				{ name: "user-desktop", factory: userDesktopExtension },
			],
		});
		const asked: string[] = [];
		const warnings: Array<string | undefined> = [];
		const selected: string[] = [];
		const statuses: Array<string | undefined> = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				confirm: async (title, message, opts) => {
					asked.push(`${title}\n${message}`);
					warnings.push(opts?.warning);
					return confirm;
				},
				setStatus: (key, text) => {
					if (key === "desktop-user") statuses.push(text);
				},
				select: async (title, options) => {
					selected.push(`${title}\n${options.join(" | ")}`);
					return answers.shift();
				},
			}),
		});
		// The user's desktop by default; the agent's own with tool "desktop".
		const call = async (input: JsonObject, tool = "user_desktop") => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return getToolResult(harness, tool);
		};
		return { harness, asked, warnings, selected, statuses, call };
	}

	// fork: the agreement is the only gate, so it says what it gives, and safe mode
	// refuses the tool.
	it("refuses the user's desktop in safe mode, without asking", async () => {
		const { harness, asked, call } = await session(true, [], "safe");
		try {
			const refused = await call({ action: "start" });
			expect(refused.isError).toBe(true);
			expect(getMessageText(refused)).toContain("Refused in safe mode");
			expect(asked).toEqual([]);
			expect(hypr.requests).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("asks the user first, and touches nothing when they decline", async () => {
		const { harness, asked, warnings, call } = await session(false);
		try {
			const declined = await call({ action: "start" });
			expect(declined.isError).toBe(true);
			expect(getMessageText(declined)).toContain("The user declined");
			expect(asked).toHaveLength(1);
			expect(asked[0]).toContain("ctrl+shift+q");
			expect(asked[0]).toContain("2 seconds");
			expect(warnings[0]).toContain("start programs and run commands with your rights, outside the sandbox");
			expect(hypr.requests).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("acts on the user's screen once they agree, until they take it back", async () => {
		const { harness, statuses, call } = await session(true);
		try {
			const started = await call({ action: "start" });
			expect(started.isError, getMessageText(started)).not.toBe(true);
			expect(getMessageText(started)).toContain("You have the user's desktop (DP-2)");
			expect(started.content.some((part) => part.type === "image")).toBe(true);
			expect(statuses.at(-1)).toContain("ctrl+shift+q");

			expect((await call({ action: "click", x: 3, y: 1 })).isError).not.toBe(true);
			expect(readFileSync(join(dir, "commands"), "utf8")).toContain("click 3 1 left 1");
			// The accessibility tree of the user's desktop would show every program of theirs:
			// the user's desktop tool has no elements action and no refs.
			const tool = harness.session.getAllTools().find((entry) => entry.name === "user_desktop");
			expect(JSON.stringify(tool?.parameters)).not.toMatch(/elements|"ref"/);

			writeFileSync(hypr.flag(), "");
			await until(() => statuses.at(-1) === undefined);
			const after = await call({ action: "click", x: 1, y: 1 });
			expect(after.isError).toBe(true);
			expect(getMessageText(after)).toContain("The user took their desktop back (with their shortcut)");
			expect(hypr.binds).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	// providers shrink a large picture without saying so; Prism shrinks it itself and maps the model's
	// coordinates back, so the model never computes a scale.
	it("shows a large screen shrunk, with the agent's pointer, and maps the model's coordinates back", async () => {
		vi.stubEnv("PRISM_DESKTOP_HELPER", fakeHelper(dir, 2732, 1536));
		const { harness, call } = await session(true);
		try {
			const started = await call({ action: "start" });
			expect(getMessageText(started)).toContain("1366x768 pixels: give x and y in this picture");
			const clicked = await call({ action: "click", x: 300, y: 200 });
			expect(readFileSync(join(dir, "commands"), "utf8")).toContain("click 600 400 left 1");
			expect(getMessageText(clicked)).toContain("Your pointer (violet arrow) is at 300,200.");
			await call({ action: "drag", x: 10, y: 10, x2: 100, y2: 50 });
			expect(readFileSync(join(dir, "commands"), "utf8").trim().split("\n").slice(-2)).toEqual([
				"move 200 100",
				"button left up",
			]);
			const shot = await call({ action: "screenshot" });
			expect(getMessageText(shot)).toContain("Your pointer (violet arrow) is at 100,50.");
			const image = shot.content.find((part) => part.type === "image");
			const photon = await loadPhoton();
			const picture = photon!.PhotonImage.new_from_byteslice(Buffer.from(image!.data, "base64"));
			try {
				expect([picture.get_width(), picture.get_height()]).toEqual([1366, 768]);
				const pixels = picture.get_raw_pixels();
				const at = (x: number, y: number) => [...pixels.slice((y * 1366 + x) * 4, (y * 1366 + x) * 4 + 3)];
				// The arrow's fill just below its tip, its outline at the tip; the rest of the screen untouched.
				expect(at(101, 52)).toEqual([139, 92, 246]);
				expect(at(100, 50)).toEqual([255, 255, 255]);
				expect(at(90, 50)).toEqual([0, 0, 0]);
			} finally {
				picture.free();
			}
		} finally {
			harness.cleanup();
		}
	});

	it("gives the desktop back on stop", async () => {
		const { harness, statuses, call } = await session(true);
		try {
			await call({ action: "start" });
			expect(hypr.binds).toHaveLength(1);
			const stopped = await call({ action: "stop" });
			expect(getMessageText(stopped)).toContain("You gave the user's desktop back.");
			expect(hypr.binds).toEqual([]);
			expect(statuses.at(-1)).toBe(undefined);
		} finally {
			harness.cleanup();
		}
	});

	// fork: the agent saw Prism's own window, and Super+1 never reached Hyprland.
	for (const lua of [true, false]) {
		it(`shows an empty workspace while the agent has the screen, switches on request, and comes back (${lua ? "Lua" : "legacy"} config)`, async () => {
			hypr.lua = lua;
			const { harness, call } = await session(true);
			try {
				const started = await call({ action: "start" });
				expect(getMessageText(started)).toContain("empty workspace 3");
				expect(hypr.shown).toBe(3);
				expect(hypr.requests).toContain(
					lua ? 'eval hl.dispatch(hl.dsp.focus({ workspace = "3" }))' : "dispatch workspace 3",
				);
				const switched = await call({ action: "workspace", workspace: "4" });
				expect(switched.isError, getMessageText(switched)).not.toBe(true);
				expect(hypr.shown).toBe(4);
				const refused = await call({ action: "workspace", workspace: "1; exec rm" });
				expect(refused.isError).toBe(true);
				expect(hypr.shown).toBe(4);
				await call({ action: "stop" });
				expect(hypr.shown).toBe(2);
			} finally {
				harness.cleanup();
			}
		});
	}

	it("leaves the screen where the user is when they take it back themselves", async () => {
		const { harness, statuses, call } = await session(true);
		try {
			await call({ action: "start" });
			expect(hypr.shown).toBe(3);
			writeFileSync(hypr.flag(), "");
			await until(() => statuses.at(-1) === undefined);
			expect(hypr.shown).toBe(3);
		} finally {
			harness.cleanup();
		}
	});

	// The owner's decision of 2026-11-13: once they gave their desktop, a launch there asks nothing more.
	it("launches a program on the user's desktop without asking, and opens it there", async () => {
		const { harness, asked, selected, call } = await session(true);
		const marker = (n: number) => join(dir, `launched-${n}`);
		const command = (n: number) => `printf %s "$WAYLAND_DISPLAY" > '${marker(n)}'`;
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-user");
		// The agent's own desktop runs too: the program must not open there.
		setDesktopSocket(join(dir, "agent-wayland"));
		try {
			const refused = await call({ action: "launch", command: command(1) });
			expect(getMessageText(refused)).toContain("You do not have the user's desktop");
			await call({ action: "start" });
			for (const n of [2, 3]) {
				const started = await call({ action: "launch", command: command(n) });
				expect(started.isError, getMessageText(started)).not.toBe(true);
				await until(() => existsSync(marker(n)) && readFileSync(marker(n), "utf8") !== "");
				expect(readFileSync(marker(n), "utf8")).toBe("wayland-user");
			}
			expect(asked).toHaveLength(1);
			expect(selected).toEqual([]);
			expect(existsSync(marker(1))).toBe(false);
		} finally {
			setDesktopSocket(undefined);
			harness.cleanup();
		}
	});

	it("stops a run of the same action, and lets another one through", async () => {
		const { harness, call } = await session(true);
		try {
			await call({ action: "start" });
			for (let n = 0; n < 15; n++) {
				expect((await call({ action: "key", key: "ctrl+End" })).isError).not.toBe(true);
				// Looking between them does not end the run.
				if (n === 7) await call({ action: "screenshot" });
			}
			const refused = await call({ action: "key", key: "ctrl+End" });
			expect(refused.isError).toBe(true);
			expect(getMessageText(refused)).toContain("You sent this same key 15 times in a row");
			const keys = () =>
				readFileSync(join(dir, "commands"), "utf8")
					.split("\n")
					.filter((l) => l.startsWith("keys "));
			expect(keys()).toHaveLength(15);
			expect((await call({ action: "key", key: "Up" })).isError).not.toBe(true);
			expect((await call({ action: "key", key: "ctrl+End" })).isError).not.toBe(true);
			expect(keys()).toHaveLength(17);
		} finally {
			harness.cleanup();
		}
	});

	it("is refused outside a Wayland session", async () => {
		vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "");
		vi.stubEnv("XDG_SESSION_TYPE", "x11");
		vi.stubEnv("WAYLAND_DISPLAY", "");
		vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "");
		const { harness, asked, call } = await session(true);
		try {
			const refused = await call({ action: "start" });
			expect(getMessageText(refused)).toContain("needs a Wayland session");
			expect(asked).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	// fork: a start still waiting when the session ended installed its
	// desktop afterwards in the closed instance, and a launch then ran its command.
	it("stops a user's desktop granted after its session ended", async () => {
		const real = UserDesktop.start.bind(UserDesktop);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held = vi.spyOn(UserDesktop, "start").mockImplementation(async (options) => {
			await gate;
			return real(options);
		});
		const { harness, statuses, call } = await session(true);
		try {
			const result = call({ action: "start" });
			await until(() => held.mock.calls.length === 1);
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "new" });
			release();
			const done = await result;
			expect(getMessageText(done)).toContain("The session ended while the desktop was starting");
			expect(hypr.binds).toEqual([]);
			expect(statuses).toEqual([]);
		} finally {
			held.mockRestore();
			harness.cleanup();
		}
	});

	it("stops the agent's desktop that came up after its session ended, and launches nothing on it", async () => {
		let release!: (desktop: AgentDesktop) => void;
		const held = vi.spyOn(AgentDesktop, "start").mockImplementation(
			() =>
				new Promise<AgentDesktop>((resolve) => {
					release = resolve;
				}),
		);
		const stopped = vi.fn();
		const fake = {
			running: true,
			socket: join(dir, "wayland-0"),
			runtimeDir: dir,
			programEnv: {},
			stop: stopped,
		} as unknown as AgentDesktop;
		const marker = join(dir, "launched");
		const { harness, call } = await session(true);
		try {
			const result = call({ action: "launch", command: `touch '${marker}'` }, "desktop");
			await until(() => held.mock.calls.length === 1);
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "new" });
			release(fake);
			const done = await result;
			expect(getMessageText(done)).toContain("The session ended while the desktop was starting");
			expect(stopped).toHaveBeenCalledOnce();
			expect(desktopSocket()).toBeUndefined();
			await sleep(200);
			expect(existsSync(marker)).toBe(false);
		} finally {
			held.mockRestore();
			harness.cleanup();
		}
	});

	it("reads the take-back shortcut from settings.json", () => {
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		expect(takeBackKey(agentDir)).toBe("ctrl+shift+q");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ desktopTakeBackKey: "super+alt+F12" }));
		expect(takeBackKey(agentDir)).toBe("super+alt+F12");
	});
});

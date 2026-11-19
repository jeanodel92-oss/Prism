// the user's own desktop through the desktop portal (GNOME, KDE), on their consent
//. A fake helper stands for prism-portal-helper: no portal, no real session is touched.
// The real helper is tried on an isolated GNOME by hand (bureau-separe.md, "Bureau de l'utilisateur (GNOME, KDE)").
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	ensureDesktopEntry,
	hasDesktopEntry,
	PORTAL_APP_ID,
	PORTAL_ENTRY_MARK,
	PortalUserDesktop,
	portalSession,
	portalTrigger,
	portalTriggerLabel,
} from "../src/fork/desktop/portal-desktop.ts";
import type { TakeBackReason } from "../src/fork/desktop/user-desktop.ts";
import userDesktopExtension from "../src/fork/desktop/user-tool.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult } from "./suite/harness.ts";
import { stubThrowawayHome } from "./suite/throwaway-home.ts";

/**
 * Answers as prism-portal-helper does, on a 4x2 screen. Files in dir steer it: start-error (its first answer),
 * new-token and trigger (its first line), cursor ("x y"), exit (its exit status, at the next command). It logs its
 * environment and its commands.
 */
function fakePortalHelper(dir: string): string {
	const path = join(dir, "prism-portal-helper");
	writeFileSync(
		path,
		`#!/bin/sh
env | grep -E '^(PRISM_|DBUS_|XDG_RUNTIME_DIR)' | sort > '${dir}/env'
if [ -f '${dir}/start-error' ]; then cat '${dir}/start-error'; exit 1; fi
echo "ok 4 2 $(cat '${dir}/new-token' 2>/dev/null || echo -) $(cat '${dir}/trigger' 2>/dev/null || echo -)"
while read -r line; do
	[ -f '${dir}/exit' ] && exit "$(cat '${dir}/exit')"
	case "$line" in
		cursor) echo "ok $(cat '${dir}/cursor' 2>/dev/null || echo '1 1')" ;;
		capture*) head -c 32 /dev/zero > "\${line#capture }"; echo "ok 4 2" ;;
		*) echo "$line" >> '${dir}/commands'; echo ok ;;
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

function helperEnv(dir: string): Record<string, string> {
	return Object.fromEntries(
		readFileSync(join(dir, "env"), "utf8")
			.trim()
			.split("\n")
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

describe("portal helpers", () => {
	it("writes the take-back shortcut in the portal's syntax", () => {
		expect(portalTrigger("ctrl+shift+q")).toBe("CTRL+SHIFT+q");
		expect(portalTrigger("super+alt+F12")).toBe("LOGO+ALT+F12");
		expect(() => portalTrigger("q")).toThrow(/modifier/);
	});

	it("reads the shortcut as the desktop describes it", () => {
		expect(portalTriggerLabel("Press <Shift><Control>q")).toBe("shift+ctrl+q");
		expect(portalTriggerLabel("Ctrl+Shift+Q")).toBe("ctrl+shift+q");
		expect(portalTriggerLabel("<Super>F12")).toBe("super+f12");
	});

	it("needs a Wayland session with a session bus", () => {
		expect(portalSession({ XDG_SESSION_TYPE: "wayland", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" })).toBe(true);
		expect(portalSession({ WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" })).toBe(true);
		expect(portalSession({ XDG_SESSION_TYPE: "x11", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" })).toBe(false);
		expect(portalSession({ XDG_SESSION_TYPE: "wayland", XDG_RUNTIME_DIR: "/nonexistent" })).toBe(false);
	});

	it("finds the desktop entry the shortcut needs in the data folders", () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-portal-entry-"));
		try {
			const env = { XDG_DATA_HOME: join(dir, "home"), XDG_DATA_DIRS: join(dir, "system") };
			expect(hasDesktopEntry(PORTAL_APP_ID, env)).toBe(false);
			mkdirSync(join(dir, "system", "applications"), { recursive: true });
			writeFileSync(join(dir, "system", "applications", `${PORTAL_APP_ID}.desktop`), "");
			expect(hasDesktopEntry(PORTAL_APP_ID, env)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes a hidden, marked entry once, never over another, and says when it cannot", () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-portal-entry-"));
		try {
			const env = { XDG_DATA_HOME: join(dir, "home"), XDG_DATA_DIRS: join(dir, "system") };
			const path = join(dir, "home", "applications", `${PORTAL_APP_ID}.desktop`);
			expect(ensureDesktopEntry(PORTAL_APP_ID, "/opt/prism/prism --gui", env)).toBe(true);
			const entry = readFileSync(path, "utf8");
			expect(entry).toContain("Exec=/opt/prism/prism --gui\n");
			expect(entry).toContain("NoDisplay=true\n");
			expect(entry).toContain(`${PORTAL_ENTRY_MARK}\n`);
			expect(statSync(path).mode & 0o777).toBe(0o644);
			writeFileSync(path, "someone else's");
			expect(ensureDesktopEntry(PORTAL_APP_ID, "/opt/prism/prism --gui", env)).toBe(true);
			expect(readFileSync(path, "utf8")).toBe("someone else's");
			expect(readdirSync(join(dir, "home", "applications"))).toEqual([`${PORTAL_APP_ID}.desktop`]);
			writeFileSync(join(dir, "file"), "");
			expect(ensureDesktopEntry(PORTAL_APP_ID, "prism --gui", { ...env, XDG_DATA_HOME: join(dir, "file") })).toBe(
				false,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("user desktop through the portal (fake helper)", () => {
	let dir: string;
	let helper: string;
	let tokenFile: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-portal-desktop-"));
		helper = fakePortalHelper(dir);
		tokenFile = join(dir, "agent", "desktop-portal-token");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const start = (onTakenBack: (reason: TakeBackReason) => void = () => {}, appId?: string) =>
		PortalUserDesktop.start({
			helper,
			shortcut: "ctrl+shift+q",
			tokenFile,
			...(appId ? { appId } : {}),
			onTakenBack,
			parent: dir,
			timeout: 5000,
			env: { XDG_RUNTIME_DIR: "/run/user/test", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/test/bus" },
		});

	it("passes the saved token, the app id and the shortcut, keeps the new token, and refuses the shortcut to the agent", async () => {
		mkdirSync(join(dir, "agent"));
		writeFileSync(tokenFile, "old-token\n");
		writeFileSync(join(dir, "new-token"), "new-token");
		writeFileSync(join(dir, "trigger"), "Press <Shift><Control>q");
		const desktop = await start(undefined, PORTAL_APP_ID);
		try {
			expect(helperEnv(dir)).toEqual({
				DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/test/bus",
				PRISM_PORTAL_APP_ID: PORTAL_APP_ID,
				PRISM_PORTAL_RESTORE_TOKEN: "old-token",
				PRISM_TAKE_BACK_SHORTCUT: "CTRL+SHIFT+q",
				XDG_RUNTIME_DIR: "/run/user/test",
			});
			expect([desktop.width, desktop.height]).toEqual([4, 2]);
			expect(readFileSync(tokenFile, "utf8")).toBe("new-token\n");
			expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
			expect(desktop.shortcutLabel).toBe("shift+ctrl+q");
			await expect(desktop.key("ctrl+shift+q")).rejects.toThrow(/take their desktop back/);
			await expect(desktop.key("shift+ctrl+Q")).rejects.toThrow(/take their desktop back/);
			await desktop.key("ctrl+l");
			await desktop.click(3, 1);
			expect(readFileSync(join(dir, "commands"), "utf8")).toBe(`keys 4 6c\nclick 3 1 left 1\n`);
		} finally {
			await desktop.stop();
		}
		expect(existsSync(desktop.runtimeDir)).toBe(false);
	});

	it("starts without a token, keeps none it is not given, and has no shortcut when the desktop binds none", async () => {
		const desktop = await start();
		try {
			const env = helperEnv(dir);
			expect(env.PRISM_PORTAL_RESTORE_TOKEN).toBeUndefined();
			expect(env.PRISM_PORTAL_APP_ID).toBeUndefined();
			expect(existsSync(tokenFile)).toBe(false);
			expect(desktop.shortcutLabel).toBeUndefined();
			await desktop.key("ctrl+shift+q");
		} finally {
			await desktop.stop();
		}
	});

	it("reports the helper's refusal, and leaves nothing behind", async () => {
		writeFileSync(join(dir, "start-error"), "error the user declined to share their screen");
		await expect(start()).rejects.toThrow("the user declined to share their screen");
		expect(readFileSync(join(dir, "env"), "utf8")).toContain("PRISM_TAKE_BACK_SHORTCUT");
		const left = readdirSync(dir).filter((name) => name.startsWith("prism-user-desk-"));
		expect(left).toEqual([]);
	});

	it.each([
		["4", "shortcut"],
		["3", "desktop"],
		["1", "helper"],
	])("tells why the desktop came back when the helper ends with status %s", async (status, reason) => {
		const reasons: TakeBackReason[] = [];
		const desktop = await start((why) => reasons.push(why));
		writeFileSync(join(dir, "exit"), status);
		await until(() => reasons.length > 0);
		expect(reasons).toEqual([reason]);
		expect(desktop.running).toBe(false);
		await expect(desktop.click(1, 1)).rejects.toThrow();
	});

	it("gives the desktop back when the user moves the mouse for two seconds, not for a brief move", async () => {
		const reasons: TakeBackReason[] = [];
		const desktop = await start((why) => reasons.push(why));
		try {
			const cursor = join(dir, "cursor");
			for (let i = 0; i < 5; i++) {
				writeFileSync(cursor, `${100 + (i % 2) * 10} 50`);
				await sleep(60);
			}
			await sleep(600);
			expect(reasons).toEqual([]);
			// Two seconds of movement, with room for a slow fake helper when the whole suite runs.
			const end = Date.now() + 8000;
			for (let i = 0; reasons.length === 0 && Date.now() < end; i++) {
				writeFileSync(cursor, `${i % 2 ? 130 : 100} ${50 + (i % 2) * 5}`);
				await sleep(60);
			}
			expect(reasons).toEqual(["mouse"]);
		} finally {
			await desktop.stop();
		}
	}, 15000);
});

describe("desktop tool on the user's desktop through the portal", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-portal-tool-"));
		stubThrowawayHome(join(dir, "home"));
		vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
		vi.stubEnv("TMPDIR", dir);
		vi.stubEnv("PRISM_PORTAL_HELPER", fakePortalHelper(dir));
		vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "");
		vi.stubEnv("XDG_SESSION_TYPE", "wayland");
		vi.stubEnv("XDG_RUNTIME_DIR", join(dir, "run"));
		vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent/test-bus");
		vi.stubEnv("XDG_DATA_HOME", join(dir, "data"));
		vi.stubEnv("XDG_DATA_DIRS", join(dir, "system-data"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function session(confirm: boolean) {
		const harness = await createHarness({
			extensionFactories: [{ name: "user-desktop", factory: userDesktopExtension }],
		});
		const asked: string[] = [];
		const statuses: Array<string | undefined> = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				confirm: async (title, message) => {
					asked.push(`${title}\n${message}`);
					return confirm;
				},
				setStatus: (key, text) => {
					if (key === "desktop-user") statuses.push(text);
				},
			}),
		});
		const call = async (input: JsonObject) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("user_desktop", input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return getToolResult(harness, "user_desktop");
		};
		return { harness, asked, statuses, call };
	}

	it("asks the user first, and starts nothing when they decline", async () => {
		const { harness, asked, call } = await session(false);
		try {
			const declined = await call({ action: "start" });
			expect(getMessageText(declined)).toContain("The user declined");
			expect(asked[0]).toContain("allow remote interaction");
			expect(existsSync(join(dir, "env"))).toBe(false);
			expect(existsSync(join(dir, "data", "applications"))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("without a desktop entry it cannot write, registers no app id, and acts until the user stops the sharing", async () => {
		writeFileSync(join(dir, "data"), "");
		const { harness, statuses, call } = await session(true);
		try {
			const started = await call({ action: "start" });
			expect(started.isError, getMessageText(started)).not.toBe(true);
			expect(getMessageText(started)).toContain("You have the user's desktop.");
			expect(statuses.at(-1)).toContain("stop the sharing or move the mouse");
			expect(helperEnv(dir).PRISM_PORTAL_APP_ID).toBeUndefined();

			expect((await call({ action: "type", text: "hi" })).isError).not.toBe(true);
			expect(readFileSync(join(dir, "commands"), "utf8")).toContain("keys 0 68 69");

			writeFileSync(join(dir, "exit"), "3");
			await until(() => statuses.at(-1) === undefined);
			const after = await call({ action: "click", x: 1, y: 1 });
			expect(getMessageText(after)).toContain("The user took their desktop back (by stopping the sharing)");
		} finally {
			harness.cleanup();
		}
	});

	it("writes Prism's hidden desktop entry on consent, registers its app id, shows the bound shortcut, and refuses it to the agent", async () => {
		writeFileSync(join(dir, "trigger"), "Press <Shift><Control>q");
		writeFileSync(join(dir, "new-token"), "token-1");
		const { harness, asked, statuses, call } = await session(true);
		try {
			await call({ action: "start" });
			expect(asked[0]).toContain("ctrl+shift+q");
			expect(helperEnv(dir).PRISM_PORTAL_APP_ID).toBe(PORTAL_APP_ID);
			const entry = readFileSync(join(dir, "data", "applications", `${PORTAL_APP_ID}.desktop`), "utf8");
			expect(entry).toMatch(/^Exec=.+ --gui$/m);
			expect(entry).toContain(PORTAL_ENTRY_MARK);
			expect(statuses.at(-1)).toContain("shift+ctrl+q");
			expect(readFileSync(join(dir, "agent", "desktop-portal-token"), "utf8")).toBe("token-1\n");
			const pressed = await call({ action: "key", key: "ctrl+shift+q" });
			expect(pressed.isError).toBe(true);
			expect(getMessageText(pressed)).toContain("take their desktop back");
			const stopped = await call({ action: "stop" });
			expect(getMessageText(stopped)).toContain("You gave the user's desktop back.");
			expect(statuses.at(-1)).toBe(undefined);
		} finally {
			harness.cleanup();
		}
	});
});

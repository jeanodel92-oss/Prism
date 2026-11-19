// fork: the unrestricted mode's warning was shown in English in a French interface,
// "/perm rules" opened an old list in English instead of the rules editor of /settings, and the help was a list
// of 30 lines in English, each of which could be chosen.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getLanguage, setLanguage, t } from "../src/fork/i18n/index.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { type SettingsTarget, setSettingsHost } from "../src/fork/settings-sections.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07|\x1b\]8;[^\x07]*\x07/g, "");

describe("fork: the permission pages", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const savedLanguage = getLanguage();
	const harnesses: Harness[] = [];

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-permission-pages-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		setLanguage("fr");
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		setSettingsHost(undefined);
		setLanguage(savedLanguage);
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** A session with the gate in the terminal interface; what it shows is recorded. */
	async function start(answer?: string) {
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		const selects: Array<{ title: string; options: string[] }> = [];
		const notices: Array<{ message: string; level?: string }> = [];
		const windows: string[][] = [];
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				select: async (title, options) => {
					selects.push({ title, options });
					return answer;
				},
				notify: (message, level) => notices.push({ message, level }),
				custom: async (factory) => {
					const tui = { terminal: { rows: 200 }, requestRender: () => {} };
					const window = (await factory(
						tui as never,
						undefined as never,
						undefined as never,
						() => {},
					)) as Component;
					windows.push(window.render(100).map(plain));
					return undefined as never;
				},
			}),
		});
		return { harness, selects, notices, windows };
	}

	it("says the unrestricted mode's warning in French, when it starts and in the dialog that enables it", async () => {
		writeFileSync(
			join(agentDir, "permissions.json"),
			JSON.stringify({ mode: "unrestricted", unrestrictedAccepted: true }),
		);
		const { harness, notices } = await start();
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
		const warning = notices.find((notice) => notice.level === "warning")?.message ?? "";
		expect(warning).toContain("Mode sans limite : aucune confirmation");
		expect(warning).not.toContain("no confirmation");

		rmSync(join(agentDir, "permissions.json"));
		const fresh = await start("Enable unrestricted mode");
		await fresh.harness.session.prompt("/perm mode unrestricted");
		expect(fresh.selects).toHaveLength(1);
		expect(fresh.selects[0]!.title).toContain("Ce n’est pas une sandbox");
		expect(fresh.selects[0]!.title).not.toContain("not a sandbox");
	});

	it("opens the saved rules in their editor in /settings", async () => {
		const host = vi.fn<(target: SettingsTarget) => void>();
		setSettingsHost(host);
		const { harness, selects } = await start();
		await harness.session.prompt("/perm rules");
		expect(host).toHaveBeenCalledWith({ domain: "permissions", item: "perm-rules", open: true });
		expect(selects).toEqual([]);
	});

	it("lists the rules in French without the interactive mode", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ allow: ["bash(npm test)"] }));
		const { harness, selects } = await start();
		await harness.session.prompt("/perm rules");
		const lines = selects[0]?.options ?? [];
		expect(lines).toContain("Enregistré, autorisé : bash(npm test)");
		expect(lines).toContain("Cette session, autorisé : rien");
		expect(lines.join("\n")).not.toMatch(/\[session\]|\[config\]|\(none\)/);
	});

	it("shows the help in a reader, in French", async () => {
		const { harness, selects, windows } = await start();
		await harness.session.prompt("/perm help");
		expect(selects).toEqual([]);
		const text = (windows[0] ?? []).join("\n");
		expect(text).toContain("Permissions — aide");
		expect(text).toContain("règles enregistrées, dans /settings");
		expect(text).toContain("lit librement");
		expect(text).toContain("pas vos secrets de l’agent.");
		expect(text).not.toMatch(/session-only|reads freely|Rule syntax/);
	});

	it("names the mode in French in /perm status", async () => {
		// "Permissions : perm: broad", the statusline's identifier, while the footer said "large".
		const { harness, notices } = await start();
		await harness.session.prompt("/perm mode broad");
		await harness.session.prompt("/perm status");
		const first = t(notices.at(-1)?.message.split("\n")[0] ?? "");
		expect(first).toBe("Permissions : large");
		await harness.session.prompt("/perm mode safe");
		expect(t(notices.at(-1)?.message ?? "")).toBe("Mode de permission : prudent (lecture seule)");
	});
});

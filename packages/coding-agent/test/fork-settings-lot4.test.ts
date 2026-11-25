// fork: the rest of the settings mockup approved on 2026-10-21: default budgets in Conversation, desktop
// notifications kept across sessions in Notifications, MCP servers on or off and their exposure in Servers, and
// the /lsp and /mcp shortcuts there.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import budgetsExtension from "../src/fork/budgets.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import notifyExtension from "../src/fork/notify.ts";
import { budgetsSection } from "../src/fork/settings-budgets.ts";
import { SETTINGS_SHORTCUTS } from "../src/fork/settings-descriptions.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { type SectionContext, setSettingsHost, settingsSections } from "../src/fork/settings-sections.ts";
import { lspServersSection, type McpSettingsDeps, mcpServersSection } from "../src/fork/settings-servers.ts";
import type { ValueInput } from "../src/fork/settings-value-input.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");
const ENTER = "\r";
const ESC = "\x1b";
const context: SectionContext = { advanced: () => true, requestRender: vi.fn() };

describe("fork: the last settings domains", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];
	const settingsFile = () => join(agentDir, "settings.json");
	const settings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-settings-lot4-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		setLanguage("en");
		setSettingsHost(undefined);
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function start(extensions: Parameters<typeof createHarness>[0] = {}) {
		const harness = await createHarness(extensions);
		harnesses.push(harness);
		const notices: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
		});
		return { harness, notices };
	}

	it("types a default budget, refuses a wrong one and removes it with an empty field", () => {
		const section = budgetsSection(agentDir);
		const row = () => section.items(context).find((item) => item.id === "budget-default-time")!;
		expect(row().currentValue).toBe("off");
		const done = vi.fn();
		const input = row().submenu!(row().currentValue, done) as ValueInput;
		const text = () =>
			input
				.render(80)
				.map((l) => plain(l).trim())
				.join(" ");
		for (const key of "abc") input.handleInput(key);
		input.handleInput(ENTER);
		expect(text()).toContain("Type a number of minutes, such as 30.");
		for (let i = 0; i < 3; i++) input.handleInput("\x7f");
		for (const key of "45") input.handleInput(key);
		input.handleInput(ENTER);
		expect(done).toHaveBeenCalledWith("changed");
		expect(settings().budgets).toEqual({ time: 45 });
		expect(row().currentValue).toBe("45 min");
		const tokens = section.items(context).find((item) => item.id === "budget-default-tokens")!;
		const tokenInput = tokens.submenu!(tokens.currentValue, vi.fn()) as ValueInput;
		for (const key of "1.5") tokenInput.handleInput(key);
		tokenInput.handleInput(ENTER);
		expect(settings().budgets.tokens).toBeUndefined();
		const again = row().submenu!(row().currentValue, vi.fn()) as ValueInput;
		again.handleInput(ENTER);
		expect(settings().budgets).toEqual({});
		const closed = vi.fn();
		const kept = row().submenu!(row().currentValue, closed) as ValueInput;
		kept.handleInput(ESC);
		expect(closed).toHaveBeenCalledWith(undefined);
		setLanguage("fr");
		const fr = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [],
			onBuiltinExtensionChange: vi.fn(),
			sections: () => [section],
			// the default budgets are in the advanced interface only.
			interfaceMode: "advanced",
		})
			.domains()
			.find((d) => d.id === "conversation")!
			.items();
		expect(fr.find((item) => item.id === "budget-default-time")?.label).toBe("Budget de durée par défaut");
	});

	it("starts a new session with the default budgets, the cost one only with a priced model", async () => {
		writeFileSync(settingsFile(), JSON.stringify({ budgets: { tools: 5, cost: 2, tokens: -3 } }));
		const { harness, notices } = await start({
			extensionFactories: [{ name: "budgets", factory: budgetsExtension }],
		});
		expect(settingsSections().some((s) => s.domain === "conversation")).toBe(true);
		await harness.session.prompt("/budget status");
		const summary = notices.at(-1)!;
		expect(summary).toMatch(/tools: 0 \/ 5/);
		expect(summary).toMatch(/cost: off/);
		expect(summary).toMatch(/tokens: off/);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(settingsSections().some((s) => s.domain === "conversation")).toBe(false);
	});

	it("keeps desktop notifications across sessions", async () => {
		const first = await start({ extensionFactories: [{ name: "notify", factory: notifyExtension }] });
		const section = settingsSections().find((s) => s.domain === "notifications")!;
		const value = (id: string) => section.items(context).find((item) => item.id === id)?.currentValue;
		expect(value("notify-desktop")).toBe("on");
		section.onChange!("notify-approvals", "off");
		expect(settings().desktopNotifications).toEqual({ approvals: false });
		await first.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await start({ extensionFactories: [{ name: "notify", factory: notifyExtension }] });
		const next = settingsSections().find((s) => s.domain === "notifications")!;
		const items = next.items(context);
		expect(items.find((item) => item.id === "notify-desktop")?.currentValue).toBe("on");
		expect(items.find((item) => item.id === "notify-approvals")?.currentValue).toBe("off");
	});

	it("lists MCP servers with their state and changes them as /mcp does", async () => {
		const deps = {
			servers: () => [
				{
					name: "docs",
					enabled: true,
					exposure: "codemode" as const,
					state: "connected · 3 tools",
					scope: "global",
				},
				{ name: "gh", enabled: false, exposure: "direct" as const, state: "disabled", scope: "extension" },
			],
			setEnabled: vi.fn(async () => "Could not update mcp.json"),
			setExposure: vi.fn(() => undefined),
			report: vi.fn(),
		} satisfies McpSettingsDeps;
		const section = mcpServersSection(deps);
		const items = section.items(context);
		expect(items.map((item) => [item.label, item.currentValue])).toEqual([
			["MCP docs", "on"],
			["MCP docs · exposure", "codemode"],
			["MCP gh", "off"],
			["MCP gh · exposure", "direct"],
		]);
		expect(items[2]!.description).toContain("registered by an extension, for this session");
		section.onChange!("mcp-exposure:docs", "deferred");
		expect(deps.setExposure).toHaveBeenCalledWith("docs", "deferred");
		section.onChange!("mcp-enabled:docs", "off");
		await vi.waitFor(() => expect(deps.report).toHaveBeenCalledWith("Could not update mcp.json"));
		expect(deps.setEnabled).toHaveBeenCalledWith("docs", false);
		expect(section.isAdvanced!("mcp-exposure:docs")).toBe(true);
		expect(section.isAdvanced!("mcp-enabled:docs")).toBe(false);
	});

	it("puts the /lsp and /mcp shortcuts in Servers, the other action commands in Other", () => {
		const model = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [],
			onBuiltinExtensionChange: vi.fn(),
			commands: SETTINGS_SHORTCUTS,
		});
		const ids = (domain: string) =>
			model
				.domains()
				.find((d) => d.id === domain)!
				.items()
				.map((item) => item.id);
		// fork: language servers open their manager, not the list of /lsp.
		expect(ids("servers")).toEqual(["command:lsp-setup", "command:mcp"]);
		expect(ids("other")).not.toContain("command:lsp-setup");
	});

	it("the MCP extension adds its servers to Servers and saves a change to their mcp.json", async () => {
		const updateConfig = vi.fn();
		const entry: McpServerEntry = {
			name: "docs",
			config: { url: "http://unused.invalid", enabled: false },
			source: join(agentDir, "mcp.json"),
			scope: "global",
		};
		const { harness } = await start({
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					updateConfig,
					createTransport: () => {
						throw new Error("no server in this test");
					},
				}),
			],
		});
		const section = settingsSections().find((s) => s.domain === "servers")!;
		expect(section.items(context).map((item) => [item.id, item.currentValue])).toEqual([
			["mcp-enabled:docs", "off"],
			["mcp-exposure:docs", "codemode"],
		]);
		section.onChange!("mcp-exposure:docs", "direct");
		expect(updateConfig).toHaveBeenLastCalledWith(expect.objectContaining({ name: "docs" }), { exposure: "direct" });
		expect(section.items(context)[1]!.currentValue).toBe("direct");
		section.onChange!("mcp-enabled:docs", "on");
		expect(updateConfig).toHaveBeenLastCalledWith(expect.objectContaining({ name: "docs" }), { enabled: true });
		await vi.waitFor(() => expect(section.items(context)[0]!.description).toContain("failed"));
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(settingsSections()).not.toContain(section);
	});

	it("turns a language server off and on, each switch in the advanced interface only", () => {
		const report = vi.fn();
		const section = lspServersSection(
			() => [
				{ name: "ruff", command: "ruff server", installed: true },
				{ name: "gopls", command: "gopls", installed: false },
			],
			report,
		);
		expect(section.items(context).map((item) => [item.id, item.currentValue])).toEqual([
			["lsp-enabled:ruff", "on"],
			["lsp-enabled:gopls", "on"],
		]);
		// the simple interface keeps the Language servers page, which turns them on or off too.
		expect(section.isAdvanced!("lsp-enabled:ruff")).toBe(true);
		expect(section.isAdvanced!("lsp-enabled:gopls")).toBe(true);
		section.onChange!("lsp-enabled:ruff", "off");
		section.onChange!("lsp-enabled:gopls", "off");
		expect(settings().lsp).toEqual({ disabled: ["gopls", "ruff"] });
		expect(section.items(context)[0]!.currentValue).toBe("off");
		section.onChange!("lsp-enabled:ruff", "on");
		section.onChange!("lsp-enabled:gopls", "on");
		expect(settings().lsp).toEqual({});
		writeFileSync(settingsFile(), "{ not json");
		section.onChange!("lsp-enabled:ruff", "off");
		expect(report).toHaveBeenCalledOnce();
		setLanguage("fr");
		const fr = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [],
			onBuiltinExtensionChange: vi.fn(),
			interfaceMode: "advanced",
			sections: () => [section],
		})
			.domains()
			.find((d) => d.id === "servers")!
			.items();
		expect(fr[0]?.description).toBe(
			"Serveur de langage ruff (ruff server) : installé. Désactivé, lsp_diagnostics et lsp_fix ne le lancent pas.",
		);
	});

	it("pi-lsp lists its servers in Servers and leaves out the ones turned off", async () => {
		writeFileSync(
			join(agentDir, "pi-lsp.json"),
			JSON.stringify({
				servers: {
					fake: { command: [process.execPath, "fake-server.mjs"], extensions: [".fake"] },
					other: { command: ["prism-no-such-lsp"], extensions: [".other"] },
				},
			}),
		);
		const lsp = builtInExtensions.find((extension) => typeof extension !== "function" && extension.name === "pi-lsp");
		if (!lsp || typeof lsp === "function") throw new Error("no built-in pi-lsp");
		const { harness, notices } = await start({ extensionFactories: [{ name: "pi-lsp", factory: lsp.factory }] });
		const section = settingsSections().find((s) => s.domain === "servers")!;
		const items = section.items(context);
		expect(items.map((item) => [item.id, item.currentValue])).toEqual([
			["lsp-enabled:fake", "on"],
			["lsp-enabled:other", "on"],
		]);
		expect(items[0]!.description).toContain(": installed.");
		expect(section.isAdvanced!("lsp-enabled:other")).toBe(true);
		// fork: /lsp sums up, instead of two lines for each server in a warning.
		await harness.session.prompt("/lsp");
		expect(notices.at(-1)).toBe(
			[
				"Language servers ready: fake.",
				"other is not installed: /lsp-setup lists this project's servers and installs them.",
				"/lsp all lists each server's command.",
			].join("\n"),
		);
		section.onChange!("lsp-enabled:fake", "off");
		await harness.session.prompt("/lsp");
		expect(notices.at(-1)).toContain("No language server is ready.\nTurned off in /settings › Servers: fake.");
		await harness.session.prompt("/lsp all");
		const status = notices.at(-1)!;
		expect(status).toContain("fake status: off in /settings > Servers");
		expect(status).not.toContain("fake LSP command");
		expect(status).toContain("other status: command missing");
		// the same list in French; server names and commands stay as they are.
		setLanguage("fr");
		await harness.session.prompt("/lsp all");
		const french = notices.at(-1)!;
		expect(french).toContain("fake : désactivé dans /settings › Serveurs");
		expect(french).toContain("Commande LSP de other : prism-no-such-lsp");
		expect(french).toContain("other : commande introuvable");
		setLanguage("en");
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(settingsSections()).not.toContain(section);
	});
});

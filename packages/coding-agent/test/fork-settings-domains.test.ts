// fork: /settings grouped by domain, advanced mode, built-in extension switches, web search keys.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingItem } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { readGlobalSetting } from "../src/fork/global-settings.ts";
import { updateMode } from "../src/fork/self-update.ts";
import {
	builtinExtensionNames,
	createSettingsDomainExtras,
	setBuiltinExtensionEnabled,
} from "../src/fork/settings-domain-extras.ts";
import {
	ADVANCED_SETTINGS,
	groupSettingsByDomain,
	type SettingsDomainExtras,
	type SettingsModel,
} from "../src/fork/settings-domains.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function item(id: string): SettingItem {
	return { id, label: id, currentValue: "a", values: ["a", "b"] };
}

/** Items of the menu a setting opens (web search choices). */
function open(top: SettingItem): SettingItem[] {
	const component = top.submenu?.("›", () => {}) as unknown as { settingsList: { items: SettingItem[] } };
	return component.settingsList.items;
}

/** The settings of the domain labelled `label` in the current interface mode. */
const domainItems = (model: SettingsModel, label: string) =>
	model
		.domains()
		.find((d) => d.label === label)!
		.items();
const domainLabels = (model: SettingsModel) => model.domains().map((d) => d.label);

const extras = (overrides: Partial<SettingsDomainExtras> = {}): SettingsDomainExtras => ({
	builtinExtensions: [
		{ name: "web", enabled: true },
		{ name: "memory", enabled: false },
	],
	onBuiltinExtensionChange: vi.fn(),
	sections: () => [],
	...overrides,
});

describe("fork: /settings by domain", () => {
	const dirs: string[] = [];
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		const dir = mkdtempSync(join(tmpdir(), "prism-settings-domains-"));
		dirs.push(dir);
		vi.stubEnv(ENV_AGENT_DIR, dir);
		for (const env of ["EXA_API_KEY", "BRAVE_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY"])
			vi.stubEnv(env, "from-env");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	// the domains of the approved mockup; Other ends the list with the action commands.
	it("lists domains, then modules, the interface and Other; settings added upstream land in Other", () => {
		const items = ["theme", "autocompact", "transport", "brand-new-upstream-setting"].map(item);
		const grouped = groupSettingsByDomain(
			items,
			vi.fn(),
			extras({
				webSearch: { provider: "exa", keySource: "none" },
				commands: [{ command: "perm", label: "Permissions", description: "d" }],
			}),
		);
		expect(domainLabels(grouped)).toEqual([
			"Appearance",
			"Conversation",
			"Network & web",
			"Modules",
			"Interface",
			"Other",
		]);
		expect(domainItems(grouped, "Appearance").map((entry) => entry.id)).toEqual(["theme"]);
		// A setting upstream adds later is never lost; the action commands follow it.
		expect(domainItems(grouped, "Other").map((entry) => entry.id)).toEqual([
			"brand-new-upstream-setting",
			"update-mode",
			"command:perm",
		]);
		// the add-on switches alone; the web search service is in Network & web.
		expect(domainItems(grouped, "Modules").map((entry) => entry.id)).toEqual(["builtin:web", "builtin:memory"]);
		// Exa needs no key, so its key row is only in the advanced interface.
		expect(domainItems(grouped, "Network & web").map((entry) => entry.id)).toEqual(["web-search-provider"]);
		expect(domainItems(grouped, "Interface").map((entry) => entry.id)).toEqual(["interface-mode"]);
		grouped.onChange("interface-mode", "advanced");
		expect(domainItems(grouped, "Network & web").map((entry) => entry.id)).toContain("web-search-key");
	});

	it("hides technical settings until advanced settings are shown, and says which ones they are", () => {
		expect(ADVANCED_SETTINGS.has("transport")).toBe(true);
		expect(ADVANCED_SETTINGS.has("clear-on-shrink")).toBe(true);
		const grouped = groupSettingsByDomain(
			[item("transport"), item("theme"), item("tui-mode"), item("clear-on-shrink")],
			vi.fn(),
			extras(),
		);
		expect(domainItems(grouped, "Terminal").map((entry) => entry.id)).toEqual(["tui-mode"]);
		expect(grouped.counts()).toEqual({ shown: 6, total: 9 });
		grouped.onChange("interface-mode", "advanced");
		expect(domainItems(grouped, "Terminal").map((entry) => entry.id)).toEqual(["tui-mode", "clear-on-shrink"]);
		expect(grouped.isAdvancedSetting("clear-on-shrink")).toBe(true);
		expect(grouped.isAdvancedSetting("tui-mode")).toBe(false);
		expect(grouped.counts()).toEqual({ shown: 9, total: 9 });
	});

	// Simple keeps what changes a newcomer's experience.
	it("keeps internal modules, duplicates and Exa's optional key out of the simple interface", () => {
		const modules = ["web", "trace", "notify", "pi-goal"].map((name) => ({ name, enabled: true }));
		const grouped = groupSettingsByDomain(
			[item("mermaid-rendering"), item("compaction-threshold")],
			vi.fn(),
			extras({ builtinExtensions: modules, webSearch: { provider: "exa", keySource: "none" } }),
		);
		expect(domainItems(grouped, "Modules").map((entry) => entry.id)).toEqual(["builtin:web", "builtin:pi-goal"]);
		expect(domainItems(grouped, "Conversation").map((entry) => entry.id)).toEqual(["compaction-threshold"]);
		expect(domainItems(grouped, "Network & web").map((entry) => entry.id)).toEqual(["web-search-provider"]);
		// The module's internal name ends its description only in the advanced interface.
		const goal = () => domainItems(grouped, "Modules").find((entry) => entry.id === "builtin:pi-goal")!;
		expect(goal().description).not.toContain("Module:");
		grouped.onChange("interface-mode", "advanced");
		expect(goal().description).toContain("Module: pi-goal.");
		expect(domainItems(grouped, "Modules").map((entry) => entry.id)).toContain("builtin:trace");
		// A service that needs its key keeps the key row in Simple.
		const brave = groupSettingsByDomain([], vi.fn(), extras({ webSearch: { provider: "brave", keySource: "none" } }));
		expect(domainItems(brave, "Network & web").map((entry) => entry.id)).toEqual([
			"web-search-provider",
			"web-search-key",
		]);
	});

	// the interface mode is saved, and a saved advanced mode shows technical settings.
	it("saves the interface mode and starts from the saved one", () => {
		const onInterfaceModeChange = vi.fn();
		const grouped = groupSettingsByDomain(
			[item("theme"), item("tui-mode"), item("clear-on-shrink")],
			vi.fn(),
			extras({ interfaceMode: "advanced", onInterfaceModeChange }),
		);
		expect(grouped.isAdvanced()).toBe(true);
		expect(domainItems(grouped, "Interface")[0]!.currentValue).toBe("advanced");
		expect(domainItems(grouped, "Terminal").map((entry) => entry.id)).toEqual(["tui-mode", "clear-on-shrink"]);
		grouped.onChange("interface-mode", "simple");
		expect(onInterfaceModeChange).toHaveBeenCalledWith("simple");
		expect(grouped.isAdvanced()).toBe(false);
	});

	// advanced settings showed, and could be changed, in the simple interface. A domain
	// of advanced settings only (Network) is left out of the simple list and comes back in advanced.
	it("leaves advanced settings out of the simple interface, everywhere, and brings them back in place", () => {
		const grouped = groupSettingsByDomain([item("transport"), item("theme")], vi.fn(), extras());
		expect(domainLabels(grouped)).not.toContain("Network & web");

		grouped.onChange("interface-mode", "advanced");
		expect(domainLabels(grouped)).toContain("Network & web");
		expect(domainItems(grouped, "Network & web").map((entry) => entry.id)).toEqual([
			"transport",
			"model-catalog-refresh",
		]);

		grouped.onChange("interface-mode", "simple");
		expect(domainLabels(grouped)).not.toContain("Network & web");
	});

	it("describes settings concretely, Mermaid included", () => {
		const grouped = groupSettingsByDomain(
			[{ ...item("mermaid-rendering"), description: "Render Mermaid code blocks as Unicode diagrams" }],
			vi.fn(),
			// an advanced setting.
			extras({ interfaceMode: "advanced" }),
		);
		expect(domainItems(grouped, "Appearance")[0]!.description).toContain("flowcharts");
	});

	it("runs the action commands from Other", () => {
		const onRunCommand = vi.fn();
		const grouped = groupSettingsByDomain(
			[item("theme")],
			vi.fn(),
			// llama.cpp's page is in the advanced interface only.
			extras({
				commands: [{ command: "llama", label: "llama.cpp models", description: "d" }],
				onRunCommand,
				interfaceMode: "advanced",
			}),
		);
		expect(domainItems(grouped, "Other").map((entry) => entry.label)).toEqual(["Updates", "llama.cpp models"]);
		grouped.onChange("command:llama", "open");
		// fork: with the domain and row, so a window it opens comes back to them.
		expect(onRunCommand).toHaveBeenCalledWith("llama", { domain: "other", item: "command:llama" });
	});

	// manual by default, saved in the global settings.
	it("saves the update mode, and manual by leaving it out", () => {
		const grouped = groupSettingsByDomain([item("theme")], vi.fn(), extras());
		const row = () => domainItems(grouped, "Other").find((entry) => entry.id === "update-mode")!;
		expect(row().currentValue).toBe("manual");
		expect(row().values).toEqual(["manual", "notify me", "automatic"]);
		grouped.onChange("update-mode", "automatic");
		expect(updateMode()).toBe("auto");
		grouped.onChange("update-mode", "notify me");
		expect(updateMode()).toBe("notify");
		grouped.onChange("update-mode", "manual");
		expect(readGlobalSetting("updateMode")).toBeUndefined();
	});

	it("routes upstream ids to the upstream handler and fork ids to the fork actions", () => {
		const upstream = vi.fn();
		const onWebSearchKey = vi.fn();
		const actions = extras({ webSearch: { provider: "exa", keySource: "auth" }, onWebSearchKey });
		const grouped = groupSettingsByDomain([item("theme")], upstream, actions);
		grouped.onChange("theme", "b");
		grouped.onChange("builtin:memory", "on");
		grouped.onChange("web-search-key", "remove");
		expect(upstream).toHaveBeenCalledWith("theme", "b");
		expect(upstream).toHaveBeenCalledTimes(1);
		expect(actions.onBuiltinExtensionChange).toHaveBeenCalledWith("memory", true);
		expect(onWebSearchKey).toHaveBeenCalledWith("remove");
	});

	// fork: the logo animation switch lives in Appearance and is saved in the user settings.
	it("shows the animations switch in Appearance and saves it", async () => {
		// The env key keeps the extras from reading the auth file of the machine running the tests.
		vi.stubEnv("EXA_API_KEY", "from-env");
		const settings = SettingsManager.inMemory({});
		const actions = await createSettingsDomainExtras({
			settings,
			loadedExtensionPaths: [],
			hasWebKeyCommand: false,
			onWebSearchKey: vi.fn(),
		});
		expect(actions.animations).toBe(true);
		const grouped = groupSettingsByDomain([item("theme")], vi.fn(), actions);
		expect(domainItems(grouped, "Appearance").map((entry) => entry.id)).toEqual(["theme", "animations"]);
		grouped.onChange("animations", "off");
		expect(settings.getAnimations()).toBe(false);
		expect(settings.getGlobalSettings().animations).toBe(false);
	});

	it("offers Firecrawl in Web search, saves the selection and shows its key configuration", async () => {
		const settings = SettingsManager.inMemory();
		const onWebSearchReload = vi.fn();
		const options = {
			settings,
			loadedExtensionPaths: [],
			hasWebKeyCommand: true,
			onWebSearchKey: vi.fn(),
			onWebSearchReload,
		};
		const actions = await createSettingsDomainExtras(options);
		const grouped = groupSettingsByDomain([], vi.fn(), actions);
		const provider = domainItems(grouped, "Network & web").find((entry) => entry.id === "web-search-provider")!;
		expect(open(provider).map((entry) => entry.id)).toEqual(["exa", "brave", "tavily", "firecrawl", "searxng"]);
		expect(provider.description).toContain("Firecrawl need a key");
		grouped.onChange("web-search-provider", "firecrawl");
		await settings.flush();
		expect(settings.getWebSearchProvider()).toBe("firecrawl");
		expect(settings.getGlobalSettings().webSearchProvider).toBe("firecrawl");
		expect(onWebSearchReload).toHaveBeenCalledOnce();
		const configured = groupSettingsByDomain([], vi.fn(), await createSettingsDomainExtras(options));
		const key = domainItems(configured, "Network & web").find((entry) => entry.id === "web-search-key")!;
		expect(key.label).toBe("Firecrawl API key");
		expect(key.currentValue).toBe("FIRECRAWL_API_KEY");
		expect(open(key).map((entry) => entry.id)).toEqual(["set a key", "remove"]);
		expect(JSON.stringify(key)).not.toContain("from-env");
		configured.onChange("web-search-key", "set a key");
		configured.onChange("web-search-key", "remove");
		expect(options.onWebSearchKey.mock.calls).toEqual([["set"], ["remove"]]);
	});

	it("shows every built-in extension but not the permission gate", () => {
		const names = builtinExtensionNames();
		expect(names).toEqual(expect.arrayContaining(["prism", "web", "memory", "pi-lsp"]));
		expect(names).not.toContain("permissions");
	});

	it("writes one explicit entry per built-in extension in the user setting", () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-settings-domains-"));
		dirs.push(dir);
		const settings = SettingsManager.inMemory({ extensions: ["./mine.ts", "-builtin:memory", "!builtin:memory"] });
		setBuiltinExtensionEnabled(settings, "memory", true);
		expect(settings.getGlobalSettings().extensions).toEqual(["./mine.ts", "+builtin:memory"]);
		setBuiltinExtensionEnabled(settings, "web", false);
		expect(settings.getGlobalSettings().extensions).toEqual(["./mine.ts", "+builtin:memory", "-builtin:web"]);
	});

	it("reports extension state from what is loaded, and web search only when /web-key exists", async () => {
		const saved = process.env.EXA_API_KEY;
		process.env.EXA_API_KEY = "from-env";
		try {
			const result = await createSettingsDomainExtras({
				settings: SettingsManager.inMemory(),
				loadedExtensionPaths: ["builtin:web", "/home/user/mine.ts"],
				hasWebKeyCommand: true,
				onWebSearchKey: vi.fn(),
			});
			expect(result.builtinExtensions.find((entry) => entry.name === "web")?.enabled).toBe(true);
			expect(result.builtinExtensions.find((entry) => entry.name === "prism")?.enabled).toBe(false);
			expect(result.webSearch).toEqual({ provider: "exa", keySource: "env", url: undefined });
			const withoutWeb = await createSettingsDomainExtras({
				settings: SettingsManager.inMemory(),
				loadedExtensionPaths: [],
				hasWebKeyCommand: false,
				onWebSearchKey: vi.fn(),
			});
			expect(withoutWeb.webSearch).toBeUndefined();
		} finally {
			if (saved === undefined) delete process.env.EXA_API_KEY;
			else process.env.EXA_API_KEY = saved;
		}
	});
});

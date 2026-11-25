// fork: every setting in /settings: the domains of the mockup, the Models
// domain, sections added by built-in extensions, rows found only by the search, and commands that open a page.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingItem } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { groupSettingsByDomain, type SettingsDomainExtras, type SettingsModel } from "../src/fork/settings-domains.ts";
import type { ModelsSettings } from "../src/fork/settings-models.ts";
import {
	openSettings,
	type SettingsSection,
	setSettingsHost,
	setSettingsSection,
	settingsSections,
} from "../src/fork/settings-sections.ts";
import { SettingsView } from "../src/fork/settings-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");

function fakeModel(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://localhost:8080/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32000,
		...overrides,
	};
}

const extras = (overrides: Partial<SettingsDomainExtras> = {}): SettingsDomainExtras => ({
	builtinExtensions: [],
	onBuiltinExtensionChange: vi.fn(),
	sections: () => [],
	...overrides,
});

const ids = (model: SettingsModel, domain: string) =>
	model
		.domains()
		.find((d) => d.id === domain)
		?.items()
		.map((item) => item.id);

function models(overrides: Partial<ModelsSettings> = {}): ModelsSettings {
	return {
		models: [fakeModel("local", "coder-30b"), fakeModel("cloud", "large-model")],
		defaultModel: "local/coder-30b",
		onDefaultModel: vi.fn(),
		thinkingLevel: "medium",
		thinkingLevels: ["off", "low", "medium", "high"],
		onThinkingLevel: vi.fn(),
		...overrides,
	};
}

describe("fork: all the settings in /settings", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		setSettingsHost(undefined);
		for (const owner of ["test-a", "test-b"]) setSettingsSection(owner, undefined);
	});

	it("orders the domains as the approved mockup, Other last", () => {
		const section = (domain: string): SettingsSection => ({
			domain,
			items: () => [{ id: `${domain}-x`, label: "x", currentValue: "on", values: ["on", "off"] }],
		});
		const model = groupSettingsByDomain(
			["theme", "autocompact", "tui-mode", "block-images", "warnings", "brand-new"].map((id) => ({
				id,
				label: id,
				currentValue: "a",
				values: ["a", "b"],
			})),
			vi.fn(),
			extras({
				models: models(),
				webSearch: { provider: "exa", keySource: "none" },
				builtinExtensions: [{ name: "web", enabled: true }],
				sections: () => [section("permissions"), section("servers"), section("notifications")],
			}),
		);
		expect(model.domains().map((d) => d.label)).toEqual([
			"Appearance",
			"Conversation",
			"Models",
			"Permissions & sandbox",
			"Terminal",
			"Images & privacy",
			"Network & web",
			"Notifications",
			"Servers",
			"Modules",
			"Interface",
			"Other",
		]);
		// the warnings list is in the advanced interface only.
		expect(ids(model, "notifications")).toEqual(["notifications-x"]);
		model.onChange("interface-mode", "advanced");
		expect(ids(model, "notifications")).toEqual(["warnings", "notifications-x"]);
	});

	it("gives Models the default model, the thinking level, the per-model levels and the cycle", () => {
		const onRunCommand = vi.fn();
		const settings = models();
		const upstream = { id: "model-thinking", label: "Thinking level for each model", currentValue: "none" };
		// the per-model levels and the cycle are advanced; the simple interface keeps the first two.
		const simple = groupSettingsByDomain([upstream], vi.fn(), extras({ models: settings, onRunCommand }));
		expect(ids(simple, "models")).toEqual(["default-model", "default-thinking"]);
		const model = groupSettingsByDomain(
			[upstream],
			vi.fn(),
			extras({ models: settings, onRunCommand, interfaceMode: "advanced" }),
		);
		expect(ids(model, "models")).toEqual([
			"default-model",
			"default-thinking",
			"model-thinking",
			"command:scoped-models",
		]);
		const [defaultModel, thinking, , cycle] = model
			.domains()
			.find((d) => d.id === "models")!
			.items();
		expect(defaultModel!.currentValue).toBe("local/coder-30b");
		expect(thinking!.values).toEqual(["off", "low", "medium", "high"]);
		expect(cycle!.currentValue).toBe("all 2 models");

		model.onChange("default-model", "cloud/large-model");
		expect(settings.onDefaultModel).toHaveBeenCalledWith(settings.models[1]);
		model.onChange("default-thinking", "high");
		expect(settings.onThinkingLevel).toHaveBeenCalledWith("high");
		model.onChange("command:scoped-models", "all 2 models");
		expect(onRunCommand).toHaveBeenCalledWith("scoped-models", { domain: "models", item: "command:scoped-models" });

		const scoped = groupSettingsByDomain(
			[],
			vi.fn(),
			extras({ models: models({ cycleCount: 1 }), interfaceMode: "advanced" }),
		);
		expect(scoped.domains()[0]!.items().at(-1)!.currentValue).toBe("1 of 2 models");
	});

	it("draws a section's settings in its domain, sends its changes to it and reads it again after a change", () => {
		let calls = 0;
		let value = "off";
		const onChange = vi.fn((_id: string, next: string) => {
			value = next;
		});
		const upstream = vi.fn();
		const model = groupSettingsByDomain(
			[],
			upstream,
			extras({
				sections: () => [
					{
						domain: "permissions",
						items: () => {
							calls++;
							return [
								{ id: "sandbox-bus", label: "System D-Bus", currentValue: value, values: ["on", "off"] },
								{ id: "sandbox-write", label: "Writable paths", currentValue: "none", values: ["none", "x"] },
							];
						},
						onChange,
						isAdvanced: (id) => id === "sandbox-write",
					},
				],
			}),
		);
		const permissions = () => model.domains().find((d) => d.id === "permissions")!;
		expect(
			permissions()
				.items()
				.map((item) => item.id),
		).toEqual(["sandbox-bus"]);
		permissions().items();
		permissions().items();
		// Built once, not at each redraw.
		expect(calls).toBe(1);
		model.onChange("sandbox-bus", "on");
		expect(onChange).toHaveBeenCalledWith("sandbox-bus", "on");
		expect(upstream).not.toHaveBeenCalled();
		expect(permissions().items()[0]!.currentValue).toBe("on");
		expect(model.isAdvancedSetting("sandbox-write")).toBe(true);
		model.onChange("interface-mode", "advanced");
		expect(
			permissions()
				.items()
				.map((item) => item.id),
		).toEqual(["sandbox-bus", "sandbox-write"]);
	});

	it("leaves out a domain with nothing to set", () => {
		const model = groupSettingsByDomain([{ id: "theme", label: "Theme", currentValue: "dark" }], vi.fn(), extras());
		expect(model.domains().map((d) => d.id)).not.toContain("servers");
		expect(model.domains().map((d) => d.id)).not.toContain("permissions");
	});

	it("finds rows that only the search shows, and opens a page from them", () => {
		const page = vi.fn();
		const searchOnly: SettingItem = {
			id: "model:local/coder-30b:maxTokens",
			label: "Max output · local/coder-30b",
			currentValue: "32000",
			submenu: (_value, done) => {
				page();
				return { render: () => ["page"], invalidate: () => {}, handleInput: () => done() };
			},
		};
		const model = groupSettingsByDomain(
			[],
			vi.fn(),
			extras({
				models: models(),
				sections: () => [{ domain: "models", items: () => [], searchItems: () => [searchOnly] }],
			}),
		);
		const view = new SettingsView(model, { onClose: vi.fn(), rows: () => 30 });
		expect(view.render(100).map(plain).join("\n")).not.toContain("Max output");
		for (const key of "/max output") view.handleInput(key);
		const lines = view.render(100).map(plain);
		expect(lines.some((l) => l.includes("Max output · local/coder-30b") && l.includes("Models"))).toBe(true);
		view.handleInput("\x1b[B");
		view.handleInput("\r");
		expect(page).toHaveBeenCalledOnce();
	});

	it("opens on a setting, and opens that setting when asked", () => {
		const model = groupSettingsByDomain([], vi.fn(), extras({ models: models() }));
		const view = new SettingsView(model, {
			onClose: vi.fn(),
			rows: () => 30,
			domain: "models",
			item: "default-thinking",
			openItem: true,
		});
		const lines = view.render(100).map(plain);
		// The choices of the thinking level are open, the current one marked.
		expect(lines.some((l) => l.includes("● medium"))).toBe(true);
	});

	it("lets commands open /settings only where there is a window", () => {
		expect(openSettings({ domain: "permissions" })).toBe(false);
		const host = vi.fn();
		setSettingsHost(host);
		expect(openSettings({ domain: "permissions", item: "sandbox-modes", open: true })).toBe(true);
		expect(host).toHaveBeenCalledWith({ domain: "permissions", item: "sandbox-modes", open: true });
	});

	it("replaces a section on reload and removes it when its module stops", () => {
		const first: SettingsSection = { domain: "servers", items: () => [] };
		const second: SettingsSection = { domain: "servers", items: () => [] };
		setSettingsSection("test-a", first);
		setSettingsSection("test-a", second);
		expect(settingsSections().filter((s) => s.domain === "servers")).toEqual([second]);
		setSettingsSection("test-a", undefined);
		expect(settingsSections()).not.toContain(second);
	});
});

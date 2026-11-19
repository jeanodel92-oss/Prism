import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../src/core/compaction/compaction.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { collectSettingsDiagnostics } from "../src/core/settings-diagnostics.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { getCompactionThresholdTokens, lowThresholdWarning } from "../src/fork/compaction-threshold.ts";
import { createCompactionThresholdSetting } from "../src/fork/compaction-threshold-setting.ts";
import { createCompactionThresholdModelChangeWarning } from "../src/fork/compaction-threshold-warning.ts";
import { ADVANCED_SETTINGS } from "../src/fork/settings-domains.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const model: Model<string> = {
	id: "small",
	name: "Small test model",
	provider: "faux",
	api: "openai-completions",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131072,
	maxTokens: 8192,
};

describe("fork: configurable compaction threshold", () => {
	const dirs: string[] = [];
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.each([0, 1, 16384, 200000])(
		"preserves the default formula and strict boundary with reserve %s",
		(reserveTokens) => {
			const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens };
			const trigger = model.contextWindow - reserveTokens;
			expect(getCompactionThresholdTokens(model.contextWindow, reserveTokens)).toBe(trigger);
			expect(shouldCompact(trigger, model.contextWindow, settings)).toBe(false);
			expect(shouldCompact(trigger + 1, model.contextWindow, settings)).toBe(true);
			expect(SettingsManager.inMemory().getCompactionSettings(model)).toEqual(DEFAULT_COMPACTION_SETTINGS);
		},
	);

	it("uses the requested percentage and keeps summarization budgets unchanged", () => {
		const manager = SettingsManager.inMemory({ compaction: { thresholdPercent: 80 } });
		const settings = manager.getCompactionSettings(model);
		const trigger = model.contextWindow * 0.8;
		expect(settings.reserveTokens).toBe(16384);
		expect(settings.keepRecentTokens).toBe(20000);
		expect(shouldCompact(trigger, model.contextWindow, settings)).toBe(false);
		expect(shouldCompact(trigger + 1, model.contextWindow, settings)).toBe(true);
		expect(shouldCompact(model.contextWindow, model.contextWindow, { ...settings, enabled: false })).toBe(false);
	});

	it.each([
		{ maxTokens: undefined, reserve: 4096 },
		{ maxTokens: 0, reserve: 4096 },
		{ maxTokens: Number.NaN, reserve: 4096 },
		{ maxTokens: Infinity, reserve: 4096 },
		{ maxTokens: 1000, reserve: 4096 },
		{ maxTokens: 8192, reserve: 8192 },
		{ maxTokens: 1000000, reserve: 16384 },
	])("caps high percentages with reply capacity $maxTokens", ({ maxTokens, reserve }) => {
		const window = 20000;
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent: 100, thresholdMaxTokens: maxTokens };
		expect(getCompactionThresholdTokens(window, 0, 100, maxTokens)).toBe(window - reserve);
		expect(shouldCompact(window - reserve, window, settings)).toBe(false);
		expect(shouldCompact(window - reserve + 1, window, settings)).toBe(true);
	});

	it("compacts immediately when the safety reserve fills a tiny context", () => {
		expect(getCompactionThresholdTokens(2048, 0, 95)).toBe(0);
		expect(shouldCompact(1, 2048, { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent: 95 })).toBe(true);
	});

	it("calculates using the supplied server window rather than a cached model window", () => {
		const settings = SettingsManager.inMemory({ compaction: { thresholdPercent: 80 } }).getCompactionSettings(model);
		expect(shouldCompact(12000, 20000, settings)).toBe(true);
		expect(shouldCompact(12000, model.contextWindow, settings)).toBe(false);
	});

	it("warns at the keep-recent boundary and stays quiet one token above it", () => {
		expect(lowThresholdWarning(40000, 4096, 20000, 50, 4096)).toContain(
			"starts at 20k tokens and keeps the last 20k",
		);
		expect(lowThresholdWarning(40002, 4096, 20000, 50, 4096)).toBeUndefined();
		expect(lowThresholdWarning(32000, 4096, 20000, 50, 4096)).toBe(
			"Compaction would have nothing to summarize: it starts at 16k tokens and keeps the last 20k as they are. Raise the threshold percentage.",
		);
		expect(lowThresholdWarning(32000, 4096, 20000)).toBeUndefined();
	});

	it("warns once when a changed model has a low threshold", () => {
		const manager = SettingsManager.inMemory({ compaction: { thresholdPercent: 50 } });
		const largeModel = { ...model, id: "large", contextWindow: 131072 };
		const warn = vi.fn();
		const onModelChange = createCompactionThresholdModelChangeWarning(manager, warn, largeModel);
		onModelChange({ ...model, contextWindow: 32000 });
		onModelChange({ ...model, contextWindow: 32000 });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("starts at 16k tokens"));
	});

	it.each([null, -1, 0, 101, "80", true, {}, []])(
		"reports malformed stored percentages once and keeps the default trigger: %j",
		(value) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ compaction: { thresholdPercent: value } }));
			const manager = SettingsManager.fromStorage(storage);
			const diagnostics = collectSettingsDiagnostics(manager);
			expect(diagnostics).toEqual([
				{ type: "warning", message: expect.stringContaining("compaction.thresholdPercent") },
			]);
			expect(manager.getCompactionSettings(model).thresholdPercent).toBeUndefined();
			manager.getCompactionSettings(model);
			expect(manager.drainErrors()).toEqual([]);
		},
	);

	it("reports a malformed threshold during reload before it is read, only once", async () => {
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
		storage.withLock("global", () => JSON.stringify({ compaction: { thresholdPercent: "80" } }));
		await manager.reload();
		expect(collectSettingsDiagnostics(manager)).toEqual([
			{ type: "warning", message: expect.stringContaining("compaction.thresholdPercent") },
		]);
		expect(manager.getCompactionSettings(model)).toEqual(DEFAULT_COMPACTION_SETTINGS);
		await manager.reload();
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
		storage.withLock("global", () => JSON.stringify({ compaction: { thresholdPercent: 80 } }));
		await manager.reload();
		expect(manager.getCompactionThresholdPercent()).toBe(80);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
	});

	it.each([Number.NaN, Infinity, -Infinity, 0, 101])("rejects invalid changes without saving them: %s", (value) => {
		const manager = SettingsManager.inMemory({ compaction: { thresholdPercent: 80 } });
		expect(() => manager.setCompactionThresholdPercent(value)).toThrow("compaction.thresholdPercent");
		expect(manager.getCompactionThresholdPercent()).toBe(80);
	});

	it("persists a choice made through /settings and restores Default without losing other fields", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prism-compaction-threshold-"));
		dirs.push(dir);
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "project");
		mkdirSync(agentDir);
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		const original = {
			compaction: {
				reserveTokens: 1000,
				keepRecentTokens: 500,
				modelOverrides: { "faux/small": { reserveTokens: 2000 } },
			},
		};
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(original));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ compaction: { thresholdPercent: 90 } }),
		);
		const manager = SettingsManager.create(cwd, agentDir);
		expect(manager.getCompactionThresholdPercent()).toBeUndefined();
		const config = {
			autoCompact: true,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			doubleEscapeAction: "tree",
			defaultModel: "faux/small",
			currentModel: model,
			availableDefaultModels: [model],
			modelThinkingLevels: {},
			domainExtras: { builtinExtensions: [], onBuiltinExtensionChange: () => {}, compactionSettings: manager },
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("compaction-threshold");
		let output = stripAnsi(list.render(100).join("\n"));
		expect(output.indexOf("Auto-compact threshold")).toBeGreaterThan(output.indexOf("Auto-compact  "));
		expect(ADVANCED_SETTINGS.has("compaction-threshold")).toBe(false);
		list.handleInput("\r");
		for (let i = 0; i < 4; i++) list.handleInput("\x1b[B"); // Default -> 80%.
		list.handleInput("\r");
		await manager.flush();
		expect(manager.drainErrors()).toEqual([]);
		const reloaded = SettingsManager.create(cwd, agentDir);
		expect(reloaded.getCompactionThresholdPercent()).toBe(80);
		expect(reloaded.getGlobalSettings()).toEqual({ compaction: { ...original.compaction, thresholdPercent: 80 } });
		output = stripAnsi(list.render(64).join("\n"));
		expect(output).toContain("80%");
		expect(output).toContain("104,858 of 131,072 tokens");
		list.handleInput("\r");
		for (let i = 0; i < 4; i++) list.handleInput("\x1b[A");
		list.handleInput("\r");
		await manager.flush();
		expect(SettingsManager.create(cwd, agentDir).getCompactionSettings(model)).toEqual({
			enabled: true,
			reserveTokens: 2000,
			keepRecentTokens: 500,
		});
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual(original);
	});

	it("shows the cap and current model's effective token value", () => {
		const manager = SettingsManager.inMemory({ compaction: { thresholdPercent: 95 } });
		const item = createCompactionThresholdSetting(manager, { ...model, contextWindow: 100000 });
		expect(item.currentValue).toBe("95% (capped at 91.8%; compacts at ~91,808 of 100,000 tokens)");
		expect(createCompactionThresholdSetting(manager).currentValue).toBe("95%");
		expect(manager.getCompactionThresholdPercent()).toBe(95);
	});

	it("shows the warning in the setting description only for the small context model", () => {
		const manager = SettingsManager.inMemory({ compaction: { thresholdPercent: 50 } });
		const small = createCompactionThresholdSetting(manager, { ...model, contextWindow: 32000 });
		const large = createCompactionThresholdSetting(manager, { ...model, contextWindow: 131072 });
		expect(small.description).toContain("starts at 16k tokens and keeps the last 20k");
		expect(large.description).not.toContain("nothing to summarize");
		const choices = small.submenu?.(small.currentValue, () => {});
		expect(choices?.render(1000).join("\n")).toContain("50% too low, nothing to summarize");
	});

	it("warns on each submenu choice for its own percentage, not the saved one", () => {
		const manager = SettingsManager.inMemory({ compaction: { thresholdPercent: 50 } });
		const item = createCompactionThresholdSetting(manager, { ...model, contextWindow: 32000 });
		const lines = item.submenu?.(item.currentValue, () => {}).render(1000) ?? [];
		const line = (label: string) => lines.find((l) => l.includes(`${label} (`)) ?? "";
		const line50 = lines.find((l) => l.includes("50% too low")) ?? "";
		expect(line50).toContain("compacts at");
		expect(line("90%")).toContain("compacts at");
		expect(line("90%")).not.toContain("nothing to summarize");
	});
});

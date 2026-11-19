// fork: each model's page in /settings > Models: one row per model with
// its count of corrections, the server and Prism columns, editing in place, the search finding one model's
// setting, and /model-settings opening the current model's page.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { writeToolCalls } from "../src/fork/capability-store.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import modelSettings, { readModelCorrection, type ServerValues } from "../src/fork/model-settings.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { ModelPage, type ModelPageDeps, modelPagesSection } from "../src/fork/settings-model-page.ts";
import { setSettingsHost, settingsSections } from "../src/fork/settings-sections.ts";
import { SettingsView } from "../src/fork/settings-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");
const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";

function fakeModel(provider: string, id: string): Model<Api> {
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
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("fork: each model's page in /settings", () => {
	let dir: string;
	let deps: ModelPageDeps;
	const coder = fakeModel("local", "coder-30b");
	const large = fakeModel("cloud", "large-model");
	const server: ServerValues = {
		kind: "llama.cpp",
		model: { id: "coder-30b", contextWindow: 131072, vision: "no", tools: "yes", reasoning: "yes" },
	};

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-model-pages-"));
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		deps = {
			modelsPath,
			capabilitiesFile: join(dir, "capabilities.json"),
			models: () => [coder, large],
			current: () => coder,
			readServer: vi.fn(async (model: Model<Api>) => (model.provider === "local" ? server : undefined)),
			reload: vi.fn(async (model: Model<Api>) => model),
		};
	});
	afterEach(() => {
		setLanguage("en");
		setSettingsHost(undefined);
		rmSync(dir, { recursive: true, force: true });
	});

	const page = (advanced = false, onMaxOutput = false) => {
		const done = vi.fn();
		const requestRender = vi.fn();
		const view = new ModelPage(deps, coder, {
			advanced: () => advanced,
			requestRender,
			done,
			focus: onMaxOutput ? "maxTokens" : undefined,
		});
		return { view, done, requestRender, lines: () => view.render(90).map(plain) };
	};

	it("lists each model with the current one and its count of changes", async () => {
		writeFileSync(
			deps.modelsPath,
			JSON.stringify({
				providers: {
					local: { modelOverrides: { "coder-30b": { maxTokens: 30000, samplingParams: { top_k: 20 } } } },
				},
			}),
		);
		await writeToolCalls(deps.capabilitiesFile, "cloud", "large-model", false);
		const section = modelPagesSection(deps);
		const items = section.items({ advanced: () => true, requestRender: vi.fn() });
		expect(items.map((item) => [item.label, item.currentValue])).toEqual([
			["local/coder-30b", "current · 2 changes"],
			["cloud/large-model", "1 change"],
		]);
		setLanguage("fr");
		const model = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [],
			onBuiltinExtensionChange: vi.fn(),
			sections: () => [section],
		});
		const values = model
			.domains()
			.find((d) => d.id === "models")!
			.items()
			.map((item) => item.currentValue);
		expect(values).toEqual(["actuel · 2 modifications", "1 modification"]);
	});

	it("shows the server's values next to Prism's, sampling only in the advanced interface", async () => {
		const simple = page(false);
		expect(simple.lines().join("\n")).toContain("Reading the server's values…");
		await flush();
		expect(simple.requestRender).toHaveBeenCalled();
		const lines = simple.lines();
		expect(lines[0]).toBe(`local/coder-30b · current${" ".repeat(90 - 25)}`);
		expect(lines.some((l) => /^→ Name +not reported +coder-30b/.test(l))).toBe(true);
		expect(lines.some((l) => /^ {2}Images +no +no/.test(l))).toBe(true);
		expect(lines.some((l) => l.includes("Temperature"))).toBe(false);
		expect(lines.some((l) => l.includes("Advanced interface: sampling"))).toBe(true);
		const advanced = page(true);
		await flush();
		expect(advanced.lines().some((l) => /^ {2}Temperature +not reported +not sent/.test(l))).toBe(true);
		// A cloud provider reports nothing: no server is read and the column says so.
		const cloud = new ModelPage(deps, large, { advanced: () => false, requestRender: vi.fn(), done: vi.fn() });
		await flush();
		expect(cloud.render(90).map(plain).join("\n")).toContain("This provider does not report its settings");
	});

	it("edits a value in place, removes it with an empty value, and refuses a wrong one", async () => {
		const { view, lines, done } = page(false, true);
		await flush();
		expect(lines().some((l) => l.startsWith("→ Max output"))).toBe(true);
		view.handleInput(ENTER);
		for (const key of "abc") view.handleInput(key);
		view.handleInput(ENTER);
		expect(lines().join("\n")).toContain("Type a number.");
		view.handleInput(ESC);
		view.handleInput(ENTER);
		for (const key of "30000") view.handleInput(key);
		view.handleInput(ENTER);
		await flush();
		expect(readModelCorrection(deps.modelsPath, "local", "coder-30b")).toEqual({ maxTokens: 30000 });
		expect(deps.reload).toHaveBeenCalledWith(coder);
		expect(lines().some((l) => /^→ Max output +not reported +32000 ✎/.test(l))).toBe(true);
		view.handleInput(ENTER);
		view.handleInput(ENTER);
		await flush();
		expect(readModelCorrection(deps.modelsPath, "local", "coder-30b")).toEqual({});
		view.handleInput(ESC);
		expect(done).toHaveBeenCalledWith("current");
	});

	it("removes every change of the model after a second Enter", async () => {
		writeFileSync(
			deps.modelsPath,
			JSON.stringify({ providers: { local: { modelOverrides: { "coder-30b": { name: "Mine", maxTokens: 9 } } } } }),
		);
		await writeToolCalls(deps.capabilitiesFile, "local", "coder-30b", false);
		const { view, lines, done } = page(false);
		await flush();
		// Name, Context, Max output, Images, Thinking, Thinking budget, Tool calls, then the removal.
		for (let i = 0; i < 7; i++) view.handleInput(DOWN);
		expect(lines().some((l) => l.startsWith("→ Remove my changes for this model"))).toBe(true);
		view.handleInput(ENTER);
		expect(lines().some((l) => l.includes("Enter again removes your changes, Esc keeps them"))).toBe(true);
		view.handleInput(ENTER);
		await flush();
		expect(readModelCorrection(deps.modelsPath, "local", "coder-30b")).toEqual({});
		expect(JSON.parse(readFileSync(deps.capabilitiesFile, "utf8"))["local/coder-30b"].toolCalls).toBeUndefined();
		expect(lines().some((l) => l.includes("Remove my changes"))).toBe(false);
		view.handleInput(ESC);
		expect(done).toHaveBeenCalledWith("current");
	});

	it("finds one setting of every model in the search, sampling only in the advanced interface", () => {
		const build = (advanced: boolean) =>
			groupSettingsByDomain([], vi.fn(), {
				builtinExtensions: [],
				onBuiltinExtensionChange: vi.fn(),
				interfaceMode: advanced ? "advanced" : "simple",
				sections: () => [modelPagesSection(deps)],
			});
		const search = (advanced: boolean, query: string) => {
			const view = new SettingsView(build(advanced), { onClose: vi.fn(), rows: () => 40 });
			for (const key of `/${query}`) view.handleInput(key);
			return view.render(110).map(plain);
		};
		const found = search(false, "max output");
		expect(found.filter((l) => /Max output · (local\/coder-30b|cloud\/large-model) +32000/.test(l))).toHaveLength(2);
		expect(search(false, "temperature").some((l) => l.includes("Temperature ·"))).toBe(false);
		expect(search(true, "temperature").filter((l) => /Temperature · \S+ +not sent/.test(l))).toHaveLength(2);
	});

	it("opens the page on the setting found, and back on the domain", async () => {
		const model = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [],
			onBuiltinExtensionChange: vi.fn(),
			sections: () => [modelPagesSection(deps)],
		});
		const view = new SettingsView(model, { onClose: vi.fn(), rows: () => 40 });
		for (const key of "/max output large") view.handleInput(key);
		view.handleInput(DOWN);
		view.handleInput(ENTER);
		await flush();
		const lines = view.render(110).map(plain);
		expect(lines.some((l) => l.includes("cloud/large-model") && !l.includes("·"))).toBe(true);
		expect(lines.some((l) => /→ Max output/.test(l))).toBe(true);
		view.handleInput(ESC);
		expect(view.render(110).map(plain).join("\n")).toContain("Max output · cloud/large-model");
	});

	it("makes /model-settings open the current model's page", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prism-model-pages-agent-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
		modelSettings({
			on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
			registerCommand: (_name: string, options: typeof command) => {
				command = options;
			},
		} as unknown as ExtensionAPI);
		const ctx = {
			hasUI: true,
			model: coder,
			modelRegistry: { getAvailable: () => [coder] },
			ui: { notify: vi.fn(), select: vi.fn() },
		};
		handlers.get("session_start")!({}, ctx);
		const host = vi.fn();
		setSettingsHost(host);
		await command!.handler("", ctx as unknown as ExtensionCommandContext);
		expect(host).toHaveBeenCalledWith({ domain: "models", item: "model:local/coder-30b", open: true });
		expect(ctx.ui.select).not.toHaveBeenCalled();
		const section = settingsSections().find((s) => s.domain === "models");
		expect(section).toBeDefined();
		handlers.get("session_shutdown")!({}, ctx);
		expect(settingsSections()).not.toContain(section);
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});
});

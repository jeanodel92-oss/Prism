// fork: after a login, a checklist of the provider's models with the recent ones checked, from the
// release date and status the generated catalog keeps from models.dev.
import type { Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScopedModel } from "../src/core/model-resolver.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { keyboardListMouse } from "../src/fork/keyboard-list-mouse.ts";
import { LoginModelsChecklist, offerLoginModels, recentModelIds, scopeAfterLogin } from "../src/fork/login-models.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

function model(provider: string, id: string, releaseDate?: string, deprecated?: boolean): Model<any> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...(releaseDate ? { releaseDate } : {}),
		...(deprecated ? { deprecated } : {}),
	};
}

const openai = [
	model("openai", "gpt-4", "2023-11-06", true),
	model("openai", "o1", "2024-12-05", true),
	model("openai", "gpt-4.1", "2025-04-14"),
	model("openai", "gpt-5.4", "2026-03-05"),
	model("openai", "gpt-5.5", "2026-04-23"),
	model("openai", "gpt-6.1-sol", "2026-09-29"),
	model("openai", "gpt-next"),
];
const anthropic = [model("anthropic", "claude-a", "2026-09-01"), model("anthropic", "claude-b", "2025-01-01")];

const plain = (component: Component, width = 80) => component.render(width).map((line) => stripAnsi(line).trimEnd());

describe("fork: models offered after a login", () => {
	beforeAll(() => initTheme("prism"));
	afterEach(() => setLanguage("en"));

	it("keeps models.dev's release date and deprecated status in the generated catalog", () => {
		const models = getModels("openai");
		const gpt4 = models.find((candidate) => candidate.id === "gpt-4");
		expect(gpt4?.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(gpt4?.deprecated).toBe(true);
		const dated = models.filter((candidate) => candidate.releaseDate).length;
		expect(dated / models.length).toBeGreaterThan(0.9);
		// The subscription login serves OpenAI's models under another provider: dated through the alias.
		expect(getModels("openai-codex").every((candidate) => candidate.releaseDate)).toBe(true);
		const checked = recentModelIds(models);
		expect(checked).not.toContain("gpt-4");
		expect(checked).not.toContain("o1");
		expect(checked.length).toBeGreaterThan(0);
		expect(checked.length).toBeLessThan(models.length / 2);
	});

	it("checks the recent models that are not deprecated, undated ones, and the ones to keep", () => {
		expect(recentModelIds(openai)).toEqual(["gpt-next", "gpt-6.1-sol", "gpt-5.5"]);
		expect(recentModelIds(openai, ["gpt-4.1"])).toEqual(["gpt-next", "gpt-6.1-sol", "gpt-5.5", "gpt-4.1"]);
		expect(recentModelIds([model("x", "gone", "2026-09-02", true), model("x", "b", "2026-09-01")])).toEqual(["b"]);
		// Without any date, nothing says a model is old.
		expect(recentModelIds([model("x", "a"), model("x", "b")])).toEqual(["a", "b"]);
	});

	it("replaces the provider's entries in enabledModels, and keeps every other provider whole", () => {
		const available = [...openai, ...anthropic];
		expect(scopeAfterLogin(undefined, "openai", ["gpt-5.5"], available)).toEqual(["anthropic/**", "openai/gpt-5.5"]);
		expect(
			scopeAfterLogin(["openai/gpt-4", "anthropic/claude-a", "*sonnet*"], "openai", ["gpt-5.5"], available),
		).toEqual(["anthropic/claude-a", "*sonnet*", "openai/gpt-5.5"]);
	});

	it("lists the models newest first under a Save row, and saves what is checked", () => {
		const onSave = vi.fn();
		const onCancel = vi.fn();
		const list = new LoginModelsChecklist({
			providerName: "OpenAI",
			models: openai,
			checked: recentModelIds(openai),
			onSave,
			onCancel,
		});
		const lines = plain(list);
		expect(lines).toContain(" → Save (3 of 7 models)");
		expect(lines).toContain("   [x] gpt-6.1-sol  2026-09-29");
		expect(lines).toContain("   [ ] gpt-4  2023-11-06 · deprecated");
		const rows = lines.filter((line) => /^ {1}(→| ) /.test(line) && /\[[x ]\]/.test(line));
		expect(rows.map((line) => line.replace(/^.{3}\[[x ]\] (\S+).*/, "$1"))).toEqual([
			"gpt-next",
			"gpt-6.1-sol",
			"gpt-5.5",
			"gpt-5.4",
			"gpt-4.1",
			"o1",
			"gpt-4",
		]);
		list.handleInput(DOWN);
		list.handleInput(ENTER); // uncheck gpt-next
		list.handleInput(DOWN);
		list.handleInput(DOWN);
		list.handleInput(DOWN);
		list.handleInput(ENTER); // check gpt-5.4
		expect(plain(list)).toContain(" → [x] gpt-5.4  2026-03-05");
		for (let i = 0; i < 4; i++) list.handleInput(DOWN); // wraps around to Save
		list.handleInput(ENTER);
		expect(onSave).toHaveBeenCalledWith(["gpt-6.1-sol", "gpt-5.5", "gpt-5.4"]);
		list.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("fits narrow widths and speaks French", () => {
		setLanguage("fr");
		const list = new LoginModelsChecklist({
			providerName: "OpenAI",
			models: openai,
			checked: recentModelIds(openai),
			onSave: () => {},
			onCancel: () => {},
		});
		for (const width of [80, 60, 40]) {
			for (const line of list.render(width)) expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
		}
		const lines = plain(list, 60);
		expect(lines).toContain(" → Enregistrer (3 modèles sur 7)");
		expect(lines.join("\n")).toContain("Modèles proposés par OpenAI");
		expect(lines.join("\n")).toContain("obsolète");
	});

	it("scrolls a long list and takes clicks through the menu mouse", () => {
		const many = Array.from({ length: 30 }, (_, i) =>
			model("openai", `m${String(i).padStart(2, "0")}`, `2026-0${1 + (i % 9)}-01`),
		);
		const list = new LoginModelsChecklist({
			providerName: "OpenAI",
			models: many,
			checked: [],
			onSave: () => {},
			onCancel: () => {},
		});
		const lines = plain(list);
		expect(lines).toContain("   (1/31)");
		const row = lines.findIndex((line) => line.includes("[ ]"));
		keyboardListMouse(list, { type: "click", button: "left", x: 6, y: row, width: 80 } as never);
		expect(plain(list)[row]).toMatch(/^ → \[x\]/);
	});

	it("is offered only when some model would be left out, and applies the choice to the session", () => {
		const host = {
			providerId: "openai",
			providerName: "OpenAI",
			available: [...openai, ...anthropic],
			patterns: undefined,
			keep: [],
			shown: undefined as Component | undefined,
			show(create: (done: () => void) => Component) {
				this.shown = create(() => {
					this.shown = undefined;
				});
			},
			savePatterns: vi.fn(),
			setScopedModels: vi.fn<(models: ScopedModel[]) => void>(),
			requestRender: () => {},
		};
		expect(offerLoginModels({ ...host, available: [model("openai", "a"), model("openai", "b")] })).toBe(false);

		expect(offerLoginModels(host)).toBe(true);
		host.shown!.handleInput!(ENTER);
		expect(host.shown).toBeUndefined();
		expect(host.savePatterns).toHaveBeenCalledWith([
			"anthropic/**",
			"openai/gpt-next",
			"openai/gpt-6.1-sol",
			"openai/gpt-5.5",
		]);
		const scoped = host.setScopedModels.mock.calls[0]![0].map((entry) => `${entry.model.provider}/${entry.model.id}`);
		expect(scoped.sort()).toEqual(
			["anthropic/claude-a", "anthropic/claude-b", "openai/gpt-5.5", "openai/gpt-6.1-sol", "openai/gpt-next"].sort(),
		);

		host.savePatterns.mockClear();
		expect(offerLoginModels(host)).toBe(true);
		host.shown!.handleInput!(ESC);
		expect(host.savePatterns).not.toHaveBeenCalled();
	});

	// a DeepSeek key added after an OpenAI login, whose checklist had narrowed enabledModels, left the
	// DeepSeek models out of /model until they were found in /scoped-models.
	it("adds a new provider to a narrowed enabledModels, whether or not the checklist opens", () => {
		const deepseek = [model("deepseek", "deepseek-chat", "2026-09-01"), model("deepseek", "deepseek-reasoner")];
		const patterns = ["anthropic/*", "openai/gpt-5.5"];
		const host = {
			providerId: "deepseek",
			providerName: "DeepSeek",
			available: [...openai, ...anthropic, ...deepseek],
			patterns,
			keep: [],
			shown: undefined as Component | undefined,
			show(create: (done: () => void) => Component) {
				this.shown = create(() => {
					this.shown = undefined;
				});
			},
			savePatterns: vi.fn(),
			setScopedModels: vi.fn<(models: ScopedModel[]) => void>(),
			requestRender: () => {},
		};
		const scoped = () =>
			host.setScopedModels.mock.calls.at(-1)![0].map((entry) => `${entry.model.provider}/${entry.model.id}`);

		// Every model is recent: no checklist, the provider joins the list whole.
		expect(offerLoginModels(host)).toBe(false);
		expect(host.savePatterns).toHaveBeenLastCalledWith([...patterns, "deepseek/**"]);
		expect(scoped()).toEqual(expect.arrayContaining(["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]));

		// Escape on the checklist keeps every model of the provider, as with no list.
		host.savePatterns.mockClear();
		const withOld = { ...host, available: [...host.available, model("deepseek", "deepseek-v2", "2024-05-01", true)] };
		expect(offerLoginModels(withOld)).toBe(true);
		withOld.shown!.handleInput!(ESC);
		expect(host.savePatterns).toHaveBeenLastCalledWith([...patterns, "deepseek/**"]);

		// A provider the list already names, or no list at all, is left alone.
		host.savePatterns.mockClear();
		expect(offerLoginModels({ ...host, patterns: [...patterns, "deepseek/deepseek-chat"] })).toBe(false);
		expect(offerLoginModels({ ...host, patterns: undefined })).toBe(false);
		expect(host.savePatterns).not.toHaveBeenCalled();
	});

	// maintainer's QA, 2026-11-22: a server added with a new local model left it out of /scoped-models.
	it("puts a server's new models in a narrowed enabledModels", () => {
		const host = {
			providerId: "localai",
			providerName: "localai",
			patterns: ["anthropic/claude-a"],
			keep: [],
			show: vi.fn(),
			savePatterns: vi.fn(),
			setScopedModels: vi.fn<(models: ScopedModel[]) => void>(),
			requestRender: () => {},
		};
		const scoped = () =>
			host.setScopedModels.mock.calls.at(-1)![0].map((entry) => `${entry.model.provider}/${entry.model.id}`);

		// A model ID with a "/", as llama.cpp and Hugging Face name them: `localai/*` matched none.
		const slashed = [...anthropic, model("localai", "unsloth/Qwen3-27B-GGUF")];
		expect(offerLoginModels({ ...host, available: slashed })).toBe(false);
		expect(host.savePatterns).toHaveBeenLastCalledWith(["anthropic/claude-a", "localai/**"]);
		expect(scoped()).toEqual(["anthropic/claude-a", "localai/unsloth/Qwen3-27B-GGUF"]);

		// The same server added again, now serving a new model: the list named only the old one.
		const served = [...anthropic, model("localai", "qwen3.8-27b"), model("localai", "org/hy4-flash")];
		const again = { ...host, patterns: ["anthropic/claude-a", "localai/qwen3.8-27b"], available: served };
		expect(offerLoginModels({ ...again, added: ["org/hy4-flash"] })).toBe(false);
		expect(host.savePatterns).toHaveBeenLastCalledWith([...again.patterns, "localai/org/hy4-flash"]);
		expect(scoped()).toEqual(["anthropic/claude-a", "localai/qwen3.8-27b", "localai/org/hy4-flash"]);

		// A model the user took out of the list stays out when it is not new.
		host.savePatterns.mockClear();
		expect(offerLoginModels({ ...again, added: [] })).toBe(false);
		expect(
			offerLoginModels({
				...again,
				patterns: [...again.patterns, "localai/org/hy4-flash"],
				added: ["org/hy4-flash"],
			}),
		).toBe(false);
		expect(host.savePatterns).not.toHaveBeenCalled();
	});
});

// the pages the Prism window draws for /settings submenus the terminal draws with its own
// component: a model's page, the move of credentials to the keyring and the module cost tool. Each page runs the
// terminal page's reads and writes; the native view (settings-native.ts) only draws its rows.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingItem } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readModelCorrection, type ServerValues } from "../src/fork/model-settings.ts";
import { type ModuleCostReport, measureModuleCosts } from "../src/fork/module-cost.ts";
import { ModuleCostView, moduleCostPage } from "../src/fork/module-cost-view.ts";
import { migrationSettingsPage } from "../src/fork/secrets/migration-page.ts";
import { type ModelPageDeps, modelPagesSection } from "../src/fork/settings-model-page.ts";
import { pageOf, type SettingsPage } from "../src/fork/settings-pages.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// The measurement starts child processes: here it answers at once.
vi.mock("../src/fork/module-cost.ts", () => ({ measureModuleCosts: vi.fn() }));

type Rows = Extract<SettingsPage, { kind: "rows" }>;

const report: ModuleCostReport = {
	baselinePromptTokens: 1200,
	baselineStartupMs: 310,
	baselineMemoryMiB: 95.5,
	baselineProcesses: 1,
	rows: [
		{
			name: "goal",
			prompt: {
				changed: true,
				addedTokens: 40,
				removedTokens: 0,
				changedSections: [],
				addedSections: ["goal"],
				removedSections: [],
				addedTools: [],
				removedTools: [],
			},
			startup: "+12 ms",
			memory: "+3 MiB",
			processes: "0",
		},
	],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Opens `item`'s window page, as the native view does. */
function open<T extends SettingsPage>(item: SettingItem | undefined, done = vi.fn()): T {
	const factory = item && pageOf(item);
	if (!factory) throw new Error(`No window page for ${item?.id}`);
	return factory(item.currentValue, done) as T;
}

const row = (page: Rows, id: string) => page.items.find((item) => item.id === id);

describe("fork.10: window pages of /settings", () => {
	beforeAll(() => initTheme("dark"));

	describe("a model's page", () => {
		let dir: string;
		let deps: ModelPageDeps;
		const model: Model<Api> = {
			id: "coder-30b",
			name: "coder-30b",
			api: "openai-completions",
			provider: "local",
			baseUrl: "http://localhost:8080/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 32000,
		};
		const server: ServerValues = {
			kind: "llama.cpp",
			model: { id: "coder-30b", contextWindow: 131072, vision: "no", tools: "yes", reasoning: "yes" },
		};

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "prism-window-model-page-"));
			const modelsPath = join(dir, "models.json");
			writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
			deps = {
				modelsPath,
				capabilitiesFile: join(dir, "capabilities.json"),
				models: () => [model],
				current: () => model,
				readServer: vi.fn(async () => server),
				reload: vi.fn(async (reloaded: Model<Api>) => reloaded),
			};
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		it("shows the server's values, saves Prism's and removes the changes after asking", async () => {
			const requestRender = vi.fn();
			const [item] = modelPagesSection(deps).items({ advanced: () => false, requestRender });
			const done = vi.fn();
			const page = open<Rows>(item, done);
			expect(page.description).toContain("Reading the server's values…");
			await flush();
			expect(page.description).toContain("llama.cpp");
			expect(requestRender).toHaveBeenCalled();
			expect(row(page, "contextWindow")?.description).toContain("131072");
			// The simple interface leaves sampling out, as the terminal's page.
			expect(row(page, "temperature")).toBeUndefined();

			const field = open<Extract<SettingsPage, { kind: "input" }>>(row(page, "maxTokens"));
			expect(field.input.parse("many")).toBeInstanceOf(Error);
			field.input.save("16000");
			expect(readModelCorrection(deps.modelsPath, "local", "coder-30b")).toEqual({ maxTokens: 16000 });
			await flush();
			expect(deps.reload).toHaveBeenCalledTimes(1);
			expect(row(page, "maxTokens")?.currentValue).toContain("✎");

			const remove = open<Extract<SettingsPage, { kind: "select" }>>(row(page, "remove"));
			remove.onSelect("remove");
			expect(readModelCorrection(deps.modelsPath, "local", "coder-30b")).toEqual({});
			await flush();
			expect(row(page, "remove")).toBeUndefined();
			page.onClose();
			expect(done).toHaveBeenCalledWith("current");
		});
	});

	describe("moving credentials to the keyring", () => {
		afterEach(() => vi.unstubAllEnvs());

		it("lists them, moves them once confirmed, then says what moved", async () => {
			vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent");
			vi.stubEnv("PRISM_SECRET_SERVICE", "");
			let entries = [{ provider: "openai", type: "api_key" }];
			const migrate = vi.fn(async () => {
				entries = [];
				return { moved: ["openai"], kept: new Map<string, string>() };
			});
			const requestRender = vi.fn();
			const done = vi.fn();
			const page = migrationSettingsPage({ entries: () => entries, migrate, requestRender })("", done) as Rows;
			expect(page.items.map((item) => item.label)).toEqual(["openai", "Move credentials to the keyring"]);

			const confirm = open<Extract<SettingsPage, { kind: "select" }>>(row(page, "move"));
			confirm.onSelect("keep");
			expect(migrate).not.toHaveBeenCalled();
			open<Extract<SettingsPage, { kind: "select" }>>(row(page, "move")).onSelect("move");
			expect(page.description).toContain("Moving to the keyring…");
			await flush();
			expect(page.description).toContain("Moved to the keyring: openai");
			expect(page.items).toEqual([]);
			expect(requestRender).toHaveBeenCalled();
			page.onClose();
			expect(done).toHaveBeenCalledWith("changed");
		});

		it("moves nothing without a keyring", () => {
			vi.stubEnv("PRISM_SECRET_SERVICE", "off");
			const migrate = vi.fn();
			const page = migrationSettingsPage({
				entries: () => [{ provider: "openai", type: "api_key" }],
				migrate,
				requestRender: vi.fn(),
			})("", vi.fn()) as Rows;
			expect(page.description).toContain("No keyring in this session: nothing can be moved.");
			expect(row(page, "move")).toBeUndefined();
		});
	});

	it("measures a module and shows the report the terminal shows", async () => {
		vi.mocked(measureModuleCosts).mockImplementation(async (options) => {
			options.onProgress?.(1, 1, "goal");
			return report;
		});
		const redraw = vi.fn();
		const page = moduleCostPage([{ name: "goal", enabled: true }], [], redraw)("", vi.fn()) as Rows;
		const close = vi.fn();
		const measurement = open<Extract<SettingsPage, { kind: "text" }>>(row(page, "goal"), close);
		expect(measurement.lines).toEqual(["Measuring 1/1: goal…"]);
		await flush();
		expect(measurement.title).toBe("Module cost results");
		expect(redraw).toHaveBeenCalledTimes(2);

		const view = new ModuleCostView([{ name: "goal", enabled: true }], [], vi.fn(), vi.fn());
		view.handleInput("\r");
		await flush();
		const terminal = view
			.render(400)
			.map((line) => line.trimEnd())
			.slice(1, measurement.lines.length + 1);
		expect(measurement.lines).toContain("  Prompt per turn: +40/-0 tokens, estimate");
		expect(terminal).toEqual(measurement.lines);
		measurement.done();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("offers to measure every module or one of them", () => {
		const page = moduleCostPage(
			[
				{ name: "goal", enabled: true },
				{ name: "lsp", enabled: false },
			],
			[],
			vi.fn(),
		)("", vi.fn()) as Rows;
		expect(page.items.map((item) => [item.label, item.description])).toEqual([
			["All modules", "Measure every built-in module"],
			["goal", "Currently on"],
			["lsp", "Currently off"],
		]);
		expect(page.items.every((item) => pageOf(item))).toBe(true);
	});
});

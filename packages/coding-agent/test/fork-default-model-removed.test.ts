// fork: the maintainer removed his default model (localai/qwen3.8-27b-fp8) from its page
// in /settings; settings.json kept naming it, and every start opened new conversations on another model without a
// word. (1) Removing the default model, or its server, says so and offers another default; (2) a start whose saved
// default is gone or has no key says which model it uses instead, in the terminal and in the window (RPC notice).
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { defaultModelFallbackMessage } from "../src/fork/default-model-fallback.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { serverModelIds } from "../src/fork/remove-server-model.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { type ModelPageDeps, modelPagesSection } from "../src/fork/settings-model-page.ts";
import { pageOf, type SettingsPage } from "../src/fork/settings-pages.ts";
import type { SectionContext } from "../src/fork/settings-sections.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const roots: string[] = [];
afterEach(() => {
	setLanguage("en");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
beforeAll(() => initTheme("dark"));

function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "prism-default-model-")));
	roots.push(dir);
	return dir;
}

const model = (provider: string, id: string) =>
	({ provider, id, name: id, contextWindow: 32000, maxTokens: 4096, input: ["text"], reasoning: false }) as Model<Api>;

const ESC = "\x1b";
const UP = "\x1b[A";
const ENTER = "\r";

describe("fork: removing the default model offers another one", () => {
	/** A models.json with two servers, the session's models, and a saved default the page reads and changes. */
	function setup(saved: { provider: string; id: string } | undefined) {
		const path = join(tempDir(), "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					localai: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "none",
						models: [{ id: "qwen3.8-27b-fp8" }, { id: "hy4-flash" }],
					},
				},
			}),
		);
		let available = [model("localai", "qwen3.8-27b-fp8"), model("localai", "hy4-flash"), model("openai", "gpt-6")];
		let current = saved;
		const set = vi.fn((chosen: Model<Api>) => {
			current = { provider: chosen.provider, id: chosen.id };
		});
		const remove = vi.fn(async (removed: Model<Api>, server: boolean) => {
			available = available.filter((m) =>
				server ? m.provider !== removed.provider : `${m.provider}/${m.id}` !== `${removed.provider}/${removed.id}`,
			);
			return server
				? `Removed the server ${removed.provider} and its models.`
				: `Removed ${removed.provider}/${removed.id}.`;
		});
		const deps: ModelPageDeps = {
			modelsPath: path,
			capabilitiesFile: join(path, "..", "capabilities.json"),
			models: () => available,
			current: () => undefined,
			readServer: async () => undefined,
			reload: async (m) => m,
			serverModels: (m) => serverModelIds(path, m.provider),
			remove,
		};
		const context: SectionContext = {
			advanced: () => false,
			requestRender: () => {},
			defaultModel: { get: () => current, set },
		};
		const section = modelPagesSection(deps);
		const item = (key: string) => {
			const found = section.items(context).find((row) => row.label === key);
			if (!found) throw new Error(`no row ${key}`);
			return found;
		};
		return { deps, context, section, item, set, remove, saved: () => current };
	}

	/** The window's page of a model (rows), opened as settings-native.ts does. */
	function windowPage(page: SettingsPage | undefined) {
		if (page?.kind !== "rows") throw new Error(`expected rows, got ${page?.kind}`);
		return page;
	}

	/** Opens a row's page and answers its select with `value`. */
	async function choose(page: SettingsPage, value: string) {
		if (page.kind !== "select") throw new Error(`expected select, got ${page.kind}`);
		await page.onSelect(value);
	}

	it("in the window: says the default was removed and offers the models left", async () => {
		const s = setup({ provider: "localai", id: "qwen3.8-27b-fp8" });
		let closedWith: string | undefined;
		const page = windowPage(
			pageOf(s.item("localai/qwen3.8-27b-fp8"))!("", (value) => {
				closedWith = value;
			}),
		);
		const removal = page.items.find((row) => row.id === "remove-model")!;
		await choose(
			pageOf(removal)!("", () => {}),
			"remove",
		);
		expect(s.remove).toHaveBeenCalledWith(expect.objectContaining({ id: "qwen3.8-27b-fp8" }), false);
		expect(page.description).toBe("Removed localai/qwen3.8-27b-fp8. It was the default model for new conversations.");
		expect(page.items.map((row) => [row.id, row.label])).toEqual([
			["choose-default-model", "Choose another default model"],
		]);

		const chooser = pageOf(page.items[0]!)!("", () => {});
		if (chooser.kind !== "select") throw new Error("expected select");
		expect(chooser.options.map((option) => option.value)).toEqual(["localai/hy4-flash", "openai/gpt-6"]);
		await chooser.onSelect("localai/hy4-flash");
		expect(s.set).toHaveBeenCalledWith(expect.objectContaining({ provider: "localai", id: "hy4-flash" }));
		expect(s.saved()).toEqual({ provider: "localai", id: "hy4-flash" });
		expect(page.description).toBe(
			"Removed localai/qwen3.8-27b-fp8. It was the default model for new conversations. Default model: localai/hy4-flash.",
		);
		expect(page.items).toEqual([]);
		page.onClose();
		expect(closedWith).toBe(page.description);
	});

	it("in the window: Esc leaves the default; another model's removal offers nothing", async () => {
		const s = setup({ provider: "localai", id: "qwen3.8-27b-fp8" });
		const page = windowPage(pageOf(s.item("localai/qwen3.8-27b-fp8"))!("", () => {}));
		await choose(
			pageOf(page.items.find((row) => row.id === "remove-model")!)!("", () => {}),
			"remove",
		);
		const chooser = pageOf(page.items[0]!)!("", () => {});
		if (chooser.kind !== "select") throw new Error("expected select");
		chooser.onCancel();
		expect(s.set).not.toHaveBeenCalled();
		expect(s.saved()).toEqual({ provider: "localai", id: "qwen3.8-27b-fp8" });
		// The offer stays on the page until it is closed.
		expect(page.items.map((row) => row.id)).toEqual(["choose-default-model"]);

		const other = setup({ provider: "openai", id: "gpt-6" });
		const otherPage = windowPage(pageOf(other.item("localai/qwen3.8-27b-fp8"))!("", () => {}));
		await choose(
			pageOf(otherPage.items.find((row) => row.id === "remove-model")!)!("", () => {}),
			"remove",
		);
		expect(otherPage.description).toBe("Removed localai/qwen3.8-27b-fp8.");
		expect(otherPage.items).toEqual([]);
	});

	it("in the window: removing the server that holds the default offers the other providers' models", async () => {
		const s = setup({ provider: "localai", id: "hy4-flash" });
		const page = windowPage(pageOf(s.item("localai/qwen3.8-27b-fp8"))!("", () => {}));
		await choose(
			pageOf(page.items.find((row) => row.id === "remove-server")!)!("", () => {}),
			"remove",
		);
		expect(page.description).toBe(
			"Removed the server localai and its models. It was the default model for new conversations.",
		);
		const chooser = pageOf(page.items[0]!)!("", () => {});
		if (chooser.kind !== "select") throw new Error("expected select");
		expect(chooser.options.map((option) => option.value)).toEqual(["openai/gpt-6"]);
	});

	it("in the terminal: the page turns into the choice, Enter saves it, Esc leaves it", async () => {
		const s = setup({ provider: "localai", id: "qwen3.8-27b-fp8" });
		let closedWith: string | undefined;
		const open = () =>
			s.item("localai/qwen3.8-27b-fp8").submenu!("", (value) => {
				closedWith = value;
			});
		const page = open();
		// The actions are last: Up from the first row reaches "Remove the server…", once more "Remove this model…".
		page.handleInput!(UP);
		page.handleInput!(UP);
		expect(stripAnsi(page.render(64).join("\n"))).toContain("→ Remove this model from Prism");
		page.handleInput!(ENTER);
		page.handleInput!(ENTER);
		await vi.waitFor(() => expect(page.render(64).join("\n")).toContain("Choose another default model"));
		const screen = stripAnsi(page.render(64).join(" ")).replace(/\s+/g, " ");
		expect(screen).toContain(
			"Removed localai/qwen3.8-27b-fp8. It was the default model for new conversations. Enter makes the chosen model the default; Esc leaves the default as it is.",
		);
		expect(screen).toContain("→ hy4-flash [localai] gpt-6 [openai]");
		expect(screen).not.toContain("qwen3.8-27b-fp8 [");
		for (const line of page.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		page.handleInput!(ENTER);
		expect(s.set).toHaveBeenCalledWith(expect.objectContaining({ provider: "localai", id: "hy4-flash" }));
		expect(closedWith).toBe("Removed localai/qwen3.8-27b-fp8. Default model: localai/hy4-flash.");

		const declined = setup({ provider: "localai", id: "qwen3.8-27b-fp8" });
		let declinedWith: string | undefined;
		const again = declined.item("localai/qwen3.8-27b-fp8").submenu!("", (value) => {
			declinedWith = value;
		});
		again.handleInput!(UP);
		again.handleInput!(UP);
		again.handleInput!(ENTER);
		again.handleInput!(ENTER);
		await vi.waitFor(() => expect(again.render(64).join("\n")).toContain("Choose another default model"));
		again.handleInput!(ESC);
		expect(declined.set).not.toHaveBeenCalled();
		expect(declinedWith).toBe("Removed localai/qwen3.8-27b-fp8.");
	});

	it("in the terminal: with no model left, it says so and closes", async () => {
		const s = setup({ provider: "localai", id: "qwen3.8-27b-fp8" });
		let closedWith: string | undefined;
		const page = s.item("localai/qwen3.8-27b-fp8").submenu!("", (value) => {
			closedWith = value;
		});
		s.deps.models = () => [];
		page.handleInput!(UP);
		page.handleInput!(UP);
		page.handleInput!(ENTER);
		page.handleInput!(ENTER);
		await vi.waitFor(() => expect(closedWith).toBeDefined());
		expect(closedWith).toBe(
			"Removed localai/qwen3.8-27b-fp8. It was the default model for new conversations; no other model is available to replace it.",
		);
	});
});

describe("fork: the Models domain gives the pages the saved default", () => {
	it("reads it live and, once changed, shows it on the domain's Default model row", () => {
		let saved: { provider: string; id: string } | undefined = { provider: "localai", id: "qwen3.8-27b-fp8" };
		const onDefaultModel = vi.fn((chosen: Model<Api>) => {
			saved = { provider: chosen.provider, id: chosen.id };
		});
		let seen: SectionContext | undefined;
		const grouped = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [],
			onBuiltinExtensionChange: vi.fn(),
			models: {
				models: [model("localai", "hy4-flash")],
				defaultModel: "localai/qwen3.8-27b-fp8",
				savedDefault: () => saved,
				onDefaultModel,
				thinkingLevel: "medium",
				thinkingLevels: ["off", "medium"],
				onThinkingLevel: vi.fn(),
			},
			sections: () => [
				{
					domain: "models",
					items: (context) => {
						seen = context;
						return [];
					},
				},
			],
		});
		const row = () =>
			grouped
				.domains()
				.find((domain) => domain.id === "models")!
				.items()
				.find((item) => item.id === "default-model")!;
		expect(row().currentValue).toBe("localai/qwen3.8-27b-fp8");
		expect(seen?.defaultModel?.get()).toEqual({ provider: "localai", id: "qwen3.8-27b-fp8" });
		seen!.defaultModel!.set(model("localai", "hy4-flash"));
		expect(onDefaultModel).toHaveBeenCalledWith(expect.objectContaining({ id: "hy4-flash" }));
		expect(seen?.defaultModel?.get()).toEqual({ provider: "localai", id: "hy4-flash" });
		expect(row().currentValue).toBe("localai/hy4-flash");
	});
});

describe("fork: a start whose saved default cannot be used says so", () => {
	const available = [model("openai", "gpt-6-astra"), model("local", "kept")];
	const runtime = (keys: string[]) =>
		({
			getModel: (provider: string, id: string) =>
				[...available, model("nokey", "m")].find((m) => m.provider === provider && m.id === id),
			hasConfiguredAuth: (provider: string) => keys.includes(provider),
			getAvailableSnapshot: () => available,
		}) as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

	it("names the missing default and the model used, in English and French", () => {
		const used = available[0];
		expect(defaultModelFallbackMessage(runtime([]), "localai", "qwen3.8-27b-fp8", used)).toBe(
			"Default model localai/qwen3.8-27b-fp8 not found; using openai/gpt-6-astra. Choose another in /settings › Models.",
		);
		setLanguage("fr");
		expect(defaultModelFallbackMessage(runtime([]), "localai", "qwen3.8-27b-fp8", used)).toBe(
			"Modèle par défaut localai/qwen3.8-27b-fp8 introuvable ; j'utilise openai/gpt-6-astra. Choisissez-en un autre dans /settings › Modèles.",
		);
	});

	it("names a default without a key; says nothing when the default opens, none is saved or it was set aside", () => {
		expect(defaultModelFallbackMessage(runtime([]), "nokey", "m", available[0])).toBe(
			"No key for the default model nokey/m; using openai/gpt-6-astra. Sign in with /login, or choose another default in /settings › Models.",
		);
		expect(defaultModelFallbackMessage(runtime([]), "openai", "gpt-6-astra", available[0])).toBeUndefined();
		expect(defaultModelFallbackMessage(runtime([]), undefined, undefined, available[0])).toBeUndefined();
		expect(defaultModelFallbackMessage(runtime(["local"]), "local", "kept", available[0])).toBeUndefined();
		expect(defaultModelFallbackMessage(runtime([]), "localai", "gone", undefined)).toBeUndefined();
	});

	it("findInitialModel keeps its choice and reports the fallback", async () => {
		const missing = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "localai",
			defaultModelId: "qwen3.8-27b-fp8",
			modelRuntime: runtime(["openai", "local"]),
		});
		expect(missing.model).toBe(available[0]);
		expect(missing.fallbackMessage).toBe(
			"Default model localai/qwen3.8-27b-fp8 not found; using openai/gpt-6-astra. Choose another in /settings › Models.",
		);
		const found = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "local",
			defaultModelId: "kept",
			modelRuntime: runtime(["openai", "local"]),
		});
		expect(found.model).toBe(available[1]);
		expect(found.fallbackMessage).toBeUndefined();
	});
});

// The engine as the window runs it: the notice reaches the client as an `extension_ui_request` notify, from both
// startup paths (main.ts with enabledModels, findInitialModel without).
describe("fork: the start notice in the window's engine", () => {
	const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const resolverUrl = pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href;
	const cli = join(packageDir, "src/cli.ts");
	const children: ChildProcessWithoutNullStreams[] = [];
	afterEach(() => {
		for (const child of children.splice(0)) child.kill("SIGKILL");
	});

	function engine(settings: Record<string, unknown>) {
		const root = tempDir();
		const dirs = { cwd: join(root, "work"), agentDir: join(root, "agent"), home: join(root, "home") };
		for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dirs.agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		writeFileSync(
			join(dirs.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "none",
						models: [{ id: "kept" }],
					},
				},
			}),
		);
		writeFileSync(
			join(dirs.agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "localai", defaultModel: "qwen3.8-27b-fp8", ...settings }),
		);
		const child = spawn(process.execPath, ["--import", resolverUrl, cli, "--mode", "rpc"], {
			cwd: dirs.cwd,
			env: {
				...process.env,
				HOME: dirs.home,
				PI_CODING_AGENT_DIR: dirs.agentDir,
				PRISM_CODING_AGENT_DIR: dirs.agentDir,
				[ENV_AGENT_DIR]: dirs.agentDir,
				PI_OFFLINE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);
		let out = "";
		let err = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			err += chunk;
		});
		return new Promise<{ message: string; notifyType: string }>((resolveNotice, reject) => {
			const timer = setTimeout(() => reject(new Error(`no notice; stdout: ${out.slice(-2000)}\n${err}`)), 30_000);
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				out += chunk;
				for (const line of out.split("\n")) {
					if (!line.startsWith("{")) continue;
					let record: { type?: string; method?: string; message?: string; notifyType?: string };
					try {
						record = JSON.parse(line);
					} catch {
						continue;
					}
					if (
						record.type === "extension_ui_request" &&
						record.method === "notify" &&
						record.message?.includes("Default model")
					) {
						clearTimeout(timer);
						resolveNotice({ message: record.message, notifyType: record.notifyType ?? "" });
					}
				}
			});
		});
	}

	const notice = {
		message:
			"Default model localai/qwen3.8-27b-fp8 not found; using local/kept. Choose another in /settings › Models.",
		notifyType: "warning",
	};

	it("with enabledModels (main.ts)", async () => {
		expect(await engine({ enabledModels: ["local/kept"] })).toEqual(notice);
	}, 40_000);

	it("without enabledModels (findInitialModel)", async () => {
		expect(await engine({})).toEqual(notice);
	}, 40_000);
});

// fork: a saved default that exists and has a key, but is not in `enabledModels`,
// was replaced at start by the first model of that list, without a word. `enabledModels` narrows the Ctrl+P cycle,
// not the default: the default opens. `--models` on the command line is a choice for this run and still wins.
describe("fork: a usable default outside enabledModels opens", () => {
	const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const resolverUrl = pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href;
	const cli = join(packageDir, "src/cli.ts");
	const children: ChildProcessWithoutNullStreams[] = [];
	afterEach(() => {
		for (const child of children.splice(0)) child.kill("SIGKILL");
	});

	/** Starts the RPC engine with `local/kept` as the saved default and returns the model it opened on. */
	function startModel(settings: Record<string, unknown>, args: string[] = []) {
		const root = tempDir();
		const dirs = { cwd: join(root, "work"), agentDir: join(root, "agent"), home: join(root, "home") };
		for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dirs.agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		writeFileSync(
			join(dirs.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "none",
						models: [{ id: "kept" }, { id: "other" }, { id: "third" }],
					},
				},
			}),
		);
		writeFileSync(
			join(dirs.agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "local", defaultModel: "kept", ...settings }),
		);
		const child = spawn(process.execPath, ["--import", resolverUrl, cli, "--mode", "rpc", ...args], {
			cwd: dirs.cwd,
			env: {
				...process.env,
				HOME: dirs.home,
				PI_CODING_AGENT_DIR: dirs.agentDir,
				PRISM_CODING_AGENT_DIR: dirs.agentDir,
				[ENV_AGENT_DIR]: dirs.agentDir,
				PI_OFFLINE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);
		child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
		let out = "";
		let err = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			err += chunk;
		});
		return new Promise<{ model: string; notices: string[] }>((resolveState, reject) => {
			const timer = setTimeout(() => reject(new Error(`no state; stdout: ${out.slice(-2000)}\n${err}`)), 30_000);
			const notices: string[] = [];
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				out += chunk;
				const lines = out.split("\n");
				out = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("{")) continue;
					let record: {
						type?: string;
						id?: string;
						method?: string;
						message?: string;
						data?: { model?: { provider: string; id: string } };
					};
					try {
						record = JSON.parse(line);
					} catch {
						continue;
					}
					if (record.type === "extension_ui_request" && record.method === "notify" && record.message) {
						notices.push(record.message);
					}
					if (record.type === "response" && record.id === "state") {
						clearTimeout(timer);
						const opened = record.data?.model;
						resolveState({ model: opened ? `${opened.provider}/${opened.id}` : "", notices });
					}
				}
			});
		});
	}

	it("opens the saved default although enabledModels does not list it", async () => {
		const started = await startModel({ enabledModels: ["local/other", "local/third"] });
		expect(started.model).toBe("local/kept");
		expect(started.notices.filter((n) => n.includes("Default model"))).toEqual([]);
	}, 40_000);

	it("keeps the default when enabledModels lists it, and lets --models choose for the run", async () => {
		expect((await startModel({ enabledModels: ["local/other", "local/kept"] })).model).toBe("local/kept");
		expect((await startModel({}, ["--models", "local/other,local/third"])).model).toBe("local/other");
	}, 60_000);
});

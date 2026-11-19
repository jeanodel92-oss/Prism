// fork: third-party plugins vendored under vendor/node_modules and shipped as built-in extensions.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { importExtensionFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { getVendorDir } from "../src/fork/vendored.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./suite/harness.ts";

describe("fork: vendored plugins", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-vendored-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	function entry(name: string) {
		const found = builtInExtensions.find((extension) => typeof extension !== "function" && extension.name === name);
		if (!found || typeof found === "function") throw new Error(`no built-in extension ${name}`);
		return found;
	}

	async function start(name: string, factory: ExtensionFactory, ui: Parameters<typeof createTestUiContext>[0] = {}) {
		const harness = await createHarness({
			extensionFactories: [{ name, factory }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(ui) });
		return harness;
	}

	it("pi-context-inspector: a replaceable built-in fork with its license and fork notes", () => {
		expect(entry("pi-context-inspector")).toMatchObject({ replaceable: true, builtin: true });
		const forkDir = join(getVendorDir(), "..", "forks", "pi-context-inspector");
		expect(existsSync(join(forkDir, "index.ts"))).toBe(true);
		expect(readFileSync(join(forkDir, "LICENSE"), "utf-8")).toContain("MIT License");
		expect(readFileSync(join(forkDir, "FORK.md"), "utf-8")).toContain("pi-context-inspector` 1.3.0");
		const readme = readFileSync(join(getVendorDir(), "..", "README.md"), "utf-8");
		expect(readme).toContain(
			"| `pi-context-inspector` | 1.3.0 | `pi-context-inspector` | `forks/pi-context-inspector/index.ts` |",
		);
	});

	it("pi-lsp: a replaceable built-in fork with its license and fork notes", () => {
		expect(entry("pi-lsp")).toMatchObject({ replaceable: true, builtin: true });
		const forkDir = join(getVendorDir(), "..", "forks", "pi-lsp");
		expect(readFileSync(join(forkDir, "LICENSE"), "utf-8")).toContain("MIT License");
		expect(readFileSync(join(forkDir, "FORK.md"), "utf-8")).toContain("pi-lsp` 0.49.8");
		const readme = readFileSync(join(getVendorDir(), "..", "README.md"), "utf-8");
		expect(readme).toContain("| `@narumitw/pi-lsp` | 0.49.8 | `pi-lsp` | `forks/pi-lsp/dist/index.ts` |");
	});

	it("pi-lsp: /lsp reports the language servers", async () => {
		const notes: string[] = [];
		const harness = await start("pi-lsp", entry("pi-lsp").factory, {
			notify: (message: string) => void notes.push(message),
		});
		await harness.session.prompt("/lsp");
		expect(notes.at(-1)).toMatch(/^(Language servers ready|No language server is ready)/);
		await harness.session.prompt("/lsp all");
		expect(notes.at(-1)).toContain("LSP command:");
	});

	it("pi-context-inspector: registers /context", async () => {
		const harness = await start("pi-context-inspector", entry("pi-context-inspector").factory);
		expect(harness.session.extensionRunner.getCommand("context")).toBeDefined();
	});

	it("pi-plan-mode: a replaceable built-in fork with its license and fork notes", () => {
		expect(entry("pi-plan-mode")).toMatchObject({ replaceable: true, builtin: true });
		const forkDir = join(getVendorDir(), "..", "forks", "pi-plan-mode");
		expect(readFileSync(join(forkDir, "LICENSE"), "utf-8")).toContain("MIT License");
		expect(readFileSync(join(forkDir, "FORK.md"), "utf-8")).toContain("pi-plan-mode` 0.58.3");
		const readme = readFileSync(join(getVendorDir(), "..", "README.md"), "utf-8");
		expect(readme).toContain(
			"| `@narumitw/pi-plan-mode` | 0.58.3 | `pi-plan-mode` | `forks/pi-plan-mode/dist/index.ts` |",
		);
	});

	it("pi-plan-mode: registers /plan", async () => {
		const harness = await start("pi-plan-mode", entry("pi-plan-mode").factory);
		expect(harness.session.extensionRunner.getCommand("plan")).toBeDefined();
	});

	it("pi-goal: a replaceable built-in fork with its license and fork notes", () => {
		expect(entry("pi-goal")).toMatchObject({ replaceable: true, builtin: true });
		const forkDir = join(getVendorDir(), "..", "forks", "pi-goal");
		expect(readFileSync(join(forkDir, "LICENSE"), "utf-8")).toContain("MIT License");
		expect(readFileSync(join(forkDir, "FORK.md"), "utf-8")).toContain("pi-goal` 0.54.8");
		const readme = readFileSync(join(getVendorDir(), "..", "README.md"), "utf-8");
		expect(readme).toContain("| `@narumitw/pi-goal` | 0.54.8 | `pi-goal` | `forks/pi-goal/dist/index.ts` |");
	});

	it("pi-goal: registers /goal", async () => {
		const harness = await start("pi-goal", entry("pi-goal").factory);
		expect(harness.session.extensionRunner.getCommand("goal")).toBeDefined();
	});

	// the saved goal was the live one, so its usage counters changed afterwards.
	it("pi-goal: a saved goal entry keeps the values it was saved with", async () => {
		const harness = await start("pi-goal", entry("pi-goal").factory);
		const manager = harness.session.sessionManager;
		const written: string[] = [];
		const append = manager.appendCustomEntry.bind(manager);
		vi.spyOn(manager, "appendCustomEntry").mockImplementation((customType, data) => {
			if (customType === "goal-state") written.push(JSON.stringify(data));
			return append(customType, data);
		});
		const goals = () =>
			manager
				.getBranch()
				.flatMap((item) =>
					item.type === "custom" && item.customType === "goal-state" ? [JSON.stringify(item.data)] : [],
				);
		harness.setResponses([fauxAssistantMessage("working on it"), fauxAssistantMessage("still working")]);
		await harness.session.prompt("/goal write the report");
		// The goal's turn runs, and its usage is counted and saved again.
		await vi.waitFor(() => expect(written.length).toBeGreaterThan(2), { timeout: 5000 });
		await harness.session.agent.waitForIdle();
		expect(goals()).toEqual(written);
	});

	it("rpiv-ask-user-question: a replaceable built-in fork with its license and fork notes", () => {
		expect(entry("rpiv-ask-user-question")).toMatchObject({ replaceable: true, builtin: true });
		const forkDir = join(getVendorDir(), "..", "forks", "rpiv-ask-user-question");
		expect(readFileSync(join(forkDir, "LICENSE"), "utf-8")).toContain("MIT License");
		expect(readFileSync(join(forkDir, "FORK.md"), "utf-8")).toContain("rpiv-ask-user-question` 2.12.0");
		const readme = readFileSync(join(getVendorDir(), "..", "README.md"), "utf-8");
		expect(readme).toContain(
			"| `@juicesharp/rpiv-ask-user-question` | 2.12.0 | `rpiv-ask-user-question` | `forks/rpiv-ask-user-question/index.ts` |",
		);
	});

	it("rpiv-ask-user-question: registers the ask_user_question tool", async () => {
		const harness = await start("rpiv-ask-user-question", entry("rpiv-ask-user-question").factory);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("ask_user_question");
	});

	it("prebundled plugins load and register like the originals", async () => {
		const out = join(agentDir, "prebundled");
		const script = join(getVendorDir(), "..", "..", "..", "..", "fork", "scripts", "prebundle-vendored.mjs");
		const result = spawnSync(process.execPath, [script, getVendorDir(), out], { encoding: "utf-8" });
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);

		const ask = join(out, "forks/rpiv-ask-user-question/index.ts");
		expect(readFileSync(ask, "utf-8")).not.toContain('from "@juicesharp/rpiv-config"');
		const askFactory = await importExtensionFactory(ask);
		if (!askFactory) throw new Error("no factory");
		const askHarness = await start("rpiv-ask-user-question", askFactory);
		expect(askHarness.session.getAllTools().map((tool) => tool.name)).toContain("ask_user_question");

		const inspectorFactory = await importExtensionFactory(join(out, "forks/pi-context-inspector/index.ts"));
		if (!inspectorFactory) throw new Error("no factory");
		const inspector = await start("pi-context-inspector", inspectorFactory);
		expect(inspector.session.extensionRunner.getCommand("context")).toBeDefined();
	});

	// the prebundle of rpiv-ask-user-question 2.12.0 deadlocked on its first call: esbuild turned
	// the plugin's dialog-builder <-> tab-content-strategy import cycle into two async lazy inits
	// awaiting each other (top-level await in state/i18n-bridge.ts makes them async), so execute()
	// never reached ui.custom and the tool never returned. Prism's fork breaks the cycle.
	it.each(["source", "prebundled"] as const)(
		"%s ask_user_question reaches its dialog and returns a result (V2.1)",
		async (variant) => {
			let factory = entry("rpiv-ask-user-question").factory;
			if (variant === "prebundled") {
				const out = join(agentDir, "prebundled");
				const script = join(getVendorDir(), "..", "..", "..", "..", "fork", "scripts", "prebundle-vendored.mjs");
				const result = spawnSync(process.execPath, [script, getVendorDir(), out], { encoding: "utf-8" });
				expect(result.status).toBe(0);
				const prebundled = await importExtensionFactory(join(out, "forks/rpiv-ask-user-question/index.ts"));
				if (!prebundled) throw new Error("no factory");
				factory = prebundled;
			}

			let dialogs = 0;
			const harness = await start("rpiv-ask-user-question", factory, {
				custom: async <T>() => {
					dialogs++;
					return undefined as T;
				},
			});
			const question = {
				question: "Pick one",
				header: "Pick",
				options: [
					{ label: "A", description: "First" },
					{ label: "B", description: "Second" },
				],
			};
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("ask_user_question", { questions: [question] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), 10_000);
			});
			const outcome = await Promise.race([harness.session.prompt("ask me").then(() => "done" as const), timeout]);
			clearTimeout(timer);
			expect(outcome).toBe("done");
			expect(dialogs).toBe(1);
			expect(getToolResult(harness, "ask_user_question")).toBeDefined();
		},
		30_000,
	);

	// aborting the turn closes the questionnaire; the tool returns a cancelled result
	// instead of waiting for an answer, or treating the closed dialog as an RPC host.
	it("rpiv-ask-user-question: an abort closes the questionnaire with a cancelled result", async () => {
		let dialogSignal: AbortSignal | undefined;
		let opened: () => void = () => {};
		const dialogOpened = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const harness = await start("rpiv-ask-user-question", entry("rpiv-ask-user-question").factory, {
			custom: <T>(_factory: unknown, options?: { signal?: AbortSignal }) =>
				new Promise<T>((resolve) => {
					dialogSignal = options?.signal;
					opened();
					options?.signal?.addEventListener("abort", () => resolve(undefined as T), { once: true });
				}),
		});
		const question = {
			question: "Pick one",
			header: "Pick",
			options: [
				{ label: "A", description: "First" },
				{ label: "B", description: "Second" },
			],
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user_question", { questions: [question] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const run = harness.session.prompt("ask me");
		await dialogOpened;
		expect(dialogSignal).toBeDefined();
		await harness.session.abort();
		await run;
		const result = getToolResult(harness, "ask_user_question");
		expect(JSON.stringify(result.content)).toContain("interrupted the turn before answering");
	}, 30_000);

	// in the window (an RPC host), Stop left the question open, a panel
	// nobody waited for. The RPC dialogs now get the turn's signal, so the host closes them.
	it("rpiv-ask-user-question: an abort closes the RPC host's dialog", async () => {
		let dialogSignal: AbortSignal | undefined;
		let opened: () => void = () => {};
		const dialogOpened = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const harness = await start("rpiv-ask-user-question", entry("rpiv-ask-user-question").factory, {
			select: (_title, _options, options) =>
				new Promise((resolve) => {
					dialogSignal = options?.signal;
					opened();
					options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		});
		const question = {
			question: "Pick one",
			header: "Pick",
			options: [
				{ label: "A", description: "First" },
				{ label: "B", description: "Second" },
			],
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user_question", { questions: [question] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const run = harness.session.prompt("ask me");
		await dialogOpened;
		expect(dialogSignal?.aborted).toBe(false);
		await harness.session.abort();
		await run;
		expect(dialogSignal?.aborted).toBe(true);
	}, 30_000);

	it("vendored packages without a license file ship one under vendor/licenses", () => {
		for (const pkg of ["@juicesharp/rpiv-config"]) {
			const license = join(getVendorDir(), "..", "licenses", pkg, "LICENSE");
			expect(readFileSync(license, "utf-8")).toContain("MIT License");
		}
	});
});

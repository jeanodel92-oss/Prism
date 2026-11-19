// fork: /model-settings shows the server's values next to Prism's, and a manual
// correction persists in models.json and wins over a new detection.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { detectCapabilities } from "../src/fork/capabilities.ts";
import { writeCompatibleServer } from "../src/fork/compatible-server.ts";
import modelSettings, {
	formatRows,
	parseSettingValue,
	readModelCorrection,
	settingRows,
	writeModelCorrection,
} from "../src/fork/model-settings.ts";

describe("fork: model settings", () => {
	let server: Server | undefined;
	let tempDir = "";
	const requests: string[] = [];

	afterEach(async () => {
		requests.length = 0;
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
		vi.unstubAllEnvs();
	});

	/** A llama.cpp server with an 8192-token slot and its own sampling defaults. */
	async function serveLlamaCpp(): Promise<string> {
		const routes: Record<string, unknown> = {
			"GET /props": {
				default_generation_settings: {
					n_ctx: 8192,
					params: { n_predict: -1, temperature: 0.8, top_p: 0.95, top_k: 40, min_p: 0.05 },
				},
				total_slots: 1,
			},
			"GET /slots": [{ id: 0, n_ctx: 8192 }],
			"GET /v1/models": { data: [{ id: "local-model" }] },
		};
		server = createServer((request, response) => {
			const key = `${request.method} ${(request.url ?? "").split("?")[0]}`;
			requests.push(key);
			const body = routes[key];
			if (body === undefined) response.writeHead(404).end();
			else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
		return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
	}

	async function runtimeFor(agentDir: string): Promise<ModelRuntime> {
		return ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
	}

	it("reads the server's output limit and sampling defaults (llama.cpp and Ollama)", async () => {
		const baseUrl = await serveLlamaCpp();
		const [model] = (await detectCapabilities(baseUrl, ["local-model"])).models;
		expect(model?.maxOutput).toBe("unlimited");
		expect(model?.sampling).toEqual({ temperature: 0.8, top_p: 0.95, top_k: 40, min_p: 0.05 });

		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = createServer((request, response) => {
			const path = request.url ?? "";
			if (path === "/api/version") response.writeHead(200).end(JSON.stringify({ version: "0.12.0" }));
			else if (path === "/api/show")
				response.writeHead(200).end(
					JSON.stringify({
						parameters: "num_ctx                        16384\nnum_predict 512\ntemperature 0.6",
					}),
				);
			else response.writeHead(404).end();
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
		const ollama = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
		const [shown] = (await detectCapabilities(ollama, ["qwen"])).models;
		expect(shown).toMatchObject({ contextWindow: 16384, maxOutput: 512, sampling: { temperature: 0.6 } });
	});

	it("labels the server's value and Prism's apart, and a correction persists and wins over a new detection", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-model-settings-"));
		const modelsPath = join(tempDir, "models.json");
		const baseUrl = await serveLlamaCpp();
		const detected = await detectCapabilities(baseUrl, ["local-model"]);
		const server = { providerId: "box", baseUrl, models: ["local-model"], detected };
		await writeCompatibleServer(modelsPath, server, "openai-completions", false);

		await writeModelCorrection(modelsPath, "box", "local-model", "contextWindow", 16384);
		await writeModelCorrection(modelsPath, "box", "local-model", "temperature", 0.3);
		// A new detection (/login again) rewrites the model list; the correction stays.
		await writeCompatibleServer(modelsPath, server, "openai-completions", false);
		expect(readModelCorrection(modelsPath, "box", "local-model")).toEqual({
			contextWindow: 16384,
			samplingParams: { temperature: 0.3 },
		});

		const runtime = await runtimeFor(tempDir);
		const model = runtime.getModel("box", "local-model")!;
		expect(model.contextWindow).toBe(16384);
		expect(model.samplingParams).toEqual({ temperature: 0.3 });

		const rows = settingRows(model, readModelCorrection(modelsPath, "box", "local-model"), detected.models[0]);
		const lines = formatRows(rows);
		expect(lines[0]).toMatch(/^Name +server not reported +Prism local-model$/);
		expect(lines[1]).toMatch(/^Context +server 8192 +Prism 16384 \(your correction\)$/);
		expect(lines.find((line) => line.startsWith("Temperature"))).toMatch(
			/server 0\.8 +Prism 0\.3 \(your correction\)$/,
		);
		expect(lines.find((line) => line.startsWith("Top P"))).toMatch(/server 0\.95 +Prism not sent$/);
		expect(lines.find((line) => line.startsWith("Max output"))).toMatch(/server unlimited /);

		// Removing the correction gives the detected value back.
		await writeModelCorrection(modelsPath, "box", "local-model", "contextWindow", undefined);
		await writeModelCorrection(modelsPath, "box", "local-model", "temperature", undefined);
		const config = JSON.parse(readFileSync(modelsPath, "utf-8"));
		expect(config.providers.box.modelOverrides).toBeUndefined();
		expect(config.providers.box.models[0].contextWindow).toBe(8192);
	});

	it("name, penalties and other parameters reach the request sent to the server", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-model-settings-"));
		const bodies: Record<string, unknown>[] = [];
		server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			bodies.push(JSON.parse(body) as Record<string, unknown>);
			const chunks = [
				{ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" } }] },
				{ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
		const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					box: {
						baseUrl,
						api: "openai-completions",
						apiKey: "none",
						models: [{ id: "qwen", contextWindow: 65536 }],
					},
				},
			}),
		);
		const parsed = (key: Parameters<typeof parseSettingValue>[0], text: string) => {
			const value = parseSettingValue(key, text);
			if (value instanceof Error) throw value;
			return value;
		};
		await writeModelCorrection(modelsPath, "box", "qwen", "name", parsed("name", " My Qwen "));
		await writeModelCorrection(modelsPath, "box", "qwen", "maxTokens", parsed("maxTokens", "30000"));
		await writeModelCorrection(modelsPath, "box", "qwen", "presence_penalty", parsed("presence_penalty", "-0.5"));
		await writeModelCorrection(modelsPath, "box", "qwen", "repeat_penalty", parsed("repeat_penalty", "1.1"));
		await writeModelCorrection(modelsPath, "box", "qwen", "extra", parsed("extra", '{"seed": 7, "typical_p": 0.9}'));
		// A new object replaces the other parameters; the named ones keep their own rows.
		await writeModelCorrection(modelsPath, "box", "qwen", "extra", parsed("extra", '{"seed": 42}'));
		expect(readModelCorrection(modelsPath, "box", "qwen")).toEqual({
			name: "My Qwen",
			maxTokens: 30000,
			samplingParams: { presence_penalty: -0.5, repeat_penalty: 1.1, seed: 42 },
		});

		const runtime = await runtimeFor(tempDir);
		const model = runtime.getModel("box", "qwen")!;
		expect(model.name).toBe("My Qwen");
		const rows = formatRows(settingRows(model, readModelCorrection(modelsPath, "box", "qwen"), undefined));
		expect(rows.find((line) => line.startsWith("Other parameters"))).toMatch(
			/Prism \{"seed":42\} \(your correction\)$/,
		);
		expect(rows.find((line) => line.startsWith("Presence penalty"))).toMatch(/Prism -0\.5 \(your correction\)$/);

		const cwd = join(tempDir, "ws");
		mkdirSync(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir: tempDir,
			modelRuntime: runtime,
			model,
			sessionManager: SessionManager.create(cwd, join(tempDir, "sessions")),
			settingsManager: SettingsManager.inMemory(),
		});
		await session.prompt("hi");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			presence_penalty: -0.5,
			repeat_penalty: 1.1,
			seed: 42,
			max_completion_tokens: 30000,
		});
		expect(bodies[0]).not.toHaveProperty("typical_p");
	});

	it("checks typed values", () => {
		expect(parseSettingValue("contextWindow", "32768")).toBe(32768);
		expect(parseSettingValue("contextWindow", "0")).toBeInstanceOf(Error);
		expect(parseSettingValue("maxTokens", "1.5")).toBeInstanceOf(Error);
		expect(parseSettingValue("temperature", "0.7")).toBe(0.7);
		expect(parseSettingValue("temperature", "-1")).toBeInstanceOf(Error);
		expect(parseSettingValue("vision", "yes")).toBe(true);
		expect(parseSettingValue("reasoning", "off")).toBe(false);
		expect(parseSettingValue("vision", "maybe")).toBeInstanceOf(Error);
		// fork: presence and frequency penalties may be negative; repeat penalty may not.
		expect(parseSettingValue("frequency_penalty", "-1.5")).toBe(-1.5);
		expect(parseSettingValue("repeat_penalty", "-1")).toBeInstanceOf(Error);
		expect(parseSettingValue("name", "  ")).toBeInstanceOf(Error);
		expect(parseSettingValue("extra", "[1]")).toBeInstanceOf(Error);
		expect(parseSettingValue("extra", "seed=1")).toBeInstanceOf(Error);
		expect(String(parseSettingValue("extra", '{"top_p": 0.9}'))).toContain("top_p: it has its own row.");
	});

	it("the command writes the correction, reloads the model and reads the server only once", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-model-settings-"));
		vi.stubEnv(ENV_AGENT_DIR, tempDir);
		const modelsPath = join(tempDir, "models.json");
		const baseUrl = await serveLlamaCpp();
		const detected = await detectCapabilities(baseUrl, ["local-model"]);
		await writeCompatibleServer(
			modelsPath,
			{ providerId: "box", baseUrl, models: ["local-model"], detected },
			"openai-completions",
			false,
		);
		requests.length = 0;
		const runtime = await runtimeFor(tempDir);
		const registry = new ModelRegistry(runtime);

		let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
		const selected: Model<Api>[] = [];
		modelSettings({
			on: () => {},
			registerCommand: (_name: string, options: typeof command) => {
				command = options;
			},
			setModel: async (model: Model<Api>) => {
				selected.push(model);
				return true;
			},
		} as unknown as ExtensionAPI);

		const titles: string[] = [];
		const answers = ["Context", undefined];
		const ctx = {
			hasUI: true,
			model: runtime.getModel("box", "local-model"),
			modelRegistry: registry,
			ui: {
				select: async (title: string, options: string[]) => {
					titles.push(title, ...options);
					const wanted = answers.shift();
					return wanted === undefined ? undefined : options.find((option) => option.startsWith(wanted));
				},
				input: async () => "12000",
				notify: () => {},
			},
		} as unknown as ExtensionCommandContext;
		await command!.handler("", ctx);

		expect(readModelCorrection(modelsPath, "box", "local-model")).toEqual({ contextWindow: 12000 });
		expect(selected.map((model) => model.contextWindow)).toEqual([12000]);
		expect(titles[0]).toContain("Prism: what Prism sends or assumes; changing it does not change the server.");
		expect(
			titles.filter((line) => /^Context +server 8192 +Prism 12000 \(your correction\)$/.test(line)),
		).toHaveLength(1);
		// One detection when the screen opens, read-only.
		expect(requests.filter((request) => request === "GET /props")).toHaveLength(1);
		expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
	});

	it("does not read anything for a provider that is not a server in models.json", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-model-settings-"));
		vi.stubEnv(ENV_AGENT_DIR, tempDir);
		writeFileSync(join(tempDir, "models.json"), JSON.stringify({ providers: {} }));
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
		modelSettings({
			on: () => {},
			registerCommand: (_name: string, options: typeof command) => {
				command = options;
			},
		} as unknown as ExtensionAPI);
		const shown: string[] = [];
		const model = {
			provider: "anthropic",
			id: "m",
			contextWindow: 200000,
			maxTokens: 64000,
			input: ["text", "image"],
			reasoning: true,
		} as unknown as Model<Api>;
		await command!.handler("", {
			hasUI: false,
			model,
			ui: { notify: (text: string) => shown.push(text) },
		} as unknown as ExtensionCommandContext);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
		expect(shown[0]).toContain("This provider does not report its settings");
		expect(shown[0]).toMatch(/Context +server not reported +Prism 200000/);
	});
});

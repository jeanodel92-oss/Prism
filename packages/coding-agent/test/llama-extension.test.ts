import { once } from "node:events";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthContext, AuthPrompt, ModelsPublication, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { type Component, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	LlamaClient,
	type LlamaModelInfo,
	type LlamaProgress,
	LlamaServerError,
	normalizeLlamaServerUrl,
} from "../src/extensions/llama/client.ts";
import { findHuggingFaceToken, HuggingFaceClient } from "../src/extensions/llama/huggingface.ts";
import llamaExtension from "../src/extensions/llama/index.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "../src/extensions/llama/provider.ts";
import { llamaErrorMessage } from "../src/extensions/llama/ui.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}` };
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

afterEach(async () => {
	setLanguage("en");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

describe("llama.cpp extension", () => {
	it("registers a native provider and /llama command", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			llamaExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:llama.cpp",
		);

		expect(extension.commands.get("llama")?.description).toBe("Manage llama.cpp router models");
		expect(runtime.pendingNativeProviderRegistrations.map((entry) => entry.provider.id)).toEqual([LLAMA_PROVIDER_ID]);
	});

	it("normalizes management and inference URLs", () => {
		expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
		expect(normalizeLlamaServerUrl("https://example.com/prefix/v1")).toBe("https://example.com/prefix");
		expect(() => normalizeLlamaServerUrl("file:///tmp/llama")).toThrow("http or https");
	});

	it("exposes loaded and sleeping models with router metadata", () => {
		const controller = createLlamaProvider();
		controller.setCatalog(
			[
				{
					id: "loaded",
					status: { value: "loaded", args: ["llama-server", "--n-gpu-layers", "999"] },
					architecture: { input_modalities: ["text", "image"] },
					meta: { n_ctx: 65536, n_ctx_train: 131072 },
				},
				{ id: "sleeping", status: { value: "sleeping" } },
				{ id: "unloaded", status: { value: "unloaded" } },
				{ id: "loading", status: { value: "loading" } },
			],
			"http://localhost:8080",
		);

		expect(controller.provider.getModels()).toEqual([
			expect.objectContaining({
				id: "loaded",
				baseUrl: "http://localhost:8080/v1",
				contextWindow: 65536,
				maxTokens: 65536,
				input: ["text", "image"],
			}),
			expect.objectContaining({
				id: "sleeping",
				baseUrl: "http://localhost:8080/v1",
			}),
		]);
	});

	// Regression test for #9528.
	it("discovers chat-template thinking support for loaded models", async () => {
		let propsRequests = 0;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [{ id: "qwen", status: { value: "loaded" }, meta: { n_ctx: 32768 } }],
				});
				return;
			}
			const requestUrl = new URL(request.url ?? "", "http://localhost");
			if (requestUrl.pathname === "/props") {
				propsRequests++;
				expect(requestUrl.searchParams.get("model")).toBe("qwen");
				expect(requestUrl.searchParams.get("autoload")).toBe("false");
				json(response, { chat_template: "{% if enable_thinking %}think{% endif %}" });
				return;
			}
			response.writeHead(404).end();
		});

		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(propsRequests).toBe(1);
		expect(controller.provider.getModels()).toEqual([
			expect.objectContaining({
				id: "qwen",
				reasoning: true,
				thinkingLevelMap: {
					off: "off",
					minimal: null,
					low: null,
					medium: "medium",
					high: null,
					xhigh: null,
				},
				compat: expect.objectContaining({ thinkingFormat: "qwen-chat-template" }),
			}),
		]);
	});

	it("persists and restores selectable models for cache-only startup refreshes", async () => {
		let cachedEntry: ModelsStoreEntry | undefined;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "loaded", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
						{ id: "sleeping", status: { value: "sleeping" }, meta: { n_ctx: 32768 } },
						{ id: "unloaded", status: { value: "unloaded" } },
					],
				});
				return;
			}
			if (request.url === "/props?model=loaded&autoload=false") {
				json(response, {});
				return;
			}
			response.writeHead(404).end();
		});

		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist === null) cachedEntry = undefined;
			else if (publication.persist !== undefined) cachedEntry = structuredClone(publication.persist);
			publication.update?.();
			return true;
		};
		const first = createLlamaProvider();
		await first.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(first.provider.getModels().map((model) => model.id)).toEqual(["loaded", "sleeping"]);
		expect(cachedEntry?.models.map((model) => [model.id, model.api])).toEqual([
			["loaded", "openai-completions"],
			["sleeping", "openai-completions"],
			["loaded", "llama-cpp-classify"],
			["sleeping", "llama-cpp-classify"],
		]);

		const second = createLlamaProvider();
		await second.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: cachedEntry,
			publish,
			allowNetwork: false,
			signal: new AbortController().signal,
		});
		expect(second.provider.getModels()).toEqual([
			expect.objectContaining({ id: "loaded", baseUrl: `${url}/v1`, contextWindow: 32768 }),
			expect.objectContaining({ id: "sleeping", baseUrl: `${url}/v1`, contextWindow: 32768 }),
		]);
		expect(second.provider.getAllModels?.().filter((model) => model.type === "classifier")).toEqual([
			expect.objectContaining({ id: "loaded", api: "llama-cpp-classify", baseUrl: url, contextWindow: 32768 }),
			expect.objectContaining({ id: "sleeping", api: "llama-cpp-classify", baseUrl: url, contextWindow: 32768 }),
		]);
	});

	it("preserves cached llama.cpp context for unloaded autoload presets", async () => {
		let cachedEntry: ModelsStoreEntry | undefined;
		let loaded = true;
		let unloadedArgs: string[] | undefined;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [
						loaded
							? {
									id: "qwen",
									status: { value: "loaded" },
									source: "preset",
									meta: { n_ctx: 65536, n_ctx_train: 128000 },
								}
							: {
									id: "qwen",
									status: { value: "unloaded", ...(unloadedArgs && { args: unloadedArgs }) },
									source: "preset",
									meta: { n_ctx_train: 128000 },
								},
					],
				});
				return;
			}
			if (request.url === "/props?model=qwen&autoload=false") {
				json(response, {});
				return;
			}
			if (request.url === "/props") {
				json(response, { role: "router", models_autoload: true });
				return;
			}
			response.writeHead(404).end();
		});

		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist === null) cachedEntry = undefined;
			else if (publication.persist !== undefined) cachedEntry = structuredClone(publication.persist);
			publication.update?.();
			return true;
		};
		const storedContextWindows = () =>
			cachedEntry?.models.map((model) => ("contextWindow" in model ? model.contextWindow : undefined));
		const credential = { type: "api_key" as const, key: "local", env: { LLAMA_BASE_URL: url } };

		const first = createLlamaProvider();
		await first.provider.refreshModels?.({
			credential,
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(storedContextWindows()).toEqual([65536, 65536]);

		loaded = false;
		const second = createLlamaProvider();
		await second.provider.refreshModels?.({
			credential,
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(second.provider.getModels()).toEqual([expect.objectContaining({ id: "qwen", contextWindow: 65536 })]);
		expect(storedContextWindows()).toEqual([65536, 65536]);

		unloadedArgs = ["llama-server", "--ctx-size", "32768"];
		await second.provider.refreshModels?.({
			credential,
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(storedContextWindows()).toEqual([32768, 32768]);
	});

	it("exposes unloaded presets only when router autoload is enabled", async () => {
		let propsRequests = 0;
		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer local");
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "preset", status: { value: "unloaded" }, source: "preset", meta: { n_ctx: 65536 } },
						{ id: "failed-preset", status: { value: "unloaded", failed: true }, source: "preset" },
						{ id: "cache", status: { value: "unloaded" }, source: "cache" },
						{ id: "models-dir", status: { value: "unloaded" }, source: "models_dir" },
					],
				});
				return;
			}
			if (request.url === "/props") {
				propsRequests++;
				json(response, { role: "router", models_autoload: true });
				return;
			}
			response.writeHead(404).end();
		});

		let cachedEntry: ModelsStoreEntry | undefined;
		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				if (publication.persist !== undefined && publication.persist !== null) {
					cachedEntry = structuredClone(publication.persist);
				}
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(propsRequests).toBe(1);
		expect(controller.provider.getModels().map((model) => model.id)).toEqual(["preset"]);
		expect(cachedEntry?.models.map((model) => [model.id, model.api])).toEqual([
			["preset", "openai-completions"],
			["preset", "llama-cpp-classify"],
		]);
	});

	it("classifies with selectable models through llama-server", async () => {
		const paths: string[] = [];
		const { url } = await listen((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				paths.push(request.url ?? "");
				const payload = JSON.parse(body) as { model: string; content?: string };
				expect(payload.model).toBe("qwen");
				if (request.url === "/tokenize") {
					json(response, { tokens: [...(payload.content ?? "")].map((char) => char.codePointAt(0)) });
				} else if (request.url === "/apply-template") {
					json(response, { prompt: "<|im_start|>assistant\n" });
				} else if (request.url === "/completion") {
					json(response, {
						completion_probabilities: [
							{
								top_logprobs: [
									{ id: 66, token: "B", logprob: -0.1 },
									{ id: 65, token: "A", logprob: -2.4 },
								],
							},
						],
					});
				} else {
					response.writeHead(404).end();
				}
			});
		});

		const controller = createLlamaProvider();
		controller.setCatalog([{ id: "qwen", status: { value: "loaded" } }], url);
		const classifier = controller.provider.getAllModels?.().find((model) => model.type === "classifier");
		if (classifier?.type !== "classifier") throw new Error("missing classifier model");

		// Provider auth resolves the OpenAI-compatible /v1 URL, which replaces the model's base URL.
		const result = await controller.provider.classify!(
			{ ...classifier, baseUrl: `${url}/v1` },
			{
				state: { message: "The build is red again." },
				questions: {
					kind: { type: "choice", instructions: "What is this about?", criteria: { billing: "", ci: "" } },
				},
			},
			{ apiKey: "local" },
		);

		expect(result.errorMessage).toBeUndefined();
		expect(result.answers.kind).toMatchObject({ type: "choice", choice: "ci" });
		expect(paths).toContain("/completion");
	});

	it("hides unloaded presets when router autoload is disabled", async () => {
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, { data: [{ id: "preset", status: { value: "unloaded" }, source: "preset" }] });
				return;
			}
			if (request.url === "/props") {
				json(response, { role: "router", models_autoload: false });
				return;
			}
			response.writeHead(404).end();
		});

		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(controller.provider.getModels()).toEqual([]);
	});

	it("stays dormant until configured and stores URL plus optional key", async () => {
		const { provider } = createLlamaProvider();
		const auth = provider.auth.apiKey!;
		const emptyContext: AuthContext = {
			env: async () => undefined,
			fileExists: async () => false,
		};
		const signal = new AbortController().signal;
		expect(await auth.check?.({ ctx: emptyContext, signal })).toBeUndefined();
		expect(await auth.resolve({ ctx: emptyContext, signal })).toBeUndefined();

		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer secret");
			json(response, { data: [] });
		});
		const answers = [url, "secret"];
		const credential = await auth.login!({
			signal,
			prompt: async (_prompt: AuthPrompt) => answers.shift()!,
			notify: () => {},
		});
		expect(credential).toEqual({
			type: "api_key",
			key: "secret",
			env: { LLAMA_BASE_URL: url },
		});
		expect(await auth.resolve({ ctx: emptyContext, credential, signal })).toEqual({
			auth: { apiKey: "secret", baseUrl: `${url}/v1` },
			env: { LLAMA_BASE_URL: url },
			source: "stored credential",
		});
	});

	it("searches Hugging Face and reads quantizations plus access requirements", async () => {
		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer hf-secret");
			if (request.url?.startsWith("/api/models?")) {
				const requestUrl = new URL(request.url, "http://localhost");
				expect(requestUrl.searchParams.get("search")).toBe("qwen coder");
				expect(requestUrl.searchParams.get("filter")).toBe("gguf");
				expect(requestUrl.searchParams.get("sort")).toBe("downloads");
				json(response, [{ id: "owner/model-GGUF", downloads: 1200 }]);
				return;
			}
			if (request.url === "/api/models/owner/model-GGUF?blobs=true") {
				json(response, {
					id: "owner/model-GGUF",
					gated: "manual",
					siblings: [
						{ rfilename: "model-Q5_K_M.gguf", size: 6000 },
						{ rfilename: "model-Q4_K_M-00001-of-00002.gguf", size: 2000 },
						{ rfilename: "model-Q4_K_M-00002-of-00002.gguf", size: 3000 },
						{ rfilename: "mmproj-F16.gguf", size: 1000 },
					],
				});
				return;
			}
			response.writeHead(404).end();
		});
		const client = new HuggingFaceClient("hf-secret", url);

		expect(await client.search("qwen coder")).toEqual([{ id: "owner/model-GGUF", downloads: 1200 }]);
		expect(await client.details("owner/model-GGUF")).toEqual({
			id: "owner/model-GGUF",
			gated: "manual",
			quantizations: [
				{ name: "Q4_K_M", size: 5000 },
				{ name: "Q5_K_M", size: 6000 },
			],
		});
		expect(await findHuggingFaceToken({ HF_TOKEN: " hf-secret " })).toBe("hf-secret");
	});

	it("loads with SSE progress and waits for the loaded catalog state", async () => {
		let status: "unloaded" | "loading" | "loaded" = "unloaded";
		const streams = new Set<ServerResponse>();
		const send = (event: unknown) => {
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const { url } = await listen((request, response) => {
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				streams.add(response);
				request.on("close", () => streams.delete(response));
				return;
			}
			if (request.url === "/models/load" && request.method === "POST") {
				status = "loading";
				json(response, { success: true });
				setTimeout(() => {
					send({
						model: "test-model",
						event: "status_change",
						data: {
							status: "loading",
							progress: { stages: ["text_model", "mmproj_model"], current: "text_model", value: 0.5 },
						},
					});
					status = "loaded";
					send({ model: "test-model", event: "status_change", data: { status: "loaded" } });
				}, 20);
				return;
			}
			if (request.url === "/models") {
				json(response, { data: [{ id: "test-model", status: { value: status } }] });
				return;
			}
			response.writeHead(404).end();
		});

		const progress: string[] = [];
		const model = await new LlamaClient(url).loadAndWait("test-model", (entry) => progress.push(entry.message));
		expect(model.status.value).toBe("loaded");
		expect(progress).toContain("Loading text model");
	});

	it("downloads with byte progress and returns the refreshed catalog", async () => {
		let status: "missing" | "downloading" | "unloaded" = "missing";
		const streams = new Set<ServerResponse>();
		const send = (event: unknown) => {
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const { url } = await listen((request, response) => {
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				streams.add(response);
				request.on("close", () => streams.delete(response));
				return;
			}
			if (request.url === "/models" && request.method === "POST") {
				status = "downloading";
				json(response, { success: true });
				setTimeout(() => {
					send({
						model: "owner/repo:Q4_K_M",
						event: "download_progress",
						data: { progress: { "https://example/model.gguf": { done: 512, total: 1024 } } },
					});
					status = "unloaded";
					send({ model: "owner/repo:Q4_K_M", event: "download_finished", data: {} });
				}, 20);
				return;
			}
			if (request.url?.startsWith("/models")) {
				json(response, {
					data: status === "missing" ? [] : [{ id: "owner/repo:Q4_K_M", status: { value: status } }],
				});
				return;
			}
			response.writeHead(404).end();
		});

		const progress: LlamaProgress[] = [];
		const models = await new LlamaClient(url).downloadAndWait("owner/repo:Q4_K_M", (entry) => progress.push(entry));
		expect(models).toEqual([{ id: "owner/repo:Q4_K_M", status: { value: "unloaded" } }]);
		expect(progress).toContainEqual({
			message: "Downloading model",
			ratio: 0.5,
			detail: "512 B / 1.00 KiB",
		});
	});
});

// terminal display and choices in both languages, with in-memory clients only.
describe("llama manager translations", () => {
	let harness: Harness | undefined;
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager({}));
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Unexpected network request");
			}),
		);
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	async function terminal(models: LlamaModelInfo[] = []) {
		const list = vi.spyOn(LlamaClient.prototype, "list").mockImplementation(async () => structuredClone(models));
		vi.spyOn(LlamaClient.prototype, "props").mockResolvedValue({});
		const unload = vi.spyOn(LlamaClient.prototype, "unloadAndWait").mockImplementation(async (id) => {
			const model = models.find((entry) => entry.id === id);
			if (model) model.status.value = "unloaded";
		});
		const load = vi.spyOn(LlamaClient.prototype, "loadAndWait");
		const download = vi.spyOn(LlamaClient.prototype, "downloadAndWait").mockImplementation(async (id) => {
			models.push({ id, status: { value: "unloaded" } });
			return structuredClone(models);
		});
		vi.stubEnv("HF_TOKEN", "test-token");
		const notes: string[] = [];
		let view: Component | undefined;
		harness = await createHarness({ initialActiveToolNames: [], extensionFactories: [llamaExtension] });
		await harness.authStorage.modify(LLAMA_PROVIDER_ID, async () => ({
			type: "api_key",
			key: "local",
			env: { LLAMA_BASE_URL: "http://llama.invalid" },
		}));
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				notify: (message) => void notes.push(message),
				custom: (async (factory) => {
					let finish: (value: unknown) => void = () => {};
					const result = new Promise((resolve) => {
						finish = resolve;
					});
					view = await factory(
						{ requestRender() {} } as Parameters<typeof factory>[0],
						theme,
						new KeybindingsManager({}),
						finish,
					);
					return result;
				}) as ExtensionUIContext["custom"],
			}),
		});
		const text = () => {
			if (!view) throw new Error("No terminal view");
			for (const width of [40, 64]) {
				for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			return view.render(160).map(stripAnsi).join("\n");
		};
		const key = (data: string) => view?.handleInput?.(data);
		const choose = (index = 0) => {
			for (let count = 0; count < index; count++) key("\u001b[B");
			key("\r");
		};
		const run = () =>
			harness!.session.extensionRunner
				.getCommand("llama")!
				.handler("", harness!.session.extensionRunner.createCommandContext());
		return { text, key, choose, run, list, unload, load, download, notes };
	}

	it.each(["en", "fr"] as const)("L01/L03/L04: loads, cancels and confirms with %s labels", async (language) => {
		setLanguage(language);
		const fr = language === "fr";
		const models: LlamaModelInfo[] = [
			{ id: "alpha", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
			{ id: "beta-$&-{1}", status: { value: "unloaded" } },
		];
		const e = await terminal(models);
		let finish = () => {};
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		e.load.mockImplementation(async (id) => {
			await gate;
			const model = models.find((entry) => entry.id === id)!;
			model.status.value = "loaded";
			return model;
		});
		const done = e.run();
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "chargé · contexte de 33k" : "loaded · 33k context"));
		expect(e.text()).toContain(fr ? "Modèles llama.cpp" : "llama.cpp models");
		expect(e.text()).toContain(fr ? "Télécharger un modèle…" : "Download model…");
		e.choose(1);
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "1 modèle est chargé" : "1 model is loaded"));
		expect(e.text()).toContain(fr ? "Garder les modèles chargés et charger" : "Keep loaded and load");
		e.choose(2);
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "Modèles llama.cpp" : "llama.cpp models"));
		expect(e.load).not.toHaveBeenCalled();
		e.choose(1);
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "Tout décharger et charger" : "Unload all and load"));
		e.choose();
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "Chargement du modèle" : "Loading model"));
		expect(e.text()).toContain(fr ? "Démarrage…" : "Starting…");
		expect(e.unload).toHaveBeenCalledWith("alpha");
		e.key("\u001b");
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "Arrêter le chargement ?" : "Stop loading?"));
		expect(e.text()).toContain(fr ? "Oui" : "Yes");
		expect(e.text()).toContain(fr ? "Non" : "No");
		e.choose(1);
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "Chargement du modèle" : "Loading model"));
		finish();
		await vi.waitFor(() => expect(e.notes).toContain(fr ? "Modèle chargé : beta-$&-{1}" : "Loaded beta-$&-{1}"));
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "Modèles llama.cpp" : "llama.cpp models"));
		e.choose();
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "Décharger le modèle ?" : "Unload model?"));
		e.choose();
		await vi.waitFor(() => expect(e.notes).toContain(fr ? "Modèle déchargé : beta-$&-{1}" : "Unloaded beta-$&-{1}"));
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "Modèles llama.cpp" : "llama.cpp models"));
		expect(models[1]?.status.value).toBe("unloaded");
		e.key("\u001b");
		await done;
	});

	it.each(["en", "fr"] as const)("L01/L04/L05: retries a local error using %s choices", async (language) => {
		setLanguage(language);
		const fr = language === "fr";
		const e = await terminal();
		e.list.mockRejectedValueOnce(new Error("llama.cpp returned an invalid model catalog"));
		const done = e.run();
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "llama.cpp indisponible" : "llama.cpp unavailable"));
		expect(e.text()).toContain(
			fr ? "llama.cpp a renvoyé un catalogue de modèles invalide" : "llama.cpp returned an invalid model catalog",
		);
		expect(e.text()).toContain(fr ? "Réessayer" : "Retry");
		expect(e.text()).toContain(fr ? "Fermer" : "Close");
		expect(e.text()).toContain("http://llama.invalid");
		e.choose();
		await vi.waitFor(() => expect(e.text()).toContain(fr ? "Modèles llama.cpp" : "llama.cpp models"));
		e.key("\u001b");
		await done;
	});

	it.each(["en", "fr"] as const)(
		"L02/L03: searches and downloads a gated repository with %s choices",
		async (language) => {
			setLanguage(language);
			const fr = language === "fr";
			const e = await terminal();
			const search = vi
				.spyOn(HuggingFaceClient.prototype, "search")
				.mockResolvedValue([{ id: "owner/model-GGUF", downloads: 1500 }]);
			const details = vi.spyOn(HuggingFaceClient.prototype, "details").mockResolvedValue({
				id: "owner/model-GGUF",
				gated: "manual",
				quantizations: [{ name: "Q4_K_M", size: 1024 }],
			});
			const done = e.run();
			await vi.waitFor(() => expect(e.text()).toContain(fr ? "Modèles llama.cpp" : "llama.cpp models"));
			e.choose();
			await vi.waitFor(() =>
				expect(e.text()).toContain(fr ? "Saisissez au moins 2 caractères" : "Type at least 2 characters"),
			);
			expect(e.text()).toContain(
				fr ? "Nom du modèle ou propriétaire/dépôt[:quant]" : "Model name or owner/repository[:quant]",
			);
			e.key("model");
			expect(e.text()).toContain(fr ? "Recherche sur Hugging Face…" : "Searching Hugging Face…");
			await vi.waitFor(() => expect(e.text()).toContain(fr ? "1.5k téléchargements" : "1.5k downloads"));
			expect(search).toHaveBeenCalledWith("model", expect.any(AbortSignal));
			e.choose();
			await vi.waitFor(() =>
				expect(e.text()).toContain(fr ? "Accès à Hugging Face nécessaire" : "Hugging Face access required"),
			);
			expect(e.text()).toContain(
				fr ? "Une autorisation manuelle est nécessaire sur :" : "Manual approval is required at:",
			);
			expect(e.text()).toContain("https://huggingface.co/owner/model-GGUF");
			expect(e.text()).toContain("HF_TOKEN");
			expect(e.text()).toContain(fr ? "Retour" : "Back");
			e.choose();
			await vi.waitFor(() => expect(e.text()).toContain(fr ? "Choisir la quantification" : "Select quantization"));
			expect(e.text()).toContain(fr ? "Q4_K_M · 1.00 KiB · recommandé" : "Q4_K_M · 1.00 KiB · recommended");
			e.choose();
			await vi.waitFor(() =>
				expect(e.notes).toContain(
					fr ? "Modèle téléchargé : owner/model-GGUF:Q4_K_M" : "Downloaded owner/model-GGUF:Q4_K_M",
				),
			);
			expect(e.download).toHaveBeenCalledWith(
				"owner/model-GGUF:Q4_K_M",
				expect.any(Function),
				expect.any(AbortSignal),
			);
			expect(details).toHaveBeenCalledWith("owner/model-GGUF");
			await vi.waitFor(() => expect(e.text()).toContain(fr ? "Modèles llama.cpp" : "llama.cpp models"));
			e.key("\u001b");
			await done;
		},
	);

	it("L01: keeps already loaded models with the French plural choice", async () => {
		setLanguage("fr");
		const models: LlamaModelInfo[] = [
			{ id: "alpha", status: { value: "loaded" } },
			{ id: "gamma", status: { value: "loaded" } },
			{ id: "beta", status: { value: "unloaded" } },
		];
		const e = await terminal(models);
		e.load.mockImplementation(async (id) => {
			const model = models.find((entry) => entry.id === id)!;
			model.status.value = "loaded";
			return model;
		});
		const done = e.run();
		await vi.waitFor(() => expect(e.text()).toContain("Modèles llama.cpp"));
		e.choose(2);
		await vi.waitFor(() => expect(e.text()).toContain("2 modèles sont chargés"));
		e.choose(1);
		await vi.waitFor(() => expect(e.notes).toContain("Modèle chargé : beta"));
		expect(e.unload).not.toHaveBeenCalled();
		expect(models.every((entry) => entry.status.value === "loaded")).toBe(true);
		await vi.waitFor(() => expect(e.text()).toContain("Modèles llama.cpp"));
		e.key("\u001b");
		await done;
	});

	it("L03/L05: shows French empty and error states while preserving a server's catalog-key text", async () => {
		setLanguage("fr");
		const e = await terminal();
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(Response.json([]));
		const done = e.run();
		await vi.waitFor(() => expect(e.text()).toContain("Modèles llama.cpp"));
		e.choose();
		await vi.waitFor(() => expect(e.text()).toContain("Saisissez au moins 2 caractères"));
		e.key("none");
		await vi.waitFor(() => expect(e.text()).toContain("Aucun modèle GGUF trouvé"));
		fetchMock.mockResolvedValueOnce(Response.json({}));
		e.key("\u0015");
		e.key("invalid");
		await vi.waitFor(() => expect(e.text()).toContain("Hugging Face a renvoyé des résultats de recherche invalides"));
		fetchMock.mockResolvedValueOnce(Response.json({ error: "Loading model" }, { status: 403 }));
		e.key("\u0015");
		e.key("remote");
		await vi.waitFor(() => expect(e.text()).toContain("Loading model"));
		expect(e.text()).not.toContain("Chargement du modèle");
		e.key("\u001b");
		await vi.waitFor(() => expect(e.text()).toContain("Modèles llama.cpp"));
		e.key("\u001b");
		await done;
	});

	it.each(["en", "fr"] as const)(
		"L05: displays %s progress without sockets and keeps stage names and byte counts",
		async (language) => {
			setLanguage(language);
			const fr = language === "fr";
			const fetchMock = vi.mocked(fetch);
			const client = new LlamaClient("http://llama.invalid");
			const progress: LlamaProgress[] = [];
			fetchMock.mockImplementation(async (input) => {
				if (String(input).endsWith("/models/sse")) return new Response(null, { status: 404 });
				if (String(input).endsWith("/models/load")) return Response.json({ success: true });
				return Response.json({ data: [{ id: "model", status: { value: "loaded" } }] });
			});
			await client.loadAndWait("model", (entry) => progress.push(entry));
			expect(progress).toContainEqual({ message: fr ? "Chargement du modèle" : "Loading model" });
			const watch = vi.spyOn(client, "watch").mockImplementation(async (onEvent) => {
				onEvent({ model: "model", event: "model_status", data: { progress: { stage: "text_model", value: 0.5 } } });
			});
			await client.loadAndWait("model", (entry) => progress.push(entry));
			expect(progress).toContainEqual({ message: fr ? "Chargement text model" : "Loading text model", ratio: 0.5 });
			watch.mockImplementation(async (onEvent) => {
				onEvent({
					model: "model",
					event: "download_progress",
					data: { progress: { file: { done: 512, total: 1024 } } },
				});
				onEvent({ model: "model", event: "download_finished" });
			});
			await client.downloadAndWait("model", (entry) => progress.push(entry));
			expect(progress).toContainEqual({
				message: fr ? "Téléchargement du modèle" : "Downloading model",
				ratio: 0.5,
				detail: "512 B / 1.00 KiB",
			});
		},
	);

	it("L04/L05: preserves a server network message and closes using the French label", async () => {
		setLanguage("fr");
		const e = await terminal();
		e.list.mockRejectedValueOnce(new LlamaServerError("Server network timeout: HTTP 503"));
		const done = e.run();
		await vi.waitFor(() => expect(e.text()).toContain("llama.cpp indisponible"));
		expect(e.text()).toContain("Server network timeout: HTTP 503");
		expect(e.text()).not.toContain("Impossible de se connecter au serveur.");
		e.choose(1);
		await done;
	});

	it("L05: translates local errors only at display and preserves matching server messages", async () => {
		setLanguage("fr");
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
		const local = await new LlamaClient("http://llama.invalid").list().catch((error: unknown) => error);
		expect(local).toMatchObject({ message: "llama.cpp returned HTTP 503" });
		expect(llamaErrorMessage(local)).toBe("llama.cpp a renvoyé HTTP 503");
		fetchMock.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { "retry-after": "15" } }));
		const limited = await new HuggingFaceClient().search("model").catch((error: unknown) => error);
		expect(limited).toMatchObject({ message: "Hugging Face rate limit reached; retry in 15s" });
		expect(llamaErrorMessage(limited)).toBe(
			"La limite de requêtes de Hugging Face est atteinte ; réessayez dans 15s",
		);
		fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "Loading model" } }, { status: 400 }));
		const server = await new LlamaClient("http://llama.invalid").list().catch((error: unknown) => error);
		expect(llamaErrorMessage(server)).toBe("Loading model");
		fetchMock.mockResolvedValueOnce(Response.json({ error: "Download failed" }, { status: 403 }));
		const hfServer = await new HuggingFaceClient().details("owner/model").catch((error: unknown) => error);
		expect(llamaErrorMessage(hfServer)).toBe("Download failed");
	});
});

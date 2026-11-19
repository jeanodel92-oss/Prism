// fork: read-only capability detection against fake llama.cpp, Ollama, LM Studio and generic servers.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectCapabilities, templateThinking } from "../src/fork/capabilities.ts";
import { writeCompatibleServer } from "../src/fork/compatible-server.ts";

type Routes = Record<string, unknown>;

describe("fork: capability detection", () => {
	let server: Server | undefined;
	const requests: { method: string; path: string }[] = [];

	afterEach(async () => {
		requests.length = 0;
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	/** Serves `routes` as JSON ("METHOD /path" keys); anything else is a 404. Records every request. */
	async function serve(routes: Routes): Promise<string> {
		server = createServer((request: IncomingMessage, response) => {
			const path = (request.url ?? "").split("?")[0];
			requests.push({ method: request.method ?? "", path: request.url ?? "" });
			// A key with a query string answers only that exact request (llama.cpp's router).
			const body = routes[`${request.method} ${request.url}`] ?? routes[`${request.method} ${path}`];
			if (body === undefined) {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
		return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
	}

	/**
	 * Only reads: GETs, and Ollama's POST /api/show; never a model load or a generation. `?model=`
	 * (which loads the model on llama.cpp's router) only with `autoload=false`.
	 */
	function expectReadsOnly() {
		for (const { method, path } of requests) {
			if (method === "POST") expect(path).toBe("/api/show");
			else expect(method).toBe("GET");
			const rest = path.replace(/\?model=[^&]*&autoload=false$/, "");
			expect(rest).not.toMatch(/load|completions|generate|chat|embed|\?model=/);
		}
	}

	it("llama.cpp: per-slot context, slots, vision and tool calls from /props and /slots", async () => {
		const baseUrl = await serve({
			"GET /props": {
				default_generation_settings: { n_ctx: 131072 },
				total_slots: 2,
				modalities: { vision: true },
				chat_template_caps: { supports_tool_calls: true },
			},
			"GET /slots": [
				{ id: 0, n_ctx: 125000 },
				{ id: 1, n_ctx: 125000 },
			],
			"GET /v1/models": { data: [{ id: "qwen", meta: { n_ctx_train: 262144 } }] },
		});
		const detected = await detectCapabilities(baseUrl, ["qwen"]);
		expect(detected).toEqual({
			kind: "llama.cpp",
			slots: 2,
			models: [
				{
					id: "qwen",
					contextWindow: 125000,
					maxContextWindow: 262144,
					vision: "yes",
					tools: "yes",
					reasoning: "unknown",
				},
			],
		});
		expectReadsOnly();
	});

	it("llama.cpp router: props of loaded models only, never loading one", async () => {
		const baseUrl = await serve({
			"GET /props": {
				role: "router",
				max_instances: 4,
				models_autoload: true,
				model_alias: "llama-server",
				model_path: "none",
				default_generation_settings: { params: {}, n_ctx: 0 },
			},
			"GET /models": {
				data: [
					{ id: "qwen", aliases: ["qwen-alias"], status: { value: "loaded" } },
					{ id: "gemma", status: { value: "unloaded" }, architecture: { input_modalities: ["text", "image"] } },
					{ id: "sleepy", status: { value: "sleeping" } },
				],
			},
			"GET /props?model=qwen-alias&autoload=false": {
				default_generation_settings: { n_ctx: 32768, params: { n_predict: -1 } },
				total_slots: 1,
				chat_template: QWEN_TEMPLATE,
				chat_template_caps: { supports_tool_calls: true },
			},
		});
		const detected = await detectCapabilities(baseUrl, ["qwen-alias", "gemma", "sleepy"]);
		expect(detected.kind).toBe("llama.cpp");
		expect(detected.models[0]).toMatchObject({
			id: "qwen-alias",
			contextWindow: 32768,
			tools: "yes",
			reasoning: "yes",
			maxOutput: "unlimited",
		});
		expect(detected.models[0]?.thinking?.levels.off).toBe("none");
		expect(detected.models.slice(1)).toEqual([
			{ id: "gemma", vision: "yes", tools: "unknown", reasoning: "unknown" },
			{ id: "sleepy", vision: "unknown", tools: "unknown", reasoning: "unknown" },
		]);
		const asked = requests.filter((request) => request.path.includes("?model=")).map((request) => request.path);
		expect(asked).toEqual(["/props?model=qwen-alias&autoload=false"]);
		expectReadsOnly();
	});

	it("llama.cpp: template caps reading the effort or the reasoning mean a thinking model", async () => {
		for (const caps of [{ supports_reasoning_effort: true }, { supports_preserve_reasoning: true }]) {
			const baseUrl = await serve({
				"GET /props": { default_generation_settings: { n_ctx: 8192 }, total_slots: 1, chat_template_caps: caps },
			});
			const [model] = (await detectCapabilities(baseUrl, ["m"])).models;
			expect(model?.reasoning).toBe("yes");
			expect(model?.thinking).toBeUndefined();
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = undefined;
		}
	});

	it("llama.cpp without /slots or template caps: context from /props, tools unknown", async () => {
		const baseUrl = await serve({
			"GET /props": { default_generation_settings: { n_ctx: 8192 }, total_slots: 1 },
			"GET /v1/models": { data: [{ id: "m", architecture: { input_modalities: ["text"] } }] },
		});
		const [model] = (await detectCapabilities(baseUrl, ["m"])).models;
		expect(model).toMatchObject({ contextWindow: 8192, vision: "no", tools: "unknown", reasoning: "unknown" });
		expectReadsOnly();
	});

	it("Ollama: capabilities list gives yes and no; the training context is not the real one", async () => {
		const baseUrl = await serve({
			"GET /api/version": { version: "0.12.0" },
			"POST /api/show": {
				capabilities: ["completion", "tools", "thinking"],
				model_info: { "qwen3.context_length": 40960 },
				parameters: "temperature 0.6",
			},
		});
		const [model] = (await detectCapabilities(baseUrl, ["qwen3:8b"])).models;
		expect(model).toEqual({
			id: "qwen3:8b",
			contextWindow: undefined,
			maxContextWindow: 40960,
			vision: "no",
			tools: "yes",
			reasoning: "yes",
			// fork: the model's default sampling, shown next to Prism's in /model-settings.
			sampling: { temperature: 0.6 },
		});
		expectReadsOnly();
	});

	it("Ollama: num_ctx set by the model is the real context; no capabilities list means unknown", async () => {
		const baseUrl = await serve({
			"GET /api/version": { version: "0.3.0" },
			"POST /api/show": { parameters: "num_ctx 16384\nstop <|im_end|>" },
		});
		const [model] = (await detectCapabilities(baseUrl, ["old"])).models;
		expect(model).toMatchObject({ contextWindow: 16384, vision: "unknown", tools: "unknown", reasoning: "unknown" });
	});

	it("LM Studio: loaded instance context, vision, tool training and reasoning", async () => {
		const baseUrl = await serve({
			"GET /api/v1/models": {
				models: [
					{
						key: "gemma",
						max_context_length: 262144,
						loaded_instances: [{ id: "gemma", config: { context_length: 4096 } }],
						capabilities: { vision: true, trained_for_tool_use: true, reasoning: { allowed_options: ["on"] } },
					},
					{
						key: "tiny",
						max_context_length: 32768,
						loaded_instances: [],
						capabilities: { vision: false, trained_for_tool_use: false },
					},
				],
			},
		});
		const detected = await detectCapabilities(baseUrl, ["gemma", "tiny"]);
		expect(detected.kind).toBe("lmstudio");
		expect(detected.models).toEqual([
			{ id: "gemma", contextWindow: 4096, maxContextWindow: 262144, vision: "yes", tools: "yes", reasoning: "yes" },
			{
				id: "tiny",
				contextWindow: undefined,
				maxContextWindow: 32768,
				vision: "no",
				tools: "unknown",
				// fork: LM Studio omits `reasoning` when it has no setting for it: not a "no".
				reasoning: "unknown",
			},
		]);
		expectReadsOnly();
	});

	it("LM Studio: reasoning options give yes, off alone gives no", async () => {
		const baseUrl = await serve({
			"GET /api/v1/models": {
				models: [
					{ key: "hybrid", capabilities: { reasoning: { allowed_options: ["off", "on"], default: "on" } } },
					{ key: "levels", capabilities: { reasoning: { allowed_options: ["low", "medium", "high"] } } },
					{ key: "off", capabilities: { reasoning: { allowed_options: ["off"] } } },
					{ key: "empty", capabilities: { reasoning: {} } },
				],
			},
		});
		const detected = await detectCapabilities(baseUrl, ["hybrid", "levels", "off", "empty"]);
		expect(detected.models.map((model) => model.reasoning)).toEqual(["yes", "yes", "no", "unknown"]);
		expectReadsOnly();
	});

	it("Ollama: thinking values decide over the capabilities list", async () => {
		const shows: Record<string, unknown> = {
			levels: { capabilities: ["completion"], thinking: { values: ["low", "medium", "high"], default: "medium" } },
			hybrid: { capabilities: ["completion", "thinking"], thinking: { values: [false, true], default: true } },
			none: { capabilities: ["completion", "thinking"], thinking: { values: [false], default: false } },
		};
		server = createServer((request, response) => {
			requests.push({ method: request.method ?? "", path: request.url ?? "" });
			if (request.url === "/api/version") {
				response.writeHead(200, { "content-type": "application/json" }).end('{"version":"0.20.0"}');
				return;
			}
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				const name = request.url === "/api/show" ? (JSON.parse(body) as { model?: string }).model : undefined;
				const shown = name ? shows[name] : undefined;
				if (!shown) response.writeHead(404).end();
				else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(shown));
			});
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
		const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
		const detected = await detectCapabilities(baseUrl, ["levels", "hybrid", "none"]);
		expect(detected.kind).toBe("ollama");
		expect(detected.models.map((model) => model.reasoning)).toEqual(["yes", "yes", "no"]);
		expectReadsOnly();
	});

	it("a generic server: everything unknown, never absent", async () => {
		const baseUrl = await serve({ "GET /v1/models": { data: [{ id: "x" }] } });
		expect(await detectCapabilities(baseUrl, ["x"])).toEqual({
			kind: "generic",
			models: [{ id: "x", vision: "unknown", tools: "unknown", reasoning: "unknown" }],
		});
		expectReadsOnly();
	});

	// the maintainer's local Qwen accepted none, low, medium and xhigh, but /login wrote no
	// reasoning for llama.cpp, so only "off" was offered.
	const QWEN_TEMPLATE = [
		"{%- if enable_thinking is defined and enable_thinking is false %}<think></think>{%- endif %}",
		"{%- if reasoning_effort is defined %}{%- if reasoning_effort == 'none' %}{{- 'no think' }}",
		"{%- elif reasoning_effort in ['low', 'medium'] %}{{- 'some' }}{%- elif reasoning_effort == \"xhigh\" %}{{- 'max' }}",
		"{%- endif %}{%- endif %}",
	].join("\n");

	it("llama.cpp: thinking controls and accepted efforts from the chat template", async () => {
		const baseUrl = await serve({
			"GET /props": { default_generation_settings: { n_ctx: 32768 }, total_slots: 1, chat_template: QWEN_TEMPLATE },
		});
		const [model] = (await detectCapabilities(baseUrl, ["qwen"])).models;
		expect(model?.reasoning).toBe("yes");
		expect(model?.thinking).toEqual({
			kwargs: { enable_thinking: { $var: "thinking.enabled" }, reasoning_effort: { $var: "thinking.effort" } },
			levels: { off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
		});
		expectReadsOnly();
	});

	it("chat template: on/off only, effort without listed values, or nothing", () => {
		expect(templateThinking("{% if enable_thinking %}x{% endif %}")).toEqual({
			kwargs: { enable_thinking: { $var: "thinking.enabled" } },
			levels: { minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
		});
		expect(templateThinking("{{ reasoning_effort }}")).toBeUndefined();
		expect(templateThinking("{% if reasoning_effort == 'high' %}x{% endif %}")?.levels.off).toBeNull();
		expect(templateThinking("{{ messages }}")).toBeUndefined();
		expect(templateThinking(undefined)).toBeUndefined();
	});

	it("/login writes the template's thinking levels to models.json", async () => {
		const baseUrl = await serve({
			"GET /props": { default_generation_settings: { n_ctx: 32768 }, total_slots: 1, chat_template: QWEN_TEMPLATE },
		});
		const detected = await detectCapabilities(baseUrl, ["qwen"]);
		const dir = mkdtempSync(join(tmpdir(), "prism-capabilities-"));
		try {
			const modelsPath = join(dir, "models.json");
			await writeCompatibleServer(
				modelsPath,
				{ providerId: "local", baseUrl, models: ["qwen"], detected },
				"openai-completions",
				false,
			);
			const [model] = JSON.parse(readFileSync(modelsPath, "utf-8")).providers.local.models;
			expect(model).toMatchObject({
				reasoning: true,
				thinkingLevelMap: { off: "none", low: "low", medium: "medium", xhigh: "xhigh", high: null },
				compat: {
					thinkingFormat: "chat-template",
					chatTemplateKwargs: {
						enable_thinking: { $var: "thinking.enabled" },
						reasoning_effort: { $var: "thinking.effort" },
					},
				},
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("/login writes what the server said to models.json; unknown stays available", async () => {
		const baseUrl = await serve({
			"GET /props": { default_generation_settings: { n_ctx: 65536 }, total_slots: 2, modalities: { vision: true } },
		});
		const detected = await detectCapabilities(baseUrl, ["vlm", "other"]);
		const dir = mkdtempSync(join(tmpdir(), "prism-capabilities-"));
		try {
			const modelsPath = join(dir, "models.json");
			await writeCompatibleServer(
				modelsPath,
				{ providerId: "local", baseUrl, models: ["vlm"], detected },
				"openai-completions",
				false,
			);
			expect(JSON.parse(readFileSync(modelsPath, "utf-8")).providers.local.models).toEqual([
				// Thinking is unknown (no template): left available, not turned off.
				// fork: no output limit from the server: the context, clamped per request.
				{ id: "vlm", contextWindow: 65536, maxTokens: 65536, input: ["text", "image"], reasoning: true },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

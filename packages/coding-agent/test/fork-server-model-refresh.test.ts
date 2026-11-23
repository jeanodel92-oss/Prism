// fork: a server added to models.json changed models (Qwen 3.8 27B to Hy4 Flash) and
// Prism kept the old one. Its list is now read again at start and when the server says the model does not exist,
// against a fake OpenAI-compatible server here; throwaway agent dir and HOME, never the real config.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { capabilitiesPath, recordDetection } from "../src/fork/capability-store.ts";
import { writeCompatibleServer } from "../src/fork/compatible-server.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import {
	describeServerChange,
	isModelNotFoundError,
	type RefreshState,
	serverModelRefresh,
} from "../src/fork/server-model-refresh.ts";

const KEY = "test-key-server-refresh-5d1e";
const OLD = "qwen3.8-27b-fp8";
const NEW = "hy4-flash";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

describe("fork: a server's model list read again by itself", () => {
	let tempDir = "";
	let agentDir = "";
	let modelsPath = "";
	let server: Server | undefined;
	let url = "";
	/** What GET /v1/models answers: a list, an HTTP error, or nothing at all. */
	let listing: string[] | number | "hang" = [NEW];
	let listRequests = 0;
	/** What GET /props answers (a llama.cpp server such as Maya), or a 404 when undefined. */
	let props: Record<string, unknown> | undefined;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prism-server-refresh-"));
		agentDir = join(tempDir, "agent");
		modelsPath = join(agentDir, "models.json");
		mkdirSync(agentDir);
		vi.stubEnv("HOME", tempDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("PI_OFFLINE", undefined);
		listing = [NEW];
		listRequests = 0;
		props = undefined;
		server = createServer((request, response) => {
			if (request.headers.authorization !== `Bearer ${KEY}`) {
				response.writeHead(401).end();
				return;
			}
			if (request.method === "GET" && request.url === "/v1/models") {
				listRequests++;
				if (listing === "hang") return;
				if (typeof listing === "number") {
					response.writeHead(listing).end();
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ object: "list", data: listing.map((id) => ({ id, object: "model" })) }));
				return;
			}
			if (request.method === "GET" && request.url === "/props" && props) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(props));
				return;
			}
			if (request.method === "POST" && request.url === "/v1/chat/completions") {
				// vLLM's answer for a model it does not serve.
				response.writeHead(404, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						object: "error",
						message: `The model \`${OLD}\` does not exist.`,
						type: "NotFoundError",
						code: 404,
					}),
				);
				return;
			}
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
		url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
	});

	afterEach(async () => {
		setLanguage("en");
		server?.closeAllConnections();
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * The server as `/login` adds it (models.json, what it detected in capabilities.json, its key in auth.json);
	 * `byHand` leaves out the detection, as for a provider written in models.json by hand. Returns a registry.
	 */
	async function addServer(baseUrl = url, byHand = false): Promise<ModelRegistry> {
		await writeCompatibleServer(
			modelsPath,
			{ providerId: "localai", baseUrl, models: [OLD] },
			"openai-completions",
			true,
		);
		if (!byHand) {
			await recordDetection(capabilitiesPath(agentDir), "localai", [
				{ id: OLD, vision: "unknown", tools: "unknown", reasoning: "unknown" },
			]);
		}
		return engine(true);
	}

	/** One engine's registry over the same models.json and auth.json. */
	async function engine(login = false): Promise<ModelRegistry> {
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath,
			allowModelNetwork: false,
		});
		if (login) {
			await runtime.login("localai", "api_key", { prompt: async () => KEY, notify: () => {} });
		}
		return new ModelRegistry(runtime);
	}

	/** Loads the extension against a fake pi with its own process state. */
	function load(registry: ModelRegistry, options: { hasUI?: boolean; timeoutMs?: number } = {}) {
		const handlers = new Map<string, Handler>();
		const state: RefreshState = { inFlight: new Map() };
		const notes: { text: string; type: string | undefined }[] = [];
		const scoped: string[] = [];
		const selected: Model<any>[] = [];
		serverModelRefresh(
			state,
			options.timeoutMs,
		)({
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			setModel: async (model: Model<any>) => {
				selected.push(model);
				return true;
			},
		} as unknown as ExtensionAPI);
		const ctx = {
			hasUI: options.hasUI ?? true,
			ui: { notify: (text: string, type?: string) => notes.push({ text, type }) },
			modelRegistry: registry,
			model: registry.find("localai", OLD),
			addToScope: (models: readonly { provider: string; id: string }[]) =>
				scoped.push(...models.map((model) => `${model.provider}/${model.id}`)),
		} as unknown as ExtensionContext;
		const fire = (event: string, payload: Record<string, unknown> = {}) =>
			handlers.get(event)!({ type: event, ...payload }, ctx);
		const settled = () => Promise.all([state.startup, ...state.inFlight.values()]);
		return { state, notes, scoped, selected, fire, settled };
	}

	const listedModels = () =>
		(JSON.parse(readFileSync(modelsPath, "utf-8")).providers.localai.models as { id: string }[]).map(
			(model) => model.id,
		);

	it("at start, adds the new model, removes the old one, reloads the list and says it once", async () => {
		const registry = await addServer();
		const { notes, scoped, fire, settled, state } = load(registry);
		// The handler returns before the server answers: the start does not wait.
		expect(fire("session_start", { reason: "startup" })).toBeUndefined();
		expect(state.startup).toBeDefined();
		await settled();

		expect(listedModels()).toEqual([NEW]);
		expect(registry.find("localai", NEW)).toBeDefined();
		expect(registry.find("localai", OLD)).toBeUndefined();
		// maintainer's QA, 2026-11-22: the new model joins a narrowed scope (/scoped-models), not only the list.
		expect(scoped).toEqual([`localai/${NEW}`]);
		expect(notes).toEqual([
			{
				text: `localai: added ${NEW}; removed ${OLD}. ${OLD}, the current model, is no longer on the server: choose another with /model.`,
				type: "warning",
			},
		]);

		// A new session in the same process is not a new start.
		fire("session_start", { reason: "new" });
		await settled();
		expect(listRequests).toBe(1);
		expect(notes).toHaveLength(1);
	});

	// maintainer's QA of fork.12.2, 2026-11-23: Maya, updated to accept GLM 5.3's thinking levels, kept serving the same
	// model, and Prism kept the levels it read when the server was added.
	it("at start, gives a model the server still serves what it says about it now, and the session takes it", async () => {
		listing = [OLD];
		const registry = await addServer();
		props = {
			default_generation_settings: { n_ctx: 32768 },
			total_slots: 1,
			ablate: { available: false },
			chat_template: "{%- set effort = reasoning_effort if reasoning_effort in ['low', 'high'] else 'max' -%}",
		};
		const { notes, selected, fire, settled } = load(registry);
		fire("session_start", { reason: "startup" });
		await settled();

		const entry = JSON.parse(readFileSync(modelsPath, "utf-8")).providers.localai.models[0];
		expect(entry).toMatchObject({
			id: OLD,
			contextWindow: 32768,
			reasoning: true,
			thinkingLevelMap: { low: "low", high: "high" },
			compat: { thinkingFormat: "chat-template" },
		});
		expect(registry.find("localai", OLD)?.thinkingLevelMap).toMatchObject({ low: "low", high: "high" });
		expect(selected.map((model) => model.thinkingLevelMap)).toEqual([entry.thinkingLevelMap]);
		expect(notes).toEqual([
			{
				text: `localai: ${OLD} updated from the server (thinking levels, context, images).`,
				type: "info",
			},
		]);

		// The next start reads the same: nothing to say. A server that no longer says anything about the model
		// (a llama.cpp router that has not loaded it) leaves the levels as they are.
		for (const answer of [props, undefined]) {
			props = answer;
			const before = readFileSync(modelsPath, "utf-8");
			const again = load(await engine());
			again.fire("session_start", { reason: "startup" });
			await again.settled();
			expect(readFileSync(modelsPath, "utf-8")).toBe(before);
			expect(again.notes).toEqual([]);
		}
	});

	it("two engines starting together write the change once and only one of them announces it", async () => {
		const first = load(await addServer());
		const second = load(await engine());
		first.fire("session_start", { reason: "startup" });
		second.fire("session_start", { reason: "startup" });
		await Promise.all([first.settled(), second.settled()]);

		expect(listedModels()).toEqual([NEW]);
		expect(first.notes.length + second.notes.length).toBe(1);
		// Each engine's session takes the new model in, whichever wrote it.
		expect(first.scoped).toEqual([`localai/${NEW}`]);
		expect(second.scoped).toEqual([`localai/${NEW}`]);
	});

	it("a server that is down, refuses or never answers changes nothing and says nothing", async () => {
		for (const answer of [500, "hang"] as const) {
			const registry = await addServer();
			const before = readFileSync(modelsPath, "utf-8");
			listing = answer;
			const { notes, fire, settled } = load(registry, { timeoutMs: 300 });
			fire("session_start", { reason: "startup" });
			await settled();
			expect(readFileSync(modelsPath, "utf-8")).toBe(before);
			expect(notes).toEqual([]);
		}

		// Nothing listens at that address any more.
		server?.closeAllConnections();
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		const registry = await addServer();
		server = undefined;
		const before = readFileSync(modelsPath, "utf-8");
		const { notes, fire, settled } = load(registry);
		fire("session_start", { reason: "startup" });
		await settled();
		expect(readFileSync(modelsPath, "utf-8")).toBe(before);
		expect(notes).toEqual([]);
	});

	it("the offline switch keeps the start from reading the list", async () => {
		const registry = await addServer();
		vi.stubEnv("PI_OFFLINE", "1");
		const { notes, fire, settled } = load(registry);
		fire("session_start", { reason: "startup" });
		await settled();
		expect(listRequests).toBe(0);
		expect(listedModels()).toEqual([OLD]);
		expect(notes).toEqual([]);
	});

	// a provider written by hand keeps the models the user chose.
	it("leaves a provider written by hand in models.json alone", async () => {
		const registry = await addServer(url, true);
		const { notes, fire, settled } = load(registry);
		fire("session_start", { reason: "startup" });
		await settled();
		expect(listRequests).toBe(0);
		expect(listedModels()).toEqual([OLD]);
		expect(notes).toEqual([]);
	});

	it("without an interface (print mode) nothing is read", async () => {
		const registry = await addServer();
		const { fire, settled } = load(registry, { hasUI: false });
		fire("session_start", { reason: "startup" });
		await settled();
		expect(listRequests).toBe(0);
	});

	it("reads the list again when the server says the requested model does not exist", async () => {
		const registry = await addServer();
		const model = registry.find("localai", OLD)!;
		const stream = registry.streamSimple(model, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});
		for await (const _event of stream) {
			// drained
		}
		const failed = await stream.result();
		expect(failed.stopReason).toBe("error");
		expect(isModelNotFoundError(failed.errorMessage)).toBe(true);

		const { notes, fire, settled } = load(registry);
		vi.stubEnv("PI_OFFLINE", "1");
		fire("session_start", { reason: "startup" });
		await settled();
		expect(listRequests).toBe(0);

		// Another failure is not about the model: the list is not read.
		fire("message_end", { message: { ...failed, errorMessage: "500 Internal Server Error" } });
		await settled();
		expect(listRequests).toBe(0);

		// The request just reached the server, so the offline switch does not stop this reading.
		fire("message_end", { message: failed });
		await settled();
		expect(listRequests).toBe(1);
		expect(listedModels()).toEqual([NEW]);
		expect(registry.find("localai", NEW)).toBeDefined();
		expect(notes.map((note) => note.text)).toEqual([
			`localai: added ${NEW}; removed ${OLD}. ${OLD}, the current model, is no longer on the server: choose another with /model.`,
		]);
	});

	it("recognises the usual wordings of a missing model, and not other failures", () => {
		for (const text of [
			"404 The model `qwen` does not exist.",
			'404: {"object":"error","message":"The model `qwen` does not exist."}',
			"404 \"model 'qwen' not found, try pulling it first\"",
			"400 model not found",
			"400 model_not_found",
			"500 could not load model - all backends returned error",
		]) {
			expect(isModelNotFoundError(text), text).toBe(true);
		}
		for (const text of [undefined, "", "500 Internal Server Error", "401 Unauthorized", "Connection error."]) {
			expect(isModelNotFoundError(text), String(text)).toBe(false);
		}
	});

	it("names the models updated from the server, with or without a list change, in French too", () => {
		expect(describeServerChange({ providerId: "localai", added: [NEW], removed: [], updated: [OLD] })).toBe(
			`localai: added ${NEW}. ${OLD} updated from the server (thinking levels, context, images).`,
		);
		setLanguage("fr");
		expect(describeServerChange({ providerId: "localai", added: [], removed: [], updated: [OLD] })).toBe(
			`localai : ${OLD} mis à jour depuis le serveur (niveaux de raisonnement, contexte, images).`,
		);
	});

	it("names the default model too, in English and in French", () => {
		const change = { providerId: "localai", added: [], removed: [OLD] };
		expect(describeServerChange(change, { default: OLD })).toBe(
			`localai: removed ${OLD}. ${OLD}, the default model, is no longer on the server.`,
		);
		setLanguage("fr");
		expect(
			describeServerChange({ providerId: "localai", added: [NEW], removed: [OLD] }, { current: OLD, default: OLD }),
		).toBe(
			`localai : ajouté ${NEW} ; retiré ${OLD}. ${OLD}, le modèle en cours et par défaut, n’est plus sur le serveur : choisissez-en un autre avec /model.`,
		);
	});
});

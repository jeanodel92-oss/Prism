/**
 * fork: `/login` entry that adds a server speaking a supported API (OpenAI chat
 * completions or responses) from its URL, without editing a file.
 *
 * The provider and its models go to models.json, without the key. The key, if any,
 * is stored by the existing API-key login, so it lands in auth.json (0600), which
 * takes precedence over models.json. A server without a key gets `"apiKey": "none"`
 * in models.json, a placeholder that keeps its models available.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../core/model-runtime.ts";
import {
	type DetectedModel,
	type DetectedServer,
	describeCapabilities,
	detectCapabilities,
	SERVER_INFO_MAX_BYTES,
} from "./capabilities.ts";
import { capabilitiesPath, recordDetection } from "./capability-store.ts";
import { lockForkFile } from "./file-lock.ts";
import { BodyTooLarge, readLimitedJson } from "./http-body-limit.ts";
import { fill, t } from "./i18n/index.ts";
import { writeFileAtomicSync } from "./secrets/atomic-write.ts";

export const COMPATIBLE_SERVER_APIS = [
	{ id: "openai-completions", label: "OpenAI chat completions (llama.cpp, vLLM, LM Studio, Ollama...)" },
	{ id: "openai-responses", label: "OpenAI responses" },
] as const;

const NO_KEY = "none";
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface CompatibleServer {
	providerId: string;
	baseUrl: string;
	models: string[];
	/** fork: what the server confirmed about each model. */
	detected?: DetectedServer;
	/**
	 * Set by `connectCompatibleServer` when the server was already in models.json: the models it lists now and did
	 * not before, which `enabledModels` must then take in (login-models.ts).
	 */
	added?: string[];
}

/**
 * models.json fields for what the server said. fork: an unknown capability stays
 * available (images, thinking); only one the server says is absent is turned off. capability-gates.ts
 * names an unknown one as a possible cause when the server refuses a request that used it.
 */
function detectedModelFields(server: CompatibleServer, id: string): Record<string, unknown> {
	const model = server.detected?.models.find((candidate) => candidate.id === id);
	if (!model) return {};
	// fork: without maxTokens pi sends 16384, which cut a long reasoning short. The
	// server's own limit when it has one; otherwise the context, which each request clamps to the
	// room left in it.
	const maxTokens = typeof model.maxOutput === "number" ? model.maxOutput : model.contextWindow;
	return {
		...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
		...(model.vision !== "no" ? { input: ["text", "image"] } : {}),
		...(model.reasoning !== "no" ? { reasoning: true } : {}),
		// fork: the levels the chat template accepts, sent as chat_template_kwargs.
		...(model.thinking
			? {
					thinkingLevelMap: model.thinking.levels,
					compat: { thinkingFormat: "chat-template", chatTemplateKwargs: model.thinking.kwargs },
				}
			: {}),
	};
}

/**
 * Whether detection heard from the server about this model. A llama.cpp router does not ask a model it has not
 * loaded, and a server Prism cannot read answers nothing: those stay as detected before.
 */
function serverAnswered(model: DetectedModel): boolean {
	return (
		model.contextWindow !== undefined ||
		model.thinking !== undefined ||
		model.tools !== "unknown" ||
		model.reasoning !== "unknown"
	);
}

/**
 * fork: a model Prism already lists, with what the server says about it now;
 * undefined when that changes nothing. Maya, updated to accept GLM 5.3's thinking levels, kept the levels Prism read
 * when the server was added. Only the fields detection writes change; the user's corrections live in
 * `modelOverrides` and stay. A size the server no longer reports keeps the last one.
 */
function redetectedEntry(
	entry: Record<string, unknown>,
	server: CompatibleServer,
	id: string,
): Record<string, unknown> | undefined {
	const model = server.detected?.models.find((candidate) => candidate.id === id);
	if (!model || !serverAnswered(model)) return undefined;
	const fresh = detectedModelFields(server, id);
	const { input: _input, reasoning: _reasoning, thinkingLevelMap: _levels, ...next } = entry;
	for (const key of ["contextWindow", "maxTokens", "input", "reasoning", "thinkingLevelMap"] as const) {
		if (fresh[key] !== undefined) next[key] = fresh[key];
	}
	const previous = entry.compat && typeof entry.compat === "object" ? (entry.compat as Record<string, unknown>) : {};
	const { thinkingFormat, chatTemplateKwargs, ...compat } = previous;
	if (thinkingFormat !== "chat-template") Object.assign(compat, { thinkingFormat, chatTemplateKwargs });
	Object.assign(compat, fresh.compat as Record<string, unknown> | undefined);
	for (const key of Object.keys(compat)) if (compat[key] === undefined) delete compat[key];
	if (Object.keys(compat).length > 0) next.compat = compat;
	else delete next.compat;
	return isDeepStrictEqual(next, entry) ? undefined : next;
}

/** Lists the server's models. Tries `<url>/models`, then `<url>/v1/models` when the URL has no path. */
export async function listCompatibleServerModels(
	url: string,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<{ baseUrl: string; models: string[] }> {
	const parsed = new URL(url.trim());
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Use a server address starting with http:// or https://. Received: ${parsed.protocol}`);
	}
	const base = parsed.href.replace(/\/+$/, "");
	const candidates = parsed.pathname.replace(/\/+$/, "") === "" ? [`${base}/v1`, base] : [base];
	let lastError: Error | undefined;
	for (const baseUrl of candidates) {
		const response = await fetch(`${baseUrl}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal,
		});
		if (!response.ok) {
			lastError = new Error(
				`Could not list models: the server returned HTTP ${response.status} for GET ${baseUrl}/models.`,
			);
			continue;
		}
		// any JSON may come back; a list of the wrong shape is "no model names", not a TypeError.
		// The list is read up to a limit: a server that answers without end is refused.
		const body: unknown = await readLimitedJson(response, SERVER_INFO_MAX_BYTES).catch((error: unknown) => {
			if (error instanceof BodyTooLarge)
				throw new Error(`The model list at ${baseUrl}/models is larger than ${SERVER_INFO_MAX_BYTES} bytes.`);
			return undefined;
		});
		const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
		const models = (Array.isArray(data) ? data : [])
			.map((entry: unknown) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
			.filter((id): id is string => typeof id === "string");
		if (models.length === 0)
			throw new Error(
				`The server returned no model names at ${baseUrl}/models. Check that its model list is available.`,
			);
		return { baseUrl, models };
	}
	throw lastError ?? new Error(`No model list at ${url}`);
}

/** Default provider id for a server URL: host and port, e.g. `127.0.0.1-8080`. */
export function defaultCompatibleServerId(baseUrl: string): string {
	const url = new URL(baseUrl);
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	return `${url.hostname}-${port}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

/**
 * Adds or updates the provider in models.json. Other providers and the other fields of
 * this provider are kept; a file that is not plain JSON (comments) is left untouched.
 */
export async function writeCompatibleServer(
	modelsPath: string,
	server: CompatibleServer,
	api: string,
	hasKey: boolean,
): Promise<void> {
	return lockForkFile(modelsPath, () => {
		let config: { providers: Record<string, Record<string, unknown>> } = { providers: {} };
		if (existsSync(modelsPath)) {
			try {
				config = JSON.parse(readFileSync(modelsPath, "utf-8"));
			} catch {
				throw new Error(
					`Could not update ${modelsPath}: it must contain valid JSON (a structured settings format, without comments). Check the file, then retry, or add "${server.providerId}" manually.`,
				);
			}
			config.providers ??= {};
		}
		const previous = config.providers[server.providerId] ?? {};
		const { apiKey: previousKey, ...rest } = previous;
		config.providers[server.providerId] = {
			...rest,
			baseUrl: server.baseUrl,
			api,
			// A key, when given, lives in auth.json only.
			...(hasKey ? {} : { apiKey: previousKey ?? NO_KEY }),
			models: server.models.map((id) => ({ id, ...detectedModelFields(server, id) })),
		};
		// fork: synced, and refused once the lock may be another writer's.
		writeFileAtomicSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
	});
}

/** What reading a server again changed: models added, removed, and kept ones whose detected fields changed. */
export interface ServerSync {
	added: string[];
	removed: string[];
	updated: string[];
}

/**
 * reads a server's model list again. A model it no longer serves leaves
 * models.json with its corrections; a new one is added with what the server says about it. Without this, a server
 * that changed models kept the old one listed and missed the new one. fork: the models it
 * still serves get what it says about them now (`redetectedEntry`).
 */
export async function syncCompatibleServer(
	modelsPath: string,
	providerId: string,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<ServerSync> {
	const entry = JSON.parse(readFileSync(modelsPath, "utf-8")).providers?.[providerId] as
		| { baseUrl?: unknown; models?: unknown }
		| undefined;
	if (typeof entry?.baseUrl !== "string" || !Array.isArray(entry.models)) {
		throw new Error(fill("{0} is not a server added to models.json.", providerId));
	}
	const baseUrl = entry.baseUrl;
	const { models } = await listCompatibleServerModels(baseUrl, apiKey, signal);
	const detected = await detectCapabilities(baseUrl, models, apiKey, signal);
	const server: CompatibleServer = { providerId, baseUrl, models, detected };
	const { added, removed, updated } = await lockForkFile(modelsPath, (): ServerSync => {
		const config = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
			providers: Record<string, Record<string, unknown>>;
		};
		const provider = config.providers[providerId];
		const unchanged: ServerSync = { added: [], removed: [], updated: [] };
		if (!provider || !Array.isArray(provider.models) || provider.baseUrl !== baseUrl) return unchanged;
		// fork: the difference is taken again under the lock, from the file as it is now. Two engines of
		// the desktop window that read the list at once would otherwise both add the new models (listed twice) and
		// both announce the change.
		const current = provider.models.flatMap((model: unknown) => {
			const id = model && typeof model === "object" ? (model as { id?: unknown }).id : undefined;
			return typeof id === "string" ? [id] : [];
		});
		const added = models.filter((id) => !current.includes(id));
		const removed = current.filter((id) => !models.includes(id));
		const updated: string[] = [];
		const kept = provider.models
			.filter((model: { id?: unknown }) => !removed.includes(String(model?.id)))
			.map((model: unknown) => {
				const entry = model && typeof model === "object" ? (model as Record<string, unknown>) : undefined;
				if (typeof entry?.id !== "string") return model;
				const next = redetectedEntry(entry, server, entry.id);
				if (!next) return model;
				updated.push(entry.id);
				return next;
			});
		if (added.length === 0 && removed.length === 0 && updated.length === 0) return unchanged;
		provider.models = [...kept, ...added.map((id) => ({ id, ...detectedModelFields(server, id) }))];
		const overrides = provider.modelOverrides as Record<string, unknown> | undefined;
		if (overrides) {
			for (const id of removed) delete overrides[id];
			if (Object.keys(overrides).length === 0) delete provider.modelOverrides;
		}
		// fork: synced, and refused once the lock may be another writer's.
		writeFileAtomicSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
		return { added, removed, updated };
	});
	const recorded = detected.models.filter((model) => added.includes(model.id) || updated.includes(model.id));
	if (recorded.length > 0) await recordDetection(capabilitiesPath(dirname(modelsPath)), providerId, recorded);
	return { added, removed, updated };
}

/** The whole flow: API, URL, optional key, model list, name; then models.json and auth.json. */
export async function connectCompatibleServer(
	runtime: ModelRuntime,
	modelsPath: string,
	interaction: AuthInteraction,
): Promise<CompatibleServer> {
	const signal = interaction.signal;
	const api = await interaction.prompt({
		type: "select",
		message: t("Which API format does your server support? (API: the format used to exchange requests and replies)"),
		options: COMPATIBLE_SERVER_APIS,
	});
	const url = await interaction.prompt({
		type: "text",
		message: t("Server URL"),
		placeholder: "http://host:port/v1",
	});
	const apiKey = (
		await interaction.prompt({
			type: "secret",
			message: t("API key (the server's access key; leave empty if it does not require one)"),
		})
	).trim();
	interaction.notify({ type: "progress", message: t("Listing the server's models...") });
	const { baseUrl, models } = await listCompatibleServerModels(url, apiKey || undefined, signal);

	// fork: `/login` again with a server already added proposed its host and port
	// as the name, so Enter added the same server a second time, its models listed twice. Its own name is proposed
	// instead, and Enter updates it.
	const known = providerIdForBaseUrl(modelsPath, baseUrl);
	const suggested = known ?? defaultCompatibleServerId(baseUrl);
	const entered = (
		await interaction.prompt({
			type: "text",
			message: known
				? fill("This server is already added as {0}: Enter updates it, or type another name", known)
				: fill("Name for this server (default {0})", suggested),
		})
	).trim();
	const providerId = entered || suggested;
	if (!PROVIDER_ID_PATTERN.test(providerId)) {
		throw new Error(`Invalid name "${providerId}": use lowercase letters, digits, ".", "_" or "-".`);
	}
	const existing = runtime.getProvider(providerId);
	if (existing && !readModelsJsonProviderIds(modelsPath).includes(providerId)) {
		throw new Error(`"${providerId}" is already a provider; choose another name.`);
	}

	interaction.notify({ type: "progress", message: t("Reading what the server says about its models...") });
	const detected = await detectCapabilities(baseUrl, models, apiKey || undefined, signal);
	for (const line of describeCapabilities(detected)) interaction.notify({ type: "progress", message: line });
	const listedBefore = readModelsJsonModelIds(modelsPath, providerId);
	const server: CompatibleServer = {
		providerId,
		baseUrl,
		models,
		detected,
		...(listedBefore ? { added: models.filter((id) => !listedBefore.includes(id)) } : {}),
	};
	await writeCompatibleServer(modelsPath, server, api, apiKey !== "");
	// fork: keep "absent" and "unknown" apart for capability-gates.ts.
	await recordDetection(capabilitiesPath(dirname(modelsPath)), providerId, detected.models);
	await runtime.refresh({ providers: [providerId], allowNetwork: false, signal });
	if (apiKey) {
		await runtime.login(providerId, "api_key", { signal, prompt: async () => apiKey, notify: () => {} });
	}
	return server;
}

/** The model IDs models.json lists for `providerId`, or `undefined` when it does not list that provider. */
function readModelsJsonModelIds(modelsPath: string, providerId: string): string[] | undefined {
	if (!existsSync(modelsPath)) return undefined;
	try {
		const models = JSON.parse(readFileSync(modelsPath, "utf-8")).providers?.[providerId]?.models;
		if (!Array.isArray(models)) return undefined;
		return models.flatMap((model: unknown) => {
			const id = model && typeof model === "object" ? (model as { id?: unknown }).id : undefined;
			return typeof id === "string" ? [id] : [];
		});
	} catch {
		return undefined;
	}
}

/** The provider of models.json already at `baseUrl` (trailing slashes aside), if any. */
function providerIdForBaseUrl(modelsPath: string, baseUrl: string): string | undefined {
	if (!existsSync(modelsPath)) return undefined;
	const normalize = (url: string) => url.trim().replace(/\/+$/, "");
	try {
		const providers = JSON.parse(readFileSync(modelsPath, "utf-8")).providers ?? {};
		return Object.keys(providers).find((id) => {
			const url = providers[id]?.baseUrl;
			return typeof url === "string" && normalize(url) === normalize(baseUrl);
		});
	} catch {
		return undefined;
	}
}

function readModelsJsonProviderIds(modelsPath: string): string[] {
	if (!existsSync(modelsPath)) return [];
	try {
		return Object.keys(JSON.parse(readFileSync(modelsPath, "utf-8")).providers ?? {});
	} catch {
		return [];
	}
}

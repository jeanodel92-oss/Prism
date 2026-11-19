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
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../core/model-runtime.ts";
import {
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

/**
 * reads a server's model list again. A model it no longer serves leaves
 * models.json with its corrections; a new one is added with what the server says about it; the others keep their
 * entries. Without this, a server that changed models kept the old one listed and missed the new one.
 */
export async function syncCompatibleServer(
	modelsPath: string,
	providerId: string,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<{ added: string[]; removed: string[] }> {
	const entry = JSON.parse(readFileSync(modelsPath, "utf-8")).providers?.[providerId] as
		| { baseUrl?: unknown; models?: unknown }
		| undefined;
	if (typeof entry?.baseUrl !== "string" || !Array.isArray(entry.models)) {
		throw new Error(fill("{0} is not a server added to models.json.", providerId));
	}
	const baseUrl = entry.baseUrl;
	const listed = entry.models.flatMap((model: unknown) => {
		const id = model && typeof model === "object" ? (model as { id?: unknown }).id : undefined;
		return typeof id === "string" ? [id] : [];
	});
	const { models } = await listCompatibleServerModels(baseUrl, apiKey, signal);
	const added = models.filter((id) => !listed.includes(id));
	const removed = listed.filter((id) => !models.includes(id));
	if (added.length === 0 && removed.length === 0) return { added, removed };
	const detected = added.length > 0 ? await detectCapabilities(baseUrl, added, apiKey, signal) : undefined;
	const server: CompatibleServer = { providerId, baseUrl, models: added, detected };
	await lockForkFile(modelsPath, () => {
		const config = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
			providers: Record<string, Record<string, unknown>>;
		};
		const provider = config.providers[providerId];
		if (!provider || !Array.isArray(provider.models)) return;
		provider.models = [
			...provider.models.filter((model: { id?: unknown }) => !removed.includes(String(model?.id))),
			...added.map((id) => ({ id, ...detectedModelFields(server, id) })),
		];
		const overrides = provider.modelOverrides as Record<string, unknown> | undefined;
		if (overrides) {
			for (const id of removed) delete overrides[id];
			if (Object.keys(overrides).length === 0) delete provider.modelOverrides;
		}
		// fork: synced, and refused once the lock may be another writer's.
		writeFileAtomicSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
	});
	if (detected) await recordDetection(capabilitiesPath(dirname(modelsPath)), providerId, detected.models);
	return { added, removed };
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

	const suggested = defaultCompatibleServerId(baseUrl);
	const entered = (
		await interaction.prompt({ type: "text", message: fill("Name for this server (default {0})", suggested) })
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
	const server = { providerId, baseUrl, models, detected };
	await writeCompatibleServer(modelsPath, server, api, apiKey !== "");
	// fork: keep "absent" and "unknown" apart for capability-gates.ts.
	await recordDetection(capabilitiesPath(dirname(modelsPath)), providerId, detected.models);
	await runtime.refresh({ providers: [providerId], allowNetwork: false, signal });
	if (apiKey) {
		await runtime.login(providerId, "api_key", { signal, prompt: async () => apiKey, notify: () => {} });
	}
	return server;
}

function readModelsJsonProviderIds(modelsPath: string): string[] {
	if (!existsSync(modelsPath)) return [];
	try {
		return Object.keys(JSON.parse(readFileSync(modelsPath, "utf-8")).providers ?? {});
	} catch {
		return [];
	}
}

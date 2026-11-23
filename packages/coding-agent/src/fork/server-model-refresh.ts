/**
 * fork: the model list of each server the user added is read again by itself.
 *
 * A server added through `/login` (models.json) changed models, Qwen 3.8 27B to Hy4 Flash: Prism kept the old model
 * and never offered the new one, because only the manual action of fork.10.2 (« Update the model list of the
 * server », `syncCompatibleServer`) read `/models` again. Now the same reading runs:
 * - once per process at start, in the background, for every server Prism added (unless PI_OFFLINE is set);
 * - when a request to such a server fails because the server says the model does not exist.
 * The models it still serves get what it says about them now
 * , and the session's model takes them at once.
 * A change is announced once, e.g. `localai: added hy4-flash; removed qwen3.8-27b-fp8.`; a server that does not
 * answer, answers with an error or takes too long changes nothing and says nothing. A new model joins the session's
 * scope and `enabledModels` when `/scoped-models` narrows them: otherwise it stayed out.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getModelsPath } from "../config.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../core/extensions/types.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import { capabilitiesPath, readAllCapabilities } from "./capability-store.ts";
import { syncCompatibleServer } from "./compatible-server.ts";
import { readGlobalSetting } from "./global-settings.ts";
import { fill } from "./i18n/index.ts";

/** How long one server's reading may take (its list, then what it says about new models). */
export const SERVER_REFRESH_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

/**
 * The servers Prism added: providers of models.json that `syncCompatibleServer` accepts (a `baseUrl` and a `models`
 * list) and whose models Prism detected when adding them (capabilities.json, written by `/login` › compatible server
 * and by « Update the model list of the server »). A provider written by hand keeps the models the user chose
 * a gateway with hundreds of models would otherwise get them all at each start.
 */
export function addedServers(modelsPath: string): Map<string, string[]> {
	const servers = new Map<string, string[]>();
	if (!existsSync(modelsPath)) return servers;
	const detected = new Set(
		Object.keys(readAllCapabilities(capabilitiesPath(dirname(modelsPath)))).map((key) => key.split("/")[0]),
	);
	let providers: Json | undefined;
	try {
		providers = record(record(JSON.parse(readFileSync(modelsPath, "utf-8")))?.providers);
	} catch {
		return servers;
	}
	for (const [id, value] of Object.entries(providers ?? {})) {
		const provider = record(value);
		if (typeof provider?.baseUrl !== "string" || !Array.isArray(provider.models) || !detected.has(id)) continue;
		const ids = provider.models.flatMap((model) => {
			const modelId = record(model)?.id;
			return typeof modelId === "string" ? [modelId] : [];
		});
		servers.set(id, ids);
	}
	return servers;
}

/**
 * Whether a failed request's error says the model does not exist on the server. The openai SDK starts its message
 * with the HTTP status (`404 The model ... does not exist`, `404: {...}`); servers word the rest their own way
 * (vLLM "does not exist", Ollama and llama.cpp "model ... not found", OpenAI `model_not_found`, LocalAI "could not
 * load model"). A false positive only costs one reading of the list, which says nothing when nothing changed.
 */
export function isModelNotFoundError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return (
		/^\s*404\b/.test(errorMessage) ||
		/model_not_found|\b(?:unknown|no such) model\b|could not load model/i.test(errorMessage) ||
		/\bmodel\b[^\n]{0,120}?\b(?:not found|does not exist|doesn't exist|not exist)\b/i.test(errorMessage)
	);
}

export interface ServerChange {
	providerId: string;
	added: string[];
	removed: string[];
	/** Models still served whose detected fields changed. */
	updated?: string[];
}

/** What the user is told, e.g. `localai: added hy4-flash; removed qwen3.8-27b-fp8.` */
export function describeServerChange(change: ServerChange, inUse: { current?: string; default?: string } = {}): string {
	const { providerId, added, removed } = change;
	const updated = change.updated ?? [];
	const listChanged = added.length > 0 || removed.length > 0;
	const refreshed =
		updated.length === 0
			? undefined
			: listChanged
				? fill("{0} updated from the server (thinking levels, context, images).", updated.join(", "))
				: fill(
						"{0}: {1} updated from the server (thinking levels, context, images).",
						providerId,
						updated.join(", "),
					);
	const listed = !listChanged
		? undefined
		: added.length > 0 && removed.length > 0
			? fill("{0}: added {1}; removed {2}.", providerId, added.join(", "), removed.join(", "))
			: added.length > 0
				? fill("{0}: added {1}.", providerId, added.join(", "))
				: fill("{0}: removed {1}.", providerId, removed.join(", "));
	const head = [listed, refreshed].filter((part) => part !== undefined).join(" ");
	const current = inUse.current !== undefined && removed.includes(inUse.current) ? inUse.current : undefined;
	const fallback = inUse.default !== undefined && removed.includes(inUse.default) ? inUse.default : undefined;
	if (current !== undefined && current === fallback)
		return `${head} ${fill("{0}, the current and default model, is no longer on the server: choose another with /model.", current)}`;
	const notes = [
		...(current !== undefined
			? [fill("{0}, the current model, is no longer on the server: choose another with /model.", current)]
			: []),
		...(fallback !== undefined ? [fill("{0}, the default model, is no longer on the server.", fallback)] : []),
	];
	return [head, ...notes].join(" ");
}

/** The key the manual action uses: the provider's stored key, without the `none` placeholder. */
async function serverKey(registry: ModelRegistry, providerId: string): Promise<string | undefined> {
	const model = registry.getAll().find((candidate) => candidate.provider === providerId);
	let apiKey: string | undefined;
	if (model) {
		const auth = await registry.getApiKeyAndHeaders(model);
		apiKey = auth.ok ? auth.apiKey : undefined;
	} else {
		apiKey = await registry.getApiKeyForProvider(providerId);
	}
	return apiKey && apiKey !== "none" ? apiKey : undefined;
}

/** What one process shares between its sessions: the start refresh runs once, one reading per server at a time. */
export interface RefreshState {
	/** The start refresh, once started (tests await it). */
	startup?: Promise<void>;
	inFlight: Map<string, Promise<void>>;
}

interface RefreshDeps {
	modelsPath: string;
	registry: ModelRegistry;
	ui: ExtensionUIContext;
	/** The model in use and the default one, read when the change is announced. */
	inUse: () => { current?: string; default?: string };
	/** Adds models to the session's scope when it is narrowed (`ExtensionContext.addToScope`). */
	addToScope: (models: readonly Model<any>[]) => void;
	/** Gives the session the reloaded entry of its model, when the server changed what it says about it. */
	reselect: (model: Model<any>) => Promise<void>;
	timeoutMs: number;
}

/** Reads one server's list again; announces a change; anything that fails changes nothing and says nothing. */
function refreshServer(state: RefreshState, providerId: string, deps: RefreshDeps): Promise<void> {
	const running = state.inFlight.get(providerId);
	if (running) return running;
	const run = async () => {
		let change: ServerChange;
		try {
			const apiKey = await serverKey(deps.registry, providerId);
			const signal = AbortSignal.timeout(deps.timeoutMs);
			change = { providerId, ...(await syncCompatibleServer(deps.modelsPath, providerId, apiKey, signal)) };
		} catch {
			return;
		}
		const updated = change.updated ?? [];
		const changed = change.added.length > 0 || change.removed.length > 0 || updated.length > 0;
		// Another engine of the desktop window may have written the change (and announced it) first: this process's
		// list is reloaded anyway when it no longer matches the file.
		const listed = deps.registry
			.getAll()
			.filter((model) => model.provider === providerId)
			.map((model) => model.id);
		const inFile = addedServers(deps.modelsPath).get(providerId) ?? [];
		const stale = listed.length !== inFile.length || inFile.some((id) => !listed.includes(id));
		if (changed || stale) await deps.registry.refresh({ allowNetwork: false }).catch(() => undefined);
		const current = deps.inUse().current;
		const reloaded =
			current !== undefined && updated.includes(current) ? deps.registry.find(providerId, current) : undefined;
		if (reloaded) await deps.reselect(reloaded).catch(() => undefined);
		// The models this process did not list before, whichever engine wrote them to the file.
		const fresh = deps.registry
			.getAll()
			.filter((model) => model.provider === providerId && inFile.includes(model.id) && !listed.includes(model.id));
		if (fresh.length > 0) {
			try {
				deps.addToScope(fresh);
			} catch {
				// A context left behind by a new session or a reload.
			}
		}
		if (!changed) return;
		const inUse = deps.inUse();
		const warn = inUse.current !== undefined && change.removed.includes(inUse.current);
		try {
			deps.ui.notify(describeServerChange(change, inUse), warn ? "warning" : "info");
		} catch {
			// The interface may be gone (the process is shutting down).
		}
	};
	const promise = run().finally(() => state.inFlight.delete(providerId));
	state.inFlight.set(providerId, promise);
	return promise;
}

const processState: RefreshState = { inFlight: new Map() };

export function serverModelRefresh(
	state: RefreshState = processState,
	timeoutMs = SERVER_REFRESH_TIMEOUT_MS,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		let latest: ExtensionContext | undefined;
		const inUseFor = (providerId: string) => () => {
			let model: { provider: string; id: string } | undefined;
			try {
				model = latest?.model;
			} catch {
				// A context left behind by a new session or a reload.
			}
			const defaultProvider = readGlobalSetting("defaultProvider");
			const defaultModel = readGlobalSetting("defaultModel");
			return {
				current: model?.provider === providerId ? model.id : undefined,
				default: defaultProvider === providerId && typeof defaultModel === "string" ? defaultModel : undefined,
			};
		};
		const deps = (ctx: ExtensionContext, providerId: string): RefreshDeps => ({
			modelsPath: getModelsPath(),
			registry: ctx.modelRegistry,
			ui: ctx.ui,
			inUse: inUseFor(providerId),
			addToScope: (models) => latest?.addToScope?.(models),
			reselect: async (model) => {
				const stillSelected = () => {
					try {
						return latest?.model?.provider === model.provider && latest.model.id === model.id;
					} catch {
						return false;
					}
				};
				if (stillSelected()) await pi.setModel(model, { onlyIf: stillSelected });
			},
			timeoutMs,
		});

		pi.on("session_start", (_event, ctx) => {
			latest = ctx;
			// Once per process: a new session in the same process is not a new start. Without an interface (print
			// mode) nobody would see the change, and a slow server would hold the process up to the timeout.
			if (state.startup || !ctx.hasUI) return;
			// The offline switch turns off the network at start (--offline, PI_OFFLINE), as model discovery does.
			if (process.env.PI_OFFLINE !== undefined) {
				state.startup = Promise.resolve();
				return;
			}
			const servers = [...addedServers(getModelsPath()).keys()];
			// Never awaited here: the start does not wait for any server.
			state.startup = Promise.all(servers.map((id) => refreshServer(state, id, deps(ctx, id)))).then(() => {});
		});

		pi.on("model_select", (_event, ctx) => {
			latest = ctx;
		});

		// The request has just reached the server, so this reading is not a start-up network access: PI_OFFLINE
		// does not stop it.
		pi.on("message_end", (event, ctx) => {
			const message = event.message as {
				role?: string;
				stopReason?: string;
				errorMessage?: string;
				provider?: string;
			};
			if (message.role !== "assistant" || message.stopReason !== "error" || !message.provider) return;
			if (!isModelNotFoundError(message.errorMessage) || !ctx.hasUI) return;
			latest = ctx;
			if (!addedServers(getModelsPath()).has(message.provider)) return;
			void refreshServer(state, message.provider, deps(ctx, message.provider));
		});
	};
}

export default serverModelRefresh();

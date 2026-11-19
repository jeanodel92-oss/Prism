/**
 * fork: read-only detection of a server's models and their capabilities.
 *
 * Every result has three states: "yes" (confirmed by the server), "no" (the server says it is
 * absent) and "unknown" (the server does not say). Missing metadata is "unknown", never "no".
 *
 * Only reads: GET requests, plus Ollama's POST /api/show, which reads a model's manifest. Nothing
 * loads, unloads or reconfigures a model: llama.cpp's /props is asked without `?model=`, except in
 * router mode, where it is asked only for a model the router lists as loaded, with `autoload=false`
 * (without it, that request would load the model). No endpoint that runs the model is called.
 *
 * Field names checked against the servers' docs and sources on 2026-10-12, then on 2026-10-20 for
 * llama.cpp's router mode, LM Studio's reasoning options and Ollama's thinking values
 * .
 */

import type { ChatTemplateKwargValue, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { readLimitedJson } from "./http-body-limit.ts";
import { fill, t } from "./i18n/index.ts";

export type Tri = "yes" | "no" | "unknown";

export type ServerKind = "llama.cpp" | "ollama" | "lmstudio" | "generic";

export interface DetectedModel {
	id: string;
	/** Context the server actually allocated, per request (llama.cpp: per slot). */
	contextWindow?: number;
	/** Largest context the model supports; not what the server allocated. */
	maxContextWindow?: number;
	vision: Tri;
	tools: Tri;
	reasoning: Tri;
	/** fork: how the chat template turns thinking on and picks its effort, when it says. */
	thinking?: TemplateThinking;
	/** fork: the server's own output limit, used when a request does not set one. */
	maxOutput?: number | "unlimited";
	/** fork: the server's default sampling values (`SAMPLING_KEYS`), used when a request does not set them. */
	sampling?: Record<string, number>;
}

/**
 * fork: sampling parameters both llama.cpp and Ollama report and accept under these
 * names (llama.cpp `server-task.cpp`, Ollama Modelfile parameters).
 */
export const SAMPLING_KEYS = [
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"presence_penalty",
	"frequency_penalty",
	"repeat_penalty",
] as const;

function samplingDefaults(read: (key: string) => unknown): Record<string, number> | undefined {
	const values: Record<string, number> = {};
	for (const key of SAMPLING_KEYS) {
		const value = read(key);
		if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
	}
	return Object.keys(values).length > 0 ? values : undefined;
}

/** llama.cpp's `n_predict` and Ollama's `num_predict`: -1 means no limit. */
function outputLimit(value: unknown): number | "unlimited" | undefined {
	return value === -1 ? "unlimited" : positive(value);
}

export interface TemplateThinking {
	/** `chat_template_kwargs` to send, with pi's thinking variables. */
	kwargs: Record<string, ChatTemplateKwargValue>;
	/** pi thinking level to template value; null marks a level the template does not accept. */
	levels: ThinkingLevelMap;
}

export interface DetectedServer {
	kind: ServerKind;
	/** llama.cpp: number of parallel slots. */
	slots?: number;
	models: DetectedModel[];
}

type Json = Record<string, unknown>;

const TIMEOUT_MS = 5000;
/**
 * fork: the most a server's answer to a detection request may hold. A large model list
 * is under 1 MiB; a server that answers without end is cut here instead of filling the engine.
 */
export const SERVER_INFO_MAX_BYTES = 16 * 1024 * 1024;

function record(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function tri(value: unknown): Tri {
	return value === true ? "yes" : value === false ? "no" : "unknown";
}

/** Server root, without a trailing `/v1`: the native endpoints live there. */
function serverRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function readJson(
	url: string,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
	body?: unknown,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) return undefined;
		return await readLimitedJson(response, SERVER_INFO_MAX_BYTES);
	} catch {
		if (signal?.aborted) throw signal.reason;
		return undefined;
	}
}

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * fork: thinking controls a Jinja chat template reads. `enable_thinking` turns thinking on
 * and off (Qwen); `reasoning_effort` picks an effort among the values the template compares it
 * with. Nothing is assumed: a template that names neither, or names `reasoning_effort` without
 * listing values, gives undefined.
 */
export function templateThinking(template: string | undefined): TemplateThinking | undefined {
	if (!template) return undefined;
	const toggles = /\benable_thinking\b/.test(template);
	const values = new Set<string>();
	for (const match of template.matchAll(/reasoning_effort\s*[!=]=\s*["']([\w-]+)["']/g)) values.add(match[1]!);
	// the list is cut at the next `]` or `)` by hand; `[^\])]*` rescanned the rest of the template for
	// every unclosed `reasoning_effort in [`, quadratic on a hostile template.
	for (const match of template.matchAll(/reasoning_effort\s+(?:not\s+)?in\s+[[(]/g)) {
		const start = match.index + match[0].length;
		const ends = [template.indexOf("]", start), template.indexOf(")", start)].filter((end) => end >= 0);
		if (ends.length === 0) break;
		for (const quoted of template.slice(start, Math.min(...ends)).matchAll(/["']([\w-]+)["']/g))
			values.add(quoted[1]!);
	}
	const efforts = EFFORT_LEVELS.filter((level) => values.has(level));
	if (!toggles && efforts.length === 0) return undefined;

	const kwargs: Record<string, ChatTemplateKwargValue> = {};
	if (toggles) kwargs.enable_thinking = { $var: "thinking.enabled" };
	if (efforts.length > 0) kwargs.reasoning_effort = { $var: "thinking.effort" };
	const levels: ThinkingLevelMap = {};
	// Without listed efforts, thinking is on or off: one level stands for "on".
	const accepted: readonly string[] = efforts.length > 0 ? efforts : ["medium"];
	for (const level of EFFORT_LEVELS) levels[level] = accepted.includes(level) ? level : null;
	// Off: the template's own "none" when it has one; else the toggle; else thinking cannot be turned off.
	if (values.has("none")) levels.off = "none";
	else if (!toggles) levels.off = null;
	return { kwargs, levels };
}

function unknownModel(id: string): DetectedModel {
	return { id, vision: "unknown", tools: "unknown", reasoning: "unknown" };
}

/** What llama.cpp's /props and /v1/models entry say about one model. */
function llamaCppModel(
	id: string,
	props: Json,
	entry: Json | undefined,
	contextWindow: number | undefined,
): DetectedModel {
	const caps = record(props.chat_template_caps);
	const vision = tri(record(props.modalities)?.vision);
	// fork: recent servers nest the defaults under `params`; older ones put them alongside n_ctx.
	const defaults = record(props.default_generation_settings);
	const params = record(defaults?.params) ?? defaults;
	const maxOutput = outputLimit(params?.n_predict);
	const sampling = samplingDefaults((key) => params?.[key]);
	const thinking = templateThinking(typeof props.chat_template === "string" ? props.chat_template : undefined);
	const inputs = record(entry?.architecture)?.input_modalities;
	return {
		id,
		contextWindow,
		maxContextWindow: positive(record(entry?.meta)?.n_ctx_train),
		vision: vision !== "unknown" ? vision : Array.isArray(inputs) ? tri(inputs.includes("image")) : "unknown",
		// Only meaningful when the server applies the chat template (--jinja); absent caps stay unknown.
		tools: tri(caps?.supports_tool_calls),
		// fork: a template llama.cpp sees reading `reasoning_effort` or replaying the reasoning
		// is a thinking model's, even when Prism cannot read its controls.
		reasoning:
			thinking || caps?.supports_reasoning_effort === true || caps?.supports_preserve_reasoning === true
				? "yes"
				: "unknown",
		...(thinking ? { thinking } : {}),
		...(maxOutput !== undefined ? { maxOutput } : {}),
		...(sampling ? { sampling } : {}),
	};
}

async function detectLlamaCpp(
	root: string,
	props: Json,
	modelIds: string[],
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<DetectedServer> {
	const slots = await readJson(`${root}/slots`, apiKey, signal);
	const slotContexts = Array.isArray(slots)
		? slots.flatMap((slot) => {
				const context = positive(record(slot)?.n_ctx);
				return context === undefined ? [] : [context];
			})
		: [];
	// A request can land on any slot; use the smallest allocation to avoid overestimating capacity.
	// reduced, not spread: `Math.min(...list)` overflows the stack on a very long /slots answer.
	const slotContext = slotContexts.length > 0 ? slotContexts.reduce((a, b) => Math.min(a, b)) : undefined;
	const contextWindow = slotContext ?? positive(record(props.default_generation_settings)?.n_ctx);
	const listed = record(await readJson(`${root}/v1/models`, apiKey, signal));
	const entries = Array.isArray(listed?.data) ? listed.data.map(record) : [];
	return {
		kind: "llama.cpp",
		slots: positive(props.total_slots),
		models: modelIds.map((id) =>
			llamaCppModel(
				id,
				props,
				entries.find((candidate) => candidate?.id === id),
				contextWindow,
			),
		),
	};
}

/**
 * fork: llama.cpp in router mode (`--models-dir`, `--models-preset`). Its own /props is a
 * placeholder (`role: "router"`, no chat template, `n_ctx` 0): each model's props come from the
 * instance that serves it. Only models the router lists as loaded are asked, and with
 * `autoload=false`, so detection never loads one; the others stay unknown.
 */
async function detectLlamaCppRouter(
	root: string,
	modelIds: string[],
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<DetectedServer> {
	const listed = record(await readJson(`${root}/models`, apiKey, signal));
	const entries = Array.isArray(listed?.data) ? listed.data.map(record) : [];
	const models: DetectedModel[] = [];
	for (const id of modelIds) {
		const entry = entries.find(
			(candidate) => candidate?.id === id || (Array.isArray(candidate?.aliases) && candidate.aliases.includes(id)),
		);
		// Only a loaded instance is asked: a sleeping one may reload its weights to answer.
		const loaded = record(entry?.status)?.value === "loaded";
		const query = `model=${encodeURIComponent(id)}&autoload=false`;
		const props = loaded ? record(await readJson(`${root}/props?${query}`, apiKey, signal)) : undefined;
		if (!props) {
			const inputs = record(entry?.architecture)?.input_modalities;
			models.push({
				...unknownModel(id),
				...(Array.isArray(inputs) ? { vision: tri(inputs.includes("image")) } : {}),
			});
			continue;
		}
		models.push(llamaCppModel(id, props, entry, positive(record(props.default_generation_settings)?.n_ctx)));
	}
	return { kind: "llama.cpp", models };
}

async function detectOllama(
	root: string,
	modelIds: string[],
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<DetectedServer> {
	const models: DetectedModel[] = [];
	for (const id of modelIds) {
		const shown = record(await readJson(`${root}/api/show`, apiKey, signal, { model: id }));
		const capabilities = Array.isArray(shown?.capabilities) ? shown.capabilities : undefined;
		const has = (name: string): Tri => (capabilities ? tri(capabilities.includes(name)) : "unknown");
		const info = record(shown?.model_info) ?? {};
		const trainingKey = Object.keys(info).find((key) => key.endsWith(".context_length"));
		// num_ctx is the context Ollama allocates for this model, when the model sets it.
		const parameters = typeof shown?.parameters === "string" ? shown.parameters : "";
		// One `name value` pair per line, e.g. `num_ctx 8192`, `temperature 0.6`.
		const parameter = (name: string): number | undefined => {
			const value = new RegExp(`^${name}\\s+(-?[\\d.]+)\\s*$`, "m").exec(parameters)?.[1];
			return value === undefined ? undefined : Number(value);
		};
		const numCtx = parameter("num_ctx");
		const maxOutput = outputLimit(parameter("num_predict"));
		const sampling = samplingDefaults(parameter);
		// fork: recent versions list the accepted `think` values; `[false]` alone means none.
		const thinkValues = record(shown?.thinking)?.values;
		const reasoning: Tri = Array.isArray(thinkValues)
			? tri(thinkValues.some((value) => value !== false))
			: has("thinking");
		models.push({
			id,
			contextWindow: positive(numCtx),
			maxContextWindow: trainingKey ? positive(info[trainingKey]) : undefined,
			vision: has("vision"),
			tools: has("tools"),
			reasoning,
			...(maxOutput !== undefined ? { maxOutput } : {}),
			...(sampling ? { sampling } : {}),
		});
	}
	return { kind: "ollama", models };
}

/**
 * fork: LM Studio adds `capabilities.reasoning` (`allowed_options` among off, on, low,
 * medium, high) only when it exposes a reasoning setting for the model. Its absence is not a "no":
 * unknown, so thinking stays available. Only a model limited to "off" has none.
 */
function lmStudioReasoning(capabilities: Json | undefined): Tri {
	const options = record(capabilities?.reasoning)?.allowed_options;
	if (!Array.isArray(options) || options.length === 0) return "unknown";
	return tri(options.some((option) => option !== "off"));
}

function detectLmStudio(listed: unknown[], modelIds: string[]): DetectedServer {
	const entries = listed.map(record);
	return {
		kind: "lmstudio",
		models: modelIds.map((id) => {
			const entry = entries.find((candidate) => candidate?.key === id);
			if (!entry) return unknownModel(id);
			const capabilities = record(entry.capabilities);
			const loaded = Array.isArray(entry.loaded_instances) ? record(entry.loaded_instances[0]) : undefined;
			return {
				id,
				contextWindow: positive(record(loaded?.config)?.context_length),
				maxContextWindow: positive(entry.max_context_length),
				vision: capabilities ? tri(capabilities.vision) : "unknown",
				// Not trained for tools does not mean tools are refused: only "yes" is confirmed.
				tools: capabilities?.trained_for_tool_use === true ? "yes" : "unknown",
				reasoning: lmStudioReasoning(capabilities),
			};
		}),
	};
}

/** Detects the server kind and what it says about each model. Never throws on missing metadata. */
export async function detectCapabilities(
	baseUrl: string,
	modelIds: string[],
	apiKey?: string,
	signal?: AbortSignal,
): Promise<DetectedServer> {
	const root = serverRoot(baseUrl);
	const props = record(await readJson(`${root}/props`, apiKey, signal));
	if (props?.role === "router") return detectLlamaCppRouter(root, modelIds, apiKey, signal);
	if (props && ("default_generation_settings" in props || "total_slots" in props)) {
		return detectLlamaCpp(root, props, modelIds, apiKey, signal);
	}
	const version = record(await readJson(`${root}/api/version`, apiKey, signal));
	if (typeof version?.version === "string") return detectOllama(root, modelIds, apiKey, signal);
	const lmStudio = record(await readJson(`${root}/api/v1/models`, apiKey, signal));
	if (Array.isArray(lmStudio?.models)) return detectLmStudio(lmStudio.models, modelIds);
	return { kind: "generic", models: modelIds.map(unknownModel) };
}

/** One line per model for the user, e.g. `qwen: context 65536 (max 131072), vision yes, tools unknown, ...`. */
export function describeCapabilities(server: DetectedServer): string[] {
	// fork: filled from structured values, so model ids and level names are never translated.
	const head = server.slots ? fill("{0}, {1} slots", server.kind, String(server.slots)) : server.kind;
	return [
		head,
		...server.models.map((model) => {
			const context = model.contextWindow ? fill("context {0}", String(model.contextWindow)) : t("context unknown");
			const max = model.maxContextWindow ? fill(" (max {0})", String(model.maxContextWindow)) : "";
			const levels = model.thinking ? ` (${thinkingLevelNames(model.thinking).join(", ")})` : "";
			return fill(
				"{0}: {1}{2}, vision {3}, tools {4}, reasoning {5}{6}",
				model.id,
				context,
				max,
				t(model.vision),
				t(model.tools),
				t(model.reasoning),
				levels,
			);
		}),
	];
}

/** Thinking levels the template accepts, in pi's order, `off` first when it can be turned off. */
export function thinkingLevelNames(thinking: TemplateThinking): string[] {
	return ["off", ...EFFORT_LEVELS].filter((level) => thinking.levels[level as keyof ThinkingLevelMap] !== null);
}

/**
 * fork: `/model-settings`, the current model's limits and sampling, with what the
 * server reports next to what Prism sends or assumes.
 *
 * The two never mix: the server column is read from the server when the screen opens (read-only, and
 * only for a server added to models.json, never a cloud provider) and is never written; the Prism
 * column is the model as Prism uses it. A correction goes to `modelOverrides` in models.json, pi's
 * topmost model layer, so it outlives a new detection (which rewrites `models`) and wins over it.
 * Changing a Prism value never changes the server: llama.cpp's context, for one, is fixed at launch.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { getModelsPath } from "../config.ts";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import { type DetectedModel, detectCapabilities, SAMPLING_KEYS } from "./capabilities.ts";
import { capabilitiesPath, readCapabilities, type StoredCapabilities, writeToolCalls } from "./capability-store.ts";
import { syncCompatibleServer } from "./compatible-server.ts";
import { lockForkFile } from "./file-lock.ts";
import { fill, t } from "./i18n/index.ts";
import { removeServer, removeServerModel, serverModelIds } from "./remove-server-model.ts";
import { writeFileAtomicSync } from "./secrets/atomic-write.ts";
import { modelPagesSection, modelRowId } from "./settings-model-page.ts";
import { modelKey } from "./settings-models.ts";
import { openSettings, type SettingsSection, setSettingsSection, settingsSections } from "./settings-sections.ts";

export type SettingKey =
	| "name"
	| "contextWindow"
	| "maxTokens"
	| "vision"
	/** fork: tool-result images inside the tool message, `compat.supportsImagesInToolResults`. */
	| "toolImages"
	| "reasoning"
	/** fork: one budget for every thinking level, stored as the model's `thinkingBudgets`. */
	| "thinkingBudget"
	| (typeof SAMPLING_KEYS)[number]
	/** fork: any other request field, sent as typed (`samplingParams` keys outside SAMPLING_KEYS). */
	| "extra";
/** fork: tool calls have no model field; their correction lives in capabilities.json. */
export type RowKey = SettingKey | "tools";

export interface SettingRow {
	key: RowKey;
	label: string;
	/** What the server reports; undefined when it does not say. */
	server?: string;
	/** What Prism sends or assumes. */
	prism: string;
	/** True when the Prism value comes from a correction in models.json. */
	corrected: boolean;
}

type Json = Record<string, unknown>;

/**
 * fork: shown whenever thinking is refused for a model not marked as reasoning. The
 * mark can be wrong (written by hand, or a server that does not say), so the refusal names the fix.
 */
export const THINKING_UNSUPPORTED =
	"Current model does not support thinking. If it does, set Thinking to yes in /model-settings.";

/**
 * fork: shown under a response that stopped on an output limit. It names the three
 * limits that end a response this way and where each one is changed.
 */
export const OUTPUT_LIMIT_STOP =
	"Response cut off by an output limit: Max output in /model-settings, the server's own limit, or the room left in the context (/compact frees some). Raise it, then ask the model to continue.";

const LABELS: Record<RowKey, string> = {
	name: "Name",
	contextWindow: "Context",
	maxTokens: "Max output",
	vision: "Images",
	toolImages: "Images from tools",
	reasoning: "Thinking",
	thinkingBudget: "Thinking budget",
	tools: "Tool calls",
	temperature: "Temperature",
	top_p: "Top P",
	top_k: "Top K",
	min_p: "Min P",
	presence_penalty: "Presence penalty",
	frequency_penalty: "Frequency penalty",
	repeat_penalty: "Repeat penalty",
	extra: "Other parameters",
};

/** fork: penalties below 0 are valid (OpenAI's presence and frequency penalties go from -2 to 2). */
const SIGNED = new Set<string>(["presence_penalty", "frequency_penalty"]);

export type SettingValue = number | boolean | string | Json;

const SAMPLING = new Set<string>(SAMPLING_KEYS);

function record(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function readConfig(modelsPath: string): { providers: Record<string, Json> } {
	if (!existsSync(modelsPath)) return { providers: {} };
	try {
		const config = JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers?: Record<string, Json> };
		return { ...config, providers: config.providers ?? {} };
	} catch {
		throw new Error(
			fill(
				"Could not update {0}: it must contain valid JSON (a structured settings format, without comments). Check the file, then retry.",
				modelsPath,
			),
		);
	}
}

/** The correction stored for this model, if any. */
export function readModelCorrection(modelsPath: string, provider: string, modelId: string): Json {
	return readAllCorrections(modelsPath)(provider, modelId);
}

/** fork: reads models.json once and returns each model's correction, for a list of models. */
export function readAllCorrections(modelsPath: string): (provider: string, modelId: string) => Json {
	const providers = readConfig(modelsPath).providers;
	return (provider, modelId) => record(record(providers[provider]?.modelOverrides)?.[modelId]) ?? {};
}

/** fork: removes every correction of one model ("Remove my changes" in its /settings page). */
export async function clearModelCorrection(modelsPath: string, provider: string, modelId: string): Promise<void> {
	await editModelCorrection(modelsPath, provider, modelId, (override) => {
		for (const key of Object.keys(override)) delete override[key];
	});
}

/** Sets (or, with `value` undefined, removes) one corrected value; other fields and providers are kept. */
export async function writeModelCorrection(
	modelsPath: string,
	provider: string,
	modelId: string,
	key: SettingKey,
	value: SettingValue | undefined,
): Promise<void> {
	await editModelCorrection(modelsPath, provider, modelId, (override) => {
		if (key === "thinkingBudget") {
			if (typeof value === "number")
				override.thinkingBudgets = { minimal: value, low: value, medium: value, high: value };
			else delete override.thinkingBudgets;
		} else if (SAMPLING.has(key) || key === "extra") {
			const sampling = { ...(record(override.samplingParams) ?? {}) };
			if (key === "extra") {
				// The typed object replaces every other parameter; the named ones keep their rows.
				for (const name of Object.keys(sampling)) if (!SAMPLING.has(name)) delete sampling[name];
				Object.assign(sampling, record(value) ?? {});
			} else if (value === undefined) delete sampling[key];
			else sampling[key] = value;
			if (Object.keys(sampling).length > 0) override.samplingParams = sampling;
			else delete override.samplingParams;
		} else if (key === "toolImages") {
			const compat = { ...(record(override.compat) ?? {}) };
			if (value === undefined) delete compat.supportsImagesInToolResults;
			else compat.supportsImagesInToolResults = value;
			if (Object.keys(compat).length > 0) override.compat = compat;
			else delete override.compat;
		} else {
			const field = key === "vision" ? "input" : key;
			if (value === undefined) delete override[field];
			else override[field] = key === "vision" ? (value ? ["text", "image"] : ["text"]) : value;
		}
	});
}

/**
 * fork: sets (or removes) the model's thinking budget, with the request field the server reads it
 * from when the model has none: an OpenAI-compatible server sends no budget without one. Removing the budget
 * removes that field too, so no level budget is sent afterwards.
 */
export async function writeThinkingBudget(
	modelsPath: string,
	provider: string,
	modelId: string,
	budget: number | undefined,
	field: OpenAICompletionsCompat["thinkingTokenBudgetField"],
): Promise<void> {
	// fork: the budget and its field in one locked change, never one without the other.
	await editModelCorrection(modelsPath, provider, modelId, (override) => {
		if (typeof budget === "number")
			override.thinkingBudgets = { minimal: budget, low: budget, medium: budget, high: budget };
		else delete override.thinkingBudgets;
		const compat = { ...(record(override.compat) ?? {}) };
		if (budget !== undefined && field) compat.thinkingTokenBudgetField = field;
		else if (budget === undefined) delete compat.thinkingTokenBudgetField;
		if (Object.keys(compat).length > 0) override.compat = compat;
		else delete override.compat;
	});
}

/** Applies `edit` to the model's entry in `modelOverrides`, under the file lock; empty entries are removed. */
async function editModelCorrection(
	modelsPath: string,
	provider: string,
	modelId: string,
	edit: (override: Json) => void,
) {
	return lockForkFile(modelsPath, () => {
		const config = readConfig(modelsPath);
		const entry = config.providers[provider] ?? {};
		config.providers[provider] = entry;
		const overrides = (record(entry.modelOverrides) ?? {}) as Record<string, Json>;
		const override = { ...(overrides[modelId] ?? {}) };
		edit(override);
		if (Object.keys(override).length > 0) overrides[modelId] = override;
		else delete overrides[modelId];
		if (Object.keys(overrides).length > 0) entry.modelOverrides = overrides;
		else delete entry.modelOverrides;
		if (Object.keys(entry).length === 0) delete config.providers[provider];

		// fork: synced, and refused once the lock may be another writer's.
		writeFileAtomicSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
	});
}

/** Parses what the user typed for a setting; an Error says what is expected. */
export function parseSettingValue(key: RowKey, text: string): SettingValue | Error {
	if (key === "name") return text.trim() || new Error(t("Type a name."));
	if (key === "extra") return parseExtra(text);
	const value = text.trim().toLowerCase();
	if (key === "vision" || key === "toolImages" || key === "reasoning" || key === "tools") {
		if (["yes", "on", "true", "oui"].includes(value)) return true;
		if (["no", "off", "false", "non"].includes(value)) return false;
		return new Error(t("Type yes or no."));
	}
	const number = Number(value);
	if (value === "" || !Number.isFinite(number) || (number < 0 && !SIGNED.has(key)))
		return new Error(t("Type a number."));
	if (
		(key === "contextWindow" || key === "maxTokens" || key === "thinkingBudget" || key === "top_k") &&
		!Number.isInteger(number)
	) {
		return new Error(t("Type a whole number."));
	}
	if ((key === "contextWindow" || key === "maxTokens" || key === "thinkingBudget") && number === 0)
		return new Error(t("Type a number above 0."));
	return number;
}

/** A JSON object of request fields; a named parameter has its own row and is refused here. */
function parseExtra(text: string): Json | Error {
	const expected = new Error(t('Type a JSON object, for example {"seed": 42}.'));
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return expected;
	}
	const object = record(parsed);
	if (!object) return expected;
	const named = Object.keys(object).find((name) => SAMPLING.has(name));
	if (named) return new Error(`${named}: ${t("it has its own row.")}`);
	return object;
}

/** One number when every level has the same budget, else the budget of each level. */
function formatBudgets(budgets: Model<Api>["thinkingBudgets"]): string {
	const values = Object.values(budgets ?? {});
	if (values.length === 0) return t("not set");
	return values.length === 4 && new Set(values).size === 1 ? String(values[0]) : JSON.stringify(budgets);
}

function yesNo(value: boolean): string {
	return value ? t("yes") : t("no");
}

function serverYesNo(value: DetectedModel["vision"]): string | undefined {
	return value === "unknown" ? undefined : yesNo(value === "yes");
}

/** The rows of the screen, from the model as Prism uses it, its correction and what the server reports. */
export function settingRows(
	model: Model<Api>,
	correction: Json,
	server: DetectedModel | undefined,
	stored?: StoredCapabilities,
): SettingRow[] {
	const sampling = record(correction.samplingParams) ?? {};
	const rows: SettingRow[] = [
		{
			key: "name",
			label: t(LABELS.name),
			prism: model.name,
			corrected: correction.name !== undefined,
		},
		{
			key: "contextWindow",
			label: t(LABELS.contextWindow),
			server: server?.contextWindow?.toString(),
			prism: model.contextWindow.toString(),
			corrected: correction.contextWindow !== undefined,
		},
		{
			key: "maxTokens",
			label: t(LABELS.maxTokens),
			server: server?.maxOutput === "unlimited" ? t("unlimited") : server?.maxOutput?.toString(),
			prism: model.maxTokens.toString(),
			corrected: correction.maxTokens !== undefined,
		},
		{
			key: "vision",
			label: t(LABELS.vision),
			server: server ? serverYesNo(server.vision) : undefined,
			prism: yesNo(model.input.includes("image")),
			corrected: correction.input !== undefined,
		},
		// Only the OpenAI-compatible chat API sends tool images as a separate message.
		...(model.api === "openai-completions"
			? [
					{
						key: "toolImages" as const,
						label: t(LABELS.toolImages),
						prism: yesNo(
							(model.compat as OpenAICompletionsCompat | undefined)?.supportsImagesInToolResults === true,
						),
						corrected: record(correction.compat)?.supportsImagesInToolResults !== undefined,
					},
				]
			: []),
		{
			key: "reasoning",
			label: t(LABELS.reasoning),
			server: server ? serverYesNo(server.reasoning) : undefined,
			prism: yesNo(model.reasoning),
			corrected: correction.reasoning !== undefined,
		},
		{
			key: "thinkingBudget",
			label: t(LABELS.thinkingBudget),
			prism: formatBudgets(model.thinkingBudgets),
			corrected: correction.thinkingBudgets !== undefined,
		},
		{
			key: "tools",
			label: t(LABELS.tools),
			server: server ? serverYesNo(server.tools) : undefined,
			// fork: off only when detection said no or the user turned them off (capability-gates.ts).
			prism: yesNo(stored?.toolCalls ?? stored?.tools !== "no"),
			corrected: stored?.toolCalls !== undefined,
		},
	];
	for (const key of SAMPLING_KEYS) {
		const sent = model.samplingParams?.[key];
		rows.push({
			key,
			label: t(LABELS[key]),
			server: server?.sampling?.[key]?.toString(),
			// Prism sends nothing for a parameter it has no value for: the server's default applies.
			prism: sent === undefined ? t("not sent") : String(sent),
			corrected: sampling[key] !== undefined,
		});
	}
	const extra = Object.fromEntries(Object.entries(model.samplingParams ?? {}).filter(([key]) => !SAMPLING.has(key)));
	rows.push({
		key: "extra",
		label: t(LABELS.extra),
		prism: Object.keys(extra).length > 0 ? JSON.stringify(extra) : t("not sent"),
		corrected: Object.keys(sampling).some((key) => !SAMPLING.has(key)),
	});
	return rows;
}

/** One line per row, aligned in two labelled columns. */
export function formatRows(rows: SettingRow[]): string[] {
	const labelWidth = Math.max(...rows.map((row) => row.label.length));
	const servers = rows.map((row) => row.server ?? t("not reported"));
	const serverWidth = Math.max(...servers.map((value) => value.length));
	const serverName = t("server");
	return rows.map((row, i) => {
		const mark = row.corrected ? ` (${t("your correction")})` : "";
		return `${row.label.padEnd(labelWidth)}  ${serverName} ${servers[i]!.padEnd(serverWidth)}  Prism ${row.prism}${mark}`;
	});
}

/** The provider's base URL when it is a server added to models.json; detection reads only those. */
function localServerUrl(modelsPath: string, provider: string): string | undefined {
	try {
		const entry = readConfig(modelsPath).providers[provider];
		return Array.isArray(entry?.models) && typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
	} catch {
		return undefined;
	}
}

const UNKNOWN_BUDGET_FIELD =
	"Budget saved, but Prism does not know which request field this server reads it from, so it is not sent. Set compat.thinkingTokenBudgetField in models.json.";

/**
 * fork: the field to add with a budget, for an OpenAI-compatible model that has no way to send one yet.
 * llama.cpp reads `thinking_budget_tokens`; "unknown" for other servers.
 */
function budgetField(
	model: Model<Api>,
	kind: string | undefined,
): OpenAICompletionsCompat["thinkingTokenBudgetField"] | "unknown" {
	if (model.api !== "openai-completions") return undefined;
	const compat = model.compat as OpenAICompletionsCompat | undefined;
	const sent =
		compat?.thinkingTokenBudgetField ||
		compat?.supportsThinkingTokenBudget ||
		JSON.stringify(compat?.chatTemplateKwargs ?? {}).includes('"thinking.budget"');
	if (sent) return undefined;
	return kind === "llama.cpp" ? "thinking_budget_tokens" : "unknown";
}

/** What a server added to models.json reports about one model. */
export interface ServerValues {
	/** The server's software, as detection names it (llama.cpp, …). */
	kind: string;
	model: DetectedModel | undefined;
}

/** Reads the server's values for `model`; undefined for a provider that is not a server in models.json. */
export async function readServer(
	registry: ModelRegistry,
	modelsPath: string,
	model: Model<Api>,
): Promise<ServerValues | undefined> {
	const baseUrl = localServerUrl(modelsPath, model.provider);
	if (!baseUrl) return undefined;
	const auth = await registry.getApiKeyAndHeaders(model);
	const apiKey = auth.ok && auth.apiKey !== "none" ? auth.apiKey : undefined;
	const detected = await detectCapabilities(baseUrl, [model.id], apiKey);
	return { kind: detected.kind, model: detected.models[0] };
}

/**
 * Saves a new Prism value for one row (undefined removes the correction). Returns a warning to show when the
 * value is saved but not sent; throws when the file cannot be written.
 */
export async function saveSetting(
	paths: { modelsPath: string; capabilitiesFile: string },
	model: Model<Api>,
	key: RowKey,
	value: SettingValue | undefined,
	serverKind: string | undefined,
): Promise<string | undefined> {
	if (key === "tools") {
		await writeToolCalls(paths.capabilitiesFile, model.provider, model.id, value as boolean | undefined);
		return undefined;
	}
	if (key === "thinkingBudget") {
		const field = value === undefined ? undefined : budgetField(model, serverKind);
		const known = field === "unknown" ? undefined : field;
		await writeThinkingBudget(paths.modelsPath, model.provider, model.id, value as number | undefined, known);
		return field === "unknown" ? t(UNKNOWN_BUDGET_FIELD) : undefined;
	}
	await writeModelCorrection(paths.modelsPath, model.provider, model.id, key, value);
	return undefined;
}

const SECTION_OWNER = "model-settings";

export default function modelSettings(pi: ExtensionAPI) {
	// fork: each model's page in the Models domain of /settings, while the session runs.
	let section: SettingsSection | undefined;
	pi.on("session_start", (_event, ctx) => {
		const modelsPath = getModelsPath();
		section = modelPagesSection({
			modelsPath,
			capabilitiesFile: capabilitiesPath(dirname(modelsPath)),
			models: () => ctx.modelRegistry.getAvailable(),
			current: () => ctx.model,
			readServer: (model) => readServer(ctx.modelRegistry, modelsPath, model),
			reload: async (model) => {
				await ctx.modelRegistry.refresh({ providers: [model.provider], allowNetwork: false });
				const updated = ctx.modelRegistry.find(model.provider, model.id);
				// fork: also checked after the auth wait, so a model chosen meanwhile stays.
				const stillSelected = () => {
					const current = ctx.model;
					return current !== undefined && modelKey(current) === modelKey(model);
				};
				if (updated && stillSelected()) await pi.setModel(updated, { onlyIf: stillSelected });
				return updated;
			},
			// a model, or a whole server, the user added can be removed again.
			serverModels: (model) => serverModelIds(modelsPath, model.provider),
			syncServer: async (model) => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				const apiKey = auth.ok && auth.apiKey !== "none" ? auth.apiKey : undefined;
				const { added, removed, updated } = await syncCompatibleServer(modelsPath, model.provider, apiKey);
				await ctx.modelRegistry.refresh({ allowNetwork: false });
				const message =
					added.length === 0 && removed.length === 0 && updated.length === 0
						? t("The server's model list has not changed.")
						: [
								added.length > 0 ? fill("Added: {0}.", added.join(", ")) : "",
								removed.length > 0 ? fill("Removed: {0}.", removed.join(", ")) : "",
								updated.length > 0 ? fill("Updated from the server: {0}.", updated.join(", ")) : "",
							]
								.filter(Boolean)
								.join(" ");
				ctx.ui.notify(message, "info");
				return { message, gone: removed.includes(model.id) };
			},
			remove: async (model, server) => {
				let serverRemoved = server;
				if (server) await removeServer(modelsPath, model.provider);
				else serverRemoved = await removeServerModel(modelsPath, model.provider, model.id);
				// Its saved key goes with the server, as /logout removes it.
				if (serverRemoved) await ctx.modelRegistry.logout(model.provider);
				await ctx.modelRegistry.refresh({ allowNetwork: false });
				const current = ctx.model;
				const inUse =
					current !== undefined &&
					(server ? current.provider === model.provider : modelKey(current) === modelKey(model));
				const done = server
					? fill("Removed the server {0} and its models.", model.provider)
					: serverRemoved
						? fill(
								"Removed {0}, the server's last model: the server {1} is removed too.",
								modelKey(model),
								model.provider,
							)
						: fill("Removed {0}.", modelKey(model));
				const message = inUse ? `${done} ${t("This conversation keeps it until you choose another model.")}` : done;
				ctx.ui.notify(message, "info");
				return message;
			},
		});
		setSettingsSection(SECTION_OWNER, section);
	});
	pi.on("session_shutdown", () => {
		// A session started since then has put its own section in place: leave it.
		if (section && settingsSections().includes(section)) setSettingsSection(SECTION_OWNER, undefined);
		section = undefined;
	});

	pi.registerCommand("model-settings", {
		description:
			"Show and correct the current model's name, context, output limit, sampling and other request parameters, next to the server's values",
		handler: async (_args, ctx) => {
			const modelsPath = getModelsPath();
			const capabilitiesFile = capabilitiesPath(dirname(modelsPath));
			let model = ctx.model;
			if (!model) {
				ctx.ui.notify(t("No model selected. Choose one with /model."), "warning");
				return;
			}
			// fork: the command opens the current model's page in /settings; without
			// that window (RPC, print), the lines below.
			if (ctx.hasUI && section && openSettings({ domain: "models", item: modelRowId(model), open: true })) return;
			const server = await readServer(ctx.modelRegistry, modelsPath, model);
			const intro = server
				? t(
						`server: what ${server.kind} reports. Prism: what Prism sends or assumes; changing it does not change the server.`,
					)
				: t("This provider does not report its settings: only Prism's values are shown.");
			for (;;) {
				const rows = settingRows(
					model,
					readModelCorrection(modelsPath, model.provider, model.id),
					server?.model,
					readCapabilities(capabilitiesFile, model.provider, model.id),
				);
				const lines = formatRows(rows);
				if (!ctx.hasUI) {
					ctx.ui.notify([`${model.provider}/${model.id}`, intro, ...lines].join("\n"));
					return;
				}
				const choice = await ctx.ui.select(`${model.provider}/${model.id}\n${intro}`, lines);
				const row = rows[lines.indexOf(choice ?? "")];
				if (!row) return;
				const typed = await ctx.ui.input(
					`${row.label}: ${t("new value for Prism")} (${t("empty: remove your correction")})`,
				);
				if (typed === undefined) continue;
				const value = typed.trim() === "" ? undefined : parseSettingValue(row.key, typed);
				if (value instanceof Error) {
					ctx.ui.notify(value.message, "warning");
					continue;
				}
				try {
					const warning = await saveSetting({ modelsPath, capabilitiesFile }, model, row.key, value, server?.kind);
					if (warning) ctx.ui.notify(warning, "warning");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				await ctx.modelRegistry.refresh({ providers: [model.provider], allowNetwork: false });
				const updated = ctx.modelRegistry.find(model.provider, model.id);
				if (updated) {
					await pi.setModel(updated);
					model = updated;
				}
			}
		},
	});
}

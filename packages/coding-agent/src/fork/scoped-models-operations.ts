// what `/scoped-models` reads and changes, for the terminal's selector and the Prism window's
// screens alike: the models offered, the session's Ctrl+P scope, the catalog refresh and the save to settings.
// Each interface keeps its own list state and only calls these operations.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../core/agent-session.ts";
import { resolveModelScopeFromModels } from "../core/model-resolver.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { refreshModelCatalogs } from "../modes/interactive/model-catalog-refresh.ts";
import { withReloginNote } from "./oauth-relogin.ts";

/** How the catalog refresh ended; `reset` when the selection was read again from the settings. */
export interface ScopedModelsRefresh {
	status: string;
	kind: "success" | "warning";
	reset: boolean;
}

export interface ScopedModelsOperations {
	models(): Model<Api>[];
	/** `null` when every model is enabled. */
	enabledIds(): string[] | null;
	/** Applies a selection to the session only. */
	change(enabledIds: string[] | null): void;
	/** Saves a selection to the settings. */
	persist(enabledIds: string[] | null): void;
	/** Refreshes the model catalogs, for 15 s at most; `abort` when the selector closes, which changes nothing. */
	refresh(): { done: Promise<ScopedModelsRefresh>; abort(): void };
}

/** `applied` runs after each change of the session's scope (the terminal redraws its footer). */
export function scopedModelsOperations(
	session: AgentSession,
	settingsManager: SettingsManager,
	applied: () => void,
): ScopedModelsOperations {
	let availableModels = [...session.modelRuntime.getAvailableSnapshot()];
	let availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
	const configuredPatterns = settingsManager.getEnabledModels();
	const sessionScopedModels = session.scopedModels;
	const configuredEnabledIds = (models: readonly Model<Api>[]): string[] | null => {
		if (!configuredPatterns?.length) return null;
		const resolved = resolveModelScopeFromModels(configuredPatterns, models);
		const ids = resolved.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		for (const diagnostic of resolved.diagnostics) {
			if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
		}
		return ids;
	};

	let currentEnabledIds =
		sessionScopedModels.length > 0
			? sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)
			: configuredEnabledIds(availableModels);
	let selectionChanged = false;

	const updateSessionModels = (enabledIds: string[] | null): void => {
		currentEnabledIds = enabledIds === null ? null : [...enabledIds];
		const hasEnabledAvailableModel = enabledIds?.some((id) => availableModelIds.has(id)) ?? false;
		const allAvailableModelsEnabled =
			enabledIds !== null && [...availableModelIds].every((id) => enabledIds.includes(id));
		if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
			const newScopedModels = resolveModelScopeFromModels(enabledIds, availableModels).scopedModels;
			session.setScopedModels(
				newScopedModels.map((scoped) => ({
					model: scoped.model,
					thinkingLevel: scoped.thinkingLevel,
				})),
			);
		} else {
			session.setScopedModels([]);
		}
		applied();
	};

	return {
		models: () => availableModels,
		enabledIds: () => currentEnabledIds,
		change: (enabledIds) => {
			selectionChanged = true;
			updateSessionModels(enabledIds);
		},
		persist: (enabledIds) => {
			const allEnabled =
				enabledIds !== null &&
				enabledIds.length === availableModels.length &&
				enabledIds.every((id) => availableModelIds.has(id));
			const newPatterns = enabledIds === null || allEnabled ? undefined : enabledIds;
			settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
		},
		refresh: () => {
			let timedOut = false;
			// Closed before the catalogs answered: the session's scope is left as it is, as the terminal's was.
			let stopped = false;
			const controller = new AbortController();
			const timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, 15_000);
			const done = refreshModelCatalogs(session.modelRuntime, controller.signal)
				.then((result): ScopedModelsRefresh => {
					if (stopped) return { status: "", kind: "warning", reset: false };
					availableModels = [...session.modelRuntime.getAvailableSnapshot()];
					availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
					const reset = !selectionChanged && sessionScopedModels.length === 0;
					if (reset) currentEnabledIds = configuredEnabledIds(availableModels);
					if (currentEnabledIds !== null) updateSessionModels(currentEnabledIds);
					if (result.aborted && timedOut) {
						return { status: "Model refresh timed out; showing cached models.", kind: "warning", reset };
					}
					if (result.errors.size > 0) {
						return {
							status: withReloginNote(
								`Could not refresh ${[...result.errors.keys()].join(", ")}; showing cached models.`,
								result.errors.values(),
							),
							kind: "warning",
							reset,
						};
					}
					return { status: "Model catalogs refreshed.", kind: "success", reset };
				})
				.catch(
					(error: unknown): ScopedModelsRefresh => ({
						status: timedOut
							? "Model refresh timed out; showing cached models."
							: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
						kind: "warning",
						reset: false,
					}),
				)
				.finally(() => clearTimeout(timeout));
			return {
				done,
				abort: () => {
					stopped = true;
					clearTimeout(timeout);
					controller.abort();
				},
			};
		},
	};
}

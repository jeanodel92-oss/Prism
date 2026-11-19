import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { lowThresholdWarning } from "./compaction-threshold.ts";

export function getCompactionThresholdWarning(settings: SettingsManager, model?: Model<string>): string | undefined {
	if (!model) return undefined;
	const compaction = settings.getCompactionSettings(model);
	return lowThresholdWarning(
		model.contextWindow,
		compaction.reserveTokens,
		compaction.keepRecentTokens,
		compaction.thresholdPercent,
		model.maxTokens,
	);
}

export function getCompactionThresholdStartupDiagnostic(
	settings: SettingsManager,
	model?: Model<string>,
): AgentSessionRuntimeDiagnostic[] {
	const message = getCompactionThresholdWarning(settings, model);
	return message ? [{ type: "warning", message }] : [];
}

export function createCompactionThresholdModelChangeWarning(
	settings: SettingsManager,
	onWarning: (message: string) => void,
	initialModel?: Model<string>,
): (model: Model<string>) => void {
	const warnedModels = new Set<string>();
	if (initialModel && getCompactionThresholdWarning(settings, initialModel)) {
		warnedModels.add(`${initialModel.provider}/${initialModel.id}`);
	}
	return (model) => {
		const key = `${model.provider}/${model.id}`;
		if (warnedModels.has(key)) return;
		const message = getCompactionThresholdWarning(settings, model);
		if (!message) return;
		warnedModels.add(key);
		onWarning(message);
	};
}

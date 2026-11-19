import type { Model } from "@earendil-works/pi-ai";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../core/settings-manager.ts";
import { getCompactionThresholdTokens, lowThresholdWarning } from "./compaction-threshold.ts";
import { getCompactionThresholdWarning } from "./compaction-threshold-warning.ts";
import { SETTING_DESCRIPTIONS } from "./settings-descriptions.ts";
import { paged } from "./settings-pages.ts";

/** fork: this submenu saves its choice before returning its effective label. */
export function createCompactionThresholdSetting(settings: SettingsManager, model?: Model<string>): SettingItem {
	const format = (percent: number | undefined): string => {
		const label = percent === undefined ? "Default" : `${percent}%`;
		if (!model) return label;
		const tokens = getCompactionThresholdTokens(
			model.contextWindow,
			settings.getCompactionReserveTokens(model),
			percent,
			model.maxTokens,
		);
		const capped = percent !== undefined && tokens < (model.contextWindow * percent) / 100;
		const cap = capped ? `capped at ${Math.floor((tokens / model.contextWindow) * 1000) / 10}%; ` : "";
		// The warning for this percentage, not the saved one: each choice in the submenu shows its own.
		const warning = lowThresholdWarning(
			model.contextWindow,
			settings.getCompactionReserveTokens(model),
			settings.getCompactionKeepRecentTokens(model),
			percent,
			model.maxTokens,
		);
		// Short and first, so it survives truncation in narrow terminals; the description has the full text.
		const low = warning ? " too low, nothing to summarize" : "";
		return `${label}${low} (${cap}compacts at ~${Math.round(tokens).toLocaleString("en-US")} of ${model.contextWindow.toLocaleString("en-US")} tokens)`;
	};
	const warning = getCompactionThresholdWarning(settings, model);
	return {
		id: "compaction-threshold",
		label: "Auto-compact threshold",
		description: warning
			? `${SETTING_DESCRIPTIONS["compaction-threshold"]} ${warning}`
			: SETTING_DESCRIPTIONS["compaction-threshold"],
		currentValue: format(settings.getCompactionThresholdPercent()),
		// a page, which the Prism window draws too.
		...paged((_value, done) => {
			const current = settings.getCompactionThresholdPercent();
			const choices = [
				...new Set([undefined, 50, 60, 70, 80, 85, 90, 95, ...(current === undefined ? [] : [current])]),
			];
			return {
				kind: "select",
				title: "Auto-compact threshold",
				description: SETTING_DESCRIPTIONS["compaction-threshold"],
				options: choices.map((percent) => ({
					value: percent === undefined ? "Default" : String(percent),
					label: percent === undefined ? "Default" : `${percent}%`,
					description: format(percent),
				})),
				current: current === undefined ? "Default" : String(current),
				onSelect: (value) => {
					const percent = value === "Default" ? undefined : Number(value);
					settings.setCompactionThresholdPercent(percent);
					done(format(percent));
				},
				onCancel: () => done(),
			};
		}),
	};
}

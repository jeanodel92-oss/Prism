/**
 * fork: the Models domain of `/settings`: the default model,
 * the default thinking level and the models of the Ctrl+P cycle. The per-model thinking levels come from the
 * upstream selector ("model-thinking"); each model's own page is added by model-settings.ts.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingItem } from "@earendil-works/pi-tui";
import { theme } from "../modes/interactive/theme/theme.ts";
import { t } from "./i18n/index.ts";
import { SETTING_DESCRIPTIONS } from "./settings-descriptions.ts";
import { paged } from "./settings-pages.ts";

export interface ModelsSettings {
	/** Models with credentials, as `/model` lists them. */
	models: Model<Api>[];
	/** The saved default, as "provider/id", or undefined when none is saved. */
	defaultModel?: string;
	/** fork: the saved default as it is now, for the pages that remove models. */
	savedDefault?(): { provider: string; id: string } | undefined;
	onDefaultModel(model: Model<Api>): void;
	thinkingLevel: ThinkingLevel;
	thinkingLevels: readonly ThinkingLevel[];
	onThinkingLevel(level: ThinkingLevel): void;
	/** How many models the Ctrl+P cycle holds, or undefined when it holds them all. */
	cycleCount?: number;
}

export const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

/** The domain's own settings, in display order. */
export function modelsItems(settings: ModelsSettings): SettingItem[] {
	const items: SettingItem[] = [
		{
			id: "default-model",
			label: "Default model",
			description: SETTING_DESCRIPTIONS["default-model"],
			currentValue: settings.defaultModel ?? "not set",
			// a page, which the Prism window draws too.
			...paged((current, done) => ({
				kind: "select",
				title: t("Default model"),
				description: t("Type to filter. Enter saves it as the default."),
				options: settings.models.map((model) => ({
					value: modelKey(model),
					label: `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`,
				})),
				current,
				onSelect: (value) => done(value),
				onCancel: () => done(),
				selectOptions: { searchable: true },
			})),
		},
		{
			id: "default-thinking",
			label: "Thinking level",
			description: SETTING_DESCRIPTIONS["default-thinking"],
			currentValue: settings.thinkingLevel,
			values: [...settings.thinkingLevels],
		},
	];
	const total = settings.models.length;
	// Translated when drawn (fr.ts patterns), like every value the window shows.
	const cycle =
		settings.cycleCount === undefined
			? total === 1
				? "1 model"
				: `all ${total} models`
			: `${settings.cycleCount} of ${total} models`;
	// Opens the `/scoped-models` selector (closing Settings), which keeps its own catalog refresh.
	items.push({
		id: "command:scoped-models",
		label: "Models in the cycle",
		description: SETTING_DESCRIPTIONS["scoped-models"],
		currentValue: cycle,
		values: [cycle],
	});
	return items;
}

/** Applies a change of the domain's own settings; false when `id` is not one of them. */
export function changeModelsSetting(settings: ModelsSettings, id: string, value: string): boolean {
	if (id === "default-model") {
		const model = settings.models.find((candidate) => modelKey(candidate) === value);
		if (model) settings.onDefaultModel(model);
		return true;
	}
	if (id === "default-thinking") {
		const level = settings.thinkingLevels.find((candidate) => candidate === value);
		if (level) settings.onThinkingLevel(level);
		return true;
	}
	return false;
}

/**
 * fork: `/settings` grouped by domain, with an advanced mode.
 *
 * The upstream selector still builds its flat list of items and its change handler; this module
 * only regroups those items into domains, which the `/settings` overlay draws (settings-view.ts).
 * Technical settings are hidden until the advanced interface is chosen. Fork-only domains: the
 * built-in extensions (the permission gate is not one of them: it is a protection, not an option), the
 * interface itself, and Models, Permissions & sandbox and Servers. Built-in extensions add their
 * settings to a domain through settings-sections.ts; Other ends with shortcuts to the action commands.
 */
import type { SettingItem } from "@earendil-works/pi-tui";
import type { InterfaceMode, SettingsManager } from "../core/settings-manager.ts";
import type { AnimationStyles } from "./animations.ts";
import { type FeatureState, MODULE_COMMANDS, stateSentence, stateTag } from "./feature-state.ts";
import { saveGlobalSetting } from "./global-settings.ts";
import { fill, type LanguageSetting, t } from "./i18n/index.ts";
import { ModuleCostView, moduleCostPage } from "./module-cost-view.ts";
import { automaticModelCatalogRefresh, MODEL_CATALOG_REFRESH_SETTING } from "./policy.ts";
import { UPDATE_MODE_SETTING, type UpdateMode, updateMode } from "./self-update.ts";
import { animationsSetting } from "./settings-animations.ts";
import { EXTENSION_DESCRIPTIONS, EXTENSION_LABELS, SETTING_DESCRIPTIONS } from "./settings-descriptions.ts";
import { changeModelsSetting, type ModelsSettings, modelKey, modelsItems } from "./settings-models.ts";
import { paged, withPage } from "./settings-pages.ts";
import { type SectionContext, type SettingsSection, settingsSections } from "./settings-sections.ts";
import { ThemeEditor, type ThemeEditorHost } from "./theme-editor.ts";
import {
	isWebSearchProvider,
	WEB_SEARCH_KEY_ENV,
	WEB_SEARCH_NAMES,
	WEB_SEARCH_PROVIDERS,
	type WebSearchProvider,
} from "./web-search-config.ts";

/** One built-in extension as `/settings` shows it. */
export interface BuiltinExtensionSetting {
	name: string;
	enabled: boolean;
}

export interface SettingsDomainExtras {
	compactionSettings?: SettingsManager; // fork: persistent global threshold
	builtinExtensions: BuiltinExtensionSetting[];
	getModuleCostConfiguration?: () => { modules: BuiltinExtensionSetting[]; globalExtensions: string[] };
	requestRender?: () => void;
	onBuiltinExtensionChange: (name: string, enabled: boolean) => void;
	/** fork: whether a module now differs from when Settings opened, so closing applies it. */
	builtinExtensionsChanged?: () => boolean;
	/** fork: each module's state in this session (off, unavailable, not supported by the model). */
	featureState?: (module: string) => FeatureState;
	/** Web search key state, or undefined when the web extension is off. */
	/** `provider` is undefined when settings.json holds an unsupported value. */
	webSearch?: { provider: WebSearchProvider | undefined; keySource: "auth" | "env" | "none"; url?: string };
	onWebSearchProvider?: (provider: WebSearchProvider) => void;
	onWebSearchKey?: (action: "set" | "remove") => void;
	/** fork: whether the startup logo is drawn in, shown in the Appearance domain. */
	animations?: boolean;
	onAnimationsChange?: (enabled: boolean) => void;
	/** fork: the theme editor's link to the interactive mode, and the name of the theme in use. */
	themeEditor?: ThemeEditorHost & { active(): string };
	/** fork: the animations turned off one by one. */
	animationsOff?: string[];
	onAnimationsOffChange?: (ids: string[]) => void;
	animationStyles?: AnimationStyles;
	onAnimationStylesChange?: (styles: AnimationStyles) => void;
	showLocalCloudWarning?: boolean;
	onShowLocalCloudWarningChange?: (enabled: boolean) => void;
	traceEnabled?: boolean;
	traceRetentionDays?: number;
	onTraceEnabledChange?: (enabled: boolean) => void;
	onTraceRetentionDaysChange?: (days: number) => void;
	/** fork: the `replyLanguage` setting, or undefined to leave it out. */
	replyLanguage?: string;
	onReplyLanguageChange?: (language: string) => void;
	/** fork: the saved interface mode; advanced also shows technical settings. */
	interfaceMode?: InterfaceMode;
	onInterfaceModeChange?: (mode: InterfaceMode) => void;
	/** fork: the interface language setting ("auto", "en" or "fr"), or undefined to leave it out. */
	language?: string;
	onLanguageChange?: (language: LanguageSetting) => void;
	/** where a plain `prism` opens and the applications-menu entry; undefined without a window. */
	openIn?: "terminal" | "window";
	onOpenInChange?: (value: "terminal" | "window") => void;
	applicationsMenu?: boolean;
	onApplicationsMenuChange?: (enabled: boolean) => void;
	/**
	 * fork: action commands listed at the end of their domain, Other when none is given; a row runs the
	 * command (closing Settings first).
	 */
	commands?: Array<{ command: string; label: string; description: string; domain?: string }>;
	/** fork: with the domain and row it was chosen from, to come back to them. */
	onRunCommand?: (command: string, from?: { domain: string; item: string }) => void;
	/** fork: the terminal's height, read at each render of the window, and the domain shown first. */
	rows?: () => number;
	startDomain?: string;
	/** fork: the setting to focus in the start domain, and whether to open it (its page or its menu). */
	startItem?: string;
	openStartItem?: boolean;
	/** fork: the Models domain's own settings, or undefined to leave them out. */
	models?: ModelsSettings;
	/** fork: the sections built-in extensions add; settings-sections.ts by default. */
	sections?: () => SettingsSection[];
}

interface Domain {
	id: string;
	label: string;
	description: string;
	settings: string[];
}

/**
 * Setting ids per domain, in display order (the order of the approved mockup). Ids not listed here land in
 * "Other". Sections of built-in extensions (settings-sections.ts) follow a domain's own settings.
 */
const DOMAINS: Domain[] = [
	{
		id: "appearance",
		label: "Appearance",
		description: "Colors, thinking text, diagrams, startup messages and spacing",
		settings: [
			"theme",
			"theme-customize",
			"animations",
			"hide-thinking",
			"mermaid-rendering",
			"show-images",
			"image-width-cells",
			"quiet-startup",
			"editor-padding",
			"output-padding",
			"autocomplete-max-visible",
			"show-hardware-cursor",
		],
	},
	{
		id: "conversation",
		label: "Conversation",
		description:
			"Auto-compact conversation (summaries of older messages), reply language, queued messages (sent while or after working), Escape and /tree history",
		settings: [
			"autocompact",
			"compaction-threshold",
			"reply-language",
			"steering-mode",
			"follow-up-mode",
			"double-escape-action",
			"tree-filter-mode",
			"skill-commands",
		],
	},
	{
		id: "models",
		label: "Models",
		description: "The model used by default, the Ctrl+P cycle and each model's settings",
		settings: ["default-model", "default-thinking", "model-thinking", "command:scoped-models"],
	},
	{
		id: "permissions",
		label: "Permissions & sandbox",
		description: "What the agent may do without asking, and where its commands run",
		settings: [],
	},
	{
		id: "terminal",
		label: "Terminal",
		description: "Fullscreen or regular mode, scrolling, selection and terminal integration",
		settings: [
			"tui-mode",
			"fullscreen-scrollbar",
			"fullscreen-copy-on-select",
			"fullscreen-wheel-scroll-lines",
			"fullscreen-exit-output",
			"clear-on-shrink",
			"terminal-progress",
		],
	},
	{
		id: "privacy",
		label: "Images & privacy",
		description: "Images sent to model services or servers, and trust for project folders",
		settings: [
			"block-images",
			"auto-resize-images",
			"default-project-trust",
			"trace-enabled",
			"trace-retention-days",
		],
	},
	{
		id: "network",
		label: "Network & web",
		description:
			"Connection method, response wait limits, keeping sent text cached for reuse, and the web search service",
		settings: [
			"transport",
			"http-idle-timeout",
			"cache-warming-mode",
			"web-search-provider",
			"web-search-key",
			"web-search-url",
			"model-catalog-refresh",
		],
	},
	{
		id: "notifications",
		label: "Notifications",
		description: "Warnings, notices, the changelog and desktop notifications",
		settings: ["warnings", "cache-miss-notices", "local-cloud-warning", "collapse-changelog"],
	},
	{
		id: "servers",
		label: "Servers",
		description: "Language servers and MCP servers, and whether each one is used",
		settings: [],
	},
];

/** fork: the modules shown in Computer use rather than Modules. */
const COMPUTER_USE_MODULES = new Set(["browser", "desktop", "user-desktop"]);

/** Technical settings, shown only in advanced mode (the "All settings" list always has them). */
export const ADVANCED_SETTINGS = new Set([
	"transport",
	"model-catalog-refresh",
	"http-idle-timeout",
	"cache-warming-mode",
	"clear-on-shrink",
	"terminal-progress",
	"show-hardware-cursor",
	"autocomplete-max-visible",
	"editor-padding",
	"output-padding",
	"fullscreen-exit-output",
	"fullscreen-wheel-scroll-lines",
	"tree-filter-mode",
	"cache-miss-notices",
	"collapse-changelog",
	"skill-commands",
	// not needed to start, and unclear to someone who never used an agent.
	"steering-mode",
	"follow-up-mode",
	"double-escape-action",
	"trace-enabled",
	"trace-retention-days",
	"model-thinking",
	"command:scoped-models",
	// Simple keeps what changes a newcomer's experience.
	"mermaid-rendering",
	"quiet-startup",
	"budget-default-time",
	"budget-default-tools",
	"budget-default-tokens",
	"budget-default-cost",
	"handoff-reminder",
	"handoff-reminder-interval",
	"command:skills",
	"command:perm window",
	"command:perm scope",
	"perm-project",
	"fullscreen-scrollbar",
	"auto-resize-images",
	"warnings",
	"notify-test",
	"command:budget",
	"command:llama",
	...[
		"llama.cpp",
		"codemode",
		"tool-search",
		"trace",
		"budgets",
		"prism",
		"lsp-setup",
		"machine-context",
		"project-continuity",
		"background",
		"session-state",
		"append-system",
		"agents",
		"skills",
		"config-tool",
		"pi-context-inspector",
		"capability-gates",
		// Also set in Notifications, Permissions & sandbox and Conversation.
		"notify",
		"injection-warning",
		"reply-language",
	].map((name) => `builtin:${name}`),
]);

/** the update modes as /settings lists them. */
const UPDATE_MODE_VALUES: Record<UpdateMode, string> = { manual: "manual", notify: "notify me", auto: "automatic" };

/** fork: the Language values, each language named in itself, and the setting they save. */
const LANGUAGE_VALUES: Record<string, LanguageSetting> = { auto: "auto", English: "en", Français: "fr" };

/**
 * fork: the item as shown, read when drawn: its label and description in the interface language
 * (fork/i18n), and a shown-only value too. A proxy, not a copy: the view writes the new value on the shared item.
 */
export function shown(item: SettingItem): SettingItem {
	return new Proxy(item, {
		get: (target, key) => {
			if (key === "label") return t(target.label);
			// A value that is only shown (an item that opens a submenu); values chosen in place keep the saved text.
			if (key === "currentValue" && !target.values) return t(target.currentValue);
			if (key === "description") return target.description === undefined ? undefined : t(target.description);
			return Reflect.get(target, key);
		},
	});
}

/** `advanced`: whether the advanced interface is shown now (the module's own name only there). */
function extensionItems(extras: SettingsDomainExtras, advanced: () => boolean): SettingItem[] {
	const items: SettingItem[] = extras.builtinExtensions.map((extension) => {
		// fork: why a module that is on does nothing here, then the commands it adds, which search finds.
		const state = extras.featureState?.(extension.name);
		const commands = MODULE_COMMANDS[extension.name]?.map((command) => `/${command}`).join(", ");
		const item: SettingItem = {
			id: `builtin:${extension.name}`,
			// the module's name in words; its own name ends the description, where search finds it.
			label: EXTENSION_LABELS[extension.name] ?? extension.name,
			currentValue: extension.enabled ? "on" : "off",
			values: ["on", "off"],
		};
		// Read when drawn: the interface mode can change while Settings is open.
		Object.defineProperty(item, "description", {
			get: () =>
				[
					state && stateSentence(state),
					// fork.9 QA: each part in the interface language; the whole sentence is in no catalog.
					EXTENSION_DESCRIPTIONS[extension.name]
						? t(EXTENSION_DESCRIPTIONS[extension.name]!)
						: fill("Included add-on (builtin:{0}).", extension.name),
					commands && fill("Commands: {0}.", commands),
					t("Applies when you close Settings."),
					// an internal name, not for the simple interface.
					advanced() && EXTENSION_LABELS[extension.name] && fill("Module: {0}.", extension.name),
				]
					.filter(Boolean)
					.join(" "),
			enumerable: true,
		});
		return item;
	});
	// fork: an advanced, on-demand tool, shown like the other advanced settings.
	if (extras.getModuleCostConfiguration) {
		items.push({
			id: "module-cost",
			label: "Measure module cost",
			description: t("Measure prompt, startup, memory and child processes on demand."),
			currentValue: "›",
			submenu: (_value, done) => {
				const configuration = extras.getModuleCostConfiguration?.();
				return new ModuleCostView(
					configuration?.modules ?? extras.builtinExtensions,
					configuration?.globalExtensions ?? [],
					done,
					extras.requestRender ?? (() => {}),
				);
			},
			// the window's page, with the same measurement.
			...withPage((value, done) => {
				const configuration = extras.getModuleCostConfiguration?.();
				return moduleCostPage(
					configuration?.modules ?? extras.builtinExtensions,
					configuration?.globalExtensions ?? [],
					extras.requestRender ?? (() => {}),
				)(value, done);
			}),
		});
	}
	return items;
}

function webSearchChoice(
	id: string,
	label: string,
	description: string,
	currentValue: string,
	choices: string[],
): SettingItem {
	return {
		id,
		label,
		description,
		currentValue,
		// a page, which the Prism window draws too.
		...paged((_value, done) => ({
			kind: "rows",
			title: label,
			description,
			items: choices.map((choice) =>
				shown({ id: choice, label: choice, currentValue: "select", values: ["select"] }),
			),
			onChange: (choice) => done(choice),
			onClose: () => done(),
		})),
	};
}

function webSearchItems(webSearch: NonNullable<SettingsDomainExtras["webSearch"]>): SettingItem[] {
	const provider = webSearch.provider;
	const providerItem = webSearchChoice(
		"web-search-provider",
		"Provider",
		SETTING_DESCRIPTIONS["web-search-provider"]!,
		provider ?? "unsupported value",
		[...WEB_SEARCH_PROVIDERS],
	);
	if (!provider) return [providerItem];
	if (provider === "searxng") {
		return [
			providerItem,
			webSearchChoice(
				"web-search-url",
				"SearXNG URL",
				SETTING_DESCRIPTIONS["web-search-url"]!,
				webSearch.url ?? "missing",
				["set a URL", "remove"],
			),
		];
	}
	const value =
		webSearch.keySource === "env"
			? WEB_SEARCH_KEY_ENV[provider]
			: webSearch.keySource === "auth"
				? "saved key"
				: provider === "exa"
					? "none (public endpoint)"
					: "missing";
	return [
		providerItem,
		webSearchChoice(
			"web-search-key",
			`${WEB_SEARCH_NAMES[provider]} API key`,
			SETTING_DESCRIPTIONS[provider === "exa" ? "web-search-key-exa" : "web-search-key"]!,
			value,
			["set a key", "remove"],
		),
	];
}

/** fork: one domain of `/settings` as the overlay shows it. */
export interface SettingsDomain {
	id: string;
	label: string;
	description: string;
	/** Every setting of the domain is advanced: the simple interface leaves the domain out. */
	advancedOnly: boolean;
	/** How many settings the domain has in the advanced interface. */
	size: number;
	/** The domain's settings in the current interface mode, translated when drawn. */
	items(): SettingItem[];
	/** fork: rows only the search shows, such as one model's setting, which open the right page. */
	searchItems(): SettingItem[];
}

/** fork: what the `/settings` overlay draws and changes. */
export interface SettingsModel {
	/** The domains in the current interface mode, in display order. */
	domains(): SettingsDomain[];
	onChange(id: string, value: string): void | Promise<void>;
	isAdvanced(): boolean;
	/** Whether a setting is shown only in the advanced interface. */
	isAdvancedSetting(id: string): boolean;
	/** fork: the mark after a module's switch when it is unavailable or not supported by the model. */
	stateTag?(id: string): string | undefined;
	/** Settings shown in the current interface mode, and in all. */
	counts(): { shown: number; total: number };
}

/**
 * The compaction threshold's description ends with the value in effect, so it stays readable when the row
 * truncates it. fork: both parts are translated when read; translating the joined text would miss,
 * since the catalog has the description as one entry and the value as a pattern.
 */
function withEffectiveValue(item: SettingItem): SettingItem {
	const copy = { ...item };
	Object.defineProperty(copy, "description", {
		get: () => `${t(SETTING_DESCRIPTIONS[item.id] ?? "")} ${t(`Effective: ${t(copy.currentValue)}.`)}`,
		enumerable: true,
	});
	return copy;
}

/**
 * The domains of `/settings`, then the fork domains (Modules, Tools, Interface), with the change handler for
 * every setting. `onChange` is the upstream handler; fork ids (`builtin:*`, web search, animations, interface,
 * language, …) are handled here. the overlay's search replaces the former "All settings" list.
 */
export function groupSettingsByDomain(
	upstreamItems: SettingItem[],
	onChange: (id: string, value: string) => void,
	extras: SettingsDomainExtras,
): SettingsModel {
	let advanced = extras.interfaceMode === "advanced";
	// fork: concrete descriptions (settings-descriptions.ts) over the upstream ones.
	const described: SettingItem[] = upstreamItems.map((item) =>
		item.id === "compaction-threshold"
			? withEffectiveValue(item)
			: { ...item, description: SETTING_DESCRIPTIONS[item.id] ?? item.description },
	);
	const items =
		extras.animations === undefined
			? described
			: [
					...described,
					// fork: the global switch and one per animation, with a preview.
					animationsSetting({
						enabled: extras.animations,
						off: extras.animationsOff ?? [],
						styles: extras.animationStyles,
						onStylesChange: (styles) => extras.onAnimationStylesChange?.(styles),
						onEnabledChange: (enabled) => extras.onAnimationsChange?.(enabled),
						onOffChange: (ids) => extras.onAnimationsOffChange?.(ids),
						requestRender: () => extras.requestRender?.(),
					}),
				];
	// fork: the theme editor, which edits a copy of the theme in use.
	const themeEditor = extras.themeEditor;
	if (themeEditor) {
		items.push({
			id: "theme-customize",
			label: "Customize theme",
			description: SETTING_DESCRIPTIONS["theme-customize"]!,
			currentValue: themeEditor.active(),
			submenu: (_value, done) =>
				new ThemeEditor({
					host: themeEditor,
					active: themeEditor.active(),
					requestRender: () => extras.requestRender?.(),
					done: () => done(themeEditor.active()),
				}),
		});
	}
	if (extras.showLocalCloudWarning !== undefined) {
		items.push({
			id: "local-cloud-warning",
			label: "Local to cloud warning",
			description: SETTING_DESCRIPTIONS["local-cloud-warning"] ?? "",
			currentValue: extras.showLocalCloudWarning ? "on" : "off",
			values: ["on", "off"],
		});
	}
	if (extras.traceEnabled !== undefined) {
		items.push({
			id: "trace-enabled",
			label: "Operation trace",
			description: SETTING_DESCRIPTIONS["trace-enabled"]!,
			currentValue: extras.traceEnabled ? "on" : "off",
			values: ["on", "off"],
		});
		items.push({
			id: "trace-retention-days",
			label: "Trace retention (days)",
			description: SETTING_DESCRIPTIONS["trace-retention-days"]!,
			currentValue: String(extras.traceRetentionDays ?? 7),
			values: [...new Set(["1", "7", "14", "30", String(extras.traceRetentionDays ?? 7)])],
		});
	}
	// fork: the reply language; another language can be written in settings.json.
	if (extras.replyLanguage !== undefined) {
		items.push({
			id: "reply-language",
			label: "Reply language",
			description: SETTING_DESCRIPTIONS["reply-language"] ?? "",
			currentValue: extras.replyLanguage,
			values: [...new Set(["auto", "English", "French", extras.replyLanguage])],
		});
	}
	// fork: the Models domain's own settings, and the web search rows (Network & web).
	if (extras.models) items.push(...modelsItems(extras.models));
	if (extras.webSearch) items.push(...webSearchItems(extras.webSearch));
	// the pi.dev catalog refreshes, on by default.
	items.push({
		id: "model-catalog-refresh",
		label: "Update the model catalog",
		description:
			"Downloads the list of each signed-in provider's models from pi.dev (the site of pi, which Prism is built on) at startup, in /model and after /login, at most every 4 hours, so new models appear without a Prism update. Off, only prism update --models downloads it.",
		currentValue: automaticModelCatalogRefresh() ? "on" : "off",
		values: ["on", "off"],
	});
	// how Prism updates itself; manual by default. In Other.
	items.push({
		id: "update-mode",
		label: "Updates",
		description:
			"When Prism looks for a newer version of itself on its site. Manual asks nothing until you run /update; the other choices check at most once an hour.",
		currentValue: UPDATE_MODE_VALUES[updateMode()],
		values: Object.values(UPDATE_MODE_VALUES),
	});
	const byId = new Map(items.map((item) => [item.id, item]));
	const listed = new Set(DOMAINS.flatMap((domain) => domain.settings));
	const other = items.filter((item) => !listed.has(item.id)).map((item) => item.id);

	// Sections of built-in extensions, built when Settings opens and again after one of their settings changes,
	// so a redraw never reads their files.
	const sections = (extras.sections ?? settingsSections)().map((section) => ({
		section,
		cached: undefined as SettingItem[] | undefined,
		searched: undefined as SettingItem[] | undefined,
	}));
	const models = extras.models;
	const context: SectionContext = {
		advanced: () => advanced,
		requestRender: () => extras.requestRender?.(),
		// fork: a model page that removes the default offers another one; the domain's row follows.
		defaultModel: models?.savedDefault
			? {
					get: models.savedDefault,
					set: (model) => {
						models.onDefaultModel(model);
						const row = byId.get("default-model");
						if (row) row.currentValue = modelKey(model);
					},
				}
			: undefined,
	};
	const sectionItems = (entry: (typeof sections)[number]) => {
		entry.cached ??= entry.section.items(context);
		return entry.cached;
	};
	const sectionSearchItems = (entry: (typeof sections)[number]) => {
		entry.searched ??= entry.section.searchItems?.(context) ?? [];
		return entry.searched;
	};
	const owner = (id: string) =>
		sections.find(
			(entry) =>
				sectionItems(entry).some((item) => item.id === id) ||
				sectionSearchItems(entry).some((item) => item.id === id),
		);

	const handle = (id: string, value: string) => {
		if (id === "interface-mode") {
			advanced = value === "advanced";
			extras.onInterfaceModeChange?.(advanced ? "advanced" : "simple");
		} else if (id.startsWith("builtin:")) {
			extras.onBuiltinExtensionChange(id.slice("builtin:".length), value === "on");
		} else if (id === "animations") {
			extras.onAnimationsChange?.(value === "on");
		} else if (id === "local-cloud-warning") {
			extras.onShowLocalCloudWarningChange?.(value === "on");
		} else if (id === "trace-enabled") {
			extras.onTraceEnabledChange?.(value === "on");
		} else if (id === "trace-retention-days") {
			extras.onTraceRetentionDaysChange?.(Number(value));
		} else if (id === "reply-language") {
			extras.onReplyLanguageChange?.(value);
		} else if (id === "language") {
			extras.onLanguageChange?.(LANGUAGE_VALUES[value] ?? "auto");
		} else if (id === "open-in" && (value === "terminal" || value === "window")) {
			extras.onOpenInChange?.(value);
		} else if (id === "model-catalog-refresh") {
			saveGlobalSetting([MODEL_CATALOG_REFRESH_SETTING], value === "off" ? false : undefined);
		} else if (id === "update-mode") {
			const mode = (Object.keys(UPDATE_MODE_VALUES) as UpdateMode[]).find(
				(key) => UPDATE_MODE_VALUES[key] === value,
			);
			saveGlobalSetting([UPDATE_MODE_SETTING], mode === "manual" ? undefined : mode);
		} else if (id === "applications-menu") {
			extras.onApplicationsMenuChange?.(value === "on");
		} else if (id === "compaction-threshold") {
			// The submenu persists the choice; the description shows the new value (withEffectiveValue).
			const item = byId.get(id);
			if (item) item.currentValue = value;
		} else if (id.startsWith("command:")) {
			const from = domains.find((d) => d.items().some((item) => item.id === id))?.id;
			extras.onRunCommand?.(id.slice("command:".length), from ? { domain: from, item: id } : undefined);
		} else if (id === "web-search-provider" && isWebSearchProvider(value)) {
			extras.onWebSearchProvider?.(value);
		} else if (id === "web-search-key" || id === "web-search-url") {
			if (value === "remove") extras.onWebSearchKey?.("remove");
			else if (value === "set a key" || value === "set a URL") extras.onWebSearchKey?.("set");
		} else if (extras.models && changeModelsSetting(extras.models, id, value)) {
			// Handled by the Models domain.
		} else {
			const entry = owner(id);
			if (!entry) {
				onChange(id, value);
				return;
			}
			const saved = entry.section.onChange?.(id, value);
			if (saved instanceof Promise) {
				return saved.then(() => {
					entry.cached = undefined;
					entry.searched = undefined;
					extras.requestRender?.();
				});
			}
			entry.cached = undefined;
			entry.searched = undefined;
		}
	};

	const isAdvancedSetting = (id: string) =>
		ADVANCED_SETTINGS.has(id) ||
		// Exa works without a key; the other services' key stays in Simple, they need it.
		(id === "web-search-key" && extras.webSearch?.provider === "exa") ||
		id === "module-cost" ||
		sections.some((entry) => entry.section.isAdvanced?.(id) === true);
	// the simple interface neither shows nor changes advanced settings.
	const inThisMode = (list: SettingItem[]) =>
		(advanced ? list : list.filter((item) => !isAdvancedSetting(item.id))).map((item) => shown(item));
	const fromIds = (ids: string[]) =>
		ids.map((id) => byId.get(id)).filter((item): item is SettingItem => item !== undefined);
	const ofDomain = (id: string) => sections.filter((entry) => entry.section.domain === id);
	const shortcuts = (id: string) =>
		(extras.commands ?? [])
			.filter((entry) => (entry.domain ?? "other") === id)
			.map(
				(entry): SettingItem => ({
					id: `command:${entry.command}`,
					label: entry.label,
					description: entry.description,
					currentValue: "open",
					values: ["open"],
				}),
			);
	const domain = (
		id: string,
		label: string,
		description: string,
		list: () => SettingItem[],
		search: () => SettingItem[] = () => [],
	): SettingsDomain => {
		const all = () => [...list(), ...ofDomain(id).flatMap(sectionItems), ...shortcuts(id)];
		return {
			id,
			label,
			description,
			get advancedOnly() {
				const current = all();
				return current.length > 0 && current.every((item) => isAdvancedSetting(item.id));
			},
			get size() {
				return all().length;
			},
			items: () => inThisMode(all()),
			searchItems: () => inThisMode([...search(), ...ofDomain(id).flatMap(sectionSearchItems)]),
		};
	};

	const domains: SettingsDomain[] = DOMAINS.map((d) =>
		domain(d.id, d.label, d.description, () => fromIds(d.settings)),
	);
	// the bundled add-ons in one domain (web search moved to Network & web). fork
	// the computer use modules in a domain of their own, with their settings and the browser's setup.
	const moduleItems = extensionItems(extras, () => advanced);
	const usesComputer = (item: SettingItem) => COMPUTER_USE_MODULES.has(item.id.slice("builtin:".length));
	domains.push(
		domain(
			"computer-use",
			"Computer use",
			"The agent using your browser, a desktop of its own or yours: each module, its settings and the browser's setup",
			() => moduleItems.filter(usesComputer),
		),
	);
	if (extras.builtinExtensions.length > 0) {
		const modules = moduleItems.filter((item) => !usesComputer(item));
		domains.push(
			domain(
				"modules",
				"Modules",
				"Bundled add-ons, each can be turned off. The permission system stays loaded; its settings are in Permissions & sandbox.",
				() => modules,
			),
		);
	}
	const interfaceItems: SettingItem[] = [
		{
			id: "interface-mode",
			label: "Interface",
			description:
				"Simple shows each action on one line and hides technical settings. Advanced shows every setting, and each action's command and output.",
			currentValue: advanced ? "advanced" : "simple",
			values: ["simple", "advanced"],
		},
	];
	if (extras.language !== undefined) {
		interfaceItems.push({
			id: "language",
			label: "Language",
			description: "The language of Prism's menus and messages.",
			currentValue: Object.entries(LANGUAGE_VALUES).find(([, code]) => code === extras.language)?.[0] ?? "auto",
			values: Object.keys(LANGUAGE_VALUES),
		});
	}
	if (extras.openIn !== undefined) {
		interfaceItems.push({
			id: "open-in",
			label: "Open Prism in",
			description:
				"Where a plain prism command opens. prism --tui and prism --gui choose for one launch; the window needs a graphical display.",
			currentValue: extras.openIn,
			values: ["window", "terminal"],
		});
	}
	if (extras.applicationsMenu !== undefined) {
		interfaceItems.push({
			id: "applications-menu",
			label: "Applications menu entry",
			description: "A Prism entry in your desktop's applications menu, which opens the window.",
			currentValue: extras.applicationsMenu ? "on" : "off",
			values: ["on", "off"],
		});
	}
	domains.push(
		domain("interface", "Interface", "Level of detail, language and where Prism opens", () => interfaceItems),
	);
	// Other holds the settings without a domain, then shortcuts to the action commands.
	domains.push(
		domain(
			"other",
			"Other",
			"Settings without a domain yet, then the commands that act rather than set something",
			() => fromIds(other),
		),
	);
	// A domain with nothing to set (its module is off) is left out.
	const present = () => domains.filter((d) => d.size > 0);

	return {
		domains: () => present().filter((d) => advanced || !d.advancedOnly),
		onChange: handle,
		isAdvanced: () => advanced,
		isAdvancedSetting,
		stateTag: (id) => {
			const state = id.startsWith("builtin:") ? extras.featureState?.(id.slice("builtin:".length)) : undefined;
			return state && stateTag(state);
		},
		counts: () => {
			const visible = present().filter((d) => advanced || !d.advancedOnly);
			return {
				shown: visible.reduce((n, d) => n + d.items().length, 0),
				total: present().reduce((n, d) => n + d.size, 0),
			};
		},
	};
}

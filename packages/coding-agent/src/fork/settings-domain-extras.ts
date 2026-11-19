/**
 * fork: the data and actions of the fork domains of `/settings`
 * , gathered by the interactive mode before it opens the selector.
 */
import type { SettingsManager } from "../core/settings-manager.ts";
import { builtInExtensions } from "../extensions/index.ts";
import type { FeatureState } from "./feature-state.ts";
import { resolveLanguage, setLanguage } from "./i18n/index.ts";
import { isNativeMenusClient, isPhoneClient } from "./interactive-client.ts";
import {
	hasDesktopEntry,
	launcherCommand,
	removeDesktopEntry,
	windowBinary,
	windowIcon,
	writeDesktopEntry,
} from "./launch-interface.ts";
import { setCloudWarningEnabled } from "./request-inspector.ts";
import { SETTINGS_SHORTCUTS } from "./settings-descriptions.ts";
import type { SettingsDomainExtras } from "./settings-domains.ts";
import type { ModelsSettings } from "./settings-models.ts";
import { resolveWebSearchKey } from "./web-search-config.ts";

const BUILTIN_PREFIX = "builtin:";

/** Names of the built-in extensions the `extensions` setting can turn on or off. */
export function builtinExtensionNames(): string[] {
	return builtInExtensions.flatMap((entry) =>
		typeof entry !== "function" && entry.builtin && entry.name !== "module-cost-probe" ? [entry.name] : [],
	);
}

/**
 * Turns a built-in extension on or off in the user `extensions` setting: any previous `+`, `-` or
 * `!` entry for it is replaced by one explicit entry. A project entry still overrides it.
 */
export function setBuiltinExtensionEnabled(settings: SettingsManager, name: string, enabled: boolean): void {
	const path = `${BUILTIN_PREFIX}${name}`;
	const current = settings.getGlobalSettings().extensions ?? [];
	const kept = current.filter((entry) => entry.replace(/^[+!-]/, "") !== path);
	settings.setExtensionPaths([...kept, `${enabled ? "+" : "-"}${path}`]);
}

/** the two launch settings, only when this installation has the window. */
function openInExtras(
	settings: SettingsManager,
): Pick<SettingsDomainExtras, "openIn" | "onOpenInChange" | "applicationsMenu" | "onApplicationsMenuChange"> {
	const binary = windowBinary();
	if (!binary) return {};
	return {
		openIn: settings.getOpenIn() ?? "terminal",
		onOpenInChange: (value) => settings.setOpenIn(value),
		applicationsMenu: hasDesktopEntry(),
		onApplicationsMenuChange: (enabled) => {
			if (enabled) writeDesktopEntry(launcherCommand(), windowIcon(binary));
			else removeDesktopEntry();
		},
	};
}

export async function createSettingsDomainExtras(options: {
	settings: SettingsManager;
	/** Extension paths loaded in this session (`builtin:<name>` for built-ins). */
	loadedExtensionPaths: string[];
	/** Whether `/web-key` exists, i.e. the web extension is loaded. */
	hasWebKeyCommand: boolean;
	onWebSearchKey: (action: "set" | "remove") => void;
	onWebSearchReload?: () => void;
	isWebSearchReloadBlocked?: () => boolean;
	requestRender?: () => void;
	onWebSearchNotify?: (message: string, type: "warning" | "error") => void;
	/** fork: whether a command exists in this session, and how to run one. */
	hasCommand?: (name: string) => boolean;
	onRunCommand?: (command: string, from?: { domain: string; item: string }) => void;
	/** fork: the Models domain's own settings. */
	models?: ModelsSettings;
	/** fork: each module's state in this session. */
	featureState?: (module: string) => FeatureState;
	/** fork: the theme editor's link to the interactive mode. */
	themeEditor?: SettingsDomainExtras["themeEditor"];
}): Promise<SettingsDomainExtras> {
	const loaded = new Set(options.loadedExtensionPaths);
	const modules = builtinExtensionNames().map((name) => ({ name, enabled: loaded.has(`${BUILTIN_PREFIX}${name}`) }));
	const chosen = new Map(modules.map((module) => [module.name, module.enabled]));
	const provider = options.settings.getWebSearchProvider();
	const keySource =
		options.hasWebKeyCommand && provider && provider !== "searxng"
			? (await resolveWebSearchKey(provider)).source
			: "none";
	return {
		compactionSettings: options.settings, // fork: selector supplies the current model
		builtinExtensions: modules,
		getModuleCostConfiguration: () => ({
			modules: modules.map((module) => ({ name: module.name, enabled: chosen.get(module.name) ?? module.enabled })),
			globalExtensions: options.settings.getGlobalSettings().extensions ?? [],
		}),
		requestRender: options.requestRender,
		onBuiltinExtensionChange: (name, enabled) => {
			chosen.set(name, enabled);
			setBuiltinExtensionEnabled(options.settings, name, enabled);
		},
		builtinExtensionsChanged: () => modules.some((module) => chosen.get(module.name) !== module.enabled),
		featureState: options.featureState,
		themeEditor: options.themeEditor,
		animations: options.settings.getAnimations(),
		replyLanguage: options.settings.getReplyLanguage(),
		onReplyLanguageChange: (language) => options.settings.setReplyLanguage(language),
		interfaceMode: options.settings.getInterfaceMode(),
		onInterfaceModeChange: (mode) => options.settings.setInterfaceMode(mode),
		language: options.settings.getLanguage(),
		onLanguageChange: (language) => {
			options.settings.setLanguage(language);
			setLanguage(resolveLanguage(language));
		},
		...openInExtras(options.settings),
		onAnimationsChange: (enabled) => options.settings.setAnimations(enabled),
		animationsOff: options.settings.getAnimationsOff(),
		onAnimationsOffChange: (ids) => options.settings.setAnimationsOff(ids),
		animationStyles: options.settings.getAnimationStyles(),
		onAnimationStylesChange: (styles) => options.settings.setAnimationStyles(styles),
		showLocalCloudWarning: options.settings.getShowLocalCloudWarning(),
		onShowLocalCloudWarningChange: (enabled) => {
			options.settings.setShowLocalCloudWarning(enabled);
			setCloudWarningEnabled(enabled);
		},
		traceEnabled: options.settings.getTraceEnabled(),
		traceRetentionDays: options.settings.getTraceRetentionDays(),
		onTraceEnabledChange: (enabled) => options.settings.setTraceEnabled(enabled),
		onTraceRetentionDaysChange: (days) => options.settings.setTraceRetentionDays(days),
		webSearch: options.hasWebKeyCommand
			? { provider, keySource, url: options.settings.getWebSearchUrl() }
			: undefined,
		onWebSearchProvider: async (provider) => {
			options.settings.setWebSearchProvider(provider);
			await options.settings.flush();
			if (options.settings.drainErrors().some(({ scope }) => scope === "global")) {
				options.onWebSearchNotify?.(
					"Could not save web search provider in settings.json. Check the file and try again.",
					"error",
				);
				return;
			}
			if (options.isWebSearchReloadBlocked?.()) {
				options.onWebSearchNotify?.(
					"Web search provider saved; change pending. Run /reload after the current response or compaction finishes to apply it.",
					"warning",
				);
				return;
			}
			options.onWebSearchReload?.();
		},
		onWebSearchKey: options.onWebSearchKey,
		// A shortcut may pass arguments ("browser setup"): the command is its first word.
		commands: SETTINGS_SHORTCUTS.filter(
			(entry) =>
				options.hasCommand?.(entry.command.split(" ")[0]!) === true &&
				!(entry.pcOnly && isPhoneClient()) &&
				!(entry.terminalOnly && isNativeMenusClient()),
		),
		onRunCommand: options.onRunCommand,
		models: options.models,
	};
}

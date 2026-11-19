// the operations behind `/settings`, shared by the terminal and the Prism window. Each callback
// saves its setting and applies it to the session, as the terminal always did; what only the terminal draws (its
// footer, chat, editor or renderer) is the host's `effects`, run after the operation. Neither host shares the
// other's components: the terminal draws the settings with SettingsView, the window with native screens.
import type { AgentSession } from "../core/agent-session.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../core/defaults.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";
import type { TuiMode } from "../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.ts";
import type { SettingsCallbacks, SettingsConfig } from "../modes/interactive/components/settings-selector.ts";
import { getAvailableThemes, type TerminalTheme } from "../modes/interactive/theme/theme.ts";
import { settingsFeatureStates } from "./feature-state.ts";
import { createSettingsDomainExtras } from "./settings-domain-extras.ts";
import type { SettingsDomainExtras } from "./settings-domains.ts";

/** What a host draws after an operation; every member is optional. */
export type SettingsEffects = Partial<Omit<SettingsCallbacks, "onTuiModeChange" | "onCancel">> & {
	/** The session's thinking level changed (a model's own level, or the default). */
	onThinkingChanged?(): void;
	/** Switches the screen layout before it is saved; false keeps the saved one. */
	onTuiModeSwitch?(mode: TuiMode): boolean;
	onTuiModeChange?(mode: TuiMode): void;
	/** Settings closed, before the modules turned on or off are applied. */
	onClose?(): void;
};

export interface SettingsHost {
	/** What the host shows of the theme, the terminal's background, thinking blocks and the screen layout. */
	view: { currentTheme: string; terminalTheme: TerminalTheme; hideThinkingBlock: boolean; tuiMode: TuiMode };
	effects: SettingsEffects;
	requestRender?(): void;
	/** `/web-key` asked from the Network domain, and the reload after a new search provider. */
	onWebSearchKey(action: "set" | "remove"): void;
	onWebSearchReload(): void;
	notify(message: string, type: "warning" | "error"): void;
	/** Module changes saved while a reply runs: they apply at the next /reload. */
	warn(message: string): void;
	/** A row that runs a command; `from` is where Settings was, to come back to it. */
	onRunCommand(command: string, from?: { domain: string; item: string }): void;
	/** Reloads the session, for the modules turned on or off. */
	reload(): void;
	themeEditor?: SettingsDomainExtras["themeEditor"];
}

/** The values, callbacks and fork domains `/settings` opens with. */
export async function settingsOperations(
	session: AgentSession,
	host: SettingsHost,
): Promise<{ config: SettingsConfig; callbacks: SettingsCallbacks }> {
	const settings = session.settingsManager;
	const effects = host.effects;
	const busy = () => session.isStreaming || session.isCompacting;
	const domainExtras = await createSettingsDomainExtras({
		settings,
		loadedExtensionPaths: session.extensionRunner.getExtensionPaths(),
		hasWebKeyCommand: session.extensionRunner.getCommand("web-key") !== undefined,
		requestRender: host.requestRender,
		onWebSearchKey: host.onWebSearchKey,
		// fork: provider changes use the same reload flow as /web-key.
		onWebSearchReload: host.onWebSearchReload,
		// fork: surface failed saves and provider changes awaiting /reload.
		isWebSearchReloadBlocked: busy,
		onWebSearchNotify: host.notify,
		// fork: /settings > Tools opens these configuration commands.
		hasCommand: (name) =>
			session.extensionRunner.getCommand(name) !== undefined ||
			BUILTIN_SLASH_COMMANDS.some((command) => command.name === name),
		onRunCommand: host.onRunCommand,
		featureState: settingsFeatureStates(session), // fork (also when off)
		themeEditor: host.themeEditor,
		// fork: the Models domain.
		models: {
			models: [...session.modelRuntime.getAvailableSnapshot()],
			defaultModel:
				settings.getDefaultProvider() && settings.getDefaultModel()
					? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}`
					: undefined,
			onDefaultModel: (model) => settings.setDefaultModelAndProvider(model.provider, model.id),
			thinkingLevel: settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
			thinkingLevels: THINKING_LEVEL_OPTIONS,
			onThinkingLevel: (level) => {
				session.setThinkingLevel(level, { persist: true });
				effects.onThinkingChanged?.();
			},
			cycleCount: session.scopedModels.length > 0 ? session.scopedModels.length : undefined,
		},
	});
	const defaultProvider = settings.getDefaultProvider();
	const defaultModelId = settings.getDefaultModel();
	const config: SettingsConfig = {
		interfaceMode: settings.getInterfaceMode(),
		autoCompact: session.autoCompactionEnabled,
		defaultModel: defaultProvider && defaultModelId ? `${defaultProvider}/${defaultModelId}` : "not set",
		currentModel: session.model,
		availableDefaultModels: session.modelRuntime.getAvailableSnapshot(),
		showImages: settings.getShowImages(),
		imageWidthCells: settings.getImageWidthCells(),
		autoResizeImages: settings.getImageAutoResize(),
		blockImages: settings.getBlockImages(),
		enableSkillCommands: settings.getEnableSkillCommands(),
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		transport: settings.getTransport(),
		httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
		cacheWarmingMode: settings.getCacheWarmingMode(),
		thinkingLevel: settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
		availableThinkingLevels: [...THINKING_LEVEL_OPTIONS],
		modelThinkingLevels: settings.getAllModelThinkingLevels(),
		currentTheme: host.view.currentTheme,
		terminalTheme: host.view.terminalTheme,
		availableThemes: getAvailableThemes(),
		hideThinkingBlock: host.view.hideThinkingBlock,
		mermaidRenderingMode: settings.getMermaidRenderingMode(),
		collapseChangelog: settings.getCollapseChangelog(),
		enableInstallTelemetry: settings.getEnableInstallTelemetry(),
		doubleEscapeAction: settings.getDoubleEscapeAction(),
		treeFilterMode: settings.getTreeFilterMode(),
		showHardwareCursor: settings.getShowHardwareCursor(),
		showCacheMissNotices: settings.getShowCacheMissNotices(),
		defaultProjectTrust: settings.getDefaultProjectTrust(),
		editorPaddingX: settings.getEditorPaddingX(),
		outputPad: settings.getOutputPad(),
		autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
		quietStartup: settings.getQuietStartup(),
		clearOnShrink: settings.getClearOnShrink(),
		showTerminalProgress: settings.getShowTerminalProgress(),
		tuiMode: host.view.tuiMode,
		fullscreenExitOutput: settings.getFullscreenExitOutput(),
		fullscreenScrollbar: settings.getFullscreenScrollbar(),
		fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
		fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(),
		warnings: settings.getWarnings(),
		domainExtras,
	};
	const callbacks: SettingsCallbacks = {
		onAutoCompactChange: (enabled) => {
			session.setAutoCompactionEnabled(enabled);
			effects.onAutoCompactChange?.(enabled);
		},
		onShowImagesChange: (enabled) => {
			settings.setShowImages(enabled);
			effects.onShowImagesChange?.(enabled);
		},
		onImageWidthCellsChange: (width) => {
			settings.setImageWidthCells(width);
			effects.onImageWidthCellsChange?.(width);
		},
		onAutoResizeImagesChange: (enabled) => settings.setImageAutoResize(enabled),
		onBlockImagesChange: (blocked) => settings.setBlockImages(blocked),
		onEnableSkillCommandsChange: (enabled) => {
			settings.setEnableSkillCommands(enabled);
			effects.onEnableSkillCommandsChange?.(enabled);
		},
		onSteeringModeChange: (mode) => session.setSteeringMode(mode),
		onFollowUpModeChange: (mode) => session.setFollowUpMode(mode),
		onTransportChange: (transport) => {
			settings.setTransport(transport);
			session.agent.transport = transport;
		},
		onHttpIdleTimeoutMsChange: (timeoutMs) => {
			settings.setHttpIdleTimeoutMs(timeoutMs);
			configureHttpDispatcher(timeoutMs);
			effects.onHttpIdleTimeoutMsChange?.(timeoutMs);
		},
		onCacheWarmingModeChange: (mode) => {
			session.setCacheWarmingMode(mode);
			effects.onCacheWarmingModeChange?.(mode);
		},
		onModelThinkingLevelChange: (provider, modelId, level) => {
			settings.setModelThinkingLevel(provider, modelId, level);
			// If the override is for the current model, apply it to the session too
			const current = session.model;
			if (current && current.provider === provider && current.id === modelId) {
				session.setThinkingLevel(level);
				effects.onThinkingChanged?.();
			}
		},
		onModelThinkingLevelRemove: (provider, modelId) => {
			settings.removeModelThinkingLevel(provider, modelId);
			// If the override was for the current model, revert to global default
			const current = session.model;
			if (current && current.provider === provider && current.id === modelId) {
				session.setThinkingLevel(settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
				effects.onThinkingChanged?.();
			}
		},
		onThemeChange: (themeSetting) => {
			settings.setTheme(themeSetting);
			effects.onThemeChange?.(themeSetting);
		},
		onThemePreview: (themeName) => effects.onThemePreview?.(themeName),
		onHideThinkingBlockChange: (hidden) => {
			settings.setHideThinkingBlock(hidden);
			effects.onHideThinkingBlockChange?.(hidden);
		},
		onMermaidRenderingModeChange: (mode) => {
			settings.setMermaidRenderingMode(mode);
			effects.onMermaidRenderingModeChange?.(mode);
		},
		onShowCacheMissNoticesChange: (shown) => {
			settings.setShowCacheMissNotices(shown);
			effects.onShowCacheMissNoticesChange?.(shown);
		},
		onCollapseChangelogChange: (collapsed) => settings.setCollapseChangelog(collapsed),
		onEnableInstallTelemetryChange: (enabled) => settings.setEnableInstallTelemetry(enabled),
		onQuietStartupChange: (quiet) => settings.setQuietStartup(quiet),
		onDefaultProjectTrustChange: (trust) => settings.setDefaultProjectTrust(trust),
		onDoubleEscapeActionChange: (action) => settings.setDoubleEscapeAction(action),
		onTreeFilterModeChange: (mode) => settings.setTreeFilterMode(mode),
		onShowHardwareCursorChange: (enabled) => {
			settings.setShowHardwareCursor(enabled);
			effects.onShowHardwareCursorChange?.(enabled);
		},
		onEditorPaddingXChange: (padding) => {
			settings.setEditorPaddingX(padding);
			effects.onEditorPaddingXChange?.(padding);
		},
		onOutputPadChange: (padding) => {
			settings.setOutputPad(padding);
			effects.onOutputPadChange?.(padding);
		},
		onAutocompleteMaxVisibleChange: (maxVisible) => {
			settings.setAutocompleteMaxVisible(maxVisible);
			effects.onAutocompleteMaxVisibleChange?.(maxVisible);
		},
		onClearOnShrinkChange: (enabled) => {
			settings.setClearOnShrink(enabled);
			effects.onClearOnShrinkChange?.(enabled);
		},
		onShowTerminalProgressChange: (enabled) => settings.setShowTerminalProgress(enabled),
		onTuiModeChange: (mode) => {
			if (effects.onTuiModeSwitch?.(mode) === false) return;
			settings.setTuiMode(mode);
			effects.onTuiModeChange?.(mode);
		},
		onFullscreenExitOutputChange: (output) => settings.setFullscreenExitOutput(output),
		onFullscreenScrollbarChange: (mode) => {
			settings.setFullscreenScrollbar(mode);
			effects.onFullscreenScrollbarChange?.(mode);
		},
		onFullscreenCopyOnSelectChange: (enabled) => {
			settings.setFullscreenCopyOnSelect(enabled);
			effects.onFullscreenCopyOnSelectChange?.(enabled);
		},
		onFullscreenWheelScrollLinesChange: (lines) => {
			settings.setFullscreenWheelScrollLines(lines);
			effects.onFullscreenWheelScrollLinesChange?.(lines);
		},
		onWarningsChange: (warnings) => settings.setWarnings(warnings),
		onCancel: () => {
			effects.onClose?.();
			// fork: modules turned on or off apply when Settings closes.
			if (!domainExtras.builtinExtensionsChanged?.()) return;
			if (busy()) host.warn("Module changes saved. Run /reload after the current response to apply them.");
			else host.reload();
		},
	};
	return { config, callbacks };
}

/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	type ImageContent,
	isRetryableAssistantError,
	type Message,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import type {
	AutocompleteProvider,
	EditorComponent,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	TuiMainScreenRenderState,
} from "@earendil-works/pi-tui";
import * as TuiLayouts from "@earendil-works/pi-tui";
import {
	type Component,
	Container,
	getCapabilities,
	hyperlink,
	Markdown,
	matchesKey,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	type Terminal,
	Text,
	TruncatedText,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { spawn } from "child_process";
import {
	APP_NAME,
	APP_TITLE,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getDocsPath,
	getModelsPath,
	VERSION,
} from "../../config.ts";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "../../core/auth-guidance.ts"; // fork
import {
	CACHE_TTL_MS,
	type CacheMiss,
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss,
} from "../../core/cache-stats.ts";
import { formatCacheWarmingStatus, formatCacheWarmingUsage } from "../../core/cache-warmer.ts";
import { findExtensionStackMatches, recordCrash, takeUnnotifiedCrash } from "../../core/crash-log.ts";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	MarkdownTransformer,
	ProjectTrustContext,
	UserBashEventResult,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import type { McpHttpServerConfig } from "../../core/mcp-servers.ts";
import { createCompactionSummaryMessage, createCustomMessage } from "../../core/messages.ts";
import { findExactModelReferenceMatch } from "../../core/model-resolver.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import { RADIUS_MCP_URL, RADIUS_PROVIDER_ID } from "../../core/radius.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import {
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
	type UsageEntry,
} from "../../core/session-manager.ts";
import type { FullscreenExitOutput, TuiMode } from "../../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { isInstallTelemetryEnabled } from "../../core/telemetry.ts";
import { withBuiltInRenderers } from "../../core/tools/renderers/index.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
import { getUsageCostBreakdown } from "../../core/usage-totals.ts";
import { addMcpServerConfig, loadMcpConfig } from "../../extensions/mcp/config.ts";
import {
	ANTHROPIC_SUBSCRIPTION_GO,
	ANTHROPIC_SUBSCRIPTION_RISK,
	ANTHROPIC_SUBSCRIPTION_TITLE,
	isAnthropicSubscription,
	loginWarningTone,
} from "../../fork/anthropic-subscription.ts";
import { createFuzzyAutocompleteItems, createSessionAutocompleteProvider } from "../../fork/autocomplete.ts";
import { APP_DISPLAY_NAME, BRANDED_RADIUS_LOGIN_INTRO, IS_BRANDED_BUILD } from "../../fork/brand.ts";
import {
	CHANGELOG_READER_OVERLAY,
	changelogReader,
	getPrismChangelogPath,
	unwrapChangelog,
} from "../../fork/changelog.ts";
import { resolveCommandAlias } from "../../fork/command-aliases.ts";
import { COMMAND_KEYS } from "../../fork/command-keys.ts";
import { createCompactionThresholdModelChangeWarning } from "../../fork/compaction-threshold-warning.ts";
import { connectCompatibleServer } from "../../fork/compatible-server.ts";
import { EditorSlot } from "../../fork/editor-slot.ts";
import { applyExpansion, type Expandable, isExpandable } from "../../fork/expand-all.ts"; // fork
import { commandNotice, sessionFeatureStates } from "../../fork/feature-state.ts"; // fork
import { attachTarget, pastedFiles } from "../../fork/file-attachments.ts";
import { FORK_WHOLE_CONVERSATION, FORK_WHOLE_DETAIL, FORK_WHOLE_LABEL } from "../../fork/fork-whole.ts";
import { helpEntries, helpSelector } from "../../fork/help.ts";
import { addSandboxWritable, hostCommand } from "../../fork/host-program.ts";
import { fill, t } from "../../fork/i18n/index.ts"; // fork
import { attachPastedImage, userMessageImages } from "../../fork/image-attachments.ts";
import { interfaceWording, showsToolStatus } from "../../fork/interface-mode.ts";
import { LoadedSummary } from "../../fork/loaded-summary.ts";
import { offerLoginModels } from "../../fork/login-models.ts";
import {
	catalogRefreshFailure,
	compatibleServerFailure,
	deferModelSelection,
	finishCompatibleServer,
	type LoginMethod,
	loginActionLabel,
	loginFailureMessage,
	loginMethods,
	loginModelsKeep,
	loginProviderOptions,
	logoutProvider,
	logoutProviderOptions,
	matchLoginProviderOptions,
	NO_STORED_CREDENTIALS,
	noLoginProvidersMessage,
	refreshCatalogAfterLogin,
	selectModelAfterLogin,
} from "../../fork/login-operations.ts";
import { THINKING_UNSUPPORTED } from "../../fork/model-settings.ts"; // fork
import { NoticeText } from "../../fork/notice-text.ts";
import { withReloginNote } from "../../fork/oauth-relogin.ts";
import { setOnboardingHost } from "../../fork/onboarding.ts";
import { closeMenusOnOutsidePress } from "../../fork/outside-press.ts";
import { pasteTargets } from "../../fork/paste-hint.ts";
import { BUG_REPORTS_ENABLED } from "../../fork/policy.ts";
import { type PanelTransition, renderHooks } from "../../fork/render-hooks.ts";
import { scopedModelsOperations } from "../../fork/scoped-models-operations.ts";
import { knownSecrets } from "../../fork/secrets/env.ts";
import { maskText } from "../../fork/secrets/mask.ts";
import { canaryNotice, isCanaryVersion } from "../../fork/self-update.ts";
import { settingsOperations } from "../../fork/settings-operations.ts";
import { setSettingsHost } from "../../fork/settings-sections.ts";
import { MAX_WIDTH as SETTINGS_MAX_WIDTH } from "../../fork/settings-view.ts";
import { unfoldOnScreen } from "../../fork/unfold-on-screen.ts";
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { copyToClipboard, readClipboardFilePaths, readClipboardText } from "../../utils/clipboard.ts";
import { readClipboardImage } from "../../utils/clipboard-image.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { loadAllHighlightLanguages } from "../../utils/syntax-highlight.ts";
import { ensureTool, type ToolStatus } from "../../utils/tools-manager.ts";
import { checkForNewPiVersion, type LatestPiRelease } from "../../utils/version-check.ts";
import { reportBug } from "./bug-report.ts";
import { createChatViewport } from "./chat-viewport.ts";
import { ArminComponent } from "./components/armin.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DaxnutsComponent } from "./components/daxnuts.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { FooterComponent, formatTokens } from "./components/footer.ts";
import { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import {
	type AuthSelectorProvider,
	formatAuthSelectorProviderStatus,
	formatAuthSelectorProviderType,
	OAuthSelectorComponent,
} from "./components/oauth-selector.ts";
import { piLogoLines, piWordmark, supportsPiLogo } from "./components/pi-logo.ts";
import { playPiLogoAnimation } from "./components/pi-logo-animation.lazy.ts";
import { createLoginMenuSelector } from "./components/radius-login-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "./components/status-indicator.ts";
import { ThemedText } from "./components/themed-text.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import { editInExternalEditor } from "./external-editor.ts";
import { refreshModelCatalogs } from "./model-catalog-refresh.ts";
import { shareSession } from "./session-share.ts";
import {
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	onThemeChange,
	SYSTEM_THEME_NAME,
	setRegisteredThemes,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";
import { InteractiveThemeController } from "./theme/theme-controller.ts";
import { createInteractiveTui, createInteractiveTuiReference } from "./tui-renderer.ts";

export { createInteractiveTui, createInteractiveTuiReference } from "./tui-renderer.ts";

interface ActiveEditor extends EditorComponent {
	getCursor?(): { line: number; col: number };
}

interface WorkingStatusEditor extends EditorComponent {
	readonly embedWorkingStatus: boolean;
	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void;
}

function isWorkingStatusEditor(editor: EditorComponent): editor is WorkingStatusEditor {
	return (
		"embedWorkingStatus" in editor &&
		editor.embedWorkingStatus === true &&
		"setWorkingStatusIndicator" in editor &&
		typeof editor.setWorkingStatusIndicator === "function"
	);
}

class ExpandableText extends ThemedText implements Expandable {
	private readonly state: { expanded: boolean };

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		const state = { expanded };
		super(() => (state.expanded ? getExpandedText() : getCollapsedText()), paddingX, paddingY);
		this.state = state;
	}

	setExpanded(expanded: boolean): void {
		this.state.expanded = expanded;
		this.invalidate();
	}
}

/** The built-in header. Clicking its logo (the first two lines, after one column of padding) plays an easter egg. */
class BuiltInHeader extends ExpandableText {
	onLogoClick: ((column: number, row: number) => void) | undefined;

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.y > 1 || event.x < 1 || event.x > 4 || !this.onLogoClick) return undefined;
		this.onLogoClick(event.screenX - event.x + 1, event.screenY - event.y);
		return { handled: true };
	}
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

type CompactionCostNotice = {
	type: "compaction_cost";
	kind: "compaction" | "branch_summary";
	usage: Usage;
};

type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" | "usage" }> | CompactionCostNotice;

function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

function isCompactionCostNotice(item: RenderSessionItem): item is CompactionCostNotice {
	return "type" in item && item.type === "compaction_cost";
}

function isUsageSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "usage" }> {
	return "type" in item && item.type === "usage";
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

export function formatCrashExtensionHint(extensionMatches: readonly string[] | undefined): string | undefined {
	// fork: translate display wrappers; keep data and model content unchanged.
	const matches = Array.isArray(extensionMatches)
		? extensionMatches.filter((match): match is string => typeof match === "string" && match.length > 0)
		: [];
	if (matches.length === 0) return undefined;
	const quoted = matches.map((match) => `\`${match}\``);
	const labels =
		quoted.length === 1
			? quoted[0]
			: quoted.length === 2
				? quoted.join(t(" and "))
				: `${quoted.slice(0, -1).join(", ")}${t(", and ")}${quoted[quoted.length - 1]}`;
	return fill(
		matches.length === 1
			? "A stack frame came from loaded extension {0}, which may be involved. Try disabling it with `{1} config`, or run `{1} -ne` to confirm."
			: "A stack frame came from loaded extensions {0}, which may be involved. Try disabling them with `{1} config`, or run `{1} -ne` to confirm.",
		labels!,
		APP_NAME,
	);
}

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

type LoginProviderCompletionOption = {
	id: string;
	name: string;
	authTypes: AuthSelectorProvider["authType"][];
	subscription?: boolean;
};

// fork: a branded build does not present itself as made by Earendil Works.
const RADIUS_LOGIN_INTRO = IS_BRANDED_BUILD
	? BRANDED_RADIUS_LOGIN_INTRO
	: "Radius is a service crafted for Pi by the builders of Pi, Earendil Works";

const AUTH_TYPE_ORDER = { oauth: 0, api_key: 1 } satisfies Record<AuthSelectorProvider["authType"], number>;

function getLoginProviderCompletionOptions(
	providerOptions: readonly AuthSelectorProvider[],
): LoginProviderCompletionOption[] {
	const byId = new Map<string, LoginProviderCompletionOption>();
	for (const provider of providerOptions) {
		const existing = byId.get(provider.id);
		if (existing) {
			if (!existing.authTypes.includes(provider.authType)) {
				existing.authTypes.push(provider.authType);
				existing.authTypes.sort((a, b) => AUTH_TYPE_ORDER[a] - AUTH_TYPE_ORDER[b]);
			}
			continue;
		}
		byId.set(provider.id, {
			id: provider.id,
			name: provider.name,
			authTypes: [provider.authType],
			subscription: provider.subscription,
		});
	}
	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getLoginProviderSearchText(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes
		.map((authType) => `${authType} ${formatAuthSelectorProviderType(authType, provider.subscription)}`)
		.join(" ");
	return `${provider.id} ${provider.name} ${authTypes}`;
}

function formatLoginProviderCompletionDescription(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes
		.map((authType) => formatAuthSelectorProviderType(authType, provider.subscription))
		.join("/");
	return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Diagnostics collected before the interactive TUI was initialized. */
	startupDiagnostics?: AgentSessionRuntimeDiagnostic[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Cwd to trust after reload if it gained a .pi directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** TUI layout mode. */
	tuiMode?: TuiMode;
	/** Initial interactive theme setting for this invocation. */
	initialThemeSetting?: string;
	/** Terminal implementation. Defaults to the current process terminal. */
	terminal?: Terminal;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private renderer: TuiMainScreen | TuiAltScreen;
	private ui: TUI;
	private mainScreenRenderState: TuiMainScreenRenderState | undefined;
	private loadedResourcesContainer: Container;
	private chatContainer: Container;
	private documentContainer: Container;
	private transcriptScrollView: TuiLayouts.ScrollView | undefined;
	private fullscreenLayoutRoot: Component | undefined;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: ActiveEditor;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private activeSelectorToken?: object;
	private activeSelectorDispose?: () => void;
	private footer: FooterComponent;
	private footerContainer: Container;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private pendingUserInputs: string[] = [];
	// fork: windows extensions have opened, to tell a command that showed one.
	private extensionWindowsOpened = 0;
	// fork: times /settings opened, to tell a command that opened it on another row.
	private settingsOpened = 0;
	private activeStatusIndicator: StatusIndicator | undefined = undefined;
	private activeWorkingIndicatorEmbedded = false;
	private readonly idleStatus = new IdleStatus();
	private workingMessage: string | undefined = undefined;
	private workingVisible = true;
	private workingIndicatorOptions: WorkingIndicatorOptions | undefined = undefined;
	private readonly defaultWorkingMessage = "Working";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: ThemedText | undefined = undefined;
	// fork: one holder per status line, so an older line keeps its own text when re-rendered.
	private lastStatusMessage = { text: "" };
	private managedToolStatusStarted = false;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private readonly entriesRenderedByBoundaryCompaction = new Set<string>();
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;
	// fork: preserve the configured default until expansion is explicitly applied.
	private thinkingExpansionOverride: boolean | undefined;
	private outputPad = 1;
	private readonly mermaidMarkdownTransformer: MarkdownTransformer = createMermaidMarkdownTransformer({
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		theme,
	});

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	/** The `/bug` hint is shown at most once per session so error output stays readable. */
	// fork: when /bug is disabled, the hint suggesting it is never shown.
	private bugReportHintShown = !BUG_REPORTS_ENABLED;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputSubscriptions = new Set<{
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		unsubscribe: () => void;
	}>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private options: InteractiveModeOptions;
	private warnLowCompactionThreshold: (model: Model<string>) => void;
	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};
	private autoTrustOnReloadCwd: string | undefined;
	private themeController: InteractiveThemeController;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.warnLowCompactionThreshold = createCompactionThresholdModelChangeWarning(
			this.settingsManager,
			(message) => this.showWarning(message),
			this.session.model,
		);
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		const tuiMode = options.tuiMode ?? this.settingsManager.getTuiMode();
		this.options = { ...options, tuiMode };
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession({ renderBeforeBind: true });
			this.themeController.applyFromSettings();
		});
		this.version = VERSION;
		this.renderer = createInteractiveTui({
			tuiMode,
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			logDirectory: getAgentDir(),
			terminal: options.terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
		});
		this.ui = createInteractiveTuiReference(() => this.renderer);
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.loadedResourcesContainer = new Container();
		this.chatContainer = new Container();
		this.documentContainer = new Container();
		this.documentContainer.addChild(this.headerContainer);
		this.documentContainer.addChild(this.loadedResourcesContainer);
		this.documentContainer.addChild(this.chatContainer);
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			embedWorkingStatus: true,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new EditorSlot(); // fork: menus framed by render hooks
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerContainer = new Container();
		this.footerContainer.addChild(this.footer);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(this.ui, {
			getSettingsManager: () => this.settingsManager,
			showError: (message) => this.showError(message),
			onChanged: () => this.updateEditorBorderColor(),
			initialThemeSetting: options.initialThemeSetting,
		});
		// fork: what the onboarding extension cannot do itself.
		setOnboardingHost({
			login: () => void this.handleLoginCommand(),
			previewTheme: (setting) => this.themeController.preview(setting),
			applyTheme: (setting) => {
				this.settingsManager.setTheme(setting);
				this.themeController.setThemeSetting(setting);
			},
		});
		// fork: /perm, /sandbox and the other commands kept as shortcuts open /settings.
		setSettingsHost((target) => void this.showSettingsSelector(target.domain, target.item, target.open));
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// fork: built in src/fork/autocomplete.ts, shared with RPC mode (the Prism window).
		return createSessionAutocompleteProvider({
			session: this.session,
			settingsManager: this.settingsManager,
			cwd: this.sessionManager.getCwd(),
			fdPath: this.fdPath,
			skillCommands: this.skillCommands,
			loginCompletions: (prefix) => {
				const providers = getLoginProviderCompletionOptions(this.getLoginProviderOptions());
				return createFuzzyAutocompleteItems(providers, prefix, getLoginProviderSearchText, (provider) => ({
					value: provider.id,
					label: provider.id,
					description: formatLoginProviderCompletionDescription(provider),
				}));
			},
		});
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = fill(
				"Updated to v{0}. Use {1} to view full changelog.",
				latestVersion,
				theme.bold("/changelog"),
			);
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", t("What's New"))), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	private mountInteractiveTui(tui: TuiMainScreen | TuiAltScreen, components: readonly Component[]): void {
		for (const component of components) tui.addChild(component);
		if (TuiLayouts.isViewportTUI(tui)) {
			if (!this.fullscreenLayoutRoot) throw new Error("Fullscreen layout is not initialized");
			tui.setLayoutRoot(this.fullscreenLayoutRoot);
		}
		// fork: a click outside an open menu closes it.
		if (tui instanceof TuiAltScreen)
			closeMenusOnOutsidePress(
				tui,
				this.editorContainer,
				() => this.editor,
				() =>
					this.session.isStreaming &&
					Boolean(this.extensionSelector ?? this.extensionInput ?? this.extensionEditor),
			);
	}

	private stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void {
		if (this.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			this.switchTuiMode("regular", false, false);
			this.renderer.renderNow();
		}
		this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" });
	}

	private switchTuiMode(mode: TuiMode, restoreProgress = true, startRenderer = true): boolean {
		const previousUi = this.renderer;
		if (mode === previousUi.mode) return true;
		if (previousUi.hasOverlayEntries) return false;

		const components = [...previousUi.children];
		const focus = previousUi.getFocusedComponent();
		const terminal = previousUi.terminal;
		const showHardwareCursor = previousUi.getShowHardwareCursor();
		const clearOnShrink = previousUi.getClearOnShrink();
		const onDebug = previousUi.onDebug;
		if (previousUi instanceof TuiMainScreen) {
			this.mainScreenRenderState = previousUi.captureRenderState();
		}

		previousUi.stop({ preserveScreen: true });
		previousUi.setFocus(null);
		previousUi.clear();
		if (TuiLayouts.isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

		const nextUi = createInteractiveTui({
			tuiMode: mode,
			showHardwareCursor,
			logDirectory: getAgentDir(),
			terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
		});
		nextUi.setClearOnShrink(clearOnShrink);
		nextUi.onDebug = onDebug;
		if (nextUi instanceof TuiMainScreen && this.mainScreenRenderState) {
			nextUi.restoreRenderState(this.mainScreenRenderState);
		}
		this.renderer = nextUi;
		this.options.tuiMode = mode;
		this.mountInteractiveTui(nextUi, components);
		nextUi.invalidate();
		nextUi.setFocus(focus);
		if (!startRenderer) return true;
		nextUi.start();
		this.themeController.rebindTui();
		this.rebindExtensionTerminalInputListeners();
		if (
			restoreProgress &&
			this.settingsManager.getShowTerminalProgress() &&
			(this.session.isStreaming || this.session.isCompacting)
		) {
			terminal.setProgress(true);
		}
		return true;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		if (this.session.scopedModels.length > 0 && this.shouldShowStartupDetails()) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		// Keep one component tree and remount it when changing renderers.
		this.renderWidgets(); // Initialize with default spacer
		const viewport = createChatViewport({
			document: this.documentContainer,
			pendingMessages: this.pendingMessagesContainer,
			status: this.statusContainer,
			widgetsAbove: this.widgetContainerAbove,
			editor: this.editorContainer,
			widgetsBelow: this.widgetContainerBelow,
			footer: this.footerContainer,
			scrollbar: this.settingsManager.getFullscreenScrollbar(),
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		this.transcriptScrollView = viewport.transcript;
		this.fullscreenLayoutRoot = viewport.root;
		this.mountInteractiveTui(this.renderer, [
			this.documentContainer,
			this.pendingMessagesContainer,
			this.statusContainer,
			this.widgetContainerAbove,
			this.editorContainer,
			this.widgetContainerBelow,
			this.footerContainer,
		]);
		// Accept text while startup completes, but only enable interrupt, exit, and submission feedback.
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onSubmit = (text) => this.handleStartupSubmit(text);
		this.ui.setFocus(this.editor);

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;

		this.themeController.applyFromSettings();
		// The header and startup notices bake theme colors into their text, so build them once the terminal
		// reported its colors. This ends at the terminal's DA1 reply, or after 100 ms if it answers nothing.
		await this.themeController.waitForTerminalColors();

		// Add header with keybindings from config (unless silenced)
		if (this.shouldShowStartupHeader()) {
			const showDetails = this.shouldShowStartupDetails();
			// Built on demand so the header follows theme changes. The logo's first line carries the version,
			// its second line the first line of key hints. Terminals that cannot render the logo get a
			// "Pi vX" line instead, with the key hints below it.
			const showLogo = supportsPiLogo();
			const withLogo = (hints: string) => {
				if (!showLogo) return `${piWordmark()} ${theme.fg("dim", `v${this.version}`)}\n${hints}`;
				const [top, bottom] = piLogoLines();
				return `${top} ${theme.fg("dim", `v${this.version}`)}\n${bottom} ${hints}`;
			};

			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = () =>
				[
					hint("app.interrupt", "to interrupt"),
					hint("app.clear", "to clear"),
					rawKeyHint(fill("{0} twice", keyText("app.clear")), "to exit"), // fork: translated
					hint("app.exit", "to exit (empty)"),
					hint("app.suspend", "to suspend"),
					keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
					hint("app.thinking.cycle", "to change thinking level"),
					rawKeyHint(
						`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`,
						"to cycle models",
					),
					hint("app.model.select", "to select model"),
					hint("app.tools.expand", "to show or hide action details"),
					hint("app.thinking.toggle", "to expand thinking"),
					hint("app.editor.external", "for external editor"),
					rawKeyHint("/", "for commands"),
					rawKeyHint("!", "to run a terminal command and share its output with the agent"),
					rawKeyHint("!!", "to run a terminal command without sharing its output with the agent"),
					hint(
						"app.message.followUp",
						interfaceWording(
							this.settingsManager.getInterfaceMode(),
							"to save a message for after the current task",
							"to queue follow-up (message after working)",
						),
					),
					hint(
						"app.message.dequeue",
						interfaceWording(
							this.settingsManager.getInterfaceMode(),
							"to edit waiting messages",
							"to edit queued messages (waiting to be sent)",
						),
					),
					hint("app.clipboard.pasteImage", `to paste ${pasteTargets()}`),
					rawKeyHint(t("drop files"), "to attach"), // fork: translated
				].join("\n");
			const compactInstructions = () =>
				[
					hint("app.interrupt", "interrupt"),
					rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
					rawKeyHint("/", "commands"),
					rawKeyHint("!", "command"),
					hint("app.tools.expand", "more"),
				].join(theme.fg("muted", " · "));
			const compactOnboarding = () =>
				theme.fg(
					"dim",
					// fork: the safe-mode header is upstream's, so translate it here.
					t(
						`Press ${keyText("app.tools.expand")} to show full startup help${showDetails ? " and loaded resources" : ""}.`,
					),
				);
			const onboarding = () =>
				theme.fg(
					"dim",
					t(
						`${APP_DISPLAY_NAME} can explain its own features and look up its docs. Ask it how to use or extend ${APP_DISPLAY_NAME}.`,
					),
				);
			const header = new BuiltInHeader(
				() => `${withLogo(compactInstructions())}\n${compactOnboarding()}\n\n${onboarding()}`,
				() => `${withLogo(expandedInstructions())}\n\n${onboarding()}`,
				this.getStartupExpansionState(),
				1,
				0,
			);
			if (showLogo) header.onLogoClick = (column, row) => playPiLogoAnimation(this.renderer, column, row);
			this.builtInHeader = header;

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}
		this.ui.requestRender();

		// Ensure fd and rg are available after mounting the TUI (downloads if missing, adds to PATH via getBinDir)
		// so slow downloads do not make startup appear frozen.
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands.
		// fork: the sandbox starts after this lookup and lets its commands write the
		// project; an `fd` they wrote in its `.venv/bin` is not taken now and run at each completion.
		addSandboxWritable([this.sessionManager.getCwd()]);
		const [fdPath] = await Promise.all([
			ensureTool("fd", (status) => this.showManagedToolStatus(status)),
			ensureTool("rg", (status) => this.showManagedToolStatus(status)),
		]);
		this.fdPath = fdPath;

		// Enable the remaining input handlers only after managed-tool setup completes.
		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		this.ui.requestRender();

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();

		// Flush the completed startup state before loading the remaining syntax grammars.
		this.ui.renderNow();
		void loadAllHighlightLanguages().then(() => {
			if (!this.isInitialized) return;
			this.ui.invalidate();
			this.ui.requestRender();
		});
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		await this.init();

		if (!process.env.PI_OFFLINE) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15_000);
			void refreshModelCatalogs(this.session.modelRuntime, controller.signal)
				.then(() => this.updateAvailableProviderCount())
				.catch(() => {})
				.finally(() => clearTimeout(timeout));
		}

		// Start version check asynchronously
		checkForNewPiVersion(this.version).then((newRelease) => {
			if (newRelease) {
				this.showNewVersionNotification(newRelease);
			}
		});
		// fork: a canary release says so at every start, with the way back to stable.
		if (IS_BRANDED_BUILD && isCanaryVersion(this.version)) this.showWarning(canaryNotice());

		// Start package update check asynchronously
		this.checkForPackageUpdates()
			.then((updates) => {
				if (updates.length > 0) {
					this.showPackageUpdateNotification(updates);
				}
			})
			.finally(() => {
				// On Windows, npm can overwrite the shared console title while checking
				// extension package versions. Restore Pi's title after the startup check.
				if (process.platform === "win32" && this.isInitialized) {
					this.updateTerminalTitle();
				}
			});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const {
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages,
		} = this.options;

		for (const diagnostic of startupDiagnostics ?? []) {
			if (diagnostic.type === "error") {
				this.showError(diagnostic.message);
			} else if (diagnostic.type === "warning") {
				this.showWarning(diagnostic.message);
			} else {
				this.showStatus(diagnostic.message);
			}
		}

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(fill("Migrated credentials to auth.json: {0}", migratedProviders.join(", ")));
		}

		const modelsJsonError = this.session.modelRuntime.getError();
		if (modelsJsonError) {
			this.showError(fill("Could not load model settings from models.json: {0}", modelsJsonError));
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		const crash = takeUnnotifiedCrash();
		if (crash) {
			const when = new Date(crash.timestamp).toLocaleString();
			this.showWarning(fill("{0} crashed on {1} ({2}).", APP_NAME, when, crash.message));
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.session.prompt(userInput);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env.PI_OFFLINE) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn(hostCommand("tmux"), ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return `tmux extended-keys-format is xterm. ${APP_DISPLAY_NAME} works best with csi-u. Add \`set -g extended-keys-format csi-u\` to ~/.tmux.conf and restart tmux.`;
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - record the version, send telemetry, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return undefined;
		}

		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
		}

		return undefined;
	}

	private reportInstallTelemetry(version: string): void {
		if (process.env.PI_OFFLINE) {
			return;
		}

		if (!isInstallTelemetryEnabled(this.settingsManager)) {
			return;
		}

		void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
			headers: {
				"User-Agent": getPiUserAgent(version),
			},
			signal: AbortSignal.timeout(5000),
		})
			.then(() => undefined)
			.catch(() => undefined);
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/** Startup header (logo, version, key hints). Hidden only by quietStartup: true. */
	private shouldShowStartupHeader(): boolean {
		return this.options.verbose === true || this.settingsManager.getQuietStartup() !== true;
	}

	/** Startup details (model scope, loaded resources). Hidden by quietStartup: true or "header". */
	private shouldShowStartupDetails(): boolean {
		return this.options.verbose === true || this.settingsManager.getQuietStartup() === false;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const normalizedFullPath = fullPath.replace(/\\/g, "/");
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const normalizedBaseDir = baseDir.replace(/\\/g, "/");
			const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
			// If fullPath is under the same node_modules root as baseDir, preserve that relative topology.
			if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
				return path.posix.relative(normalizedBaseDir, normalizedFullPath);
			}

			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		// Resource rendering is idempotent; chat clears no longer clear this separate container.
		this.loadedResourcesContainer.clear();

		const showListing = options?.force || this.shouldShowStartupDetails();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		// Bodies are built on demand so the listing follows theme changes.
		// fork: sections are collected first, so a render hook can sum them up in one line.
		const loadedSections: Array<{ name: string; count: number; collapsed: () => string; expanded: () => string }> =
			[];
		const addLoadedSection = (
			name: string,
			count: number,
			collapsedBody: () => string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			loadedSections.push({
				name,
				count,
				collapsed: () => `${sectionHeader(name, color)}\n${collapsedBody()}`,
				expanded: () => `${sectionHeader(name, color)}\n${expandedBody()}`,
			});
		};
		const addLoadedSectionComponent = (section: (typeof loadedSections)[number]): void => {
			const component = new ExpandableText(
				section.collapsed,
				section.expanded,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.loadedResourcesContainer.addChild(component);
			this.loadedResourcesContainer.addChild(new Spacer(1));
		};

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader
				.getExtensions()
				.extensions.filter((extension) => !extension.hidden)
				.map((extension) => ({
					path: extension.path,
					sourceInfo: extension.sourceInfo,
				}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const systemPromptSource = this.session.resourceLoader.getSystemPromptSource();
			const contextFiles = [
				...(systemPromptSource ? [systemPromptSource] : []),
				...this.session.resourceLoader.getAppendSystemPromptSources(),
				...this.session.resourceLoader.getAgentsFiles().agentsFiles,
			];
			if (contextFiles.length > 0) {
				this.loadedResourcesContainer.addChild(new Spacer(1));
				const contextList = () =>
					contextFiles.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`)).join("\n");
				const contextCompactList = () =>
					formatCompactList(
						contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
						{ sort: false },
					);
				addLoadedSection("Context", contextFiles.length, contextCompactList, contextList);
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = () =>
					this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatDisplayPath(item.path),
						formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
					});
				const skillCompactList = () => formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skills.length, skillCompactList, skillList);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = () =>
					this.formatScopeGroups(groups, {
						formatPath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
						formatPackagePath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
					});
				const promptCompactList = () => formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", templates.length, promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = () =>
					this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatExtensionDisplayPath(item.path),
						formatPackagePath: (item) =>
							this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
					});
				const extensionLabels = this.getCompactExtensionLabels(extensions);
				const extensionCompactList = () => formatCompactList(extensionLabels);
				addLoadedSection("Extensions", extensions.length, extensionCompactList, extList, "mdHeading");
			}

			if (renderHooks.loadedSummary && loadedSections.length > 0) {
				const expanded = this.getStartupExpansionState();
				const listing = new ExpandableText(
					() => loadedSections.map((section) => section.collapsed()).join("\n\n"),
					() => loadedSections.map((section) => section.expanded()).join("\n\n"),
					expanded,
					0,
					0,
				);
				const counts = loadedSections.map(({ name, count }) => ({ name, count }));
				this.loadedResourcesContainer.addChild(new LoadedSummary(counts, listing, expanded));
				this.loadedResourcesContainer.addChild(new Spacer(1));
			} else {
				for (const section of loadedSections) addLoadedSectionComponent(section);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(() => `${theme.fg("warning", "[Skill conflicts]")}\n${warningLines()}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(() => `${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines()}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionsResult = this.session.resourceLoader.getExtensions();
			for (const error of extensionsResult.errors) {
				extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
			}
			for (const warning of extensionsResult.warnings ?? []) {
				extensionDiagnostics.push({ type: "warning", message: warning.warning, path: warning.path });
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(() => `${theme.fg("warning", "[Extension issues]")}\n${warningLines()}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(() => `${theme.fg("warning", "[Theme conflicts]")}\n${warningLines()}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => {
					this.clearStatusIndicator();
					try {
						return await this.runtimeHost.newSession(options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (this.session.isIdle) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	private applyFullscreenScrollbarSetting(): void {
		this.transcriptScrollView?.setScrollbar(this.settingsManager.getFullscreenScrollbar());
	}

	private applyRuntimeSettings(): void {
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.applyFullscreenScrollbarSetting();
		if (this.renderer instanceof TuiAltScreen) {
			this.renderer.setCopyOnSelect(this.settingsManager.getFullscreenCopyOnSelect());
			this.renderer.setWheelScrollLines(this.settingsManager.getFullscreenWheelScrollLines());
		}
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		const clearOnShrink = this.settingsManager.getClearOnShrink();
		this.ui.setClearOnShrink(clearOnShrink);
		if (!clearOnShrink && !this.activeStatusIndicator) {
			this.statusContainer.clear();
		}
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		const session = this.session;

		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applyRuntimeSettings();

		if (options.renderBeforeBind) {
			this.renderCurrentSessionState();
			this.subscribeToAgent();
		}

		await this.bindCurrentSessionExtensions();

		if (this.session !== session) {
			return;
		}

		if (!options.renderBeforeBind) {
			this.subscribeToAgent();
		}

		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		const extensionHint = this.getCrashExtensionHint(error);
		if (extensionHint) {
			this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", extensionHint), this.outputPad, 0));
		}
		if (this.recordCrash("fatal_error", error)) {
			const instructions = this.crashReportInstructions();
			this.chatContainer.addChild(new ThemedText(() => theme.fg("muted", instructions), this.outputPad, 0));
		}
		stopThemeWatcher();
		this.stop("transcript");
		process.exit(1);
	}

	private getCrashExtensionHint(error: unknown): string | undefined {
		try {
			return formatCrashExtensionHint(
				findExtensionStackMatches(
					error instanceof Error ? error.stack : undefined,
					this.session.resourceLoader.getExtensions().extensions,
				),
			);
		} catch {
			return undefined;
		}
	}

	/** Persist a crash so the next start can point the user at `/bug`. Returns false when nothing was written. */
	private recordCrash(kind: "uncaught_exception" | "fatal_error", error: unknown): boolean {
		try {
			return (
				recordCrash({
					kind,
					error,
					sessionFile: this.session.sessionFile,
					cwd: this.session.sessionManager.getCwd(),
				}) !== undefined
			);
		} catch {
			return false;
		}
	}

	private crashReportInstructions(): string {
		// fork: translate display wrappers; keep data and model content unchanged.
		// fork: /bug is disabled; point to the local crash log instead.
		return fill("Crash details were saved to {0}/crashes.json.", getAgentDir());
	}

	private suggestBugReport(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (this.bugReportHintShown) return;
		this.bugReportHintShown = true;
		this.chatContainer.addChild(
			new ThemedText(
				() =>
					theme.fg(
						"muted",
						fill("If this looks like a {0} bug, /bug sends a report to the developers.", APP_NAME),
					),
				this.outputPad,
				0,
			),
		);
		this.ui.requestRender();
	}

	private maybeSuggestBugReport(message: AssistantMessage): void {
		if (message.stopReason !== "error" || isRetryableAssistantError(message)) return;
		if (/\b(?:abort(?:ed)?|cancel(?:l?ed)?)\b/i.test(message.errorMessage ?? "")) return;
		this.suggestBugReport();
	}

	private renderCurrentSessionState(): void {
		this.loadedResourcesContainer.clear();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	/**
	 * Extension-registered definition, falling back to the built-in one. The renderer components take
	 * whatever this returns, so they never reach into the tool registry themselves.
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return withBuiltInRenderers(toolName, this.session.getToolDefinition(toolName));
	}

	private getMarkdownTransformers(): MarkdownTransformer[] {
		return [this.mermaidMarkdownTransformer, ...this.session.extensionRunner.getMarkdownTransformers()];
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: extensionRunner.getModelRegistry(),
			model: this.session.model,
			scopedModels: this.session.scopedModels,
			thinkingLevel: this.session.thinkingLevel,
			isIdle: () => this.session.isIdle,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(fill("Shortcut handler error: {0}", err instanceof Error ? err.message : String(err)));
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean {
		this.defaultEditor.setWorkingStatusIndicator(undefined);
		if (!isWorkingStatusEditor(this.editor)) return false;
		this.editor.setWorkingStatusIndicator(indicator);
		return true;
	}

	private showStatusIndicator(indicator: StatusIndicator): void {
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = indicator;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.setEditorWorkingStatusIndicator(undefined);
		if (this.setEditorWorkingStatusIndicator(indicator)) {
			this.activeWorkingIndicatorEmbedded = true;
			return;
		}
		this.statusContainer.addChild(indicator);
	}

	private clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		if (kind && this.activeStatusIndicator?.kind !== kind) {
			return;
		}
		const clearedIndicator = this.activeStatusIndicator;
		const clearedIndicatorWasEmbedded = this.activeWorkingIndicatorEmbedded;
		clearedIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.setEditorWorkingStatusIndicator(undefined);
		if (
			clearedIndicator &&
			!clearedIndicatorWasEmbedded &&
			this.options.tuiMode === "regular" &&
			this.ui.getClearOnShrink()
		) {
			this.statusContainer.addChild(this.idleStatus);
		}
	}

	private showWorkingStatusIndicator(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const colorFn = isWorkingStatusEditor(this.editor)
			? (text: string) =>
					(this.editor.borderColor ?? theme.getThinkingBorderColor(this.session.thinkingLevel || "off"))(text)
			: undefined;
		this.showStatusIndicator(
			new WorkingStatusIndicator(
				this.ui,
				this.workingMessage ?? t(this.defaultWorkingMessage),
				this.workingIndicatorOptions,
				colorFn,
			),
		);
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.clearStatusIndicator("working");
			this.ui.requestRender();
			return;
		}
		if (this.session.isStreaming && this.activeStatusIndicator?.kind !== "working") {
			this.showWorkingStatusIndicator();
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setIndicator(options);
		}
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new ThemedText(() => theme.fg("muted", t("... (widget truncated)")), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setMessage(
				fill("{0} ({1} to interrupt)", t(this.defaultWorkingMessage), keyText("app.interrupt")),
			);
		}
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		this.footerContainer.clear();
		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.footerContainer.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.footerContainer.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const subscription = { handler, unsubscribe: this.ui.addInputListener(handler) };
		this.extensionTerminalInputSubscriptions.add(subscription);
		return () => {
			subscription.unsubscribe();
			this.extensionTerminalInputSubscriptions.delete(subscription);
		};
	}

	private rebindExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) {
			subscription.unsubscribe();
			subscription.unsubscribe = this.ui.addInputListener(subscription.handler);
		}
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) subscription.unsubscribe();
		this.extensionTerminalInputSubscriptions.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
		};
	}

	private createExtensionUIContext(): ExtensionUIContext {
		// fork: translate display wrappers; keep data and model content unchanged.
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.activeStatusIndicator?.kind === "working") {
					this.activeStatusIndicator.setMessage(message ?? t(this.defaultWorkingMessage));
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill, opts) => this.showExtensionEditor(title, prefill, opts),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					return this.themeController.setThemeInstance(themeOrName);
				}
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{
					tui: this.ui,
					timeout: opts?.timeout,
					onToggleToolsExpanded: () => this.onToolsKey(),
					warning: opts?.warning,
				},
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, secret: opts?.secret },
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(
		title: string,
		prefill?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			// fork: the signal closes the editor, as it closes the selector.
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}
			const onAbort = () => {
				this.hideExtensionEditor();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionEditor();
					resolve(undefined);
				},
				undefined,
				this.settingsManager.getExternalEditorCommand(),
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		// fork: with large pastes expanded; the other editor has no paste markers.
		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();

		this.disposeActiveSelector();
		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}
			if (newEditor.setAutocompleteMaxVisible !== undefined) {
				newEditor.setAutocompleteMaxVisible(this.defaultEditor.getAutocompleteMaxVisible());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		if (this.activeStatusIndicator) {
			this.statusContainer.clear();
			this.activeWorkingIndicatorEmbedded = this.setEditorWorkingStatusIndicator(this.activeStatusIndicator);
			if (!this.activeWorkingIndicatorEmbedded) {
				this.statusContainer.addChild(this.activeStatusIndicator);
			}
		}
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
			signal?: AbortSignal;
		},
	): Promise<T> {
		// fork: an aborted signal closes the component, as for the selector and input dialogs.
		if (options?.signal?.aborted) return Promise.resolve(undefined as T);
		this.extensionWindowsOpened++;
		// fork: setText drops the editor's large pastes. An untouched draft is left
		// as it is; a changed one gets the saved draft back with its pastes expanded.
		const savedText = this.editor.getText();
		const savedExpanded = this.editor.getExpandedText?.() ?? savedText;
		const restoreDraft = () => {
			if (this.editor.getText() !== savedText) this.editor.setText(savedExpanded);
		};
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			restoreDraft();
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;
			let panel: { handle: OverlayHandle; transition: PanelTransition } | undefined; // fork
			let slot: PanelTransition | undefined; // fork

			// Before the component is shown there is no overlay or editor slot to restore.
			const onAbort = () => {
				if (component) {
					close(undefined as T);
					return;
				}
				closed = true;
				resolve(undefined as T);
			};
			const close = (result: T) => {
				if (closed) return;
				closed = true;
				options?.signal?.removeEventListener("abort", onAbort);
				// fork: a panel that opened with a transition folds before it goes, without focus.
				if (panel) {
					const { handle } = panel;
					handle.unfocus();
					panel.transition.close(() => handle.hide());
					this.ui.requestRender();
				} else if (isOverlay) this.ui.hideOverlay();
				else if (slot) {
					// fork: keys go back to the editor at once; the menu folds in its place, then
					// gives it back unless the menu's next screen has replaced it.
					const going = component;
					restoreDraft();
					this.ui.setFocus(this.editor);
					slot.close(() => {
						if (this.editorContainer.children[0] !== going) return;
						this.editorContainer.clear();
						this.editorContainer.addChild(this.editor);
						this.ui.requestRender();
					});
					this.ui.requestRender();
				} else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			options?.signal?.addEventListener("abort", onAbort, { once: true });
			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) {
						// fork: cancelled or done while it was being built, it was never shown and
						// close() had nothing to dispose: its timers and subscriptions end here.
						try {
							c?.dispose?.();
						} catch {
							/* ignore dispose errors */
						}
						return;
					}
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const transition = renderHooks.panel?.(component); // fork
						const handle = this.ui.showOverlay(component, resolveOptions());
						if (transition) panel = { handle, transition };
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						// fork: a menu shown in place of the editor opens with a transition; the next
						// screen of a menu replaces the screen going at once, and folds when it goes.
						slot = renderHooks.panel?.(component, this.editorContainer.children[0] !== this.editor);
						this.disposeActiveSelector();
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const errorMsg = fill('Extension "{0}" error: {1}', extensionPath, error);
		const errorText = new ThemedText(() => theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack.split("\n").slice(1); // Skip first line (duplicates error message)
			if (stackLines.length > 0) {
				const renderStack = () => stackLines.map((line) => theme.fg("dim", `  ${line.trim()}`)).join("\n");
				this.chatContainer.addChild(new ThemedText(renderStack, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.session.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		for (const [action, command] of COMMAND_KEYS) {
			this.defaultEditor.onAction(action, () => {
				if (!this.session.extensionRunner.getCommand(command)) {
					this.showStatus(fill("/{0} is not available in this session.", command));
					return;
				}
				void this.session.prompt(`/${command}`).catch((error: unknown) => {
					this.showError(`/${command} shortcut failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			});
		}
		this.defaultEditor.onAction("app.tools.expand", () => this.onToolsKey());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.onThinkingKey());
		this.defaultEditor.onAction("app.editor.external", () => void this.handleOpenExternalEditor());
		this.defaultEditor.onAction(
			"app.message.copy",
			() => void this.handleCopyCommand({ flashConfirmation: true, preferSelection: true }),
		);
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard paste (triggered on Ctrl+V). Copied files use their original paths,
		// images are attached via temporary files, and plain text is the final fallback.
		this.defaultEditor.onPasteImage = () => {
			void this.handleClipboardPaste();
		};
	}

	private async handleRightClickPaste(): Promise<void> {
		const target = this.renderer.getFocusedComponent();
		const handleInput = target?.handleInput;
		if (!target || !handleInput) return;
		try {
			const text = await readClipboardText();
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			this.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private async handleClipboardPaste(): Promise<void> {
		try {
			const filePaths = await readClipboardFilePaths();
			if (filePaths) {
				if (filePaths.some((filePath) => /\p{Cc}/u.test(filePath))) {
					throw new Error("Clipboard file path contains control characters");
				}
				// an image as an image, a file from outside the project as a copy the agent can reach.
				const shown = pastedFiles(filePaths, () => attachTarget(this.sessionManager));
				const paths = this.isBashMode ? shown.map(quoteIfNeeded).join(" ") : shown.join("\n");
				const cursor = this.editor.getCursor?.();
				const currentLine = cursor ? (this.editor.getText().split("\n")[cursor.line] ?? "") : "";
				const characterBeforeCursor = cursor && cursor.col > 0 ? currentLine[cursor.col - 1] : "";
				const characterAfterCursor = cursor ? currentLine[cursor.col] : "";
				const leadingSpace = characterBeforeCursor && !/\s/.test(characterBeforeCursor) ? " " : "";
				const trailingSpace = characterAfterCursor && !/\s/.test(characterAfterCursor) ? " " : "";
				this.editor.insertTextAtCursor?.(`${leadingSpace}${paths}${trailingSpace}`);
				this.ui.requestRender();
				return;
			}

			const image = await readClipboardImage();
			if (image) {
				// fork.10 (LIV-08): sent to the model as an image, not as the path of a file it had to read.
				this.editor.insertTextAtCursor?.(attachPastedImage(image.bytes, image.mimeType));
				this.ui.requestRender();
				return;
			}

			const text = await readClipboardText();
			if (text) {
				this.editor.insertTextAtCursor?.(text);
				this.ui.requestRender();
			}
		} catch (error) {
			this.showError(`Failed to paste from clipboard: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * fork: a command chosen in a menu goes through the composer's submit path, which runs built-in commands
	 * too; session.prompt() only runs extension commands and sent "/scoped-models" to the model as a message.
	 * The draft comes back after.
	 */
	private submitCommandLine(line: string): Promise<void> {
		const draft = this.editor.getText();
		return Promise.resolve(this.defaultEditor.onSubmit?.(line)).finally(() => {
			if (draft && this.editor.getText() === "") this.editor.setText(draft);
		});
	}

	/**
	 * fork: a window an extension command opened from /settings comes back to /settings when
	 * closed, on the row it was chosen from; Esc in /perm window closed everything. A command that only writes to
	 * the conversation, or starts a turn, leaves the conversation shown. fork: so does one
	 * that put a command in the input box, as /lsp-setup does to install a server.
	 */
	private async runSettingsCommand(command: string, from?: { domain: string; item: string }): Promise<void> {
		const line = `/${command}`;
		if (!from || !this.isExtensionCommand(line)) {
			await this.submitCommandLine(line);
			return;
		}
		const windows = this.extensionWindowsOpened;
		const settings = this.settingsOpened;
		const draft = this.editor.getText();
		await this.session.prompt(line);
		if (
			this.extensionWindowsOpened === windows ||
			this.session.isStreaming ||
			this.settingsOpened !== settings ||
			this.editor.getText() !== draft
		)
			return;
		await this.showSettingsSelector(from.domain, from.item);
	}

	private handleStartupSubmit(text: string): void {
		this.editor.setText(text);
		this.showStatus("Startup is still in progress");
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			// fork: "/exit" runs "/quit", and other aliases (src/fork/command-aliases.ts).
			const aliased = /^\/(\S+)(\s.*)?$/.exec(text);
			if (aliased) {
				const target = resolveCommandAlias(
					aliased[1]!,
					(name) =>
						this.session.extensionRunner.getCommand(name) !== undefined ||
						BUILTIN_SLASH_COMMANDS.some((command) => command.name === name),
				);
				if (target) text = `/${target}${aliased[2] ?? ""}`;
				// fork: a command of a module that is off says so instead of going to the model as a message;
				// one whose module is unavailable or not supported by the model warns, then runs.
				const name = target ?? aliased[1]!;
				const notice = commandNotice(
					name,
					this.session.extensionRunner.getCommand(name) !== undefined ||
						BUILTIN_SLASH_COMMANDS.some((command) => command.name === name) ||
						this.session.promptTemplates.some((template) => template.name === name),
					sessionFeatureStates(this.session),
				);
				if (notice) {
					this.showWarning(notice.text);
					if (notice.stop) {
						this.editor.addToHistory?.(text);
						this.editor.setText("");
						return;
					}
				}
			}

			// Handle commands
			if (text === "/settings") {
				// fork: async, to read the web search key state first.
				await this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/thinking" || text.startsWith("/thinking ")) {
				const searchTerm = text.startsWith("/thinking ") ? text.slice(10).trim() : undefined;
				this.editor.setText("");
				this.handleThinkingCommand(searchTerm);
				return;
			}
			if (text === "/export" || text.startsWith("/export ")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/import" || text.startsWith("/import ")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/bug" || text.startsWith("/bug ")) {
				const hint = text.slice("/bug".length).trim();
				this.editor.setText("");
				await this.handleBugCommand(hint ? hint : undefined);
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/changelog") {
				// fork: cleared first, or the reader would put "/changelog" back on close.
				this.editor.setText("");
				this.handleChangelogCommand();
				return;
			}
			// fork: expand or collapse thinking and tool output together.
			if (text === "/expand") {
				this.editor.setText("");
				this.unfoldOnScreen(["tools", "thinking"]);
				this.toggleExpandAll();
				return;
			}
			// fork: filterable help.
			if (text === "/help") {
				this.editor.setText("");
				this.showHelpSelector();
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/clone") {
				this.editor.setText("");
				await this.handleCloneCommand();
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/trust") {
				this.showTrustSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login" || text.startsWith("/login ")) {
				const providerRef = text.startsWith("/login ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleLoginCommand(providerRef);
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/new") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/dementedelves") {
				this.handleDementedDelves();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/quit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, "steer");
				}
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text, { streamingBehavior: "steer" });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			} else {
				this.pendingUserInputs.push(text);
			}
			this.editor.addToHistory?.(text);
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				this.pendingTools.clear();
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				break;

			case "turn_start":
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				if (this.workingVisible) {
					if (this.activeStatusIndicator?.kind !== "working") {
						this.showWorkingStatusIndicator();
					}
				} else {
					this.clearStatusIndicator();
				}
				this.ui.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "entry_appended":
				if (this.entriesRenderedByBoundaryCompaction.delete(event.entry.id)) break;
				if (event.entry.type === "custom") {
					this.addCustomEntryToChat(event.entry);
					this.ui.requestRender();
				} else if (event.entry.type === "usage" && event.entry.kind === "cache_warm") {
					this.addCacheWarmingUsage(event.entry);
					this.ui.requestRender();
				} else if (event.entry.type === "custom_message" && event.entry.display) {
					this.addMessageToChat(
						createCustomMessage(
							event.entry.customType,
							event.entry.content,
							event.entry.display,
							event.entry.details,
							event.entry.timestamp,
						),
					);
					this.ui.requestRender();
				} else if (event.entry.type === "compaction") {
					const entries = this.sessionManager.buildContextEntries();
					if (entries[0]?.id !== event.entry.id) break;
					this.chatContainer.clear();
					const branch = this.sessionManager.getBranch();
					const compactionIndex = branch.findIndex((entry) => entry.id === event.entry.id);
					const entriesAfterCompaction = new Set(branch.slice(compactionIndex + 1).map((entry) => entry.id));
					const retainedEntries = entries.slice(1);
					this.renderSessionEntries(retainedEntries.filter((entry) => !entriesAfterCompaction.has(entry.id)));
					this.addMessageToChat(
						createCompactionSummaryMessage(event.entry.summary, event.entry.tokensBefore, event.entry.timestamp),
					);
					if (event.entry.usage) {
						this.addCompactionCostNotice({
							type: "compaction_cost",
							kind: "compaction",
							usage: event.entry.usage,
						});
					}
					this.renderSessionEntries(retainedEntries.filter((entry) => entriesAfterCompaction.has(entry.id)));
					for (const entryId of entriesAfterCompaction) this.entriesRenderedByBoundaryCompaction.add(entryId);
					this.footer.invalidate();
					this.ui.requestRender();
				}
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.thinkingExpansionOverride === undefined
							? this.hideThinkingBlock
							: !this.thinkingExpansionOverride, // fork
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
						this.outputPad,
						this.getMarkdownTransformers(),
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage, true);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage, true);

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
										imageWidthCells: this.settingsManager.getImageWidthCells(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								component.setChatSlot(this.chatContainer); // fork
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage, false);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
						this.maybeSuggestBugReport(this.streamingMessage);
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
						this.maybeShowThinkingDropNotice(this.streamingMessage);
						this.maybeShowCacheMissNotice(this.streamingMessage);
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "bash_execution_update":
				// The bash execution callback handles TUI output rendering.
				break;

			case "tool_execution_start": {
				// Nested calls (from codemode scripts) are shown inside their parent's row.
				if (event.parentToolCallId) break;
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
							imageWidthCells: this.settingsManager.getImageWidthCells(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					component.setChatSlot(this.chatContainer); // fork
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				this.clearStatusIndicator("working");
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();

				this.ui.requestRender();
				break;

			case "agent_settled":
				await this.checkShutdownRequested();
				break;

			case "compaction_start": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason));
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				this.clearStatusIndicator("compaction");
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus(
							interfaceWording(
								this.settingsManager.getInterfaceMode(),
								"Automatic summary cancelled",
								"Auto-compact (conversation summary) cancelled",
							),
						);
					}
				} else if (event.result) {
					const entries = this.sessionManager.buildContextEntries();
					if (entries[0]?.type !== "compaction") {
						throw new Error("Completed compaction is missing from the session context");
					}
					this.chatContainer.clear();
					// The latest compaction is prepended for model context; append it below at its chronological position.
					this.renderSessionEntries(entries.slice(1));
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					if (event.result.usage) {
						this.addCompactionCostNotice({
							type: "compaction_cost",
							kind: "compaction",
							usage: event.result.usage,
						});
					}
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						const errorMessage = event.errorMessage;
						this.chatContainer.addChild(new ThemedText(() => theme.fg("error", errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				this.showStatusIndicator(
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				this.clearStatusIndicator("retry");
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(
						fill(
							"Still unable to get a response after {0} attempts: {1}",
							String(event.attempt),
							event.finalError || t("Unknown error"),
						),
					);
				}
				this.ui.requestRender();
				break;
			}

			case "summarization_retry_scheduled": {
				this.showError(event.errorMessage);
				this.showStatusIndicator(
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.ui.requestRender();
				break;
			}

			case "summarization_retry_attempt_start": {
				this.clearStatusIndicator("retry");
				if (event.source === "branchSummary") {
					this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui));
				} else {
					this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason));
				}
				this.ui.requestRender();
				break;
			}

			case "summarization_retry_finished": {
				this.clearStatusIndicator("retry");
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/** Show a managed-tool status update in the chat. */
	private showManagedToolStatus(status: ToolStatus): void {
		if (!showsToolStatus(status, this.settingsManager.getInterfaceMode())) return; // fork
		if (!this.managedToolStatusStarted) {
			this.chatContainer.addChild(new Spacer(1));
			this.managedToolStatusStarted = true;
		}
		const message = () => (status.type === "warning" ? `${t("Warning: ")}${t(status.message)}` : t(status.message));
		const color = status.type === "warning" ? "warning" : "dim";
		this.chatContainer.addChild(
			status.type === "warning"
				? new NoticeText("warning", status.message, () => theme.fg(color, message()), 1)
				: new ThemedText(() => theme.fg(color, message()), 1, 0),
		);
		this.lastStatusSpacer = undefined;
		this.lastStatusText = undefined;
		this.ui.requestRender();
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusMessage.text = message;
			this.lastStatusText.invalidate();
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const shown = { text: message };
		this.lastStatusMessage = shown;
		const text = new ThemedText(() => theme.fg("dim", shown.text.split("\n").map(t).join("\n")), 1, 0); // fork: t()
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
		if (!renderer) {
			return;
		}
		const component = new CustomEntryComponent(entry, renderer);
		component.setExpanded(this.toolOutputExpanded);
		if (!component.hasContent()) {
			return;
		}

		if (this.streamingComponent) {
			const streamingIndex = this.chatContainer.children.indexOf(this.streamingComponent);
			if (streamingIndex >= 0) {
				this.chatContainer.children.splice(streamingIndex, 0, component);
				return;
			}
		}

		this.chatContainer.addChild(component);
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				component.setExpanded(this.toolOutputExpanded); // fork
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(
						message,
						renderer,
						this.getMarkdownThemeWithSettings(),
						this.outputPad,
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "system":
				break;
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
								this.getMarkdownTransformers(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							this.getMarkdownTransformers(),
						);
						this.chatContainer.addChild(userComponent);
					}
					// fork.10 (LIV-08): a pasted screenshot shows under the message it was sent with.
					for (const image of userMessageImages(message, {
						show: this.settingsManager.getShowImages(),
						widthCells: this.settingsManager.getImageWidthCells(),
						fallbackColor: (text) => theme.fg("muted", text),
					}))
						this.chatContainer.addChild(image);
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.thinkingExpansionOverride === undefined ? this.hideThinkingBlock : !this.thinkingExpansionOverride, // fork
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					this.outputPad,
					this.getMarkdownTransformers(),
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	private renderSessionItems(
		items: readonly RenderSessionItem[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// Cache misses are not persisted, unlike successful cache-warming usage.
		// Re-derive them and inject them after the assistant messages that paid for them.
		const cacheMisses = this.settingsManager.getShowCacheMissNotices()
			? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRuntime)
			: new Map<AssistantMessage, CacheMiss>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const item of items) {
			if (isCustomSessionEntry(item)) {
				this.addCustomEntryToChat(item);
				continue;
			}
			if (isUsageSessionEntry(item)) {
				this.addCacheWarmingUsage(item);
				continue;
			}
			if (isCompactionCostNotice(item)) {
				this.addCompactionCostNotice(item);
				continue;
			}

			const message = item;
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								imageWidthCells: this.settingsManager.getImageWidthCells(),
							},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						component.setChatSlot(this.chatContainer); // fork

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					const miss = cacheMisses.get(message);
					if (miss) this.addCacheMissNotice(miss);
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.ui.requestRender();
	}

	/**
	 * Render session entries to chat. Used for initial load and rebuild after compaction.
	 * @param entries Compaction-aware session entries to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionEntries(
		entries: SessionEntry[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		const items = entries.flatMap((entry): RenderSessionItem[] => {
			if (entry.type === "custom" || (entry.type === "usage" && entry.kind === "cache_warm")) {
				return [entry];
			}
			const messages = sessionEntryToContextMessages(entry);
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && messages.length > 0) {
				return [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }];
			}
			return messages;
		});
		this.renderSessionItems(items, options);
	}

	private addCacheWarmingUsage(entry: UsageEntry): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;
		this.chatContainer.addChild(new Spacer(1));
		const usage = formatCacheWarmingUsage(entry);
		this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", usage), 1, 0));
	}

	/**
	 * Render billing usage for a compaction or branch summary. The notice is derived
	 * from persisted summary usage and is not stored as a separate session entry.
	 */
	private addCompactionCostNotice(notice: CompactionCostNotice): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		const { usage } = notice;
		const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
		const label = notice.kind === "compaction" ? "Compaction" : "Branch summary";
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new ThemedText(
				() => theme.fg("warning", fill("{0}: {1} tokens billed{2}", t(label), formatTokens(tokens), cost)),
				1,
				0,
			),
		);
	}

	private static countDroppedThinkingBlocks(message: AssistantMessage): number {
		let count = 0;
		for (const diagnostic of message.diagnostics ?? []) {
			if (diagnostic.type !== "anthropic_input_transformations") continue;
			const transformations = diagnostic.details?.transformations;
			if (!Array.isArray(transformations)) continue;
			count += transformations.filter(
				(transformation) =>
					typeof transformation === "object" &&
					transformation !== null &&
					(transformation as Record<string, unknown>).type === "thinking_dropped",
			).length;
		}
		return count;
	}

	private maybeShowThinkingDropNotice(message: AssistantMessage): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		const droppedCount = InteractiveMode.countDroppedThinkingBlocks(message);
		if (droppedCount === 0) return;

		let previousDroppedCount = 0;
		// message_end reaches the UI before the current message is persisted,
		// so the branch's last assistant message is the previous response.
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				previousDroppedCount = InteractiveMode.countDroppedThinkingBlocks(entry.message);
				break;
			}
		}
		if (droppedCount <= previousDroppedCount) return;

		// fork: the count is display-only.
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new ThemedText(
				() =>
					theme.fg(
						"warning",
						fill(
							droppedCount === 1
								? "Anthropic dropped {0} thinking block (details in session)"
								: "Anthropic dropped {0} thinking blocks (details in session)",
							String(droppedCount),
						),
					),
				1,
				0,
			),
		);
	}

	/**
	 * Show a transcript notice when a completed assistant message paid for a
	 * significant cache miss. Only states observable facts: the miss itself,
	 * a model switch, or an idle gap past the cache TTL.
	 */
	private maybeShowCacheMissNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// Entries don't contain `message` yet: message_end fires before persistence.
		const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRuntime);
		if (miss) this.addCacheMissNotice(miss);
	}

	private addCacheMissNotice(miss: CacheMiss): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

		const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
		const reBilled = fill("{0} tokens re-billed{1}", formatTokens(miss.missedTokens), cost);
		let label = t("Cache miss");
		if (miss.modelChanged) {
			label = t("Cache miss after model switch");
		} else if (miss.idleMs >= CACHE_TTL_MS) {
			label = fill("Cache miss after {0}m idle", String(Math.round(miss.idleMs / 60_000)));
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", fill("{0}: {1}", label, reBilled)), 1, 0));
	}

	renderInitialMessages(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const entries = this.sessionManager.buildContextEntries();
		this.renderSessionEntries(entries, {
			updateFooter: true,
			populateHistory: true,
		});
		this.renderProjectTrustWarningIfNeeded();

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? t("1 time") : fill("{0} times", String(compactionCount));
			this.showStatus(fill("Session compacted {0}", times));
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new ThemedText(
				() =>
					theme.fg(
						"warning",
						fill(
							"This project folder is untrusted. Its settings, extensions, and instructions were not loaded. Trust it later with /trust, then restart {0}.",
							APP_NAME,
						),
					),
				1,
				0,
			),
		);
	}

	async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		this.renderSessionEntries(this.sessionManager.buildContextEntries());
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.runtimeHost.dispose();
			this.themeController.disableAutoSync();
			await this.ui.terminal.drainInput(1000);
			this.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		this.themeController.disableAutoSync();
		await this.ui.terminal.drainInput(1000);

		this.stop();
		await this.runtimeHost.dispose();

		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		console.error(`${APP_NAME} exiting due to uncaughtException:`);
		console.error(error);
		const extensionHint = this.getCrashExtensionHint(error);
		if (extensionHint) console.error(`\n${extensionHint}`);
		if (this.recordCrash("uncaught_exception", error)) {
			console.error(`\n${this.crashReportInstructions()}`);
		}
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in pi) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.activeStatusIndicator?.invalidate();
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus(THINKING_UNSUPPORTED); // fork
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				// fork: with no model at all, say so and how to add one; translated.
				const msg =
					this.session.scopedModels.length > 0
						? "Only one model in scope"
						: this.session.modelRuntime.getAvailableSnapshot().length === 0
							? formatNoModelsAvailableMessage()
							: "Only one model available";
				this.showStatus(t(msg));
			} else {
				this.warnLowCompactionThreshold(result.model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off"
						? fill(" (thinking: {0})", result.thinkingLevel)
						: "";
				this.showStatus(fill("Switched to {0}{1}", result.model.name || result.model.id, thinkingStr));
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	/** ctrl+o, the blocks on screen unfolding or folding. */
	private onToolsKey(): void {
		this.unfoldOnScreen(["tools", "thinking"]);
		this.toggleToolOutputExpansion();
	}

	/** ctrl+t, the thinking blocks on screen unfolding or folding. */
	private onThinkingKey(): void {
		this.unfoldOnScreen(["thinking"]);
		this.toggleThinkingBlockVisibility();
	}

	/** the blocks on screen unfold or fold before a global toggle changes them. */
	private unfoldOnScreen(ids: readonly ("tools" | "thinking")[]): void {
		const blocks = [this.headerContainer, ...this.loadedResourcesContainer.children, ...this.chatContainer.children];
		const columns = this.ui.terminal.columns;
		if (this.renderer instanceof TuiMainScreen) {
			// The document is the top of the main screen's rows, so its rows from the viewport's top are on screen.
			const top = this.renderer.captureRenderState().previousViewportTop;
			unfoldOnScreen(blocks, columns, top, Number.POSITIVE_INFINITY, ids);
			return;
		}
		const view = this.transcriptScrollView;
		if (view)
			unfoldOnScreen(
				blocks,
				view.getContentWidth(columns),
				view.scrollTop,
				view.scrollTop + view.viewportHeight,
				ids,
			);
	}

	private setToolsExpanded(expanded: boolean): void {
		// fork: always force the state, including thinking and pending bash output.
		this.toolOutputExpanded = expanded;
		this.thinkingExpansionOverride = expanded;
		const activeHeader = this.customHeader ?? this.builtInHeader;
		applyExpansion(expanded, [
			activeHeader,
			...this.loadedResourcesContainer.children,
			...this.chatContainer.children,
			...(this.pendingBashComponents ?? []),
		]);
		this.showStatus(`Tool output: ${expanded ? "expanded" : "collapsed"}`);
	}

	/** Update rendered assistant messages without rebuilding live tool components. */
	private updateThinkingBlockVisibility(): void {
		this.thinkingExpansionOverride = undefined; // fork: Ctrl+T/settings take precedence until the next Ctrl+O.
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.hideThinkingBlock);
			}
		}
		this.ui.requestRender();
	}

	/** fork: expand thinking and tool output, or collapse both when both are already open. */
	private toggleExpandAll(): void {
		const expand = !this.toolOutputExpanded || this.hideThinkingBlock;
		this.setToolsExpanded(expand);
		// Same switch as the thinking shortcut, so the choice is saved the same way.
		if (this.hideThinkingBlock === expand) this.toggleThinkingBlockVisibility();
		this.showStatus(expand ? "Thinking and tool output: expanded" : "Thinking and tool output: collapsed");
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
		this.updateThinkingBlockVisibility();
		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private async handleOpenExternalEditor(): Promise<void> {
		const editorCmd = this.settingsManager.getExternalEditorCommand();
		const content = this.editor.getExpandedText?.() ?? this.editor.getText();
		let failure: string | undefined;
		this.ui.stop();
		try {
			const result = await editInExternalEditor({
				command: editorCmd,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
			// fork: the prompt is kept and the reason shown once the screen is back.
			else if (result.error) failure = result.error;
		} finally {
			this.ui.start();
			this.ui.requestRender(true);
		}
		if (failure) this.showError(`External editor: ${failure}`);
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new NoticeText(
				"error",
				errorMessage,
				() => theme.fg("error", `${t("Error: ")}${t(errorMessage)}`), // fork: t()
				this.outputPad,
			),
		);
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new NoticeText(
				"warning",
				warningMessage,
				() => theme.fg("warning", `${t("Warning: ")}${t(warningMessage)}`), // fork: t()
				1,
			),
		);
		this.ui.requestRender();
	}

	showNewVersionNotification(release: LatestPiRelease): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const updateInstruction = () =>
			theme.fg("muted", fill("New version {0} is available. Run ", release.version)) +
			theme.fg("accent", `${APP_NAME} update`);
		const changelogUrl = "https://pi.dev/changelog";
		const changelogLine = () => {
			const changelogLink = getCapabilities().hyperlinks
				? hyperlink(theme.fg("accent", changelogUrl), changelogUrl)
				: theme.fg("accent", changelogUrl);
			return theme.fg("muted", "Changelog: ") + changelogLink;
		};
		const note = release.note?.trim();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new ThemedText(
				() => `${theme.bold(theme.fg("warning", t("Update Available")))}\n${updateInstruction()}`,
				1,
				0,
			),
		);
		if (note) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
					color: (text) => theme.fg("muted", text),
				}),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		// fork: pi.dev's changelog is not Prism's.
		if (!IS_BRANDED_BUILD) this.chatContainer.addChild(new ThemedText(changelogLine, 1, 0));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const updateInstruction = () =>
			theme.fg("muted", t("Package updates are available. Run ")) +
			theme.fg("accent", `${APP_NAME} update --extensions`);
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new ThemedText(
				() =>
					`${theme.bold(theme.fg("warning", t("Package Updates Available")))}\n${updateInstruction()}\n${theme.fg("muted", t("Packages:"))}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", fill("Steering: {0}", message));
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", fill("Follow-up: {0}", message));
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", fill("↳ {0} to edit all queued messages", dequeueHint));
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				void this.session.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			void this.session.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				fill(
					queuedMessages.length > 1 ? "Failed to send queued messages: {0}" : "Failed to send queued message: {0}",
					error instanceof Error ? error.message : String(error),
				),
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Start a prompt when idle, or queue it into a run still finishing compaction.
			const promptPromise = this.session
				.prompt(firstPrompt.text, { streamingBehavior: firstPrompt.mode })
				.catch((error) => {
					restoreQueue(error);
				});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	private disposeActiveSelector(): void {
		const dispose = this.activeSelectorDispose;
		this.activeSelectorToken = undefined;
		this.activeSelectorDispose = undefined;
		dispose?.();
	}

	/**
	 * fork: shows a selector as a centred window over the screen instead of in the editor's
	 * place, with the same factory as showSelector. The width is read at each render (a getter), so the
	 * window follows terminal resizes.
	 */
	private showSettingsOverlay(
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
	): void {
		let handle: OverlayHandle | undefined;
		let dispose: (() => void) | undefined;
		let transition: PanelTransition | undefined;
		// the window is narrower than the terminal and often shorter, so the input box drawn under
		// it showed its border on the edges. The box leaves the screen while the window is open.
		const hidden = [...this.editorContainer.children];
		this.editorContainer.clear();
		const done = () => {
			dispose?.();
			if (this.editorContainer.children.length === 0)
				for (const child of hidden) this.editorContainer.addChild(child);
			// fork: a panel that opened with a transition folds before it goes, without focus.
			const closing = handle;
			if (closing && transition) {
				closing.unfocus();
				transition.close(() => closing.hide());
				this.ui.requestRender();
			} else closing?.hide();
			handle = undefined;
		};
		const created = create(done);
		dispose = created.dispose;
		const ui = this.ui;
		transition = renderHooks.panel?.(created.focus);
		handle = ui.showOverlay(created.focus, {
			anchor: "center",
			get width() {
				return Math.min(ui.terminal.columns - 2, SETTINGS_MAX_WIDTH);
			},
			maxHeight: "100%",
		});
		ui.requestRender();
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
	): void {
		const token = {};
		let dispose: (() => void) | undefined;
		const done = () => {
			dispose?.();
			if (this.activeSelectorToken !== token) return;
			this.activeSelectorToken = undefined;
			this.activeSelectorDispose = undefined;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const created = create(done);
		dispose = created.dispose;
		this.disposeActiveSelector();
		this.activeSelectorToken = token;
		this.activeSelectorDispose = dispose;
		this.editorContainer.clear();
		this.editorContainer.addChild(created.component);
		this.ui.setFocus(created.focus);
		this.ui.requestRender();
	}

	private async showSettingsSelector(startDomain?: string, startItem?: string, openStartItem = false): Promise<void> {
		this.settingsOpened++;
		let closeSettings: (() => void) | undefined;
		let selector: SettingsSelectorComponent | undefined;
		// the operations are shared with the Prism window (settings-operations.ts); what follows
		// each one here is what the terminal draws of it.
		const { config, callbacks } = await settingsOperations(this.session, {
			view: {
				currentTheme: this.themeController.getThemeSelection() || SYSTEM_THEME_NAME,
				terminalTheme: this.themeController.getTerminalTheme(),
				hideThinkingBlock: this.hideThinkingBlock,
				tuiMode: this.ui.mode,
			},
			requestRender: () => this.ui.requestRender(),
			onWebSearchKey: (action) => {
				closeSettings?.();
				void this.session.prompt(action === "remove" ? "/web-key remove" : "/web-key");
			},
			onWebSearchReload: () => {
				closeSettings?.();
				void this.handleReloadCommand();
			},
			notify: (message, type) => this.showExtensionNotify(message, type),
			warn: (message) => this.showWarning(message),
			onRunCommand: (command, from) => {
				closeSettings?.();
				void this.runSettingsCommand(command, from);
			},
			reload: () => void this.handleReloadCommand(),
			// fork: the theme editor shows a theme in memory, then saves the new setting.
			themeEditor: {
				active: () => theme.name ?? SYSTEM_THEME_NAME,
				setting: () => this.themeController.getThemeSelection() ?? SYSTEM_THEME_NAME,
				preview: (instance) => {
					this.themeController.setThemeInstance(instance);
					this.ui.invalidate();
					this.ui.requestRender();
				},
				apply: (setting) => {
					this.settingsManager.setTheme(setting);
					this.themeController.setThemeSetting(setting);
				},
				restore: () => {
					this.themeController.applyFromSettings();
					this.ui.invalidate();
					this.ui.requestRender();
				},
			},
			effects: {
				onThinkingChanged: () => {
					this.footer.invalidate();
					this.updateEditorBorderColor();
				},
				onAutoCompactChange: (enabled) => this.footer.setAutoCompactEnabled(enabled),
				onShowImagesChange: (enabled) => {
					for (const child of this.chatContainer.children) {
						if (child instanceof ToolExecutionComponent) {
							child.setShowImages(enabled);
						}
					}
				},
				onImageWidthCellsChange: (width) => {
					for (const child of this.chatContainer.children) {
						if (child instanceof ToolExecutionComponent) {
							child.setImageWidthCells(width);
						}
					}
				},
				onEnableSkillCommandsChange: () => this.setupAutocompleteProvider(),
				onHttpIdleTimeoutMsChange: (timeoutMs) =>
					this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`),
				onCacheWarmingModeChange: (mode) => this.showStatus(`Cache warming: ${mode}`),
				onThemeChange: (themeSetting) => this.themeController.setThemeSetting(themeSetting),
				onThemePreview: (themeName) => this.themeController.preview(themeName),
				onHideThinkingBlockChange: (hidden) => {
					this.hideThinkingBlock = hidden;
					this.updateThinkingBlockVisibility();
				},
				onMermaidRenderingModeChange: () => {
					this.chatContainer.invalidate();
					this.ui.requestRender();
				},
				onShowCacheMissNoticesChange: () => this.rebuildChatFromMessages(),
				onShowHardwareCursorChange: (enabled) => this.ui.setShowHardwareCursor(enabled),
				onEditorPaddingXChange: (padding) => {
					this.defaultEditor.setPaddingX(padding);
					if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
						this.editor.setPaddingX(padding);
					}
				},
				onOutputPadChange: (padding) => {
					this.outputPad = padding;
					if (this.streamingComponent || this.session.isStreaming) {
						for (const child of this.chatContainer.children) {
							if (
								child instanceof AssistantMessageComponent ||
								child instanceof CustomMessageComponent ||
								child instanceof UserMessageComponent
							) {
								child.setOutputPad(padding);
							}
						}
						if (this.streamingComponent) {
							this.streamingComponent.setOutputPad(padding);
						}
						this.ui.requestRender();
						return;
					}
					this.rebuildChatFromMessages();
				},
				onAutocompleteMaxVisibleChange: (maxVisible) => {
					this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
					if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
						this.editor.setAutocompleteMaxVisible(maxVisible);
					}
				},
				onClearOnShrinkChange: (enabled) => {
					this.ui.setClearOnShrink(enabled);
					if (!enabled && !this.activeStatusIndicator) {
						this.statusContainer.clear();
					}
				},
				onTuiModeSwitch: (mode) => {
					// fork: no overlay may be open while the mode changes; Settings reopens on Terminal.
					closeSettings?.();
					if (this.switchTuiMode(mode)) return true;
					selector?.getSettingsList().updateValue("tui-mode", this.ui.mode);
					this.showStatus("Close active overlays before changing TUI mode");
					return false;
				},
				onTuiModeChange: (mode) => {
					if (!this.activeStatusIndicator) this.statusContainer.clear();
					this.showStatus(`TUI mode: ${mode}`);
					void this.showSettingsSelector("terminal");
				},
				onFullscreenScrollbarChange: () => this.applyFullscreenScrollbarSetting(),
				onFullscreenCopyOnSelectChange: (enabled) => {
					if (this.renderer instanceof TuiAltScreen) this.renderer.setCopyOnSelect(enabled);
				},
				onFullscreenWheelScrollLinesChange: (lines) => {
					if (this.renderer instanceof TuiAltScreen) this.renderer.setWheelScrollLines(lines);
				},
				onClose: () => {
					closeSettings?.();
				},
			},
		});
		const domainExtras = config.domainExtras!;
		// fork: Settings is a window over the screen, as tall as the terminal allows.
		domainExtras.rows = () => this.ui.terminal.rows;
		domainExtras.startDomain = startDomain;
		domainExtras.startItem = startItem;
		domainExtras.openStartItem = openStartItem;
		this.showSettingsOverlay((done) => {
			closeSettings = () => {
				done();
				this.ui.requestRender();
			};
			selector = new SettingsSelectorComponent(config, callbacks);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private handleThinkingCommand(searchTerm?: string): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		// fork: a model not marked as reasoning has only "off"; say how to change the mark.
		if (this.session.model && !this.session.model.reasoning) {
			this.showStatus(THINKING_UNSUPPORTED);
			return;
		}
		const availableLevels = this.session.getAvailableThinkingLevels();
		if (!searchTerm) {
			this.showThinkingSelector();
			return;
		}

		const normalized = searchTerm.trim().toLowerCase();
		const level = availableLevels.find((candidate) => candidate.toLowerCase() === normalized);
		if (!level) {
			this.showError(
				fill('Unknown thinking level "{0}". Available levels: {1}.', searchTerm, availableLevels.join(", ")),
			);
			return;
		}

		this.selectThinkingLevel(level, false);
	}

	private selectThinkingLevel(level: ThinkingLevel, persist: boolean): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		try {
			this.session.setThinkingLevel(level, { persist });
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(persist ? fill("Default thinking level: {0}", level) : `Thinking level: ${level}`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showThinkingSelector(): void {
		this.showSelector((done) => {
			const selectLevel = (level: ThinkingLevel, persist: boolean) => {
				this.selectThinkingLevel(level, persist);
				done();
			};
			const selector = new ThinkingSelectorComponent(
				this.session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
				this.session.getAvailableThinkingLevels(),
				(level) => selectLevel(level, false),
				() => {
					done();
					this.ui.requestRender();
				},
				(level) => selectLevel(level, true),
				this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model, { persist: false });
				this.warnLowCompactionThreshold(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		// fork: translate display wrappers; keep data and model content unchanged.
		const cachedModels =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: [...this.session.modelRuntime.getAvailableSnapshot()];
		const cachedMatch = findExactModelReferenceMatch(searchTerm, cachedModels);
		if (cachedMatch || this.session.scopedModels.length > 0) return cachedMatch;

		this.showStatus("Refreshing model catalogs…");
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, 15_000);
		try {
			const result = await refreshModelCatalogs(this.session.modelRuntime, controller.signal);
			if (result.aborted && timedOut) {
				this.showWarning("Model refresh timed out; searching cached models.");
			} else if (result.errors.size > 0) {
				this.showWarning(
					withReloginNote(
						fill("Could not refresh {0}; searching cached models.", [...result.errors.keys()].join(", ")),
						result.errors.values(),
					),
				);
			}
		} catch (error) {
			this.showWarning(
				timedOut
					? "Model refresh timed out; searching cached models."
					: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timeout);
		}
		return findExactModelReferenceMatch(searchTerm, [...this.session.modelRuntime.getAvailableSnapshot()]);
	}

	/** Update the footer's available provider count from the current snapshot without refreshing catalogs. */
	private updateAvailableProviderCount(): void {
		const models =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: this.session.modelRuntime.getAvailableSnapshot();
		const uniqueProviders = new Set(models.map((model) => model.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		try {
			if ((await this.session.modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
				this.anthropicSubscriptionWarningShown = true;
				this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
				return;
			}
			const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		// fork: translate display wrappers; keep data and model content unchanged.
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(
				fill(
					"Could not save project trust after reload: {0}",
					error instanceof Error ? error.message : String(error),
				),
			);
			return false;
		}
	}

	private showTrustSelector(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const cwd = this.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		const savedDecision = trustStore.getEntry(cwd);
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd,
				savedDecision,
				projectTrusted: this.settingsManager.isProjectTrusted(),
				onSelect: (selection) => {
					trustStore.setMany(selection.updates);
					done();
					this.showStatus(
						fill(
							"Saved trust decision: {0}. Restart {1} for this to take effect.",
							t(selection.trusted ? "trusted" : "untrusted"),
							APP_NAME,
						),
					);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showModelSelector(initialSearchInput?: string): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		this.showSelector((done) => {
			const selectModel = async (model: Model<any>, persist: boolean) => {
				try {
					await this.session.setModel(model, { persist });
					this.warnLowCompactionThreshold(model);
					this.updateAvailableProviderCount();
					this.footer.invalidate();
					this.updateEditorBorderColor();
					done();
					this.showStatus(
						persist ? fill("Default model: {0}/{1}", model.provider, model.id) : `Model: ${model.id}`,
					);
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
					this.checkDaxnutsEasterEgg(model);
				} catch (error) {
					done();
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			const defaultProvider = this.settingsManager.getDefaultProvider();
			const defaultModel = this.settingsManager.getDefaultModel();
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.session.modelRuntime,
				this.session.scopedModels,
				(model) => selectModel(model, false),
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
				(model) => selectModel(model, true),
				defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
			);
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	private showModelsSelector(): void {
		// the reads, the session's scope, the refresh and the save are shared with the window.
		const operations = scopedModelsOperations(this.session, this.settingsManager, () => {
			this.updateAvailableProviderCount();
			this.ui.requestRender();
		});

		this.showSelector((done) => {
			let disposed = false;
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels: operations.models(),
					enabledModelIds: operations.enabledIds(),
					refreshStatus: "Refreshing model catalogs…",
				},
				{
					onChange: (enabledIds) => operations.change(enabledIds),
					onPersist: (enabledIds) => {
						operations.persist(enabledIds);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			const refresh = operations.refresh();
			void refresh.done.then((result) => {
				if (disposed) return;
				if (result.reset) selector.updateModels(operations.models(), operations.enabledIds());
				else selector.updateModels(operations.models());
				selector.setRefreshStatus(result.status, result.kind);
				this.ui.requestRender();
			});
			return {
				component: selector,
				focus: selector,
				dispose: () => {
					disposed = true;
					refresh.abort();
				},
			};
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				// fork: /clone is the last entry of /fork.
				[
					...userMessages.map((m) => ({ id: m.entryId, text: m.text })),
					{ id: FORK_WHOLE_CONVERSATION, text: t(FORK_WHOLE_LABEL), detail: `  ${t(FORK_WHOLE_DETAIL)}` },
				],
				async (entryId) => {
					done();
					if (entryId === FORK_WHOLE_CONVERSATION) {
						await this.handleCloneCommand();
						return;
					}
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							this.ui.requestRender();
							return;
						}

						this.editor.setText(result.selectedText ?? "");
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showStatus("Nothing to clone yet");
			return;
		}

		try {
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === this.sessionManager.getLeafId()) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// The user committed to navigating: stop the active response first.
					if (this.session.isStreaming) {
						this.restoreQueuedMessagesToEditor();
						await this.session.abort();
					}

					// Recheck after the dialogs and streaming abort, before replacing another operation's UI.
					if (this.session.isCompacting) {
						this.showError(
							"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
						);
						return;
					}

					// Set up escape handler and status indicator if summarizing
					let showingSummaryIndicator = false;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui));
						showingSummaryIndicator = true;
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (showingSummaryIndicator) {
							this.clearStatusIndicator("branchSummary");
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			selector.onCopy = async (text) => {
				if (!text) {
					this.showError("Selected entry has no text to copy");
					return;
				}
				try {
					await copyToClipboard(text);
					this.showStatus("Copied selected message to clipboard");
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress, signal) =>
					SessionManager.list(
						this.sessionManager.getCwd(),
						this.sessionManager.getSessionDir(),
						onProgress,
						signal,
					),
				(onProgress, signal) =>
					this.sessionManager.usesDefaultSessionDir()
						? SessionManager.listAll(onProgress, signal)
						: SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				if (result.cancelled) {
					return result;
				}
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	// the options, the method labels, the model chosen after a login and the messages are shared with
	// the Prism window (src/fork/login-operations.ts).
	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		return loginProviderOptions(this.session.modelRuntime, authType);
	}

	private getLogoutProviderOptions(): Promise<AuthSelectorProvider[]> {
		return logoutProviderOptions(this.session.modelRuntime);
	}

	private findLoginProviderOptions(providerRef: string): AuthSelectorProvider[] {
		return matchLoginProviderOptions(this.getLoginProviderOptions(), providerRef);
	}

	private async handleLoginCommand(providerRef?: string): Promise<void> {
		if (!providerRef) {
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.findLoginProviderOptions(providerRef);
		if (providerOptions.length === 1) {
			await this.startProviderLogin(providerOptions[0]!);
			return;
		}

		if (providerOptions.length > 1) {
			const providerIds = new Set(providerOptions.map((provider) => provider.id));
			if (providerIds.size === 1) {
				this.showLoginAuthTypeSelector(providerOptions);
				return;
			}
		}

		this.showLoginProviderSelector(undefined, providerRef);
	}

	/** `onBack` reopens the selector the login was started from when the user cancels it. */
	private async startProviderLogin(providerOption: AuthSelectorProvider, onBack?: () => void): Promise<void> {
		// warn before a Claude subscription sign-in (src/fork/anthropic-subscription.ts).
		if (isAnthropicSubscription(providerOption)) {
			const go = t(ANTHROPIC_SUBSCRIPTION_GO);
			const choice = await this.showExtensionSelector(
				`${t(ANTHROPIC_SUBSCRIPTION_TITLE)}\n${theme.fg("error", theme.bold(t(ANTHROPIC_SUBSCRIPTION_RISK)))}`,
				[go, t("Back")],
			);
			if (choice !== go) {
				onBack?.();
				return;
			}
		}
		if (providerOption.authType === "oauth") {
			await this.showLoginDialog(providerOption.id, providerOption.name, onBack);
		} else if (providerOption.method?.login) {
			await this.showApiKeyLoginDialog(providerOption.id, providerOption.name, onBack);
		} else {
			this.showAmbientAuthDialog(providerOption, onBack);
		}
	}

	private showLoginAuthTypeSelector(providerOptions?: AuthSelectorProvider[]): void {
		// The top-level selector offers Radius directly, as its last option.
		const radiusOption = providerOptions
			? undefined
			: this.getLoginProviderOptions("oauth").find((provider) => provider.id === RADIUS_PROVIDER_ID);
		const radiusText = radiusOption ? `Sign in with ${radiusOption.name}` : undefined;
		const radiusLabel = radiusOption ? `${radiusText}${formatAuthSelectorProviderStatus(radiusOption)}` : undefined;
		// fork: add a server from its URL; first, local first (src/fork/login-menu.ts, login-operations.ts).
		const { title, methods } = loginMethods(providerOptions);
		const labelOf = (method: LoginMethod) => methods.find((entry) => entry.method === method)?.label;
		const serverLabel = labelOf("server");
		const subscriptionLabel = labelOf("oauth");
		const options = methods.map((entry) => entry.label);
		if (radiusLabel) options.push(radiusLabel);

		if (options.length === 0) {
			this.showStatus("No login methods available.");
			return;
		}

		if (providerOptions && options.length === 1) {
			const providerOption = providerOptions[0];
			if (providerOption) {
				void this.startProviderLogin(providerOption);
			}
			return;
		}

		this.showSelector((done) => {
			const onSelect = (option: string) => {
				done();
				if (radiusOption && option === radiusLabel) {
					void this.startProviderLogin(radiusOption, () => this.showLoginAuthTypeSelector());
					return;
				}
				if (option === serverLabel) {
					void this.showCompatibleServerLogin();
					return;
				}
				const authType = option === subscriptionLabel ? "oauth" : "api_key";
				if (providerOptions) {
					const providerOption = providerOptions.find((provider) => provider.authType === authType);
					if (providerOption) {
						void this.startProviderLogin(providerOption, () => this.showLoginAuthTypeSelector(providerOptions));
					}
					return;
				}
				this.showLoginProviderSelector(authType);
			};
			const onCancel = () => {
				done();
				this.ui.requestRender();
			};
			const selector =
				radiusLabel && radiusText
					? createLoginMenuSelector(
							this.ui,
							title,
							options,
							{ label: radiusLabel, text: radiusText },
							onSelect,
							onCancel,
						)
					: new ExtensionSelectorComponent(title, options, onSelect, onCancel);
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	private showLoginProviderSelector(authType?: AuthSelectorProvider["authType"], initialSearchInput?: string): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			this.showStatus(noLoginProvidersMessage(authType));
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				providerOptions,
				async (providerId, selectedAuthType) => {
					done();

					const providerOption = providerOptions.find(
						(provider) => provider.id === providerId && provider.authType === selectedAuthType,
					);
					if (!providerOption) {
						return;
					}

					await this.startProviderLogin(providerOption, () =>
						this.showLoginProviderSelector(authType, initialSearchInput),
					);
				},
				() => {
					done();
					if (authType) {
						this.showLoginAuthTypeSelector();
					} else {
						this.ui.requestRender();
					}
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (mode === "login") {
			this.showLoginAuthTypeSelector();
			return;
		}

		let providerOptions: AuthSelectorProvider[];
		try {
			providerOptions = await this.getLogoutProviderOptions();
		} catch (error) {
			this.showError(
				fill("Could not read stored credentials: {0}", error instanceof Error ? error.message : String(error)),
			);
			return;
		}
		if (providerOptions.length === 0) {
			this.showStatus(NO_STORED_CREDENTIALS);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					const result = await logoutProvider(this.session.modelRuntime, providerOption);
					if ("error" in result) {
						this.showError(result.error);
					} else {
						await this.updateAvailableProviderCount();
						this.showStatus(result.message);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		// the model chosen and the messages are shared with the Prism window (login-operations.ts).
		const actionLabel = loginActionLabel(authType, providerName, providerId);

		const session = this.session;
		// Dynamic catalogs may be empty until the first authenticated network refresh.
		const deferSelection = deferModelSelection(session, providerId, previousModel);
		const finishAuthentication = async () => {
			const { selectedModel, selectionError } = await selectModelAfterLogin(
				this.session,
				providerId,
				actionLabel,
				previousModel,
			);
			if (selectedModel) this.warnLowCompactionThreshold(selectedModel);

			await this.updateAvailableProviderCount();
			this.footer.invalidate();
			this.updateEditorBorderColor();
			if (selectedModel) {
				this.showStatus(
					fill("{0}. Selected {1}. Credentials saved to {2}", actionLabel, selectedModel.id, getAuthPath()),
				);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
				this.checkDaxnutsEasterEgg(selectedModel);
			} else {
				this.showStatus(fill("{0}. Credentials saved to {1}", actionLabel, getAuthPath()));
				if (selectionError) {
					this.showError(selectionError);
				} else {
					void this.maybeWarnAboutAnthropicSubscriptionAuth();
				}
			}
		};
		if (deferSelection) {
			this.showStatus(fill("{0}. Credentials saved to {1}. Refreshing model catalog…", actionLabel, getAuthPath()));
		} else {
			await finishAuthentication();
		}

		void refreshCatalogAfterLogin(session.modelRuntime, providerId, actionLabel)
			.then(async (warning) => {
				if (warning) this.showWarning(warning);
				// Do not replace a model or session selected while the refresh was running.
				if (deferSelection && this.session === session && session.model === previousModel) {
					await finishAuthentication();
				}
				if (this.session === session) this.offerLoginModels(providerId, providerName); // fork
				this.updateAvailableProviderCount();
				this.footer.invalidate();
				this.ui.requestRender();
			})
			.catch((error: unknown) => this.showWarning(catalogRefreshFailure(actionLabel, error)));
	}

	/** fork: choose which of the provider's models /model offers; see fork/login-models.ts. */
	private offerLoginModels(providerId: string, providerName: string): void {
		// Another dialog (one opened after the login, or by the user meanwhile) keeps the screen.
		if (this.editorContainer.children[0] !== this.editor) return;
		offerLoginModels({
			providerId,
			providerName,
			available: this.session.modelRuntime.getAvailableSnapshot(),
			patterns: this.settingsManager.getEnabledModels(),
			keep: loginModelsKeep(this.session, providerId),
			show: (create) =>
				this.showSelector((done) => {
					const component = create(done);
					return { component, focus: component };
				}),
			savePatterns: (patterns) => this.settingsManager.setEnabledModels(patterns),
			setScopedModels: (models) => this.session.setScopedModels(models),
			requestRender: () => {
				this.updateAvailableProviderCount();
				this.ui.requestRender();
			},
		});
	}

	// fork: /login entry for a server from its URL; see fork/compatible-server.ts.
	private async showCompatibleServerLogin(): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		const previousModel = this.session.model;
		const dialog = new LoginDialogComponent(this.ui, "server", () => {}, undefined, "Connect a compatible server");
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};
		try {
			const server = await connectCompatibleServer(this.session.modelRuntime, getModelsPath(), {
				signal: dialog.signal,
				prompt: (prompt) => this.showAuthPrompt(dialog, prompt, "server"),
				notify: (event) => this.notifyAuthDialog(dialog, event),
			});
			restoreEditor();
			await this.updateAvailableProviderCount();
			// shared with the Prism window (login-operations.ts).
			const { message, selectedModel } = await finishCompatibleServer(
				this.session,
				server,
				getModelsPath(),
				previousModel,
			);
			if (selectedModel) this.warnLowCompactionThreshold(selectedModel);
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(message);
			this.offerLoginModels(server.providerId, server.providerId); // fork: same scope as a login
		} catch (error: unknown) {
			restoreEditor();
			const failure = compatibleServerFailure(error);
			if (failure) this.showError(failure);
		}
	}

	private showAmbientAuthDialog(providerOption: AuthSelectorProvider, onBack?: () => void): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		const dialog = new LoginDialogComponent(
			this.ui,
			providerOption.id,
			() => {
				restoreEditor();
				onBack?.();
			},
			providerOption.name,
			fill("{0} setup", providerOption.name),
		);
		dialog.showInfo(
			fill("{0} is configured outside {1}.", providerOption.method?.name ?? t("Authentication"), APP_NAME),
			[],
			true,
		);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		const previousModel = this.session.model;

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		if (providerId === "amazon-bedrock") {
			dialog.showDetails([
				theme.fg("text", "You can also use an AWS profile, IAM keys, or role-based credentials."),
				theme.fg("muted", "See:"),
				theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
			]);
		}

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.loginProvider(dialog, providerId, "api_key");
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const failure = loginFailureMessage("api_key", providerName, error);
			if (failure) this.showError(failure);
			else onBack?.();
		}
	}

	private showAuthSelect(
		dialog: LoginDialogComponent,
		prompt: Extract<AuthPrompt, { type: "select" }>,
		providerId: string,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const restoreDialog = () => {
				this.editorContainer.clear();
				this.editorContainer.addChild(dialog);
				this.ui.setFocus(dialog);
				this.ui.requestRender();
			};
			const labels = prompt.options.map((option) => option.label);
			const tone = loginWarningTone(prompt.message);
			const selector = new ExtensionSelectorComponent(
				// Claude Code's warning in bold yellow (loginWarningTone).
				tone ? theme.fg(tone, theme.bold(prompt.message)) : prompt.message,
				labels,
				(_label, index) => {
					restoreDialog();
					// fork: by position, since two options may share a label.
					const id = prompt.options[index]?.id;
					if (id) resolve(id);
					else reject(new Error("Login cancelled"));
				},
				() => {
					restoreDialog();
					reject(new Error("Login cancelled"));
				},
				{ description: providerId === RADIUS_PROVIDER_ID ? RADIUS_LOGIN_INTRO : undefined },
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(selector);
			this.ui.setFocus(selector);
			this.ui.requestRender();
		});
	}

	private async showAuthPrompt(dialog: LoginDialogComponent, prompt: AuthPrompt, providerId: string): Promise<string> {
		let response: Promise<string>;
		if (prompt.type === "select") {
			response = this.showAuthSelect(dialog, prompt, providerId);
		} else if (prompt.type === "manual_code") {
			response = dialog.showManualInput(prompt.message);
		} else {
			response = dialog.showPrompt(prompt.message, prompt.placeholder, prompt.type === "secret");
		}
		if (!prompt.signal) return response;
		if (prompt.signal.aborted) throw new Error("Login cancelled");
		const signal = prompt.signal;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<string>((_resolve, reject) => {
			onAbort = () => reject(new Error("Login cancelled"));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([response, aborted]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	private notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
		if (event.type === "auth_url") {
			dialog.showAuth(event.url, event.instructions);
		} else if (event.type === "device_code") {
			dialog.showDeviceCode(event);
			dialog.showWaiting("Waiting for authentication...");
		} else if (event.type === "info") {
			dialog.showInfo(event.message, event.links);
		} else {
			dialog.showProgress(event.message);
		}
	}

	private async loginProvider(
		dialog: LoginDialogComponent,
		providerId: string,
		method: "api_key" | "oauth",
	): Promise<void> {
		await this.session.modelRuntime.login(
			providerId,
			method,
			{
				signal: dialog.signal,
				prompt: (prompt) => this.showAuthPrompt(dialog, prompt, providerId),
				notify: (event) => this.notifyAuthDialog(dialog, event),
			},
			{ getDeviceId: () => this.settingsManager.getOrCreateDeviceId() },
		);
	}

	private async showLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		const previousModel = this.session.model;
		const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {}, providerName);
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.loginProvider(dialog, providerId, "oauth");
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
			if (providerId === RADIUS_PROVIDER_ID) this.offerRadiusMcpServer(providerId, providerName);
		} catch (error: unknown) {
			restoreEditor();
			const failure = loginFailureMessage("oauth", providerName, error);
			if (failure) this.showError(failure);
			else onBack?.();
		}
	}

	/**
	 * Offer to point the Radius MCP server in the global mcp.json at the Radius login, adding the server
	 * when missing. Nothing is asked when a global server already uses this login.
	 */
	private offerRadiusMcpServer(providerId: string, providerName: string): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const mcpPath = path.join(getAgentDir(), "mcp.json");
		const normalizeUrl = (url: string) => url.replace(/\/+$/u, "");
		const { servers } = loadMcpConfig({
			agentDir: getAgentDir(),
			cwd: this.sessionManager.getCwd(),
			projectTrusted: false,
		});
		const existing = servers.find(
			(server) => "url" in server.config && normalizeUrl(server.config.url) === normalizeUrl(RADIUS_MCP_URL),
		);
		if (existing && "url" in existing.config && existing.config.auth?.provider === providerId) return;

		let name = existing?.name ?? "radius";
		if (!existing && servers.some((server) => server.name === name)) name = "radius-mcp";
		const config: McpHttpServerConfig =
			existing && "url" in existing.config
				? { ...existing.config, auth: { provider: providerId } }
				: { url: RADIUS_MCP_URL, auth: { provider: providerId } };
		// `auth` replaces the MCP OAuth sign-in.
		delete config.oauth;

		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				fill("Configure {0} MCP in {1}?", providerName, mcpPath),
				["Yes", "No"],
				(option) => {
					done();
					if (option !== "Yes") return;
					try {
						addMcpServerConfig(mcpPath, name, config);
					} catch (error: unknown) {
						this.showError(
							fill("Could not update {0}: {1}", mcpPath, error instanceof Error ? error.message : String(error)),
						);
						return;
					}
					// The MCP extension reads mcp.json when the session starts.
					void this.handleReloadCommand();
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new ThemedText(
				() =>
					theme.fg("muted", t("Reloading keybindings, extensions, skills, prompts, themes, and context files...")),
				1,
				0,
			),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		let chatRestoredBeforeSessionStart = false;
		let reloadBoxDismissed = false;
		const restoreChatBeforeSessionStart = () => {
			if (chatRestoredBeforeSessionStart) {
				return;
			}
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.outputPad = this.settingsManager.getOutputPad();
			this.rebuildChatFromMessages();
			chatRestoredBeforeSessionStart = true;
		};

		try {
			await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
			restoreChatBeforeSessionStart();
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.applyRuntimeSettings();
			this.themeController.applyFromSettings();
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRuntime.getError();
			if (modelsJsonError) {
				this.showError(fill("Could not load model settings from models.json: {0}", modelsJsonError));
			}
			this.showStatus(
				savedImplicitProjectTrust
					? "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"
					: "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
			);
			dismissReloadBox(this.editor as Component);
			reloadBoxDismissed = true;
		} catch (error) {
			if (!reloadBoxDismissed) {
				dismissReloadBox(previousEditor as Component);
			}
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath, {
					themeName: theme.name,
				});
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleImportCommand(text: string): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm(
			"Import session",
			fill("Replace current session with {0}?", inputPath),
		);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			this.clearStatusIndicator();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return;
			}
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return;
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return;
				}
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	private async handleShareCommand(): Promise<void> {
		await shareSession({
			session: this.session,
			ui: this.ui,
			editorContainer: this.editorContainer,
			editor: this.editor,
			showStatus: (message) => this.showStatus(message),
			showError: (message) => this.showError(message),
		});
	}

	private async handleBugCommand(hint: string | undefined): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		// fork: bug reports go to the Pi developers (Earendil); disabled in this fork.
		if (!BUG_REPORTS_ENABLED) {
			this.showWarning(fill("/bug is disabled in {0}.", APP_NAME));
			return;
		}
		await reportBug(
			{
				session: this.session,
				ui: this.ui,
				editorContainer: this.editorContainer,
				editor: this.editor,
				keybindings: this.keybindings,
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
			},
			hint,
		);
	}

	private async handleCopyCommand(
		options: { flashConfirmation?: boolean; preferSelection?: boolean } = {},
	): Promise<void> {
		// fork: translate display wrappers; keep data and model content unchanged.
		if (
			options.preferSelection &&
			this.ui instanceof TuiAltScreen &&
			!this.ui.getCopyOnSelect() &&
			this.ui.hasActiveSelection()
		) {
			await this.ui.copyActiveSelectionToClipboard();
			return;
		}

		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			if (options.flashConfirmation && this.ui instanceof TuiAltScreen) {
				this.ui.flash(t("Copied!"));
			} else {
				this.showStatus("Copied last agent message to clipboard");
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(
					new ThemedText(() => theme.fg("dim", fill("Session name: {0}", currentName)), 1, 0),
				);
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.session.setSessionName(name);
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName !== name) {
			this.showWarning(
				fill("Session name was normalized from {0} to {1}", JSON.stringify(name), JSON.stringify(sessionName)),
			);
		}
		this.chatContainer.addChild(new Spacer(1));
		const displayName = sessionName ?? name;
		this.chatContainer.addChild(
			new ThemedText(() => theme.fg("dim", fill("Session name set: {0}", displayName)), 1, 0),
		);
		this.ui.requestRender();
	}

	private handleSessionCommand(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();
		const entries = this.sessionManager.getEntries();
		const cacheWaste = computeCacheWaste(entries, this.session.modelRuntime);

		// Cost/token totals per provider/model actually used (e.g. OpenRouter `auto`
		// resolves to a concrete responseModel). Usage without model attribution is
		// grouped separately so the breakdown reconciles with the session total.
		const usageBreakdown = getUsageCostBreakdown(entries);

		// Snapshot the stats; the text is built on demand so it follows theme changes.
		const cacheWarmingStatus = this.session.cacheWarmingStatus;
		const cacheWarmingMode = this.settingsManager.getCacheWarmingMode();
		const model = this.session.model;
		const selectedModelKey = `${model?.provider}/${model?.id}`;
		const renderInfo = (): string => {
			let info = `${theme.bold(t("Session Info"))}\n\n`;
			if (sessionName) {
				info += `${theme.fg("dim", t("Name:"))} ${sessionName}\n`;
			}
			info += `${theme.fg("dim", t("File:"))} ${stats.sessionFile ?? t("In-memory")}\n`;
			info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
			info += `${theme.bold("Messages")}\n`;
			info += `${theme.fg("dim", t("Total:"))} ${stats.totalMessages}\n`;
			info += `${theme.fg("dim", t("User:"))} ${stats.userMessages}\n`;
			info += `${theme.fg("dim", t("Assistant:"))} ${stats.assistantMessages}\n`;
			info += `${theme.fg("dim", t("Tools:"))} ${fill("{0} calls, {1} results", String(stats.toolCalls), String(stats.toolResults))}\n\n`;
			info += `${theme.bold("Tokens")}\n`;
			// "Input" is the full prompt volume. With cache activity, split it into
			// cached (served from cache) vs uncached (everything else) - the only
			// provider-independent split. Cache writes, where reported, are a detail
			// of the uncached portion.
			const { input, cacheRead, cacheWrite } = stats.tokens;
			const promptTokens = input + cacheRead + cacheWrite;
			info += `${theme.fg("dim", t("Input:"))} ${promptTokens.toLocaleString()}\n`;
			if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
				const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
				info += `  ${theme.fg("dim", t("Cached:"))} ${cacheRead.toLocaleString()} ${hitRate}\n`;
				const written =
					cacheWrite > 0 ? ` ${theme.fg("dim", fill("({0} written to cache)", cacheWrite.toLocaleString()))}` : "";
				info += `  ${theme.fg("dim", t("Uncached:"))} ${(input + cacheWrite).toLocaleString()}${written}\n`;
			}
			info += `${theme.fg("dim", t("Output:"))} ${stats.tokens.output.toLocaleString()}\n`;
			info += `${theme.fg("dim", t("Total:"))} ${stats.tokens.total.toLocaleString()}\n`;

			info += `\n${theme.bold(t("Cache Warming"))}\n`;
			info += `${theme.fg("dim", t("Mode:"))} ${cacheWarmingMode}\n`;
			info += `${theme.fg("dim", t("Status:"))} ${cacheWarmingStatus ? formatCacheWarmingStatus(cacheWarmingStatus) : t("Inactive (cache warming unavailable)")}\n`;
			const decision = cacheWarmingStatus?.decision;
			if (decision?.economicsAvailable) {
				info += `${theme.fg("dim", t("Cache miss penalty:"))} $${decision.missCost.toFixed(3)}\n`;
				info += `${theme.fg("dim", t("Refresh cost:"))} $${decision.warmCost.toFixed(3)}\n`;
			}

			if (stats.cost > 0 || cacheWaste.missedTokens > 0) {
				info += `\n${theme.bold(t("Cost"))}\n`;
				info += `${theme.fg("dim", t("Total:"))} $${stats.cost.toFixed(3)}`;
				// A single entry repeats the total, unless it names a model other than the selected one.
				if (usageBreakdown.length > 1 || usageBreakdown[0]?.key !== selectedModelKey) {
					for (const entry of usageBreakdown) {
						info += `\n  ${theme.fg("dim", `${entry.key}:`)} $${entry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(entry.tokens)} tokens)`)}`;
					}
				}
				if (cacheWaste.missedTokens > 0) {
					const missLabel =
						cacheWaste.missCount === 1 ? t("1 miss") : fill("{0} misses", String(cacheWaste.missCount));
					const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
					info +=
						cacheWaste.missedCost >= 0.0001
							? `\n${theme.fg("dim", t("Cache Re-billed:"))} $${cacheWaste.missedCost.toFixed(3)} ${theme.fg("dim", `(${detail})`)}`
							: `\n${theme.fg("dim", t("Cache Re-billed:"))} ${detail}`;
				}
			}
			return info;
		};

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ThemedText(renderInfo, 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		// fork: translate display wrappers; keep data and model content unchanged.
		// fork: Prism's release notes in a branded build; their links are not upstream's.
		const changelogPath = IS_BRANDED_BUILD ? getPrismChangelogPath() : getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? // fork: newest first in the reader; the conversation had it last, by the editor.
					allEntries
						.map((e) => (IS_BRANDED_BUILD ? unwrapChangelog(e.content) : normalizeChangelogLinks(e.content, e)))
						.join("\n\n")
				: t("No changelog entries found.");

		// fork: a closable, searchable reader, not the whole history in the conversation.
		void this.showExtensionCustom<void>(
			(tui, _theme, _keybindings, done) => changelogReader(changelogMarkdown, tui, done),
			{
				overlay: true,
				overlayOptions: CHANGELOG_READER_OVERLAY,
			},
		);
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/** fork: shortcuts and common actions, most frequent first; choosing a command puts it in the editor. */
	private showHelpSelector(): void {
		const entries = helpEntries(
			keyDisplayText,
			(name) => this.session.extensionRunner.getCommand(name) !== undefined,
			sessionFeatureStates(this.session), // fork
		);
		this.showSelector((done) => {
			const selector = helpSelector(
				entries,
				(index) => {
					done();
					const command = entries[index]?.command;
					if (command) this.editor.setText(command);
					this.ui.requestRender();
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleClearCommand(): Promise<void> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new ThemedText(() => theme.fg("accent", "✓ New session started"), 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		// fork: the lines and messages hold no known secret once on disk (their JSON form
		// included), and the file is private.
		fs.writeFileSync(debugLogPath, maskText(debugData, knownSecrets()), { mode: 0o600 });

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new ThemedText(() => `${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDementedDelves(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		let eventResult: UserBashEventResult | undefined;
		try {
			eventResult = await extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd: this.sessionManager.getCwd(),
			});
		} catch {
			// The extension runner already reported the error. Do not fall back to local execution.
			return;
		}

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			this.bashComponent.setExpanded(this.toolOutputExpanded); // fork
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
		this.bashComponent.setExpanded(this.toolOutputExpanded); // fork

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		this.clearStatusIndicator();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		this.disposeActiveSelector();
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		this.clearStatusIndicator();
		this.themeController.disableAutoSync();
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.stopInteractiveTui(fullscreenExitOutput);
			this.isInitialized = false;
		}
		this.unregisterSignalHandlers();
	}
}

/**
 * fork: the permission gate, built in. Ported from
 * fork/reference/extensions/permissions.ts (pi-custom); differences:
 *   - default mode "broad" when no mode is configured, not "yolo";
 *   - paths come from config.ts (agent dir, project config dir), not ~/.pi;
 *   - fork: configuration writes are refused except through configure_prism;
 *     security settings belong exclusively to the user, including in unrestricted mode;
 *   - /perm help says this is not a sandbox.
 * Registered as an inline extension (src/extensions/index.ts), so --no-extensions,
 * --safe and the `extensions` setting do not turn it off; only the user can, with
 * /perm mode or --perm-mode. A user extension can replace it; a project extension
 * cannot.
 *
 * Gate: read-only tools and known-safe bash commands pass; writes, edits and other
 * bash commands ask (mode "ask"), are blocked (mode "safe") or pass (mode "broad",
 * formerly "yolo", still accepted as an alias); dangerous calls (sudo, rm -rf,
 * curl | sh, protected paths, writes outside the project...) always ask, with no
 * "always allow" option. Without a UI, anything that would ask is blocked.
 * mode "unrestricted" asks nothing at all (only explicit deny rules apply). It is
 * an explicit opt-in: accepted once in a warning dialog (stored in the global config),
 * or given on the command line; a project config cannot select it. Config: <agent dir>/permissions.json and, for trusted
 * projects, <project>/<config dir>/permissions.json:
 *
 *   { "mode": "ask", "allow": ["bash(npm run test*)", "write(src/**)"], "ask": [...],
 *     "deny": [...], "protectedPaths": ["secrets/**"], "tools": { "my_tool": "ask" } }
 *
 * Rule syntax: `tool` or `tool(glob)`, matched against the bash command, the resolved
 * path (read, write, edit) or JSON.stringify(input) for other tools.
 * Precedence: deny rules > configuration restrictions > unrestricted > built-in danger tier > allow rules > broad > ask rules and
 * built-in ask tier > tool default. No allow rule overrides the danger detection
 * a broad rule such as write(**) must not open Prism's own config files.
 * The `background` tool's command (action=run) is classified like a bash command.
 *
 * This is a guardrail based on patterns, not a sandbox: an allowed shell command can
 * do anything the user can, including reading auth.json.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir, getPackageDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "../core/extensions/types.ts";
import { resolveReadPath, resolveToCwd } from "../core/tools/path-utils.ts";
import { backgroundTasks } from "./background.ts";
import { extensionCopies } from "./browser/setup.ts";
import { configPathKind, configWriteRefusal, phoneLinkPath, shellConfigWrite } from "./config-policy.ts";
import { credentialPaths, holdsCredentials, insideCredentials } from "./credential-paths.ts";
import { DocReader } from "./docs-command.ts";
import { attachTarget, keepChangedAttachments } from "./file-attachments.ts";
import { bindFileCall, judgedFile } from "./file-binding.ts";
import { cacheFile } from "./file-cache.ts";
import { lockForkFile } from "./file-lock.ts";
import { repositoryProgramSetting } from "./git-repo-programs.ts";
import { globMatches } from "./glob-match.ts";
import { saveGlobalSetting } from "./global-settings.ts";
import { fill, t } from "./i18n/index.ts";
import { hasInteractiveClient, hasNativeMenus } from "./interactive-client.ts";
import { mcpTrust } from "./mcp-trust.ts";
import { guardedFetch, npmInstallRefusal } from "./npm-guard.ts";
import {
	DEFAULT_PERMISSION_MODE,
	PERMISSION_MODE_EVENT,
	PERMISSION_MODE_QUERY_EVENT,
	type PermissionModeQuery,
	type PermissionModeRequest,
} from "./onboarding.ts";
import { homeRelative, within } from "./path-within.ts";
import { permStateSealed, sealPermState } from "./perm-seal.ts";
import {
	MODE_LABELS,
	MODE_SUMMARIES,
	PERM_MAX_WIDTH,
	PermView,
	type PermViewAction,
	ROW_LABELS,
	VIEW_MODES,
} from "./perm-view.ts";
import { RULE_TEXT } from "./permission-rule.ts";
import { planBridge } from "./plan-bridge.ts";
import {
	addProjectHost,
	addProjectRule,
	type HostGrant,
	projectGrantsProblem,
	readProjectGrants,
	removeProjectHost,
	removeProjectRule,
	watchProjectGrants,
} from "./project-permissions.ts";
import { physicalPath, realPath } from "./real-path.ts";
import { PinnedLookup } from "./sandbox/dns-guard.ts";
import { type GitConfigQuestion, gitCopyRefusal } from "./sandbox/git-copy.ts";
import type { HooksQuestion } from "./sandbox/git-hooks.ts";
import { describeGitCopies } from "./sandbox/git-orphans.ts";
import { gitSshHostOf } from "./sandbox/git-ssh.ts";
import {
	buildLayout,
	DEFAULT_HIDDEN_HOME_PATHS,
	HOME_FOLDER_BLOCKED,
	isExcludedCommand,
	READ_ALL_HIDDEN_HOME_PATHS,
	readSandboxSettings,
	SANDBOX_SETTINGS_ERROR_START,
	type SandboxLayout,
	type SandboxSettings,
	SandboxSettingsError,
	sandboxedMode,
	sandboxSettingsProblem,
	saveSandboxSetting,
} from "./sandbox/layout.ts";
import { likelyHosts } from "./sandbox/likely-hosts.ts";
import { reportedRepositories, takeUnseenRepositories } from "./sandbox/nested-git.ts";
import { describeSandbox, networkRefusalNote, sandboxPromptSection, sandboxResultNote } from "./sandbox/notes.ts";
import {
	type CommandNetwork,
	type HostAnswer,
	HostPolicy,
	isDenied,
	localPortOf,
	matchesHost,
	type NetworkCommand,
	privateAddressOf,
	type SessionHostGrant,
} from "./sandbox/proxy.ts";
import { isReadable, readableSet, toolsFound } from "./sandbox/read-limit.ts";
import {
	brokenSandboxReason,
	createSandboxableBashOperations,
	existingSessionTmpDir,
	removeSessionTmpDir,
	type SandboxRuntime,
	sessionSandbox,
	sessionTmpDir,
	setSessionSandbox,
	startSandbox,
	takeSandboxLayout,
} from "./sandbox/runtime.ts";
import {
	checkDestination,
	destinationName,
	TOOL_NETWORK_EVENT,
	type ToolNetworkRequest,
	webFetchDestinations,
} from "./sandbox/tool-network.ts";
import { noteScheduledRun, readScheduledTask, SCHEDULED_FLAG } from "./scheduled-tasks.ts";
import { approveScopeNative } from "./scope-native.ts";
import { setProtectedSearch } from "./search-protected.ts";
import { writeFileAtomicSync } from "./secrets/atomic-write.ts";
import { type PermissionScope, type PermissionSettingsDeps, permissionsSection } from "./settings-permissions.ts";
import { openSettings, type SettingsSection, setSettingsSection, settingsSections } from "./settings-sections.ts";
import { expandGlob } from "./shell-glob.ts";
import { evaluatedText, unseenCodeReason } from "./shell-unseen-code.ts";
import {
	closingBrace,
	commandSubstitutions,
	parameterExpansions,
	type ShellRedirect,
	type ShellSegment,
	type ShellWord,
	shellSegments,
} from "./shell-words.ts";
import {
	blockedReport,
	maxScopeMinutes,
	operationDetail,
	parseProposal,
	type ScopeApproval,
	type ScopeOperation,
	type ScopeProposal,
	ScopeView,
	scopeLimits,
	type TaskScope,
} from "./task-scope.ts";
import { type Capability, declaredEffects, SHIPPED_TOOL_PERMISSIONS } from "./tool-capabilities.ts";
import { textBlock, visibleText } from "./visible-text.ts";

/** fork: observe permission outcomes without changing the gate's return value. */
export interface PermissionDecisionFact {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	decision:
		| "allowed_by_rule"
		| "asked_granted_once"
		| "asked_granted_timed"
		| "asked_granted_session"
		| "asked_granted_always"
		| "denied"
		| "blocked";
	reason: string;
}

const permissionDecisionListeners = new Set<(fact: PermissionDecisionFact) => void>();

export function subscribePermissionDecision(listener: (fact: PermissionDecisionFact) => void): () => void {
	permissionDecisionListeners.add(listener);
	return () => permissionDecisionListeners.delete(listener);
}

function emitPermissionDecision(fact: PermissionDecisionFact): void {
	for (const listener of permissionDecisionListeners) {
		try {
			listener(fact);
		} catch {}
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Mode = "ask" | "safe" | "broad" | "unrestricted";
// fork: the dedicated writer rechecks the live mode after its question.
const configurationModes = new WeakMap<ExtensionContext["sessionManager"], () => Mode>();
export function configurationMode(ctx: ExtensionContext): Mode | undefined {
	return configurationModes.get(ctx.sessionManager)?.();
}

const sudoApprovals = new WeakMap<ExtensionContext["sessionManager"], () => boolean>();
/** D11: the guard's revocable, memory-only approval for all sudo calls in this session. */
export function sudoSessionApproved(ctx: ExtensionContext): boolean {
	return sudoApprovals.get(ctx.sessionManager)?.() === true;
}
/**
 * what the window keeps of a conversation while its engine sleeps. The rules "in
 * this session" already live in the session file (`perm-state`); the dangerous actions and the hosts allowed "in
 * this session" are never saved, by design (a resumed session asks again), so the window takes them from the
 * engine before stopping it and gives them back to the engine it wakes. Nothing is written to disk.
 */
export interface SessionGrants {
	danger: Array<[string, string]>;
	hosts: string[];
	commandHosts?: SessionHostGrant[];
	/** The browser's "every site in this session" answer. */
	browserEverySite?: boolean;
}
const sessionGrants = new WeakMap<
	ExtensionContext["sessionManager"],
	{ take: () => SessionGrants; give: (grants: SessionGrants) => void }
>();
/** The grants to keep across the engine's sleep; undefined without the permission extension. */
export function exportSessionGrants(sessionManager: ExtensionContext["sessionManager"]): SessionGrants | undefined {
	return sessionGrants.get(sessionManager)?.take();
}
/** Gives back what `exportSessionGrants` returned; malformed entries are ignored. */
export function importSessionGrants(sessionManager: ExtensionContext["sessionManager"], grants: unknown): boolean {
	const entry = sessionGrants.get(sessionManager);
	if (!entry || typeof grants !== "object" || grants === null) return false;
	const { danger, hosts, commandHosts, browserEverySite } = grants as Partial<Record<keyof SessionGrants, unknown>>;
	entry.give({
		danger: Array.isArray(danger)
			? danger.filter(
					(pair): pair is [string, string] =>
						Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string"),
				)
			: [],
		hosts: Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === "string") : [],
		commandHosts: Array.isArray(commandHosts)
			? commandHosts.filter(
					(grant): grant is SessionHostGrant =>
						typeof grant === "object" &&
						grant !== null &&
						typeof grant.host === "string" &&
						typeof grant.command === "string",
				)
			: [],
		...(browserEverySite === true ? { browserEverySite: true } : {}),
	});
	return true;
}
/**
 * what a client's own permissions screen shows and
 * the operations it offers, the same as /perm's: the engine keeps the decisions, the client only draws them.
 */
export interface PermissionsPanel {
	snapshot(): PermissionsSnapshot;
	setMode(mode: Mode, asDefault: boolean): Promise<boolean>;
	revoke(index: number, what: string): boolean;
	rule(change: PermissionRuleChange): Promise<string | undefined>;
	sandbox(mode: Mode, on: boolean): Promise<string | undefined>;
	scope(): Promise<void>;
	/** Ends the task scope in effect, or still held by background tasks, as /perm scope's "End the task scope now". */
	endScope(): void;
	/** What the settings of /settings › Permissions & sandbox read and save, for the window's /sandbox screen. */
	settings(): PermissionSettingsDeps;
}
export interface PermissionRuleChange {
	action: "add" | "remove";
	effect: "allow" | "ask" | "deny";
	rule: string;
	where: "session" | "project" | "global";
}
export interface PermissionsSnapshot {
	mode: Mode;
	defaultMode: Mode;
	unrestrictedAccepted: boolean;
	modes: Array<{ mode: Mode; label: string; summary: string; sandbox: "on" | "off" | "unavailable" }>;
	sandbox: { running: boolean; problem?: string };
	rows: Array<{ row: PolicyRow; label: string; verdicts: Record<Mode, Verdict> }>;
	grants: Array<{ index: number; effect: "allow" | "deny"; what: string; scope: string; left: string }>;
	sessionRules: { allow: string[]; deny: string[] };
	saved: Array<{
		where: "project" | "global";
		file: string;
		read: boolean;
		allow: string[];
		ask: string[];
		deny: string[];
	}>;
	scope?: { minutesLeft: number; away: boolean; items: string[]; limits: string[] };
	shortcuts: Array<{ keys: string; action: string }>;
	help: string;
}
const permissionPanels = new WeakMap<ExtensionContext["sessionManager"], (ctx: ExtensionContext) => PermissionsPanel>();
/**
 * fork: the network policies of ended instances whose commands still run (a background
 * task outlives a /reload or a new session on purpose). The watchers of the instance in place recheck them too, so a
 * host blocked after the change still closes their tunnels; one is dropped once its commands have ended.
 */
const outlivingPolicies = new Set<HostPolicy>();
function recheckOutliving(): void {
	for (const policy of outlivingPolicies) {
		policy.recheck();
		if (!policy.inUse) outlivingPolicies.delete(policy);
	}
}
/** The permissions screen's data and operations for this context; undefined without the permission extension. */
export function permissionsPanel(ctx: ExtensionContext): PermissionsPanel | undefined {
	return permissionPanels.get(ctx.sessionManager)?.(ctx);
}
/** What a child Prism process (an agent) inherits: this session's live mode and its session deny rules. */
export interface ChildPermissions {
	mode: Mode;
	deny: string[];
}
// what a child Prism process (an agent) inherits, so it never has more rights than its parent.
const childRestrictions = new WeakMap<ExtensionContext["sessionManager"], () => ChildPermissions>();
/** Flags for a child Prism process: this session's live mode and its session deny rules. */
export function childPermissionArgs(ctx: ExtensionContext): string[] {
	const now = childRestrictions.get(ctx.sessionManager)?.();
	if (!now) return [];
	return ["--perm-mode", now.mode, ...(now.deny.length > 0 ? ["--perm-deny", JSON.stringify(now.deny)] : [])];
}
/** This session's live mode and session deny rules, as a child process inherits them; undefined without the extension. */
export function childPermissions(ctx: ExtensionContext): ChildPermissions | undefined {
	return childRestrictions.get(ctx.sessionManager)?.();
}
// fork: an agent already running hears of its parent's later restrictions.
const childPermissionWatchers = new WeakMap<ExtensionContext["sessionManager"], Set<() => void>>();
/** Calls `listener` after each change of this session's mode or session rules; returns the way to stop. */
export function watchChildPermissions(ctx: ExtensionContext, listener: () => void): () => void {
	const watchers = childPermissionWatchers.get(ctx.sessionManager);
	watchers?.add(listener);
	return () => watchers?.delete(listener);
}
/** Whether `mode` lets more run without a question than `than`. Ask and safe are the narrow modes, neither wider. */
export function isWiderMode(mode: Mode, than: Mode): boolean {
	const rank = (m: Mode) => (m === "unrestricted" ? 2 : m === "broad" ? 1 : 0);
	return rank(mode) > rank(than);
}
type Tier = "allow" | "ask" | "danger";
const MODES: Mode[] = ["ask", "safe", "broad", "unrestricted"];
/** The mode when no flag, saved session or config names one (onboarding.ts holds the value). */
const FALLBACK_MODE: Mode = DEFAULT_PERMISSION_MODE;

/** A refusal reason as a sentence: its own final point is kept, never doubled ("(curl).."). */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The rules of --perm-deny (a JSON array); a malformed value denies nothing more, the mode still applies. */
function flagDenyRules(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw) return [];
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value)
			? value.filter((rule): rule is string => typeof rule === "string" && !!parseRule(rule))
			: [];
	} catch {
		return [];
	}
}

/** A mode name from a flag, a config or a saved session; "yolo" is the former name of "broad". */
function parseMode(raw: unknown): Mode | undefined {
	if (raw === "yolo") return "broad";
	return typeof raw === "string" && MODES.includes(raw as Mode) ? (raw as Mode) : undefined;
}

/** One line per mode, for the menu and the help. */
const MODE_DESCRIPTIONS: Record<Mode, string> = {
	ask: "reads freely; asks before changing a file, running a command or going online",
	safe: "reads and runs only safe commands; blocks other changes; asks before going online",
	broad: "works in the project without asking; asks for what leaves the project, sudo and the first use of a browser or a desktop; configuration uses configure_prism (default)",
	unrestricted: "skips ordinary questions; configuration uses configure_prism; security settings are user-only",
};

// fork: one text, so that it has a translation; the dialog wraps it.
const UNRESTRICTED_WARNING =
	"Unrestricted mode: no confirmation for anything, including rm -rf, sudo, writes outside the project. Configuration uses configure_prism; security settings are user-only. This is not a sandbox: the agent can do anything your user account can, including reading auth.json and your other files. Only explicit deny rules still apply.";
const RANK: Record<Tier, number> = { allow: 0, ask: 1, danger: 2 };
/** Grace period for an unanswered permission dialog. When it expires Pi
 *  dismisses the dialog itself (with a live countdown) and this gate fails
 *  closed, so an unattended session — user away, or a session watched from the
 *  phone where no TUI dialog is rendered — never waits forever. */
const PROMPT_TIMEOUT_MS = 3 * 60 * 1000;
/** fork: how long the permission a question offers lasts. */
const TIMED_MINUTES = 15;

interface Rule {
	effect: "allow" | "ask" | "deny";
	tool: string;
	pattern?: string;
	label: string;
}

interface PermConfig {
	mode?: Mode | "yolo";
	/** fork: the user accepted the unrestricted mode's warning once (global config only). */
	unrestrictedAccepted?: boolean;
	allow?: string[];
	deny?: string[];
	ask?: string[];
	protectedPaths?: string[];
	tools?: Record<string, "allow" | "ask" | "deny">;
}

/** fork: a rule given for a limited time; `until` is an absolute date, so a reopened session does not revive it. */
export interface TimedPermission {
	rule: string;
	effect: "allow" | "deny";
	/** Milliseconds since the epoch. */
	until: number;
}

function isTimedPermission(value: unknown): value is TimedPermission {
	if (typeof value !== "object" || value === null) return false;
	const grant = value as Partial<TimedPermission>;
	return (
		typeof grant.rule === "string" &&
		(grant.effect === "allow" || grant.effect === "deny") &&
		typeof grant.until === "number"
	);
}

interface SessionState {
	mode: Mode;
	allow: string[];
	deny: string[];
	timed: TimedPermission[];
}

interface TierResult {
	tier: Tier;
	detail?: string;
	abs?: string;
	/** fork: a write outside the project that lands in /tmp, without the sandbox; see decide. */
	scratch?: boolean;
}

interface Decision {
	effect: "allow" | "block" | "prompt";
	reason: string;
	tier: Tier;
	target: string;
	suggestedRule?: string;
	/** fork: blocked because the tool declares no permissions. */
	undeclared?: boolean;
	/** fork: allowed by one of the user's rules, not by the mode. */
	byRule?: boolean;
	/** fork: the real path a read-only file tool reaches outside what the agent may read. */
	readOutside?: string;
}

/** fork: the line shown once when reading is limited to the project. */
export const READ_LIMIT_NOTICE =
	"Commands and file tools now read only the project and what its tools need, not the rest of your home folder. To widen it: /settings › Permissions & sandbox › What the agent reads. MCP and LSP servers and your browser are not limited.";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const globalConfigPath = () => join(getAgentDir(), "permissions.json");
const projectConfigPath = (cwd: string) => join(cwd, CONFIG_DIR_NAME, "permissions.json");

/**
 * Prism's own config and credential files: reading them is a dangerous call. Writes to these and to the rest of
 * the configuration are refused (config-policy.ts); this list only keeps reads as they were.
 */
function prismConfigFiles(cwd: string): string[] {
	const names = ["auth.json", "settings.json", "models.json", "permissions.json", "checkpoint.key"];
	return [
		...names.map((name) => join(getAgentDir(), name)),
		join(cwd, CONFIG_DIR_NAME, "settings.json"),
		projectConfigPath(cwd),
	];
}

/**
 * fork: a permissions file that cannot be read used to count as absent, so one
 * trailing comma dropped every deny rule, ask rule and protected path without a word, and the next "always allow"
 * rewrote the file with that one rule. Now, like the sandbox settings, it fails
 * closed: the last valid version read in this process applies; without one, every tool call is refused until the
 * file is fixed (`permissionsFileProblem`). A save never replaces a file that does not parse.
 */
const lastValidConfig = new Map<string, PermConfig>();

/** What is wrong with a permissions file's content, if anything. */
function configShapeProblem(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "it must be a JSON object";
	const cfg = value as Record<string, unknown>;
	if (cfg.mode !== undefined && parseMode(cfg.mode) === undefined) {
		return fill('"mode" must be one of {0}', MODES.join(", "));
	}
	for (const key of ["allow", "deny", "ask", "protectedPaths"] as const) {
		const list = cfg[key];
		if (list === undefined) continue;
		if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
			return fill('"{0}" must be a list of text rules', key);
		}
		const malformed = key === "protectedPaths" ? undefined : list.find((rule) => !parseRule(rule as string));
		if (malformed !== undefined)
			return fill('"{0}" holds a rule that is not tool or tool(pattern): {1}', key, malformed);
	}
	const tools = cfg.tools;
	if (
		tools !== undefined &&
		(typeof tools !== "object" ||
			tools === null ||
			Array.isArray(tools) ||
			!Object.values(tools).every((effect) => effect === "allow" || effect === "ask" || effect === "deny"))
	) {
		return '"tools" must give each tool "allow", "ask" or "deny"';
	}
	return undefined;
}

/** A permissions file: its config, nothing when it is missing, or what is wrong with it. */
const inspectConfig = cacheFile(
	(file: string): { config?: PermConfig; problem?: string } => {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === "ENOENT" || code === "ENOTDIR"
				? {}
				: { problem: fill("it cannot be read ({0})", String(code)) };
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			return { problem: fill("it is not valid JSON ({0})", error instanceof Error ? error.message : String(error)) };
		}
		const problem = configShapeProblem(value);
		if (problem) return { problem };
		lastValidConfig.set(file, value as PermConfig);
		return { config: value as PermConfig };
	},
	(result) => result.problem === undefined,
);

/** A permissions file's config: the file's, or the last valid version read when it no longer parses. */
function readConfig(file: string): PermConfig | undefined {
	const { config, problem } = inspectConfig(file);
	return config ?? (problem ? lastValidConfig.get(file) : undefined);
}

/**
 * Why no tool may run: a permissions file that does not parse and of which no valid version was read before.
 * The model is told to stop; the user fixes the file.
 */
export function permissionsFileProblem(cwd: string, trusted: boolean): string | undefined {
	for (const file of trusted ? [globalConfigPath(), projectConfigPath(cwd)] : [globalConfigPath()]) {
		const { problem } = inspectConfig(file);
		if (problem && !lastValidConfig.has(file)) {
			return fill(
				"{0} is not a valid permissions file: {1}. Until it is fixed, every tool call is refused, so that its deny rules cannot be lost. Fix the file, or remove it to start from the defaults.",
				file,
				problem,
			);
		}
	}
	const grants = projectGrantsProblem();
	return grants
		? fill(
				"{0}. Until it is fixed, every tool call is refused, so that the rules refused for projects cannot be lost. Fix the file, or remove it to drop the rules given for projects.",
				grants,
			)
		: undefined;
}

/** The permissions files whose last valid version applies because the file no longer parses. */
function staleConfigFiles(cwd: string, trusted: boolean): string[] {
	return (trusted ? [globalConfigPath(), projectConfigPath(cwd)] : [globalConfigPath()]).filter(
		(file) => inspectConfig(file).problem !== undefined && lastValidConfig.has(file),
	);
}

function loadConfig(cwd: string, trusted: boolean): PermConfig {
	const cfg: PermConfig = {};
	const global = readConfig(globalConfigPath());
	if (global) Object.assign(cfg, global);
	if (trusted) {
		const proj = readConfig(projectConfigPath(cwd));
		if (proj) {
			// A project cannot select the unrestricted mode.
			const projectMode = parseMode(proj.mode);
			if (projectMode && projectMode !== "unrestricted") cfg.mode = projectMode;
			for (const key of ["allow", "deny", "ask", "protectedPaths"] as const) {
				cfg[key] = [...(cfg[key] ?? []), ...(proj[key] ?? [])];
			}
			if (proj.tools) cfg.tools = { ...(cfg.tools ?? {}), ...proj.tools };
		}
	}
	return cfg;
}

/**
 * Changes a permissions file under the lock every Prism process takes, then replaces it whole
 * two sessions saving a rule at once both keep theirs, and a crash cannot leave half a file. A file
 * that does not parse is never replaced: its rules would be lost.
 */
async function updateConfigFile(file: string, change: (cfg: PermConfig) => PermConfig): Promise<void> {
	mkdirSync(dirname(file), { recursive: true });
	return lockForkFile(file, () => {
		// fork: under the lock, the last writer's version, never a cached one.
		const { config, problem } = inspectConfig.fresh(file);
		if (problem)
			throw new Error(fill("{0} is not a valid permissions file ({1}). Fix it, then retry.", file, problem));
		const next = change({ ...(config ?? {}) });
		writeFileAtomicSync(file, `${JSON.stringify(next, null, 2)}\n`);
		lastValidConfig.set(file, next);
	});
}

/** fork: sets top-level fields of a permissions config file, keeping the others. */
async function saveConfigFields(file: string, fields: Partial<PermConfig>): Promise<void> {
	await updateConfigFile(file, (cfg) => ({ ...cfg, ...fields }));
}

/** saveConfigFields for /settings, which reports the refusal of a file that does not parse. */
const saveValidConfigFields = saveConfigFields;

/** Runs a save; a refusal (a file that does not parse, a lock) is told to the user. Whether it saved. */
async function savedOrReported(ctx: ExtensionContext, save: () => Promise<void>): Promise<boolean> {
	try {
		await save();
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else process.stderr.write(`${message}\n`);
		return false;
	}
}

async function saveRuleToConfig(file: string, rule: string, effect: "allow" | "deny"): Promise<void> {
	await updateConfigFile(file, (cfg) => ({ ...cfg, [effect]: [...new Set([...(cfg[effect] ?? []), rule])] }));
}

/**
 * the switch that lets the agent start any program on its own desktop without a
 * question, in /settings › Computer use. It is the rule `desktop(*)` of the global permissions file, so /perm shows
 * it, deny rules still win, and removing the rule turns the switch off.
 */
export const DESKTOP_LAUNCH_RULE = "desktop(*)";

export function globalAllowsRule(rule: string): boolean {
	return (readConfig(globalConfigPath())?.allow ?? []).includes(rule);
}

export async function setGlobalAllowRule(rule: string, allowed: boolean): Promise<void> {
	await updateConfigFile(globalConfigPath(), (cfg) => {
		const rest = (cfg.allow ?? []).filter((entry) => entry !== rule);
		return { ...cfg, allow: allowed ? [...rest, rule] : rest };
	});
}

// ---------------------------------------------------------------------------
// Rule parsing + glob matching
// ---------------------------------------------------------------------------

function parseRule(raw: string): Rule | undefined {
	const m = RULE_TEXT.exec(raw.trim());
	if (!m) return undefined;
	return { effect: "allow", tool: m[1], pattern: m[2] || undefined, label: raw.trim() };
}

/** A shell command: bash, or the `background` tool starting one. */
function isShellCall(tool: string, input: Record<string, unknown>): boolean {
	return tool === "bash" || (tool === "background" && input.action === "run") || isDesktopLaunch(tool, input);
}

/** a program the agent starts on its desktop, always outside the sandbox. */
function isDesktopLaunch(tool: string, input: Record<string, unknown>): boolean {
	return tool === "desktop" && input.action === "launch";
}

function ruleMatches(rule: Rule, tool: string, targets: string[]): boolean {
	if (rule.tool !== tool) return false;
	if (!rule.pattern) return true;
	const loose = rule.tool === "bash" || rule.tool === "background" || rule.tool === "desktop";
	const pattern = rule.pattern;
	return targets.some((t) => globMatches(pattern, loose, t));
}

/** The project directory as written and as resolved: a project reached through a symlink is still inside. */
function projectRoots(cwd: string): string[] {
	const real = realPath(cwd);
	return real === cwd ? [cwd] : [cwd, real];
}

function insideProject(abs: string, cwd: string): boolean {
	// Preserve the former prefix at / (//), including the equal-project case.
	return projectRoots(cwd).some((root) => abs === root || within(abs, root + sep));
}

/** An absolute path and, when it is in the project, the same path relative to it (rules and globs see both). */
function pathForms(abs: string, cwd: string): string[] {
	// Equal paths stay absolute; / keeps its former // prefix.
	const root = projectRoots(cwd).find((candidate) => within(abs, candidate + sep));
	return root ? [abs, abs.slice(root.length + sep.length)] : [abs];
}

/**
 * fork: the file a tool call touches, resolved exactly as the tools resolve
 * it (`~`, `@` prefix, unicode spaces; read also tries the macOS file name variants). The gate used
 * to resolve `~/.bashrc` to `<project>/~/.bashrc`.
 */
function toolPath(tool: string, raw: string, cwd: string): string {
	return tool === "read" ? resolveReadPath(raw, cwd) : resolveToCwd(raw, cwd);
}

/**
 * Rule targets of a call. File tools give both the path as written and its real target, so a deny
 * or ask rule matches either; `realOnly` keeps the real target alone, for allow rules.
 */
function toolTargets(tool: string, input: Record<string, unknown>, cwd: string, realOnly = false): string[] {
	if (isShellCall(tool, input)) {
		return shellRuleTargets(typeof input.command === "string" ? input.command : "");
	}
	if (typeof input.path === "string" && input.path) {
		const abs = toolPath(tool, input.path, cwd);
		const real = realPath(abs);
		const paths = realOnly || real === abs ? [real] : [abs, real];
		return paths.flatMap((path) => pathForms(path, cwd));
	}
	try {
		return [JSON.stringify(input)];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Bash command classifier
// ---------------------------------------------------------------------------

// fork: a command line is read by the shell lexer
// (shell-words.ts) as bash reads it: segments, redirections and words with their quotes removed, `--`, patterns
// matched on the disk, `~`, `$HOME`, `$PWD`, the variables the line sets and the folder a `cd` moves to. Each segment
// is unwrapped down to the program it runs: shell keywords, VAR=value prefixes, wrappers with the options they are
// known to take (`timeout 60`, `nice -n 5`, `env -C dir`, `xargs`...), and the directory of a program in a standard
// bin directory (`/usr/bin/sudo`). Known-safe commands still ask when an option makes them write a file or run
// another program, and what the lexer cannot read asks. This informs the user; the sandbox is the boundary.

const SHELL_KEYWORDS = new Set(["!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}"]);
const STANDARD_BIN_DIRS = new Set(["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

const DANGER_COMMANDS = new Set([
	"sudo",
	"doas",
	"pkexec",
	"run0",
	"su",
	"dd",
	"mkfs",
	"fdisk",
	"parted",
	"wipefs",
	"shred",
	"mount",
	"umount",
	"insmod",
	"rmmod",
	"shutdown",
	"reboot",
	"halt",
	"poweroff",
	"useradd",
	"userdel",
	"usermod",
	"groupadd",
	"groupdel",
	"passwd",
	"visudo",
	"iptables",
	"ip6tables",
	"ufw",
	"firewall-cmd",
	"setfacl",
	"chattr",
]);

// `printenv` left the list: it hands the model every secret in the environment.
// `yq` left it: its expressions read files (`load`) and write them (`-s`).
const SAFE_BASH_COMMANDS = new Set([
	"ls",
	"ll",
	"dir",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"file",
	"stat",
	"du",
	"df",
	"pwd",
	"which",
	"whereis",
	"echo",
	"printf",
	"date",
	"uname",
	"hostname",
	"whoami",
	"id",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"find",
	"tree",
	"sort",
	"uniq",
	"diff",
	"comm",
	"cut",
	"column",
	"jq",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"type",
	"man",
	"true",
	"cd",
]);

/**
 * fork: the programs `xargs` may run without a question. It gives them
 * words it reads, which may be options: only programs that no option makes write a file or run another program.
 */
const XARGS_SAFE = new Set([
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"egrep",
	"fgrep",
	"ls",
	"stat",
	"du",
	"echo",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"cut",
	"diff",
	"comm",
	"true",
]);

const GIT_SAFE_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"rev-parse",
	"rev-list",
	"blame",
	"ls-files",
	"ls-remote",
	"describe",
	"shortlog",
	"cat-file",
]);

/**
 * fork: `git branch` options that only list, and those of them that take a value
 * as the next word (which is not a branch name).
 */
const GIT_BRANCH_LIST_OPTIONS = new Set([
	"-l",
	"--list",
	"-a",
	"--all",
	"-r",
	"--remotes",
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
	"--points-at",
	"--show-current",
]);
const GIT_BRANCH_VALUE_OPTIONS = new Set([
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
	"--points-at",
	"--sort",
	"--format",
]);
/** Short `git branch` flags that change a branch: delete, move, copy, force, upstream, track. */
const GIT_BRANCH_WRITE_SHORT = /^-[a-zA-Z]*[dDmMcCfut]/;
const GIT_BRANCH_WRITE_LONG = [
	"--delete",
	"--move",
	"--copy",
	"--force",
	"--set-upstream-to",
	"--set-upstream",
	"--unset-upstream",
	"--edit-description",
	"--track",
	"--no-track",
	"--create-reflog",
	"--recurse-submodules",
];
/** The long options of `git branch` that only show, by which an abbreviation is read. */
const GIT_BRANCH_READ_LONG = [...new Set([...GIT_BRANCH_LIST_OPTIONS, ...GIT_BRANCH_VALUE_OPTIONS])].filter((o) =>
	o.startsWith("--"),
);

/** Whether `git branch <args>` only shows branches: a name without a list option creates one. */
function gitBranchReadOnly(args: string[]): boolean {
	let listing = false;
	let named = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") {
			named ||= i + 1 < args.length;
			break;
		}
		if (arg.startsWith("--")) {
			// fork: git takes any unambiguous abbreviation (`--unset-u`, `--edit-desc`); one
			// a writing option starts with writes, or is ambiguous and fails.
			const given = arg.split("=")[0]!;
			if (!GIT_BRANCH_READ_LONG.includes(given) && GIT_BRANCH_WRITE_LONG.some((o) => o.startsWith(given)))
				return false;
			const option = longOption(given, GIT_BRANCH_READ_LONG) ?? given;
			if (GIT_BRANCH_LIST_OPTIONS.has(option)) listing = true;
			if (GIT_BRANCH_VALUE_OPTIONS.has(option) && !arg.includes("=")) i++;
		} else if (GIT_BRANCH_VALUE_OPTIONS.has(arg)) i++;
		else if (arg.startsWith("-") && arg.length > 1) {
			if (GIT_BRANCH_WRITE_SHORT.test(arg)) return false;
			if (/^-[a-zA-Z]*l/.test(arg) || /^-[a-zA-Z]*[ar]/.test(arg)) listing = true;
		} else named = true;
	}
	return listing || !named;
}

/** Git settings that make git run a program (`git -c`, `git config`). */
const GIT_EXEC_CONFIG_RE =
	/^(core\.(fsmonitor|pager|editor|sshcommand|hookspath|askpass|gitproxy)|diff\..*(external|textconv|command)|merge\..*driver|filter\.|alias\.|credential\.|gpg\..*program|sequence\.editor|(remote\..*\.)?(uploadpack|receivepack))/i;

const DANGER_PATTERNS: Array<[RegExp, string]> = [
	[/\|\s*(ba|z|da|k)?sh\b/, "pipe into shell"],
	[/:\s*\(\s*\)\s*\{/, "fork bomb"],
	[/>+\s*\/dev\/(sd[a-z]|nvme|hd[a-z]|mmcblk|xvd)/, "write to block device"],
	[/\b(npm|pnpm|yarn)\s+publish\b/, "publishing a package"],
	[/\bpip\s+upload\b/, "publishing a package"],
	[/\bcargo\s+publish\b/, "publishing a package"],
	[/\bgit\s+push\b[^\n|;&]*\s(--force\b|-f\b)/, "force push"],
	// fork: forced or deleting without -f: a `+` or `:` refspec, --mirror, --delete,
	// --prune, a short-option cluster holding f or d, and `git -C x push`.
	[
		/\bgit\b(?:\s+-(?:C|c)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+push\b[^\n|;&]*\s(?:\+\S|:\S|--mirror\b|--delete\b|--prune\b|-[a-zA-Z]*[fd][a-zA-Z]*\b|--force)/,
		"forced or deleting push",
	],
	[/\bchmod\b[^\n|;&]*(\b777\b|\b666\b|a\+rwx)/, "world-writable permissions"],
];

/** Commands that run a command given as their arguments: a dangerous one among them is dangerous. */
const RUNS_ITS_ARGUMENTS = new Set([
	"find",
	"watch",
	"flock",
	"strace",
	"ltrace",
	"unshare",
	"nsenter",
	"setpriv",
	"script",
	"parallel",
	"runuser",
	"systemd-run",
	"chrt",
	"taskset",
	"numactl",
	"prlimit",
	"firejail",
	"bwrap",
	"busybox",
]);

interface BashContext {
	cwd: string;
	cfg: PermConfig;
	/** fork: the session's private /tmp, which sandboxed commands see at /tmp. */
	tmp?: string;
	/** fork: the folder the command runs in, after the `cd`s before it; null when it cannot be known. The project when absent. */
	dir?: string | null;
	/** fork: the variables an earlier part of the line set to a known value (`S=/tmp/x; … > $S/out`). */
	vars?: ReadonlyMap<string, string>;
	/**
	 * fork: an exported variable an earlier part of the line changed
	 * (`PATH=$PWD/bin:$PATH; ls`), which reaches the commands after it as `PATH=… ls` would.
	 */
	changedEnv?: string;
}

/**
 * fork: where `abs`, a path under /tmp, is in the session's private /tmp; undefined for any
 * other path. A path already in the private /tmp stays as it is.
 */
function inSessionTmp(abs: string, tmp: string): string | undefined {
	if (abs !== "/tmp" && !abs.startsWith("/tmp/")) return undefined;
	if (within(abs, tmp)) return abs;
	return join(tmp, abs.slice("/tmp".length));
}

/** Whether `abs` and the file it really is are both in the session's private /tmp. */
const realInTmp = (abs: string, tmp: string) => {
	const root = realPath(tmp);
	const real = realPath(abs);
	return within(abs, tmp) && within(real, root);
};

/** fork: a path as the session sees it, the private /tmp shown as /tmp. */
const publicTmp = (path: string, tmp: string | undefined) =>
	tmp && within(path, tmp) ? `/tmp${path.slice(tmp.length)}` : path;

/** `~`, `$HOME` and `${HOME}` at the start of a path, as the shell expands them. */
const expandHome = (path: string) => path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());

/** The folder a command's relative paths start from: null when a `cd` made it unknown. */
const baseDir = (ctx: BashContext): string | null => (ctx.dir === undefined ? ctx.cwd : ctx.dir);

const VARIABLE_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * fork: `text` once bash has put in `~` (when `tilde`), `$HOME`, `$PWD`
 * and the variables the line set; undefined when it holds another variable, whose value is not known here.
 */
function expandText(text: string, tilde: boolean, ctx: BashContext): string | undefined {
	let out = text;
	if (tilde) {
		if (!/^~(\/|$)/.test(out)) return undefined;
		out = homedir() + out.slice(1);
	}
	let unknown = false;
	out = out.replace(VARIABLE_RE, (_, braced: string | undefined, plain: string | undefined) => {
		const name = braced ?? plain ?? "";
		const value = name === "HOME" ? homedir() : name === "PWD" ? (baseDir(ctx) ?? undefined) : ctx.vars?.get(name);
		if (value === undefined) unknown = true;
		return value ?? "";
	});
	return unknown || /\$[0-9?#$!@*-]/.test(out) ? undefined : out;
}

/** The text a word gives its program; undefined when bash computes it from something not known here. */
function wordText(word: ShellWord, ctx: BashContext): string | undefined {
	if (word.expansion) return undefined;
	return word.variable ? expandText(word.text, word.raw.startsWith("~"), ctx) : word.text;
}

/** Where a value not known here stands in a candidate text (`wordPieces`). */
const UNKNOWN = "\u0000";
/** That value in a piece's text: a variable, which `protectedTail` reads as one. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a template
const UNKNOWN_VARIABLE = "${UNKNOWN}";
/** More candidate texts than this for one word, and it is not judged at all. */
const MAX_CANDIDATES = 32;

/** The value of a variable as bash puts it in; undefined when it is not known here. */
const variableValue = (name: string, ctx: BashContext) =>
	name === "HOME" ? homedir() : name === "PWD" ? (baseDir(ctx) ?? undefined) : ctx.vars?.get(name);

/** A word's text without its quotes, for the argument of `${X:-".env"}` (an approximation that keeps every letter). */
const unquoted = (text: string) => text.replace(/\\(.)/g, "$1").replace(/["']/g, "");

/**
 * fork: the texts a word may give its program, each with its unknown parts as `UNKNOWN`;
 * a string when they cannot be listed. `${X:-.env}` may be `.env`, `${S:=…}`, `${S:+…}` and `${S-…}` alike, and a
 * value cut from a known variable (`${S:0}`, `${S%x}`) is not computed here.
 */
function candidateTexts(text: string, ctx: BashContext, depth = 0): string[] | string {
	let candidates = [""];
	const append = (alternatives: readonly string[]): string | undefined => {
		const next = new Set<string>();
		for (const before of candidates) for (const value of alternatives) next.add(before + value);
		if (next.size > MAX_CANDIDATES) return "a word that may take too many values";
		candidates = [...next];
		return undefined;
	};
	let literal = "";
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "$") {
			literal += text[i];
			continue;
		}
		let alternatives: string[];
		let end: number;
		if (text[i + 1] === "{") {
			end = closingBrace(text, i + 2);
			if (end < 0) return "an unclosed ${";
			const inner = text.slice(i + 2, end - 1);
			const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(inner)?.[0];
			const rest = name ? inner.slice(name.length) : inner;
			const value = name ? variableValue(name, ctx) : undefined;
			const op = /^:?[-=+?]/.exec(rest)?.[0];
			if (!name) alternatives = [UNKNOWN];
			else if (rest === "") alternatives = [value ?? UNKNOWN];
			else if (op) {
				if (depth >= 2) return "nested variable defaults";
				const arg = candidateTexts(unquoted(rest.slice(op.length)), ctx, depth + 1);
				if (typeof arg === "string") return arg;
				const own = value ?? UNKNOWN;
				alternatives = op.endsWith("+") ? ["", ...arg] : op.endsWith("?") ? [own] : [own, ...arg];
			} else if (value !== undefined) return `a value cut from the variable ${name}`;
			else alternatives = [UNKNOWN];
		} else {
			const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?#$!@*-])/.exec(text.slice(i + 1))?.[0];
			if (!name) {
				literal += "$";
				continue;
			}
			end = i + 1 + name.length;
			alternatives = [variableValue(name, ctx) ?? UNKNOWN];
		}
		const tooMany = append([literal]) ?? append(alternatives);
		if (tooMany) return tooMany;
		literal = "";
		i = end - 1;
	}
	return append([literal]) ?? candidates;
}

/** One argument bash may give a program from a word, `known` when no part of it is unknown here. */
interface WordPiece {
	text: string;
	known: boolean;
	glob: boolean;
}

/**
 * fork: the arguments a word may give its program, a variable's value split on blanks
 * when it is not quoted (`S='notes .env'; cat $S` reads `.env`); a string when they cannot be listed.
 */
function wordPieces(word: ShellWord, ctx: BashContext): WordPiece[] | string {
	if (!word.variable && !word.expansion) return [{ text: word.text, known: true, glob: word.glob }];
	if (/\$\(|`|^[<>]\(/.test(word.text)) return [{ text: word.text, known: false, glob: word.glob }];
	let text = word.text;
	if (word.raw.startsWith("~")) {
		if (!/^~(\/|$)/.test(text)) return [{ text, known: false, glob: word.glob }];
		text = homedir() + text.slice(1);
	}
	const candidates = candidateTexts(text, ctx);
	if (typeof candidates === "string") return candidates;
	// A `$` outside quotes: bash splits the value on blanks and expands its patterns.
	const splits = unquotedDollar(word.raw);
	const pieces: WordPiece[] = [];
	for (const candidate of candidates) {
		for (const piece of splits ? candidate.split(/[ \t\n]+/).filter(Boolean) : [candidate]) {
			const known = !piece.includes(UNKNOWN);
			pieces.push({
				text: known ? piece : piece.replaceAll(UNKNOWN, UNKNOWN_VARIABLE),
				known,
				glob: word.glob || (splits && /[*?[]/.test(piece)),
			});
		}
	}
	return pieces;
}

/** Whether a raw word holds a `$` outside quotes. */
function unquotedDollar(raw: string): boolean {
	let inDouble = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (c === "\\") i++;
		else if (c === "'" && !inDouble) {
			const end = raw.indexOf("'", i + 1);
			i = end < 0 ? raw.length : end;
		} else if (c === '"') inDouble = !inDouble;
		else if (c === "$" && !inDouble) return true;
	}
	return false;
}

/** The program a command word runs: `\rm`, `'sudo'` and `/usr/bin/sudo` are rm and sudo; `./tool` is run by path. */
function programName(text: string): { name: string; byPath: boolean } {
	if (!text.includes("/")) return { name: text, byPath: false };
	return { name: basename(text), byPath: !STANDARD_BIN_DIRS.has(dirname(text)) };
}

/** The options a wrapper or a program is known to take. */
interface OptionSpec {
	/** Options without a value. */
	flags?: readonly string[];
	/** Options with a value: the next word, or attached (`-n5`, `--signal=KILL`). */
	values?: readonly string[];
	/** Options whose value is optional and only attached (`xargs -i{}`, `--replace=X`). */
	attached?: readonly string[];
	/** Options that make the program write a file. */
	writes?: readonly string[];
	/** Positional arguments before the command (timeout's duration). */
	operands?: number;
	/** `-5` is an option (nice). */
	numeric?: boolean;
}

interface ParsedOptions {
	/** The index of the word after the options and the positional arguments. */
	next: number;
	/** The options given a value, with it. */
	values: Array<[string, ShellWord]>;
	/** An option not known or that writes a file: why the words cannot be trusted. */
	problem?: string;
}

// fork: GNU programs accept any unambiguous prefix of a long option, so
// `sort --out=f` is `sort --output=f`.
function longOption(given: string, names: readonly string[]): string | undefined {
	if (names.includes(given)) return given;
	const matches = names.filter((name) => name.startsWith(given));
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * fork: the options of a wrapper, by its table. An option it does not know,
 * or one that writes a file (`time -o`), is a problem; reading goes on as before, the problem makes the command ask.
 */
function parseOptions(words: readonly ShellWord[], from: number, spec: OptionSpec): ParsedOptions {
	const flags = spec.flags ?? [];
	const valued = spec.values ?? [];
	const attached = spec.attached ?? [];
	const all = [...flags, ...valued, ...attached];
	const values: Array<[string, ShellWord]> = [];
	let problem: string | undefined;
	const note = (why: string) => {
		problem ??= why;
	};
	const attach = (word: ShellWord, text: string): ShellWord => ({ ...word, text });
	let i = from;
	while (i < words.length) {
		const word = words[i]!;
		const text = word.text;
		if (text === "--") {
			i++;
			break;
		}
		if (!text.startsWith("-") || text === "-") break;
		i++;
		if (word.variable || word.expansion) {
			note(`an option built from a variable (${word.raw})`);
			continue;
		}
		if (spec.numeric && /^-\d+$/.test(text)) continue;
		if (text.startsWith("--")) {
			const eq = text.indexOf("=");
			const name = longOption(eq < 0 ? text : text.slice(0, eq), all);
			if (!name) {
				note(`an option it does not know (${text})`);
				continue;
			}
			if (spec.writes?.includes(name)) note(`an option that writes a file (${text})`);
			if (eq >= 0) values.push([name, attach(word, text.slice(eq + 1))]);
			else if (valued.includes(name) && i < words.length) values.push([name, words[i++]!]);
			continue;
		}
		for (let k = 1; k < text.length; k++) {
			const option = `-${text[k]}`;
			if (spec.writes?.includes(option)) note(`an option that writes a file (${option})`);
			if (flags.includes(option)) continue;
			if (valued.includes(option) || attached.includes(option)) {
				const rest = text.slice(k + 1);
				if (rest) values.push([option, attach(word, rest)]);
				else if (valued.includes(option) && i < words.length) values.push([option, words[i++]!]);
				break;
			}
			note(`an option it does not know (${option})`);
		}
	}
	return { next: Math.min(i + (spec.operands ?? 0), words.length), values, problem };
}

/** Wrappers that run the command after their own options, with the options each is known to take. */
const WRAPPERS = new Map<string, OptionSpec>([
	["nohup", {}],
	// Bash's `time` keyword and GNU time; -o and -a write the report to a file.
	[
		"time",
		{
			flags: ["-p", "-v", "-q", "-a", "--portability", "--verbose", "--quiet", "--append"],
			values: ["-f", "-o", "--format", "--output"],
			writes: ["-o", "-a", "--output", "--append"],
		},
	],
	["setsid", { flags: ["-c", "-f", "-w", "--ctty", "--fork", "--wait"] }],
	["exec", { flags: ["-c", "-l"], values: ["-a"] }],
	["command", { flags: ["-p"] }],
	["nice", { values: ["-n", "--adjustment"], numeric: true }],
	["ionice", { flags: ["-t", "--ignore"], values: ["-c", "-n", "--class", "--classdata"] }],
	["stdbuf", { values: ["-i", "-o", "-e", "--input", "--output", "--error"] }],
	[
		"env",
		{
			flags: ["-i", "-0", "-v", "--ignore-environment", "--null", "--debug"],
			values: ["-u", "-C", "--unset", "--chdir"],
		},
	],
	[
		"timeout",
		{
			flags: ["-v", "--verbose", "--preserve-status", "--foreground"],
			values: ["-s", "-k", "--signal", "--kill-after"],
			operands: 1,
		},
	],
	[
		"xargs",
		{
			flags: [
				"-0",
				"-r",
				"-t",
				"-p",
				"-x",
				"-o",
				"--null",
				"--no-run-if-empty",
				"--verbose",
				"--interactive",
			].concat(["--exit", "--open-tty"]),
			values: ["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args"].concat([
				"--max-procs",
				"--max-chars",
				"--process-slot-var",
			]),
			attached: ["-i", "-l", "-e", "--replace", "--max-lines", "--eof"],
		},
	],
]);

interface Unwrapped {
	/** The program and its arguments. */
	words: ShellWord[];
	/** A VAR=value assignment came before the program. */
	env: boolean;
	/** The last wrapper removed, if any. */
	wrapper?: string;
	/** `xargs` gives the program words it reads. */
	xargs: boolean;
	/** The folder a wrapper runs the program in (`env -C dir`). */
	chdir?: ShellWord;
	/** Why a wrapper's options cannot be trusted. */
	problem?: string;
}

/** A segment's words from the program it runs on: keywords, VAR=value prefixes and wrappers removed. */
function unwrapSegment(words: readonly ShellWord[]): Unwrapped {
	let i = 0;
	const out: Unwrapped = { words: [], env: false, xargs: false };
	for (let guard = 0; guard < 32 && i < words.length; guard++) {
		const word = words[i]!;
		if (!word.quoted && SHELL_KEYWORDS.has(word.text)) {
			i++;
			continue;
		}
		if (ASSIGNMENT_RE.test(word.raw)) {
			out.env = true;
			i++;
			continue;
		}
		const { name, byPath } = programName(word.text);
		const spec = byPath ? undefined : WRAPPERS.get(name);
		// `command -v NAME` only looks a name up.
		if (!spec || (name === "command" && /^-[a-zA-Z]*[vV]/.test(words[i + 1]?.text ?? ""))) break;
		const parsed = parseOptions(words, i + 1, spec);
		if (parsed.problem) out.problem ??= `${name} with ${parsed.problem}`;
		for (const [option, value] of parsed.values) if (option === "-C" || option === "--chdir") out.chdir = value;
		if (name === "xargs") out.xargs = true;
		out.wrapper = name;
		i = parsed.next;
	}
	out.words = words.slice(i);
	return out;
}

/** The operands of a command (its words that are not options or option values). */
function operandsOf(args: string[], withValue: string[] = []): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") {
			out.push(...args.slice(i + 1));
			break;
		}
		if (args[i].startsWith("-") && args[i] !== "-") {
			if (withValue.includes(args[i])) i++;
			continue;
		}
		out.push(args[i]);
	}
	return out;
}

const hasShortOption = (args: string[], letters: string) =>
	args.some((arg) => /^-[^-]/.test(arg) && [...letters].some((letter) => arg.slice(1).includes(letter)));
// fork: GNU programs accept any unambiguous prefix of a long option, so
// `sort --out=f` is `sort --output=f`. Every prefix counts: an ambiguous one only asks.
const hasLongOption = (args: string[], names: string[]) =>
	args.some((arg) => {
		const given = /^--([^=]+)/.exec(arg)?.[1];
		return given !== undefined && names.some((name) => name.startsWith(given));
	});

/** man's options without a value that only choose, find or show a page. */
const MAN_SHORT_FLAGS = "afkwWdDiI7tZK";
/** man's options with a value that only choose a page or how to show it. */
const MAN_SHORT_VALUES = "sSLmeERpT";
const MAN_LONG_FLAGS = [
	"all",
	"whatis",
	"apropos",
	"where",
	"path",
	"location",
	"where-cat",
	"location-cat",
	"debug",
	"default",
	"ignore-case",
	"match-case",
	"regex",
	"wildcard",
	"names-only",
	"no-subpages",
	"ascii",
	"global-apropos",
	"troff",
	"ditroff",
	"no-hyphenation",
	"nh",
	"no-justification",
	"nj",
	"help",
	"usage",
	"version",
];
const MAN_LONG_VALUES = [
	"sections",
	"section",
	"locale",
	"systems",
	"extension",
	"encoding",
	"recode",
	"preprocessor",
	"troff-device",
];

/**
 * fork: man with an option outside those that only choose and show a page. A
 * list of risky options missed `-C` (a configuration file names the formatting programs man runs) and `-l` (a local
 * page includes any file with `.so`); an option this list does not know now asks.
 */
function manOptionsProblem(args: string[]): string | undefined {
	const longNames = [...MAN_LONG_FLAGS, ...MAN_LONG_VALUES];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") break;
		if (!arg.startsWith("-") || arg === "-") continue;
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = longOption(arg.slice(2, eq < 0 ? undefined : eq), longNames);
			if (!name) return `man with ${arg}, an option that can run a program or read another file`;
			if (MAN_LONG_VALUES.includes(name) && eq < 0) i++;
			continue;
		}
		for (let j = 1; j < arg.length; j++) {
			const letter = arg[j]!;
			if (MAN_SHORT_FLAGS.includes(letter)) continue;
			if (!MAN_SHORT_VALUES.includes(letter))
				return `man with -${letter}, an option that can run a program or read another file`;
			if (j === arg.length - 1) i++;
			break;
		}
	}
	return undefined;
}

/** jq options followed by values, and how many. */
const JQ_VALUES = new Map([
	["--indent", 1],
	["-L", 1],
	["--library-path", 1],
	["--arg", 2],
	["--argjson", 2],
	["--argfile", 2],
	["--slurpfile", 2],
	["--rawfile", 2],
]);

/** In a jq program: the environment (`env`, `$ENV`) or code loaded from a file (`import`, `include`). */
const JQ_ENVIRONMENT = /(?<![\w.$])(?:env|import|include)(?!\w)|\$\s*ENV(?!\w)/;

/**
 * fork: jq whose program reads the environment, which `printenv` left the safe
 * list not to hand over (`jq -n env`, `$ENV.TOKEN`). A program or module read from a file is not seen here, so it
 * asks too. A field named env (`.env`) is data, not the builtin.
 */
function jqEnvironmentReason(args: string[]): string | undefined {
	let program: string | undefined;
	for (let i = 0; i < args.length && program === undefined; i++) {
		const arg = args[i]!;
		if (arg === "--") program = args[i + 1];
		else if (arg === "--from-file" || arg === "--run-tests" || /^-[^-L]*f/.test(arg))
			return "jq reading its program from a file";
		else if (arg.startsWith("-") && arg !== "-") i += JQ_VALUES.get(arg) ?? 0;
		else program = arg;
	}
	return program !== undefined && JQ_ENVIRONMENT.test(program)
		? "jq reading the environment or loading code from a file"
		: undefined;
}

/** Options that make a known-safe command write a file or run another program. */
const RISKY_OPTIONS = new Map<string, (args: string[]) => string | undefined>([
	[
		"sort",
		(a) =>
			hasShortOption(a, "o") || hasLongOption(a, ["output", "compress-program"])
				? "sort writing a file or running a program"
				: undefined,
	],
	["uniq", (a) => (operandsOf(a, ["-f", "-s", "-w"]).length > 1 ? "uniq writing its output file" : undefined)],
	["tree", (a) => (hasShortOption(a, "oR") || hasLongOption(a, ["output"]) ? "tree writing files" : undefined)],
	["rg", (a) => (hasLongOption(a, ["pre", "hostname-bin"]) ? "rg running a program" : undefined)],
	["ag", (a) => (hasLongOption(a, ["pager"]) ? "ag running a program" : undefined)],
	["man", manOptionsProblem],
	[
		"less",
		(a) =>
			hasShortOption(a, "oO") || hasLongOption(a, ["log-file", "LOG-FILE"]) || a.some((arg) => arg.startsWith("+"))
				? "less writing a file or running a command"
				: undefined,
	],
	["date", (a) => (hasShortOption(a, "s") || hasLongOption(a, ["set"]) ? "date setting the clock" : undefined)],
	[
		"hostname",
		(a) =>
			operandsOf(a).length > 0 || hasShortOption(a, "bF") || hasLongOption(a, ["file", "boot"])
				? "hostname setting the host name"
				: undefined,
	],
	[
		"file",
		(a) =>
			hasShortOption(a, "C") || hasLongOption(a, ["compile"]) ? "file writing a compiled magic file" : undefined,
	],
	// fork: `printf -v NAME` assigns a variable, and an array index in NAME
	// is evaluated as code.
	["printf", (a) => (/^-v/.test(a[0] ?? "") ? "printf -v assigning a variable" : undefined)],
	["jq", jqEnvironmentReason],
]);

/**
 * fork: a command's arguments with the values of their variables, split as bash splits them
 * (`S=-delete; find . $S` gives find `-delete`), and the first word whose value is not known here and may start with
 * a `-`, before `--`.
 */
function expandedArguments(words: readonly ShellWord[], ctx: BashContext): { args: string[]; unknown?: string } {
	const args: string[] = [];
	let unknown: string | undefined;
	let options = true;
	for (const word of words) {
		const pieces = wordPieces(word, ctx);
		if (typeof pieces === "string") {
			if (options) unknown ??= word.text;
			args.push(word.text);
			continue;
		}
		for (const piece of pieces) {
			if (options && !piece.known && piece.text.startsWith(UNKNOWN_VARIABLE)) unknown ??= word.text;
			args.push(piece.text);
		}
		if (word.text === "--") options = false;
	}
	return { args, unknown };
}

const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_WRITE = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/**
 * fork: the folders that hold credentials, the same list the sandbox hides (with the
 * user's own hidden paths), so that the native tools, which run outside the sandbox, protect them too.
 */
function credentials(): string[] {
	let hidden: readonly string[] = [];
	try {
		const settings = readSandboxSettings();
		hidden = [
			...settings.hide.map((path) => resolve(expandHome(path))),
			// fork: hidden from commands only when they read everything.
			...(settings.read.limit === "all" ? READ_ALL_HIDDEN_HOME_PATHS.map((path) => join(homedir(), path)) : []),
		];
	} catch {}
	return credentialPaths(hidden);
}

/**
 * fork: the danger details that name a protected path or credentials; their question
 * offers no permission for the session.
 */
const PROTECTED_DETAIL = /protected path \(|credential/;

/** The protected path (Prism config file or protected glob) that `abs` designates, if any. */
function protectedPath(abs: string, cwd: string, cfg: PermConfig): string | undefined {
	// judge the file really touched as well as the path written.
	const real = realPath(abs);
	const configFiles = prismConfigFiles(cwd);
	if (configFiles.includes(abs) || configFiles.some((file) => realPath(file) === real)) {
		return "Prism config or credential file";
	}
	// fork: the PC's key for the phone link is read like auth.json.
	if (phoneLinkPath(abs, [abs, real])) return "Prism config or credential file";
	const candidates = [...pathForms(abs, cwd), ...pathForms(real, cwd)];
	for (const glob of [...DEFAULT_PROTECTED_GLOBS, ...(cfg.protectedPaths ?? [])]) {
		if (candidates.some((candidate) => globMatches(glob, false, candidate))) return `protected path (${glob})`;
	}
	return undefined;
}

/** A path a word names: as written, and the file the kernel reaches, links followed before `..` (finding 413). */
interface NamedPath {
	abs: string;
	real: string;
}

const lexists = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * The paths `text` names from the command's folder: itself, or the matches of a pattern (finding 395). A string
 * when they cannot be known: a relative path after an unknown `cd`, a pattern over too many files.
 */
function namedPaths(text: string, glob: boolean, ctx: BashContext): NamedPath[] | string {
	const base = baseDir(ctx);
	if (base === null && !text.startsWith("/")) return "a relative path after a cd to a folder not known in advance";
	const from = base ?? "/";
	if (glob) {
		const matches = expandGlob(text, from);
		if (matches === undefined) return `a pattern over too many files to check (${text})`;
		if (matches.length > 0) return matches.map((match) => ({ abs: resolve(match), real: physicalPath("/", match) }));
	}
	return [{ abs: resolve(from, text), real: physicalPath(from, text) }];
}

const namedProtected = (path: NamedPath, ctx: BashContext) =>
	protectedPath(path.abs, ctx.cwd, ctx.cfg) ??
	(path.real === path.abs ? undefined : protectedPath(path.real, ctx.cwd, ctx.cfg));

/**
 * fork (finding 395): `"$X/.env"`: the part of a word after its last expansion, when it names a protected file
 * wherever the expansion points.
 */
function protectedTail(text: string, ctx: BashContext): string | undefined {
	const tail = text.replace(
		/^[\s\S]*(?:\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9?#$!@*-]|^~[^/]*)/,
		"",
	);
	if (!tail || tail === text) return undefined;
	const relativeTail = tail.replace(/^\/+/, "");
	return (
		protectedPath(join(ctx.cwd, "x", relativeTail), ctx.cwd, ctx.cfg) ??
		(relativeTail ? protectedPath(join(ctx.cwd, relativeTail), ctx.cwd, ctx.cfg) : undefined)
	);
}

/** What one word names, judged like the read tool would. */
function protectedName(word: ShellWord, text: string | undefined, ctx: BashContext): TierResult | undefined {
	if (text === undefined) {
		const hit = protectedTail(word.text, ctx);
		return hit ? { tier: "ask", detail: `a path built from a variable may be a ${hit}` } : undefined;
	}
	if (!text) return undefined;
	const base = baseDir(ctx);
	if (word.glob && (base !== null || text.startsWith("/"))) {
		if (insideCredentials(dirname(resolve(base ?? "/", text)), credentials())) {
			return { tier: "danger", detail: "glob over a credential directory" };
		}
	}
	// A word counts as a path when it holds a `/`, is a pattern or names an existing file, so `jq .key` is not
	// mistaken for a `*.key` file.
	const pathLike = text.includes("/") || word.glob;
	if (base === null && !text.startsWith("/")) {
		if (pathLike || text.startsWith(".")) return { tier: "ask", detail: namedPaths(text, false, ctx) as string };
		const hit = protectedPath(join(ctx.cwd, text), ctx.cwd, ctx.cfg);
		return hit ? { tier: "ask", detail: `a file named like a ${hit}, in a folder not known in advance` } : undefined;
	}
	const named = namedPaths(text, word.glob, ctx);
	if (typeof named === "string") return { tier: "ask", detail: named };
	for (const path of named) {
		if (!pathLike && !lexists(path.abs)) continue;
		const hit = namedProtected(path, ctx);
		if (hit) return { tier: "danger", detail: hit };
	}
	return undefined;
}

/**
 * A protected file named in a command (`cat ~/.pi/agent/auth.json`, `cat -- -alias`, `cat .[e]nv`), judged like the
 * read tool would: after `--` every word is an operand, an option's `=value` is a path too.
 */
function protectedWord(words: readonly ShellWord[], ctx: BashContext): TierResult | undefined {
	let options = true;
	let found: TierResult | undefined;
	for (const word of words) {
		if (options && word.text === "--") {
			options = false;
			continue;
		}
		const hit = protectedPieces(word, ctx, options);
		if (hit?.tier === "danger") return hit;
		found ??= hit;
	}
	return found;
}

/** What the arguments a word may give name (`wordPieces`); an option's `=value` when `options`. */
function protectedPieces(word: ShellWord, ctx: BashContext, options: boolean): TierResult | undefined {
	const pieces = wordPieces(word, ctx);
	if (typeof pieces === "string") return { tier: "ask", detail: pieces };
	let found: TierResult | undefined;
	for (const piece of pieces) {
		let text = piece.text;
		if (options && text.startsWith("-") && text !== "-") {
			const eq = text.indexOf("=");
			if (eq < 0) continue;
			text = text.slice(eq + 1);
		}
		const pieceWord = { ...word, text, glob: piece.glob };
		const hit = protectedName(pieceWord, piece.known ? text : undefined, ctx);
		if (hit?.tier === "danger") return hit;
		found ??= hit;
	}
	return found;
}

/** A dangerous command among the arguments of a command that runs them (`find -exec sudo`, `watch rm -rf`). */
function dangerInArguments(args: readonly ShellWord[], ctx: BashContext, depth: number): TierResult | undefined {
	for (let i = 0; i < args.length; i++) {
		const { name } = programName(args[i]!.text);
		if (!DANGER_COMMANDS.has(name) && name !== "rm") continue;
		// What they run it on comes from them (`find -exec rm -rf {}`): its operands are not known here.
		const inner = classifyWords(args.slice(i), ctx, depth + 1, { fedArguments: true });
		if (inner.tier === "danger") return inner;
	}
	return undefined;
}

/** ssh's options that take a value (`ssh -p 22 host cmd`). */
const SSH_VALUE_OPTIONS = "BbcDEeFIiJLlmOoPpQRSWw";

/** The command `ssh [options] host command…` runs on the host, its words joined as ssh joins them. */
function sshRemoteCommand(args: string[]): string | undefined {
	let i = 0;
	for (; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") {
			i++;
			break;
		}
		if (!arg.startsWith("-") || arg === "-") break;
		for (let k = 1; k < arg.length; k++) {
			if (!SSH_VALUE_OPTIONS.includes(arg[k]!)) continue;
			if (k === arg.length - 1) i++;
			break;
		}
	}
	const command = args.slice(i + 1).join(" ");
	return command.trim() === "" ? undefined : command;
}

/**
 * fork: a Git command its words allow still asks when the repository it runs in
 * has a configuration that names a program (`core.fsmonitor`, `diff.external`…), which Git would run; and when that
 * cannot be known (`dir` null, Git failing).
 */
function classifyGit(args: string[], dir: string | null): TierResult {
	const result = classifyGitArgs(args);
	if (result.tier !== "allow") return result;
	let setting: string | undefined;
	try {
		if (dir === null) throw new Error("unknown folder");
		setting = repositoryProgramSetting(dir);
	} catch {
		return { tier: "ask", detail: "git in a folder whose configuration could not be read" };
	}
	return setting ? { tier: "ask", detail: `git, whose repository configuration runs a program (${setting})` } : result;
}

function classifyGitArgs(args: string[]): TierResult {
	for (let i = 0; i < args.length; i++) {
		// fork: `-ccore.pager=id` is `-c core.pager=id`.
		const setting = args[i] === "-c" ? args[i + 1] : args[i]!.startsWith("-c") ? args[i]!.slice(2) : undefined;
		if (setting !== undefined && GIT_EXEC_CONFIG_RE.test(setting)) {
			return { tier: "danger", detail: "git setting that runs a program" };
		}
	}
	const [sub, ...rest] = args;
	if (!sub) return { tier: "allow" };
	if (GIT_SAFE_SUBCOMMANDS.has(sub)) {
		if (hasLongOption(rest, ["output"])) return { tier: "ask", detail: `git ${sub} writing a file` };
		if (sub === "ls-remote" && (rest.includes("-u") || hasLongOption(rest, ["upload-pack"]))) {
			return { tier: "ask", detail: "git ls-remote running a program" };
		}
		return { tier: "allow" };
	}
	if (sub === "branch") {
		// fork: `-f`, `-m`, `-c`, a new name… move or create refs, not only `-d`.
		return gitBranchReadOnly(rest) ? { tier: "allow" } : { tier: "ask", detail: "git branch change" };
	}
	if (sub === "reflog") {
		// `expire`, `delete` and `drop` remove recovery points; `show`, `exists`, `list` only read.
		return ["expire", "delete", "drop"].includes(rest[0] ?? "")
			? { tier: "ask", detail: `git reflog ${rest[0]}` }
			: { tier: "allow" };
	}
	if (sub === "remote") {
		return rest[0] === "-v" ? { tier: "allow" } : { tier: "ask", detail: "git remote" };
	}
	if (sub === "config") {
		if (rest.some((t) => t === "--get" || t === "--list" || t === "--get-regexp")) return { tier: "allow" };
		const key = rest.find((t) => !t.startsWith("-"));
		return key && GIT_EXEC_CONFIG_RE.test(key)
			? { tier: "danger", detail: "git setting that runs a program" }
			: { tier: "ask", detail: "git config" };
	}
	if (sub === "tag") {
		return rest[0] === "-l" ? { tier: "allow" } : { tier: "ask", detail: "git tag" };
	}
	return { tier: "ask", detail: `git ${sub}` };
}

/**
 * fork: a path below /tmp (or the session's private /tmp), which a command may change with an
 * ordinary question. A home folder under /tmp (a test's) is still the home folder.
 */
const inScratch = (path: string, ctx: BashContext) =>
	(path.startsWith("/tmp/") || (!!ctx.tmp && path.startsWith(`${ctx.tmp}/`))) && !within(path, homedir());

/** Where an operand of `rm -r` is: in the project, in /tmp, or anywhere else (undefined), for finding the danger. */
function removalPlace(word: ShellWord, ctx: BashContext): "project" | "tmp" | undefined {
	const text = wordText(word, ctx);
	if (text === undefined) return undefined;
	const named = namedPaths(text, word.glob, ctx);
	if (typeof named === "string") return undefined;
	// `rm -rf *` at the root of the project removes all of it.
	if (
		word.glob &&
		basename(text) === "*" &&
		projectRoots(ctx.cwd).includes(dirname(resolve(baseDir(ctx) ?? "/", text)))
	) {
		return undefined;
	}
	let place: "project" | "tmp" = "project";
	for (const { abs, real } of named) {
		const roots = projectRoots(ctx.cwd);
		if (insideProject(abs, ctx.cwd) && insideProject(real, ctx.cwd) && !roots.includes(abs) && !roots.includes(real))
			continue;
		if (inScratch(abs, ctx) && inScratch(real, ctx)) {
			place = "tmp";
			continue;
		}
		return undefined;
	}
	return place;
}

/**
 * fork: `rm -r` and `rm -f` are dangerous outside the project and /tmp, or when what they remove
 * is not known here; inside the project they are an ordinary question, like any other write there.
 */
function classifyRm(args: readonly ShellWord[], ctx: BashContext, fedArguments: boolean): TierResult {
	const flags: string[] = [];
	const operands: ShellWord[] = [];
	let options = true;
	for (const word of args) {
		if (options && word.text === "--") options = false;
		else if (options && word.text.startsWith("-") && word.text !== "-") flags.push(word.text);
		else operands.push(word);
	}
	const forced = flags.some((f) => f === "--recursive" || f === "--force" || /^-[a-z]*[rf]/i.test(f));
	if (!forced) return { tier: "ask", detail: "rm" };
	if (flags.some((f) => f.startsWith("--no-pres"))) return { tier: "danger", detail: "rm --no-preserve-root" };
	if (fedArguments) return { tier: "danger", detail: "rm with -r/-f on paths it is given at run time" };
	const places = operands.map((word) => removalPlace(word, ctx));
	if (places.includes(undefined)) return { tier: "danger", detail: "rm with -r/-f outside the project" };
	return { tier: "ask", detail: places.includes("tmp") ? "rm with -r/-f in /tmp" : "rm with -r/-f in the project" };
}

/** Programs whose script can run a command; their scripts are searched for dangerous ones (M4). */
const SCRIPT_RUNNERS = new Set([
	"awk",
	"gawk",
	"mawk",
	"nawk",
	"sed",
	"gsed",
	"perl",
	"python",
	"python3",
	"ruby",
	"node",
	"php",
	"lua",
]);

/** The texts in a script's arguments that may be a command: each argument, its quoted strings, a sed `e` command. */
function quotedStrings(text: string): string[] {
	return [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((quoted) => quoted[1] ?? quoted[2] ?? "");
}

/** The texts of a script that may be commands; `run` marks a sed `e` command, which sed runs for sure. */
function scriptTexts(args: string[], joined = true): Array<{ text: string; run?: boolean }> {
	const texts: Array<{ text: string; run?: boolean }> = [];
	const add = (text: string, depth: number) => {
		texts.push({ text });
		if (depth > 2) return;
		// A string in a string: `'BEGIN{system("sudo id")}'`.
		for (const quoted of quotedStrings(text)) add(quoted, depth + 1);
		for (const sed of text.matchAll(/(?:^|[;\n{])\s*\d*e\s+([^;\n}]+)/g)) texts.push({ text: sed[1]!, run: true });
	};
	for (const arg of joined ? [...args, args.join(" ")] : args) add(arg, 0);
	return texts.filter(({ text }) => text.trim() !== "");
}

/** sed's long options; the ones mapped to false write a file or read a script, and ask. */
const SED_LONG = new Map<string, "flag" | "value" | "script" | false>([
	["--quiet", "flag"],
	["--silent", "flag"],
	["--regexp-extended", "flag"],
	["--separate", "flag"],
	["--unbuffered", "flag"],
	["--null-data", "flag"],
	["--zero-terminated", "flag"],
	["--posix", "flag"],
	["--debug", "flag"],
	["--sandbox", "flag"],
	["--follow-symlinks", "flag"],
	["--line-length", "value"],
	["--expression", "script"],
	["--in-place", false],
	["--file", false],
]);

/**
 * fork: whether a sed script only prints. Its commands are read one by one; `w`, `W`, `r`, `R`,
 * `e`, the `w` and `e` flags of `s`, and anything not understood make it more than a reader.
 */
function sedScriptReadOnly(script: string): boolean {
	let i = 0;
	const at = () => script[i] ?? "";
	// A regular expression's bracket expression may hold the delimiter (`s/[/]/x/`); a backslash or a line break
	// inside one is read differently by sed versions, so it is not understood.
	const bracket = (): boolean => {
		i++;
		if (at() === "^") i++;
		if (at() === "]") i++;
		for (; i < script.length; i++) {
			const c = script[i];
			if (c === "\\" || c === "\n") return false;
			if (c === "]") return true;
			if (c === "[" && /[:.=]/.test(script[i + 1] ?? "")) {
				const close = script.indexOf(`${script[i + 1]}]`, i + 2);
				if (close < 0 || script.slice(i, close).includes("\n")) return false;
				i = close + 1;
			}
		}
		return false;
	};
	const delimited = (delimiter: string, regex: boolean): boolean => {
		for (; i < script.length; i++) {
			if (script[i] === "\\") i++;
			else if (regex && script[i] === "[") {
				if (!bracket()) return false;
			} else if (script[i] === delimiter) {
				i++;
				return true;
			} else if (script[i] === "\n") return false;
		}
		return false;
	};
	const address = (): boolean => {
		if (/[\d$]/.test(at())) {
			while (/[\d~$]/.test(at())) i++;
			return true;
		}
		if (at() === "/" || at() === "\\") {
			const delimiter = at() === "\\" ? script[i + 1] : "/";
			i += at() === "\\" ? 2 : 1;
			if (!delimiter || !delimited(delimiter, true)) return false;
			while (/[IM]/.test(at())) i++;
		}
		return true;
	};
	const skipTo = (stops: RegExp) => {
		while (i < script.length && !stops.test(at())) i++;
	};
	while (i < script.length) {
		while (/[\s;]/.test(at())) i++;
		if (i >= script.length) break;
		if (!address()) return false;
		if (at() === ",") {
			i++;
			while (/[\s+~]/.test(at())) i++;
			if (!address()) return false;
		}
		while (/[\s!]/.test(at())) i++;
		const command = at();
		i++;
		if ("pPdDnNgGhHxzF={}".includes(command)) continue;
		if ("lqQ".includes(command)) {
			while (/[\d ]/.test(at())) i++;
		} else if (command === "#" || "aic".includes(command)) {
			// A comment, or the text of a, i and c, runs to the end of the line; `\` continues it.
			for (; i < script.length && at() !== "\n"; i++) if (at() === "\\") i++;
		} else if (":btT".includes(command)) skipTo(/[;\n}]/);
		else if (command === "s" || command === "y") {
			const delimiter = at();
			i++;
			if (!delimiter || delimiter === "\n" || delimiter === "\\") return false;
			if (!delimited(delimiter, command === "s") || !delimited(delimiter, false)) return false;
			if (command === "s") while (/[gpIiMm\d]/.test(at())) i++;
		} else return false;
	}
	return true;
}

/** Whether sed only reads: no -i, no script file, no option it does not know (GNU sed takes options anywhere). */
function sedReadOnly(args: readonly ShellWord[]): boolean {
	const scripts: string[] = [];
	let operand: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const word = args[i]!;
		const text = word.text;
		if (text === "--") {
			operand ??= args[i + 1]?.text;
			break;
		}
		if (!text.startsWith("-") || text === "-") {
			operand ??= text;
			continue;
		}
		if (word.variable || word.expansion) return false;
		if (text.startsWith("--")) {
			const eq = text.indexOf("=");
			const name = longOption(eq < 0 ? text : text.slice(0, eq), [...SED_LONG.keys()]);
			const kind = name ? SED_LONG.get(name) : false;
			if (!kind) return false;
			const value = eq >= 0 ? text.slice(eq + 1) : kind === "flag" ? undefined : args[++i]?.text;
			if (kind === "script") scripts.push(value ?? "");
			continue;
		}
		for (let k = 1; k < text.length; k++) {
			const letter = text[k]!;
			if ("nErsuz".includes(letter)) continue;
			if (letter !== "e" && letter !== "l") return false;
			const value = text.slice(k + 1) || args[++i]?.text || "";
			if (letter === "e") scripts.push(value);
			break;
		}
	}
	if (scripts.length === 0 && operand !== undefined) scripts.push(operand);
	return scripts.length > 0 && scripts.every(sedScriptReadOnly);
}

/** awk's long options (gawk); the ones mapped to false write a file, load code or read a program file. */
const AWK_LONG = new Map<string, "flag" | "value" | "source" | false>([
	["--field-separator", "value"],
	["--assign", "value"],
	["--source", "source"],
	["--posix", "flag"],
	["--traditional", "flag"],
	["--characters-as-bytes", "flag"],
	["--sandbox", "flag"],
	["--re-interval", "flag"],
	["--lint", "flag"],
	["--bignum", "flag"],
	["--non-decimal-data", "flag"],
	["--use-lc-numeric", "flag"],
	["--optimize", "flag"],
	["--no-optimize", "flag"],
	["--file", false],
	["--include", false],
	["--load", false],
	["--dump-variables", false],
	["--debug", false],
	["--pretty-print", false],
	["--profile", false],
	["--exec", false],
]);

/** Keywords after which awk reads an operand, so a `/` there starts a regular expression. */
const AWK_OPERAND_KEYWORDS = new Set(["print", "printf", "return", "in", "do", "else", "exit", "case"]);

/** Keywords whose parenthesised condition is followed by a statement, where a `/` starts a regular expression. */
const AWK_CONTROL_KEYWORDS = new Set(["if", "while", "for"]);

/**
 * fork: whether an awk program only prints. It does not when it names `system`, `getline`,
 * `ENVIRON` (the environment's secrets), a gawk directive or a coprocess anywhere, or when a print statement sends its
 * output to a file or a command. Strings and regular expressions are set aside first, so their `>` and `|` count for
 * nothing.
 *
 * fork: whether a `/` starts a regular expression or divides is awk's grammar,
 * not the character before it: after `print`, `}` or the `)` of an `if`, awk reads an expression, and a quote in it
 * shifted every string for this check (`print /"/; print "x" | "/bin/sh"; y = /"/` hid the pipe). The previous token
 * decides now, as in awk's lexer; a `/` after a token that does not say (`++`, `--`, `$`) makes the program ask.
 *
 * fork: gawk's `SYMTAB` reaches every variable by a name built at run time,
 * `ENVIRON` included (`SYMTAB["ENV" "IRON"]`), so it asks like `ENVIRON`.
 */
function awkProgramReadOnly(program: string): boolean {
	if (/\b(?:system|getline|ENVIRON|SYMTAB|PROCINFO|ARGV|ARGC)\b|@|\|&/.test(program)) return false;
	let code = "";
	/** The last character outside spaces, and the identifier it ends, if any. */
	let previous = "";
	let word = "";
	/** For each open parenthesis, whether it holds the condition of `if`, `while` or `for`. */
	const parens: boolean[] = [];
	let closedControl = false;
	/** Whether awk reads a `/` here as the start of a regular expression; undefined when this check cannot tell. */
	const regexHere = (): boolean | undefined => {
		if (previous === "" || /[(,{};!~&|=\n?:<>*%^]/.test(previous)) return true;
		if (previous === "+" || previous === "-") {
			// `a++ /x/` divides, `a + /x/` matches: a doubled sign does not say which.
			return code.trimEnd().endsWith(previous + previous) ? undefined : true;
		}
		if (previous === ")") return closedControl;
		if (previous === "]" || previous === '"' || previous === "/") return false;
		if (/[A-Za-z0-9_]/.test(previous)) return AWK_OPERAND_KEYWORDS.has(word);
		return undefined;
	};
	for (let i = 0; i < program.length; i++) {
		const c = program[i]!;
		if (c === "/") {
			const regex = regexHere();
			if (regex === undefined) return false;
			if (!regex) {
				code += c;
				previous = c;
				word = "";
				continue;
			}
		}
		if (c === '"' || c === "/") {
			let end = i + 1;
			for (let inClass = false; end < program.length; end++) {
				const d = program[end];
				if (d === "\\") end++;
				else if (c === "/" && d === "[") inClass = true;
				else if (c === "/" && d === "]") inClass = false;
				else if (d === c && !inClass) break;
				else if (d === "\n") return false;
			}
			if (end >= program.length) return false;
			code += `${c}${c}`;
			previous = c;
			word = "";
			i = end;
			continue;
		}
		if (c === "#") {
			while (i < program.length && program[i] !== "\n") i++;
			code += "\n";
			previous = "\n";
			word = "";
			continue;
		}
		if (c === "\\" && program[i + 1] === "\n") {
			// A continued line is one line for awk.
			code += " ";
			i++;
			continue;
		}
		code += c;
		if (/[ \t]/.test(c)) continue;
		// An identifier goes on only from the character just before it, not across a space.
		if (/[A-Za-z0-9_]/.test(c)) word = /[A-Za-z0-9_]/.test(program[i - 1] ?? "") ? word + c : c;
		else {
			if (c === "(") parens.push(AWK_CONTROL_KEYWORDS.has(word));
			if (c === ")") closedControl = parens.pop() ?? false;
			word = "";
		}
		previous = c;
	}
	// awk also goes on to the next line after a comma, `&&` or `||`.
	code = code.replace(/(,|&&|\|\|)\s*\n/g, "$1 ");
	for (const statement of code.matchAll(/\bprintf?\b([^;{}\n]*)/g)) {
		let depth = 0;
		for (const c of statement[1]!) {
			if (c === "(") depth++;
			else if (c === ")") depth--;
			else if (depth <= 0 && (c === ">" || c === "|")) return false;
		}
	}
	return true;
}

/** An awk assignment to ARGV or ARGC, which changes the files awk reads (`-v ARGC=…`, an operand `ARGC=…`). */
const SETS_AWK_ARGUMENTS = /^\s*(?:ARGV|ARGC)\b/;

/** Whether awk only reads: its program prints, and no option writes a file or loads code. */
function awkReadOnly(args: readonly ShellWord[]): boolean {
	const sources: string[] = [];
	let i = 0;
	for (; i < args.length; i++) {
		const word = args[i]!;
		const text = word.text;
		if (text === "--") {
			i++;
			break;
		}
		if (!text.startsWith("-") || text === "-") break;
		if (word.variable || word.expansion) return false;
		if (text.startsWith("--")) {
			const eq = text.indexOf("=");
			const name = longOption(eq < 0 ? text : text.slice(0, eq), [...AWK_LONG.keys()]);
			const kind = name ? AWK_LONG.get(name) : false;
			if (!kind) return false;
			const value = eq >= 0 ? text.slice(eq + 1) : kind === "flag" ? undefined : args[++i]?.text;
			if (kind === "source") sources.push(value ?? "");
			if (name === "--assign" && SETS_AWK_ARGUMENTS.test(value ?? "")) return false;
			continue;
		}
		const letter = text[1]!;
		const rest = text.slice(2);
		if (letter === "F" || letter === "v") {
			const valueWord = rest ? undefined : args[++i];
			if (valueWord?.variable || valueWord?.expansion) return false;
			if (letter === "v" && SETS_AWK_ARGUMENTS.test(rest || valueWord?.text || "")) return false;
		} else if (letter === "e") sources.push(rest || args[++i]?.text || "");
		else if (rest || !"bcgLMnNOPrsStV".includes(letter)) return false;
	}
	if (sources.length === 0) {
		const program = args[i];
		if (!program || program.variable || program.expansion) return false;
		sources.push(program.text);
		i++;
	}
	// An operand `ARGC=…` is an assignment awk makes before reading on.
	if (args.slice(i).some((word) => SETS_AWK_ARGUMENTS.test(word.text))) return false;
	return sources.every(awkProgramReadOnly);
}

const READ_ONLY_SCRIPTS = new Map<string, (args: readonly ShellWord[]) => boolean>([
	["sed", sedReadOnly],
	["gsed", sedReadOnly],
	["awk", awkReadOnly],
	["gawk", awkReadOnly],
	["mawk", awkReadOnly],
	["nawk", awkReadOnly],
]);

interface WordsOptions {
	/** The program is given more arguments at run time (`xargs`, `find -exec`). */
	fedArguments?: boolean;
	/** What it reads on its standard input from the line: here-documents and here-strings. */
	input?: readonly string[];
}

/** The tier of a program and its arguments (`words[0]` is the program, already unwrapped). */
const BUILT_NAME = "a program whose name a substitution builds";

/**
 * A dangerous program named in a string of a script (`system("sudo id")`). Only the programs count: a `>` or a path in
 * a string is text the script prints or writes, rarely a shell redirection.
 */
function scriptDanger(text: string, ctx: BashContext, depth: number): TierResult | undefined {
	for (const segment of shellSegments(text)) {
		const inner = classifyWords(unwrapSegment(segment.words).words, ctx, depth);
		if (inner.tier === "danger") return inner;
		if (depth >= 3) continue;
		for (const { body } of segmentSubstitutions(segment)) {
			const nested = scriptDanger(body, ctx, depth + 1);
			if (nested) return nested;
		}
	}
	return undefined;
}

function classifyWords(
	words: readonly ShellWord[],
	ctx: BashContext,
	depth: number,
	options: WordsOptions = {},
): TierResult {
	const first = words[0];
	if (!first) return { tier: "allow" };
	// fork: a program named by a substitution (`"$(echo sudo)" id`) is unknown here.
	if (/`|\$\(/.test(first.raw)) return { tier: "danger", detail: BUILT_NAME };
	if (first.expansion) return { tier: "ask", detail: `${first.text} (a program named by a variable)` };
	const program = wordText(first, ctx);
	if (program === undefined) return { tier: "ask", detail: first.text };
	const { name: word, byPath } = programName(program);
	const rest = words.slice(1);
	const args = rest.map((w) => w.text);
	const input = options.input ?? [];

	if (DANGER_COMMANDS.has(word)) {
		return { tier: "danger", detail: word };
	}

	if (word === "rm") return classifyRm(rest, ctx, options.fedArguments === true);

	if (byPath) return { tier: "ask", detail: `${program} (program run by path)` };

	if (word === "crontab") {
		return args[0] === "-l" ? { tier: "allow" } : { tier: "danger", detail: "crontab" };
	}

	// What xargs gives its program may be options: only programs no option makes write or run something (411).
	const fed = (result: TierResult): TierResult =>
		options.fedArguments && result.tier === "allow" && !XARGS_SAFE.has(word)
			? { tier: "ask", detail: `${word} given arguments at run time (xargs)` }
			: result;

	if (word === "find") {
		if (args.some((t) => FIND_EXEC.has(t))) {
			return dangerInArguments(rest, ctx, depth) ?? { tier: "ask", detail: "find with -exec" };
		}
		const expanded = expandedArguments(rest, ctx);
		if (expanded.args.some((t) => FIND_EXEC.has(t))) return { tier: "ask", detail: "find with -exec" };
		if (expanded.args.some((t) => FIND_WRITE.has(t)))
			return { tier: "ask", detail: "find deleting or writing files" };
		if (expanded.unknown) return { tier: "ask", detail: `find given ${expanded.unknown}, which may be an option` };
		return fed({ tier: "allow" });
	}

	if (word === "git") return fed(classifyGit(args, baseDir(ctx)));

	// Reached only for `command -v` / `-V` (a lookup): other uses are unwrapped.
	if (word === "command") return { tier: "allow" };
	// fork: `builtin eval 'sudo id'` is `eval 'sudo id'`.
	if (word === "builtin" && words.length > 1) return classifyWords(rest, ctx, depth, options);

	// Recursive searches read every file below their paths, so not a credential directory (M2).
	const recursive =
		word === "rg" ||
		word === "ag" ||
		(/^[ef]?grep$/.test(word) && (hasShortOption(args, "rR") || hasLongOption(args, ["recursive"])));
	const base = baseDir(ctx) ?? ctx.cwd;
	if (recursive && operandsOf(args).some((path) => holdsCredentials(resolve(base, expandHome(path)), credentials()))) {
		return { tier: "danger", detail: "search over a directory holding credentials" };
	}

	if (SAFE_BASH_COMMANDS.has(word)) {
		const risky = RISKY_OPTIONS.get(word);
		const expanded = risky ? expandedArguments(word === "printf" ? rest.slice(0, 1) : rest, ctx) : undefined;
		const risk = risky?.(args) ?? (expanded && risky?.(expanded.args));
		if (risk) return { tier: "ask", detail: risk };
		if (expanded?.unknown)
			return { tier: "ask", detail: `${word} given ${expanded.unknown}, which may be an option` };
		return fed({ tier: "allow" });
	}

	// `bash -c '...'`, `eval '...'` and a shell reading a here-document: the command they run is classified too, at
	// least "ask".
	const shellC = SHELLS.has(word) ? args.findIndex((t) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) : -1;
	if (word === "eval" || SHELLS.has(word)) {
		// fork: eval runs its words joined, without their quotes.
		const scripts = word === "eval" ? [args.join(" ")] : shellC >= 0 ? [args[shellC + 1] ?? ""] : input;
		if (depth < 3) {
			for (const script of scripts) {
				const result = classifyBash(script, ctx, depth + 1);
				if (result.tier === "danger") return result;
			}
		}
		if (word === "eval") return { tier: "ask", detail: "eval" };
		return { tier: "ask", detail: shellC >= 0 ? `${word} -c` : `${word} (runs a script or -c)` };
	}
	if (word === "source" || word === ".") {
		return { tier: "ask", detail: word };
	}
	// The command ssh sends and the here-document it reads run in a shell on the other host.
	if (word === "ssh") {
		const remote = sshRemoteCommand(args);
		if (depth < 3) {
			for (const script of [...(remote ? [remote] : []), ...input]) {
				const result = classifyBash(script, ctx, depth + 1);
				if (result.tier === "danger") return { tier: "danger", detail: `${result.detail} (over ssh)` };
			}
		}
		return { tier: "ask", detail: "ssh" };
	}

	if (RUNS_ITS_ARGUMENTS.has(word)) {
		const danger = dangerInArguments(rest, ctx, depth);
		if (danger) return danger;
	}

	// fork: sed and awk that only print are read like cat.
	if (READ_ONLY_SCRIPTS.get(word)?.(rest)) return fed({ tier: "allow" });

	// fork: a program whose script runs commands (`awk 'BEGIN{system("sudo id")}'`,
	// `sed -n 'e sudo id'`, `python -c "os.system('sudo id')"`): a dangerous command in its text asks as such.
	// A here-document is not shell code: only its strings are read, as in an argument (`os.system("sudo id")`).
	if (SCRIPT_RUNNERS.has(word) && depth < 3) {
		// The words as written, quotes kept: the script itself is one word, only the strings in it are read as commands.
		const raw = rest.map((w) => w.raw);
		const texts = [...scriptTexts(raw), ...input.flatMap((body) => scriptTexts(quotedStrings(body), false))];
		for (const { text, run } of texts) {
			const inner = scriptDanger(text, ctx, depth + 1);
			// A `$(` in a string (`sed 's/$(x)/y/'`, shell code a python script writes) names no program, except in a
			// command sed runs (`e`).
			if (inner && (run || !inner.detail?.startsWith(BUILT_NAME)))
				return { tier: "danger", detail: `${inner.detail} (in a ${word} script)` };
		}
	}

	// Everything else (npm, python, node, docker, kubectl, ...) needs confirmation.
	return { tier: "ask", detail: word };
}

const HARMLESS_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

/**
 * The tier of a segment's redirections: reading a
 * protected file is dangerous, a write in the project or /tmp asks, a write anywhere else is dangerous.
 */
function checkRedirects(redirects: readonly ShellRedirect[], ctx: BashContext): TierResult | undefined {
	let found: TierResult | undefined;
	for (const { op, target, hereDoc } of redirects) {
		if (!target || hereDoc || op.endsWith("<<<")) continue;
		// `2>&1`, `<&0`, `>&-`: a descriptor, not a file. `> >(cmd)`: a pipe to a command, classified with the substitutions.
		if (/[<>]&$/.test(op) && /^(\d+|-)$/.test(target.text)) continue;
		if (/^[<>]\(/.test(target.raw)) continue;
		let text = wordText(target, ctx);
		if (text !== undefined && target.glob) {
			// Bash redirects to the one file a pattern matches.
			const matches = baseDir(ctx) === null ? undefined : expandGlob(text, baseDir(ctx)!);
			if (matches?.length === 1) text = matches[0]!;
		}
		if (text !== undefined && (HARMLESS_TARGETS.has(text) || /^\/(?:dev|proc\/self)\/fd\/\d+$/.test(text))) continue;
		if (!op.includes(">")) {
			const hit = protectedPieces({ ...target, glob: false }, ctx, false);
			if (hit?.tier === "danger") return { tier: "danger", detail: `redirect from a ${hit.detail}` };
			found ??= hit;
			continue;
		}
		if (text === undefined)
			return { tier: "danger", detail: `redirect to a path built from a variable (${target.text})` };
		const named = namedPaths(text, false, ctx);
		if (typeof named === "string") return { tier: "danger", detail: `redirect to ${named}` };
		const [{ abs, real }] = named as [NamedPath];
		const hit = namedProtected({ abs, real }, ctx);
		if (hit) return { tier: "danger", detail: `redirect to a ${hit}` };
		// fork: the command's /tmp is the session's private one, written like the project.
		const scratch = ctx.tmp && !insideProject(abs, ctx.cwd) ? inSessionTmp(abs, ctx.tmp) : undefined;
		if (scratch !== undefined) {
			if (realInTmp(scratch, ctx.tmp!)) {
				found ??= { tier: "ask", detail: `file redirect (${text})` };
				continue;
			}
		} else if (!ctx.tmp && inScratch(abs, ctx) && inScratch(real, ctx)) {
			// fork: without the sandbox, /tmp is still scratch space: an ordinary question.
			found ??= { tier: "ask", detail: `file redirect (${text})` };
			continue;
		}
		if (!insideProject(abs, ctx.cwd) || !insideProject(real, ctx.cwd)) {
			return { tier: "danger", detail: `redirect outside project (${text})` };
		}
		found ??= { tier: "ask", detail: `file redirect (${text})` };
	}
	return found;
}

/** The commands a segment's substitutions run: in its words, its redirections and its expanded here-documents. */
function segmentSubstitutions(segment: ShellSegment): Array<{ body: string; process: boolean }> {
	const bodies: Array<{ body: string; process: boolean }> = [];
	for (const word of segment.words) bodies.push(...commandSubstitutions(word.raw));
	for (const { target, hereDoc } of segment.redirects) {
		if (hereDoc) {
			if (hereDoc.expands) bodies.push(...commandSubstitutions(hereDoc.body, true));
		} else if (target) bodies.push(...commandSubstitutions(target.raw));
	}
	return bodies;
}

/** What a segment's program reads from the line on its standard input: here-documents and here-strings. */
const segmentInput = (segment: ShellSegment): string[] =>
	segment.redirects.flatMap(({ op, target, hereDoc }) =>
		hereDoc ? [hereDoc.body] : op.endsWith("<<<") && target ? [target.text] : [],
	);

function classifySegment(segment: ShellSegment, ctx: BashContext, depth = 0): TierResult {
	let result: TierResult = { tier: "allow" };
	const escalate = (r: TierResult | undefined) => {
		if (r && RANK[r.tier] > RANK[result.tier]) result = r;
		return result.tier === "danger";
	};
	const unwrapped = unwrapSegment(segment.words);
	// `env -C dir cmd` runs cmd in dir (finding 388).
	let inner = ctx;
	if (unwrapped.chdir) {
		const text = wordText(unwrapped.chdir, ctx);
		const base = baseDir(ctx);
		inner = {
			...ctx,
			dir: text === undefined || (base === null && !text.startsWith("/")) ? null : physicalPath(base ?? "/", text),
		};
	}
	if (escalate(assignedAndRead(segment))) return result;
	if (escalate(protectedWord(segment.words, ctx))) return result;
	if (inner !== ctx && escalate(protectedWord(unwrapped.words, inner))) return result;
	if (escalate(checkRedirects(segment.redirects, ctx))) return result;
	for (const { body, process } of segmentSubstitutions(segment)) {
		const nested =
			depth < 3 ? classifyBash(body, ctx, depth + 1) : { tier: "ask" as const, detail: "nested command" };
		if (nested.tier === "danger") return { tier: "danger", detail: `${nested.detail} (in substitution)` };
		// A command substitution's output becomes words of the command, which the check cannot see; a process
		// substitution only gives a file to read or write (`diff <(ls a) b`).
		escalate(nested.tier === "allow" && !process ? { tier: "ask", detail: "command substitution" } : nested);
	}
	if (unwrapped.problem) escalate({ tier: "ask", detail: unwrapped.problem });
	if (unwrapped.words.length === 0) {
		if (unwrapped.wrapper === "env") escalate({ tier: "ask", detail: "env (prints the environment)" });
	} else {
		let words = classifyWords(unwrapped.words, inner, depth, {
			fedArguments: unwrapped.xargs,
			input: segmentInput(segment),
		});
		// A variable can change what a command does (GIT_EXTERNAL_DIFF=rm git diff, LD_PRELOAD=...).
		if (unwrapped.env && words.tier === "allow")
			words = { tier: "ask", detail: "environment variable set for the command" };
		// fork: or set before it in the line, for a variable it inherits.
		else if (ctx.changedEnv && words.tier === "allow")
			words = { tier: "ask", detail: `environment variable ${ctx.changedEnv} changed earlier in the command` };
		if (escalate(words)) return result;
	}
	// What the lexer cannot read never runs without a question; a danger found in it still counts.
	if (segment.opaque && result.tier === "allow") {
		result = { tier: "ask", detail: `${segment.opaque}, which the permission check cannot read` };
	}
	return result;
}

const PIPES = new Set(["|", "|&"]);

/** The words of a segment, its redirections' targets included. */
const segmentWords = (segment: ShellSegment) => [
	...segment.words,
	...segment.redirects.flatMap((r) => (r.target && !r.hereDoc ? [r.target] : [])),
];

/** The `${NAME:=ARG}` and `${NAME=ARG}` of a segment, which set NAME in the current shell. */
const assignedDefaults = (segment: ShellSegment) =>
	segmentWords(segment).flatMap((word) =>
		parameterExpansions(word.raw).filter((expansion) => expansion.op === ":=" || expansion.op === "="),
	);

/**
 * fork: a variable a command both sets with `${S:=…}` and reads (`cat ${S:=x} ${S}y`):
 * which value each word sees is not followed here, so it asks.
 */
function assignedAndRead(segment: ShellSegment): TierResult | undefined {
	const assigned = assignedDefaults(segment);
	for (const name of new Set(assigned.map((expansion) => expansion.name))) {
		const uses = new RegExp(`\\$\\{${name}(?![A-Za-z0-9_])`, "g");
		const count = segmentWords(segment).reduce((n, word) => n + (word.text.match(uses)?.length ?? 0), 0);
		if (count > assigned.filter((expansion) => expansion.name === name).length) {
			return { tier: "ask", detail: `the variable ${name}, set and read in one command` };
		}
	}
	return undefined;
}

/**
 * The variables `${S:=value}` and `${S=value}` set (an unset or, with `:=`, empty S). A variable not known here is
 * taken as unset, as most are: one set outside the line is not known anyway.
 */
function applyAssignedDefaults(segment: ShellSegment, ctx: BashContext, vars: Map<string, string>): void {
	for (const { name, op, arg } of assignedDefaults(segment)) {
		const current = vars.get(name);
		if (current !== undefined && (current !== "" || op === "=")) continue;
		const value = candidateTexts(unquoted(arg), { ...ctx, vars });
		if (Array.isArray(value) && value.length === 1 && !value[0]!.includes(UNKNOWN)) vars.set(name, value[0]!);
		else vars.delete(name);
	}
}

/** The folder and variables after a segment that runs in the current shell: `cd`, `S=value`, `export S=value`. */
function afterSegment(segment: ShellSegment, ctx: BashContext): Pick<BashContext, "dir" | "vars" | "changedEnv"> {
	const vars = new Map(ctx.vars ?? []);
	let dir = baseDir(ctx);
	let start = 0;
	while (
		start < segment.words.length &&
		!segment.words[start]!.quoted &&
		SHELL_KEYWORDS.has(segment.words[start]!.text)
	) {
		start++;
	}
	const words = segment.words.slice(start);
	const first = words[0];
	const exported = first !== undefined && !first.quoted && first.text === "export";
	const assignments = exported ? words.slice(1) : words;
	let changedEnv = ctx.changedEnv;
	applyAssignedDefaults(segment, ctx, vars);
	if (assignments.length > 0 && assignments.every((word) => ASSIGNMENT_RE.test(word.raw))) {
		for (const word of assignments) {
			const eq = word.text.indexOf("=");
			const name = word.text.slice(0, eq);
			// fork: a variable the commands inherit already, or one exported here.
			if (exported || process.env[name] !== undefined) changedEnv ??= name;
			const raw = word.raw.slice(word.raw.indexOf("=") + 1);
			const value = word.expansion
				? undefined
				: word.variable
					? expandText(word.text.slice(eq + 1), raw.startsWith("~"), ctx)
					: word.text.slice(eq + 1);
			if (value === undefined) vars.delete(name);
			else vars.set(name, value);
		}
		return { dir, vars, changedEnv };
	}
	// `export S` exports a variable the line may have set.
	if (exported && words.length > 1) changedEnv ??= words[1]!.text;
	// A variable another command may set (`read S`, `for S in`, `printf -v S`, `unset S`) is no longer known.
	for (const word of segment.words) {
		const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(word.text)?.[0];
		if (name) vars.delete(name);
	}
	if (first && !first.quoted && (first.text === "pushd" || first.text === "popd"))
		return { dir: null, vars, changedEnv };
	if (first && !first.quoted && first.text === "cd") {
		let k = 1;
		while (k < words.length && /^-[LPe@]+$/.test(words[k]!.text)) k++;
		if (words[k]?.text === "--") k++;
		const target = words[k];
		const text = target === undefined ? homedir() : target.text === "-" ? undefined : wordText(target, ctx);
		const next = text === undefined || (dir === null && !text.startsWith("/")) ? null : resolve(dir ?? "/", text);
		// When the cd may have failed, the commands after it run in either folder.
		const sure = segment.operator === "&&" || (next !== null && isDirectory(next));
		dir = sure ? next : null;
	}
	return { dir, vars, changedEnv };
}

/**
 * Each segment of a command line with the context it runs in: a `cd` or `S=value` reaches the segments after it, not
 * through a pipe or a background `&`, and not out of parentheses (finding 388). `visit` returns true to stop.
 */
function forEachSegment(
	command: string,
	ctx: BashContext,
	visit: (segment: ShellSegment, ctx: BashContext) => boolean | undefined,
): void {
	let state: Pick<BashContext, "dir" | "vars" | "changedEnv"> = {
		dir: baseDir(ctx),
		vars: ctx.vars,
		changedEnv: ctx.changedEnv,
	};
	const saved: Array<Pick<BashContext, "dir" | "vars" | "changedEnv">> = [];
	const segments = shellSegments(command);
	for (let k = 0; k < segments.length; k++) {
		const segment = segments[k]!;
		const here: BashContext = { ...ctx, ...state };
		if (visit(segment, here)) return;
		const before = segments[k - 1]?.operator;
		if (!PIPES.has(segment.operator ?? "") && !PIPES.has(before ?? "") && segment.operator !== "&") {
			state = afterSegment(segment, here);
		}
		if (segment.operator === "(") saved.push(state);
		if (segment.operator === ")") state = saved.pop() ?? { dir: null, vars: undefined, changedEnv: ctx.changedEnv };
	}
}

function classifyBash(command: string, ctx: BashContext, depth = 0): TierResult {
	for (const [re, why] of DANGER_PATTERNS) {
		if (re.test(command)) return { tier: "danger", detail: why };
	}
	let result: TierResult = { tier: "allow" };
	forEachSegment(command, ctx, (segment, here) => {
		const r = classifySegment(segment, here, depth);
		if (RANK[r.tier] > RANK[result.tier]) result = r;
		return result.tier === "danger";
	});
	// fork: text built to run later, `${x:=\$\(…\)} ${x@P}` for one.
	if (result.tier === "allow") {
		const built = evaluatedText(command);
		if (built) result = { tier: "ask", detail: built };
	}
	return result;
}

/** A segment's text in its line, without its operator and here-document bodies. */
const segmentText = (command: string, segment: ShellSegment) => command.slice(segment.start, segment.end).trim();

/**
 * What deny and ask rules see of a shell command: the whole line, each
 * command in it, and each command unwrapped (`FOO=1 timeout 5 /usr/bin/curl x` is also `curl x`),
 * so `bash(curl*)` catches `true && curl x`. The commands of substitutions and here-documents count too.
 */
function shellRuleTargets(command: string): string[] {
	const targets = new Set([command, command.trim()]);
	const add = (text: string, depth: number) => {
		for (const segment of shellSegments(text)) {
			const span = segmentText(text, segment);
			if (span) targets.add(span);
			const { words } = unwrapSegment(segment.words);
			if (words[0]) targets.add([programName(words[0].text).name, ...words.slice(1).map((w) => w.text)].join(" "));
			if (depth >= 3) continue;
			for (const { body } of segmentSubstitutions(segment)) add(body, depth + 1);
			for (const { hereDoc } of segment.redirects) if (hereDoc) add(hereDoc.body, depth + 1);
		}
	};
	add(command, 0);
	return [...targets];
}

/**
 * The allow rule covering a shell command: every command in the line must
 * be matched by an allow rule or be allowed on its own, so `bash(npm run*)` no longer covers
 * `npm run x; node evil.js`. A command substitution is never covered by a pattern.
 */
function shellAllowRule(rules: Rule[], tool: string, command: string, ctx: BashContext): Rule | undefined {
	// a grant of the whole desktop tool, given for a click or a screenshot, never starts programs
	// outside the sandbox; a launch needs desktop(<command>) or desktop(*).
	const own = rules.filter((rule) => rule.tool === tool && (rule.pattern || tool !== "desktop"));
	const whole = own.find((rule) => !rule.pattern);
	if (whole || own.length === 0) return whole;
	// fork: not `<(…)`, `${x@P}` and the other ways to run unseen code either.
	if (unseenCodeReason(command)) return undefined;
	let matched: Rule | undefined;
	let covered = true;
	forEachSegment(command, ctx, (segment, here) => {
		const span = segmentText(command, segment);
		if (!span) return undefined;
		const rule = own.find((candidate) => ruleMatches(candidate, tool, [span]));
		if (rule) matched ??= rule;
		else if (classifySegment(segment, here).tier !== "allow") covered = false;
		return !covered;
	});
	return covered ? matched : undefined;
}

/** The reason of the first part of `command` that no allow rule covers and that needs a permission. */
function uncoveredDetail(command: string, rules: Rule[], tool: string, ctx: BashContext): string | undefined {
	const own = rules.filter((rule) => rule.tool === tool && rule.pattern);
	if (own.length === 0) return undefined;
	let detail: string | undefined;
	forEachSegment(command, ctx, (segment, here) => {
		const span = segmentText(command, segment);
		if (!span || own.some((rule) => ruleMatches(rule, tool, [span]))) return undefined;
		const result = classifySegment(segment, here);
		if (result.tier !== "allow") detail = result.detail;
		return detail !== undefined;
	});
	return detail;
}

/** The first part of `command` that needs a permission no allow rule gives, else its first part. */
function segmentNeedingRule(command: string, ctx: BashContext, own: Rule[], tool: string): ShellSegment | undefined {
	let first: ShellSegment | undefined;
	let needing: ShellSegment | undefined;
	forEachSegment(command, ctx, (segment, here) => {
		const span = segmentText(command, segment);
		if (!span) return undefined;
		first ??= segment;
		if (classifySegment(segment, here).tier !== "allow" && !own.some((rule) => ruleMatches(rule, tool, [span]))) {
			needing = segment;
		}
		return needing !== undefined;
	});
	return needing ?? first;
}

// ---------------------------------------------------------------------------
// File tool classifier
// ---------------------------------------------------------------------------

const DEFAULT_PROTECTED_GLOBS = [
	".env",
	".env.*",
	"**/.env",
	"**/.env.*",
	"**/id_rsa",
	"**/id_rsa.pub",
	"**/id_ed25519",
	"**/id_ed25519.pub",
	"**/*.pem",
	"**/*.key",
	".netrc",
	"**/.netrc",
	"**/netrc",
	"**/authorized_keys",
	// fork: the common names of credential and secret files.
	"**/.env~",
	"**/.envrc",
	"**/.dev.vars",
	"**/id_ecdsa",
	"**/id_ecdsa_sk",
	"**/id_ed25519_sk",
	"**/id_dsa",
	"**/*.p12",
	"**/*.pfx",
	"**/*.jks",
	"**/*.keystore",
	"**/.npmrc",
	"**/.pypirc",
	"**/.git-credentials",
	"**/.htpasswd",
	"**/credentials.json",
	"**/service-account.json",
	"**/secrets.json",
	"**/secrets.yaml",
	"**/secrets.yml",
	"**/.aws/credentials",
	"**/.docker/config.json",
	"**/kubeconfig",
	"**/.kube/config",
	"**/*.tfstate",
	"**/*.tfstate.backup",
	"**/*.tfvars",
	"**/*.tfvars.json",
	"**/wp-config.php",
	"**/config/database.yml",
	"**/local.settings.json",
	"**/.git/hooks/**",
	// fork: core.fsmonitor, diff.external... run on the next git status.
	"**/.git/config",
	`${CONFIG_DIR_NAME}/permissions.json`,
	`**/${CONFIG_DIR_NAME}/permissions.json`,
	"**/trust.json",
];

function classifyFileTool(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	cfg: PermConfig,
	tmp?: string,
): TierResult {
	const raw = input.path;
	if (typeof raw !== "string" || !raw) return { tier: "ask", detail: "no path provided" };
	const abs = toolPath(tool, raw, cwd);
	// judge the file really touched as well as the path written, or a symlink in the
	// project would turn a dangerous call into an ordinary one.
	const real = realPath(abs);
	const hit = protectedPath(abs, cwd, cfg);
	if (hit) return { tier: "danger", detail: hit, abs };
	// fork: grep reads every file below a directory, hidden ones included.
	if (tool === "grep" && holdsCredentials(abs, credentials())) {
		return { tier: "danger", detail: "search over a directory holding credentials", abs };
	}
	// fork: what the sandbox hides from commands, read by a tool that runs outside it.
	// Prism's own folder keeps its file-by-file policy (its credential files above, the rest readable).
	const agentDir = realPath(getAgentDir());
	if (tool === "read" && !within(real, agentDir) && !within(agentDir, real)) {
		const secret = insideCredentials(abs, credentials());
		if (secret) return { tier: "danger", detail: `credential file or folder (${homeRelative(secret)})`, abs };
	}
	if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
		return { tier: "allow", abs };
	}
	// write / edit
	// the browser extension's copies in ~/Prism, the window's folder when it opens in
	// the home folder. The browser runs them again at its next start, outside the sandbox, with the extension's rights.
	const copy = extensionCopies().find((folder) => within(abs, folder) || within(real, realPath(folder)));
	if (copy) return { tier: "danger", detail: "protected path (Prism browser extension)", abs };
	// fork: a write through one name changes the file under all its names, which may be
	// outside the project or protected.
	const links = judgedFile(abs).links;
	if (links > 1)
		return { tier: "danger", detail: `file with ${links} names (hard links): writing changes them all`, abs };
	if (insideProject(abs, cwd) && insideProject(real, cwd)) {
		return { tier: "ask", detail: "write inside project", abs };
	}
	// fork: the gate has already moved a path under /tmp into the session's private /tmp.
	if (tmp && realInTmp(abs, tmp)) return { tier: "ask", detail: "write in the session's /tmp", abs };
	if (real !== abs && insideProject(abs, cwd)) {
		return { tier: "danger", detail: `write outside project through a symlink to ${real}`, abs };
	}
	// fork: without the sandbox, /tmp is scratch space, as for a command's redirect; broad mode
	// writes there without asking (decide). The file really written must be in /tmp too, outside the home folder and
	// Prism's own folder; protected paths, links out of /tmp and hard links are dangerous above, in every mode.
	const scratch = !tmp && inScratch(abs, { cwd, cfg }) && inScratch(real, { cwd, cfg }) && !within(real, agentDir);
	return { tier: "danger", detail: "write outside project", abs, ...(scratch ? { scratch } : {}) };
}

// ---------------------------------------------------------------------------
// Reading limited to the project
// ---------------------------------------------------------------------------

/** A path the user let the agent read with the file tools: `readable(<path>)`, the path and what it holds. */
const READABLE = "readable";
const readableRule = (path: string) => `${READABLE}(${path})`;

const isDirectory = (path: string) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/**
 * Prism's own files the file tools read and commands do not (sandbox.md § 9.5): its documentation and examples,
 * the skills, prompts, themes and extensions of its folder, and the logs of this session's background tasks.
 */
function prismResources(): string[] {
	const agentDir = getAgentDir();
	return [
		getPackageDir(),
		...["skills", "prompts", "themes", "extensions"].map((name) => join(agentDir, name)),
		...(backgroundTasks() ?? []).map((task) => task.logPath),
	].map((path) => realPath(path));
}

/** What the agent may read with these settings, plus `allow`. */
const readSetFor = (cwd: string, settings: SandboxSettings, allow: readonly string[] = []) =>
	readableSet({
		cwd,
		allow: [...settings.read.allow, ...allow],
		allowWrite: settings.allowWrite,
		hide: [...DEFAULT_HIDDEN_HOME_PATHS.map((path) => join(homedir(), path)), ...settings.hide],
		toolsOff: settings.read.toolsOff,
	});

/** What Prism leaves in the system's temporary folder: full outputs of commands and tools, sandbox /tmp folders. */
const PRISM_TEMP = /^(?:pi-(?:bash|powershell|mcp|codemode)-[0-9a-f]{16}(?:\.[^/]*)?|prism-tmp-\d+-.+)$/;

/** Whether a file or folder of Prism's temporary folder belongs to the current session (set at session start). */
let ownTemp: ((name: string) => boolean) | undefined;

/**
 * sandbox.md § 9.5, test 6: a file of another session in the system's temporary folder, which the file tools
 * would read since it is outside the home folder: its full outputs, or the private /tmp of its commands.
 */
function otherSessionTemp(real: string): boolean {
	const tmp = realPath(tmpdir());
	if (real === tmp || !within(real, tmp)) return false;
	const name = relative(tmp, real).split(sep)[0]!;
	return PRISM_TEMP.test(name) && !ownTemp?.(name);
}

/** The real path a read-only file tool reaches outside what the agent may read, while reading is limited. */
function readOutside(abs: string, cwd: string): string | undefined {
	const settings = readSandboxSettings();
	if (settings.read.limit !== "project") return undefined;
	const real = realPath(abs);
	if (
		(isReadable(readSetFor(cwd, settings), real) && !otherSessionTemp(real)) ||
		prismResources().some((root) => within(real, root))
	) {
		return undefined;
	}
	return real;
}

/**
 * fork: the first path an MCP call passes outside what the agent may read,
 * among the string values of its arguments that are a whole absolute path, `~/…` or a `file://` URL, and that no
 * readable(…) rule allows. An aid, not a boundary: a server reads what it wants without being
 * given a path.
 */
function mcpReadOutside(input: unknown, cwd: string, allowed: (real: string) => boolean): string | undefined {
	for (const path of mcpPaths(input)) {
		const outside = readOutside(path, cwd);
		if (outside && !allowed(outside)) return outside;
	}
	return undefined;
}

/** The string values of an MCP call's arguments that are a whole absolute path, `~/…` or a `file://` URL. */
function mcpPaths(input: unknown): string[] {
	const strings: string[] = [];
	const visit = (value: unknown, depth: number) => {
		if (strings.length >= 64) return;
		if (typeof value === "string") strings.push(value.trim());
		else if (depth < 4 && value && typeof value === "object") {
			for (const item of Object.values(value)) visit(item, depth + 1);
		}
	};
	visit(input, 0);
	const paths: string[] = [];
	for (const text of strings) {
		let path: string | undefined;
		if (/^file:\/\//i.test(text)) {
			try {
				path = fileURLToPath(text);
			} catch {}
		} else if (text === "~" || text.startsWith("~/")) path = join(homedir(), text.slice(2));
		else if (isAbsolute(text) && !text.includes("\n")) path = text;
		if (path) paths.push(path);
	}
	return paths;
}

/** The paths of the readable(…) rules given for this session and this project: sandboxed commands read them too. */
const readableGrants = (session: readonly string[], cwd: string) =>
	[...session, ...readProjectGrants(cwd).allow]
		.map((raw) => parseRule(raw))
		.flatMap((rule) =>
			rule?.tool === READABLE && rule.pattern && !within(homedir(), rule.pattern) ? [rule.pattern] : [],
		);

/**
 * /settings › Readable files: a path the user adds, as its real path, or why it cannot be added. A hidden path
 * (keys, credentials) and a folder too wide (~, ~/.config) do not open this way (sandbox.md § 9.7).
 */
function parseReadable(text: string, cwd: string): string | Error {
	const typed = text.trim();
	const abs =
		typed === "~" ? homedir() : typed.startsWith("~/") ? join(homedir(), typed.slice(2)) : resolve(cwd, typed);
	if (!existsSync(abs)) return new Error(fill("{0} does not exist.", typed));
	const real = realPath(abs);
	if (!isReadable(readSetFor(cwd, readSandboxSettings(), [real]), real)) {
		return new Error(
			fill(
				"{0} cannot be opened here: it is a hidden path (keys, credentials), holds one, or is too wide (the home folder, ~/.config, ~/.local, ~/.cache). Remove a path you hid yourself from Hidden paths first; to read everything, set What the agent reads to all.",
				homeRelative(real),
			),
		);
	}
	return real;
}

/** sandbox.md § 9.8: what the model learns when the file tools may not read a path. */
const readOutsideRefusal = (path: string) =>
	`[Prism: ${homeRelative(path)} is outside what the agent may read (the project, the tools' resources and the folders the user allowed). This is intended, not a fault. Do not look for another copy or another way to it; ask the user, who can allow it when asked or in /settings, Readable files.]`;

// ---------------------------------------------------------------------------
// Decision engine
// ---------------------------------------------------------------------------

/** fork: the tools that start a language server (pi-lsp). */
const LSP_TOOLS = new Set(["lsp_diagnostics", "lsp_fix"]);

/** The tools the gate classifies itself, from their input. */
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

/**
 * fork: the rows of the policy table, in the order /perm shows
 * them. A call falls in one row or more; the strictest verdict applies.
 */
export const POLICY_ROWS = [
	"read",
	// fork: only while reading is limited to the project.
	"read-outside",
	"write-project",
	"write-outside",
	"process-safe",
	"process-other",
	"network",
	"computer",
	"privilege",
	"security-config",
	"undeclared",
] as const;
export type PolicyRow = (typeof POLICY_ROWS)[number];

/** allow: runs; ask: a question; danger: a question flagged dangerous, never "always"; block: refused. */
export type Verdict = "allow" | "ask" | "danger" | "block";
const STRICTNESS: Record<Verdict, number> = { allow: 0, ask: 1, danger: 2, block: 3 };

/**
 * fork: what a mode does with each row, before rules
 * . /perm draws its table from it, and the sandbox will compile it (§ 4).
 */
export function modePolicy(mode: Mode, row: PolicyRow): Verdict {
	// fork: security configuration belongs exclusively to the user, in every mode.
	if (row === "security-config") return "block";
	if (mode === "unrestricted") return "allow";
	switch (row) {
		case "read":
		case "process-safe":
			return "allow";
		case "write-project":
		case "process-other":
			return mode === "safe" ? "block" : mode === "ask" ? "ask" : "allow";
		case "write-outside":
		case "privilege":
			return mode === "safe" ? "block" : "danger";
		case "read-outside":
			return "ask";
		case "network":
			return mode === "broad" ? "allow" : "ask";
		// broad mode asks the first time too; "in this session" covers the rest.
		case "computer":
			return "ask";
		case "undeclared":
			return mode === "broad" ? "allow" : "block";
	}
	// fork: a row no table knows (a declaration that is not a list of
	// capabilities) is refused, not allowed.
	return "block";
}

/** What a call does, for the policy: its rows, the built-in danger detection and what the question says. */
interface CallProfile {
	rows: PolicyRow[];
	// fork: declared file writers follow the same configuration restriction as write/edit.
	configuration?: ReturnType<typeof configPathKind>;
	/** fork: see Decision.readOutside. */
	readOutside?: string;
	/** fork: an MCP server's tool, whose path arguments are checked. */
	mcp?: boolean;
	/** Detected danger: always a question (or a refusal in safe mode), never covered by an allow rule. */
	danger?: string;
	detail?: string;
	/** fork: why the call is refused whatever the mode or rules. */
	refused?: string;
	/** fork: write or edit in /tmp without the sandbox, which broad mode allows (decide). */
	scratch?: boolean;
}

/** The tool's declaration, as the session lists it (pi.getAllTools()). */
export type ToolDeclaration = Pick<ToolInfo, "permissions" | "namespace" | "annotations">;

const CAPABILITY_DETAIL: Record<Capability, string> = {
	none: "no effect",
	"fs.read": "reads files",
	"fs.write": "writes files",
	process: "runs a program",
	network: "network access",
	computer: "uses a browser or a desktop",
	privilege: "administrator rights",
	"security-config": "changes Prism's security settings",
};

/** A file tool's call, or a declared write with its path. */
function fileProfile(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	cfg: PermConfig,
	tmp?: string,
): CallProfile {
	const base = classifyFileTool(tool, input, cwd, cfg, tmp);
	const danger = base.tier === "danger" ? (base.detail ?? tool) : undefined;
	if (tool !== "write" && tool !== "edit") {
		// fork: write and edit outside the project already ask; their answer covers what they read.
		const outside = danger === undefined && base.abs ? readOutside(base.abs, cwd) : undefined;
		return outside
			? { rows: ["read-outside"], detail: "read outside the project", readOutside: outside }
			: { rows: ["read"], danger, detail: base.detail };
	}
	const abs = base.abs;
	const configuration = abs ? configPathKind(abs, cwd) : undefined;
	// fork: a link in the private /tmp that leads out of it is not followed, as in a command.
	const refused =
		abs && tmp && within(abs, tmp) && !realInTmp(abs, tmp)
			? `Refused: ${abs.replace(tmp, "/tmp")} is a link out of this session's /tmp, which commands cannot write through either.`
			: undefined;
	const row: PolicyRow =
		configuration === "security"
			? "security-config"
			: abs && ((insideProject(abs, cwd) && insideProject(realPath(abs), cwd)) || (tmp && realInTmp(abs, tmp)))
				? "write-project"
				: abs
					? "write-outside"
					: "write-project";
	return { rows: [row], danger, detail: base.detail, configuration, refused, scratch: base.scratch };
}

/** MCP tools: from the server's hints, read-only and closed-world tools only read. */
function mcpEffects(annotations: ToolInfo["annotations"]): Capability[] {
	const effects: Capability[] = [];
	if (annotations?.readOnlyHint !== true) effects.push("process");
	if (annotations?.openWorldHint !== false) effects.push("network");
	return effects.length > 0 ? effects : ["fs.read"];
}

function profileCall(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	cfg: PermConfig,
	declare: () => ToolDeclaration | undefined,
	tmp?: string,
): CallProfile {
	if (isShellCall(tool, input)) {
		const command = typeof input.command === "string" ? input.command : "";
		if (!command.trim()) return { rows: ["process-safe"] };
		const base = classifyBash(command, { cwd, cfg, tmp });
		return {
			rows: [base.tier === "allow" ? "process-safe" : "process-other"],
			danger: base.tier === "danger" ? (base.detail ?? tool) : undefined,
			detail: base.detail,
		};
	}
	if (FILE_TOOLS.has(tool)) return fileProfile(tool, input, cwd, cfg, tmp);
	if (tool === "powershell") return { rows: ["process-other"], detail: "powershell" };
	const declaration = declare();
	const mcp = declaration?.namespace?.name.startsWith("mcp__") === true || tool === "read_mcp_resource";
	const effects =
		declaredEffects(declaration?.permissions, input) ??
		// fork: an own entry only; `toString` is not a shipped tool.
		declaredEffects(
			Object.hasOwn(SHIPPED_TOOL_PERMISSIONS, tool) ? SHIPPED_TOOL_PERMISSIONS[tool] : undefined,
			input,
		) ??
		(declaration?.namespace?.name.startsWith("mcp__") ? mcpEffects(declaration.annotations) : undefined);
	if (!effects) return { rows: ["undeclared"], detail: "tool that declares no permissions" };
	const profile: CallProfile = { rows: [], ...(mcp ? { mcp } : {}) };
	const details: string[] = [];
	for (const effect of effects) {
		const { capability, path } = typeof effect === "string" ? { capability: effect, path: undefined } : effect;
		if (capability !== "none" && capability !== "fs.read") details.push(CAPABILITY_DETAIL[capability]);
		if (capability === "fs.write" && path) {
			const file = fileProfile("write", { path }, cwd, cfg, tmp);
			profile.rows.push(...file.rows);
			profile.danger ??= file.danger;
			profile.configuration ??= file.configuration;
			continue;
		}
		profile.rows.push(
			capability === "none" || capability === "fs.read"
				? "read"
				: capability === "fs.write"
					? "write-project"
					: capability === "process"
						? "process-other"
						: capability,
		);
	}
	if (profile.rows.length === 0) profile.rows.push("read");
	profile.detail = [...new Set(details)].join(", ") || undefined;
	// fork: a path an MCP call names is judged as `read` judges it, inside the
	// project too; one a tool that may write names is reserved as for `write`. A server reads or writes what it wants
	// without naming it: an aid, not a boundary (Q-L9), but a path given explicitly is checked.
	if (mcp) {
		for (const path of mcpPaths(input)) {
			const read = classifyFileTool("read", { path }, cwd, cfg);
			if (read.tier === "danger") profile.danger ??= read.detail ?? tool;
			if (declaration?.annotations?.readOnlyHint !== true) profile.configuration ??= configPathKind(path, cwd);
		}
	}
	return profile;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 14)}\n...[truncated]` : s;
}

/**
 * fork: what a question shows of its target. The question used the 300 characters
 * of the decision's target, so a long command's end, which the answer allows too, was never shown. Whole up to
 * 10 lines and 800 characters; beyond, its start and its end, with how much is left out between them, and the
 * question offers to read it in full before allowing it.
 * fork: the limit was 4000 characters, so a 60-line here-document filled
 * the terminal and pushed the choices below it: Enter, or the wheel that moves the selection, answered unseen.
 */
export function questionTarget(target: string): string {
	if (target.length <= 800 && target.split("\n").length <= 10) return target;
	let headEnd = Math.min(target.length, 480);
	let newline = -1;
	for (let line = 0; line < 6 && newline < headEnd; line++) {
		newline = target.indexOf("\n", newline + 1);
		if (newline < 0) break;
	}
	if (newline >= 0) headEnd = Math.min(headEnd, newline);
	let tailStart = Math.max(target.length - 240, headEnd);
	let back = target.length;
	for (let line = 0; line < 3 && back > tailStart; line++) back = target.lastIndexOf("\n", back - 1);
	tailStart = Math.max(tailStart, back + 1);
	const hidden = tailStart - headEnd;
	return `${target.slice(0, headEnd)}\n... [${hidden} characters not shown] ...\n${target.slice(tailStart)}`;
}

function targetOf(tool: string, input: Record<string, unknown>, cwd: string): string {
	if (isShellCall(tool, input)) return typeof input.command === "string" ? input.command : "";
	if (typeof input.path === "string") {
		const abs = toolPath(tool, input.path, cwd);
		const real = realPath(abs);
		return real === abs ? abs : `${abs} -> ${real}`;
	}
	try {
		return JSON.stringify(input);
	} catch {
		return "";
	}
}

/** Subcommands that run what the next word names: a script, a package's binary, a program. */
const RUNNERS = new Set(["run", "run-script", "exec", "x", "dlx"]);

function suggestRule(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	cfg: PermConfig,
	tmp?: string,
	allowRules: Rule[] = [],
): string | undefined {
	if (isShellCall(tool, input)) {
		const command = typeof input.command === "string" ? input.command : "";
		// fork: the part that needs the permission, not `cd x` or `S=…` before it, which allow
		// nothing more and would leave the next question unchanged.
		// fork: nor a part an allow rule already covers (`npm run test; node x`
		// with `bash(npm run*)` asked about npm).
		const own = allowRules.filter((rule) => rule.tool === tool && rule.pattern);
		const words = segmentNeedingRule(command, { cwd, cfg }, own, tool)?.words ?? [];
		const program = words.findIndex((word) => !ASSIGNMENT_RE.test(word.raw));
		const tokens = program < 0 ? [] : words.slice(program).map((word) => word.raw);
		const w0 = tokens[0];
		if (!w0) return undefined;
		const MULTI = new Set(["npm", "npx", "pnpm", "yarn", "git", "docker", "kubectl", "make", "cargo", "go"]);
		const prefix = MULTI.has(w0) && tokens[1] && !tokens[1].startsWith("-") ? `${w0} ${tokens[1]}` : w0;
		// fork: `npm run build` allows that script, not every one (`npm run*` was wider than shown).
		const runs = prefix !== w0 && RUNNERS.has(tokens[1] ?? "") && tokens[2] && !tokens[2].startsWith("-");
		if (runs) return `${tool}(${prefix} ${tokens[2]}*)`;
		return `${tool}(${prefix}*)`;
	}
	if (tool === "write" || tool === "edit") {
		if (typeof input.path !== "string" || !input.path) return undefined;
		// fork: the private /tmp changes with each session, so the rule names /tmp. It allows
		// nothing more without the sandbox, where a write to the real /tmp stays a dangerous question.
		if (tmp && realInTmp(toolPath(tool, input.path, cwd), tmp)) return `${tool}(/tmp/**)`;
		// The real target's folder: allow rules match the real target only.
		const real = realPath(toolPath(tool, input.path, cwd));
		return `${tool}(${dirname(real)}/**)`;
	}
	return tool; // whole tool
}

/** Session rules and the time-limited permissions still running. */
function sessionRules(state: SessionState, now: number): { allow: string[]; deny: string[] } {
	const live = state.timed.filter((grant) => grant.until > now);
	return {
		allow: [...state.allow, ...live.filter((g) => g.effect === "allow").map((g) => g.rule)],
		deny: [...state.deny, ...live.filter((g) => g.effect === "deny").map((g) => g.rule)],
	};
}

function decide(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	trusted: boolean,
	state: SessionState,
	/** Read only for the tools the gate does not classify itself. */
	declare: () => ToolDeclaration | undefined = () => undefined,
	now = Date.now(),
	/** fork: the session's private /tmp, with the sandbox on. */
	tmp?: string,
): Decision {
	const cfg = loadConfig(cwd, trusted);
	const targets = toolTargets(tool, input, cwd);
	const target = truncate(publicTmp(targetOf(tool, input, cwd), tmp), 300);
	// fork: rules that cannot be known refuse everything, in every mode.
	const fileProblem = permissionsFileProblem(cwd, trusted);
	if (fileProblem) {
		return {
			effect: "block",
			reason: `${fileProblem} Do not retry or work around it; tell the user, who must fix the file.`,
			tier: "danger",
			target,
		};
	}
	const session = sessionRules(state, now);

	const withEffect = (raw: string[], effect: Rule["effect"]): Rule[] =>
		raw
			.map((r) => parseRule(r))
			.filter((r): r is Rule => r !== undefined)
			.map((r) => ({ ...r, effect }));

	// fork: the rules given or refused for this project, kept in Prism's folder,
	// count like saved ones.
	const project = readProjectGrants(cwd);
	const denyRules = [
		...withEffect(session.deny, "deny"),
		...withEffect(cfg.deny ?? [], "deny"),
		...withEffect(project.deny, "deny"),
	];
	const allowRules = [
		...withEffect(session.allow, "allow"),
		...withEffect(cfg.allow ?? [], "allow"),
		...withEffect(project.allow, "allow"),
	];
	const askRules = withEffect(cfg.ask ?? [], "ask");

	// 1. Deny rules (session, time-limited, config): highest priority, in every mode.
	const denied = denyRules.find((r) => ruleMatches(r, tool, targets));
	if (denied) {
		return { effect: "block", reason: `Denied by rule "${denied.label}"`, tier: "danger", target };
	}
	if (cfg.tools?.[tool] === "deny") {
		return {
			effect: "block",
			reason: `Tool "${tool}" is denied by the permissions config`,
			tier: "danger",
			target,
		};
	}

	// fork: neither rules, a task scope nor unrestricted mode bypass configuration guards.
	const configKind =
		(tool === "write" || tool === "edit") && typeof input.path === "string"
			? configPathKind(toolPath(tool, input.path, cwd), cwd)
			: isShellCall(tool, input) && typeof input.command === "string"
				? shellConfigWrite(input.command, cwd)
				: undefined;
	if (configKind) {
		const command = typeof input.command === "string" ? input.command : "";
		const reading =
			configKind === "security" &&
			/^\s*(?:less|more)\s/.test(command) &&
			!/[;&|<>\n]/.test(command) &&
			!unseenCodeReason(command) &&
			classifyWords(unwrapSegment(shellSegments(command)[0]?.words ?? []).words, { cwd, cfg }, 0).tier === "allow";
		return {
			effect: "block",
			reason: reading ? "Reading a Prism config or credential file is refused." : configWriteRefusal(configKind),
			tier: "danger",
			target,
		};
	}
	if (tool === "configure_prism") {
		return state.mode === "safe"
			? { effect: "block", reason: "Configuration changes are refused in safe mode.", tier: "danger", target }
			: { effect: "allow", reason: "Configuration tool requires its own confirmation", tier: "allow", target };
	}
	let profile = profileCall(tool, input, cwd, cfg, declare, tmp);
	if (profile.refused) return { effect: "block", reason: profile.refused, tier: "danger", target };
	if (profile.configuration)
		return { effect: "block", reason: configWriteRefusal(profile.configuration), tier: "danger", target };
	if (profile.rows.includes("security-config"))
		return { effect: "block", reason: configWriteRefusal("security"), tier: "danger", target };
	// D11: remembering a password never replaces approval, even in unrestricted mode.
	if (tool === "sudo")
		return {
			effect: state.mode === "safe" ? "block" : "prompt",
			reason: "Run as root, outside the sandbox?",
			tier: "danger",
			target,
		};

	// 2. Unrestricted mode: ordinary calls skip questions; configuration stays guarded above.
	if (state.mode === "unrestricted") {
		return { effect: "allow", reason: "unrestricted mode", tier: "allow", target };
	}

	// 3. The policy table: the strictest verdict of the call's rows.
	// fork: Plan mode promises that the project does not change before the plan is
	// approved, so while it is on, broad mode asks as ask mode does for what runs a program or writes in the project
	// (`git status` in a repository whose configuration runs a program, for one).
	const planning = state.mode === "broad" && planBridge()?.enabled?.() === true;
	// fork: broad mode writes /tmp with the file tools as its commands already do, without asking;
	// ask and safe keep the question and the refusal of a write outside the project, and Plan mode keeps asking.
	if (state.mode === "broad" && !planning && profile.scratch)
		profile = { ...profile, rows: ["write-project"], danger: undefined };
	const verdict = profile.rows
		.map((row) =>
			modePolicy(planning && (row === "process-other" || row === "write-project") ? "ask" : state.mode, row),
		)
		.reduce<Verdict>((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a), "allow");
	const suggestedRule = suggestRule(tool, input, cwd, cfg, tmp, allowRules);
	const blocked = (): Decision =>
		profile.rows.includes("undeclared") && verdict === modePolicy(state.mode, "undeclared")
			? {
					effect: "block",
					reason: `Blocked: the tool "${tool}" declares no permissions, so ${state.mode} mode refuses it; the user can allow it with /perm`,
					tier: "ask",
					target,
					undeclared: true,
				}
			: {
					effect: "block",
					reason: `Blocked by safe mode: this action requires permission (${profile.danger ?? profile.detail ?? tool}).`,
					tier: "ask",
					target,
				};

	// 4. Detected danger and security settings: a question no allow rule skips, refused where
	//    the mode refuses the action itself (safe).
	if (profile.danger !== undefined || verdict === "danger") {
		if (verdict === "block") return blocked();
		return {
			effect: "prompt",
			reason: `This action may be dangerous: ${profile.danger ?? profile.detail ?? tool}`,
			tier: "danger",
			target,
			suggestedRule,
		};
	}

	// fork: a folder or file the user let the agent read, for every read-only file tool.
	const outside = profile.readOutside;
	if (outside) {
		// A rule for the home folder or above it, written by hand, opens nothing (Q-L12).
		const readable = allowRules.find(
			(r) => r.tool === READABLE && r.pattern && within(outside, r.pattern) && !within(homedir(), r.pattern),
		);
		if (readable) {
			return { effect: "allow", reason: `Allowed by rule "${readable.label}"`, tier: "allow", target, byRule: true };
		}
	}

	// fork: an MCP call's path outside what the agent may read asks as a file tool does, before the
	// rules that allow the tool; credentials keep their dangerous question, and the mode's refusal wins.
	const mcpOutside = profile.mcp
		? mcpReadOutside(input, cwd, (real) =>
				allowRules.some(
					(r) =>
						r.tool === READABLE &&
						r.pattern !== undefined &&
						within(real, r.pattern) &&
						!within(homedir(), r.pattern),
				),
			)
		: undefined;
	if (mcpOutside) {
		if (verdict === "block") return blocked();
		const credentials = classifyFileTool("read", { path: mcpOutside }, cwd, cfg);
		if (credentials.tier === "danger") {
			return {
				effect: "prompt",
				reason: `This action may be dangerous: ${credentials.detail ?? tool}`,
				tier: "danger",
				target,
				suggestedRule,
			};
		}
		return {
			effect: "prompt",
			reason: `This action needs your permission: ${[profile.detail, "read outside the project"].filter(Boolean).join(", ")}`,
			tier: "ask",
			target,
			suggestedRule: readableRule(isDirectory(mcpOutside) ? mcpOutside : dirname(mcpOutside)),
			readOutside: mcpOutside,
		};
	}

	// 5. Allow rules (session, time-limited, config).
	const allowed = isShellCall(tool, input)
		? shellAllowRule(allowRules, tool, typeof input.command === "string" ? input.command : "", { cwd, cfg })
		: allowRules.find((r) => ruleMatches(r, tool, toolTargets(tool, input, cwd, true)));
	if (allowed) {
		return { effect: "allow", reason: `Allowed by rule "${allowed.label}"`, tier: "allow", target, byRule: true };
	}
	if (cfg.tools?.[tool] === "allow" && !isDesktopLaunch(tool, input)) {
		return { effect: "allow", reason: `Tool "${tool}" allowed by config`, tier: "allow", target, byRule: true };
	}

	// 6. The mode's verdict; explicit ask rules and the tool config can turn an allowed call into a question.
	//    Broad mode skips them.
	const forcedAsk =
		state.mode === "broad"
			? undefined
			: (askRules.find((r) => ruleMatches(r, tool, targets))?.label ??
				(cfg.tools?.[tool] === "ask" ? tool : undefined));
	if (verdict === "block" && !(forcedAsk && profile.rows.includes("undeclared"))) return blocked();
	if (verdict === "ask") {
		// fork: the part the question is about, not one a rule already allows.
		const detail =
			(isShellCall(tool, input) && typeof input.command === "string"
				? uncoveredDetail(input.command, allowRules, tool, { cwd, cfg })
				: undefined) ?? profile.detail;
		return {
			effect: "prompt",
			reason: detail ? `This action needs your permission: ${detail}` : "This action needs your permission.",
			tier: "ask",
			target,
			// The folder, so that a task refuses the rest of it at once (sandbox.md § 9.11, test 9).
			suggestedRule: outside ? readableRule(isDirectory(outside) ? outside : dirname(outside)) : suggestedRule,
			...(outside ? { readOutside: outside } : {}),
		};
	}
	if (forcedAsk) {
		return {
			effect: "prompt",
			reason:
				cfg.tools?.[tool] === "ask" && forcedAsk === tool
					? `tool "${tool}" is set to "ask" in the permissions config`
					: `matches ask rule "${forcedAsk}"`,
			tier: "ask",
			target,
			suggestedRule,
		};
	}

	return { effect: "allow", reason: state.mode === "broad" ? "broad mode" : "auto-allowed", tier: "allow", target };
}

/** For tests: the gate's decision for one call, in a mode and with session rules, outside a trusted project. */
export function decidePermission(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	session: { mode: Mode; allow?: string[]; deny?: string[]; timed?: TimedPermission[] },
	options: { declaration?: ToolDeclaration; now?: number } = {},
): Pick<Decision, "effect" | "reason" | "tier"> {
	const { effect, reason, tier } = decide(
		tool,
		input,
		cwd,
		false,
		{ mode: session.mode, allow: session.allow ?? [], deny: session.deny ?? [], timed: session.timed ?? [] },
		() => options.declaration,
		options.now,
	);
	return { effect, reason, tier };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * fork: what a rule lets the agent do, in words, for the permission
 * question: `bash(npm test*)` is "run npm test", `edit(<project>/**)` is "change the project's files".
 */
function ruleIntent(rule: string, cwd: string): string {
	const parsed = parseRule(rule);
	const pattern = parsed?.pattern?.replace(/\*$/, "").trim();
	if (!parsed) return rule;
	if (parsed.tool === READABLE && parsed.pattern) return fill("read {0}", homeRelative(parsed.pattern));
	if (pattern && (parsed.tool === "bash" || parsed.tool === "background")) return fill("run {0}", pattern);
	if (parsed.pattern && (parsed.tool === "write" || parsed.tool === "edit")) {
		const root = realPath(cwd);
		if (parsed.pattern === `${root}/**` || parsed.pattern === `${cwd}/**`) return t("change the project's files");
		const inside = parsed.pattern.startsWith(`${root}/`) ? parsed.pattern.slice(root.length + 1) : parsed.pattern;
		return fill("change {0}", inside);
	}
	return parsed.pattern ? rule : fill("use the {0} tool", parsed.tool);
}

/** fork: whether a rule allows a shell command: each part matches it or needs no permission. */
function commandMatches(rule: string, command: string, cwd: string, cfg: PermConfig): boolean {
	const parsed = parseRule(rule);
	if (!parsed) return false;
	return shellAllowRule([{ ...parsed, effect: "allow" }], parsed.tool, command, { cwd, cfg }) !== undefined;
}

/**
 * fork: the rule a network answer "in this project" is kept for: the one the command's permission
 * question would suggest, when it allows the command itself (not with `$(…)`, for one).
 */
function networkRule(command: string, cwd: string, cfg: PermConfig): string | undefined {
	const rule = suggestRule("bash", { command }, cwd, cfg);
	return rule && commandMatches(rule, command, cwd, cfg) ? rule : undefined;
}

const parsedRules = (raw: string[]): Rule[] =>
	raw.map((rule) => parseRule(rule)).filter((rule): rule is Rule => rule !== undefined);

/**
 * fork: the rules a scope's operation stands for: a command prefix allows that command in
 * the foreground and in the background, a path allows writing and editing it (a write outside the project
 * is dangerous, which a scope never covers). `*` (only from the user's own presets) is any command run in
 * the sandbox: with the sandbox off, it covers nothing.
 */
export function operationRules(operation: ScopeOperation, sandboxed: boolean): Rule[] {
	const raw = [
		...operation.commands.flatMap((command) => {
			if (command === "*" && !sandboxed) return [];
			const pattern = command === "*" ? "*" : `${command}*`;
			return [`bash(${pattern})`, `background(${pattern})`];
		}),
		...operation.writes.flatMap((glob) => [`write(${glob})`, `edit(${glob})`]),
	];
	return parsedRules(raw);
}

/** The entry whose rule covers a call: a shell command segment by segment, any other tool by its targets. */
function coveringEntry<T extends { rule: Rule }>(
	entries: T[],
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	cfg: PermConfig,
): T | undefined {
	const rules = entries.map((entry) => entry.rule);
	const matched = isShellCall(tool, input)
		? shellAllowRule(rules, tool, typeof input.command === "string" ? input.command : "", { cwd, cfg })
		: rules.find((rule) => ruleMatches(rule, tool, toolTargets(tool, input, cwd, true)));
	return matched ? entries.find((entry) => entry.rule === matched) : undefined;
}

/** The intention of the scope's line that covers a call; rules added by "for this task" are a line each. */
function scopeCovers(
	scope: TaskScope,
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	cfg: PermConfig,
	sandboxed: boolean,
): string | undefined {
	const entries = [
		...scope.operations.flatMap((operation) =>
			operationRules(operation, sandboxed).map((rule) => ({ rule, what: operation.what })),
		),
		...parsedRules(scope.rules).map((rule) => ({ rule, what: ruleIntent(rule.label, cwd) })),
	];
	return coveringEntry(entries, tool, input, cwd, cfg)?.what;
}

/** Whether a call falls under a rule refused earlier in the task. */
function scopeRefused(
	scope: TaskScope,
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	cfg: PermConfig,
): boolean {
	const refused = [...scope.refused].filter((key) => key.startsWith("rule ")).map((key) => key.slice(5));
	return (
		coveringEntry(
			parsedRules(refused).map((rule) => ({ rule })),
			tool,
			input,
			cwd,
			cfg,
		) !== undefined
	);
}

/** Whether a scope gives `host` to `command`: an operation's hosts go to its own commands, or to any. */
function scopeHasHost(scope: TaskScope, host: string, command: string, cwd: string, cfg: PermConfig): boolean {
	const matches = (rules: string[]) => rules.some((rule) => commandMatches(rule, command, cwd, cfg));
	return (
		scope.operations.some(
			(operation) =>
				matchesHost(host, operation.hosts) &&
				(operation.commands.length === 0 ||
					matches(operation.commands.map((prefix) => (prefix === "*" ? "bash(*)" : `bash(${prefix}*)`)))),
		) || scope.hostGrants.some((grant) => matchesHost(host, [grant.host]) && matches([grant.rule]))
	);
}

/** A rule as /perm lists it: `bash(npm test*)` is "Run npm test", `write(src/**)` is "Change src/**". */
function describeRule(rule: string, effect: "allow" | "deny"): string {
	const parsed = parseRule(rule);
	const pattern = parsed?.pattern?.replace(/\*$/, "").trim();
	const what =
		parsed && pattern && (parsed.tool === "bash" || parsed.tool === "background")
			? fill("Run {0}", pattern)
			: parsed?.pattern && (parsed.tool === "write" || parsed.tool === "edit")
				? fill("Change {0}", parsed.pattern)
				: rule;
	return effect === "deny" ? fill("Block: {0}", what) : what;
}

/**
 * fork: turns the sandbox on or off for the session, by mode and settings. Returns why it cannot
 * run; the session then keeps a broken sandbox, so commands fail instead of running outside it.
 */
/** fork: the latest sandbox asked for each session; an older start is not published. */
const sandboxRequests = new WeakMap<object, number>();

async function applySandbox(
	ctx: ExtensionContext,
	mode: Mode,
	policy: HostPolicy,
	readable: () => string[],
): Promise<string | undefined> {
	const request = (sandboxRequests.get(ctx.sessionManager) ?? 0) + 1;
	sandboxRequests.set(ctx.sessionManager, request);
	let settings: SandboxSettings;
	try {
		settings = readSandboxSettings();
	} catch (error) {
		// rules that cannot be known block the commands, in every mode.
		if (!(error instanceof SandboxSettingsError)) throw error;
		setSessionSandbox(ctx.sessionManager, { error: error.message });
		return error.message;
	}
	if (!sandboxedMode(settings, mode)) {
		setSessionSandbox(ctx.sessionManager, undefined);
		return undefined;
	}
	// Namespace startup yields: commands must not run outside the sandbox while it is being prepared.
	setSessionSandbox(ctx.sessionManager, { error: "the sandbox is starting." });
	const sandbox = await startSandbox(
		settings,
		ctx.cwd,
		policy,
		sessionTmpDir(ctx.sessionManager.getSessionId()),
		readable,
	);
	// A newer request (another mode chosen meanwhile) decides the session's sandbox.
	if (sandboxRequests.get(ctx.sessionManager) !== request) return undefined;
	if (!("error" in sandbox)) {
		// fork: safe mode changes no file, whatever the classifier lets through.
		sandbox.readOnlyProject = mode === "safe";
		sandbox.askHooks = (question) => askHooksPath(ctx, question);
		sandbox.askGitConfig = (question) => askGitConfig(ctx, question);
	}
	setSessionSandbox(ctx.sessionManager, sandbox);
	// fork: Git work a stop or crash left, said once, without blocking anything.
	if (sandbox.gitReport) {
		if (ctx.hasUI) ctx.ui.notify(sandbox.gitReport, "warning");
		else process.stderr.write(`${sandbox.gitReport}\n`);
	}
	// fork: commands that do not share localhost, said rather than silent.
	if ("netReport" in sandbox && sandbox.netReport) {
		if (ctx.hasUI) ctx.ui.notify(sandbox.netReport, "warning");
		else process.stderr.write(`${sandbox.netReport}\n`);
	}
	return "error" in sandbox ? sandbox.error : undefined;
}

/**
 * fork: asks whether a sandboxed command's change to Git's hooks folder may be
 * applied, with the folder, the hooks in it and the risk. Undefined when nobody answers.
 */
async function askHooksPath(ctx: ExtensionContext, question: HooksQuestion): Promise<boolean | undefined> {
	if (!ctx.hasUI) return undefined;
	// fork: values a sandboxed command wrote show their controls.
	const { change, hooks } = question;
	const folder = visibleText(question.folder);
	const scripts = question.scripts === undefined ? undefined : visibleText(question.scripts);
	const text = [
		fill("A command changed the Git hooks folder of {0}:", visibleText(question.repository)),
		`core.hooksPath: ${change.before === undefined ? t("(unset)") : visibleText(change.before)} → ${change.after === undefined ? t("(unset)") : visibleText(change.after)}`,
		fill("Git would run hooks from {0}", folder),
		hooks.length > 0 ? fill("Hooks there now: {0}", visibleText(hooks.join(", "))) : t("No hooks there yet."),
		...(scripts ? [fill("These hooks run the scripts of {0}, with node_modules/.bin first in PATH.", scripts)] : []),
		"",
		t("Risk: Git outside Prism (your terminal, your editor) runs these hooks without the sandbox, with your rights."),
		scripts
			? fill("Sandboxed commands still cannot change {0} or {1}.", folder, scripts)
			: fill("Sandboxed commands still cannot change {0}.", folder),
		t("What the hooks call (npm scripts, node_modules, other project files) stays writable by sandboxed commands."),
	].join("\n");
	const apply = t("Apply this hooks folder");
	const choice = await ctx.ui.select(text, [apply, t("Do not apply it")], { timeout: PROMPT_TIMEOUT_MS });
	return choice === undefined ? undefined : choice === apply;
}

/**
 * fork: asks whether a sandboxed command's changes to a repository's remotes or to
 * the identity of its commits may be applied, with each value before and after and what it does outside Prism.
 * Undefined when nobody answers; the changes are then kept aside, not applied.
 */
async function askGitConfig(ctx: ExtensionContext, question: GitConfigQuestion): Promise<boolean | undefined> {
	if (!ctx.hasUI) return undefined;
	// fork: keys and values a sandboxed command wrote show their controls.
	const shown = (values: string[]) => (values.length === 0 ? t("(unset)") : visibleText(values.join(", ")));
	const remotes = question.changes.some(({ key }) => key.startsWith("remote."));
	const identity = question.changes.some(({ key }) => key.startsWith("user."));
	const text = [
		fill("A command changed the Git configuration of {0}:", visibleText(question.repository)),
		...question.changes.map(({ key, before, after }) => `${visibleText(key)}: ${shown(before)} → ${shown(after)}`),
		"",
		...(remotes
			? [
					t(
						"Risk: Git outside Prism (your terminal, your editor) uses these remotes with your credentials, without the sandbox: a later git push sends your code there, and a forced or deleting refspec overwrites or removes branches on the server.",
					),
				]
			: []),
		...(identity ? [t("Your next commits outside Prism will carry this name or e-mail address.")] : []),
	].join("\n");
	const apply = t("Apply these Git changes");
	const choice = await ctx.ui.select(text, [apply, t("Do not apply them")], { timeout: PROMPT_TIMEOUT_MS });
	return choice === undefined ? undefined : choice === apply;
}

/**
 * fork: asks whether sandboxed commands may reach a host. The question says it
 * can be turned off. Without an interface, the host is refused.
 * fork: it names the command asking, and an answer for this command lasts until it ends.
 */
async function askHost(
	ctx: ExtensionContext,
	host: string,
	command: NetworkCommand,
	scope: TaskScope | undefined,
	/** The browser tool's question: called with the user's wider answer (a site or every site, for the request or the session). */
	browserGrant?: (grant: BrowserGrant) => void,
): Promise<HostAnswer> {
	// fork: in a task scope, one refusal holds for the whole task, and nothing outside the scope
	// waits for an answer while the user is away.
	const refusal = `host ${host.toLowerCase()}`;
	const what = fill("Connect to {0}", host);
	if (scope?.refused.has(refusal)) {
		scope.blocked.push({ what, why: "again" });
		return "scope";
	}
	if (scope?.away) {
		scope.refused.add(refusal);
		scope.blocked.push({ what, why: "away" });
		return "scope";
	}
	const answer = await askHostOnce(ctx, host, command, scope, browserGrant);
	if (scope && (answer === "deny" || answer === "unanswered")) {
		scope.refused.add(refusal);
		scope.blocked.push({ what, why: answer === "deny" ? "user" : "unanswered" });
	}
	return answer;
}

/**
 * The browser question's answers beyond one call: "this time" asked again at each
 * action on the same site, and refusing "every site" meant a question per action of a web search. A site, or every
 * site, for the request (until the agent finishes answering the user's message) sits between the two.
 */
type BrowserGrant = "site-request" | "every-request" | "every-session";

async function askHostOnce(
	ctx: ExtensionContext,
	host: string,
	command: NetworkCommand,
	scope: TaskScope | undefined,
	browserGrant?: (grant: BrowserGrant) => void,
): Promise<HostAnswer> {
	// Nobody to ask: refused, but not by the user.
	if (!ctx.hasUI) return "unanswered";
	// fork: kept for the project, a host is given to the commands of one rule, not to every command.
	const rule = networkRule(command.command, ctx.cwd, loadConfig(ctx.cwd, ctx.isProjectTrusted()));
	// fork.12 security audit: the command's words show their terminal controls, in the options too.
	const intent = rule ? visibleText(ruleIntent(rule, ctx.cwd)) : undefined;
	// fork: the browser's question offers every site for the session,
	// never a port of this machine, and says in red what a page reaches without another question.
	// fork: nor a name at a private address.
	const lan = privateAddressOf(host);
	const browser = browserGrant !== undefined && localPortOf(host) === undefined && lan === undefined;
	const options: [HostAnswer | BrowserGrant, string][] = [
		browser
			? ["site-request", fill("Allow {0} for this request", host)]
			: ["command", fill("Allow {0} for this command", host)],
		// fork: widens the task scope, to the commands of the same rule.
		...(scope && rule
			? [["task", fill('Allow {0} for "{1}" for this task', host, intent ?? "")] as [HostAnswer, string]]
			: []),
		["session", fill("Allow {0} in this session", host)],
		...(browser
			? [
					["every-request", t("Allow every site for this request (browser only)")] as [BrowserGrant, string],
					["every-session", t("Allow every site in this session (browser only)")] as [BrowserGrant, string],
				]
			: []),
		// fork: for every project, it is in /settings › Allowed hosts.
		...(rule
			? [["project", fill('Allow {0} for "{1}" in this project', host, intent ?? "")] as [HostAnswer, string]]
			: []),
		["deny", scope ? fill("Block {0} for this task", host) : t("Block for this command")],
	];
	const firstLine = command.command.trim().split("\n")[0] ?? "";
	const shown = visibleText(firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine);
	const question = [
		fill("The command {0} wants to connect to {1}", shown, host),
		// fork: a service of this machine opens alone, never the others.
		...(localPortOf(host) === undefined
			? []
			: [t("This is a service of this machine: only this port opens, by any of its addresses.")]),
		// fork: a name the user allowed leads to a private network.
		...(lan === undefined
			? []
			: [
					fill(
						"{0} leads to {1}, on your local or private network (a router, a VPN such as Tailscale, a cloud metadata service): allowing it opens this name there only, not at another address.",
						lan.host,
						lan.addresses.join(", "),
					),
				]),
		// fork: Prism runs ssh, with the user's keys, for Git's fetch and push alone.
		...(gitSshHostOf(host) === undefined
			? []
			: [
					t(
						"This is Git over SSH, with your SSH keys: only Git's fetch and push to this host pass, no other command.",
					),
				]),
		"",
		browser
			? t("The agent opens it in your own browser, where you are signed in to your sites.")
			: t("Sandboxed commands reach only the hosts you allow."),
		t(
			'These questions can be turned off: "sandbox": { "network": { "askNewHosts": false } } in settings.json. Hosts in "deny" stay blocked.',
		),
	].join("\n");
	const warning = browser
		? t(
				"Once a page is open, its links and the scripts the agent runs in it reach other sites without another question.",
			)
		: undefined;
	let failure = "";
	for (;;) {
		// fork: an interruption closes the question, in every client.
		const choice = await ctx.ui.select(
			`${failure}${question}`,
			options.map(([, label]) => label),
			{ timeout: PROMPT_TIMEOUT_MS, signal: ctx.signal, ...(warning ? { warning } : {}) },
		);
		// No answer in time is not a refusal by the user: the command's result tells the model which.
		if (choice === undefined) return "unanswered";
		const chosen = options.find(([, label]) => label === choice)?.[0] ?? "deny";
		// This site for this call; the next calls pass by the browser's grant (TOOL_NETWORK_EVENT).
		const wider = chosen === "site-request" || chosen === "every-request" || chosen === "every-session";
		if (wider) browserGrant?.(chosen);
		const answer: HostAnswer = wider ? "command" : chosen;
		if (answer === "task" && scope && rule) scope.hostGrants.push({ host, rule });
		if (answer !== "project" || !rule) return answer;
		const saved = await saveForProject(async () => await addProjectHost(ctx.cwd, { host, rule }));
		if (saved === true) return answer;
		failure = saved;
	}
}

/**
 * fork: keeps a permission for the project; on failure, the line that tells the user and asks again,
 * since nothing was allowed: the choice never turns into a narrower or wider one.
 */
async function saveForProject(save: () => Promise<void>): Promise<true | string> {
	try {
		await save();
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `${fill("Could not keep it for this project: {0}", message)}\n${t("Nothing was allowed. Choose again.")}\n\n`;
	}
}

/**
 * fork: what the user is told about a sandbox that does not work. Prism
 * keeps running, chat and settings included; only the commands that need the sandbox are blocked.
 */
const brokenSandboxMessage = (mode: Mode, failure: string, hasUI: boolean) =>
	failure.startsWith(SANDBOX_SETTINGS_ERROR_START)
		? t(failure)
		: failure === HOME_FOLDER_BLOCKED
			? // fork (audit FIN-15): two short lines and one action, not an 80-word paragraph, on a first try from ~.
				[
					t("Prism was opened in your home folder: shell commands stay blocked here."),
					t("Open Prism in a project folder (cd into it first). Details: /docs sandbox."),
				].join("\n")
			: [
					fill("The sandbox is on for {0} mode but does not work: {1}", t(mode), t(failure)),
					t("Shell commands stay blocked until it works; nothing runs outside it."),
					hasUI
						? t(
								"Once it is fixed, choose Check the sandbox again in /sandbox. To go without it in this mode, turn it off there, under In modes.",
							)
						: fill(
								'To go without it, turn it off for this mode in settings.json ("sandbox": { "modes": { "{0}": false } }) or choose another mode with --perm-mode.',
								mode,
							),
				].join(" ");

const SETTINGS_OWNER = "permissions";

export default function (pi: ExtensionAPI) {
	let state: SessionState = { mode: "ask", allow: [], deny: [], timed: [] };
	// fork.9 (SEC-03): MCP results marked as external, and a changed MCP tool asks before the gate decides.
	mcpTrust(pi, () => state.mode);
	/** fork: what the user let the agent read, for the session's sandbox, read before each command. */
	const granted = (ctx: ExtensionContext) => () => readableGrants(state.allow, ctx.cwd);
	/** Tools whose refusal for want of a declaration the user was told about, once per session. */
	const warnedUndeclared = new Set<string>();
	const warnedStaleConfig = new Set<string>();
	/**
	 * fork: dangerous calls the user allowed "in this session", by tool and whole target.
	 * Never saved: a resumed or new session asks again. The value is how /perm shows it.
	 */
	const dangerAllowed = new Map<string, string>();
	/**
	 * fork: the user answered the browser's host question with "every
	 * site in this session". Never saved, shown in /perm, taken back there; ports of this machine and blocked hosts
	 * keep their own answer.
	 */
	let browserEverySite = false;
	/** The browser's answers for the request: forgotten when the agent finishes answering. */
	const browserRequestSites = new Set<string>();
	let browserRequestEverySite = false;
	/** fork: calls whose path the gate moved into the private /tmp, by id, with that folder. */
	const scratchCalls = new Map<string, string>();
	/** fork: this session's section of /settings. */
	let settingsSection: SettingsSection | undefined;
	// fork: the sandbox's network answers last for the session, across mode changes.
	let networkCtx: ExtensionContext | undefined;
	/**
	 * fork: the folder and trust the network answers are read for. A background task
	 * outlives its session on purpose, and the session's ctx throws once it is replaced or reloaded: from then on,
	 * the values it had at its end, with nobody to ask.
	 */
	let closedPlace: { cwd: string; trusted: boolean } | undefined;
	const networkPlace = () =>
		networkCtx ? { cwd: networkCtx.cwd, trusted: networkCtx.isProjectTrusted() } : closedPlace;
	const hostPolicy = new HostPolicy(
		// fork.9 (CAP-01): an unattended scheduled run reaches only its scope's hosts. No setting widens it: not
		// "askNewHosts": false, not the global allow list, not the hosts kept for the project. Blocked hosts stay so.
		() => {
			const network = readSandboxSettings().network;
			return scheduledId ? { ...network, askNewHosts: true, allow: [] } : network;
		},
		(host, command) =>
			networkCtx
				? askHost(
						networkCtx,
						host,
						command,
						liveScope(),
						command.browser
							? (grant) => {
									if (grant === "every-session") browserEverySite = true;
									else if (grant === "every-request") browserRequestEverySite = true;
									else browserRequestSites.add(host.toLowerCase());
								}
							: undefined,
					)
				: Promise.resolve("unanswered"),
		// fork: a host given for this project, to the commands of its rule; or by the task scope, which a
		// background task started under it keeps until the scope's time is up.
		(host, command) => {
			const place = networkPlace();
			if (!place) return false;
			const { cwd } = place;
			const cfg = loadConfig(cwd, place.trusted);
			const held = command.toolCallId === undefined ? undefined : heldScopes.get(command.toolCallId);
			const scope = liveScope() ?? (held && held.until > Date.now() ? held : undefined);
			if (scope && scopeHasHost(scope, host, command.command, cwd, cfg)) return true;
			if (scheduledId) return false;
			const grants = readProjectGrants(cwd).hosts.filter((grant) => matchesHost(host, [grant.host]));
			return grants.some((grant) => commandMatches(grant.rule, command.command, cwd, cfg));
		},
		undefined,
		// fork: the hosts above, so the relay serves the ports of this machine among them.
		() => {
			const place = networkPlace();
			if (!place) return [];
			const scopes = [liveScope(), ...heldScopes.values()].filter((held) => held !== undefined);
			return [
				...(scheduledId ? [] : readProjectGrants(place.cwd).hosts.map((grant) => grant.host)),
				...scopes.flatMap((held) => [
					...held.operations.flatMap((operation) => operation.hosts),
					...held.hostGrants.map((grant) => grant.host),
				]),
			];
		},
		(approved, command) => {
			const place = networkPlace();
			if (!place) return false;
			const cfg = loadConfig(place.cwd, place.trusted);
			const rule = networkRule(approved, place.cwd, cfg);
			return rule ? commandMatches(rule, command, place.cwd, cfg) : approved === command;
		},
	);
	/** fork: the approved task scope, while its task runs and its time lasts. */
	let scope: TaskScope | undefined;
	/** fork.9 (CAP-01): the scheduled task this unattended run carries out, from `--scheduled`. */
	let scheduledId: string | undefined;
	/** Background commands started under a scope: they keep its network until its time is up. */
	const heldScopes = new Map<string, TaskScope>();
	const liveScope = (): TaskScope | undefined => (scope && scope.until > Date.now() ? scope : undefined);
	/**
	 * Ends the scope: its hosts lose their open connections; the user reads what it refused. Background tasks
	 * keep it until its time is up, unless the user ends it (`revoke`).
	 */
	const endScope = (ctx: ExtensionContext | undefined, revoke = false) => {
		const ended = scope;
		scope = undefined;
		const now = Date.now();
		for (const [id, held] of heldScopes) if (revoke || held.until <= now) heldScopes.delete(id);
		hostPolicy.recheck();
		const report = ended ? blockedReport(ended.blocked) : undefined;
		if (report && ctx) ctx.ui.notify(report, "warning");
		// fork.9 (CAP-01): what a scheduled run refused goes to its log at exit, read by /schedule.
		if (ended && scheduledId && report) noteScheduledRun({ refused: report });
	};
	const startScope = (ctx: ExtensionContext, approval: ScopeApproval, running: boolean) => {
		if (scope) endScope(ctx);
		const until = Date.now() + approval.minutes * 60_000;
		scope = {
			operations: approval.operations,
			away: approval.away,
			until,
			running,
			rules: [],
			hostGrants: [],
			refused: new Set(),
			blocked: [],
		};
		const started = scope;
		// At the end of its time, the scope and the background tasks holding it lose their connections, even
		// when its task ended first.
		const timer = setTimeout(() => {
			if (scope === started) endScope(networkCtx);
			else {
				for (const [id, held] of heldScopes) if (held === started) heldScopes.delete(id);
				hostPolicy.recheck();
			}
		}, until - Date.now());
		timer.unref?.();
	};
	/** fork: a host taken back in any Prism session closes its connections here too. */
	let stopWatchingGrants: (() => void) | undefined;
	let stopWatchingSettings: (() => void) | undefined;

	/** fork: the agents running from this session, told of each change. */
	const childWatchers = new Set<() => void>();
	const persist = () => {
		state.timed = state.timed.filter((grant) => grant.until > Date.now());
		try {
			// fork: a copy, or the entry would follow every later change in memory.
			// fork: sealed, so only a state this installation wrote is given back.
			const seal = sealPermState(getAgentDir(), state);
			pi.appendEntry("perm-state", { ...structuredClone(state), ...(seal ? { seal } : {}) });
		} catch {
			// Non-fatal: state just won't survive /reload or resume.
		}
		for (const watcher of [...childWatchers]) watcher();
	};

	// The footer status is parsed, by the terminal's footer and by the window, which word it themselves: English only.
	const statusText = (s: SessionState) => `perm: ${modeText(s)}`;
	// The bare mode for notices, so the French catalogue names it like the footer does.
	const modeText = (s: SessionState) => (s.mode === "safe" ? "safe (read-only)" : s.mode);
	// fork: the footer says when shell commands run in the sandbox.
	const activeSandbox = (ctx: ExtensionContext): SandboxRuntime | undefined => {
		const sandbox = sessionSandbox(ctx.sessionManager);
		return sandbox && !("error" in sandbox) ? sandbox : undefined;
	};

	/** fork: whether reading outside the project is limited now, as the scope screen says. */
	const readLimited = (ctx: ExtensionContext): boolean => {
		if (sandboxSettingsProblem()) return false;
		const settings = readSandboxSettings();
		return (
			settings.read.limit === "project" && sandboxedMode(settings, state.mode) && activeSandbox(ctx) !== undefined
		);
	};

	const updateStatus = (ctx: ExtensionContext) => {
		try {
			const sandbox = sessionSandbox(ctx.sessionManager);
			const sandboxText = !sandbox ? "" : "error" in sandbox ? " · sandbox not working" : " · sandbox";
			ctx.ui.setStatus("permissions", `${statusText(state)}${sandboxText}`);
		} catch {
			// ignore
		}
	};

	const permissionsFile = (cwd: string, scope: PermissionScope) =>
		scope === "project" ? projectConfigPath(cwd) : globalConfigPath();

	/** fork: what the Permissions & sandbox domain of /settings reads and changes. */
	const settingsDeps = (ctx: ExtensionContext): PermissionSettingsDeps => ({
		mode: () => state.mode,
		modes: cycleOrder,
		setMode: async (mode) => void (await setMode(ctx, mode)),
		defaultMode: () => parseMode(readConfig(globalConfigPath())?.mode) ?? FALLBACK_MODE,
		setDefaultMode: async (mode) => await saveValidConfigFields(globalConfigPath(), { mode }),
		projectTrusted: () => ctx.isProjectTrusted(),
		readList: (scope, list) => readConfig(permissionsFile(ctx.cwd, scope))?.[list] ?? [],
		changeList: async (scope, list, change) =>
			await updateConfigFile(permissionsFile(ctx.cwd, scope), (cfg) => ({
				...cfg,
				[list]: change(cfg[list] ?? []),
			})),
		parseRule: (text) => parseRule(text)?.label ?? new Error(t("Type a rule: tool or tool(glob).")),
		projectGrants: () => {
			const grants = readProjectGrants(ctx.cwd);
			return [
				...(["allow", "deny"] as const).flatMap((effect) =>
					grants[effect].map((rule) => ({
						id: JSON.stringify([effect, rule]),
						label: describeRule(rule, effect),
						detail: rule,
					})),
				),
				...grants.hosts.map(({ host, rule }) => ({
					id: JSON.stringify(["host", host, rule]),
					label: fill('Let "{0}" connect to {1}', ruleIntent(rule, ctx.cwd), host),
					detail: rule,
				})),
			];
		},
		addProjectRule: async (rule) => await addProjectRule(ctx.cwd, rule),
		removeProjectGrant: async (id) => {
			const [kind, value, rule] = JSON.parse(id) as [string, string, string?];
			if (kind === "allow" || kind === "deny") return await removeProjectRule(ctx.cwd, value, kind);
			await removeProjectHost(ctx.cwd, { host: value, rule: rule ?? "" } satisfies HostGrant);
			// A host taken back loses its open connections too.
			hostPolicy.recheck();
		},
		defaultProtectedPaths: DEFAULT_PROTECTED_GLOBS,
		readTools: () =>
			toolsFound().map(({ tool, paths }) => ({ name: tool, paths: paths.map((path) => homeRelative(path)) })),
		parseReadable: (text) => parseReadable(text, ctx.cwd),
		shortPath: (path: string) => homeRelative(path),
		sandbox: () => readSandboxSettings(),
		saveSandbox: async (path, value) => {
			saveSandboxSetting(path, value);
			// fork: a host no longer allowed loses its open connections, not only the next ones.
			hostPolicy.recheck();
			// The session's sandbox starts again with the new settings; one that does not work blocks commands.
			const failure = await applySandbox(ctx, state.mode, hostPolicy, granted(ctx));
			updateStatus(ctx);
			if (failure) ctx.ui.notify(brokenSandboxMessage(state.mode, failure, ctx.hasUI), "error");
		},
		checkSandbox: async () => {
			const failure = await applySandbox(ctx, state.mode, hostPolicy, granted(ctx));
			updateStatus(ctx);
			if (failure) ctx.ui.notify(brokenSandboxMessage(state.mode, failure, ctx.hasUI), "error");
			else
				ctx.ui.notify(
					activeSandbox(ctx) ? t("The sandbox works.") : fill("The sandbox is off in {0} mode.", t(state.mode)),
					"info",
				);
		},
		sandboxState: () => {
			const sandbox = sessionSandbox(ctx.sessionManager);
			const settings = readSandboxSettings();
			const error = sandbox && "error" in sandbox ? sandbox.error : undefined;
			return {
				label: error ? "not working" : activeSandbox(ctx) ? "on in this mode" : "off in this mode",
				broken: !!error,
				// The page closes with Esc: no « Close » choice as in /sandbox's list.
				lines: describeSandbox({
					mode: state.mode,
					active: !!activeSandbox(ctx),
					error,
					settings,
					layout: sandboxedMode(settings, state.mode)
						? buildLayout({
								cwd: ctx.cwd,
								settings,
								copyGitDir: (gitDir) => gitCopyRefusal(gitDir) === undefined,
							})
						: undefined,
					gitCopies: describeGitCopies(join(getAgentDir(), "sandbox", "git-copies")),
					repositories: reportedRepositories(),
					settingsPath: join(getAgentDir(), "settings.json"),
				}).filter((line) => line !== "Close"),
			};
		},
		report: (message) => ctx.ui.notify(message, "error"),
	});

	pi.on("session_shutdown", (event, ctx) => {
		dangerAllowed.clear();
		sudoApprovals.delete(ctx.sessionManager);
		// fork: the session's private /tmp goes with it, but survives a reload.
		if (event.reason !== "reload") {
			// fork: the attached copies the agent changed are saved first.
			try {
				keepChangedAttachments(attachTarget(ctx.sessionManager));
			} catch (error) {
				ctx.ui.notify(
					fill(
						"Could not keep the changed attached files: {0}",
						error instanceof Error ? error.message : String(error),
					),
					"warning",
				);
			}
			removeSessionTmpDir(ctx.sessionManager.getSessionId());
		}
		// fork: a task scope is not kept across sessions or reloads.
		endScope(undefined);
		heldScopes.clear();
		closedPlace = networkPlace();
		networkCtx = undefined;
		if (hostPolicy.inUse) outlivingPolicies.add(hostPolicy);
		stopWatchingGrants?.();
		stopWatchingGrants = undefined;
		stopWatchingSettings?.();
		stopWatchingSettings = undefined;
		// A session started since then has put its own section in place: leave it.
		if (settingsSection && settingsSections().includes(settingsSection))
			setSettingsSection(SETTINGS_OWNER, undefined);
		settingsSection = undefined;
	});

	pi.registerFlag("perm-mode", {
		description:
			"Permission mode: ask (confirms writes and non-safe commands, 3 min timeout), safe (read-only), broad (default: asks only for dangerous calls; formerly yolo) or unrestricted (asks nothing; not a sandbox)",
		type: "string",
		default: "",
	});
	pi.registerFlag("perm-deny", {
		description: "Session deny rules, as a JSON array of rules; Prism passes its own to the agents it starts",
		type: "string",
		default: "",
	});
	pi.registerFlag(SCHEDULED_FLAG, {
		description: "Run a scheduled task (started by its systemd timer; see /schedule)",
		type: "string",
		default: "",
	});
	pi.registerFlag("perm-yolo", {
		description: "Broad permission mode, formerly yolo (sugar for --perm-mode broad)",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		// fork: a search leaves out what `read` asks for, unless its folder was asked for.
		setProtectedSearch((root, cwd) => {
			if (state.mode === "unrestricted") return undefined;
			const cfg = loadConfig(cwd, ctx.isProjectTrusted());
			return protectedPath(root, cwd, cfg) ? undefined : (file) => protectedPath(file, cwd, cfg);
		});
		dangerAllowed.clear();
		hostPolicy.sessionAllowed.clear();
		browserEverySite = false;
		configurationModes.set(ctx.sessionManager, () => state.mode);
		sudoApprovals.set(ctx.sessionManager, () => dangerAllowed.has("sudo\0"));
		permissionPanels.set(ctx.sessionManager, panelFor);
		sessionGrants.set(ctx.sessionManager, {
			take: () => ({
				danger: [...dangerAllowed].filter(([key]) => key !== "sudo\0"),
				hosts: [...hostPolicy.sessionAllowed]
					.filter((grant) => grant.command === undefined)
					.map((grant) => grant.host),
				...([...hostPolicy.sessionAllowed].some((grant) => grant.command !== undefined)
					? { commandHosts: [...hostPolicy.sessionAllowed].filter((grant) => grant.command !== undefined) }
					: {}),
				...(browserEverySite ? { browserEverySite: true } : {}),
			}),
			give: (grants) => {
				for (const [key, what] of grants.danger) dangerAllowed.set(key, what);
				for (const host of grants.hosts) hostPolicy.allowForSession(host, { command: "", nonCommand: true });
				for (const grant of grants.commandHosts ?? [])
					hostPolicy.allowForSession(grant.host, { command: grant.command ?? "" });
				if (grants.browserEverySite) browserEverySite = true;
			},
		});
		childRestrictions.set(ctx.sessionManager, () => ({ mode: state.mode, deny: [...state.deny] }));
		childWatchers.clear();
		childPermissionWatchers.set(ctx.sessionManager, childWatchers);
		// fork: this session's /tmp is the one it made; its full outputs are the ones Prism cites in its
		// results. Only where Prism writes the path: a file listing of the temporary folder does not make it own.
		const sessionManager = ctx.sessionManager;
		ownTemp = (name) => {
			const dir = existingSessionTmpDir(sessionManager.getSessionId());
			if (dir !== undefined && (name === basename(dir) || name.startsWith(`${basename(dir)}.task-`))) return true;
			// fork: only the path Prism itself recorded when it saved the output, never a
			// name found in a result's text or details, which the model can write (an edit's diff).
			const saved = (path: unknown) => typeof path === "string" && path.endsWith(`${sep}${name}`);
			return sessionManager.getEntries().some((entry) => {
				if (entry.type !== "message") return false;
				const message = entry.message;
				if (message.role === "bashExecution") return saved(message.fullOutputPath);
				if (message.role !== "toolResult" || (message.toolName !== "bash" && !message.toolName.includes("mcp")))
					return false;
				const details = message.details as { fullOutputPath?: unknown } | undefined;
				return saved(details?.fullOutputPath);
			});
		};
		// Restore session-scoped state persisted via custom entries.
		let persisted: Partial<SessionState> | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "perm-state") {
				// A copy, so the restored state never changes the saved entry.
				persisted = structuredClone(entry.data) as Partial<SessionState> | undefined;
			}
		}
		const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const flagMode: Mode | undefined =
			parseMode(pi.getFlag("perm-mode")) ?? (pi.getFlag("perm-yolo") === true ? "broad" : undefined);

		// A saved or configured "unrestricted" counts only once its warning was accepted;
		// the command line selects it explicitly.
		const accepted = (mode: Mode | undefined) =>
			mode === "unrestricted" && readConfig(globalConfigPath())?.unrestrictedAccepted !== true ? "broad" : mode;
		// fork: a saved state without this installation's seal (a session file from
		// elsewhere, one that was edited, one written before the seal) gives back only what narrows: its deny rules,
		// and its mode when that is no wider than the configured one. See perm-seal.ts.
		const sealed = persisted === undefined || permStateSealed(getAgentDir(), persisted);
		const configured = accepted(parseMode(cfg.mode)) ?? FALLBACK_MODE;
		const strictness = (mode: Mode) => ["safe", "ask", "broad", "unrestricted"].indexOf(mode);
		const savedMode = accepted(parseMode(persisted?.mode));
		const savedTimed = (Array.isArray(persisted?.timed) ? (persisted.timed as unknown[]) : []).filter(
			// An expired permission stays expired when the session is reopened.
			(grant): grant is TimedPermission => isTimedPermission(grant) && grant.until > Date.now(),
		);
		const savedAllow = Array.isArray(persisted?.allow) ? persisted.allow : [];
		const keptMode =
			savedMode !== undefined && (sealed || strictness(savedMode) <= strictness(configured)) ? savedMode : undefined;
		const dropped =
			!sealed &&
			(keptMode !== savedMode || savedAllow.length > 0 || savedTimed.some((grant) => grant.effect === "allow"));
		state = {
			mode: flagMode ?? keptMode ?? configured,
			allow: sealed ? savedAllow : [],
			// an agent keeps the session deny rules of the Prism that started it.
			deny: [...new Set([...(persisted?.deny ?? []), ...flagDenyRules(pi.getFlag("perm-deny"))])],
			timed: sealed ? savedTimed : savedTimed.filter((grant) => grant.effect === "deny"),
		};
		if (dropped) {
			const message = fill(
				"This session's saved permissions were not given back: its file was not written by this Prism, or was changed. Mode: {0}; the rules allowed in this session are gone.",
				state.mode,
			);
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}
		warnedUndeclared.clear();
		// fork.9 (CAP-01): a scheduled run asks nobody: ask mode, and only the scope the user fixed at creation.
		const scheduledFlag = pi.getFlag(SCHEDULED_FLAG);
		if (typeof scheduledFlag === "string" && scheduledFlag !== "") {
			scheduledId = scheduledFlag;
			noteScheduledRun({ session: ctx.sessionManager.getSessionFile() });
			const task = readScheduledTask(scheduledFlag);
			state.mode = "ask";
			startScope(ctx, { operations: task?.operations ?? [], minutes: task?.budget.minutes ?? 1, away: true }, true);
		}
		updateStatus(ctx);
		// fork: the domain Permissions & sandbox of /settings, while this session runs.
		settingsSection = permissionsSection(settingsDeps(ctx));
		setSettingsSection(SETTINGS_OWNER, settingsSection);
		// fork: a sandbox that does not work blocks the commands that
		// need it, never runs them outside; Prism itself starts, so chat and settings stay usable.
		networkCtx = ctx;
		stopWatchingGrants?.();
		const recheckAll = () => {
			hostPolicy.recheck();
			recheckOutliving();
		};
		// The settings may have changed while no watcher ran.
		recheckOutliving();
		stopWatchingGrants = watchProjectGrants(recheckAll);
		stopWatchingSettings?.();
		stopWatchingSettings = watchProjectGrants(recheckAll, getAgentDir(), undefined, "settings.json");
		const sandboxFailure = await applySandbox(ctx, state.mode, hostPolicy, granted(ctx));
		updateStatus(ctx);
		if (sandboxFailure) {
			const message = brokenSandboxMessage(state.mode, sandboxFailure, ctx.hasUI);
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else process.stderr.write(`${message}\n`);
		}
		if (state.mode === "unrestricted") {
			ctx.ui.notify(fill("Permission mode: unrestricted. {0}", t(UNRESTRICTED_WARNING)), "warning");
		}
		// fork: once, the first time reading is limited, say so and where to widen it.
		// The mark lives beside the rules, not in permissions.json, which stays the user's.
		const noticed = join(getAgentDir(), "sandbox", "read-limit-noticed");
		if (ctx.hasUI && readLimited(ctx) && !existsSync(noticed)) {
			ctx.ui.notify(t(READ_LIMIT_NOTICE), "info");
			try {
				mkdirSync(dirname(noticed), { recursive: true });
				writeFileSync(noticed, "");
			} catch {
				// An agent dir that cannot be written: the line comes back next time.
			}
		}
	});

	// -------------------------------------------------------------------------
	// The gate
	// -------------------------------------------------------------------------

	// fork: the model knows what the sandbox hides before it runs into it.
	pi.on("before_agent_start", (event, ctx) => {
		const sandbox = activeSandbox(ctx);
		if (!sandbox) return;
		event.systemPromptOptions.sections.sandbox = sandboxPromptSection(
			buildLayout({
				cwd: ctx.cwd,
				agentDir: sandbox.agentDir,
				settings: sandbox.settings,
				copyGitDir: (gitDir) => gitCopyRefusal(gitDir) === undefined,
			}),
			readSandboxSettings(sandbox.agentDir),
		);
	});

	// ...and a command that ran into something the sandbox blocks says so in its result: a hidden
	// path, D-Bus, a container, the network, localhost, or a host the proxy refused to it.
	// fork: the result names the path as the model wrote it, the one its commands see.
	pi.on("tool_result", (event) => {
		const tmp = scratchCalls.get(event.toolCallId);
		if (tmp === undefined) return;
		scratchCalls.delete(event.toolCallId);
		return {
			content: event.content.map((part) =>
				part.type === "text" ? { ...part, text: part.text.split(tmp).join("/tmp") } : part,
			),
			structuredContent: event.structuredContent,
		};
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "background") return;
		hostPolicy.forgetCall(event.toolCallId);
		// fork: the user hears of such a repository too, not only the model.
		const repositories = takeUnseenRepositories();
		if (repositories.length > 0 && ctx.hasUI)
			ctx.ui.notify(
				fill(
					"A command made or changed Git repositories whose hooks or configuration run programs: {0}. Git run there outside Prism (git status, your shell prompt, your editor) would run them. Check them first; /sandbox lists them.",
					repositories.join(", "),
				),
				"warning",
			);
		const sandbox = activeSandbox(ctx);
		if (!sandbox) return;
		const output = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const notes = [
			networkRefusalNote(hostPolicy.refusalsOf(event.toolCallId)),
			sandboxResultNote(
				`${String(event.input.command ?? "")}\n${output}`,
				(event.toolName === "bash" ? takeSandboxLayout(sandbox, event.toolCallId) : undefined) ??
					buildLayout({ cwd: ctx.cwd, agentDir: sandbox.agentDir, settings: sandbox.settings }),
				readSandboxSettings(sandbox.agentDir),
			),
		].filter((note) => note !== undefined);
		if (notes.length === 0) return;
		return {
			content: [...event.content, ...notes.map((note) => ({ type: "text" as const, text: `\n${note}` }))],
			structuredContent: event.structuredContent,
		};
	});

	// fork: the user's ! commands, in the sandbox only when asked.
	pi.on("user_bash", (_event, ctx) => {
		const problem = sandboxSettingsProblem();
		if (problem) return { result: { output: t(problem), exitCode: 1, cancelled: false, truncated: false } };
		if (!readSandboxSettings().userCommands || !sessionSandbox(ctx.sessionManager)) return;
		return {
			operations: createSandboxableBashOperations(
				() => sessionSandbox(ctx.sessionManager),
				pi.getSettings().shellPath,
			),
		};
	});

	pi.registerCommand("sandbox", {
		description: "Sandbox: state, writable and hidden paths, allowed hosts",
		handler: async (_args, ctx) => {
			// fork: opens the sandbox's settings in /settings; the text without that window.
			if (ctx.hasUI && openSettings({ domain: "permissions", item: "sandbox-state" })) return;
			const problem = sandboxSettingsProblem();
			if (problem) {
				if (ctx.hasUI) ctx.ui.notify(t(problem), "error");
				else console.log(t(problem));
				return;
			}
			const sandbox = sessionSandbox(ctx.sessionManager);
			const settings = readSandboxSettings();
			const lines = describeSandbox({
				mode: state.mode,
				active: !!activeSandbox(ctx),
				error: sandbox && "error" in sandbox ? sandbox.error : undefined,
				settings,
				layout: sandboxedMode(settings, state.mode)
					? buildLayout({ cwd: ctx.cwd, settings, copyGitDir: (gitDir) => gitCopyRefusal(gitDir) === undefined })
					: undefined,
				gitCopies: describeGitCopies(join(getAgentDir(), "sandbox", "git-copies")),
				repositories: reportedRepositories(),
				settingsPath: join(getAgentDir(), "settings.json"),
			});
			if (ctx.hasUI) await ctx.ui.select(t("Sandbox"), lines);
			else console.log(lines.join("\n"));
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;
		const input = event.input as Record<string, unknown>;
		// settings.json is there but its sandbox rules cannot be known, and none were
		// read before: no tool runs, in any mode, until it is fixed. Once it is, the session's sandbox starts again.
		const settingsProblem = sandboxSettingsProblem();
		if (settingsProblem) {
			return {
				block: true,
				reason: `${settingsProblem} Do not retry or work around it; tell the user, who must fix the file.`,
			};
		}
		const current = sessionSandbox(ctx.sessionManager);
		if (current && "error" in current && current.error.startsWith(SANDBOX_SETTINGS_ERROR_START)) {
			await applySandbox(ctx, state.mode, hostPolicy, granted(ctx));
			updateStatus(ctx);
		}
		// fork: a permissions file that no longer parses keeps its last valid rules; said once.
		for (const file of staleConfigFiles(ctx.cwd, ctx.isProjectTrusted())) {
			if (warnedStaleConfig.has(file)) continue;
			warnedStaleConfig.add(file);
			ctx.ui.notify(
				fill(
					"{0} is not a valid permissions file any more. Its last valid version still applies; a rule saved from a question is refused until the file is fixed.",
					file,
				),
				"warning",
			);
		}
		const sandbox = activeSandbox(ctx);
		// fork: with the sandbox, the file tools use the session's
		// private /tmp, the one its commands see at /tmp.
		const tmp = sandbox?.tmp;
		const field = FILE_TOOLS.has(tool) ? "path" : undefined;
		const given = field ? input[field] : undefined;
		if (sandbox && tmp && field && typeof given === "string") {
			const abs = toolPath(tool, given, ctx.cwd);
			const scratch = inSessionTmp(abs, tmp);
			// What the sandbox mounts in its own place under /tmp (a project there, a hidden agent dir) stays there.
			const mounted = (layout: SandboxLayout) =>
				[
					...layout.writable,
					...layout.readOnly,
					...layout.hidden,
					...(layout.copies ?? []).map(([, original]) => original),
				].some((root) => within(abs, root));
			// The read-only tools fall back on the host's /tmp, where Prism keeps full outputs and the user may leave
			// a file to read.
			const writes = tool === "write" || tool === "edit";
			if (
				scratch !== undefined &&
				scratch !== abs &&
				(writes || existsSync(scratch)) &&
				!mounted(buildLayout({ cwd: ctx.cwd, agentDir: sandbox.agentDir, settings: sandbox.settings }))
			) {
				input[field] = scratch;
				scratchCalls.set(event.toolCallId, tmp);
			}
		}
		// fork: the object judged now is the one the tool opens, whatever is put since.
		if ((tool === "read" || tool === "write" || tool === "edit") && typeof input.path === "string" && input.path)
			bindFileCall(event.toolCallId, toolPath(tool, input.path, ctx.cwd));
		let decision = decide(
			tool,
			input,
			ctx.cwd,
			ctx.isProjectTrusted(),
			state,
			() => pi.getAllTools().find((info) => info.name === tool),
			undefined,
			tmp,
		);
		// fork: a command the user excluded from the sandbox runs outside it, so the
		// mode alone does not allow it; one of the user's own rules still does.
		let excluded = false;
		if (decision.effect === "allow" && !decision.byRule && sandbox && isDesktopLaunch(tool, input)) {
			// the sandbox refuses Unix sockets, so a program shown on the agent's
			// desktop starts outside it; as an excluded command, the mode alone does not allow it.
			excluded = true;
			decision = {
				...decision,
				effect: "prompt",
				tier: "ask",
				reason: "This program runs outside the sandbox, with your rights, on the agent's desktop.",
				suggestedRule: suggestRule(tool, input, ctx.cwd, loadConfig(ctx.cwd, ctx.isProjectTrusted())),
			};
		} else if (
			decision.effect === "allow" &&
			!decision.byRule &&
			sandbox &&
			(tool === "bash" || tool === "background") &&
			typeof input.command === "string" &&
			isExcludedCommand(input.command, sandbox.settings.excludedCommands)
		) {
			excluded = true;
			decision = {
				...decision,
				effect: "prompt",
				tier: "ask",
				reason: "This command runs outside the sandbox (sandbox.excludedCommands).",
				suggestedRule: suggestRule(tool, input, ctx.cwd, loadConfig(ctx.cwd, ctx.isProjectTrusted())),
			};
		}
		// safe mode keeps "changes no file" when no sandbox mounts the project read-only
		// (sandbox.modes.safe off, or no bubblewrap): then only plain commands run, with nothing the classifier could
		// misread (substitutions, evaluated text, file redirects). The sandbox, when on, is the boundary instead.
		if (
			state.mode === "safe" &&
			!sandbox &&
			decision.effect === "allow" &&
			isShellCall(tool, input) &&
			typeof input.command === "string"
		) {
			const why =
				unseenCodeReason(input.command) ??
				(/(^|[^0-9&<>-])>>?\s*(?!&|\/dev\/null\b)/.test(input.command) ? "it redirects into a file" : undefined);
			if (why) {
				decision = {
					...decision,
					effect: "block",
					reason: `Blocked by safe mode without the sandbox: ${why}. Without the sandbox, safe mode runs only plain read-only commands; tell the user, who can turn the sandbox on for safe mode.`,
				};
			}
		}
		// fork: with the sandbox on, the language server runs in it (lsp-sandbox.ts);
		// without, it runs the project's code (build scripts, macros) with every right of the user, so the mode alone
		// does not allow it, nor a task scope.
		if (
			LSP_TOOLS.has(tool) &&
			!sandbox &&
			state.mode !== "unrestricted" &&
			decision.effect !== "block" &&
			!decision.byRule
		) {
			decision = {
				...decision,
				effect: "prompt",
				tier: "danger",
				reason:
					"The language server runs outside the sandbox, with your rights: it can run code the project controls (build scripts such as build.rs, macros). Allow it only for a project you trust.",
			};
		}
		// fork.9 (CAP-01): a scheduled run follows the scope fixed for it, not the allow rules of the user's sessions.
		if (scheduledId && decision.effect === "allow" && decision.byRule)
			decision = {
				...decision,
				effect: "prompt",
				tier: "ask",
				reason: "Scheduled run: only the task's own scope applies, not allow rules.",
			};
		const emitDecision = (result: PermissionDecisionFact["decision"], reason: string) =>
			emitPermissionDecision({
				sessionId: ctx.sessionManager.getSessionId(),
				toolCallId: event.toolCallId,
				toolName: tool,
				decision: result,
				reason,
			});

		// fork: a background command started under a task scope keeps its hosts until its time is up.
		let task = liveScope();
		// call-only approval, before allow rules or a task scope can let an install run.
		if (
			state.mode !== "unrestricted" &&
			decision.effect !== "block" &&
			isShellCall(tool, input) &&
			typeof input.command === "string"
		) {
			// the registries a configuration names follow the host policy of the commands,
			// checked without a question; Prism's own public endpoints are refused only when blocked, as a provider.
			const network = hostPolicy.open({ command: input.command });
			// the npm guard's requests reach only the
			// addresses its check resolved for this call.
			const pins = new PinnedLookup(hostPolicy.dnsGuard);
			const registry = guardedFetch(pins.lookup);
			const reason = await npmInstallRefusal(input.command, {
				cwd: ctx.cwd,
				home: homedir(),
				fetch: registry.fetch,
				reach: async (url, fixed) => {
					const name = destinationName(url);
					if (fixed && !scheduledId) return isDenied(name, readSandboxSettings().network) ? name : undefined;
					let refused: string | undefined;
					await checkDestination(
						url,
						async (host) => {
							if (network.allowsNow(host)) return true;
							refused = host;
							return false;
						},
						pins.resolve,
						(address) => {
							if (!isDenied(address, readSandboxSettings().network)) return false;
							refused = address;
							return true;
						},
					);
					return refused;
				},
				now: Date.now,
				env: process.env,
				ui: ctx.hasUI && !scheduledId && !task?.away ? ctx.ui : undefined,
			}).finally(() => {
				network.close();
				void registry.close();
			});
			if (reason) {
				emitDecision("blocked", reason);
				return { block: true, reason };
			}
			// fork: a scope that ended or expired during the check covers nothing.
			task = liveScope();
		}
		const holdScope = () => {
			if (task && tool === "background" && input.action === "run") heldScopes.set(event.toolCallId, task);
		};

		if (decision.effect === "allow") {
			emitDecision("allowed_by_rule", decision.reason);
			holdScope();
			// fork: a port of this machine written in a command that runs without
			// a question is asked about before it starts, so that a program connecting without the proxy finds it open.
			const command = typeof input.command === "string" ? input.command : undefined;
			if (sandbox && ctx.hasUI && command !== undefined && (tool === "bash" || tool === "background") && !excluded) {
				const network: NetworkCommand = { toolCallId: event.toolCallId, command };
				const ports = likelyHosts(shellSegments(command).map((segment) => segmentText(command, segment))).filter(
					(host) => localPortOf(host) !== undefined && hostPolicy.wouldAsk(host, network),
				);
				const granted: string[] = [];
				const refused: [string, "user" | "unanswered" | "scope"][] = [];
				for (const host of ports) {
					const answer = await hostPolicy.ask?.(host, network);
					if (answer === "session") hostPolicy.allowForSession(host, network);
					if (answer === "command") granted.push(host);
					if (answer === "deny" || answer === "unanswered" || answer === "scope")
						refused.push([host, answer === "deny" ? "user" : answer]);
				}
				hostPolicy.grantForCall(event.toolCallId, granted);
				hostPolicy.refuseForCall(event.toolCallId, refused);
			}
			return undefined;
		}
		const callKey = tool === "sudo" ? "sudo\0" : `${tool}\0${targetOf(tool, input, ctx.cwd)}`;
		if (decision.effect === "prompt" && decision.tier === "danger" && dangerAllowed.has(callKey)) {
			emitDecision("allowed_by_rule", "Allowed in this session");
			holdScope();
			return undefined;
		}

		if (decision.effect === "block") {
			emitDecision("blocked", decision.reason);
			// The user, not the model, is told how to allow the tool.
			if (decision.undeclared && !warnedUndeclared.has(tool)) {
				warnedUndeclared.add(tool);
				ctx.ui.notify(
					fill(
						'The tool "{0}" declares no permissions, so the {1} mode blocks it. Allow it with /perm allow {0} (this session), /perm always {0}, or the broad mode.',
						tool,
						state.mode,
					),
					"warning",
				);
			}
			return { block: true, reason: `${sentence(decision.reason)} Do not retry the identical call.` };
		}

		// decision.effect === "prompt"
		// fork: a broken sandbox refuses every shell command, so a question would be for nothing.
		const session = sessionSandbox(ctx.sessionManager);
		if ((tool === "bash" || tool === "background") && session && "error" in session) {
			const reason = brokenSandboxReason(session);
			emitDecision("blocked", reason);
			return { block: true, reason };
		}
		// fork: in a task scope, what it covers passes; one refusal holds for the whole task; the rest
		// is refused at once while the user is away. Never a dangerous call, nor a command run outside the sandbox.
		const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const refusalKey = decision.suggestedRule
			? `rule ${decision.suggestedRule}`
			: `call ${tool} ${JSON.stringify(input)}`;
		if (task) {
			const covered =
				decision.tier === "ask" && !excluded
					? (scopeCovers(task, tool, input, ctx.cwd, cfg, sandbox !== undefined) ??
						// fork.9 (CAP-01): a scheduled task given hosts may use the web tools; each destination, or the
						// search provider, is then checked against those hosts alone (TOOL_NETWORK_EVENT).
						(scheduledId && (tool === "web_fetch" || tool === "web_search")
							? task.operations.find((operation) => operation.hosts.length > 0)?.what
							: undefined))
					: undefined;
			if (covered !== undefined) {
				const reason = `Allowed by the task scope: ${covered}`;
				emitDecision("allowed_by_rule", reason);
				holdScope();
				return undefined;
			}
			const shown = decision.suggestedRule ? ruleIntent(decision.suggestedRule, ctx.cwd) : decision.target || tool;
			if (task.refused.has(refusalKey) || scopeRefused(task, tool, input, ctx.cwd, cfg)) {
				task.blocked.push({ what: shown, why: "again" });
				const reason =
					"Action blocked: already refused in this task (task scope). Do not retry it or a variant of it; go on without it and tell the user at the end what is left.";
				emitDecision("blocked", reason);
				return { block: true, reason };
			}
			if (task.away) {
				task.refused.add(refusalKey);
				task.blocked.push({ what: shown, why: "away" });
				const reason =
					"Action blocked: outside the task scope the user approved, and the user is away, so nobody can allow it now. This is intended. Do not retry it or a variant of it; continue without it, and say at the end what is left and which permission it needs.";
				emitDecision("blocked", reason);
				return { block: true, reason };
			}
		}

		if (!ctx.hasUI && decision.readOutside) {
			const reason = readOutsideRefusal(decision.readOutside);
			emitDecision("blocked", reason);
			return { block: true, reason };
		}
		if (!ctx.hasUI) {
			// fork.9 QA: broad and allow rules still ask for a dangerous call, so suggesting them went in circles.
			const reason =
				decision.tier === "danger"
					? `${decision.reason}. Blocked: a dangerous call needs confirmation in every mode but unrestricted, ` +
						`and the session is non-interactive. Run it in an interactive session.`
					: `${decision.reason}. Blocked: this call needs confirmation but the session is ` +
						`non-interactive. Re-run ${APP_NAME} with --perm-mode broad or add an allow rule ` +
						`(see /perm help in interactive mode).`;
			console.error(`Permission blocked: ${reason}`);
			emitDecision("blocked", reason);
			return {
				block: true,
				reason,
			};
		}

		const suggested = decision.suggestedRule;
		const configTarget = ctx.isProjectTrusted() ? projectConfigPath(ctx.cwd) : globalConfigPath();

		interface Opt {
			label: string;
			action:
				| "once"
				| "task"
				| "timed"
				| "session"
				| "dangerSession"
				| "project"
				| "deny"
				| "projectDeny"
				| "alwaysDeny"
				| "show";
			rule?: string;
		}
		const opts: Opt[] = [];
		// fork: labels in the interface language (fork/i18n); the choice is found by its shown label.
		// fork: the rule in words; "for this project" replaces saving it in
		// permissions.json, which stays in /settings.
		const rule = suggested ?? tool;
		// fork.12 security audit: the options repeat the call's target; its controls show.
		const intent = visibleText(ruleIntent(rule, ctx.cwd));
		opts.push({ label: t("Allow once"), action: "once" });
		// fork: blocking in a task blocks it for the rest of the task.
		const denyLabel = task ? fill('Block "{0}" for this task', intent) : t("Block this action once");
		if (decision.readOutside) {
			// fork: this file, or its folder, for the session or the
			// project; for every project stays in the settings.
			const path = decision.readOutside;
			const folder = isDirectory(path) ? path : dirname(path);
			// Q-L12: a file right in the home folder opens alone, not with all of it.
			for (const readable of folder === path || within(homedir(), folder) ? [path] : [path, folder]) {
				const what = visibleText(ruleIntent(readableRule(readable), ctx.cwd));
				opts.push({
					label: fill('Allow "{0}" in this session', what),
					action: "session",
					rule: readableRule(readable),
				});
				opts.push({
					label: fill('Allow "{0}" in this project', what),
					action: "project",
					rule: readableRule(readable),
				});
			}
			opts.push({ label: denyLabel, action: "deny" });
		} else if (decision.tier === "danger") {
			// fork: this exact call for the session, never for a protected path or credentials.
			if (!PROTECTED_DETAIL.test(decision.reason))
				opts.push({
					label: t(tool === "sudo" ? "Allow sudo for this session" : "Allow this action in this session"),
					action: "dangerSession",
				});
			opts.push({ label: denyLabel, action: "deny" });
			opts.push({
				label: fill('Always block "{0}"; save in {1}', intent, configTarget),
				action: "alwaysDeny",
				rule,
			});
		} else {
			// fork: widens the task scope.
			if (task) opts.push({ label: fill('Allow "{0}" for this task', intent), action: "task", rule });
			// a permission for 15 minutes, then one for the session.
			opts.push({
				label: fill('Allow "{0}" for {1} minutes', intent, String(TIMED_MINUTES)),
				action: "timed",
				rule,
			});
			opts.push({ label: fill('Allow "{0}" in this session', intent), action: "session", rule });
			opts.push({ label: fill('Allow "{0}" in this project', intent), action: "project", rule });
			opts.push({ label: denyLabel, action: "deny" });
			// fork: kept like "in this project", and taken back from /settings alike.
			opts.push({ label: fill('Block "{0}" in this project', intent), action: "projectDeny", rule });
		}

		// fork: the hosts the command will probably contact, as a suggestion. The
		// user's answer covers them for this run; a project approval also keeps them with its rule.
		const command = typeof input.command === "string" ? input.command : undefined;
		const commandHosts =
			sandbox &&
			(tool === "bash" || tool === "background") &&
			command !== undefined &&
			!isExcludedCommand(command, sandbox.settings.excludedCommands)
				? likelyHosts(shellSegments(command).map((segment) => segmentText(command, segment))).filter(
						(host) => !isDenied(host, hostPolicy.getSettings()),
					)
				: undefined;
		const hosts = commandHosts
			? commandHosts.filter((host) => hostPolicy.wouldAsk(host, { command: command ?? "" }))
			: // fork (SEC-03): the destinations of a web_fetch call; the answer to its question covers them.
				tool === "web_fetch" && state.mode !== "unrestricted"
				? webFetchDestinations(input.urls).filter((host) =>
						hostPolicy.wouldAsk(host, { command: `web_fetch ${host}` }),
					)
				: [];
		const header =
			decision.tier === "danger" ? `Potentially dangerous action: ${tool}` : `Allow this action? ${tool}`;
		const shownHosts = commandHosts ?? hosts;
		const hostLines =
			shownHosts.length === 0
				? ""
				: `\n\n${fill("Will probably connect to: {0}", visibleText(shownHosts.join(", ")))}\n${t("Allowing it lets this run connect to them; other hosts are asked about.")}`;
		// fork: the whole command, since the answer covers all of it.
		// fork.12 security audit: what comes from the call (the target, the reason that quotes it)
		// shows its terminal controls and bidi characters instead of acting on the terminal; only a shell command
		// keeps its line breaks.
		const whole = visibleText(publicTmp(targetOf(tool, input, ctx.cwd), activeSandbox(ctx)?.tmp), {
			lines: isShellCall(tool, input),
		});
		const shown = questionTarget(whole);
		const title = `${t(header)}\n\n${textBlock(shown || t("(no target)"))}\n\n${visibleText(t(decision.reason))}${hostLines}`;
		// nothing is allowed blind. A target too long for the question is read in full
		// first; until then, only refusing is offered.
		const showWhole: Opt = { label: t("Show the whole command first"), action: "show" };
		let seen = shown === whole;
		const refusals = new Set<Opt["action"]>(["deny", "projectDeny", "alwaysDeny"]);

		let choice: string | undefined;
		let opt: Opt | undefined;
		let failure = "";
		let savedHosts: readonly string[] = [];
		const askedMode = state.mode;
		for (;;) {
			const offered = seen ? opts : [showWhole, ...opts.filter((o) => refusals.has(o.action))];
			choice = await ctx.ui.select(
				`${failure}${title}`,
				offered.map((o) => o.label),
				{
					timeout: PROMPT_TIMEOUT_MS,
					// fork: an interruption closes the question; a client shows it with its call.
					signal: ctx.signal,
					toolCallId: event.toolCallId,
				},
			);
			opt = choice === undefined ? undefined : offered.find((o) => o.label === choice);
			if (opt?.action === "show") {
				// fork: an interruption closes it too, instead of leaving the turn waiting.
				await ctx.ui.editor(t("The whole command, as it would run (changes here are ignored)"), whole, {
					signal: ctx.signal,
					toolCallId: event.toolCallId,
				});
				if (ctx.signal?.aborted) {
					// Unanswered: refused, never "show" taken as an answer.
					choice = undefined;
					opt = undefined;
					break;
				}
				seen = true;
				continue;
			}
			if (opt?.action !== "project" && opt?.action !== "projectDeny") break;
			// fork: kept for the project, or said so and asked again.
			const rule = opt.rule ?? tool;
			const effect = opt.action === "project" ? "allow" : "deny";
			const linkedHosts =
				command !== undefined && isShellCall(tool, input) && commandMatches(rule, command, ctx.cwd, cfg)
					? shownHosts
					: [];
			const saved = await saveForProject(
				async () => await addProjectRule(ctx.cwd, rule, effect, getAgentDir(), linkedHosts),
			);
			if (saved === true) {
				savedHosts = linkedHosts;
				break;
			}
			failure = saved;
		}
		// fork: the answer was given under the policy of the question. A switch to safe, or
		// a rule that now blocks the call, made while it was open applies: the call is refused.
		if (opt && !refusals.has(opt.action)) {
			const now =
				state.mode === "safe" && askedMode !== "safe"
					? {
							effect: "block" as const,
							reason: "Blocked: the permission mode changed to safe while the question was open",
						}
					: decide(
							tool,
							input,
							ctx.cwd,
							ctx.isProjectTrusted(),
							state,
							() => pi.getAllTools().find((info) => info.name === tool),
							undefined,
							tmp,
						);
			if (now.effect === "block") {
				emitDecision("blocked", now.reason);
				return { block: true, reason: `${sentence(now.reason)} Nothing ran. Do not retry the identical call.` };
			}
		}
		if (opt && opt.action !== "deny" && opt.action !== "projectDeny" && opt.action !== "alwaysDeny") {
			// Saved hosts must stay revocable during this execution too.
			hostPolicy.grantForCall(
				event.toolCallId,
				hosts.filter((host) => !savedHosts.includes(host)),
			);
			holdScope();
		} else if (task) {
			task.refused.add(refusalKey);
			const shown = decision.suggestedRule ? ruleIntent(decision.suggestedRule, ctx.cwd) : decision.target || tool;
			task.blocked.push({ what: shown, why: choice === undefined ? "unanswered" : "user" });
		}

		switch (opt?.action) {
			case "once":
				emitDecision("asked_granted_once", decision.reason);
				return undefined;
			case "task":
				if (task && opt.rule) task.rules = [...new Set([...task.rules, opt.rule])];
				emitDecision("asked_granted_timed", decision.reason);
				return undefined;
			case "timed": {
				const rule = opt.rule ?? tool;
				state.timed = [
					...state.timed.filter((grant) => grant.rule !== rule || grant.effect !== "allow"),
					{ rule, effect: "allow", until: Date.now() + TIMED_MINUTES * 60_000 },
				];
				persist();
				emitDecision("asked_granted_timed", decision.reason);
				return undefined;
			}
			case "session": {
				if (opt.rule) state.allow = [...new Set([...state.allow, opt.rule])];
				persist();
				emitDecision("asked_granted_session", decision.reason);
				return undefined;
			}
			case "dangerSession": {
				dangerAllowed.set(callKey, tool === "sudo" ? t("Commands as root (sudo)") : `${tool}(${decision.target})`);
				emitDecision("asked_granted_session", decision.reason);
				return undefined;
			}
			case "project": {
				emitDecision("asked_granted_always", decision.reason);
				return undefined;
			}
			case "projectDeny": {
				emitDecision("denied", "Denied by the user for this project");
				return {
					block: true,
					reason:
						"Denied by the user for this project (permission system, saved). This is intended. Do not retry this action or a variant of it; ask the user how to proceed.",
				};
			}
			case "alwaysDeny": {
				// fork: refused when the file does not parse; this call is still denied.
				if (await savedOrReported(ctx, async () => await saveRuleToConfig(configTarget, opt.rule ?? tool, "deny")))
					ctx.ui.notify(fill('Saved deny rule "{0}" to {1}', opt.rule ?? tool, configTarget), "warning");
				emitDecision("denied", decision.reason);
				return { block: true, reason: `Denied (rule saved to ${configTarget})` };
			}
			default:
				if (choice === undefined && ctx.signal?.aborted) {
					emitDecision("denied", "Interrupted by the user");
					return { block: true, reason: "Action blocked: the user interrupted the run before answering." };
				}
				emitDecision("denied", choice === undefined ? "Permission cancelled or timed out" : "Denied by user");
				return {
					block: true,
					reason:
						// fork: what was blocked, that it is intended, and how the user lifts it.
						choice === undefined
							? `Action blocked: the permission question was cancelled or not answered within ${PROMPT_TIMEOUT_MS / 60000} minutes; the user may be away. Do not retry this action or a variant of it: each one waits for an answer again. Go on with what does not need it, then tell the user what is left and which permission it needs (they can allow it with /perm or when asked).`
							: task
								? "Denied by the user for the rest of this task (permission system). This is intended. Do not retry this action or a variant of it; go on without it and tell the user at the end what is left."
								: decision.readOutside
									? `Denied by the user: ${homeRelative(decision.readOutside)} is outside what the agent may read. This is intended. Do not look for another copy or another way to it; ask the user how to proceed.`
									: "Denied by the user (permission system). This is intended. Do not retry this action or a variant of it; ask the user how to proceed.",
				};
		}
	});

	// -------------------------------------------------------------------------
	// Task scope
	// -------------------------------------------------------------------------

	let agentRunning = false;
	pi.on("agent_start", () => {
		agentRunning = true;
		if (scope) scope.running = true;
	});
	// The task is one run of the agent: its end ends the scope.
	pi.on("agent_end", (_event, ctx) => {
		agentRunning = false;
		if (scope?.running) endScope(ctx);
		browserRequestSites.clear();
		browserRequestEverySite = false;
	});

	/** The approval screen; only the user's answer on it starts a scope. */
	const approveScope = (ctx: ExtensionContext, proposal: ScopeProposal): Promise<ScopeApproval | undefined> => {
		// the same choices on a native screen in the Prism window.
		if (hasNativeMenus(ctx)) return approveScopeNative(ctx, proposal, readLimited(ctx), maxScopeMinutes());
		let columns = () => process.stdout.columns ?? 80;
		return ctx.ui.custom<ScopeApproval | undefined>(
			(tui, _theme, _keybindings, done) => {
				columns = () => tui.terminal.columns;
				return new ScopeView(proposal, done, readLimited(ctx), maxScopeMinutes());
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					get width() {
						return Math.min(columns() - 2, PERM_MAX_WIDTH);
					},
					maxHeight: "100%",
				},
			},
		);
	};

	// Only where someone can approve it: without a UI the tool would cost prompt tokens for nothing.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) registerScopeTool();
	});
	const registerScopeTool = () =>
		pi.registerTool({
			name: "propose_scope",
			label: "Propose scope",
			// It only asks the user; what they approve is applied by the permission gate.
			permissions: ["none"],
			description:
				"Ask the user once for what a task needs, so it runs without a question for each step, and can go on while they are away. Operations in plain words, each with the commands, files and hosts it needs, and a duration. The user removes lines and approves; what they approve then passes without asking, including hosts a sandboxed command could not reach. Anything else still asks, or is refused while the user is away. It cannot cover dangerous commands such as sudo or rm -rf, which always ask, and does nothing in safe mode, which changes no file whatever is approved.",
			promptSnippet: "Ask the user to approve what a long task needs",
			promptGuidelines: [
				"Use propose_scope when a task will need several permission questions, or will run long enough that the user may leave: builds, test runs, refactors, migrations, installs, work on the network. Do not use it for one or two commands, or in safe mode (it is refused there: ask the user to change mode instead). Name the fewest operations that do it, each in plain words. Call it alone and wait for its answer: calls made in the same turn are judged before the user approves.",
				"After a refusal outside the scope, do not retry it or a variant of it; go on without it and say at the end what is left.",
			],
			parameters: Type.Object({
				operations: Type.Array(
					Type.Object({
						what: Type.String({ description: 'The intention in plain words, e.g. "Run the tests"' }),
						commands: Type.Optional(
							Type.Array(Type.String(), {
								description: 'Command prefixes, e.g. "npm test" (covers "npm test --silent"); no wildcards',
							}),
						),
						writes: Type.Optional(
							Type.Array(Type.String(), {
								description: 'Files it changes, globs relative to the project, e.g. "src/**"',
							}),
						),
						hosts: Type.Optional(
							Type.Array(Type.String(), {
								description: 'Hosts its commands connect to, e.g. "registry.npmjs.org" or "*.github.com"',
							}),
						),
					}),
				),
				minutes: Type.Optional(
					Type.Number({ description: "How long the task should take, in minutes (default 60)" }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const reply = (text: string, approved: boolean) => ({
					content: [{ type: "text" as const, text }],
					details: { approved },
				});
				// fork: nothing the mode or the danger rules refuse anyway is put to the user for approval.
				if (state.mode === "safe")
					return reply(
						"Scope not proposed: safe mode changes no file, whatever is approved. Ask the user to change the permission mode if the task needs it.",
						false,
					);
				const proposal = parseProposal(params, maxScopeMinutes());
				if (proposal instanceof Error) return reply(`Scope not proposed: ${proposal.message}`, false);
				const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
				const dangerous = proposal.operations
					.flatMap((operation) => operation.commands)
					.filter((command) => classifyBash(command, { cwd: ctx.cwd, cfg }).tier === "danger");
				if (dangerous.length > 0)
					return reply(
						`Scope not proposed: a scope never covers dangerous commands (${dangerous.join(", ")}), each call of them asks the user. Propose the rest without them.`,
						false,
					);
				const approval = await approveScope(ctx, proposal);
				if (!approval)
					return reply(
						"The user did not approve the scope. Nothing changed: each step is asked about as before.",
						false,
					);
				startScope(ctx, approval, agentRunning);
				const lines = approval.operations.map(
					(operation) => `- ${operation.what}: ${operationDetail(operation, true)}`,
				);
				return reply(
					[
						`The user approved this scope for ${approval.minutes} minutes or until this task ends:`,
						...lines,
						approval.away
							? "The user is away: anything outside it is refused at once. Do not retry a refused action; go on without it and say at the end what is left."
							: "The user stays: anything outside it is asked about.",
					].join("\n"),
					true,
				);
			},
		});

	/** /perm scope: the scope in effect and how to end it, or the screen to set one, with lines ready to pick. */
	const scopeCommand = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify(t("A task scope needs the interactive mode."), "warning");
			return;
		}
		// A scope in effect, or still held by background tasks after its task.
		const current = liveScope() ?? [...heldScopes.values()].filter((held) => held.until > Date.now()).at(-1);
		if (current) {
			const left = Math.max(1, Math.round((current.until - Date.now()) / 60_000));
			const end = t("End the task scope now");
			const choice = await ctx.ui.select(
				[
					t(`Task scope: ${left} min left, ${current.away ? "you are away" : "you stay"}`),
					...current.operations.map((operation) => `  • ${visibleText(operation.what)}`),
					...current.rules.map((rule) => `  • ${visibleText(ruleIntent(rule, ctx.cwd))}`),
					"",
					...scopeLimits(readLimited(ctx)).map((line) => t(line)),
				].join("\n"),
				[end, t("Keep it")],
			);
			if (choice === end) endScope(ctx, true);
			return;
		}
		if (state.mode === "safe") {
			ctx.ui.notify(t("Safe mode changes no file, whatever a scope allows. Change the mode first."), "warning");
			return;
		}
		const operations: ScopeOperation[] = [
			{ what: t("Change the project's files"), commands: [], writes: ["**"], hosts: [] },
		];
		if (activeSandbox(ctx))
			operations.push({
				what: t("Run commands in the sandbox, except dangerous ones"),
				commands: ["*"],
				writes: [],
				hosts: [],
			});
		const approval = await approveScope(ctx, { operations, minutes: 60, from: "user" });
		if (approval) {
			startScope(ctx, approval, agentRunning);
			ctx.ui.notify(t(`Task scope set for your next task (${approval.minutes} min at most).`));
		}
	};

	// -------------------------------------------------------------------------
	// /perm command
	// -------------------------------------------------------------------------

	/**
	 * fork: sets the session's mode. "unrestricted" needs its warning accepted once (in a
	 * dialog; stored in the global config). Returns false when it was not set.
	 */
	let modeRequests = 0;
	const setMode = async (ctx: ExtensionContext, mode: Mode): Promise<boolean> => {
		if (mode === "unrestricted" && readConfig(globalConfigPath())?.unrestrictedAccepted !== true) {
			if (!ctx.hasUI) return false;
			const enable = t("Enable unrestricted mode");
			const choice = await ctx.ui.select(t(UNRESTRICTED_WARNING), [enable, t("Cancel")]);
			if (choice !== enable) return false;
			if (
				!(await savedOrReported(
					ctx,
					async () => await saveConfigFields(globalConfigPath(), { unrestrictedAccepted: true }),
				))
			)
				return false;
		}
		// fork: a mode whose sandbox does not work applies, with its commands blocked, as at start.
		const request = ++modeRequests;
		const sandboxFailure = await applySandbox(ctx, mode, hostPolicy, granted(ctx));
		// fork: a mode chosen while this one's sandbox was starting wins.
		if (request !== modeRequests) return false;
		if (sandboxFailure) ctx.ui.notify(brokenSandboxMessage(mode, sandboxFailure, ctx.hasUI), "error");
		state.mode = mode;
		persist();
		updateStatus(ctx);
		return true;
	};

	// fork: Prism's network tools follow the host policy of the commands. The
	// tool may be allowed without a question (broad); each destination still is, as for a sandboxed command.
	pi.events.on(TOOL_NETWORK_EVENT, (data) => {
		const request = data as ToolNetworkRequest;
		if (state.mode === "unrestricted") return;
		let network: CommandNetwork | undefined;
		const browser = request.browser === true;
		const open = () => {
			network ??= hostPolicy.open({
				toolCallId: request.toolCallId,
				command: request.command,
				nonCommand: true,
				...(browser ? { browser } : {}),
			});
			return network;
		};
		// "Every site in this session" of the browser's question, or a site or every site for the request: public hosts
		// only, and only with the user there.
		const everySite = (name: string) =>
			browser &&
			(browserEverySite || browserRequestEverySite || browserRequestSites.has(name.toLowerCase())) &&
			!scheduledId &&
			!liveScope()?.away &&
			localPortOf(name) === undefined &&
			privateAddressOf(name) === undefined &&
			!isDenied(name, hostPolicy.getSettings());
		request.gate = {
			destination: (url, resolve) =>
				checkDestination(
					url,
					async (name) => everySite(name) || (await open().allows(name)),
					resolve,
					(address) => isDenied(address, hostPolicy.getSettings()),
				),
			provider: (url) => {
				const name = destinationName(url);
				if (isDenied(name, readSandboxSettings().network))
					return `Refused by Prism's network permissions: ${name} is blocked. Nothing was sent.`;
				// fork.9 (CAP-01): unattended, the provider is a destination like any other: in the scope, or refused.
				const task = liveScope();
				if (scheduledId && !task?.operations.some((operation) => matchesHost(name, operation.hosts)))
					return `Refused: ${name} is not among the hosts this scheduled task may reach. Nothing was sent.`;
				return undefined;
			},
			close: () => {
				network?.close();
				hostPolicy.forgetCall(request.toolCallId);
			},
		};
	});

	// fork: the mode chosen in the onboarding applies now and becomes the default. fork
	// unrestricted too, once its warning is accepted, as with /perm.
	pi.events.on(PERMISSION_MODE_EVENT, (data) => {
		const request = data as PermissionModeRequest;
		const chosen = parseMode(request.mode);
		if (!chosen) return;
		request.applied = setMode(request.ctx, chosen).then(async (applied) => {
			if (applied)
				await savedOrReported(
					request.ctx,
					async () => await saveConfigFields(globalConfigPath(), { mode: chosen }),
				);
			return applied;
		});
	});

	// fork: the onboarding starts from the mode in effect, not the default.
	pi.events.on(PERMISSION_MODE_QUERY_EVENT, (data) => {
		(data as PermissionModeQuery).mode = state.mode;
	});

	/** fork: the modes alt+m cycles through; unrestricted only once accepted. */
	const cycleOrder = (): Mode[] =>
		readConfig(globalConfigPath())?.unrestrictedAccepted === true
			? ["ask", "broad", "unrestricted", "safe"]
			: ["ask", "broad", "safe"];

	pi.registerShortcut("alt+m", {
		description: "Cycle the permission mode",
		handler: async (ctx) => {
			const order = cycleOrder();
			const next = order[(order.indexOf(state.mode) + 1) % order.length] ?? "ask";
			if (await setMode(ctx, next))
				ctx.ui.notify(fill("Permission mode: {0} — {1}", t(next), t(MODE_DESCRIPTIONS[next])));
		},
	});

	/**
	 * The permissions in effect, as /perm lists them: the time-limited ones, then the session rules. fork
	 * each has an `id` that names it whatever its place in the list, so the one /perm
	 * showed is the one revoked, even after an earlier one expired.
	 */
	// fork: a label quotes a call's target or a rule made from it.
	const grantsInEffect = (now = Date.now()) =>
		grantsListed(now).map((grant) => ({ ...grant, what: visibleText(grant.what) }));
	const grantsListed = (now: number) => [
		...state.timed
			.filter((grant) => grant.until > now)
			.map((grant) => ({
				id: JSON.stringify(["timed", grant.effect, grant.rule, grant.until]),
				effect: grant.effect,
				what: describeRule(grant.rule, grant.effect),
				scope: t(`${TIMED_MINUTES} minutes`),
				left: t(`${Math.max(1, Math.ceil((grant.until - now) / 60_000))} min left`),
				revoke: () => {
					state.timed = state.timed.filter((other) => other !== grant);
				},
			})),
		...(["allow", "deny"] as const).flatMap((effect) =>
			state[effect].map((rule) => ({
				id: JSON.stringify(["session", effect, rule]),
				effect,
				what: describeRule(rule, effect),
				scope: t("this session"),
				left: "",
				revoke: () => {
					state[effect] = state[effect].filter((other) => other !== rule);
				},
			})),
		),
		...[...dangerAllowed].map(([key, what]) => ({
			id: JSON.stringify(["danger", key]),
			effect: "allow" as const,
			what,
			scope: t("this session"),
			left: "",
			revoke: () => {
				dangerAllowed.delete(key);
			},
		})),
		// fork: hosts answered "in this session" in the sandbox's network question; taken back, their
		// open connections close too.
		...[...hostPolicy.sessionAllowed].map((grant) => ({
			id: JSON.stringify(["host", grant.host, grant.command ?? null]),
			effect: "allow" as const,
			what:
				grant.command === undefined
					? fill("Connect to {0}", grant.host)
					: `${fill("Connect to {0}", grant.host)} (${grant.command})`,
			scope: t("this session"),
			left: "",
			revoke: () => {
				hostPolicy.sessionAllowed.delete(grant);
				hostPolicy.recheck();
			},
		})),
		...(browserEverySite
			? [
					{
						id: JSON.stringify(["browser-every-site"]),
						effect: "allow" as const,
						what: t("Open any site in the browser"),
						scope: t("this session"),
						left: "",
						revoke: () => {
							browserEverySite = false;
						},
					},
				]
			: []),
	];

	/**
	 * fork: /perm without arguments opens the permissions window (perm-view.ts). Choosing the
	 * unrestricted mode for the first time, the rules and the help close it for their own dialog, then
	 * reopen it.
	 */
	const openMenu = async (ctx: ExtensionContext): Promise<void> => {
		for (;;) {
			let height = () => process.stdout.rows ?? 24;
			let columns = () => process.stdout.columns ?? 80;
			const next = await ctx.ui.custom<Mode | PermViewAction | undefined>(
				(tui, _theme, _keybindings, done) => {
					height = () => tui.terminal.rows;
					columns = () => tui.terminal.columns;
					return new PermView({
						mode: () => state.mode,
						defaultMode: () => parseMode(loadConfig(ctx.cwd, ctx.isProjectTrusted()).mode) ?? FALLBACK_MODE,
						verdict: modePolicy,
						// fork: reading outside the project is a row of its own only while it is limited.
						rows:
							readSandboxSettings().read.limit === "project"
								? POLICY_ROWS
								: POLICY_ROWS.filter((row) => row !== "read-outside"),
						grants: () =>
							grantsInEffect().map(({ id, effect, what, scope, left }) => ({ id, effect, what, scope, left })),
						savedRules: () => {
							const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
							return (cfg.allow?.length ?? 0) + (cfg.ask?.length ?? 0) + (cfg.deny?.length ?? 0);
						},
						height: () => height(),
						onMode: async (mode) => {
							if (mode === "unrestricted" && readConfig(globalConfigPath())?.unrestrictedAccepted !== true) {
								done(mode);
								return;
							}
							void (await setMode(ctx, mode));
							tui.requestRender();
						},
						onRevoke: (_index, shown) => {
							grantsInEffect()
								.find((grant) => shown?.id !== undefined && grant.id === shown.id)
								?.revoke();
							persist();
							tui.requestRender();
						},
						onAction: async (action) => {
							if (action !== "keep-default") {
								done(action);
								return;
							}
							if (
								await savedOrReported(
									ctx,
									async () => await saveConfigFields(globalConfigPath(), { mode: state.mode }),
								)
							)
								ctx.ui.notify(fill("Default permission mode: {0} ({1})", t(state.mode), globalConfigPath()));
							tui.requestRender();
						},
						onClose: () => done(undefined),
					});
				},
				{
					overlay: true,
					// The UI resolves overlayOptions once; the TUI reads these getters each render.
					overlayOptions: {
						anchor: "center",
						get width() {
							return Math.min(columns() - 2, PERM_MAX_WIDTH);
						},
						maxHeight: "100%",
					},
				},
			);
			if (next === undefined) return;
			// fork: the rules open in their editor in /settings, which this window leaves to.
			if (next === "rules") {
				if (await showRules(ctx)) return;
			} else if (next === "help") await showHelp(ctx, "back");
			else if (next !== "keep-default" && !(await setMode(ctx, next))) {
				ctx.ui.notify(t("Unrestricted mode not enabled."), "warning");
			}
		}
	};

	/**
	 * fork: the saved rules open in their editor in /settings, as /perm does; true when it
	 * opened. Without the interactive mode, the rules are listed, those of the session too.
	 */
	const showRules = async (ctx: ExtensionContext): Promise<boolean> => {
		if (ctx.hasUI && openSettings({ domain: "permissions", item: "perm-rules", open: true })) return true;
		const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const list = (rules: readonly string[] | undefined) => (rules?.length ? rules.join(", ") : t("none"));
		const timed = state.timed.filter((grant) => grant.until > Date.now());
		const lines = [
			fill("Mode: {0}", t(state.mode)),
			"",
			fill("This session, allowed: {0}", list(state.allow)),
			fill("This session, blocked: {0}", list(state.deny)),
			fill(
				"For {0} minutes: {1}",
				String(TIMED_MINUTES),
				list(timed.map((grant) => `${t(grant.effect)} ${grant.rule}`)),
			),
			"",
			fill("Saved, allowed: {0}", list(cfg.allow)),
			fill("Saved, asks: {0}", list(cfg.ask)),
			fill("Saved, blocked: {0}", list(cfg.deny)),
			...(cfg.protectedPaths?.length ? [fill("Protected paths: {0}", list(cfg.protectedPaths))] : []),
			fill("Default mode: {0}", t(cfg.mode ?? FALLBACK_MODE)),
			"",
			fill("Every project: {0}", globalConfigPath()),
			ctx.isProjectTrusted()
				? fill("This project: {0}", projectConfigPath(ctx.cwd))
				: fill("This project: {0} (not read: the project is not trusted)", projectConfigPath(ctx.cwd)),
			t("Close"),
		];
		await ctx.ui.select(t("Permission rules"), lines);
		return false;
	};

	/** fork: the commands of /perm, with what each does. */
	const HELP_COMMANDS: ReadonlyArray<readonly [string, string]> = [
		["/perm", "Permissions & sandbox in /settings: mode, rules, protected paths, sandbox"],
		["/perm window", "window: modes, what each allows, current permissions, rules, help (alt+m cycles the mode)"],
		["/perm status", "status"],
		["/perm scope", "task scope: set one for the next task, or end the one in effect"],
		["/perm mode <mode>", "set mode for this session"],
		["/perm default <mode>", "set the default mode (global config)"],
		["/perm allow <rule>", "session-only allow rule"],
		["/perm deny <rule>", "session-only deny rule"],
		[
			"/perm always <rule> [-g]",
			"save permission for matching actions in this trusted project, otherwise globally; -g always saves globally",
		],
		[
			"/perm never <rule> [-g]",
			"save a block rule for matching actions in this trusted project, otherwise globally; -g always saves globally",
		],
		["/perm rules", "saved rules, in /settings"],
		["/perm clear", "clear session and 15-minute permissions"],
	];

	/** fork: the help, in the interface's language, as Markdown. */
	const helpText = (): string =>
		[
			`## ${t("Commands")}`,
			"",
			...HELP_COMMANDS.map(([command, what]) => `- \`${command}\` — ${t(what)}`),
			"",
			`## ${t("Modes")}`,
			"",
			...MODES.map((mode) => `- **${mode}** — ${t(MODE_DESCRIPTIONS[mode])}`),
			"",
			t('"yolo" is accepted as the former name of broad.'),
			"",
			`## ${t("Rules")}`,
			"",
			t(
				"Rule syntax: `tool` or `tool(glob)`. A glob is a matching pattern: `*` matches text; in file paths it stays in one folder, while `**` includes subfolders. Examples: `bash(npm run test*)`, `write(src/**)`.",
			),
			"",
			fill(
				"Saved in `{0}` for every project, and in `{1}` for a project.",
				globalConfigPath(),
				`<project>/${CONFIG_DIR_NAME}/permissions.json`,
			),
			"",
			t(
				"These rules check action patterns. They are not a sandbox (an isolated environment that limits access to your computer).",
			),
			t(
				"A command you allow can access anything your user account can access, including auth.json, which stores sign-in details. These rules do not isolate your secrets from the agent.",
			),
		].join("\n");

	/**
	 * fork: the help in a reader that scrolls, instead of a list whose every line could be
	 * chosen. Without the window (RPC), its lines go to a list as before.
	 */
	const showHelp = async (ctx: ExtensionContext, closeLabel: "back" | "close"): Promise<void> => {
		const text = helpText();
		if (!hasInteractiveClient(ctx)) {
			await ctx.ui.select(t("Permission system — help"), [...text.split("\n"), t("Close")]);
			return;
		}
		await ctx.ui.custom<void>(
			(tui, _theme, _keybindings, done) =>
				new DocReader(
					t("Permission system — help"),
					text,
					() => Math.max(8, Math.floor(tui.terminal.rows * 0.75)),
					() => done(undefined),
					() => tui.requestRender(),
					closeLabel,
				),
			{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" } },
		);
	};

	/** /perm's window for a client that draws its own (rpc-builtins.ts, perm_*). */
	const panelFor = (ctx: ExtensionContext): PermissionsPanel => ({
		settings: () => settingsDeps(ctx),
		snapshot: () => {
			const settings = readSandboxSettings();
			const trusted = ctx.isProjectTrusted();
			const sandbox = sessionSandbox(ctx.sessionManager);
			const current = liveScope() ?? [...heldScopes.values()].filter((held) => held.until > Date.now()).at(-1);
			const savedFrom = (where: "project" | "global") => {
				const file = where === "global" ? globalConfigPath() : projectConfigPath(ctx.cwd);
				const read = where === "global" || trusted;
				const cfg = (read ? readConfig(file) : undefined) ?? {};
				return { where, file, read, allow: cfg.allow ?? [], ask: cfg.ask ?? [], deny: cfg.deny ?? [] };
			};
			return {
				mode: state.mode,
				defaultMode: parseMode(loadConfig(ctx.cwd, trusted).mode) ?? FALLBACK_MODE,
				unrestrictedAccepted: readConfig(globalConfigPath())?.unrestrictedAccepted === true,
				modes: VIEW_MODES.map((mode) => ({
					mode,
					label: t(MODE_LABELS[mode]),
					summary: t(MODE_SUMMARIES[mode]),
					sandbox: settings.modes[mode] ? "on" : "off",
				})),
				sandbox: {
					running: activeSandbox(ctx) !== undefined,
					problem: sandbox && "error" in sandbox ? sandbox.error : sandboxSettingsProblem(),
				},
				rows: (settings.read.limit === "project"
					? POLICY_ROWS
					: POLICY_ROWS.filter((row) => row !== "read-outside")
				).map((row) => ({
					row,
					label: t(ROW_LABELS[row]),
					verdicts: Object.fromEntries(VIEW_MODES.map((mode) => [mode, modePolicy(mode, row)])) as Record<
						Mode,
						Verdict
					>,
				})),
				grants: grantsInEffect().map(({ effect, what, scope, left }, index) => ({
					index,
					effect,
					what,
					scope,
					left,
				})),
				sessionRules: { allow: [...state.allow], deny: [...state.deny] },
				saved: [savedFrom("project"), savedFrom("global")],
				scope: current && {
					minutesLeft: Math.max(1, Math.round((current.until - Date.now()) / 60_000)),
					away: current.away,
					items: [
						...current.operations.map((operation) => visibleText(operation.what)),
						...current.rules.map((rule) => visibleText(ruleIntent(rule, ctx.cwd))),
					],
					limits: scopeLimits(readLimited(ctx)).map((line) => t(line)),
				},
				shortcuts: [{ keys: "alt+m", action: t("Cycle the permission mode") }],
				help: helpText(),
			};
		},
		setMode: async (mode, asDefault) => {
			if (!(await setMode(ctx, mode))) return false;
			if (asDefault)
				return await savedOrReported(ctx, async () => await saveConfigFields(globalConfigPath(), { mode }));
			return true;
		},
		revoke: (index, what) => {
			const grant = grantsInEffect()[index];
			// The list may have changed since the client read it: only the grant it showed is taken back.
			if (!grant || grant.what !== what) return false;
			grant.revoke();
			persist();
			updateStatus(ctx);
			return true;
		},
		rule: async ({ action, effect, rule, where }) => {
			const parsed = parseRule(rule);
			if (!parsed) return fill('Invalid rule: "{0}" (expected: tool or tool(glob))', rule);
			if (where === "session") {
				if (effect === "ask") return t("A rule for this session allows or blocks; it cannot ask.");
				state[effect] =
					action === "add"
						? [...new Set([...state[effect], parsed.label])]
						: state[effect].filter((other) => other !== parsed.label);
				persist();
				return undefined;
			}
			if (where === "project" && !ctx.isProjectTrusted())
				return t("This project is not trusted: its permission rules are not read.");
			const file = where === "project" ? projectConfigPath(ctx.cwd) : globalConfigPath();
			try {
				await updateConfigFile(file, (cfg) => ({
					...cfg,
					[effect]:
						action === "add"
							? [...new Set([...(cfg[effect] ?? []), parsed.label])]
							: (cfg[effect] ?? []).filter((other) => other !== parsed.label),
				}));
				return undefined;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
		sandbox: async (mode, on) => {
			try {
				saveGlobalSetting(["sandbox", "modes", mode], on);
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			if (mode === state.mode) {
				const failure = await applySandbox(ctx, mode, hostPolicy, granted(ctx));
				updateStatus(ctx);
				if (failure) return brokenSandboxMessage(mode, failure, false);
			}
			return undefined;
		},
		scope: () => scopeCommand(ctx),
		endScope: () => endScope(ctx, true),
	});

	pi.registerCommand("perm", {
		description: "Permissions: mode, default, rules (menu); alt+m cycles the mode",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";
			const rest = parts.slice(1);
			const globalOnly = rest.includes("-g");
			const ruleArg = rest.filter((x) => x !== "-g").join(" ");

			const notify = (msg: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(msg, type);

			const ruleFile = (trusted: boolean) =>
				!globalOnly && trusted ? projectConfigPath(ctx.cwd) : globalConfigPath();

			switch (sub) {
				case "": {
					// fork: /perm opens Permissions & sandbox in /settings; /perm window
					// opens the modes and the permissions in effect.
					if (ctx.hasUI && openSettings({ domain: "permissions" })) return;
					if (ctx.hasUI) {
						await openMenu(ctx);
						return;
					}
					// Without a UI, fall through to the status.
					const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
					const projLoaded = ctx.isProjectTrusted() && readConfig(projectConfigPath(ctx.cwd)) !== undefined;
					notify(
						[
							fill("Permissions: {0}", t(modeText(state))),
							fill("session: {0} allow, {1} deny", String(state.allow.length), String(state.deny.length)),
							fill(
								"config: {0}{1} (mode: {2})",
								globalConfigPath(),
								projLoaded ? ` + ${projectConfigPath(ctx.cwd)}` : "",
								t(cfg.mode ?? "broad (default)"),
							),
							t("use /perm help for commands"),
						].join("\n"),
					);
					return;
				}
				case "scope": {
					await scopeCommand(ctx);
					return;
				}
				case "window": {
					if (ctx.hasUI) await openMenu(ctx);
					else notify(t("The permissions window needs the interactive mode."), "warning");
					return;
				}
				case "help": {
					await showHelp(ctx, "close");
					return;
				}
				case "status": {
					const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
					notify(
						[
							fill("Permissions: {0}", t(modeText(state))),
							fill("session: {0} allow, {1} deny", String(state.allow.length), String(state.deny.length)),
							fill("config: {0} (default mode: {1})", globalConfigPath(), t(cfg.mode ?? FALLBACK_MODE)),
						].join("\n"),
					);
					return;
				}
				case "mode":
				case "default": {
					const m = parseMode(rest[0]);
					if (!m) {
						notify(fill("Usage: /perm {0} <{1}>", sub, MODES.join("|")), "error");
						return;
					}
					if (!(await setMode(ctx, m))) {
						notify(t("Unrestricted mode not enabled."), "warning");
						return;
					}
					if (sub === "default") {
						if (await savedOrReported(ctx, async () => await saveConfigFields(globalConfigPath(), { mode: m })))
							notify(fill("Default permission mode: {0} ({1})", t(m), globalConfigPath()));
						return;
					}
					notify(fill("Permission mode: {0}", t(modeText(state))));
					return;
				}
				case "allow":
				case "deny": {
					const rule = parseRule(ruleArg);
					if (!rule) {
						notify(fill('Invalid rule: "{0}" (expected: tool or tool(glob))', ruleArg), "error");
						return;
					}
					if (sub === "allow") state.allow = [...new Set([...state.allow, rule.label])];
					else state.deny = [...new Set([...state.deny, rule.label])];
					persist();
					notify(fill("{0} rule for this session: {1}", t(sub === "allow" ? "Allow" : "Deny"), rule.label));
					return;
				}
				case "always":
				case "never": {
					const rule = parseRule(ruleArg);
					if (!rule) {
						notify(fill('Invalid rule: "{0}" (expected: tool or tool(glob))', ruleArg), "error");
						return;
					}
					const file = ruleFile(ctx.isProjectTrusted());
					if (
						!(await savedOrReported(
							ctx,
							async () => await saveRuleToConfig(file, rule.label, sub === "always" ? "allow" : "deny"),
						))
					)
						return;
					notify(fill('Saved {0} rule "{1}" to {2}', t(sub === "always" ? "allow" : "deny"), rule.label, file));
					return;
				}
				case "rules": {
					await showRules(ctx);
					return;
				}
				case "clear": {
					state.allow = [];
					state.deny = [];
					state.timed = [];
					persist();
					notify(t("Cleared session permission rules"));
					return;
				}
				default:
					notify(fill("Unknown subcommand: {0} (try /perm help)", sub), "error");
			}
		},
	});
}

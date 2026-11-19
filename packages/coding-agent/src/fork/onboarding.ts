/**
 * fork: the onboarding. A short guided set of choices (language, theme, display,
 * permissions, optional modules, connection), opened at the first start of someone with no model
 * yet, and again at any time with /onboarding. Every step can be left as it is; Esc skips the rest.
 *
 * Choices are written where /settings, /perm and /login already keep them: settings.json,
 * permissions.json (through the permissions extension) and the login flow of the interactive mode.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Component,
	foregroundAnsi,
	getKeybindings,
	rgbColor,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { type InterfaceMode, SettingsManager } from "../core/settings-manager.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { type AnimationStyle, animationOn } from "./animations.ts";
import { moduleNeeds } from "./feature-state.ts";
import { fill, labelled, resolveLanguage, setLanguage, t } from "./i18n/index.ts";
import { hasNativeMenus } from "./interactive-client.ts";
import { chooseOnboardingAnswers } from "./onboarding-native.ts";

/**
 * The permission mode when no flag, saved session or config names one.
 * Kept here, not in permissions.ts, because that module imports this one: one source for both.
 */
export const DEFAULT_PERMISSION_MODE = "broad";

/** Event the permissions extension listens to, so the chosen mode applies to this session too. */
export const PERMISSION_MODE_EVENT = "prism:permission-mode";

export interface PermissionModeRequest {
	mode: "ask" | "safe" | "broad" | "unrestricted";
	ctx: ExtensionContext;
	/**
	 * fork: set by the listener; resolves once the mode applies, or to false when it does not
	 * (unrestricted needs the user to accept its warning).
	 */
	applied?: Promise<boolean>;
}

/**
 * fork: event the permissions extension answers with the mode in effect in this
 * session, which alt+m or a resumed session may have set apart from the default in permissions.json.
 */
export const PERMISSION_MODE_QUERY_EVENT = "prism:permission-mode-query";

export interface PermissionModeQuery {
	/** Set by the listener. */
	mode?: PermissionModeRequest["mode"];
}

/**
 * fork: event the tutorial (tutorial.ts) listens to, so the onboarding's last step can start it.
 * The listener sets `opened`, which resolves once the tutorial closes: true when it ran a command on closing.
 */
export const TUTORIAL_EVENT = "prism:tutorial";

export interface TutorialRequest {
	ctx: ExtensionContext;
	opened?: Promise<boolean>;
}

/**
 * What only the mode can do: open /login, and preview or apply a theme setting (pairs included). The RPC mode
 * only opens the window's tutorial: the window does not ask for the terminal's theme.
 */
export interface OnboardingHost {
	login?: () => void;
	previewTheme?: (setting: string) => void;
	applyTheme?: (setting: string) => void;
	/** opens the Prism window's own tutorial, where the terminal's would be a terminal view. */
	openTutorial?: () => void;
}

let host: OnboardingHost | undefined;

export function setOnboardingHost(next: OnboardingHost | undefined): void {
	host = next;
}

export function onboardingPath(agentDir: string): string {
	return join(agentDir, "onboarding.json");
}

export function isOnboardingDone(agentDir: string): boolean {
	return existsSync(onboardingPath(agentDir));
}

export function markOnboardingDone(agentDir: string, skipped: boolean): void {
	const path = onboardingPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), skipped }, null, 2)}\n`);
}

/** Opened by itself only for someone new: never done (or skipped) before, and no model to talk to. */
export function shouldOpenAtStartup(agentDir: string, availableModels: number): boolean {
	return availableModels === 0 && !isOnboardingDone(agentDir);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export interface Option {
	value: string;
	label: string;
	detail?: string;
	/** fork: what to know before choosing it, shown in full under the list while it is selected. */
	note?: string;
}

export interface Step {
	id: string;
	title: string;
	help: string;
	options: Option[];
	/** Toggle list: Enter flips the row under the cursor, the last row continues. */
	toggles?: boolean;
}

export type Answers = Record<string, string | string[]>;

/**
 * Optional modules the onboarding offers, by built-in extension name. fork: more of them;
 * every module stays in /settings › Modules.
 */
const MODULES: Option[] = [
	{ value: "web", label: "Web search", detail: "search and read pages; works without a key (Exa)" },
	{ value: "pi-lsp", label: "Language servers", detail: "code diagnostics from the servers installed for a project" },
	{ value: "mcp", label: "MCP servers", detail: "tools from the servers listed in mcp.json" },
	{ value: "pi-plan-mode", label: "Plan mode", detail: "the model plans and only reads until you approve" },
	{ value: "pi-goal", label: "Goal mode", detail: "a goal the model keeps working towards across turns" },
	{ value: "checkpoints", label: "Checkpoints", detail: "file snapshots before edits, to roll back" },
	{ value: "notify", label: "Desktop notifications", detail: "when the model finishes or waits for you" },
	{ value: "memory", label: "Memory", detail: "notes the model keeps between sessions" },
];
/**
 * fork: computer use, a step of its own. Each module says what it needs; once the onboarding
 * ends, Prism says what to install for the ones turned on (`computerUseNeeds`).
 */
const COMPUTER: Option[] = [
	{
		value: "browser",
		label: "Your browser",
		detail: "web pages in your own browser, in tabs of their own (Prism extension)",
		note: "Needs Prism's extension in Firefox, Chromium, Chrome, Brave or Zen: /browser setup walks you through it.",
	},
	{
		value: "desktop",
		label: "A desktop of its own",
		detail: "graphical programs on a desktop apart from yours",
		note: "Needs labwc, a small Wayland compositor; Prism says how to install it.",
	},
	{
		value: "user-desktop",
		label: "Your desktop",
		detail: "your own screen, pointer and keyboard, when you agree",
		note: "Needs a Wayland session: Hyprland, GNOME or KDE.",
	},
];
const OFF_BY_DEFAULT = new Set(["memory", "browser", "desktop", "user-desktop"]);
export const CONTINUE = "continue";

/**
 * `model` names the current model when it is configured
 * .
 */
export function buildSteps(model: string | undefined, withTutorial = false): Step[] {
	const steps: Step[] = [
		{
			id: "language",
			title: "Language",
			help: "The language of Prism's own interface. The model answers in the language you write in.",
			options: [
				{ value: "auto", label: "Automatic", detail: "from the system language" },
				{ value: "en", label: "English" },
				{ value: "fr", label: "Français" },
			],
		},
		{
			id: "theme",
			title: "Theme",
			help: "Colours of the interface. You see each one as you move.",
			options: [
				{ value: "prism-light/prism", label: "Automatic", detail: "light or dark, like the terminal" },
				{ value: "prism", label: "Dark" },
				{ value: "prism-light", label: "Light" },
				{ value: "system", label: "Terminal colours", detail: "uses the terminal's own palette" },
			],
		},
		{
			id: "display",
			title: "Display",
			help: "How much technical detail Prism shows. You can switch at any time in /settings.",
			options: [
				{ value: "simple", label: "Simple", detail: "plain words, fewer technical messages" },
				{ value: "advanced", label: "Advanced", detail: "token counts, raw statuses and full details" },
			],
		},
		{
			id: "permissions",
			title: "Permissions",
			help: "What the model may do without asking you first. Change it later with /perm or alt+m.",
			options: [
				// fork: ask first, none recommended, unrestricted offered.
				{ value: "ask", label: "Ask", detail: "reading and safe commands run; edits and other commands ask" },
				{ value: "safe", label: "Read only", detail: "the model reads and searches; anything else is blocked" },
				{ value: "broad", label: "Broad", detail: "ordinary actions run without asking; dangerous ones still ask" },
				{
					value: "unrestricted",
					label: "Unrestricted",
					detail: "nothing asks, not even dangerous actions",
					note: "No confirmation for anything, including deleting files, sudo and writes outside the project. After this setup, a warning says what it allows, and the mode applies only if you accept it there.",
				},
			],
		},
		{
			id: "modules",
			title: "Optional modules",
			help: "Enter turns a module on or off. Changes apply when onboarding finishes, or at the next start during first-run setup. Every module is in /settings › Modules.",
			options: [...MODULES, { value: CONTINUE, label: "Continue" }],
			toggles: true,
		},
		{
			id: "computer",
			title: "Computer use",
			help: "The agent can use your browser, a desktop of its own, or yours. Enter turns each on or off; at the end, Prism says what to install, if anything. Every one is in /settings › Computer use.",
			options: [...COMPUTER, { value: CONTINUE, label: "Continue" }],
			toggles: true,
		},
		{
			id: "connection",
			title: "Model",
			help: model
				? fill(
						"{0} is configured. Prism has not contacted it yet: your first message shows whether it answers. You can connect another model now or later with /login.",
						model,
					)
				: "Prism needs a model: a server on this computer or your network, a subscription or an API key.",
			options: model
				? [
						{ value: "keep", label: "Keep this model" },
						{ value: "login", label: "Connect another model now", detail: "opens /login" },
					]
				: [
						{ value: "login", label: "Connect a model now", detail: "opens /login" },
						{ value: "later", label: "Later", detail: "with /login" },
					],
		},
	];
	// fork: the tutorial is offered last, when it is loaded.
	if (withTutorial) {
		steps.push({
			id: "tutorial",
			title: "Tutorial",
			help: "Nine short modules show how to work with Prism, each with an exercise. Open it later with /tutorial or from « more… ».",
			options: [
				{ value: "start", label: "Start the tutorial" },
				{ value: "later", label: "Later", detail: "with /tutorial" },
			],
		});
	}
	return steps;
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

/** The spectrum drawn under the title; it traces itself in when a step opens. */
const SPECTRUM: Array<[number, number, number]> = [
	[232, 72, 85],
	[245, 140, 60],
	[245, 210, 80],
	[95, 200, 110],
	[70, 140, 230],
	[150, 90, 210],
];
const BEAM_MS = 450;

export interface WizardOptions {
	steps: Step[];
	initial: Answers;
	animate: boolean;
	animationStyle?: AnimationStyle;
	requestRender: () => void;
	onPreview: (stepId: string, value: string) => void;
	onDone: (answers: Answers) => void;
	onSkip: (answers: Answers) => void;
}

export class OnboardingWizard implements Component {
	private index = 0;
	private cursor = 0;
	private readonly answers: Answers;
	private readonly options: WizardOptions;
	private stepStart = Date.now();
	private timer?: ReturnType<typeof setInterval>;

	constructor(options: WizardOptions) {
		this.options = options;
		this.answers = { ...options.initial };
		this.enterStep();
	}

	get stepId(): string {
		return this.step.id;
	}

	private get step(): Step {
		return this.options.steps[this.index]!;
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private enterStep(): void {
		const answer = this.answers[this.step.id];
		const found = this.step.options.findIndex((option) => option.value === answer);
		this.cursor = this.step.toggles ? 0 : Math.max(0, found);
		// What is shown matches the cursor again after a step was left with only a preview.
		if (!this.step.toggles) this.options.onPreview(this.step.id, this.step.options[this.cursor]!.value);
		this.stepStart = Date.now();
		if (!this.options.animate || this.timer) return;
		this.timer = setInterval(() => {
			if (Date.now() - this.stepStart > BEAM_MS) this.dispose();
			this.options.requestRender();
		}, 33);
	}

	private beam(width: number): string {
		const length = Math.max(1, Math.min(width - 2, 36));
		const shown = this.options.animate
			? Math.min(length, Math.round((length * (Date.now() - this.stepStart)) / BEAM_MS))
			: length;
		let line = " ";
		const count =
			this.options.animationStyle === "wipe" || this.options.animationStyle === "dissolve" ? length : shown;
		for (let i = 0; i < count; i++) {
			const style = this.options.animationStyle;
			const visible =
				!this.options.animate ||
				(style === "dissolve" ? (i * 17) % length < shown : style === "wipe" ? i >= length - shown : i < shown);
			if (!visible) {
				line += " ";
				continue;
			}
			const [r, g, b] = SPECTRUM[Math.floor((i * SPECTRUM.length) / length)]!;
			line += `${foregroundAnsi(rgbColor(r, g, b), theme.getColorMode())}━\x1b[39m`;
		}
		return line;
	}

	render(width: number): string[] {
		const step = this.step;
		const wrapped = (text: string) => wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => ` ${line}`);
		const position = fill("Step {0} of {1}", String(this.index + 1), String(this.options.steps.length));
		const lines = [
			"",
			...wrapped(`${theme.bold(theme.fg("accent", t("Welcome to Prism")))}  ${theme.fg("dim", position)}`),
			this.beam(width),
			"",
			...wrapped(theme.bold(t(step.title))),
			...wrapped(theme.fg("muted", t(step.help))),
			"",
		];
		const selected = this.answers[step.id];
		step.options.forEach((option, i) => {
			const here = i === this.cursor;
			const mark = step.toggles
				? option.value === CONTINUE
					? "  "
					: Array.isArray(selected) && selected.includes(option.value)
						? "[x] "
						: "[ ] "
				: option.value === selected
					? "● "
					: "○ ";
			const label = `${here ? theme.fg("accent", "❯ ") : "  "}${mark}${here ? theme.fg("accent", t(option.label)) : t(option.label)}`;
			const detail = option.detail ? theme.fg("dim", ` ${t(option.detail)}`) : "";
			const row = ` ${label}${detail}`;
			lines.push(visibleWidth(row) <= width ? row : truncateToWidth(row, width, "…"));
		});
		const note = step.options[this.cursor]?.note;
		if (note) lines.push("", ...wrapped(theme.fg("warning", t(note))));
		lines.push("");
		const back = this.index > 0 ? ` · ← ${t("back")}` : "";
		lines.push(...wrapped(theme.fg("dim", `↑↓ · ${t("enter: choose")}${back} · ${t("esc: skip the rest")}`)));
		return lines;
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const step = this.step;
		if (keys.matches(data, "tui.select.cancel")) {
			this.dispose();
			this.options.onSkip(this.answers);
			return;
		}
		if (keys.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (keys.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (keys.matches(data, "tui.editor.cursorLeft")) {
			if (this.index === 0) return;
			this.index--;
			this.enterStep();
		} else if (keys.matches(data, "tui.select.confirm")) {
			const option = step.options[this.cursor]!;
			if (step.toggles && option.value !== CONTINUE) {
				const current = new Set((this.answers[step.id] as string[] | undefined) ?? []);
				if (current.has(option.value)) current.delete(option.value);
				else current.add(option.value);
				this.answers[step.id] = [...current];
			} else {
				if (!step.toggles) this.answers[step.id] = option.value;
				if (this.index === this.options.steps.length - 1) {
					this.dispose();
					this.options.onDone(this.answers);
					return;
				}
				this.index++;
				this.enterStep();
			}
		} else {
			return;
		}
		this.options.requestRender();
	}

	private move(delta: number): void {
		const step = this.step;
		this.cursor = Math.max(0, Math.min(step.options.length - 1, this.cursor + delta));
		if (!step.toggles) this.options.onPreview(step.id, step.options[this.cursor]!.value);
	}
}

// ---------------------------------------------------------------------------
// Reading and writing the choices
// ---------------------------------------------------------------------------

function readPermissionMode(agentDir: string): string {
	try {
		const mode = (JSON.parse(readFileSync(join(agentDir, "permissions.json"), "utf8")) as { mode?: unknown }).mode;
		return mode === "ask" || mode === "safe" || mode === "broad" || mode === "unrestricted"
			? mode
			: DEFAULT_PERMISSION_MODE;
	} catch {
		return DEFAULT_PERMISSION_MODE;
	}
}

/** Built-in modules of a step (`modules` by default) on in the user `extensions` setting, or by default. */
export function enabledModules(extensionPaths: readonly string[], group: readonly Option[] = MODULES): string[] {
	return group
		.map((module) => module.value)
		.filter((name) => {
			const entry = [...extensionPaths].reverse().find((path) => path.replace(/^[+!-]/, "") === `builtin:${name}`);
			return entry ? entry.startsWith("+") : !OFF_BY_DEFAULT.has(name);
		});
}

/** `sessionMode`: the permission mode in effect in this session, shown and compared instead of the default. */
export function currentAnswers(
	settings: SettingsManager,
	agentDir: string,
	hasModel: boolean,
	sessionMode?: string,
): Answers {
	return {
		language: settings.getLanguage(),
		theme: settings.getThemeSetting() ?? "prism-light/prism",
		display: settings.getInterfaceMode(),
		permissions: sessionMode ?? readPermissionMode(agentDir),
		modules: enabledModules(settings.getGlobalSettings().extensions ?? []),
		computer: enabledModules(settings.getGlobalSettings().extensions ?? [], COMPUTER),
		connection: hasModel ? "keep" : "login",
	};
}

/** Writes the choices that differ from the current ones; returns whether modules changed. */
export function applyAnswers(settings: SettingsManager, before: Answers, after: Answers): { modulesChanged: boolean } {
	if (after.language !== before.language) settings.setLanguage(String(after.language));
	if (after.theme !== before.theme) settings.setTheme(String(after.theme));
	if (after.display !== before.display) settings.setInterfaceMode(after.display as InterfaceMode);
	const was = new Set([...((before.modules as string[]) ?? []), ...((before.computer as string[]) ?? [])]);
	const now = new Set([...((after.modules as string[]) ?? []), ...((after.computer as string[]) ?? [])]);
	const changed = [...MODULES, ...COMPUTER]
		.map((module) => module.value)
		.filter((name) => was.has(name) !== now.has(name));
	if (changed.length > 0) {
		const kept = (settings.getGlobalSettings().extensions ?? []).filter(
			(entry) => !changed.includes(entry.replace(/^[+!-]/, "").replace(/^builtin:/, "")),
		);
		settings.setExtensionPaths([...kept, ...changed.map((name) => `${now.has(name) ? "+" : "-"}builtin:${name}`)]);
	}
	return { modulesChanged: changed.length > 0 };
}

/**
 * What to install or do for the computer use modules just turned on, one line each: the
 * missing parts (labwc, a Wayland session), and the browser's extension, which /browser setup installs.
 */
export function computerUseNeeds(before: Answers, after: Answers, cwd: string, needs = moduleNeeds): string[] {
	const was = new Set((before.computer as string[]) ?? []);
	const lines: string[] = [];
	for (const module of (after.computer as string[]) ?? []) {
		if (was.has(module)) continue;
		const label = t(COMPUTER.find((option) => option.value === module)?.label ?? module);
		const missing = needs(module, cwd);
		if (missing) lines.push(`${labelled(label, missing)}.`);
		else if (module === "browser") lines.push(fill("{0}: install Prism's extension with /browser setup.", label));
	}
	return lines;
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

/** A notice for the onboarding of the next session start, once the modules reloaded (module state outlives it). */
let afterReload: { text: string; level: "info" | "warning" } | undefined;

export default function onboarding(pi: ExtensionAPI): void {
	const run = async (ctx: ExtensionContext, reload?: () => Promise<void>) => {
		if (!ctx.hasUI) {
			ctx.ui.notify(t("The onboarding needs the interactive interface."), "warning");
			return;
		}
		const agentDir = getAgentDir();
		const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
		// fork: a model counts once it has a key or a server, as for the first-start check.
		const current = ctx.model;
		const configured =
			current &&
			ctx.modelRegistry
				.getAvailable()
				.some((model) => model.provider === current.provider && model.id === current.id)
				? `${current.provider}/${current.id}`
				: undefined;
		const query: PermissionModeQuery = {};
		pi.events.emit(PERMISSION_MODE_QUERY_EVENT, query);
		const before = currentAnswers(settings, agentDir, configured !== undefined, query.mode);
		const withTutorial = pi.getCommands().some((command) => command.name === "tutorial");
		const steps = buildSteps(configured, withTutorial);
		// the Prism window asks the same steps on native screens, but the terminal's theme: the
		// window shows Prism's light or dark theme, as Window › Theme chooses.
		const result = hasNativeMenus(ctx)
			? await chooseOnboardingAnswers(
					ctx,
					steps.filter((step) => step.id !== "theme"),
					before,
				)
			: await ctx.ui.custom<{ answers: Answers; skipped: boolean }>((tui, _theme, _keys, done) => {
					const wizard = new OnboardingWizard({
						steps,
						initial: before,
						animate: animationOn(
							{
								animations: settings.getAnimations(),
								animationsOff: settings.getAnimationsOff(),
								animationStyles: settings.getAnimationStyles(),
							},
							"intro",
						),
						animationStyle: settings.getAnimationStyles().intro,
						requestRender: () => tui.requestRender(),
						onPreview: (stepId, value) => {
							if (stepId === "theme") host?.previewTheme?.(value);
							if (stepId === "language") setLanguage(resolveLanguage(value));
						},
						onDone: (answers) => done({ answers, skipped: false }),
						onSkip: (answers) => done({ answers, skipped: true }),
					});
					return wizard;
				});
		// Esc keeps what was chosen in the steps already passed and the current values for the rest.
		const answers = result ?? { answers: before, skipped: true };
		setLanguage(resolveLanguage(answers.answers.language));
		const { modulesChanged } = applyAnswers(settings, before, answers.answers);
		await settings.flush();
		// After the write above, so the interactive mode's own settings save the same theme. An unchanged
		// theme is only shown again (a preview may still be on screen), not written.
		const theme = String(answers.answers.theme);
		if (theme !== before.theme) host?.applyTheme?.(theme);
		else host?.previewTheme?.(theme);
		let refused = false;
		if (answers.answers.permissions !== before.permissions) {
			const request: PermissionModeRequest = {
				mode: answers.answers.permissions as PermissionModeRequest["mode"],
				ctx,
			};
			pi.events.emit(PERMISSION_MODE_EVENT, request);
			// Before the dialogs below: unrestricted asks to accept its warning first. fork
			// every mode is awaited, so the reload below starts once the mode applies and is saved.
			const applied = await request.applied;
			refused = request.mode === "unrestricted" && applied === false;
		}
		markOnboardingDone(agentDir, answers.skipped);
		// One notice: a second info notice replaces the first on screen.
		const again = t("Run /onboarding to go through these choices again.");
		const login = !answers.skipped && answers.answers.connection === "login";
		// What computer use needs goes in the same notice as the rest, which would replace it.
		const needs = answers.skipped ? [] : computerUseNeeds(before, answers.answers, ctx.cwd);
		const lines = [
			...(needs.length ? [t("To finish setting up computer use:"), ...needs] : []),
			refused ? `${t("Unrestricted mode not enabled.")} ${again}` : again,
			...(needs.length && login && !host?.login ? [t("Connect a model with /login.")] : []),
			...(needs.length && modulesChanged && !reload ? [t("Module changes apply at the next start.")] : []),
		];
		ctx.ui.notify(lines.join("\n"), needs.length ? "warning" : "info");
		// The browser's setup is one Enter away.
		const browserOn = (answers.answers.computer as string[] | undefined)?.includes("browser");
		if (!answers.skipped && browserOn && !(before.computer as string[]).includes("browser"))
			ctx.ui.setEditorText("/browser setup");
		if (!needs.length && login && !host?.login) ctx.ui.notify(t("Connect a model with /login."), "info");
		if (!needs.length && modulesChanged && !reload)
			ctx.ui.notify(t("Module changes apply at the next start."), "info");
		// Last: ctx is stale after a reload.
		const tutorial = !answers.skipped && answers.answers.tutorial === "start";
		if (modulesChanged && reload) {
			// The reload clears the notice shown before it, and ctx is stale after it: the reloaded onboarding says it.
			const after = [
				...(needs.length ? [t("To finish setting up computer use:"), ...needs] : []),
				...(tutorial ? [t("Start the tutorial with /tutorial.")] : []),
			];
			afterReload = after.length ? { text: after.join("\n"), level: needs.length ? "warning" : "info" } : undefined;
			await reload();
		} else if (tutorial && hasNativeMenus(ctx) && host?.openTutorial) {
			host.openTutorial();
		} else if (tutorial) {
			// Before the login, which opens its own dialogs. A command chosen in the tutorial runs instead.
			const request: TutorialRequest = { ctx };
			pi.events.emit(TUTORIAL_EVENT, request);
			if (await request.opened) {
				if (login) ctx.ui.notify(t("Connect a model with /login."), "info");
				return;
			}
		}
		if (login) host?.login?.();
	};

	pi.registerCommand("onboarding", {
		description: t("Go through the first-start choices again: language, theme, permissions, modules, model"),
		handler: async (_args, ctx) => run(ctx, () => ctx.reload()),
	});

	pi.on("session_start", (event, ctx) => {
		if (event.reason === "reload" && afterReload && ctx.hasUI) {
			ctx.ui.notify(afterReload.text, afterReload.level);
			afterReload = undefined;
		}
		if (event.reason !== "startup" || !ctx.hasUI) return;
		if (!shouldOpenAtStartup(getAgentDir(), ctx.modelRegistry.getAvailable().length)) return;
		// Not awaited: the session finishes starting while the onboarding is open.
		void run(ctx);
	});
}

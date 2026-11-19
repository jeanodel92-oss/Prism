/**
 * fork: why a module's feature is missing, told in the same words in /settings > Modules,
 * in /help and when its command is typed, so a user does not conclude the feature does not exist. Besides on:
 *
 * - off: the module is turned off in /settings > Modules;
 * - unavailable: the module is on, but something it needs is missing (a language server for pi-lsp);
 * - unsupported: the module is on and works through tools, but the model cannot call tools, so the
 *   capability gates give it none.
 *
 * Off comes first, then unavailable (installing something fixes it whatever the model), then unsupported.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { BUILTIN_PATH_PREFIX } from "../core/source-info.ts";
import { type Gate, gatesFor } from "./capability-gates.ts";
import { desktopHelperPath } from "./desktop/helper.ts";
import { hyprlandSocketPath } from "./desktop/hyprland.ts";
import { portalSession } from "./desktop/portal-desktop.ts";
import { fill, t } from "./i18n/index.ts";
import { onPath, ownLspCommands, projectExtensions, serversFor } from "./lsp-setup.ts";

export type FeatureState =
	| { state: "on" }
	| { state: "off" }
	| { state: "unavailable"; why: string }
	| { state: "unsupported"; why: string };

/**
 * The commands each module adds, so that a command typed while its module is off is recognized. A module
 * without commands (its feature is a tool or a part of the prompt) is still listed in /settings > Modules.
 */
export const MODULE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
	"llama.cpp": ["llama"],
	mcp: ["mcp"],
	trace: ["trace"],
	budgets: ["budget"],
	prism: ["tutorial"],
	files: ["files"],
	"lsp-setup": ["lsp-setup"],
	"project-continuity": ["init", "handoff"],
	checkpoints: ["undo", "checkpoints"],
	background: ["bg", "bg-clear"],
	memory: ["memory", "memory-edit", "memory-project"],
	"session-search": ["sessions"],
	"session-state": ["state"],
	web: ["web-key"],
	agents: ["agents"],
	skills: ["skills"],
	"pi-lsp": ["lsp"],
	"pi-context-inspector": ["context"],
	"pi-plan-mode": ["plan"],
	"pi-goal": ["goal"],
	schedule: ["schedule"],
	"portable-export": ["export-zip"],
	browser: ["browser"],
	desktop: ["desktop"],
	"user-desktop": [],
};

/** The module a command belongs to, or undefined for a command of no module. */
export function commandModule(command: string): string | undefined {
	return Object.keys(MODULE_COMMANDS).find((module) => MODULE_COMMANDS[module]!.includes(command));
}

/** What a module needs, checked while it is on: the missing part in plain words, or undefined. */
const DEPENDENCIES: Readonly<Record<string, (cwd: string) => string | undefined>> = {
	// A project with code and no server ready for any of its languages: pi-lsp has nothing to start.
	"pi-lsp": (cwd) => {
		const servers = serversFor(projectExtensions(cwd), onPath, ownLspCommands(cwd));
		return servers.length > 0 && !servers.some((server) => server.ready)
			? t("no language server for this project's languages is installed; /lsp-setup shows how")
			: undefined;
	},
	// the agent's desktop is a labwc started by Prism, driven by Prism's helper.
	desktop: () => {
		if (!onPath("labwc")) {
			const install = installCommand("labwc");
			return install
				? fill("labwc is not installed; install it with: {0}", install)
				: t("labwc is not installed (Fedora, Debian, Ubuntu, Arch: package labwc)");
		}
		try {
			desktopHelperPath();
			return undefined;
		} catch {
			return t("prism-desktop-helper is missing from this installation");
		}
	},
	// fork: the user's own desktop, through Hyprland's socket or the desktop portal.
	"user-desktop": () =>
		hyprlandSocketPath() || portalSession() ? undefined : t("needs a Wayland session (Hyprland, GNOME or KDE)"),
};

/** The command that installs a distribution package here, from the package manager found on PATH. */
export function installCommand(name: string, has: (command: string) => boolean = onPath): string | undefined {
	const managers: Array<[string, string]> = [
		["dnf", `sudo dnf install ${name}`],
		["apt", `sudo apt install ${name}`],
		["pacman", `sudo pacman -S ${name}`],
		["zypper", `sudo zypper install ${name}`],
	];
	return managers.find(([tool]) => has(tool))?.[1];
}

/** What a module needs and is missing here, in plain words (the onboarding's computer use step), or undefined. */
export function moduleNeeds(module: string, cwd: string): string | undefined {
	return DEPENDENCIES[module]?.(cwd);
}

export interface FeatureContext {
	/** The modules loaded in this session. */
	enabled: ReadonlySet<string>;
	/** The modules that registered tools for the model. */
	withTools: ReadonlySet<string>;
	/** The current model and its tool calls, when one is chosen. */
	model?: { id: string; tools?: Gate };
	cwd: string;
}

/** Each module's state; a dependency is checked once per call of this function, when first asked. */
export function featureStates(context: FeatureContext): (module: string) => FeatureState {
	const known = new Map<string, FeatureState>();
	const compute = (module: string): FeatureState => {
		if (!context.enabled.has(module)) return { state: "off" };
		const missing = DEPENDENCIES[module]?.(context.cwd);
		if (missing) return { state: "unavailable", why: missing };
		const tools = context.model?.tools;
		// The capability gates take the tools away; without them, the model still gets them.
		if (context.withTools.has(module) && tools?.state === "no" && context.enabled.has("capability-gates")) {
			const id = context.model!.id;
			return {
				state: "unsupported",
				why:
					tools.source === "you"
						? fill(
								"tool calls are turned off for {0} in /model-settings, and this module works through tools",
								id,
							)
						: fill("{0} cannot call tools (its server says so), and this module works through tools", id),
			};
		}
		return { state: "on" };
	};
	return (module) => {
		let state = known.get(module);
		if (!state) {
			state = compute(module);
			known.set(module, state);
		}
		return state;
	};
}

/** The parts of a running session the states are read from. */
export interface LoadedSession {
	extensionRunner: {
		getExtensionPaths(): string[];
		getAllRegisteredTools(): Array<{ sourceInfo: { path: string } }>;
	};
	model: Model<Api> | undefined;
	sessionManager: { getCwd(): string };
}

/** The states in a running session: its loaded modules, their tools and the current model. */
export function sessionFeatureStates(session: LoadedSession): (module: string) => FeatureState {
	const builtin = (path: string) =>
		path.startsWith(BUILTIN_PATH_PREFIX) ? [path.slice(BUILTIN_PATH_PREFIX.length)] : [];
	const runner = session.extensionRunner;
	const model = session.model;
	return featureStates({
		enabled: new Set(runner.getExtensionPaths().flatMap(builtin)),
		withTools: new Set(runner.getAllRegisteredTools().flatMap((tool) => builtin(tool.sourceInfo.path))),
		model: model && { id: model.id, tools: gatesFor(model)?.tools },
		cwd: session.sessionManager.getCwd(),
	});
}

/**
 * The states /settings > Modules shows: a module that is off but could not work here (labwc missing, no Wayland
 * session) is unavailable already, so the user learns it before turning it on, not at the next opening once it is
 * loaded. /help and typed commands keep "off" first.
 */
export function settingsFeatureStates(session: LoadedSession): (module: string) => FeatureState {
	const states = sessionFeatureStates(session);
	const cwd = session.sessionManager.getCwd();
	// Checked once per opening, like the states: the rows ask at each frame.
	const known = new Map<string, FeatureState>();
	return (module) => {
		let state = known.get(module);
		if (!state) {
			state = states(module);
			const missing = state.state === "off" ? DEPENDENCIES[module]?.(cwd) : undefined;
			if (missing) state = { state: "unavailable", why: missing };
			known.set(module, state);
		}
		return state;
	};
}

/** The short mark next to a module in /settings > Modules; off has its switch. */
export function stateTag(state: FeatureState): string | undefined {
	if (state.state === "unavailable") return t("unavailable");
	if (state.state === "unsupported") return t("not for this model");
	return undefined;
}

/** The sentence that opens a module's description in /settings > Modules. */
export function stateSentence(state: FeatureState): string | undefined {
	if (state.state === "unavailable") return t(`Unavailable: ${state.why}.`);
	if (state.state === "unsupported") return t(`Not supported by this model: ${state.why}.`);
	return undefined;
}

/**
 * A /help entry whose module is not on: the state, put before the action so a narrow terminal still shows it,
 * and where to look, in place of the usual detail.
 */
export function helpState(state: FeatureState): { label: string; hint: string } | undefined {
	if (state.state === "off") return { label: "off", hint: "turn it on in /settings › Modules" };
	if (state.state === "unavailable") return { label: "unavailable", hint: "/settings › Modules says why" };
	if (state.state === "unsupported") {
		// Short, like the mark in /settings: a narrow /help keeps the action visible after it.
		return { label: "not for this model", hint: "/settings › Modules says why" };
	}
	return undefined;
}

/**
 * What to tell a user who typed `/name`, and whether to stop there: a command of a module that is off does
 * not exist, so without this the text went to the model as a message. `exists` is whether something else
 * (a replacing extension, a prompt template) answers to that name; it then runs without a word.
 */
export function commandNotice(
	name: string,
	exists: boolean,
	stateOf: (module: string) => FeatureState,
): { text: string; stop: boolean } | undefined {
	const module = commandModule(name);
	if (!module) return undefined;
	const state = stateOf(module);
	if (state.state === "off") {
		return exists
			? undefined
			: // fork.9 QA: the module's name as /settings › Modules shows it ("fichiers" for files, in French).
				{
					text: fill("/{0}: the {1} module is off. Turn it on in /settings › Modules.", name, t(module)),
					stop: true,
				};
	}
	if (!exists) return undefined;
	if (state.state === "unavailable") return { text: fill("/{0} is unavailable: {1}.", name, state.why), stop: false };
	if (state.state === "unsupported") {
		return { text: fill("/{0} is not supported by this model: {1}.", name, state.why), stop: false };
	}
	return undefined;
}

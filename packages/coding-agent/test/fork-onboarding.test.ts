// fork: the onboarding, its steps, where the choices go, and when it opens by itself.
// fork: "Ask" was "recommended", unrestricted was missing, the web module said it needed a key,
// few modules were offered, and a selected model without a key counted as available.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getAgentDir } from "../src/config.ts";
import type { ExtensionCommandContextActions, ExtensionFactory } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { installCommand } from "../src/fork/feature-state.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import onboarding, {
	type Answers,
	applyAnswers,
	buildSteps,
	CONTINUE,
	computerUseNeeds,
	currentAnswers,
	enabledModules,
	OnboardingWizard,
	onboardingPath,
	PERMISSION_MODE_EVENT,
	type PermissionModeRequest,
	searchNeeds,
	setOnboardingHost,
	shouldOpenAtStartup,
} from "../src/fork/onboarding.ts";
import { sealPermState } from "../src/fork/perm-seal.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { initTheme, type Theme, theme as uiTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
/** The rendered lines as one line of plain text, so a wrapped sentence reads whole. */
const flat = (lines: string[]) =>
	lines
		.join(" ")
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\s+/g, " ");
const ENTER = "\r";
const ESC = "\x1b";
const LEFT = "\x1b[D";

describe("fork: onboarding", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		initTheme();
		agentDir = mkdtempSync(join(tmpdir(), "prism-onboarding-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		setOnboardingHost(undefined);
		setLanguage("en");
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	const initial: Answers = {
		language: "auto",
		theme: "prism-light/prism",
		display: "simple",
		permissions: "ask",
		modules: ["web", "pi-lsp"],
		connection: "login",
	};

	function wizard(model?: string) {
		const seen = {
			previews: [] as string[],
			done: undefined as Answers | undefined,
			skipped: undefined as Answers | undefined,
		};
		const component = new OnboardingWizard({
			steps: buildSteps(model),
			initial,
			animate: false,
			requestRender: () => {},
			onPreview: (step, value) => seen.previews.push(`${step}=${value}`),
			onDone: (answers) => {
				seen.done = answers;
			},
			onSkip: (answers) => {
				seen.skipped = answers;
			},
		});
		return {
			component,
			seen,
			keys: (...keys: string[]) => {
				for (const key of keys) component.handleInput(key);
			},
		};
	}

	it("opens by itself only for someone with no model who never went through it", () => {
		expect(shouldOpenAtStartup(agentDir, 0)).toBe(true);
		expect(shouldOpenAtStartup(agentDir, 2)).toBe(false);
		const { component, keys } = wizard();
		keys(ESC);
		expect(component.stepId).toBe("language");
	});

	it("shows memory off by default and includes it after explicit opt-in", () => {
		expect(enabledModules([])).not.toContain("memory");
		expect(enabledModules(["+builtin:memory"])).toContain("memory");
	});

	it("walks every step; arrows preview, left goes back, Enter on modules toggles", () => {
		const { component, seen, keys } = wizard();
		keys(DOWN, DOWN, ENTER); // Français
		expect(component.stepId).toBe("theme");
		keys(DOWN); // Dark, previewed
		expect(seen.previews).toContain("theme=prism");
		keys(LEFT);
		expect(component.stepId).toBe("language");
		// Going back drops the theme only previewed: the cursor and the preview return to the saved answer.
		keys(ENTER);
		expect(seen.previews.at(-1)).toBe("theme=prism-light/prism");
		keys(DOWN, ENTER, DOWN, ENTER); // Dark, Advanced
		expect(component.stepId).toBe("permissions");
		keys(DOWN, ENTER); // Read only
		expect(component.stepId).toBe("modules");
		keys(...Array(7).fill(DOWN), ENTER); // memory on
		keys(DOWN, ENTER); // Continue
		// fork: computer use, a step of its own.
		expect(component.stepId).toBe("computer");
		keys(ENTER, DOWN, DOWN, DOWN, ENTER); // browser on, Continue
		// the privacy step.
		expect(component.stepId).toBe("privacy");
		keys(DOWN, ENTER, DOWN, ENTER); // Exa on, Continue
		expect(component.stepId).toBe("connection");
		keys(DOWN, ENTER); // Later
		expect(seen.done).toEqual({
			language: "fr",
			theme: "prism",
			display: "advanced",
			permissions: "safe",
			modules: ["web", "pi-lsp", "memory"],
			computer: ["browser"],
			privacy: ["exa"],
			connection: "later",
		});
	});

	// without web search, where searches would go is no question to ask.
	it("leaves the Exa row out of the privacy step once web search is turned off", () => {
		const { component, seen, keys } = wizard();
		keys(ENTER, ENTER, ENTER, ENTER); // language, theme, display, permissions as they are
		expect(component.stepId).toBe("modules");
		keys(ENTER, ...Array(8).fill(DOWN), ENTER); // web search off, Continue
		keys(DOWN, DOWN, DOWN, ENTER); // computer use: Continue
		expect(component.stepId).toBe("privacy");
		const screen = component.render(80).join("\n");
		expect(screen).toContain("Model list from pi.dev");
		expect(screen).not.toContain("Exa");
		keys(DOWN, DOWN, DOWN, ENTER); // the cursor stops on Continue, the last of two rows
		expect(component.stepId).toBe("connection");
		keys(ENTER);
		expect(seen.done?.modules).toEqual(["pi-lsp"]);
	});

	it("Esc skips the rest and keeps what was chosen so far", () => {
		const { seen, keys } = wizard();
		keys(DOWN, DOWN, ENTER, ESC);
		expect(seen.done).toBeUndefined();
		expect(seen.skipped?.language).toBe("fr");
		expect(seen.skipped?.theme).toBe("prism-light/prism");
	});

	it("fits a 40-column terminal on every step", () => {
		const { component, keys } = wizard("faux/model");
		for (const step of buildSteps("faux/model")) {
			for (const line of component.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
			if (step.toggles) keys(...step.options.slice(1).map(() => DOWN));
			if (step.id !== "connection") keys(ENTER);
		}
		expect(
			buildSteps("faux/model")
				.at(-1)
				?.options.map((option) => option.value),
		).toEqual(["keep", "login"]);
		expect(
			buildSteps(undefined)
				.find((step) => step.id === "modules")
				?.options.at(-1)?.value,
		).toBe(CONTINUE);
	});

	// fork: the computer use step, and what to install for the modules turned on.
	it("says what computer use needs once its modules are turned on, with the distribution's install command", () => {
		const step = buildSteps(undefined).find((candidate) => candidate.id === "computer")!;
		expect(step.options.map((option) => option.value)).toEqual(["browser", "desktop", "user-desktop", CONTINUE]);
		expect(
			buildSteps(undefined)
				.find((candidate) => candidate.id === "modules")!
				.options.map((option) => option.value),
		).not.toContain("browser");
		const needs = (module: string) =>
			module === "desktop" ? "labwc is not installed; install it with: sudo dnf install labwc" : undefined;
		const lines = computerUseNeeds(
			{ computer: ["user-desktop"] },
			{ computer: ["user-desktop", "desktop", "browser"] },
			"/",
			needs,
		);
		expect(lines).toEqual([
			"A desktop of its own: labwc is not installed; install it with: sudo dnf install labwc.",
			"Your browser: install Prism's extension with /browser setup.",
		]);
		expect(installCommand("labwc", (tool) => tool === "apt")).toBe("sudo apt install labwc");
		expect(installCommand("labwc", () => false)).toBeUndefined();
	});

	it("explains when module choices take effect", () => {
		expect(buildSteps(undefined).find((step) => step.id === "modules")?.help).toBe(
			"Enter turns a module on or off. Changes apply when onboarding finishes, or at the next start during first-run setup. Every module is in /settings › Modules.",
		);
	});

	it("offers the four permission modes, none of them recommended, and says what unrestricted allows", () => {
		const step = buildSteps(undefined).find((candidate) => candidate.id === "permissions")!;
		expect(step.options.map((option) => option.value)).toEqual(["ask", "safe", "broad", "unrestricted"]);
		expect(step.options.map((option) => option.label).join(" ")).not.toMatch(/recommended/i);
		const { component, keys } = wizard();
		keys(ENTER, ENTER, ENTER, DOWN, DOWN, DOWN);
		const text = flat(component.render(100));
		expect(text).toContain("including deleting files, sudo and writes outside the project");
		expect(text).toContain("the mode applies only if you accept it there");
	});

	it("offers more modules, says web search needs no key", () => {
		const modules = buildSteps(undefined).find((step) => step.id === "modules")!.options;
		expect(modules.map((option) => option.value)).toEqual(
			expect.arrayContaining(["mcp", "pi-plan-mode", "pi-goal", "checkpoints", "notify"]),
		);
		expect(modules.find((option) => option.value === "web")?.detail).not.toMatch(/needs .*key/);
		const { component, keys } = wizard();
		keys(ENTER, ENTER, ENTER, ENTER);
		expect(component.stepId).toBe("modules");
		expect(component.render(100).join("\n")).not.toContain("relay");
	});

	// language servers, MCP, Goal mode and the sandbox are defined where they appear.
	it("defines language servers, MCP and Goal mode on their rows, and the sandbox at the permissions step", () => {
		const steps = buildSteps(undefined);
		const note = (value: string) =>
			steps.find((step) => step.id === "modules")!.options.find((option) => option.value === value)?.note;
		expect(note("pi-lsp")).toMatch(/^A language server is a program/);
		expect(note("mcp")).toMatch(/^MCP is a common way/);
		expect(note("pi-goal")).toMatch(/\/goal pause/);
		expect(steps.find((step) => step.id === "permissions")!.help).toMatch(/shut in a sandbox/);
		setLanguage("fr");
		const { component, keys } = wizard();
		// The screen's words, without colours or line breaks.
		const text = () =>
			component
				.render(64)
				.join(" ")
				.replace(/\x1b\[[0-9;]*m/g, "")
				.replace(/\s+/g, " ");
		keys(DOWN, DOWN, ENTER, ENTER, ENTER); // Français, theme, display
		expect(text()).toContain("enfermées dans une sandbox");
		keys(ENTER, DOWN); // permissions, then the language servers' row
		expect(text()).toContain("Un serveur de langage est un programme");
	});

	it("writes only the choices that changed to settings.json", async () => {
		const settings = SettingsManager.create(agentDir, agentDir);
		applyAnswers(settings, initial, {
			...initial,
			language: "fr",
			display: "advanced",
			modules: ["web", "pi-lsp", "memory"],
		});
		await settings.flush();
		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(saved).toEqual({
			language: "fr",
			interfaceMode: "advanced",
			extensions: ["+builtin:memory"],
		});
		expect(enabledModules(saved.extensions)).toEqual([
			"web",
			"pi-lsp",
			"mcp",
			"pi-plan-mode",
			"pi-goal",
			"checkpoints",
			"notify",
			"memory",
		]);
	});

	// the services Prism contacts besides the model, on by default.
	it("reads and writes the privacy choices: pi.dev's model list, and Exa or the user's SearXNG", async () => {
		const settings = SettingsManager.create(agentDir, agentDir);
		const before = currentAnswers(settings, agentDir, true);
		expect(before.privacy).toEqual(["catalog", "exa"]);
		const step = buildSteps(undefined).find((candidate) => candidate.id === "privacy")!;
		expect(step.toggles).toBe(true);
		expect(step.options.map((option) => option.value)).toEqual(["catalog", "exa", "continue"]);

		const after = { ...before, privacy: [] };
		expect(applyAnswers(settings, before, after, agentDir).modulesChanged).toBe(true);
		expect(searchNeeds(settings, before, after)).toContain("/web-key searxng");
		await settings.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
			modelCatalogRefresh: false,
			webSearchProvider: "searxng",
		});
		expect(currentAnswers(settings, agentDir, true).privacy).toEqual([]);

		// Back on: the catalog setting is removed (on is the default), searches go to Exa again.
		expect(applyAnswers(settings, after, before, agentDir).modulesChanged).toBe(true);
		expect(searchNeeds(settings, after, before)).toBeUndefined();
		await settings.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({ webSearchProvider: "exa" });
		// Unchanged choices write nothing.
		expect(applyAnswers(settings, before, before, agentDir).modulesChanged).toBe(false);
	});

	it("leaves the search provider alone and asks for no SearXNG address when web search is turned off", async () => {
		const settings = SettingsManager.create(agentDir, agentDir);
		const before = currentAnswers(settings, agentDir, true);
		const modules = (before.modules as string[]).filter((name) => name !== "web");
		// The Exa row was not shown, or was unticked before web search was turned off: no provider change either way.
		for (const privacy of [["catalog", "exa"], ["catalog"]]) {
			const after = { ...before, modules, privacy };
			applyAnswers(settings, before, after, agentDir);
			expect(searchNeeds(settings, before, after)).toBeUndefined();
		}
		await settings.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
			extensions: ["-builtin:web"],
		});
	});

	/** Runs /onboarding, answering each step with the given keys; returns what it showed and did. */
	async function runOnboarding(
		steps: string[][],
		options: {
			withConfiguredAuth?: boolean;
			accept?: boolean;
			/** The session's own mode, apart from the default in permissions.json. */
			sessionMode?: string;
			/** In place of the permissions extension. */
			permissions?: ExtensionFactory;
			/** What /onboarding's reload of the extensions does. */
			reload?: () => void;
		} = {},
	) {
		const harness = await createHarness({
			withConfiguredAuth: options.withConfiguredAuth,
			extensionFactories: [
				{ name: "permissions", factory: options.permissions ?? permissionsExtension },
				{ name: "onboarding", factory: onboarding },
			],
		});
		harnesses.push(harness);
		if (options.sessionMode) {
			// fork: sealed, as the state this Prism saved is.
			const saved = { mode: options.sessionMode, allow: [], deny: [], timed: [] };
			harness.session.sessionManager.appendCustomEntry("perm-state", {
				...saved,
				seal: sealPermState(getAgentDir(), saved),
			});
		}
		const statuses = new Map<string, string | undefined>();
		const notes: string[] = [];
		const theme: string[] = [];
		const screens: string[] = [];
		const selects: string[] = [];
		let logins = 0;
		setOnboardingHost({
			login: () => logins++,
			previewTheme: () => {},
			applyTheme: (setting) => theme.push(setting),
		});
		await harness.session.bindExtensions({
			...(options.reload && {
				commandContextActions: {
					reload: async () => options.reload?.(),
				} as unknown as ExtensionCommandContextActions,
			}),
			uiContext: createTestUiContext({
				notify: (text) => notes.push(text),
				setStatus: (key, text) => statuses.set(key, text),
				select: async (title, choices) => {
					selects.push(title);
					return options.accept ? choices[0] : choices.at(-1);
				},
				custom: async <T>(
					factory: (
						tui: TUI,
						theme: Theme,
						keys: KeybindingsManager,
						done: (result: T) => void,
					) => Component | Promise<Component>,
				) =>
					new Promise<T>((resolve) => {
						const tui = { requestRender: () => {} } as unknown as TUI;
						const component = factory(tui, uiTheme, new KeybindingsManager({}), resolve) as Component;
						for (const step of steps) {
							screens.push(flat(component.render(100)));
							for (const key of step) component.handleInput?.(key);
						}
					}),
			}),
		});
		await harness.session.prompt("/onboarding");
		const permissions = () => JSON.parse(readFileSync(join(agentDir, "permissions.json"), "utf8"));
		const sessionMode = () =>
			harness.session.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === "perm-state"
						? [(entry.data as { mode: string }).mode]
						: [],
				)
				.at(-1);
		return { statuses, notes, theme, screens, selects, logins: () => logins, permissions, sessionMode };
	}

	const toContinue = buildSteps(undefined)[4]!
		.options.slice(1)
		.map(() => DOWN);
	const toComputerContinue = buildSteps(undefined)[5]!
		.options.slice(1)
		.map(() => DOWN);
	const toPrivacyContinue = buildSteps(undefined)[6]!
		.options.slice(1)
		.map(() => DOWN);

	it("/onboarding saves the choices, applies the permission mode now and opens /login when asked", async () => {
		// English, Dark, Simple, Read only, modules, connect another model. With no mode configured the session is in
		// broad, the step's choice: one step up is Read only.
		const run = await runOnboarding([
			[DOWN, ENTER],
			[DOWN, ENTER],
			[ENTER],
			[UP, ENTER],
			[ENTER, DOWN, ENTER, ...toContinue, ENTER],
			[...toComputerContinue, ENTER],
			[...toPrivacyContinue, ENTER],
			[DOWN, ENTER],
		]);

		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ language: "en" });
		expect(run.theme).toEqual(["prism"]);
		expect(run.permissions().mode).toBe("safe");
		expect([...run.statuses.values()].join(" ")).toContain("safe");
		expect(existsSync(onboardingPath(agentDir))).toBe(true);
		expect(run.logins()).toBe(1);
		expect(run.notes.some((note) => note.includes("/onboarding"))).toBe(true);
	});

	const toUnrestricted = [
		[ENTER],
		[ENTER],
		[ENTER],
		[DOWN, DOWN, DOWN, ENTER],
		[...toContinue, ENTER],
		[...toComputerContinue, ENTER],
		[...toPrivacyContinue, ENTER],
		[ENTER],
	];

	it("/onboarding applies unrestricted only once its warning is accepted", async () => {
		const accepted = await runOnboarding(toUnrestricted, { accept: true });
		expect(accepted.selects).toHaveLength(1);
		expect(accepted.selects[0]).toContain("not a sandbox");
		expect(accepted.permissions()).toMatchObject({ mode: "unrestricted", unrestrictedAccepted: true });
		expect([...accepted.statuses.values()].join(" ")).toContain("unrestricted");
		expect(accepted.notes.join(" ")).not.toContain("Unrestricted mode not enabled.");
	});

	it("/onboarding keeps the previous mode when the unrestricted warning is refused", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		const refused = await runOnboarding(toUnrestricted, { accept: false });
		expect(refused.selects).toHaveLength(1);
		expect(refused.permissions()).toEqual({ mode: "broad" });
		expect(refused.notes).toContain(
			"Unrestricted mode not enabled. Run /onboarding to go through these choices again.",
		);
	});

	// Handoff « À corriger »: with no answer from the permissions extension, the step preselected "ask"
	// although the default mode became broad on 2026-11-18.
	it("preselects the default mode when none is saved, and a saved one as is", () => {
		const settings = SettingsManager.inMemory();
		expect(currentAnswers(settings, agentDir, true).permissions).toBe("broad");
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "ask" }));
		expect(currentAnswers(settings, agentDir, true).permissions).toBe("ask");
		writeFileSync(join(agentDir, "permissions.json"), "{");
		expect(currentAnswers(settings, agentDir, true).permissions).toBe("broad");
	});

	// the step showed the default of permissions.json, not the session's own mode,
	// so confirming "Read only" over a broad session changed nothing.
	it("/onboarding starts from the session's mode and applies the one confirmed", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "safe" }));
		// Broad is shown as chosen: one step up is Read only.
		const run = await runOnboarding(
			[
				[ENTER],
				[ENTER],
				[ENTER],
				[UP, ENTER],
				[...toContinue, ENTER],
				[...toComputerContinue, ENTER],
				[...toPrivacyContinue, ENTER],
				[ENTER],
			],
			{
				sessionMode: "broad",
			},
		);
		expect(run.sessionMode()).toBe("safe");
		expect([...run.statuses.values()].join(" ")).toContain("safe");
	});

	// only unrestricted was awaited; the reload for the modules could start before another mode applied.
	it("/onboarding reloads the modules only once the chosen mode applies", async () => {
		const log: string[] = [];
		const permissions: ExtensionFactory = (pi) => {
			log.push("load");
			pi.events.on(PERMISSION_MODE_EVENT, (data) => {
				const request = data as PermissionModeRequest;
				request.applied = new Promise<boolean>((resolve) =>
					setTimeout(() => {
						log.push(`applied ${request.mode}`);
						resolve(true);
					}, 50),
				);
			});
		};
		// The step starts on the default mode, broad: one step up is safe.
		await runOnboarding(
			[
				[ENTER],
				[ENTER],
				[ENTER],
				[UP, ENTER],
				[ENTER, DOWN, ENTER, ...toContinue, ENTER],
				[...toComputerContinue, ENTER],
				[...toPrivacyContinue, ENTER],
				[ENTER],
			],
			{
				permissions,
				reload: () => log.push("reload"),
			},
		);
		expect(log).toEqual(["load", "applied safe", "reload"]);
	});

	it("/onboarding names a configured model and does not call a model without a key available", async () => {
		const toModel = [
			[ENTER],
			[ENTER],
			[ENTER],
			[ENTER],
			[...toContinue, ENTER],
			[...toComputerContinue, ENTER],
			[...toPrivacyContinue, ENTER],
			[DOWN, ENTER],
		];
		const configured = await runOnboarding(toModel);
		const shown = configured.screens.at(-1)!;
		expect(shown).toMatch(/faux[^ ]*\/[^ ]+ is configured\. Prism has not contacted it yet/);
		expect(shown).toContain("Keep this model");

		const unconfigured = await runOnboarding(toModel, { withConfiguredAuth: false });
		const missing = unconfigured.screens.at(-1)!;
		expect(missing).toContain("Prism needs a model");
		expect(missing).not.toContain("is configured");
		expect(missing).not.toContain("already available");
	});
});

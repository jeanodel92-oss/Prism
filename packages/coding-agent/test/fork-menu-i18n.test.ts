// fork: the menus, dialogs and notifications of the bundled Goal and Plan plug-ins speak the
// harness's language. the Goal menu showed "No goal is currently set" in a French profile.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import {
	KIT_I18N,
	MENU_I18N,
	translateKitChoices,
	translateKitText,
	translateMenu,
	translateUi,
	UI_I18N,
} from "../src/fork/menu-i18n.ts";
import { dialogFrameHook } from "../src/fork/prism/dialogs.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { GOAL_DONE_STATUSES, goalOn } from "../src/fork/prism/modes.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { loadVendored } from "./fork-vendored-module.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const { formatStatus } = await loadVendored<{
	formatStatus: (goal: unknown, automaticTurnLimit?: number | null) => string;
}>(join(__dirname, "../vendor/forks/pi-goal/dist/chunks/chunk-7FMBWODN.ts"));

type KitFactory = (
	tui: unknown,
	theme: unknown,
	keybindings: KeybindingsManager,
	done: (result: unknown) => void,
) => Component | Promise<Component>;

function entry(name: string) {
	const found = builtInExtensions.find((extension) => typeof extension !== "function" && extension.name === name);
	if (!found || typeof found === "function") throw new Error(`no built-in extension ${name}`);
	return found;
}

/** Each menu screen the plug-in opens, drawn in its Prism window at `width` columns, then closed. */
function screenRecorder(width: number, inputs: string[][] = []) {
	const screens: string[][] = [];
	const rawScreens: string[][] = [];
	const state = createState();
	state.theme = theme;
	state.animates = () => false;
	const frame = dialogFrameHook(state);
	const ui: Partial<ExtensionUIContext> = {
		custom: (async (factory: KitFactory) => {
			const component = await factory(
				{ terminal: { rows: 40 }, requestRender() {} },
				theme,
				new KeybindingsManager({}),
				() => {},
			);
			for (const input of inputs.shift() ?? []) component.handleInput?.(input);
			const rendered = frame(component, width)!.lines;
			rawScreens.push(rendered);
			for (const line of rendered) expect(visibleWidth(line)).toBe(width);
			screens.push(rendered.map((line) => stripAnsi(line)));
			return { kind: "close" };
		}) as ExtensionUIContext["custom"],
	};
	return { screens, rawScreens, ui };
}

describe("fork: Goal and Plan menus in the harness's language", () => {
	let agentDir: string;
	const savedAgentDir = process.env[ENV_AGENT_DIR];
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("prism");
		setKeybindings(new KeybindingsManager({}));
	});
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-menu-i18n-"));
		process.env[ENV_AGENT_DIR] = agentDir;
	});
	afterEach(() => {
		setLanguage("en");
		for (const harness of harnesses.splice(0)) harness.cleanup();
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});
	afterAll(() => setLanguage("en"));

	async function open(name: string, command: string, width: number) {
		const recorder = screenRecorder(width);
		const harness = await createHarness({ extensionFactories: [{ name, factory: entry(name).factory }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(recorder.ui), mode: "tui" });
		await harness.session.prompt(command);
		return recorder.screens;
	}

	it("opens the Goal menu in French, its key hints too", async () => {
		setLanguage("fr");
		const [screen] = await open("pi-goal", "/goal", 64);
		const text = screen!.join("\n");
		expect(screen![1]).toMatch(/^│ Objectif +✕ │$/);
		expect(text).toContain("Aucun objectif n'est défini");
		expect(text).toContain("Lancer un objectif…");
		expect(text).toContain("Fermer");
		expect(screen!.at(-2)).toMatch(/^│ ↑\/↓ parcourir • Entrée choisir • Échap fermer +│$/);
		expect(text).not.toMatch(/No goal|Start a goal|navigate/);
	});

	it("keeps the Goal menu in English for an English profile", async () => {
		const [screen] = await open("pi-goal", "/goal", 100);
		const text = screen!.join("\n");
		expect(text).toContain("No goal is currently set");
		expect(screen!.at(-2)).toMatch(/^│ ↑\/↓ navigate • enter select • esc close +│$/);
	});

	it("opens the Plan menu in French", async () => {
		setLanguage("fr");
		const [screen] = await open("pi-plan-mode", "/plan", 64);
		const text = screen!.join("\n");
		expect(screen![1]).toMatch(/^│ Mode Plan +✕ │$/);
		expect(text).toContain("Lancer le mode Plan");
		expect(text).toContain("Fonctionnement du mode Plan");
		expect(text).not.toMatch(/Start Plan mode|How Plan mode works/);
	});

	it.each(["fr", "en"] as const)(
		"renders every Plan widget state in %s without changing English",
		async (language) => {
			setLanguage(language);
			const plan = "# Keep this plan in English";
			const cases = [
				{
					state: { enabled: true },
					en: [
						"Plan mode: planning",
						"Plan policy allows: bash, read. Model-visible tools stay unchanged.",
						"Finish with plan_mode_complete when decision-ready.",
					],
					fr: [
						"Mode Plan : planification",
						"Le mode Plan autorise : bash, read. Les outils visibles du modèle ne changent pas.",
						"Terminez avec plan_mode_complete quand tout est décidé.",
					],
					status: ["plan active", "plan actif"],
				},
				{
					state: { enabled: true, latestPlan: plan, latestPlanSource: "plan_mode_complete" },
					en: ["Proposed plan ready", "Use /plan to implement, save, revise, or exit Plan mode."],
					fr: ["Plan proposé prêt", "Utilisez /plan pour implémenter, garder, réviser ou quitter le mode Plan."],
					status: ["plan ready", "plan prêt"],
				},
				{
					state: { enabled: false, savedPlan: { plan, source: "plan_mode_complete" } },
					en: ["Plan saved for later", "Use /plan to show, implement, or clear it."],
					fr: ["Plan gardé pour plus tard", "Utilisez /plan pour l'afficher, l'implémenter ou l'effacer."],
					status: ["plan saved", "plan gardé"],
				},
				{
					state: {
						enabled: false,
						activeImplementation: {
							id: "test-plan",
							plan,
							source: "plan_mode_complete",
							startedAt: 1,
							retention: "until-clear",
						},
					},
					en: ["Implementation plan active", "Use /plan to show, replace, or clear it."],
					fr: ["Plan d'implémentation actif", "Utilisez /plan pour l'afficher, le remplacer ou l'effacer."],
					status: ["plan implementing", "plan en implémentation"],
				},
			];
			for (const test of cases) {
				const sessionManager = SessionManager.inMemory();
				sessionManager.appendCustomEntry("plan-mode-state", test.state);
				const harness = await createHarness({
					sessionManager,
					extensionFactories: [{ name: "pi-plan-mode", factory: entry("pi-plan-mode").factory }],
				});
				harnesses.push(harness);
				const statuses: Array<string | undefined> = [];
				const widgets: string[][] = [];
				await harness.session.bindExtensions({
					mode: "tui",
					uiContext: createTestUiContext({
						setStatus: (_key, text) => void statuses.push(text),
						setWidget: (_key, widget) => {
							if (typeof widget !== "function") return;
							const component = widget({} as Parameters<typeof widget>[0], theme);
							for (const width of [40, 64, 140]) {
								const rendered = component.render(width);
								for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
								// Wrapped, not cut: every word is still there at a narrow width.
								const words = (lines: string[]) => lines.join(" ").split(/\s+/).filter(Boolean);
								expect(words(rendered.slice(1).map(stripAnsi))).toEqual(
									words(component.render(1000).slice(1).map(stripAnsi)),
								);
							}
							widgets.push(component.render(140).slice(1).map(stripAnsi));
						},
					}),
				});
				expect(widgets.length).toBeGreaterThan(0);
				expect(widgets.at(-1)).toEqual(test[language]);
				expect(statuses.at(-1)).toBe(test.status[language === "en" ? 0 : 1]);
			}
		},
	);

	it.each(["fr", "en"] as const)("renders Plan tool policies and kit-generated texts in %s", async (language) => {
		setLanguage(language);
		for (const command of ["/plan settings", "/plan tools"]) {
			const recorder = screenRecorder(
				100,
				command.endsWith("settings")
					? [[], [], ["\u001b[B"], ["no-such-tool"]]
					: [[], ["\u001b[B"], ["no-such-tool"]],
			);
			const custom = recorder.ui.custom!;
			let call = 0;
			const harness = await createHarness({
				extensionFactories: [{ name: "pi-plan-mode", factory: entry("pi-plan-mode").factory }],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createTestUiContext({
					custom: (async (...args: Parameters<ExtensionUIContext["custom"]>) => {
						await custom(...args);
						call++;
						if (call === 1 && command.endsWith("settings"))
							return { kind: "transition", transition: { kind: "to", screen: "tools" } };
						if (call < (command.endsWith("settings") ? 4 : 3))
							return { kind: "transition", transition: { kind: "stay" } };
						return { kind: "close" };
					}) as ExtensionUIContext["custom"],
				}),
			});
			await harness.session.prompt(command);
			const text = recorder.screens.at(-3)!.join("\n");
			if (language === "fr") {
				expect(text).toContain("intégré, limité");
				expect(text).toContain("(indisponible)");
				expect(text).toContain("Tapez pour chercher");
				expect(text).not.toMatch(/built-in|\(unavailable\)|Type to search/);
				expect(recorder.screens.at(-1)!.join("\n")).toContain("Aucun résultat");
				expect(recorder.screens.at(-2)!.join("\n")).toContain(
					command.endsWith("settings") ? "Indisponible : Pas encore actif" : "Indisponible : Inactif",
				);
			} else {
				expect(text).toContain("built-in limited · Execute a bash command in the current working directory.");
				expect(text).toContain("(unavailable)");
				expect(text).toContain("Type to search");
				expect(recorder.screens.at(-1)!.join("\n")).toContain("No matching items");
			}
		}
	});

	it("keeps English Plan menu output byte-identical with and without translation hooks", async () => {
		setLanguage("en");
		const recorder = screenRecorder(100);
		const harness = await createHarness({
			extensionFactories: [{ name: "pi-plan-mode", factory: entry("pi-plan-mode").factory }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(recorder.ui), mode: "tui" });
		for (const command of ["/plan", "/plan tools", "/plan settings"]) {
			await harness.session.prompt(command);
			const translated = recorder.rawScreens.at(-1);
			const menuHook: unknown = Reflect.get(globalThis, MENU_I18N);
			const uiHook: unknown = Reflect.get(globalThis, UI_I18N);
			const kitHook: unknown = Reflect.get(globalThis, KIT_I18N);
			try {
				Reflect.deleteProperty(globalThis, MENU_I18N);
				Reflect.deleteProperty(globalThis, UI_I18N);
				Reflect.deleteProperty(globalThis, KIT_I18N);
				await harness.session.prompt(command);
				expect(recorder.rawScreens.at(-1)).toEqual(translated);
			} finally {
				Reflect.set(globalThis, MENU_I18N, menuHook);
				Reflect.set(globalThis, UI_I18N, uiHook);
				Reflect.set(globalThis, KIT_I18N, kitHook);
			}
		}
	});

	// "Back" shown as "Retour" next to an extension's own "Retour" gave that one back.
	it("gives back each of two choices a translation would show alike, in both orders", () => {
		setLanguage("fr");
		for (const options of [
			["Retour", "Back"],
			["Back", "Retour"],
		]) {
			const choices = translateKitChoices(options);
			expect(new Set(choices.shown).size).toBe(2);
			expect(choices.shown.map(choices.original)).toEqual(options);
		}
		expect(translateKitChoices(["Back", "Next"]).shown).toEqual([t("Back"), t("Next")]);
		setLanguage("en");
	});

	it("translates pi-tui-kit's own texts only, by exact text or fixed part", () => {
		setLanguage("fr");
		expect(translateKitText("Type to search")).toBe("Tapez pour chercher");
		expect(translateKitText("  No matching items")).toBe("  Aucun résultat");
		expect(translateKitText("(unavailable) read")).toBe("(indisponible) read");
		expect(translateKitText("  Unavailable: Bloqué")).toBe("  Indisponible : Bloqué");
		expect(translateKitText("grep ✓ current")).toBe("grep ✓ actuel");
		expect(translateKitText("  [-] find (unavailable)")).toBe("  [-] find (indisponible)");
		// Tool names, values and the menu's own (already translated) texts are never matched as patterns.
		for (const text of ["read", "Done", "✓ high", "5 selected", "high · same as plan", "gpt [x] · default", "Off"])
			expect(translateKitText(text)).toBe(text);
		setLanguage("en");
		expect(translateKitText("(unavailable) read")).toBe("(unavailable) read");
	});

	it("leaves no catch-all Plan pattern in the catalog: a value around a fixed word stays as it is", () => {
		setLanguage("fr");
		for (const text of ["✓ Done", "5 selected", "Done · default", "Done · same as plan", "read (unavailable)"])
			expect(t(text)).toBe(text);
	});

	it("builds Plan's compound settings in French, a count in the singular or plural, values as they are", async () => {
		setLanguage("fr");
		for (const [tools, shown] of [
			[["read"], "1 sélectionné"],
			[["read", "grep"], "2 sélectionnés"],
		] as const) {
			writeFileSync(
				join(agentDir, "pi-plan-mode.json"),
				JSON.stringify({
					defaultPlanTools: tools,
					defaultImplementationModel: { provider: "nowhere", modelId: "custom" },
				}),
			);
			const text = (await open("pi-plan-mode", "/plan settings", 100))[0]!.join("\n");
			expect(text).toContain(shown);
			expect(text).toContain("comme le plan · custom [nowhere] indisponible");
			expect(text).toContain("Réflexion (nouvelle session)");
		}
	});

	it("keeps every Plan settings label within the kit's 30-column label column", () => {
		setLanguage("fr");
		const chunk = readFileSync(
			join(__dirname, "../vendor/forks/pi-plan-mode/dist/chunks/interactive-ui-OZA4BHGS.ts"),
			"utf8",
		);
		const settings = chunk.slice(chunk.indexOf("async function showPlanModeSettings"));
		// A setting row: the label the kit lines up, before the value it shows.
		const labels = [...settings.matchAll(/label: "([^"]+)",\s+description: "[^"]*",\s+currentValue/g)].map(
			(match) => match[1]!,
		);
		expect(labels).toContain("Fresh thinking");
		for (const label of labels) expect(visibleWidth(t(label)), label).toBeLessThanOrEqual(30);
	});

	it("translates shown texts only: ids stay, and a setting reads back the plug-in's own value", async () => {
		setLanguage("fr");
		const received: Array<string | undefined> = [];
		const menu = translateMenu({
			start: "main",
			screens: {
				main: () => ({
					kind: "settings",
					title: "Pi Goal Settings",
					lines: ["Automatic work is configured to pause after 25 responses."],
					items: [
						{ id: "rpc", label: "Managed run RPC", currentValue: "Off", values: ["Off", "On"], action: "set" },
					],
				}),
				budget: () => ({ kind: "input", title: "Custom token budget", placeholder: "100k", action: "set" }),
			},
			actions: {
				set: ({ value }: { itemId: string; value?: string }) => {
					received.push(value);
					return undefined;
				},
			},
		});
		const screen = menu.screens.main!();
		expect(screen.title).toBe("Réglages de Pi Goal");
		expect(screen.lines).toEqual(["Le travail automatique est réglé pour s'arrêter après 25 réponses."]);
		expect(screen.items).toEqual([
			{
				id: "rpc",
				label: "Pilotage RPC des passages",
				currentValue: "Désactivé",
				values: ["Désactivé", "Activé"],
				action: "set",
			},
		]);
		menu.screens.main!();
		menu.actions.set!({ itemId: "rpc", value: "Activé" });
		// Typed text is the user's, even when it reads like a translated value.
		menu.actions.set!({ itemId: "budget", value: "Activé" });
		expect(received).toEqual(["On", "Activé"]);
	});

	it("translates dialogs and notifications line by line, never the user's prefilled text", async () => {
		setLanguage("fr");
		const calls: unknown[][] = [];
		const ui = translateUi({
			notify: (...args) => void calls.push(["notify", ...args]),
			confirm: async (...args) => {
				calls.push(["confirm", ...args]);
				return true;
			},
			editor: async (...args) => void calls.push(["editor", ...args]),
			input: async (...args) => void calls.push(["input", ...args]),
		});
		ui.notify("Goal paused: ship it", "info");
		await ui.confirm("Clear goal?", "Remove this goal:\n\nship it\n\nThis cannot be undone.");
		await ui.editor("Edit goal objective", "Goal objective");
		await ui.input("Repeated-run threshold (whole number greater than 0)", "Positive whole number");
		expect(calls).toEqual([
			["notify", "Objectif en pause : ship it", "info"],
			[
				"confirm",
				"Effacer l'objectif ?",
				"Supprimer cet objectif :\n\nship it\n\nCette action est irréversible.",
				undefined,
			],
			["editor", "Modifier l'énoncé de l'objectif", "Goal objective", undefined],
			["input", "Seuil de passages répétés (nombre entier supérieur à 0)", "Nombre entier positif", undefined],
		]);
	});

	it("shows the Plan plug-in's own notifications in French", async () => {
		setLanguage("fr");
		const notes: string[] = [];
		const harness = await createHarness({
			extensionFactories: [{ name: "pi-plan-mode", factory: entry("pi-plan-mode").factory }],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => void notes.push(message) }),
			mode: "tui",
		});
		await harness.session.prompt("/plan finalize");
		await harness.session.prompt("/plan save");
		await harness.session.prompt("/plan show");
		expect(notes).toEqual([
			"Le mode Plan n'est pas actif. Lancez d'abord /plan.",
			"Aucun plan terminé à garder.",
			"Aucun plan terminé. Lancez /plan finalize quand la planification est finie.",
		]);
	});

	it("has a French text for every fixed notification of the Plan plug-in", () => {
		setLanguage("fr");
		const dist = join(__dirname, "../vendor/forks/pi-plan-mode/dist");
		const code = ["index.ts", "chunks/chunk-L2CXUWCH.ts", "chunks/interactive-ui-OZA4BHGS.ts"]
			.map((file) => readFileSync(join(dist, file), "utf8"))
			.join("\n");
		const fixed =
			/(?:\.notify\(\s*|safeNotify\(ctx,\s*|notifyCurrent\(ctx,\s*request,\s*|const (?:message|notification) = )("(?:[^"\\]|\\.)*")/g;
		const texts = [...code.matchAll(fixed)].map((match) => JSON.parse(match[1]!) as string);
		expect(texts.length).toBeGreaterThan(30);
		expect(texts.filter((text) => t(text) === text)).toEqual([]);
	});

	it("translates the Plan plug-in's notifications with variable parts, the longer form first", () => {
		setLanguage("fr");
		expect(t("Plan exported to /tmp/PLAN.md. Plan mode disabled.")).toBe(
			"Plan exporté vers /tmp/PLAN.md. Mode Plan coupé.",
		);
		expect(
			t(
				"Proposed plan is not ready: the closing tag is missing. Continue Plan mode and produce one complete non-empty <proposed_plan> block.",
			),
		).toBe(
			"Le plan proposé n'est pas prêt : la balise fermante manque. Continuez en mode Plan et produisez un seul bloc <proposed_plan> complet et non vide.",
		);
		expect(
			t(
				"Cannot save the plan and leave Plan mode while an agent run is active. Wait for the run to settle, then retry.",
			),
		).toBe(
			"Impossible de garder le plan et quitter le mode Plan pendant qu'un passage de l'agent est en cours. Attendez qu'il se termine, puis réessayez.",
		);
		expect(
			t(
				"Unable to implement the plan: implementation model a/b is no longer available. Choose another model and retry.",
			),
		).toBe(
			"Impossible d'implémenter le plan : le modèle d'implémentation a/b n'est plus disponible. Choisissez un autre modèle et réessayez.",
		);
	});

	// the Goal status in the composer switch and the status line.
	it("words the Goal status in French, counts and budgets as they are, and keeps the switch rule", () => {
		const hooks = globalThis as Record<symbol, unknown>;
		const saved = hooks[UI_I18N];
		const goal = (fields: Record<string, unknown>) => ({
			status: "active",
			automaticModelTurns: 3,
			timeUsedSeconds: 125,
			tokensUsed: 1200,
			...fields,
		});
		try {
			hooks[UI_I18N] = undefined;
			expect(formatStatus(goal({}), 50)).toBe("active 2m · automatic 3/50");
			hooks[UI_I18N] = translateUi;
			expect(formatStatus(goal({}), 50)).toBe("active 2m · automatic 3/50");
			setLanguage("fr");
			expect(formatStatus(goal({}), 50)).toBe("actif 2m · automatique 3/50");
			expect(formatStatus(goal({}), null)).toBe("actif 2m · automatique illimité");
			expect(formatStatus(goal({ status: "paused", safetyPauseCause: "continuation_limit" }), 3)).toBe(
				"en pause · limite automatique 3/3",
			);
			expect(formatStatus(goal({ status: "blocked" }), 50)).toBe("bloqué · automatique 3/50");
			expect(formatStatus(goal({ waiting: { reason: "CI run" } }), 50)).toBe(
				"en attente : CI run · automatique 3/50",
			);
			const done = formatStatus(goal({ status: "complete" }), 50);
			expect(done).toBe("terminé");
			expect(GOAL_DONE_STATUSES).toEqual(["complete", "terminé"]);
			expect(goalOn(done)).toBe(false);
			expect(goalOn("complete")).toBe(false);
			expect(goalOn(formatStatus(goal({}), 50))).toBe(true);
			expect(goalOn(undefined)).toBe(false);
		} finally {
			hooks[UI_I18N] = saved;
		}
	});

	it("names the check-box toggle of Plan's settings and /config", () => {
		setLanguage("fr");
		expect(t("toggle")).toBe("cocher/décocher");
	});
});

// fork: common UI paths translate their wrappers, never user or model data.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, Container, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createShellRenderers } from "../src/core/tools/renderers/bash.ts";
import background from "../src/fork/background.ts";
import budgets from "../src/fork/budgets.ts";
import { setLanguage } from "../src/fork/i18n/index.ts";
import permissions from "../src/fork/permissions.ts";
import { startSandbox } from "../src/fork/sandbox/runtime.ts";
import { formatSessionState } from "../src/fork/session-state.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { CompactionStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

vi.mock("../src/fork/sandbox/runtime.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	startSandbox: vi.fn(() => ({ error: "test sandbox unavailable" })),
}));

const shown = (component: Component, width = 64) => stripAnsi(component.render(width).join("\n"));
const tui = { requestRender: vi.fn() } as unknown as TUI;
const methods = InteractiveMode.prototype as unknown as {
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	handleSessionCommand: () => void;
	handleNameCommand: (text: string) => void;
	cycleModel: (direction: "forward" | "backward") => Promise<void>;
	createBaseAutocompleteProvider: () => {
		getSuggestions: (
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: { signal: AbortSignal },
		) => Promise<{ items: { value: string; description?: string }[] } | null>;
	};
};

describe("fork: French common interface paths", () => {
	let dir: string;
	let harness: Harness | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-i18n-common-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		setLanguage("fr");
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		setLanguage("en");
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([false, true])("renders confirm options but returns the original Yes/No value (%s)", async (no) => {
		let selector: ExtensionSelectorComponent | undefined;
		const result = methods.showExtensionConfirm.call(
			{
				showExtensionSelector: (title: string, options: string[]) =>
					new Promise<string>((resolve) => {
						selector = new ExtensionSelectorComponent(title, options, resolve, vi.fn());
					}),
			} as unknown as InteractiveMode,
			"Import session",
			"Question",
		);
		const screen = shown(selector!);
		if (no) selector!.handleInput("j");
		selector!.handleInput("\r");
		expect({ yes: screen.includes("Oui"), no: screen.includes("Non"), confirmed: await result }).toEqual({
			yes: true,
			no: true,
			confirmed: !no,
		});
	});

	it("renders the cost budget summary", async () => {
		const notify = vi.fn();
		harness = await createHarness({ extensionFactories: [budgets] });
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ notify }) });
		await harness.session.prompt("/budget status");
		const summary = notify.mock.calls.at(-1)![0] as string;
		expect(summary).toContain("coût : désactivé (consommé : $0.0000)");
		expect(summary).toContain("Coût : ");
		expect(summary).toContain("État : actif");
	});

	it("puts the French space before the colon in /state", () => {
		expect(formatSessionState([], [], 80, 0)).toEqual([
			"Dernier tour : terminé",
			"Appels d'outils interrompus : 0",
			"Tâches en arrière-plan en cours : 0",
			"Points de restauration disponibles : rien",
		]);
	});

	it("renders the bash earlier-lines hint and preserves full-output paths", () => {
		const path = "/tmp/$&/{0}/output.txt";
		const component = new ToolExecutionComponent(
			"bash",
			"bash",
			{ command: "echo" },
			{},
			createShellRenderers("$"),
			tui,
			dir,
		);
		component.updateResult({
			content: [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `English output ${i}`).join("\n") }],
			details: { fullOutputPath: path },
			isError: false,
		});
		const screen = shown(component, 120);
		expect({
			earlier: screen.includes("5 lignes précédentes,"),
			expand: screen.includes("pour déplier"),
			path: screen.includes(`Sortie complète : ${path}`),
		}).toEqual({ earlier: true, expand: true, path: true });
	});

	it.each(["manual", "threshold", "overflow"] as const)(
		"renders the summarizing status (%s) at narrow widths",
		(reason) => {
			const indicator = new CompactionStatusIndicator(tui, reason);
			try {
				const screen = shown(indicator, 200);
				expect({
					label: screen.includes(
						reason === "manual" ? "Résumé des anciens messages" : "Résumé automatique des anciens messages",
					),
					cancel: screen.includes("pour annuler"),
					overflow: reason !== "overflow" || screen.includes("La conversation dépasse la limite du modèle."),
					fits: indicator.render(64).every((line) => visibleWidth(line) <= 64),
				}).toEqual({ label: true, cancel: true, overflow: true, fits: true });
			} finally {
				indicator.dispose();
			}
		},
	);

	it("renders /session report labels", async () => {
		harness = await createHarness();
		const chatContainer = new Container();
		methods.handleSessionCommand.call({
			session: harness.session,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			chatContainer,
			ui: tui,
		} as unknown as InteractiveMode);
		const screen = shown(chatContainer, 120);
		for (const label of [
			"Informations de session",
			"Fichier :",
			"En mémoire",
			"Utilisateur :",
			"Outils :",
			"0 appels, 0 résultats",
			"Entrée :",
			"Sortie :",
			"Maintien du cache",
		])
			expect.soft(screen).toContain(label);
	});

	it("renders a translated wrapper with a literal data slot", () => {
		const name = "/tmp/$&/{0}/copy";
		const chatContainer = new Container();
		methods.handleNameCommand.call(
			{ sessionManager: { getSessionName: () => name }, chatContainer, ui: tui } as unknown as InteractiveMode,
			"/name",
		);
		expect(shown(chatContainer, 120)).toContain(`Nom de session : ${name}`);
	});

	it("renders the sandbox network permission question with unchanged command data", async () => {
		const select = vi.fn(async (_title: string) => undefined);
		harness = await createHarness({ extensionFactories: [permissions] });
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ select }) });
		const policy = vi.mocked(startSandbox).mock.calls.at(-1)![2];
		await policy.ask!("example.test", { command: "curl /tmp/$&/{0}/input" });
		const selector = new ExtensionSelectorComponent(select.mock.calls[0]![0], [], vi.fn(), vi.fn());
		const screen = shown(selector, 200);
		expect({
			explanation: screen.includes("Les commandes dans la sandbox ne joignent que les hôtes que vous autorisez."),
			setting: screen.includes("Ces questions peuvent être désactivées"),
			denied: screen.includes("Les hôtes dans « deny » restent bloqués."),
			config: screen.includes('"askNewHosts": false'),
			command: screen.includes("curl /tmp/$&/{0}/input"),
		}).toEqual({ explanation: true, setting: true, denied: true, config: true, command: true });
	});

	it("renders an extension command description through autocomplete", async () => {
		harness = await createHarness({ extensionFactories: [{ factory: background, path: "builtin:background" }] });
		const display = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session: harness.session },
			skillCommands: new Map(),
		});
		const autocomplete = methods.createBaseAutocompleteProvider.call(display);
		const items = (await autocomplete.getSuggestions(["/bg"], 0, 3, { signal: new AbortController().signal }))!.items;
		expect(items.find((item) => item.value === "bg")?.description).toBe(
			"Afficher et gérer les tâches en arrière-plan",
		);
	});

	// fork.9 QA: a click on the model name with no model said, in English, "Only one model available".
	it.each([
		[0, 0, "Aucun modèle disponible."],
		[1, 0, "Un seul modèle disponible"],
		[1, 1, "Un seul modèle dans la sélection"],
	])("says how many models the cycle has (%i available, %i scoped)", async (available, scoped, expected) => {
		const showStatus = vi.fn();
		await methods.cycleModel.call(
			{
				session: {
					cycleModel: async () => undefined,
					scopedModels: Array(scoped).fill({}),
					modelRuntime: { getAvailableSnapshot: () => Array(available).fill({}) },
				},
				showStatus,
			} as unknown as InteractiveMode,
			"forward",
		);
		expect(showStatus.mock.calls[0]?.[0]).toContain(expected);
	});
});

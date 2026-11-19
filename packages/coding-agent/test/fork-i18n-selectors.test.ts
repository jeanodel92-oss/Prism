// fork: translate before wrapping; callbacks, model content and saved values stay English.
import type { Api, Model } from "@earendil-works/pi-ai";
import { type Component, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { fill, setLanguage, t } from "../src/fork/i18n/index.ts";
import { createState } from "../src/fork/prism/lib/state.ts";
import { noticeHooks } from "../src/fork/prism/notices.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { formatKeyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { SelectSubmenu } from "../src/modes/interactive/components/settings-submenu.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const shown = (component: Component, width = 64) => stripAnsi(component.render(width).join("\n"));
const tui = { requestRender: vi.fn() } as unknown as TUI;

describe("fork: French selectors", () => {
	let harness: Harness | undefined;
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		setLanguage("fr");
	});
	afterEach(() => {
		setLanguage("en");
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps command names, counts and third-party text out of translated slots", () => {
		// A slot filled with a catalog word was translated too: /copy became /copier, "Build failed" changed.
		expect(fill("/{0} is not available in this session.", "copy")).toBe(
			"/copy n’est pas disponible dans cette session.",
		);
		// String.replace read "$$" and "$&" in a value as patterns, and a second slot was looked for in the first value.
		expect(fill("{0}: {1} restored", "echo $$ $& {1}", "3")).toBe("echo $$ $& {1} : 3 restauré(s)");
		setLanguage("en");
		expect(fill("{0}: {1} restored", "{1}", "3")).toBe("{1}: 3 restored");
		setLanguage("fr");
		for (const text of ["/copy is not available in this session.", "Build failed", "copy deleted", "Prism — done"]) {
			expect(t(text)).toBe(text);
		}
	});

	it("translates model hints, refresh failures, scope and name without changing the selected model", async () => {
		harness = await createHarness({ models: [{ id: "my-model", name: "My Model" }] });
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([["local", new Error("offline")]]),
		});
		const model = harness.getModel("my-model")!;
		const select = vi.fn();
		const selector = new ModelSelectorComponent(
			tui,
			model,
			harness.session.modelRuntime,
			[],
			select,
			vi.fn(),
			undefined,
			vi.fn(),
		);
		expect(shown(selector)).toContain("Seuls les modèles");
		expect(shown(selector)).toContain("Nom du modèle : My Model");
		expect(shown(selector)).toContain("Entrée choisir");
		await vi.waitFor(() => expect(shown(selector)).toContain("Impossible d’actualiser local"));
		selector.handleInput("\r");
		expect(select).toHaveBeenCalledWith(model);
		const scoped = new ModelSelectorComponent(
			tui,
			model,
			harness.session.modelRuntime,
			[{ model }],
			vi.fn(),
			vi.fn(),
		);
		expect(shown(scoped)).toContain("Liste : tous | sélection");
		scoped.dispose();
	});

	it("translates thinking descriptions and configurable key hints, preserving the level value", () => {
		expect(formatKeyText("ctrl+d/alt+w")).toBe("ctrl+d/alt+w");
		setKeybindings(new KeybindingsManager({ "app.thinking.save": "ctrl+r" }));
		const save = vi.fn();
		const selector = new ThinkingSelectorComponent("high", ["off", "high"], vi.fn(), vi.fn(), save, "high");
		const output = shown(selector);
		expect(output).toContain("Niveau de réflexion");
		expect(output).toContain("Réflexion approfondie");
		expect(output).toContain("Ctrl+R par défaut");
		expect(output).not.toMatch(/to select|to cancel|reasoning|default/);
		selector.handleInput("\x12");
		expect(save).toHaveBeenCalledWith("high");
	});

	it("translates plain submenus and extension dialogs but returns original options", () => {
		const select = vi.fn();
		const submenu = new SelectSubmenu(
			"Theme",
			"Select a model to configure",
			[{ value: "dark", label: "dark", description: "(current)" }],
			"dark",
			select,
			vi.fn(),
			undefined,
			{ searchable: true },
		);
		expect(shown(submenu, 120)).toContain("Tapez pour filtrer");
		expect(shown(submenu)).toContain("(actuel)");
		submenu.handleInput("\r");
		expect(select).toHaveBeenCalledWith("dark");
		const dialog = new ExtensionSelectorComponent(
			"Undo turn 2?\nChanges made by bash commands are not tracked.",
			["Cancel"],
			select,
			vi.fn(),
		);
		expect(shown(dialog)).toContain("Annuler le tour 2 ?");
		expect(shown(dialog)).toContain("Les changements faits par les commandes bash");
		dialog.handleInput("\r");
		expect(select).toHaveBeenLastCalledWith("Cancel", 0);
	});

	// two login choices with the same label gave back the first one's id.
	it("tells which of two options with the same label was chosen", () => {
		const select = vi.fn();
		const dialog = new ExtensionSelectorComponent("Account", ["Work", "Work"], select, vi.fn());
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
		expect(select).toHaveBeenLastCalledWith("Work", 1);
	});

	it("translates warning and automatic-theme submenus before line wrapping", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const change = vi.fn();
		const callbacks = { onWarningsChange: change, onCancel: vi.fn() } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("warnings");
		list.handleInput("\r");
		const warning = shown(list);
		expect(warning).toContain("Usage supplémentaire Anthropic");
		expect(warning).not.toMatch(/Warn when|extra charges|true|false/);
		list.handleInput("\r");
		expect(change).toHaveBeenCalledWith({ anthropicExtraUsage: false });
		list.handleInput("\x1b");
		list.selectItem("theme");
		list.handleInput("\r");
		const automatic = shown(list);
		expect(automatic).toContain("Thème automatique");
		expect(automatic).toContain("Thème clair");
		expect(automatic).not.toMatch(/Choose themes|Light theme|Theme to use/);
		for (const line of list.render(64)) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
	});

	it("translates login titles, statuses, empty states and device instructions", () => {
		const select = vi.fn();
		const provider = new OAuthSelectorComponent(
			"login",
			[{ id: "my-service", name: "My Service", authType: "api_key" }],
			select,
			vi.fn(),
		);
		expect(shown(provider)).toContain("Choisissez un service");
		expect(shown(provider)).toContain("non configuré");
		provider.handleInput("\r");
		expect(select).toHaveBeenCalledWith("my-service", "api_key");
		expect(shown(new OAuthSelectorComponent("logout", [], vi.fn(), vi.fn()))).toContain("Aucun fournisseur connecté");
		const login = new LoginDialogComponent(tui, "My Service", vi.fn());
		login.showDeviceCode({ verificationUri: "https://example.test/login", userCode: "ABCD" });
		expect(shown(login)).toContain("Connexion à My Service");
		expect(shown(login)).toContain("Ctrl+clic pour ouvrir");
		expect(shown(login)).toContain("saisissez ce code : ABCD");
	});

	it("translates session empty states and tree chrome while keeping message and copy content intact", async () => {
		const sessions = new SessionSelectorComponent(
			async () => [],
			async () => [],
			vi.fn(),
			vi.fn(),
			vi.fn(),
			vi.fn(),
		);
		await vi.waitFor(() => expect(shown(sessions)).toContain("Aucune session dans ce dossier"));
		expect(shown(sessions)).not.toMatch(/Current Folder|scope|Sort:|Name:/);
		const tree = new TreeSelectorComponent(
			[
				{
					entry: {
						type: "message",
						id: "entry",
						parentId: null,
						timestamp: new Date().toISOString(),
						message: { role: "user", content: "Keep this English content", timestamp: 0 },
					},
					children: [],
				},
			],
			"entry",
			40,
			vi.fn(),
			vi.fn(),
		);
		expect(shown(tree)).toContain("Arbre de session");
		expect(shown(tree)).toContain("Tapez pour rechercher");
		expect(shown(tree)).toContain("vous : Keep this English content");
		const copy = vi.fn();
		tree.onCopy = copy;
		tree.getTreeList().copySelected();
		expect(copy).toHaveBeenCalledWith("Keep this English content");
	});

	it("translates startup warnings in the Prism callouts as well as their plain fallback", () => {
		const state = createState();
		state.theme = theme;
		const message = "fd not found. Offline mode enabled, skipping download.";
		const output = noticeHooks(state).notice!("warning", message, 64)!.map(stripAnsi).join("\n");
		expect(output).toContain("fd introuvable");
		expect(output).not.toContain("not found");
		expect(
			t(
				"tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.",
			),
		).toContain("combinaisons avec Entrée");
	});

	it("translates /scoped-models and keeps model names and saved ids", async () => {
		const model = { provider: "acme", id: "large", name: "Large" } as unknown as Model<Api>;
		const onChange = vi.fn();
		const selector = new ScopedModelsSelectorComponent(
			{ allModels: [model], enabledModelIds: null, refreshStatus: "Refreshing model catalogs…" },
			{ onChange, onPersist: vi.fn(), onCancel: vi.fn() },
		);
		let screen = shown(selector, 100);
		expect(screen).toContain("Modèles parcourus");
		expect(screen).toContain("Pour cette session seulement.");
		expect(screen).toContain("tous activés");
		expect(screen).toContain("Nom du modèle : Large");
		expect(screen).toContain("Mise à jour des listes de modèles…");
		selector.setRefreshStatus("Model catalogs refreshed.", "success");
		selector.handleInput("\r");
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		expect(onChange.mock.calls[0]![0]).toEqual([]);
		screen = shown(selector, 100);
		expect(screen).toContain("Catalogues de modèles actualisés.");
		expect(screen).toContain("0 sur 1 activés");
		expect(screen).toContain("(non enregistré)");
		for (const width of [40, 64]) {
			for (const line of selector.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

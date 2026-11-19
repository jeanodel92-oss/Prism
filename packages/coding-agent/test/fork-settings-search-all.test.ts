// fork: every setting of /settings is found by its search
// the upstream settings, the fork's domains, the sections of the built-in extensions, each model's
// rows, and the command shortcuts, in English and in French.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingItem } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import budgetsExtension from "../src/fork/budgets.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import modelSettingsExtension from "../src/fork/model-settings.ts";
import notifyExtension from "../src/fork/notify.ts";
import permissionsExtension from "../src/fork/permissions.ts";
import { SETTINGS_SHORTCUTS } from "../src/fork/settings-descriptions.ts";
import { settingsSections } from "../src/fork/settings-sections.ts";
import type { SettingsView } from "../src/fork/settings-view.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

describe("fork: the /settings search finds every setting", () => {
	let agentDir: string;
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-settings-search-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		setLanguage("en");
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function openSettings(): Promise<() => SettingsView> {
		const entry: McpServerEntry = {
			name: "docs",
			config: { url: "http://unused.invalid", enabled: false },
			source: join(agentDir, "mcp.json"),
			scope: "global",
		};
		harness = await createHarness({
			extensionFactories: [
				{ name: "budgets", factory: budgetsExtension },
				{ name: "notify", factory: notifyExtension },
				{ name: "permissions", factory: permissionsExtension },
				{ name: "model-settings", factory: modelSettingsExtension },
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					updateConfig: vi.fn(),
					createTransport: () => {
						throw new Error("no server in this test");
					},
				}),
			],
		});
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const model = harness.session.model!;
		const config = {
			interfaceMode: "advanced",
			autoCompact: true,
			defaultModel: `${model.provider}/${model.id}`,
			currentModel: model,
			availableDefaultModels: [model],
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
			modelThinkingLevels: {},
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			availableThemes: ["dark", "light"],
			currentTheme: "dark",
			warnings: {},
			domainExtras: {
				builtinExtensions: [{ name: "codemode", enabled: true }],
				onBuiltinExtensionChange: vi.fn(),
				interfaceMode: "advanced",
				sections: settingsSections,
				commands: SETTINGS_SHORTCUTS,
				hasCommand: () => true,
				onRunCommand: vi.fn(),
				webSearch: { provider: "exa", keySource: "none" },
				rows: () => 400,
			},
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		return () => new SettingsSelectorComponent(config, callbacks).getSettingsList() as SettingsView;
	}

	/** Every row of every domain, and the rows only the search shows, as the window lists them. */
	function allRows(view: SettingsView): Array<{ item: SettingItem; domain: string }> {
		return view.model
			.domains()
			.flatMap((domain) =>
				[...domain.items(), ...domain.searchItems()].map((item) => ({ item, domain: domain.id })),
			);
	}

	for (const language of ["en", "fr"] as const) {
		it(`finds each row by its label (${language})`, async () => {
			setLanguage(language);
			const view = await openSettings();
			const rows = allRows(view());
			const domains = new Set(rows.map((row) => row.domain));
			for (const domain of [
				"models",
				"permissions",
				"servers",
				"network",
				"notifications",
				"conversation",
				"other",
			]) {
				expect(domains, domain).toContain(domain);
			}
			const ids = rows.map((row) => row.item.id);
			for (const id of [
				"budget-default-time",
				"notify-desktop",
				"mcp-enabled:docs",
				"mcp-exposure:docs",
				"command:lsp-setup",
				"command:budget",
				"sandbox-state",
			]) {
				expect(ids, id).toContain(id);
			}
			expect(
				ids.some((id) => id.startsWith("model:")),
				"a model's own row",
			).toBe(true);
			const missed: string[] = [];
			for (const { item } of rows) {
				const window = view();
				for (const key of `/${item.label}`) window.handleInput(key);
				const shown = fold(window.render(200).map(plain).join("\n"));
				if (shown.includes(fold(t("No setting matches."))) || !shown.includes(fold(item.label).slice(0, 12))) {
					missed.push(`${item.id} (${item.label})`);
				}
			}
			expect(missed).toEqual([]);
		});
	}
});

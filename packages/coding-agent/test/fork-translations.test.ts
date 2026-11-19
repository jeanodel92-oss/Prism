// fork: in French, every value /settings shows is French. The owner's QA on 1.0.0-fork.6
// found "capped at 93.4%", "1 configured", "tree", "disabled", "on" and "off" left in English.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, Container } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import type { SettingsView } from "../src/fork/settings-view.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * Values that read the same in French: names, identifiers, numbers, paths and units. Anything else
 * that comes back from t() unchanged is a missing translation.
 */
const SAME_IN_FRENCH = new Set([
	"minimal",
	"auto",
	"dark",
	"light",
	"simple",
	"Simple",
	"English",
	"Français",
	"sse",
	"websocket",
	"websocket-cached",
	"none",
	"short",
	"long",
	"exa",
	"brave",
	"tavily",
	"firecrawl",
	"searxng",
]);
/** Numbers, sizes and percentages, and paths such as theme names (`prism-light/prism`). */
const UNTRANSLATABLE = /^(?:[\d.,%\s]+(?:ms|s|px|cells?|days?|min)?|\S*\/\S*)$/;

describe("fork: /settings in French", () => {
	let dir: string;
	let harness: Harness | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prism-translations-"));
		vi.stubEnv(ENV_AGENT_DIR, dir);
		initTheme("dark");
	});
	afterEach(() => {
		setLanguage("en");
		harness?.cleanup();
		harness = undefined;
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function openSettings(): Promise<SettingsView> {
		harness = await createHarness();
		const settings = SettingsManager.create(dir, dir);
		settings.setInterfaceMode("advanced");
		let selector: SettingsSelectorComponent | undefined;
		const mode = {
			settingsManager: settings,
			session: harness.session,
			ui: { mode: "regular", requestRender: vi.fn(), terminal: { rows: 40, columns: 140 } },
			themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => undefined },
			chatContainer: new Container(),
			showSettingsOverlay(create: (done: () => void) => { component: Component; focus: Component }) {
				selector = create(vi.fn()).component as SettingsSelectorComponent;
			},
		};
		const show = Reflect.get(InteractiveMode.prototype, "showSettingsSelector") as (
			this: typeof mode,
		) => Promise<void>;
		await show.call(mode);
		return selector!.getSettingsList() as SettingsView;
	}

	/** Every value each setting shows, current one and choices, as drawn (settings-view.ts translates them). */
	const shownValues = (view: SettingsView) =>
		view.model.domains().flatMap((domain) =>
			domain.items().flatMap((item) =>
				[item.currentValue, ...(item.values ?? [])].map((value) => ({
					where: `${domain.id} › ${item.id}`,
					value: t(value),
				})),
			),
		);

	it("shows no English value in any domain", async () => {
		const view = await openSettings();
		const english = shownValues(view);
		setLanguage("fr");
		const french = shownValues(view);
		const left = french
			.filter(({ value }, i) => value === english[i]!.value)
			.filter(({ value }) => /\p{L}/u.test(value) && !SAME_IN_FRENCH.has(value) && !UNTRANSLATABLE.test(value))
			.map(({ where, value }) => `${where}: ${value}`);
		expect(left).toEqual([]);
	});

	it("describes every setting in French, the compaction threshold's value in effect included", async () => {
		const view = await openSettings();
		const describe = () =>
			view.model.domains().flatMap((domain) => domain.items().map((item) => [item.id, item.description ?? ""]));
		const english = describe();
		setLanguage("fr");
		const french = describe();
		// Module descriptions without a French text (installed add-ons describe themselves) are not checked.
		const left = french.filter(([id, text], i) => text && text === english[i]![1] && !id!.startsWith("builtin:"));
		expect(left).toEqual([]);
		const threshold = french.find(([id]) => id === "compaction-threshold")![1]!;
		expect(threshold).toContain("En vigueur : Par défaut (résumé vers");
	});

	it("translates the values built from numbers", () => {
		setLanguage("fr");
		expect(t("1 configured")).toBe("1 configuré");
		expect(t("3 configured")).toBe("3 configurés");
		expect(t("30 sec")).toBe("30 s");
		expect(t("tree")).toBe("arbre");
		expect(t("80% (capped at 93.4%; compacts at ~119,603 of 128,000 tokens)")).toBe(
			"80% (plafonné à 93.4% ; résumé vers ~119,603 sur 128,000 tokens)",
		);
	});
});

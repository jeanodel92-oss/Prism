// fork: long labels in /settings can be read whole: the choices of a setting wrap instead of
// being cut ("Ne jamais faire confian…"), the help zone wraps the focused setting's name and what each choice does,
// a row cuts its label before its value, and a model's page keeps long translated labels whole.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingItem, TuiMouseEvent } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setLanguage, t } from "../src/fork/i18n/index.ts";
import { OPTION_DESCRIPTIONS } from "../src/fork/settings-descriptions.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { ModelPage } from "../src/fork/settings-model-page.ts";
import { SettingsView } from "../src/fork/settings-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");
/** The text of a window's lines, frames and spacing aside, to find a wrapped sentence. */
const words = (lines: string[]) =>
	lines
		.map((l) => l.replace(/[│┌┐└┘─▌●→]/g, " "))
		.join(" ")
		.replace(/\s+/g, " ");

const click = (x: number, y: number): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 64,
	height: 30,
	shift: false,
	alt: false,
	ctrl: false,
});

const TRUST = ["Ask", "Always trust", "Never trust"];

function trustView() {
	const onChange = vi.fn();
	const items: SettingItem[] = [
		{
			id: "default-project-trust",
			label: t("Trust for new project folders"),
			description: "Whether to trust a folder when nothing else decides.",
			currentValue: "Ask",
			values: TRUST,
		},
		{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
		// A domain as long as the real ones, which sets the window's height.
		...Array.from({ length: 12 }, (_, i) => ({
			id: `filler-${i}`,
			label: `Filler ${i}`,
			currentValue: "on",
			values: ["on", "off"],
		})),
	];
	const model = groupSettingsByDomain(items, onChange, { builtinExtensions: [], onBuiltinExtensionChange: vi.fn() });
	const view = new SettingsView(model, { onClose: vi.fn(), rows: () => 30 });
	for (const key of `/${t("Trust for new project folders").split(" ")[0]}`) view.handleInput(key);
	view.handleInput("\x1b[B");
	return { view, onChange };
}

describe("fork: long labels in /settings", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setLanguage("en"));

	it("wraps each choice and what it does instead of cutting them, in French at 64 and 100 columns", () => {
		setLanguage("fr");
		for (const width of [64, 100]) {
			const { view } = trustView();
			view.handleInput("\r");
			const lines = view.render(width).map(plain);
			for (const line of lines) expect(visibleWidth(line), line).toBe(width);
			const text = words(lines);
			for (const value of TRUST) {
				expect(text, `${width}: ${value}`).toContain(t(value));
				expect(text, `${width}: ${value}`).toContain(t(OPTION_DESCRIPTIONS["default-project-trust"]![value]!));
			}
			// A name never runs into its description.
			expect(lines.join("\n")).not.toMatch(/confiance(Charger|Ignorer)/);
		}
	});

	it("picks the choice whose wrapped line is clicked", () => {
		setLanguage("fr");
		const { view, onChange } = trustView();
		view.handleInput("\r");
		const lines = view.render(64).map(plain);
		const name = lines.findIndex((l) => l.includes("Ne jamais faire confiance"));
		// The line under the name carries the rest of its description.
		expect(lines[name + 1]).toContain("modules");
		expect(lines[name + 1]).not.toContain("faire confiance");
		view.handleMouse(click(40, name + 1));
		expect(onChange).toHaveBeenLastCalledWith("default-project-trust", "Never trust");
	});

	it("shows the focused setting's whole name and every choice in the help zone, and keeps the value in the row", () => {
		setLanguage("fr");
		const { view } = trustView();
		const lines = view.render(64).map(plain);
		const text = words(lines);
		expect(text).toContain("Confiance pour les nouveaux dossiers");
		expect(text).toContain(`${t("Never trust")} : ${t("Ignore its settings and add-ons")}`);
		const row = lines.find((l) => l.includes("Demander ▾"));
		expect(row).toBeDefined();
		expect(lines.join("\n")).not.toContain("……");
	});

	it("keeps a model page's long translated labels whole", () => {
		setLanguage("fr");
		const dir = mkdtempSync(join(tmpdir(), "prism-long-labels-"));
		try {
			const modelsPath = join(dir, "models.json");
			writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
			const model = {
				id: "m",
				name: "m",
				api: "openai-completions",
				provider: "local",
				baseUrl: "http://localhost:8080/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 32000,
			} as Model<Api>;
			const page = new ModelPage(
				{
					modelsPath,
					capabilitiesFile: join(dir, "capabilities.json"),
					models: () => [model],
					current: () => model,
					readServer: async () => undefined,
					reload: async (m: Model<Api>) => m,
				},
				model,
				{ advanced: () => true, requestRender: vi.fn(), done: vi.fn() },
			);
			const text = page.render(58).map(plain).join("\n");
			expect(text).toContain("Pénalité de répétition");
			expect(text).toContain("Pénalité de fréquence");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

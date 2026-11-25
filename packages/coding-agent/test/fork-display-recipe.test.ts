// fork: defects found by the width, language and theme recipe.
import type { SettingItem } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { helpEntries, helpItems, helpSelector } from "../src/fork/help.ts";
import { FR, FR_PATTERNS } from "../src/fork/i18n/fr.ts";
import { fill, setLanguage, t } from "../src/fork/i18n/index.ts";
import { PermView } from "../src/fork/perm-view.ts";
import { modePolicy, POLICY_ROWS } from "../src/fork/permissions.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { ListEditor } from "../src/fork/settings-list-editor.ts";
import { SettingsView } from "../src/fork/settings-view.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { formatKeyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");
/** A window's text without its frame, to find a wrapped sentence. */
const words = (lines: string[]) =>
	lines
		.map((l) => plain(l).replace(/[│┌┐└┘├┤┬┴─]/g, " "))
		.join(" ")
		.replace(/\s+/g, " ");

describe("fork: display recipe", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setLanguage("en"));

	// fork.9 QA: browsing /help does not resize it, nor move what is under the list.
	it("keeps the height of /help whichever row is selected", () => {
		const entries = helpEntries(
			(id) => `<${id}>`,
			() => true,
		);
		for (const width of [40, 64, 100]) {
			const menu = helpSelector(
				entries,
				() => {},
				() => {},
			);
			const seen = new Set<number>();
			const hints = new Set<number>();
			for (let index = 0; index < entries.length; index++) {
				const lines = menu.render(width);
				seen.add(lines.length);
				hints.add(lines.findIndex((line) => line.includes("Esc")));
				menu.handleInput("\x1b[B");
			}
			expect(seen.size).toBe(1);
			expect(hints.size).toBe(1);
		}
	});

	it("shows the whole description of the chosen /help line at any width", () => {
		// At 64 columns "Commandes (tapez / pour les list" ended mid-word; at 40 the descriptions were gone.
		setLanguage("fr");
		const entries = helpEntries(
			(id) => `<${id}>`,
			() => true,
		);
		const stop = helpItems(entries)[2].description ?? "";
		for (const width of [40, 64, 100]) {
			const menu = helpSelector(
				entries,
				() => {},
				() => {},
			);
			menu.handleInput("\x1b[B");
			menu.handleInput("\x1b[B");
			const text = menu
				.render(width)
				.map((line) => plain(line).trim())
				.join(" ");
			expect(text.replace(/\s+/g, " "), String(width)).toContain(stop);
		}
	});

	it("keeps <instruction> in the French empty-memory hint, like /memory's help", () => {
		// The patterns had a second, unused translation with "<consigne>" ("<instruction>").
		for (const key of Object.keys(FR_PATTERNS)) if (key in FR) expect(FR_PATTERNS[key], key).toBe(FR[key]);
		setLanguage("fr");
		expect(fill("{0} is empty. Use /{1} <instruction> to fill it.", "MEMORY.md", "memory")).toBe(
			"MEMORY.md est vide. Utilisez /memory <instruction> pour le remplir.",
		);
	});

	it("names the keys in French, in /files and /help, like the other menus", () => {
		// /files showed "enter ajouter au message · tab sélectionner" and "esc fermer"; /help "Up / Down".
		setLanguage("fr");
		for (const hint of [
			"enter add to message · tab mark",
			"← back · esc close",
			"enter actions",
			"enter choose",
			"esc back",
			"esc close",
		])
			expect(t(hint), hint).not.toMatch(/\b(enter|esc|tab)\b/);
		const arrows = () => ["up", "down"].map((key) => formatKeyText(key, { capitalize: true })).join(" / ");
		expect(arrows()).toBe("Haut / Bas");
		setLanguage("en");
		expect(arrows()).toBe("Up / Down");
	});

	it("keeps the whole key hint of /settings and /perm at 40 columns", () => {
		// "↑↓ bouger · Entrée modifier · ← re…" and "←→ ou clic : changer de mode · ↓ a…": "Échap fermer" was cut off.
		setLanguage("fr");
		const items: SettingItem[] = Array.from({ length: 14 }, (_, i) => ({
			id: `setting-${i}`,
			label: `Setting ${i}`,
			currentValue: "on",
			values: ["on", "off"],
		}));
		const model = groupSettingsByDomain(items, vi.fn(), { builtinExtensions: [], onBuiltinExtensionChange: vi.fn() });
		const settings = new SettingsView(model, { onClose: vi.fn(), rows: () => 40 });
		settings.handleInput("\r");
		const lines = settings.render(40);
		expect(words(lines)).toContain(t("↑↓ move · Enter change · ← back · Esc close"));
		expect(lines.length).toBeLessThanOrEqual(40);

		const perm = new PermView({
			mode: () => "ask",
			defaultMode: () => "ask",
			verdict: modePolicy,
			rows: POLICY_ROWS,
			grants: () => [],
			savedRules: () => 0,
			height: () => 40,
			onMode: vi.fn(),
			onRevoke: vi.fn(),
			onAction: vi.fn(),
			onClose: vi.fn(),
		});
		const permLines = perm.render(40);
		expect(words(permLines)).toContain(
			t("←→ or click: change mode · ↓ permissions · alt+m from the editor · Esc or click outside: close"),
		);
		expect(permLines.length).toBeLessThanOrEqual(38);
	});

	it("wraps the /resume filters and keys instead of cutting them", async () => {
		// At 64 columns: "Rep ◉ Dossier actuel…" and "ctrl+p che…"; at 40: "Nom : Tou".
		for (const [language, width] of [
			["fr", 40],
			["fr", 64],
			["en", 64],
		] as const) {
			setLanguage(language);
			const sessions = new SessionSelectorComponent(
				async () => [],
				async () => [],
				vi.fn(),
				vi.fn(),
				vi.fn(),
				vi.fn(),
			);
			await vi.waitFor(() =>
				expect(words(sessions.render(width))).toContain(language === "fr" ? "Aucune session" : "No sessions"),
			);
			const lines = sessions.render(width).map(plain);
			const text = words(lines);
			for (const part of [
				t("Name: ") + t("All"),
				t("Sort: ") + t("Threaded"),
				t("delete"),
				fill("path {0}", t("(off)")),
			])
				expect(text, `${language} ${width}`).toContain(part.trim());
			expect(lines.join("\n"), `${language} ${width}`).not.toMatch(/\bRep\b|Resume S\b|…/);
		}
	});

	it("shows a long setting label whole when the window has room", () => {
		// At 140 columns: "Les commandes voient mes conten…", "Commands read the state of serv…".
		for (const language of ["fr", "en"] as const) {
			setLanguage(language);
			const items: SettingItem[] = [
				{ id: "a", label: t("Commands see my containers"), currentValue: "off", values: ["on", "off"] },
				{ id: "b", label: t("Commands read the state of services"), currentValue: "off", values: ["on", "off"] },
			];
			const model = groupSettingsByDomain(items, vi.fn(), {
				builtinExtensions: [],
				onBuiltinExtensionChange: vi.fn(),
			});
			const view = new SettingsView(model, { onClose: vi.fn(), rows: () => 40 });
			view.handleInput("\x1b[B");
			const text = words(view.render(140));
			for (const item of items) expect(text, language).toContain(item.label);
		}
	});

	it("keeps a rule apart from its scope at 40 columns", () => {
		// "read(data.t…autoriser · globale": the rule was cut and ran into its scope.
		setLanguage("fr");
		const editor = new ListEditor({
			title: "Rules",
			description: "",
			addPrompt: "",
			entries: () => [{ text: "read(data.txt)", tag: `${t("allow")} · ${t("global")}` }],
			onAdd: vi.fn(),
			onRemove: vi.fn(),
			requestRender: vi.fn(),
			done: vi.fn(),
		});
		const text = editor.render(36).map(plain).join("\n");
		expect(text).toContain("read(data.txt)");
		expect(text).toMatch(new RegExp(`\\n\\s+${t("allow")} · ${t("global")}`));
	});

	it("keeps Revoke and the whole scope of a permission in effect visible at 40 and 64 columns", () => {
		// At 40 columns "+ read(sa… cette sessi… …": no "Revoke"; at 64 "cette sessi…" was still cut.
		setLanguage("fr");
		const revoked: number[] = [];
		for (const width of [40, 64]) {
			const perm = new PermView({
				mode: () => "ask",
				defaultMode: () => "ask",
				verdict: modePolicy,
				rows: POLICY_ROWS,
				grants: () => [{ effect: "allow", what: "read(sample.txt)", scope: t("this session"), left: "" }],
				savedRules: () => 0,
				height: () => 60,
				onMode: vi.fn(),
				onRevoke: (index) => void revoked.push(index),
				onAction: vi.fn(),
				onClose: vi.fn(),
			});
			const lines = perm.render(width).map(plain);
			const row = lines.findIndex((line) => line.includes("read(sample.txt)"));
			const text = words(lines.slice(row, row + 2));
			expect(text, String(width)).toContain(t("Revoke"));
			expect(text, String(width)).toContain(t("this session"));
			const x = lines[row]!.indexOf(t("Revoke"));
			perm.handleMouse({
				type: "click",
				button: "left",
				x,
				y: row,
				screenX: x,
				screenY: row,
				width,
				height: 60,
				shift: false,
				alt: false,
				ctrl: false,
			});
		}
		expect(revoked).toEqual([0, 0]);
	});

	it("wraps a long path in a question after a slash, not inside the file name", () => {
		// At 40 columns: "/tmp/pi-drive-ws.smgYKM/approval.t" then "xt" alone.
		const path = "/tmp/pi-drive-ws.smgYKM/approval.txt";
		const selector = new ExtensionSelectorComponent(
			`Allow this action? write\n\n  ${path}`,
			["Allow once"],
			vi.fn(),
			vi.fn(),
		);
		// The window in its frame at 40 columns.
		const lines = selector.render(38).map((line) => plain(line).trimEnd());
		expect(lines).toContain("   approval.txt");
		expect(lines.some((line) => line.trim() === "/tmp/pi-drive-ws.smgYKM/")).toBe(true);
		// A path that fits stays on one line.
		const wide = new ExtensionSelectorComponent(`Allow?\n\n  ${path}`, ["Allow once"], vi.fn(), vi.fn());
		expect(
			wide
				.render(64)
				.map(plain)
				.some((line) => line.includes(path)),
		).toBe(true);
	});
});

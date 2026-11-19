// fork: the French interface: fallback, language detection, the saved choice, patterns,
// the /settings view in French, and no catalog entry left without its English text in the code.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDocsPath } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { docFile, docTopics } from "../src/fork/docs-command.ts";
import { FR, FR_PATTERNS } from "../src/fork/i18n/fr.ts";
import { getLanguage, resolveLanguage, setLanguage, systemLanguage, t } from "../src/fork/i18n/index.ts";
import { THINKING_UNSUPPORTED } from "../src/fork/model-settings.ts";
import { groupSettingsByDomain } from "../src/fork/settings-domains.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("fork: interface language", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setLanguage("en"));

	it("falls back to the English text when a translation is missing", () => {
		setLanguage("fr");
		expect(t("Start a new session")).toBe("Commencer une nouvelle session");
		expect(t("A text nobody translated")).toBe("A text nobody translated");
		expect(t("")).toBe("");
		setLanguage("en");
		expect(t("Start a new session")).toBe("Start a new session");
	});

	it("follows LC_ALL, then LC_MESSAGES, then LANG, and an explicit choice over the system", () => {
		expect(systemLanguage({ LANG: "fr_FR.UTF-8" })).toBe("fr");
		expect(systemLanguage({ LANG: "fr" })).toBe("fr");
		expect(systemLanguage({ LC_MESSAGES: "fr_CA.UTF-8", LANG: "en_US.UTF-8" })).toBe("fr");
		expect(systemLanguage({ LC_ALL: "C", LANG: "fr_FR.UTF-8" })).toBe("en");
		expect(systemLanguage({ LANG: "french" })).toBe("en");
		expect(systemLanguage({})).toBe("en");
		expect(resolveLanguage("auto", { LANG: "fr_FR.UTF-8" })).toBe("fr");
		expect(resolveLanguage("en", { LANG: "fr_FR.UTF-8" })).toBe("en");
		expect(resolveLanguage("fr", { LANG: "en_US.UTF-8" })).toBe("fr");
		expect(resolveLanguage("klingon", { LANG: "en_US.UTF-8" })).toBe("en");
	});

	it("saves the Language choice from /settings and applies it at once", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getLanguage()).toBe("auto");
		const onLanguageChange = vi.fn((language: "auto" | "en" | "fr") => {
			settings.setLanguage(language);
			setLanguage(resolveLanguage(language, {}));
		});
		const grouped = groupSettingsByDomain([], vi.fn(), {
			builtinExtensions: [],
			onBuiltinExtensionChange: vi.fn(),
			language: settings.getLanguage(),
			onLanguageChange,
		});
		const language = grouped
			.domains()
			.find((d) => d.id === "interface")!
			.items()
			.find((item) => item.id === "language")!;
		expect(language.values).toEqual(["auto", "English", "Français"]);
		expect(language.currentValue).toBe("auto");

		grouped.onChange("language", "Français");
		expect(onLanguageChange).toHaveBeenCalledWith("fr");
		expect(settings.getLanguage()).toBe("fr");
		expect(getLanguage()).toBe("fr");
		// Labels are read when drawn, so the open menu follows the new language.
		expect(language.label).toContain("Langue");
		grouped.onChange("language", "English");
		expect(settings.getLanguage()).toBe("en");
		expect(language.label).toContain("Language");
	});

	it("fills patterns, keeps their variable parts, and translates sentence by sentence", () => {
		setLanguage("fr");
		expect(t("Model: claude-x")).toBe("Modèle : claude-x");
		expect(t("Failed to login to Acme: bad key")).toBe("Échec de la connexion à Acme : bad key");
		expect(t("Restored 2 queued messages to editor")).toBe("2 messages en attente remis dans la saisie");
		expect(t("Appearance. Advanced settings only.")).toBe("Apparence. Réglages avancés seulement.");
		expect(t("Module changes apply at the next start.")).toBe(
			"Les changements de modules s'appliqueront au prochain démarrage.",
		);
		expect(
			t("Connects the MCP servers (external tool providers) listed in mcp.json. Changes take effect after /reload."),
		).toBe(
			"Connecte les serveurs MCP (fournisseurs d'outils externes) listés dans mcp.json. Le changement s'applique après /reload.",
		);
		expect(t("Untranslated first. Takes effect at the next start.")).toBe(
			"Untranslated first. S'applique au prochain démarrage.",
		); // fork: the thinking refusal names its fix in both languages.
		expect(t(THINKING_UNSUPPORTED)).toBe(
			"Ce modèle ne prend pas en charge la réflexion. S'il la prend en charge, mettez Réflexion à oui dans /model-settings.",
		);
	});

	it("reads /docs in French when a page is translated, and in English otherwise", () => {
		const dir = getDocsPath();
		const fr = docTopics(dir, "fr");
		expect(fr.find((topic) => topic.path === "models.md")?.label).toBe("Guides › Utiliser Prism › Choisir un modèle");
		expect(docTopics(dir, "en").find((topic) => topic.path === "models.md")?.label).not.toContain("modèle");
		expect(docFile("models.md", dir, "fr")).toBe(join(dir, "fr", "models.md"));
		expect(docFile("sdk.md", dir, "fr")).toBe(join(dir, "sdk.md"));
		expect(docFile("models.md", dir, "en")).toBe(join(dir, "models.md"));
		// Every translated page is listed in docs.json.
		const listed = new Set(fr.map((topic) => topic.path));
		for (const name of readdirSync(join(dir, "fr")).filter((file) => file.endsWith(".md")))
			expect(listed).toContain(name);
	});

	it("has no catalog entry whose English text is gone from the code", () => {
		// fork: the forked plug-ins (Goal, Plan) have catalog entries too.
		const roots = [join(__dirname, "../src"), join(__dirname, "../../tui/src"), join(__dirname, "../vendor/forks")];
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (path.endsWith(".ts") && !path.includes(`${join("fork", "i18n")}`)) files.push(path);
			}
		};
		for (const root of roots) walk(root);
		const code = files.map((file) => readFileSync(file, "utf8")).join("\n");
		// A text built from pieces (a `label: value` status, a menu's key hints) is found by its words.
		const words = (key: string) => key.match(/[A-Za-z][A-Za-z-]{2,}/g) ?? [];
		const orphans = Object.keys(FR).filter(
			(key) => !code.includes(key.trim()) && words(key).some((word) => !code.includes(word)),
		);
		// A pattern is found by its fixed parts, the text between the `{n}` slots.
		const orphanPatterns = Object.keys(FR_PATTERNS).filter((key) =>
			key
				.split(/\{\d\}/)
				.map((part) => part.trim())
				.some(
					(part) => part.length > 2 && !code.includes(part) && words(part).some((word) => !code.includes(word)),
				),
		);
		expect(orphans).toEqual([]);
		expect(orphanPatterns).toEqual([]);
	});
});

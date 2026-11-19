// fork: the startup trust prompt is in the interface language, its choices still saved as is.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { type Language, setLanguage } from "../src/fork/i18n/index.ts";

const roots: string[] = [];

describe("fork: startup trust prompt", () => {
	afterEach(() => {
		setLanguage("en");
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it.each([
		["fr", "Approuver le dossier du projet ?", "Approuver", "Ne pas approuver"],
		["en", "Trust project folder?", "Trust", "Do not trust"],
	] as const)("asks in %s and saves the choice made", async (language: Language, title, trust, refuse) => {
		setLanguage(language);
		const root = mkdtempSync(join(tmpdir(), "prism-trust-prompt-"));
		roots.push(root);
		const cwd = join(root, "project");
		mkdirSync(cwd);
		writeFileSync(join(cwd, "AGENTS.md"), "# Project\n");
		for (const [label, trusted] of [
			[refuse, false],
			[trust, true],
		] as const) {
			const store = new ProjectTrustStore(join(root, `agent-${trusted}`));
			let shown: { title: string; options: string[] } | undefined;
			const result = await resolveProjectTrusted({
				cwd,
				trustStore: store,
				projectTrustContext: {
					cwd,
					mode: "tui",
					hasUI: true,
					ui: {
						select: async (prompt: string, options: string[]) => {
							shown = { title: prompt, options };
							return label;
						},
						confirm: async () => false,
						input: async () => undefined,
						notify: () => {},
					},
				},
			});
			expect(shown?.title.split("\n")[0]).toBe(title);
			expect(shown?.title).toContain(cwd);
			expect(shown?.options).toContain(label);
			// No English left in the French prompt, the folder's path aside.
			if (language === "fr") expect(shown?.title.replace(cwd, "")).not.toMatch(/\b(Trust|This allows)\b/);
			if (language === "fr")
				for (const option of shown?.options ?? []) expect(option).not.toMatch(/Trust|this session/);
			expect(result).toBe(trusted);
			expect(store.get(cwd)).toBe(trusted);
		}
	});
});

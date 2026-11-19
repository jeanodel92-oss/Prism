// the ask_user_question dialog speaks Prism's language through its i18n bridge; the question,
// the options and the answers returned to the model stay as written.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../src/fork/i18n/index.ts";
import { translateUi, UI_I18N } from "../src/fork/menu-i18n.ts";
import { loadVendored } from "./fork-vendored-module.ts";

interface Answer {
	kind: string;
	answer?: string;
	selected?: string[];
}
const { runRpcQuestionnaire } = await loadVendored<{
	runRpcQuestionnaire: (
		ui: unknown,
		params: { questions: unknown[] },
	) => Promise<{ cancelled: boolean; answers: Answer[] }>;
}>(join(__dirname, "../vendor/forks/rpiv-ask-user-question/rpc-fallback.ts"));

const hooks = globalThis as Record<symbol, unknown>;
const saved = hooks[UI_I18N];

function recordingUi(answers: (string | undefined)[]) {
	const titles: string[] = [];
	const options: string[][] = [];
	return {
		titles,
		options,
		ui: {
			select: async (title: string, choices: string[]) => {
				titles.push(title);
				options.push(choices);
				return answers.shift();
			},
			input: async (title: string) => {
				titles.push(title);
				return answers.shift();
			},
			confirm: async () => false,
			notify: () => {},
		},
	};
}

const question = {
	question: "Which database?",
	header: "DB",
	options: [
		{ label: "Postgres $&", description: "relational", preview: "CREATE TABLE t();" },
		{ label: "SQLite", description: "file" },
	],
};

describe("fork: ask_user_question in the interface language", () => {
	afterEach(() => {
		setLanguage("en");
		hooks[UI_I18N] = saved;
	});

	it("words the dialog's own texts in French and returns the answers as written", async () => {
		hooks[UI_I18N] = translateUi;
		setLanguage("fr");
		const single = recordingUi(["3. Écrire autre chose.", "MySQL"]);
		const result = await runRpcQuestionnaire(single.ui, { questions: [question] });
		expect(single.titles[0]).toBe("[DB] Which database?\n\n--- Aperçu de 1. Postgres $& ---\nCREATE TABLE t();");
		expect(single.options[0]?.at(-1)).toBe("3. Écrire autre chose.");
		expect(single.titles[1]).toBe("[DB] Which database?\n\nVotre réponse :");
		expect(result).toMatchObject({ cancelled: false, answers: [{ kind: "custom", answer: "MySQL" }] });

		const multi = recordingUi(["1,2"]);
		const chosen = await runRpcQuestionnaire(multi.ui, { questions: [{ ...question, multiSelect: true }] });
		expect(multi.titles[0]).toContain("Entrez les numéros de toutes les réponses qui conviennent");
		expect(chosen.answers[0]).toMatchObject({ kind: "multi", selected: ["Postgres $&", "SQLite"] });
	});

	it("keeps the published English without Prism's hook", async () => {
		hooks[UI_I18N] = undefined;
		setLanguage("fr");
		const single = recordingUi(["3. Type something.", "MySQL"]);
		await runRpcQuestionnaire(single.ui, { questions: [question] });
		expect(single.titles[0]).toContain("--- 1. Postgres $& preview ---");
		expect(single.titles[1]).toBe("[DB] Which database?\n\nType your answer:");
	});
});

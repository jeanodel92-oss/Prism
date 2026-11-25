// in the window and the phone (the RPC dialogs), a questionnaire of several
// questions offers the way back to the previous question, then a review where each answer can be changed before the
// answers are sent. Once an option was chosen there was no way back.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadVendored } from "./fork-vendored-module.ts";

interface Answer {
	questionIndex: number;
	kind: string;
	answer?: string | null;
	selected?: string[];
}
const { runRpcQuestionnaire } = await loadVendored<{
	runRpcQuestionnaire: (
		ui: unknown,
		params: { questions: unknown[] },
	) => Promise<{ cancelled: boolean; answers: Answer[] }>;
}>(join(__dirname, "../vendor/forks/rpiv-ask-user-question/rpc-fallback.ts"));

function scriptedUi(replies: (string | undefined)[]) {
	const titles: string[] = [];
	const options: string[][] = [];
	return {
		titles,
		options,
		ui: {
			select: async (title: string, choices: string[]) => {
				titles.push(title);
				options.push(choices);
				return replies.shift();
			},
			input: async (title: string) => {
				titles.push(title);
				options.push([]);
				return replies.shift();
			},
		},
	};
}

const questions = [
	{
		question: "Which database?",
		header: "DB",
		options: [
			{ label: "Postgres", description: "a" },
			{ label: "SQLite", description: "b" },
		],
	},
	{
		question: "Which cache?",
		header: "Cache",
		options: [
			{ label: "Redis", description: "c" },
			{ label: "None", description: "d" },
		],
	},
	{
		question: "Which features?",
		header: "Features",
		multiSelect: true,
		options: [
			{ label: "Auth", description: "e" },
			{ label: "Search", description: "f" },
		],
	},
];

describe("fork: ask_user_question's way back and review in the window", () => {
	it("goes back to the previous question, then reviews the answers before sending them", async () => {
		const run = scriptedUi([
			"1. Postgres — a",
			"← Previous question",
			"2. SQLite — b",
			"1. Redis — c",
			"1,2",
			"Submit answers",
		]);
		const result = await runRpcQuestionnaire(run.ui, { questions });
		expect(run.options[0]).not.toContain("← Previous question");
		expect(run.options[1]?.at(-1)).toBe("← Previous question");
		expect(run.titles[2]).toBe("[DB] Which database?");
		expect(run.titles[5]).toBe(
			"Review your answers\n\n1. Which database?\n   → SQLite\n2. Which cache?\n   → Redis\n3. Which features?\n   → Auth, Search",
		);
		expect(run.options[5]).toEqual([
			"Submit answers",
			"Change 1. DB",
			"Change 2. Cache",
			"Change 3. Features",
			"Cancel",
		]);
		expect(result.cancelled).toBe(false);
		expect(result.answers.map((answer) => answer.answer ?? answer.selected)).toEqual([
			"SQLite",
			"Redis",
			["Auth", "Search"],
		]);
	});

	it("changes an answer from the review, keeps it when that question is dismissed, and cancels from the review", async () => {
		const run = scriptedUi([
			"1. Postgres — a",
			"1. Redis — c",
			"",
			"Change 2. Cache",
			"2. None — d",
			"Change 1. DB",
			undefined,
			"Submit answers",
		]);
		const result = await runRpcQuestionnaire(run.ui, { questions });
		// A question reopened from the review has no way back: the review is where it returns.
		expect(run.options[4]).not.toContain("← Previous question");
		expect(run.titles[7]).toContain(
			"1. Which database?\n   → Postgres\n2. Which cache?\n   → None\n3. Which features?\n   → (no answer)",
		);
		expect(result).toMatchObject({ cancelled: false });
		expect(result.answers.map((answer) => answer.questionIndex)).toEqual([0, 1, 2]);
		expect(result.answers[1]).toMatchObject({ answer: "None" });

		const cancelled = await runRpcQuestionnaire(scriptedUi(["1. Postgres — a", "1. Redis — c", "", "Cancel"]).ui, {
			questions,
		});
		expect(cancelled.cancelled).toBe(true);
	});

	it("asks a single question as before, without a review", async () => {
		const run = scriptedUi(["2. SQLite — b"]);
		const result = await runRpcQuestionnaire(run.ui, { questions: [questions[0]] });
		expect(run.titles).toHaveLength(1);
		expect(result).toMatchObject({ cancelled: false, answers: [{ answer: "SQLite" }] });
	});
});

/**
 * fork: default execution budgets, in `/settings` > Conversation
 * . A session with no budget of its own starts with them; `/budget` changes the
 * current session's budgets only. Kept in the `budgets` object of the global settings.json.
 */
import { readGlobalSetting, saveGlobalSetting } from "./global-settings.ts";
import { t } from "./i18n/index.ts";
import { paged } from "./settings-pages.ts";
import type { SettingsSection } from "./settings-sections.ts";

export type BudgetKind = "time" | "tools" | "tokens" | "cost";
export type BudgetLimits = Partial<Record<BudgetKind, number>>;

export const BUDGET_KINDS: readonly BudgetKind[] = ["time", "tools", "tokens", "cost"];

/** Whether `amount` is a valid limit: positive, whole for tool calls and tokens. */
export function validBudget(kind: BudgetKind, amount: number | undefined): amount is number {
	return (
		amount !== undefined &&
		Number.isFinite(amount) &&
		amount > 0 &&
		(kind === "time" || kind === "cost" || Number.isInteger(amount))
	);
}

/** The default budgets of the global settings; invalid entries are left out. */
export function readDefaultBudgets(agentDir?: string): BudgetLimits {
	const value = readGlobalSetting("budgets", agentDir);
	const limits: BudgetLimits = {};
	if (typeof value !== "object" || value === null) return limits;
	for (const kind of BUDGET_KINDS) {
		const amount = (value as Record<string, unknown>)[kind];
		if (typeof amount === "number" && validBudget(kind, amount)) limits[kind] = amount;
	}
	return limits;
}

const ROWS: Record<BudgetKind, { label: string; description: string; expected: string; unit: (n: number) => string }> =
	{
		time: {
			label: "Default time budget",
			description:
				"Minutes a new session may work, counted while the agent runs; 80% gives a warning. /budget changes the current session's.",
			expected: "Type a number of minutes, such as 30.",
			unit: (n) => `${n} ${t("min")}`,
		},
		tools: {
			label: "Default tool-call budget",
			description: "Tool calls a new session may make; 80% gives a warning. /budget changes the current session's.",
			expected: "Type a whole number, such as 200.",
			unit: (n) => String(n),
		},
		tokens: {
			label: "Default token budget",
			description:
				"Tokens a new session may use (input, output and cache); 80% gives a warning. /budget changes the current session's.",
			expected: "Type a whole number, such as 2000000.",
			unit: (n) => String(n),
		},
		cost: {
			label: "Default cost budget",
			description:
				"Dollars a new session may spend, only with a model whose price is known (not applied otherwise); 80% gives a warning. /budget changes the current session's.",
			expected: "Type an amount in dollars, such as 5 or 0.50.",
			unit: (n) => `$${n}`,
		},
	};

/** What a limit of `kind` is typed as. */
export function budgetExpected(kind: BudgetKind): string {
	return t(ROWS[kind].expected);
}

export function budgetsSection(agentDir?: string): SettingsSection {
	return {
		domain: "conversation",
		items: (context) => {
			const limits = readDefaultBudgets(agentDir);
			return BUDGET_KINDS.map((kind) => {
				const row = ROWS[kind];
				const current = limits[kind] === undefined ? "off" : row.unit(limits[kind]!);
				return {
					id: `budget-default-${kind}`,
					label: row.label,
					description: row.description,
					currentValue: current,
					// a page, which the Prism window draws too.
					...paged((_value, done) => ({
						kind: "input",
						input: {
							title: row.label,
							description: row.description,
							current,
							parse: (text) => {
								const amount = Number(text.replace(/^\$/, ""));
								return validBudget(kind, amount) ? String(amount) : new Error(t(row.expected));
							},
							save: (value) =>
								saveGlobalSetting(["budgets", kind], value === undefined ? undefined : Number(value), agentDir),
							requestRender: context.requestRender,
							// The row's value is read again when the section is rebuilt.
							done: (changed) => done(changed ? "changed" : undefined),
						},
					})),
				};
			});
		},
	};
}

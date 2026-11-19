// fork: per-session execution limits enforced at agent and tool boundaries.

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { backgroundTasks as getBackgroundTasks } from "./background.ts";
import { fill, labelled, t } from "./i18n/index.ts";
import {
	type BudgetKind,
	budgetExpected,
	budgetsSection,
	type BudgetLimits as Limits,
	readDefaultBudgets,
	validBudget,
} from "./settings-budgets.ts";
import { type SettingsSection, setSettingsSection, settingsSections } from "./settings-sections.ts";

interface BudgetState {
	version: 1;
	limits: Limits;
	tools: number;
	tokens: number;
	cost: number;
	costUnknown: boolean;
	elapsedMs: number;
	startedAt?: number;
	/** Last time the state was saved, so a resumed session does not count the time Prism was closed. */
	savedAt?: number;
	blocked?: BudgetKind;
	warned: BudgetKind[];
	/**
	 * fork: the last session entry scanned for usage that comes without an
	 * assistant message (cache warming, compaction, branch summaries, tool results). Entries are only appended, so
	 * each one is counted once, across reloads too.
	 */
	scannedThrough?: string;
}

const ENTRY = "fork-budget-state";
const KINDS: BudgetKind[] = ["time", "tools", "tokens", "cost"];
const SETTINGS_OWNER = "budgets";
/** The longest delay setTimeout keeps (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;
const zero = (): BudgetState => ({
	version: 1,
	limits: {},
	tools: 0,
	tokens: 0,
	cost: 0,
	costUnknown: false,
	elapsedMs: 0,
	warned: [],
});

function positive(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function priced(ctx: ExtensionContext): boolean {
	const cost = ctx.model?.cost;
	return (
		cost !== undefined &&
		[cost, ...(cost.tiers ?? [])].some((rates) =>
			[rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some((rate) => rate > 0),
		)
	);
}

function tokens(usage: Usage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function backgroundTasks(): string[] {
	return (getBackgroundTasks() ?? []).filter((task) => task.status === "running").map((task) => task.id);
}

export interface BudgetSnapshot {
	rows: Array<{
		kind: BudgetKind;
		label: string;
		used: string;
		limit: number | null;
		limitText: string;
		fraction: number;
		available: boolean;
	}>;
	blocked: BudgetKind | null;
	notes: string[];
}
export interface BudgetPanel {
	snapshot(ctx: ExtensionContext): BudgetSnapshot;
	/** Sets a limit, or removes it with null; says why one is refused. */
	set(ctx: ExtensionContext, kind: BudgetKind, value: number | null): string | undefined;
}
const budgetPanels = new WeakMap<ExtensionContext["sessionManager"], BudgetPanel>();
/** The budget screen's data and operations for this context; undefined without the extension. */
export function budgetPanel(ctx: ExtensionContext): BudgetPanel | undefined {
	return budgetPanels.get(ctx.sessionManager);
}

export default function budgetsExtension(pi: ExtensionAPI): void {
	const flags: Record<BudgetKind, string> = {
		time: "budget-time",
		tools: "budget-tools",
		tokens: "budget-tokens",
		cost: "budget-cost",
	};
	pi.registerFlag(flags.time, { type: "string", description: t("Session wall-clock budget in minutes") });
	pi.registerFlag(flags.tools, { type: "string", description: t("Session tool-call budget") });
	pi.registerFlag(flags.tokens, { type: "string", description: t("Session token budget") });
	pi.registerFlag(flags.cost, {
		type: "string",
		description: t("Session cost budget in USD (requires known model pricing)"),
	});
	let state = zero();
	let context: ExtensionContext | undefined;
	let settingsSection: SettingsSection | undefined;
	let timer: NodeJS.Timeout | undefined;
	const report = (message: string, level: "warning" | "error" | "info" = "warning") => {
		if (context?.hasUI) context.ui.notify(message, level);
		else console.error(message);
	};
	const elapsed = () =>
		state.startedAt === undefined ? state.elapsedMs : state.elapsedMs + Date.now() - state.startedAt;
	const used = (kind: BudgetKind) =>
		kind === "time"
			? elapsed() / 60_000
			: kind === "tools"
				? state.tools
				: kind === "tokens"
					? state.tokens
					: state.cost;
	const limitText = (kind: BudgetKind, value: number) =>
		kind === "time" ? `${value} ${t("min")}` : kind === "cost" ? `$${value}` : String(value);
	const usedText = (kind: BudgetKind) =>
		kind === "time"
			? `${used(kind).toFixed(2)} ${t("min")}`
			: kind === "cost"
				? `$${state.cost.toFixed(4)}`
				: String(used(kind));
	const persist = () => {
		state.savedAt = Date.now();
		try {
			// fork: a copy, or the entry would follow every later change in memory.
			pi.appendEntry(ENTRY, structuredClone(state));
		} catch {
			/* A budget remains enforced in memory if persistence fails. */
		}
	};
	const stopTimer = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
	const scheduleTimeLimit = () => {
		stopTimer();
		if (!state.limits.time || state.startedAt === undefined || state.blocked) return;
		const warningAt = state.limits.time * 60_000 * 0.8;
		const remaining =
			!state.warned.includes("time") && elapsed() < warningAt
				? warningAt - elapsed()
				: state.limits.time * 60_000 - elapsed();
		timer = setTimeout(
			() => {
				if (!context || state.blocked) return;
				if (elapsed() < state.limits.time! * 60_000) {
					check(context, "time");
					scheduleTimeLimit();
					return;
				}
				state.blocked = "time";
				state.elapsedMs = elapsed();
				state.startedAt = undefined;
				persist();
				context.abort();
				report(stopMessage("time"), "error");
			},
			// fork: Node runs a longer delay after 1 ms, which re-armed the timer
			// almost at once, over and over; the longest delay it keeps, then the remaining time is recomputed.
			Math.min(MAX_TIMER_MS, Math.max(1, remaining)),
		);
		timer.unref();
	};
	function stopMessage(kind: BudgetKind): string {
		const stillRunning = backgroundTasks();
		return fill(
			"Execution budget exhausted: {0} consumed of {1}. No new model turn or tool call will start. An active tool call, if any, received an abort signal; external process exit is not confirmed here. Raise or clear it with /budget; detached tasks are still running: {2}.",
			usedText(kind),
			limitText(kind, state.limits[kind] ?? 0),
			stillRunning.length ? stillRunning.join(", ") : t("none"),
		);
	}
	const stopForUnknownCost = (ctx: ExtensionContext) => {
		state.costUnknown = true;
		state.blocked = "cost";
		persist();
		ctx.abort();
		report(
			t(
				"Cost budget cannot be enforced because model pricing or reported usage is unknown. Choose a priced model or clear the limit with /budget off cost.",
			),
			"error",
		);
	};
	const check = (ctx: ExtensionContext, kind: BudgetKind) => {
		const limit = state.limits[kind];
		if (!limit || state.blocked) return;
		if (used(kind) >= limit) {
			state.blocked = kind;
			state.elapsedMs = elapsed();
			state.startedAt = undefined;
			persist();
			ctx.abort();
			report(stopMessage(kind), "error");
			return;
		}
		warn(kind, limit);
	};
	const warn = (kind: BudgetKind, limit = state.limits[kind]) => {
		if (limit !== undefined && !state.warned.includes(kind) && used(kind) >= limit * 0.8) {
			state.warned.push(kind);
			persist();
			report(fill("Execution budget warning: {0} of {1} used.", usedText(kind), limitText(kind, limit)), "warning");
		}
	};
	const checkAll = (ctx: ExtensionContext) => {
		for (const kind of KINDS) check(ctx, kind);
	};
	/**
	 * fork: adds the usage of entries appended since the last scan that no
	 * assistant message_end reports. Like assistant usage, it counts only while a limit is set.
	 */
	const absorbEntries = (ctx: ExtensionContext): void => {
		const entries = ctx.sessionManager.getEntries();
		let start = 0;
		if (state.scannedThrough !== undefined) {
			start = entries.length;
			for (let index = entries.length - 1; index >= 0; index--) {
				if (entries[index].id === state.scannedThrough) {
					start = index + 1;
					break;
				}
			}
		}
		if (entries.length > 0) state.scannedThrough = entries[entries.length - 1].id;
		if (!Object.keys(state.limits).length) return;
		let added = false;
		for (const entry of entries.slice(start)) {
			const usage =
				entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
					? entry.usage
					: entry.type === "message" && entry.message.role === "toolResult"
						? entry.message.usage
						: undefined;
			if (!usage) continue;
			state.tokens += tokens(usage);
			if (Number.isFinite(usage.cost.total)) state.cost += usage.cost.total;
			added = true;
		}
		if (added) {
			persist();
			checkAll(ctx);
		}
	};
	const summary = () =>
		KINDS.map((kind) =>
			labelled(
				kind,
				state.limits[kind] === undefined
					? `${t("off")} (${labelled("consumed", usedText(kind))})`
					: `${usedText(kind)} / ${limitText(kind, state.limits[kind]!)}`,
			),
		).join("\n") +
		`\n${t("Warning threshold: 80%.")}\n${t("Tokens count input, output, cache read, and cache write.")}\n${labelled("Cost", state.costUnknown || !context || !priced(context) ? t("unknown") : `$${state.cost.toFixed(4)}`)}\n${labelled("State", state.blocked ? fill("paused at {0}", t(state.blocked)) : t("active"))}`;
	/** One change of `/budget`, by its words; what was wrong with it, if anything. */
	const change = (parts: string[], ctx: ExtensionContext): string | undefined => {
		if (parts[0] === "off") {
			if (parts.length === 1) {
				state.limits = {};
				state.elapsedMs = 0;
				state.startedAt = undefined;
			} else if (parts.length === 2 && KINDS.includes(parts[1] as BudgetKind)) {
				delete state.limits[parts[1] as BudgetKind];
				if (parts[1] === "time") {
					state.elapsedMs = 0;
					state.startedAt = undefined;
				}
			} else {
				return t("Usage: /budget [time|tools|tokens|cost <value>|off [kind]]");
			}
		} else {
			const kind = parts[0] as BudgetKind;
			const amount = positive(parts[1]);
			if (!KINDS.includes(kind) || !validBudget(kind, amount) || parts.length !== 2) {
				return t("Usage: /budget [time|tools|tokens|cost <value>|off [kind]]");
			}
			if (kind === "cost" && (!priced(ctx) || state.costUnknown)) {
				return t(
					state.costUnknown
						? "Cost budget refused: earlier cost usage is unknown for this session."
						: "Cost budget refused: the current model has no non-zero price metadata.",
				);
			}
			if (state.limits[kind] !== amount) state.warned = state.warned.filter((warned) => warned !== kind);
			if (kind === "time" && state.limits.time === undefined) {
				state.elapsedMs = 0;
				state.startedAt = undefined;
			}
			state.limits[kind] = amount;
		}
		state.blocked = undefined;
		if (state.limits.cost && (state.costUnknown || !priced(ctx))) {
			state.costUnknown = true;
			state.blocked = "cost";
			report(
				t(
					"Cost budget cannot be enforced because model pricing or reported usage is unknown. Choose a priced model or clear the limit with /budget off cost.",
				),
				"error",
			);
		}
		state.warned = state.warned.filter((kind) => state.limits[kind] !== undefined);
		scheduleTimeLimit();
		persist();
		return undefined;
	};
	/** fork.9 QA: `/budget` alone, a menu in the style of /goal: each budget with what it used; Enter changes it. */
	const menu = async (ctx: ExtensionContext): Promise<void> => {
		for (;;) {
			const rows = new Map(
				KINDS.map((kind) => [
					labelled(
						kind,
						state.limits[kind] === undefined
							? `${t("off")} (${labelled("consumed", usedText(kind))})`
							: `${usedText(kind)} / ${limitText(kind, state.limits[kind]!)}`,
					),
					kind,
				]),
			);
			const allOff = t("Turn all limits off");
			const close = t("Close");
			const choice = await ctx.ui.select(t("Budgets of this session"), [
				...rows.keys(),
				...(KINDS.some((kind) => state.limits[kind] !== undefined) ? [allOff] : []),
				close,
			]);
			if (!choice || choice === close) return;
			const error = choice === allOff ? change(["off"], ctx) : await ask(ctx, rows.get(choice)!);
			if (error) report(error, "error");
		}
	};

	/** Asks a new limit of `kind`; empty turns it off, Esc changes nothing. What was wrong with it, if anything. */
	const ask = async (ctx: ExtensionContext, kind: BudgetKind): Promise<string | undefined> => {
		const typed = await ctx.ui.input(
			fill("{0}: {1} Empty turns it off.", t(kind), budgetExpected(kind)),
			state.limits[kind] === undefined ? "" : String(state.limits[kind]),
		);
		if (typed === undefined) return undefined;
		const value = typed.trim().replace(/^\$/, "");
		if (!value) return change(["off", kind], ctx);
		return validBudget(kind, Number(value)) ? change([kind, value], ctx) : budgetExpected(kind);
	};

	pi.registerCommand("budget", {
		description: t("Show or change execution budgets for this session"),
		getArgumentCompletions: (prefix) => {
			const known = [
				{ value: "time ", label: "time", description: t("Minutes, such as time 30") },
				{ value: "tools ", label: "tools", description: t("Tool calls, such as tools 200") },
				{ value: "tokens ", label: "tokens", description: t("Tokens, such as tokens 2000000") },
				{ value: "cost ", label: "cost", description: t("Dollars, such as cost 5") },
				{ value: "off", label: "off", description: t("Turn all limits off, or one: off time") },
				{ value: "status", label: "status", description: t("Show the budgets as a notice") },
			];
			const found = known.filter((item) => item.value.startsWith(prefix.trimStart()));
			return found.length > 0 ? found : null;
		},
		handler: async (args, ctx) => {
			context = ctx;
			const parts = args?.trim().split(/\s+/) ?? [];
			if (parts.length === 0 || parts[0] === "") {
				if (ctx.hasUI) await menu(ctx);
				else report(summary(), "info");
				return;
			}
			if (parts[0] === "status" && parts.length === 1) {
				report(summary(), "info");
				return;
			}
			const error = change(parts, ctx);
			report(error ?? summary(), error ? "error" : "info");
		},
	});
	// the window's /budget screen.
	const panel: BudgetPanel = {
		snapshot: (ctx) => {
			context = ctx;
			return {
				rows: KINDS.map((kind) => ({
					kind,
					label: t(kind),
					used: usedText(kind),
					limit: state.limits[kind] ?? null,
					limitText: state.limits[kind] === undefined ? t("off") : limitText(kind, state.limits[kind]!),
					fraction: state.limits[kind] ? Math.min(1, used(kind) / state.limits[kind]!) : 0,
					available: kind !== "cost" || (priced(ctx) && !state.costUnknown),
				})),
				blocked: state.blocked ?? null,
				notes: summary().split("\n").slice(KINDS.length),
			};
		},
		set: (ctx, kind, value) => {
			context = ctx;
			return change(value === null ? ["off", kind] : [kind, String(value)], ctx);
		},
	};
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		budgetPanels.set(ctx.sessionManager, panel);
		// fork: the default budgets in /settings > Conversation, while this session runs.
		settingsSection = budgetsSection();
		setSettingsSection(SETTINGS_OWNER, settingsSection);
		state = zero();
		let saved = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY && entry.data && typeof entry.data === "object") {
				// A copy, so the restored state never changes the saved entry.
				state = structuredClone(entry.data) as BudgetState;
				saved = true;
			}
		}
		// A session with no budget state of its own starts with the defaults; a cost budget only with a priced
		// model, since it would otherwise pause every turn.
		if (!saved) {
			const defaults = readDefaultBudgets();
			if (defaults.cost !== undefined && !priced(ctx)) delete defaults.cost;
			state.limits = defaults;
		}
		// Usage already in the session before budgets scanned it is not counted afresh.
		if (state.scannedThrough === undefined) state.scannedThrough = ctx.sessionManager.getEntries().at(-1)?.id;
		// A run cut short by a crash or exit counts until its last save, not until now.
		if (state.startedAt !== undefined) {
			state.elapsedMs += Math.max(0, (state.savedAt ?? state.startedAt) - state.startedAt);
			state.startedAt = undefined;
		}
		for (const kind of KINDS) {
			const flag = positive(
				typeof pi.getFlag(flags[kind]) === "string" ? (pi.getFlag(flags[kind]) as string) : undefined,
			);
			if (flag !== undefined && validBudget(kind, flag)) state.limits[kind] = flag;
		}
		if (state.limits.cost && (!priced(ctx) || state.costUnknown)) {
			state.costUnknown = true;
			state.blocked = "cost";
			report(
				t(
					"Cost budget cannot be enforced because model pricing or reported usage is unknown. Choose a priced model or clear the limit with /budget off cost.",
				),
				"error",
			);
		}
		if (Object.keys(state.limits).length) persist();
		scheduleTimeLimit();
	});
	// fork: once a budget is exhausted, a new prompt is refused before
	// any request; the abort of agent_start came after the run's first request had gone. /budget runs before this.
	pi.on("input", (_event, ctx) => {
		if (!state.blocked) return;
		context = ctx;
		report(
			fill(
				"Execution budget exhausted ({0}): the message was not sent. Raise or clear it with /budget.",
				t(state.blocked),
			),
			"error",
		);
		return { action: "handled" };
	});
	pi.on("agent_start", (_event, ctx) => {
		context = ctx;
		absorbEntries(ctx);
		if (!Object.keys(state.limits).length) return;
		if (state.limits.cost && !priced(ctx) && !state.blocked) stopForUnknownCost(ctx);
		if (state.blocked) {
			ctx.abort();
			return;
		}
		if (state.startedAt === undefined) {
			state.startedAt = Date.now();
			persist();
		}
		scheduleTimeLimit();
		checkAll(ctx);
	});
	// fork: the time budget counts while the agent runs; once it has settled, the
	// time the user takes to read or think until the next prompt is not counted. Not saved here: the last save of the
	// run (its last message) already bounds it on resume, and the next run saves when it starts.
	pi.on("agent_settled", () => {
		if (state.startedAt === undefined) return;
		state.elapsedMs = elapsed();
		state.startedAt = undefined;
		stopTimer();
	});
	pi.on("tool_call", (_event, ctx) => {
		context = ctx;
		if (state.blocked)
			return {
				block: true,
				terminate: true,
				reason: "Execution budget exhausted. Stop and wait for the user to resume with /budget.",
			};
		if (!Object.keys(state.limits).length) return;
		if (state.limits.tools !== undefined && state.tools >= state.limits.tools) {
			state.blocked = "tools";
			persist();
			report(stopMessage("tools"), "error");
			return {
				block: true,
				terminate: true,
				reason: "Execution budget exhausted. Stop and wait for the user to resume with /budget.",
			};
		}
		state.tools++;
		persist();
		warn("tools");
	});
	pi.on("tool_result", (_event) => {
		if (state.blocked) return;
		if (state.limits.tools === undefined || state.tools < state.limits.tools) return;
		state.blocked = "tools";
		persist();
		report(stopMessage("tools"), "error");
	});
	pi.on("turn_end", (_event, ctx) => {
		context = ctx;
		absorbEntries(ctx);
		if (state.blocked) return { stop: true };
		if (state.limits.tools !== undefined && state.tools >= state.limits.tools) {
			state.blocked = "tools";
			persist();
			report(stopMessage("tools"), "error");
			return { stop: true };
		}
	});
	pi.on("message_end", (event, ctx) => {
		context = ctx;
		absorbEntries(ctx);
		if (!Object.keys(state.limits).length || event.message.role !== "assistant") return;
		if (!("usage" in event.message) || !event.message.usage) {
			if (state.limits.cost) stopForUnknownCost(ctx);
			else {
				state.costUnknown = true;
				persist();
			}
			return;
		}
		const usage = event.message.usage;
		state.tokens += tokens(usage);
		if (priced(ctx) && Number.isFinite(usage.cost.total)) state.cost += usage.cost.total;
		else if (state.limits.cost) {
			stopForUnknownCost(ctx);
			return;
		} else state.costUnknown = true;
		persist();
		checkAll(ctx);
	});
	// fork: compactions and branch summaries are paid requests too.
	pi.on("session_compact", (_event, ctx) => {
		context = ctx;
		absorbEntries(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		context = ctx;
		absorbEntries(ctx);
	});
	// fork: each cache refresh is a paid request: the previous refresh is counted
	// first, and none is sent once a budget is exhausted or would be by this refresh.
	pi.on("cache_warming_decision", (event, ctx) => {
		context = ctx;
		absorbEntries(ctx);
		if (state.blocked) return { action: "stop" };
		const { tokens: tokenLimit, cost: costLimit } = state.limits;
		if (tokenLimit !== undefined && state.tokens >= tokenLimit) return { action: "stop" };
		if (costLimit !== undefined && state.cost + event.warmCost >= costLimit) return { action: "stop" };
		return undefined;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		// fork: a reload keeps the session manager. Without this instance (module turned
		// off), its panel must not keep accepting budgets nobody applies; a new instance has put its own in place.
		if (budgetPanels.get(ctx.sessionManager) === panel) budgetPanels.delete(ctx.sessionManager);
		// A session started since then has put its own section in place: leave it.
		if (settingsSection && settingsSections().includes(settingsSection))
			setSettingsSection(SETTINGS_OWNER, undefined);
		settingsSection = undefined;
	});
}

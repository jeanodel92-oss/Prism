/**
 * fork: the task scope. The model proposes what
 * a task needs, in plain words (`propose_scope`), or the user sets it from /perm scope; the user approves it
 * on {@link ScopeView}. While it lasts, the calls and hosts it covers pass without a question; anything else
 * is asked about (the user stays) or refused at once (the user is away), and one refusal holds for the whole
 * task. The model never approves anything: only the screen does.
 */
import {
	type Component,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../modes/interactive/theme/theme.ts";
import { readGlobalSetting } from "./global-settings.ts";
import { fill, t } from "./i18n/index.ts";
import { paint, tok } from "./prism/lib/palette.ts";
import { visibleText } from "./visible-text.ts";

/** One line of a scope: an intention in words, and what it lets the agent do. */
export interface ScopeOperation {
	/** The intention, as the user reads it: "Run the tests". */
	what: string;
	/** Command prefixes: `npm test` covers `npm test --silent`. */
	commands: string[];
	/** Files it may change, as globs relative to the project: `src/**`. */
	writes: string[];
	/** Hosts its commands may connect to; with no command, any sandboxed command may. */
	hosts: string[];
}

/** What a task refused, for the report the user reads when it ends. */
export interface ScopeBlock {
	what: string;
	why: "away" | "again" | "user" | "unanswered";
}

/** An approved scope, while its task runs. */
export interface TaskScope {
	operations: ScopeOperation[];
	away: boolean;
	/** Milliseconds since the epoch. */
	until: number;
	/** Its task has started: the end of that agent run ends the scope. */
	running: boolean;
	/** Rules the user added when asked ("for this task"): `bash(npm run build*)`. */
	rules: string[];
	/** Hosts the user added when asked, each to the commands of one rule, as for a project. */
	hostGrants: { host: string; rule: string }[];
	/** Rules and hosts refused in this task: refused again without a question. */
	refused: Set<string>;
	blocked: ScopeBlock[];
}

/** What the model or the user proposes; nothing is in effect before the screen approves it. */
export interface ScopeProposal {
	operations: ScopeOperation[];
	minutes: number;
	/** Who wrote it, shown in the title. */
	from: "agent" | "user";
}

export const DURATIONS = [15, 30, 60, 120, 240, 480] as const;
export const MAX_MINUTES = 480;
/** The longest file glob the model may propose for a scope. */
export const MAX_GLOB_LENGTH = 256;
/**
 * The most file globs the model may propose in one scope: each write is matched against every
 * glob, so their number bounds that cost as {@link MAX_GLOB_LENGTH} bounds each one's.
 */
export const MAX_SCOPE_GLOBS = 64;

/** fork.9 QA: the longest scope, in minutes: `scopeMaxMinutes` of the global settings.json, 480 by default. */
export function maxScopeMinutes(agentDir?: string): number {
	const value = readGlobalSetting("scopeMaxMinutes", agentDir);
	return typeof value === "number" && Number.isInteger(value) && value >= 5 ? value : MAX_MINUTES;
}

const clean = (values: unknown): string[] =>
	Array.isArray(values)
		? [
				...new Set(
					values.filter((value): value is string => typeof value === "string").map((value) => value.trim()),
				),
			].filter(Boolean)
		: [];

/**
 * Checks a proposal from the model: an Error says what to change. A command prefix with a wildcard or a
 * substitution, a path outside the project or a host pattern wider than one domain's subdomains would allow
 * more than the line shows.
 */
export function parseProposal(
	input: { operations?: unknown; minutes?: unknown },
	maxMinutes: number = MAX_MINUTES,
): ScopeProposal | Error {
	const raw = Array.isArray(input.operations) ? input.operations : [];
	const operations: ScopeOperation[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const fields = item as Record<string, unknown>;
		// fork: the model's words show their terminal controls wherever the
		// scope is shown; a command prefix or a path with one is refused, since it would not read as it matches.
		const what = typeof fields.what === "string" ? visibleText(fields.what.trim()) : "";
		const commands = clean(fields.commands);
		const writes = clean(fields.writes);
		const hosts = clean(fields.hosts).map((host) => host.toLowerCase());
		if (!what) return new Error("Each operation needs `what`: the intention in plain words.");
		const hidden = [...commands, ...writes].find((text) => visibleText(text) !== text);
		if (hidden !== undefined)
			return new Error(`"${visibleText(hidden)}": no control or invisible characters in a command or a path.`);
		const badCommand = commands.find((command) => /[*?`]|\$\(/.test(command));
		if (badCommand) return new Error(`Command prefix "${badCommand}": no wildcards or substitutions.`);
		const badWrite = writes.find(
			(glob) => glob.startsWith("/") || glob.startsWith("~") || glob.split("/").includes(".."),
		);
		if (badWrite) return new Error(`Path "${badWrite}": only paths inside the project, relative to it.`);
		// fork: matching costs the path's length times the glob's.
		const longWrite = writes.find((glob) => glob.length > MAX_GLOB_LENGTH);
		if (longWrite) return new Error(`Path "${longWrite.slice(0, 40)}…": at most ${MAX_GLOB_LENGTH} characters.`);
		const badHost = hosts.find((host) => !/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host !== "localhost");
		if (badHost) return new Error(`Host "${badHost}": a host name, or *.domain for its subdomains.`);
		if (commands.length + writes.length + hosts.length === 0)
			return new Error(`Operation "${what}" allows nothing: give its commands, files or hosts.`);
		operations.push({ what, commands, writes, hosts });
	}
	if (operations.length === 0) return new Error("Propose at least one operation.");
	const globs = operations.reduce((count, operation) => count + operation.writes.length, 0);
	if (globs > MAX_SCOPE_GLOBS)
		return new Error(
			`${globs} file paths: at most ${MAX_SCOPE_GLOBS} in a scope. Group them with wildcards, such as src/**.`,
		);
	const minutes = typeof input.minutes === "number" && Number.isFinite(input.minutes) ? input.minutes : 60;
	return { operations, minutes: Math.min(maxMinutes, Math.max(5, Math.round(minutes))), from: "agent" };
}

/** What an operation lets the agent do, on one line under its intention. */
/**
 * What an operation allows, in the interface language for the user, in English for the model
 * . The commands, files and hosts are shown as they are.
 */
export function operationDetail(operation: ScopeOperation, forModel = false): string {
	const say = forModel
		? (key: string, ...values: string[]) => key.replace(/\{(\d)\}/g, (slot, n: string) => values[Number(n)] ?? slot)
		: fill;
	const parts: string[] = [];
	// "*" and "**" come only from the user's own lines in /perm scope.
	if (operation.commands.includes("*")) parts.push(say("runs any command in the sandbox, except dangerous ones"));
	else if (operation.commands.length) parts.push(say("runs {0}", operation.commands.join(", ")));
	if (operation.writes.includes("**")) parts.push(say("changes any file in the project"));
	else if (operation.writes.length) parts.push(say("changes {0}", operation.writes.join(", ")));
	if (operation.hosts.length)
		parts.push(
			operation.commands.length
				? say("connects to {0}", operation.hosts.join(", "))
				: say("any command may connect to {0}", operation.hosts.join(", ")),
		);
	return parts.join(" · ");
}

/**
 * § 9.5: what a scope limits and what it does not, on the screen and in /perm scope. Reading outside the project is
 * said to be limited only while it is: limit turned on and commands in the sandbox.
 */
export function scopeLimits(readLimited: boolean): string[] {
	return readLimited
		? [
				"Limits: the commands run, the files changed, the hosts sandboxed commands connect to, and the other tools, which still ask. Reading stays limited to the project and what its tools need (/settings › What the agent reads).",
				"Does not limit: commands that run outside the sandbox, what MCP and LSP servers and your browser read themselves, what an allowed program does with its connections.",
			]
		: [
				"Limits: the commands run, the files changed, the hosts sandboxed commands connect to, and the other tools, which still ask.",
				"Does not limit: reading files outside the project (except hidden folders), commands that run outside the sandbox, what an allowed program does with its connections.",
			];
}

const WHY: Record<ScopeBlock["why"], string> = {
	away: "refused while you were away",
	again: "refused again: already refused in this task",
	user: "you blocked it",
	unanswered: "not answered",
};

/** The report shown when a task ends: each refused action once, with how many times. */
export function blockedReport(blocked: readonly ScopeBlock[]): string | undefined {
	if (blocked.length === 0) return undefined;
	const counts = new Map<string, { block: ScopeBlock; times: number }>();
	for (const block of blocked) {
		// A refusal repeated in the task is counted with the first one, whose reason is shown.
		const key = block.what;
		const seen = counts.get(key);
		if (seen) seen.times++;
		else counts.set(key, { block, times: 1 });
	}
	const lines = [...counts.values()].map(({ block, times }) => {
		const count = times > 1 ? t(` (${times} times)`) : "";
		// fork: the refused call's target, as the call gave it.
		return `  • ${visibleText(block.what)}: ${t(WHY[block.why])}${count}`;
	});
	return [t("Task scope ended. Outside it, Prism refused:"), ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// The approval screen
// ---------------------------------------------------------------------------

/** What the user approved: the lines kept, the duration and whether they stay. */
export interface ScopeApproval {
	operations: ScopeOperation[];
	minutes: number;
	away: boolean;
}

/** The durations the approval offers, up to `maxMinutes`, and the index of the proposed one. */
export function scopeDurations(proposed: number, maxMinutes: number): { durations: number[]; index: number } {
	const minutes = Math.min(proposed, maxMinutes);
	const durations = [...new Set([...DURATIONS.filter((value) => value <= maxMinutes), maxMinutes, minutes])].sort(
		(a, b) => a - b,
	);
	return { durations, index: durations.indexOf(minutes) };
}

type Row =
	| { kind: "operation"; index: number }
	| { kind: "duration" }
	| { kind: "presence" }
	| { kind: "approve" }
	| { kind: "cancel" };

function padTo(text: string, width: number): string {
	const cut = truncateToWidth(text, Math.max(0, width), "…");
	return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
}

/**
 * The scope as the user approves it: each line can be left out, the duration and the presence changed;
 * « Approve » and « Cancel ». Enter (or space) acts on the focused row, Esc cancels.
 */
export class ScopeView implements Component {
	private readonly proposal: ScopeProposal;
	private readonly done: (approval: ScopeApproval | undefined) => void;
	private readonly kept: boolean[];
	private readonly durations: number[];
	private duration: number;
	private away = false;
	private focus = 0;
	private readonly readLimited: boolean;
	/** the terminal's height, and the first operation shown when they do not all fit. */
	private readonly height: () => number | undefined;
	private scroll = 0;

	constructor(
		proposal: ScopeProposal,
		done: (approval: ScopeApproval | undefined) => void,
		readLimited = false,
		maxMinutes: number = MAX_MINUTES,
		height: () => number | undefined = () => process.stdout.rows,
	) {
		this.proposal = proposal;
		this.done = done;
		this.readLimited = readLimited;
		this.height = height;
		this.kept = proposal.operations.map(() => true);
		({ durations: this.durations, index: this.duration } = scopeDurations(proposal.minutes, maxMinutes));
	}

	invalidate(): void {}

	private rows(): Row[] {
		return [
			...this.proposal.operations.map((_, index) => ({ kind: "operation" as const, index })),
			{ kind: "duration" },
			{ kind: "presence" },
			{ kind: "approve" },
			{ kind: "cancel" },
		];
	}

	private get minutes(): number {
		return this.durations[this.duration] ?? 60;
	}

	/** Framed like the permissions window, so the screen under the overlay does not show at its edges. */
	render(width: number): string[] {
		const inner = Math.max(20, width - 2);
		const border = (s: string) => paint(tok(theme, "borderAccent"), s);
		return [
			border(`┌${"─".repeat(inner)}┐`),
			...this.body(inner - 2).map((line) => `${border("│")} ${line} ${border("│")}`),
			border(`└${"─".repeat(inner)}┘`),
		];
	}

	private body(width: number): string[] {
		const top: string[] = [];
		const operations: string[][] = [];
		let out = top;
		const muted = (s: string) => theme.fg("muted", s);
		const rows = this.rows();
		const focused = rows[this.focus];
		const cursor = (row: Row) =>
			focused && JSON.stringify(focused) === JSON.stringify(row) ? theme.fg("accent", "❯ ") : "  ";
		const wrap = (text: string, indent: string) =>
			wrapTextWithAnsi(text, Math.max(10, width - visibleWidth(indent))).map((line) => `${indent}${line}`);

		out.push(
			theme.bold(
				theme.fg(
					"accent",
					this.proposal.from === "agent" ? t("Task scope proposed by the agent") : t("Set a task scope"),
				),
			),
		);
		out.push(...wrap(muted(t("Within it, the agent works without asking. Leave out a line with Enter.")), ""));
		out.push("");
		this.proposal.operations.forEach((operation, index) => {
			const row: Row = { kind: "operation", index };
			const box = this.kept[index] ? "[x]" : "[ ]";
			const shown = visibleText(operation.what);
			const what = this.kept[index] ? theme.fg("text", shown) : theme.fg("dim", shown);
			operations.push([
				...wrap(`${cursor(row)}${box} ${what}`, "").slice(0, 2),
				...wrap(muted(operationDetail(operation)), "      "),
			]);
		});
		const settings: string[] = [];
		out = settings;
		out.push("");
		out.push(`${cursor({ kind: "duration" })}${t(`Duration: ${this.minutes} min`)}  ${muted(t("(Enter: change)"))}`);
		out.push(
			`${cursor({ kind: "presence" })}${this.away ? t("While it runs: I'm away") : t("While it runs: I stay here")}  ${muted(t("(Enter: change)"))}`,
		);
		out.push(
			...wrap(
				muted(
					this.away
						? t("Anything else is refused at once; you get the list when the task ends.")
						: t("Anything else is asked about, as now."),
				),
				"    ",
			),
		);
		const limits: string[] = [];
		out = limits;
		out.push("");
		for (const line of scopeLimits(this.readLimited)) out.push(...wrap(muted(t(line)), ""));
		const actions: string[] = [];
		out = actions;
		out.push("");
		const none = this.kept.every((keep) => !keep);
		const approve = none ? theme.fg("dim", t("Approve")) : theme.bold(theme.fg("success", t("Approve")));
		out.push(`${cursor({ kind: "approve" })}${approve}`);
		out.push(`${cursor({ kind: "cancel" })}${t("Cancel")}`);
		out.push(muted(t("↑↓ move · Enter choose · Esc cancel")));
		return this.fitToHeight(top, operations, settings, limits, actions, focused).map((line) => padTo(line, width));
	}

	/**
	 * a scope taller than the terminal keeps its title and its actions in view and
	 * shows only the operations around the selected one, the header saying which. When even that does not fit, the
	 * limits' explanation goes first; a terminal shorter still shows the lines around the selection.
	 */
	private fitToHeight(
		top: string[],
		operations: string[][],
		settings: string[],
		limits: string[],
		actions: string[],
		focused: Row | undefined,
	): string[] {
		const all = [...top, ...operations.flat(), ...settings, ...limits, ...actions];
		const height = this.height();
		// The frame takes two rows.
		const room = height === undefined || height <= 0 ? Number.POSITIVE_INFINITY : height - 2;
		if (all.length <= room) return all;
		const focusedOperation = focused?.kind === "operation" ? focused.index : undefined;
		const size = (index: number) => operations[index]!.length;
		const needed = focusedOperation === undefined ? 1 : size(focusedOperation);
		let bottom = [...settings, ...limits, ...actions];
		if (room - top.length - bottom.length < needed) bottom = [...settings, ...actions];
		const budget = room - top.length - bottom.length;
		if (budget < needed) {
			// Too short for the title and the actions: the lines around the selected one.
			const at = Math.max(
				0,
				all.findIndex((line) => line.includes("❯ ")),
			);
			const from = Math.max(0, Math.min(at - Math.floor(room / 2), all.length - room));
			return all.slice(from, from + Math.max(1, room));
		}
		const count = operations.length;
		let from = Math.max(0, Math.min(this.scroll, count - 1));
		if (focusedOperation !== undefined && focusedOperation < from) from = focusedOperation;
		const extend = (start: number) => {
			let end = start;
			let used = 0;
			while (end < count && used + size(end) <= budget) used += size(end++);
			return end;
		};
		let to = extend(from);
		if (focusedOperation !== undefined && focusedOperation >= to) {
			to = focusedOperation + 1;
			from = focusedOperation;
			let used = size(from);
			while (from > 0 && used + size(from - 1) <= budget) used += size(--from);
		}
		this.scroll = from;
		const header = [...top];
		header[header.length - 1] = theme.fg(
			"muted",
			fill("{0}–{1} of {2}", String(from + 1), String(to), String(count)),
		);
		return [...header, ...operations.slice(from, to).flat(), ...bottom];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const rows = this.rows();
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.down") || kb.matches(data, "tui.input.tab")) {
			this.focus = (this.focus + 1) % rows.length;
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.focus = (this.focus - 1 + rows.length) % rows.length;
			return;
		}
		if (!(kb.matches(data, "tui.select.confirm") || data === " ")) return;
		const row = rows[this.focus];
		if (!row) return;
		if (row.kind === "operation") this.kept[row.index] = !this.kept[row.index];
		else if (row.kind === "duration") this.duration = (this.duration + 1) % this.durations.length;
		else if (row.kind === "presence") this.away = !this.away;
		else if (row.kind === "cancel") this.done(undefined);
		else {
			const operations = this.proposal.operations.filter((_, index) => this.kept[index]);
			if (operations.length > 0) this.done({ operations, minutes: this.minutes, away: this.away });
		}
	}
}

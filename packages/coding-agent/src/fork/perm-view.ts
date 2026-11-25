/**
 * fork: `/perm` as a window over the screen.
 *   • the four modes side by side, the one in effect highlighted; ←→ or a click changes it;
 *   • under them, what each mode does with each kind of action, drawn from the gate's own policy
 *     (permissions.ts, modePolicy), and one line that sums up the chosen mode;
 *   • the permissions given for a while or for the session, each with its « Revoke » button;
 *   • « Keep this mode as default », the saved rules and the help, then the key hints;
 *   • Esc, ✕ or a click outside the window closes it (fork/outside-press.ts).
 */
import {
	type Component,
	getKeybindings,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../modes/interactive/theme/theme.ts";
import { fill, t } from "./i18n/index.ts";
import type { Mode, PolicyRow, Verdict } from "./permissions.ts";
import { onBg, paint, tok } from "./prism/lib/palette.ts";

/** The window's widest size. */
export const PERM_MAX_WIDTH = 104;

/** The modes from the strictest to the most open, as the mockup lays them out. */
export const VIEW_MODES: Mode[] = ["safe", "ask", "broad", "unrestricted"];

export const MODE_LABELS: Record<Mode, string> = {
	safe: "Safe",
	ask: "Ask",
	broad: "Broad",
	unrestricted: "Unrestricted",
};

/** One line per mode: what the model may do without asking (also in /settings). */
export const MODE_SUMMARIES: Record<Mode, string> = {
	safe: "Reads and searches freely. Changes no file and runs only safe commands (ls, git status…). Internet: it asks.",
	ask: "Reads freely. Asks before changing a file, running a command or going on the internet.",
	broad: "Works in the project without asking. Still asks for what leaves the project, sudo and the first use of a browser or a desktop.",
	unrestricted:
		"Skips ordinary questions. Configuration uses configure_prism; security settings are user-only. Keep it for a throwaway machine or container.",
};

export const ROW_LABELS: Record<PolicyRow, string> = {
	read: "Read the project's files",
	"read-outside": "Read files outside the project",
	"write-project": "Change the project's files",
	"write-outside": "Change files outside the project",
	"process-safe": "Safe commands (ls, git status…)",
	"process-other": "Other commands",
	network: "Internet",
	computer: "Use a browser or a desktop",
	privilege: "Administrator rights (sudo)",
	"security-config": "Prism's security settings",
	undeclared: "Add-on tools that declare nothing",
};

const MARKS: Record<Verdict, string> = { allow: "✓", ask: "?", danger: "?!", block: "✗" };
const MARK_COLORS: Record<Verdict, "success" | "text" | "warning" | "error"> = {
	allow: "success",
	ask: "text",
	danger: "warning",
	block: "error",
};

/** A permission in effect: given for a while or for the session. */
export interface GrantView {
	/** fork: names the permission whatever its place in the list. */
	id?: string;
	effect: "allow" | "deny";
	/** What it covers, as the user reads it. */
	what: string;
	/** "15 minutes" or "this session". */
	scope: string;
	/** Time left, or "" for the session. */
	left: string;
}

export type PermViewAction = "keep-default" | "rules" | "help";

export interface PermViewOptions {
	mode: () => Mode;
	defaultMode: () => Mode;
	verdict: (mode: Mode, row: PolicyRow) => Verdict;
	rows: readonly PolicyRow[];
	grants: () => GrantView[];
	savedRules: () => number;
	/** The terminal's height, read at each render. */
	height: () => number;
	onMode: (mode: Mode) => void;
	/** `shown` is the permission the last render showed at `index`, the one to revoke. */
	onRevoke: (index: number, shown: GrantView | undefined) => void;
	onAction: (action: PermViewAction) => void;
	onClose: () => void;
}

type Focus = "modes" | "grants" | "buttons";

const BUTTONS: PermViewAction[] = ["keep-default", "rules", "help"];

/** Where the last render put things, for the mouse (rows and columns inside the window). */
interface Geometry {
	close: number;
	/** The rows of the mode headers and of the table, where a click in a column picks that mode. */
	tableRows: number[];
	columns: Array<[number, number]>;
	/** The rows of the permissions in effect: which one, and whether its Revoke button is on that row. */
	grantRows: Array<{ y: number; grant: number; revoke: boolean }>;
	revoke: [number, number];
	/** Each button's row and columns, by its index in BUTTONS. */
	buttons: Array<{ y: number; from: number; to: number }>;
	/** In a narrow window, each mode tab's row and columns, by its index in VIEW_MODES. */
	tabs: Array<{ y: number; from: number; to: number }>;
}

/** A line of the window's body; `kind` marks the lines the mouse acts on. */
interface BodyLine {
	text: string;
	/** Lines a short terminal may drop, the highest first: spacers 3, the legend 2, the mode ids and the summary 1. */
	drop?: number;
	kind?: "table" | "tabs" | "grant" | "buttons";
	/** On a permission's line: its index, and whether the line has its Revoke button. */
	grant?: { index: number; revoke: boolean };
	/** On a line of buttons: each button's columns and index. */
	buttons?: Array<{ from: number; to: number; index: number }>;
	/** On a line of mode tabs: each mode's columns and index in VIEW_MODES. */
	modes?: Array<{ from: number; to: number; index: number }>;
}

/** Fits `text` to exactly `width` columns. */
function padTo(text: string, width: number): string {
	const cut = truncateToWidth(text, Math.max(0, width), "…");
	return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
}

export class PermView implements Component {
	private readonly options: PermViewOptions;
	private focus: Focus = "modes";
	private grantIndex = 0;
	/** the first permission shown when they do not all fit. */
	private grantScroll = 0;
	/** The permissions the last render showed, in their order there. */
	private shownGrants: GrantView[] = [];
	private buttonIndex = 0;
	private geometry: Geometry | undefined;

	constructor(options: PermViewOptions) {
		this.options = options;
	}

	invalidate(): void {}

	private get modeIndex(): number {
		return Math.max(0, VIEW_MODES.indexOf(this.options.mode()));
	}

	private buttonLabel(action: PermViewAction): string {
		if (action === "keep-default") return t("Keep this mode as default");
		if (action === "rules") return `${t(`Saved rules (${this.options.savedRules()})`)}  ›`;
		return `${t("Help")}  ›`;
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 2);
		const border = (s: string) => paint(tok(theme, "borderAccent"), s);
		const muted = (s: string) => theme.fg("muted", s);
		const geometry: Geometry = {
			close: -1,
			tableRows: [],
			columns: [],
			grantRows: [],
			revoke: [0, 0],
			buttons: [],
			tabs: [],
		};
		const body: BodyLine[] = [];
		const push = (text: string, line: Omit<BodyLine, "text"> = {}) =>
			body.push({ ...line, text: padTo(text, inner) });
		const blank = () => push("", { drop: 3 });

		// The table: a label column, then one column per mode, each headed by its name ("● Unrestricted").
		// When the four names do not fit beside the labels, the modes become a row of tabs and the table
		// shows the chosen mode's column only, as /settings shows one column under 80.
		const nameWidth = Math.max(...VIEW_MODES.map((mode) => visibleWidth(` ● ${t(MODE_LABELS[mode])}`)));
		const longestLabel = Math.max(...this.options.rows.map((row) => visibleWidth(t(ROW_LABELS[row]))));
		const wide = inner - 1 - (longestLabel + 1) >= VIEW_MODES.length * nameWidth;
		const current = this.modeIndex;
		const band = tok(theme, "selectedBg");
		const modeLabel = this.focus === "modes" ? theme.fg("accent", "▌") : " ";
		const modeName = (mode: Mode, active: boolean) => {
			const name = ` ${active ? "●" : "○"} ${t(MODE_LABELS[mode])}`;
			return active ? theme.bold(theme.fg("text", name)) : theme.fg("muted", name);
		};
		const markOf = (mode: Mode, row: PolicyRow, active: boolean) => {
			const verdict = this.options.verdict(mode, row);
			return active
				? theme.fg(MARK_COLORS[verdict], `   ${MARKS[verdict]}`)
				: theme.fg("dim", `   ${MARKS[verdict]}`);
		};
		const rowLabel = (row: PolicyRow, width: number) => padTo(theme.fg("thinkingText", t(ROW_LABELS[row])), width);
		blank();
		if (wide) {
			const labelWidth = longestLabel + 1;
			const cell = Math.floor((inner - 1 - labelWidth) / VIEW_MODES.length);
			for (let i = 0; i < VIEW_MODES.length; i++) {
				const left = 1 + 1 + labelWidth + i * cell;
				geometry.columns.push([left, left + cell]);
			}
			const cellText = (i: number, text: string) =>
				i === current ? onBg(padTo(text, cell), band, cell) : padTo(text, cell);
			const names = VIEW_MODES.map((mode, i) => cellText(i, modeName(mode, i === current)));
			const ids = VIEW_MODES.map((mode, i) => cellText(i, muted(`   ${mode}`)));
			push(`${modeLabel}${padTo(muted(t("Mode")), labelWidth)}${names.join("")}`, { kind: "table" });
			push(` ${padTo("", labelWidth)}${ids.join("")}`, { kind: "table", drop: 1 });
			for (const row of this.options.rows) {
				const cells = VIEW_MODES.map((mode, i) => cellText(i, markOf(mode, row, i === current)));
				push(` ${rowLabel(row, labelWidth)}${cells.join("")}`, { kind: "table" });
			}
		} else {
			// The tabs, on as many lines as needed; a click on a name picks that mode.
			let line = { text: modeLabel, modes: [] as NonNullable<BodyLine["modes"]> };
			const lines = [line];
			VIEW_MODES.forEach((mode, index) => {
				const name = modeName(mode, index === current);
				const size = visibleWidth(name) + 1;
				if (line.modes.length > 0 && visibleWidth(line.text) + size > inner) {
					line = { text: " ", modes: [] };
					lines.push(line);
				}
				const from = 1 + visibleWidth(line.text);
				line.modes.push({ from, to: from + size, index });
				line.text += index === current ? onBg(`${name} `, band, size) : `${name} `;
			});
			for (const { text, modes } of lines) push(text, { kind: "tabs", modes });
			const cell = 6;
			const labelWidth = Math.max(8, inner - 1 - cell);
			for (const row of this.options.rows) {
				push(` ${rowLabel(row, labelWidth)}${markOf(VIEW_MODES[current]!, row, true)}`);
			}
		}
		const legend = [
			`${theme.fg("success", "✓")} ${t("without asking")}`,
			`${theme.fg("text", "?")} ${t("asks")}`,
			`${theme.fg("warning", "?!")} ${t("asks, flagged dangerous, never “always”")}`,
			`${theme.fg("error", "✗")} ${t("refused")}`,
		];
		for (const l of wrapTextWithAnsi(muted(legend.join("   ")), inner - 2)) push(` ${l}`, { drop: 2 });
		blank();

		// The chosen mode in one line.
		const mode = VIEW_MODES[current]!;
		const tag = mode === this.options.defaultMode() ? muted(` · ${t("default")}`) : "";
		// the table gained a row; a short terminal drops this name too, which the table's header shows.
		push(` ${theme.bold(theme.fg("text", t(MODE_LABELS[mode])))}${tag}`, { drop: 1 });
		for (const l of wrapTextWithAnsi(theme.fg("thinkingText", t(MODE_SUMMARIES[mode])), inner - 2)) {
			push(` ${l}`, { drop: 1 });
		}
		blank();

		// The permissions in effect.
		push(` ${muted(t("Current permissions"))}`);
		const grantsHeader = body[body.length - 1]!;
		const grants = this.options.grants();
		this.shownGrants = grants;
		this.grantIndex = Math.max(0, Math.min(this.grantIndex, grants.length - 1));
		if (grants.length === 0) {
			const none = t("None. They appear when you answer “15 minutes” or “this session” to a question.");
			for (const l of wrapTextWithAnsi(muted(none), inner - 2)) push(` ${l}`);
		}
		const revokeLabel = ` ${t("Revoke")} `;
		const revokeWidth = visibleWidth(revokeLabel) + 2;
		// fork: the scope and time columns fit their text ("cette sessi…" was cut), and a window
		// too narrow for one line puts them on a second: at 40 columns "Revoke" was outside the window.
		const scopeWidth = Math.max(13, ...grants.map((grant) => visibleWidth(grant.scope) + 1));
		// No time column when nothing has a time left (grants for the session).
		const widestLeft = Math.max(0, ...grants.map((grant) => visibleWidth(grant.left)));
		const leftWidth = widestLeft === 0 ? 0 : Math.max(13, widestLeft + 1);
		const oneLine = inner - 4 - scopeWidth - leftWidth - revokeWidth - 2 >= 8;
		const whatWidth = oneLine ? inner - 4 - scopeWidth - leftWidth - revokeWidth - 2 : inner - 4 - revokeWidth;
		// Border, bar, sign and a space, the rule, a space, the scope and the time left, then the button.
		const revokeAt = 1 + 3 + whatWidth + (oneLine ? 1 + scopeWidth + leftWidth : 0);
		geometry.revoke = [revokeAt, revokeAt + revokeWidth];
		grants.forEach((grant, i) => {
			const focused = this.focus === "grants" && i === this.grantIndex;
			const sign = grant.effect === "allow" ? "+" : "−";
			const button = focused
				? onBg(theme.bold(theme.fg("text", revokeLabel)), band, visibleWidth(revokeLabel))
				: theme.fg("thinkingText", revokeLabel);
			const bar = focused ? theme.fg("accent", "▌") : " ";
			const what = `${bar}${muted(sign)} ${padTo(theme.fg("text", grant.what), whatWidth)}`;
			const scope = theme.fg("thinkingText", grant.scope);
			const revoke = `${muted("[")}${button}${muted("]")}`;
			if (oneLine) {
				const left = leftWidth ? `${padTo(muted(grant.left), leftWidth - 1)} ` : "";
				push(`${what} ${padTo(scope, scopeWidth - 1)} ${left}${revoke}`, {
					kind: "grant",
					grant: { index: i, revoke: true },
				});
			} else {
				push(`${what}${revoke}`, { kind: "grant", grant: { index: i, revoke: true } });
				// A short terminal drops it with the summary.
				push(`${bar}  ${scope}${grant.left ? muted(` · ${grant.left}`) : ""}`, {
					kind: "grant",
					grant: { index: i, revoke: false },
					drop: 1,
				});
			}
		});
		blank();

		// The buttons, on as many lines as the width needs, then a reminder that these rules are not a sandbox.
		const rows: Array<{ text: string; buttons: NonNullable<BodyLine["buttons"]> }> = [];
		let row = { text: " ", buttons: [] as NonNullable<BodyLine["buttons"]> };
		BUTTONS.forEach((action, index) => {
			const label = ` ${this.buttonLabel(action)} `;
			const size = visibleWidth(label) + 2;
			if (row.buttons.length > 0 && visibleWidth(row.text) + 1 + size > inner) {
				rows.push(row);
				row = { text: " ", buttons: [] };
			}
			if (row.buttons.length > 0) row.text += " ";
			// Columns inside the window: its left border, then the body.
			const from = 1 + visibleWidth(row.text);
			row.buttons.push({ from, to: from + size, index });
			const focused = this.focus === "buttons" && index === this.buttonIndex;
			const text = focused ? onBg(theme.bold(theme.fg("text", label)), band, visibleWidth(label)) : label;
			row.text += `${muted("[")}${text}${muted("]")}`;
		});
		rows.push(row);
		const note = muted(t("These are not walls: see Help"));
		const last = rows[rows.length - 1]!;
		const gap = inner - visibleWidth(last.text) - visibleWidth(note) - 1;
		if (gap >= 2) last.text += `${" ".repeat(gap)}${note}`;
		else rows.push({ text: ` ${note}`, buttons: [] });
		for (const { text, buttons } of rows) push(text, { kind: "buttons", buttons });

		// Fit the terminal: drop the lines a short one can do without, spacers first, from the bottom up.
		// The key hints close the window under the second rule: one line, or all of them wrapped when the
		// body leaves room.
		const room = Math.max(6, this.options.height() - 2) - 6;
		// fork: the wrapped hints come before the lines that can go, "Esc close" was cut at 40 columns.
		const wrapped = wrapTextWithAnsi(this.hints(), inner - 2);
		while (body.length + wrapped.length - 1 > room) {
			const highest = Math.max(0, ...body.map((line) => line.drop ?? 0));
			if (highest === 0) break;
			const at = body.findLastIndex((line) => line.drop === highest);
			body.splice(at, 1);
		}
		const hints = wrapped.length - 1 <= room - body.length ? wrapped : [this.hints()];
		this.scrollGrants(body, room, grantsHeader, grants.length, inner);
		// The body starts on the window's fourth row (border, title, rule).
		body.forEach((line, i) => {
			const y = i + 3;
			if (line.kind === "table") geometry.tableRows.push(y);
			else if (line.grant) geometry.grantRows.push({ y, grant: line.grant.index, revoke: line.grant.revoke });
			for (const { from, to, index } of line.buttons ?? []) geometry.buttons[index] = { y, from, to };
			for (const { from, to, index } of line.modes ?? []) geometry.tabs[index] = { y, from, to };
		});

		const out: string[] = [];
		out.push(border(`┌${"─".repeat(inner)}┐`));
		const title = theme.bold(theme.fg("text", t("Permissions")));
		const subtitle = muted(t("what the model may do without asking you"));
		const close = muted(" ✕ ");
		geometry.close = 1 + inner - 3;
		out.push(
			`${border("│")}${padTo(` ${title}  ${truncateToWidth(subtitle, Math.max(0, inner - visibleWidth(t("Permissions")) - 8), "…")}`, inner - 3)}${close}${border("│")}`,
		);
		out.push(border(`├${"─".repeat(inner)}┤`));
		for (const line of body) out.push(`${border("│")}${line.text}${border("│")}`);
		out.push(border(`├${"─".repeat(inner)}┤`));
		for (const hint of hints) out.push(`${border("│")}${padTo(theme.fg("dim", ` ${hint}`), inner)}${border("│")}`);
		out.push(border(`└${"─".repeat(inner)}┘`));
		this.geometry = geometry;
		return out.map((l) => onBg(l, tok(theme, "userMessageBg"), width));
	}

	/**
	 * when the window is still too tall once the optional lines are gone, only the
	 * permissions around the selected one stay, so the buttons below them stay in view; the header says which.
	 */
	private scrollGrants(body: BodyLine[], room: number, header: BodyLine, count: number, inner: number): void {
		const excess = body.length - room;
		const lines = body.filter((line) => line.grant !== undefined);
		if (excess <= 0 || lines.length === 0) return;
		const budget = Math.max(1, lines.length - excess);
		const size = (index: number) => lines.filter((line) => line.grant!.index === index).length;
		let from = Math.max(0, Math.min(this.grantScroll, count - 1));
		if (this.grantIndex < from) from = this.grantIndex;
		const extend = (start: number) => {
			let end = start;
			let used = 0;
			while (end < count && used + size(end) <= budget) used += size(end++);
			return Math.max(end, start + 1);
		};
		let to = extend(from);
		if (this.grantIndex >= to) {
			// Bring the selected permission in at the bottom, with as many before it as fit.
			to = this.grantIndex + 1;
			from = this.grantIndex;
			let used = size(from);
			while (from > 0 && used + size(from - 1) <= budget) used += size(--from);
		}
		this.grantScroll = from;
		for (let i = body.length - 1; i >= 0; i--) {
			const grant = body[i]!.grant;
			if (grant && (grant.index < from || grant.index >= to)) body.splice(i, 1);
		}
		const range = fill("{0}–{1} of {2}", String(from + 1), String(to), String(count));
		header.text = padTo(theme.fg("muted", ` ${t("Current permissions")} (${range})`), inner);
	}

	private hints(): string {
		if (this.focus === "grants") return t("↑↓ move · Enter or click: revoke · Esc close");
		if (this.focus === "buttons") return t("←→ move · Enter open · ↑ back · Esc close");
		return t("←→ or click: change mode · ↓ permissions · alt+m from the editor · Esc or click outside: close");
	}

	private moveDown(): void {
		const grants = this.options.grants().length;
		if (this.focus === "modes") this.focus = grants > 0 ? "grants" : "buttons";
		else if (this.focus === "grants") {
			if (this.grantIndex < grants - 1) this.grantIndex++;
			else this.focus = "buttons";
		}
	}

	private moveUp(): void {
		const grants = this.options.grants().length;
		if (this.focus === "buttons") {
			if (grants > 0) {
				this.focus = "grants";
				this.grantIndex = grants - 1;
			} else this.focus = "modes";
		} else if (this.focus === "grants") {
			if (this.grantIndex > 0) this.grantIndex--;
			else this.focus = "modes";
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.down") || kb.matches(data, "tui.input.tab")) this.moveDown();
		else if (kb.matches(data, "tui.select.up")) this.moveUp();
		else if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.editor.cursorRight")) {
			const step = kb.matches(data, "tui.editor.cursorLeft") ? -1 : 1;
			if (this.focus === "buttons") {
				this.buttonIndex = (this.buttonIndex + step + BUTTONS.length) % BUTTONS.length;
			} else {
				const next = this.modeIndex + step;
				if (next >= 0 && next < VIEW_MODES.length) this.options.onMode(VIEW_MODES[next]!);
			}
		} else if (kb.matches(data, "tui.select.confirm") || data === " ") {
			if (this.focus === "grants") this.options.onRevoke(this.grantIndex, this.shownGrants[this.grantIndex]);
			else if (this.focus === "buttons") this.options.onAction(BUTTONS[this.buttonIndex]!);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const g = this.geometry;
		if (!g) return undefined;
		if (event.type === "wheel") return { handled: true };
		if (event.button !== "left") return { handled: true };
		if (event.type !== "click") return { handled: true, focus: true };
		const { x, y } = event;
		if (y === 1 && x >= g.close && x < g.close + 3) {
			this.options.onClose();
			return { handled: true };
		}
		const column = g.tableRows.includes(y)
			? g.columns.findIndex(([from, to]) => x >= from && x < to)
			: g.tabs.findIndex((tab) => tab !== undefined && tab.y === y && x >= tab.from && x < tab.to);
		if (column !== -1) {
			this.focus = "modes";
			this.options.onMode(VIEW_MODES[column]!);
			return { handled: true, focus: true, render: true };
		}
		const row = g.grantRows.find((r) => r.y === y);
		if (row) {
			this.focus = "grants";
			this.grantIndex = row.grant;
			if (row.revoke && x >= g.revoke[0] && x < g.revoke[1])
				this.options.onRevoke(row.grant, this.shownGrants[row.grant]);
			return { handled: true, focus: true, render: true };
		}
		const button = g.buttons.findIndex((b) => b !== undefined && b.y === y && x >= b.from && x < b.to);
		if (button !== -1) {
			this.focus = "buttons";
			this.buttonIndex = button;
			this.options.onAction(BUTTONS[button]!);
		}
		return { handled: true, focus: true, render: true };
	}
}

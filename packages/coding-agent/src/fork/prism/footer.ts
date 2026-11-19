// Statusline. Carries everything the built-in footer shows (cwd, branch,
// session name, token totals, cache hit rate, cost, subscription flag, context
// usage with auto-compact marker, routed model, experimental flag, extension
// statuses) plus Codex quotas published by pi-codex-usage.
// Model and thinking level live in the composer's badge row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import {
	sanitizeTerminalLabel,
	sanitizeTerminalText,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { Theme, ThemeToken } from "../../modes/interactive/theme/theme.ts";
import { getCompactionThresholdTokens } from "../compaction-threshold.ts";
import { t } from "../i18n/index.ts";
import { homeRelative } from "../path-within.ts";
import { INIT_STATUS } from "../project-continuity.ts";
import type { ContextInfo } from "./footer-actions.ts";
import { BG_OFF, bgRGB, FG_OFF, fgRGB, isLightTheme, mix, pill, step, tok } from "./lib/palette.ts";
import type { PrismState } from "./lib/state.ts";

interface CodexBridge {
	onChange?: () => void;
	usage?: { fiveHourPercent: number; weeklyPercent: number };
	severity?: (period: "5h" | "wk") => number;
}

const CODEX_BRIDGE = Symbol.for("pi-codex-usage.bridge");
const GAUGE = 12;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** compaction.enabled from Prism's global then project settings (default: on). */
export function autoCompactEnabled(cwd: string, projectTrusted = true): boolean {
	let enabled = true;
	const files = [join(getAgentDir(), "settings.json")];
	if (projectTrusted) files.push(join(cwd, CONFIG_DIR_NAME, "settings.json"));
	for (const file of files) {
		try {
			const v = JSON.parse(readFileSync(file, "utf8"))?.compaction?.enabled;
			if (typeof v === "boolean") enabled = v;
		} catch {}
	}
	return enabled;
}

/**
 * fork: how auto-compaction runs with these settings, read as
 * the engine reads them (shouldCompact): whether it is on, and where it starts, in tokens and in percent of the
 * window. Undefined when the settings cannot be read; no threshold when it is off or the window is unknown.
 */
export function compactionState(
	settings: SettingsManager,
	model: Parameters<SettingsManager["getCompactionSettings"]>[0],
	contextWindow: number,
): { auto: boolean; threshold?: number; mark?: number } | undefined {
	try {
		const c = settings.getCompactionSettings(model);
		if (!c.enabled || !contextWindow) return { auto: c.enabled };
		const threshold = getCompactionThresholdTokens(
			contextWindow,
			c.reserveTokens,
			c.thresholdPercent,
			c.thresholdMaxTokens,
		);
		return { auto: true, threshold, mark: (threshold / contextWindow) * 100 };
	} catch {
		return undefined;
	}
}

export interface Stats {
	key: string;
	count: number;
	lastEntry?: unknown;
	latest?: { model: string; thinkingLevel?: string };
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	hitRate?: number;
	routed?: { id: string; level?: string };
}

function add(s: Stats, u: (Partial<Omit<Usage, "cost">> & { cost?: { total?: number } }) | undefined) {
	if (!u) return;
	s.input += u.input ?? 0;
	s.output += u.output ?? 0;
	s.cacheRead += u.cacheRead ?? 0;
	s.cacheWrite += u.cacheWrite ?? 0;
	s.cost += u.cost?.total ?? 0;
}

export function computeSessionStats(
	previous: Stats | undefined,
	ctx: {
		model?: { provider: string; id: string; api?: string };
		sessionManager: { getSessionId(): string; getEntries(): readonly unknown[] };
	},
): Stats {
	const sm = ctx.sessionManager;
	const entries = sm.getEntries() as readonly SessionEntry[];
	// getEntries() holds every branch and does not depend on the leaf, which moves with each new entry.
	const key = `${sm.getSessionId()}:${ctx.model?.provider}/${ctx.model?.id}`;
	let s: Stats;
	if (
		previous?.key === key &&
		entries.length >= previous.count &&
		(previous.count === 0 || entries[previous.count - 1] === previous.lastEntry)
	) {
		s = previous;
	} else {
		s = { key, count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	}
	let latest = s.latest;
	for (let index = s.count; index < entries.length; index += 1) {
		const e = entries[index]!;
		if (e.type === "usage") add(s, e.usage);
		else if (e.type === "message" && e.message.role === "assistant") {
			const u = e.message.usage;
			add(s, u);
			const prompt = u.input + u.cacheRead + u.cacheWrite;
			s.hitRate = prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
			if (e.message.stopReason !== "error" && e.message.stopReason !== "aborted") latest = e.message;
		} else if (e.type === "message" && e.message.role === "toolResult" && e.message.usage) add(s, e.message.usage);
		else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) add(s, e.usage);
	}
	if (ctx.model?.api === "pi-virtual" && latest) s.routed = { id: latest.model, level: latest.thinkingLevel };
	else delete s.routed;
	s.count = entries.length;
	s.lastEntry = entries.at(-1);
	s.latest = latest;
	return s;
}

export function createFooterFactory(state: PrismState) {
	return (
		tui: Pick<TUI, "requestRender">,
		_theme: Theme,
		footerData: {
			getGitBranch: PrismState["branch"];
			getExtensionStatuses: PrismState["statuses"];
			onBranchChange: ReadonlyFooterDataProvider["onBranchChange"];
		},
	) => {
		state.branch = () => footerData.getGitBranch();
		state.statuses = () => footerData.getExtensionStatuses();
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		const bridge = (globalThis as Record<symbol, CodexBridge | undefined>)[CODEX_BRIDGE];
		if (bridge) bridge.onChange = () => tui.requestRender();
		let stats: Stats | undefined;
		// Prism's settings for the threshold mark, read again at most every 2 s so /settings changes show.
		let settings: { cwd: string; at: number; manager: SettingsManager } | undefined;
		// fork: where the permission chip was drawn, so a click on it opens /perm.
		let permHit: { row: number; from: number; to: number } | undefined;
		let sandboxHit: { row: number; from: number; to: number } | undefined;
		// fork: where the "more…" button was drawn.
		let moreHit: { row: number; from: number; to: number } | undefined;
		// fork: where project continuity's "init" button was drawn.
		let initHit: { row: number; from: number; to: number } | undefined;
		// fork: the pinned commands, the settings gear and the context gauge.
		let actionHits: Array<{ hit: { row: number; from: number; to: number }; command: string }> = [];
		let contextHit: { row: number; from: number; to: number } | undefined;
		let contextInfo: ContextInfo | undefined;

		const computeStats = (ctx: ExtensionContext): Stats => {
			stats = computeSessionStats(stats, ctx);
			return stats;
		};

		return {
			invalidate() {},
			dispose() {
				unsubscribe?.();
				if (bridge?.onChange) bridge.onChange = undefined;
				state.branch = () => undefined;
				state.statuses = () => new Map();
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type !== "click" || event.button !== "left") return undefined;
				const on = (hit: typeof permHit) =>
					hit !== undefined && event.y === hit.row && event.x >= hit.from && event.x < hit.to;
				const action = actionHits.find((entry) => on(entry.hit));
				// fork: the mode's chip opens the modes and permissions in effect; the sandbox's, its settings.
				if (on(permHit)) state.openCommand?.("perm window");
				else if (on(sandboxHit)) state.openCommand?.("sandbox");
				else if (on(moreHit)) state.openMenu?.();
				else if (on(initHit)) state.openCommand?.("init");
				else if (action) state.runAction?.(action.command);
				else if (on(contextHit) && contextInfo) state.openContext?.(contextInfo);
				else return undefined;
				return { handled: true };
			},
			render(width: number): string[] {
				const theme = state.theme;
				const ctx = state.ctx;
				if (!theme || !ctx) return [];
				const dim = (s: string) => theme.fg("dim", s);
				// fork: folder, branch, session name and routed model come from outside.
				const muted = (s: string) => theme.fg("muted", sanitizeTerminalLabel(s));
				let s: Stats;
				try {
					s = computeStats(ctx);
				} catch {
					return [];
				}

				// ── left: location ───────────────────────────────────────
				const home = process.env.HOME || process.env.USERPROFILE || "";
				// Cleaned before fitLine may shorten it: cut first, the tail of a sequence would stay on screen.
				const cwd = homeRelative(sanitizeTerminalLabel(ctx.sessionManager.getCwd?.() ?? ctx.cwd), home);
				const branch = footerData.getGitBranch();
				const session = ctx.sessionManager.getSessionName?.();
				// one line in ink 3, icons included.
				const folder = dim("\uf07b");
				const loc = [`${folder} ${muted(cwd)}`];
				if (branch) loc.push(`${dim("\ue0a0")} ${muted(branch)}`);
				if (session) loc.push(`${dim("\uf02b")} ${muted(session)}`);

				// ── right: tokens, cost, context ─────────────────────────
				const advanced = state.interfaceMode() === "advanced";
				// fork: words in the simple interface; the advanced arrows and letters are explained in /help.
				const figure = (arrow: string, word: string, count: number) => {
					const n = formatTokens(count);
					if (advanced) return `${dim(arrow)}${muted(n)}`;
					const text = t(`${word} ${n}`);
					const at = text.lastIndexOf(n);
					return `${dim(text.slice(0, at))}${muted(n)}${dim(text.slice(at + n.length))}`;
				};
				const tokens: string[] = [];
				if (s.input) tokens.push(figure("↑", "sent", s.input));
				if (s.output) tokens.push(figure("↓", "received", s.output));
				const cache: string[] = [];
				const cached = (s.cacheRead > 0 || s.cacheWrite > 0) && s.hitRate !== undefined;
				if (advanced) {
					if (s.cacheRead) cache.push(`${dim("R")}${muted(formatTokens(s.cacheRead))}`);
					if (s.cacheWrite) cache.push(`${dim("W")}${muted(formatTokens(s.cacheWrite))}`);
					if (cached) cache.push(`${dim("CH")}${muted(`${s.hitRate!.toFixed(1)}%`)}`);
				} else if (cached) {
					// fork: one figure in plain words; the read/write detail stays in /session.
					cache.push(`${dim(t("cache"))} ${muted(`${Math.round(s.hitRate!)}%`)}`);
				}
				let sub = false;
				try {
					sub = !!ctx.model && (ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model));
				} catch {}
				const cost =
					s.cost || sub ? theme.fg("text", `$${s.cost.toFixed(3)}`) + (sub ? dim(` ${t("sub")}`) : "") : "";

				const usage = ctx.getContextUsage?.();
				const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const pct: number | null = usage?.percent ?? null;
				const now = Date.now();
				if (!settings || settings.cwd !== ctx.cwd || now - settings.at > 2000) {
					try {
						settings = {
							cwd: ctx.cwd,
							at: now,
							manager: SettingsManager.create(ctx.cwd, getAgentDir(), {
								projectTrusted: ctx.isProjectTrusted(),
							}),
						};
					} catch {
						settings = undefined;
					}
				}
				// fork: "auto" follows the settings read again below, as the mark does; it
				// was read once per folder.
				const compaction = settings ? compactionState(settings.manager, ctx.model, window) : undefined;
				const auto = compaction?.auto ?? autoCompactEnabled(ctx.cwd, ctx.isProjectTrusted());
				const mark = compaction?.mark;
				const level = gaugeLevel(pct ?? 0, mark);
				const pctText = pct === null ? "?" : `${pct.toFixed(1)}%`;
				const ctxPart =
					`${gauge(theme, pct ?? 0, mark)} ${theme.fg(level ?? "text", pctText)}${dim(`/${formatTokens(window)}`)}` +
					(auto ? dim(" auto") : "");

				// The session's placeholder when no model is configured is not a model (as in the header).
				const noModel = !ctx.model || (ctx.model.provider === "unknown" && ctx.model.id === "unknown");
				contextInfo = { percent: pct, window, noModel, auto, mark, threshold: compaction?.threshold };
				state.contextSeen?.(contextInfo);
				// fork: extension statuses as chips, on the first line when they fit beside the stats.
				const chips: string[] = [];
				const statuses = footerData.getExtensionStatuses() as Map<string, string>;
				for (const [key, text] of [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
					// fork: the controls other than colours, which statuses carry.
					const clean = sanitizeTerminalText(text)
						.replace(/[\r\n\t]/g, " ")
						.replace(/ +/g, " ")
						.trim();
					if (clean) chips.push(chip(theme, key, clean));
				}
				// fork: the "more…" button, after the statuses, opens a menu of the common commands. QA of fork.8
				// before it, the pinned commands and the settings gear; the buttons are kept whole after the
				// statuses, and pinned commands that do not fit stay in the menu.
				const more = state.openMenu ? t("more…") : undefined;
				const pinned = state.runAction ? (state.footerActions?.() ?? []) : [];
				const buttons = (count: number) => [
					...pinned.slice(0, count).map((command) => chip(theme, "action", `/${command}`)),
					...(state.runAction ? [chip(theme, "settings", GEAR)] : []),
					...(more ? [chip(theme, "more", more)] : []),
				];
				const chipsPart = [...chips, ...buttons(pinned.length)].join(sep2(theme));

				const sep = dim("  ");
				const build = (parts: string[]) => parts.filter(Boolean).join(sep);
				// Words need the wider gap to read as separate figures.
				const tokensPart = tokens.join(advanced ? " " : "  ");
				const candidates = [
					[tokensPart, cache.join(" "), cost, ctxPart],
					[tokensPart, cost, ctxPart],
					[tokensPart, ctxPart],
					[ctxPart],
				];
				// Chips never push stats off the first line: they join it only next to the full stats.
				const withChips = chipsPart ? [[chipsPart, ...candidates[0]]] : [];
				const fitted = fitLine(
					width,
					loc,
					[...withChips, ...candidates].map(build),
					cwd,
					(c) => `${folder} ${muted(c)}`,
				);
				const line1 = fitted.line;
				// Chips that did not fit on the first line go to the second.
				if (fitted.index < withChips.length) chips.length = 0;
				const plainContext = stripVTControlCharacters(ctxPart);

				// ── second line: extension statuses, quotas, routing ─────
				const extras: string[] = [];
				const quota = bridge?.usage;
				if (quota) {
					if (quota.fiveHourPercent >= 0)
						extras.push(quotaPart(theme, "5h", quota.fiveHourPercent, bridge.severity?.("5h") ?? 0));
					if (quota.weeklyPercent >= 0)
						extras.push(quotaPart(theme, "wk", quota.weeklyPercent, bridge.severity?.("wk") ?? 0));
				}
				if (s.routed)
					extras.push(`${dim("→")} ${muted(s.routed.id)}${s.routed.level ? dim(` ${s.routed.level}`) : ""}`);
				if (process.env.PI_EXPERIMENTAL === "1") extras.push(theme.bold(theme.fg("warning", "xp")));

				const lines = [line1];
				const onLine1 = fitted.index < withChips.length;
				const shown = onLine1 ? [] : buttons(pinned.length);
				if (shown.length || extras.length) {
					const right = extras.join(sep);
					lines.push(
						shown.length
							? buttonsLine(
									width,
									chips.join(sep2(theme)),
									(count) => buttons(count).join(sep2(theme)),
									pinned.length,
									right,
								)
							: join2(width, "", right),
					);
				}
				permHit = findPermChip(lines, statuses.get("permissions"));
				sandboxHit = findSandboxChip(lines, permHit, statuses.get("permissions"));
				moreHit = more ? findText(lines, `• ${more}`) : undefined;
				const init = statuses.get(INIT_STATUS);
				initHit = init ? findText(lines, `• ${init}`) : undefined;
				actionHits = [];
				for (const command of ["settings", ...pinned]) {
					const hit = findText(lines, command === "settings" ? `• ${GEAR}` : `• /${command}`);
					if (hit) actionHits.push({ hit, command });
				}
				contextHit = findText(lines, plainContext);
				return lines;
			},
		};
	};
}

const sep2 = (theme: Theme) => theme.fg("dim", "  ");

/** The settings button: a gear (Nerd Font, like the footer's other icons). */
const GEAR = "\uf013";

/**
 * fork: the second line when it carries the buttons. The buttons stay whole at the end
 * of the statuses, which are cut first; pinned commands go next (they stay in "more…"), then the right part.
 */
function buttonsLine(
	width: number,
	statuses: string,
	buttons: (count: number) => string,
	pinned: number,
	right: string,
): string {
	for (const extras of right ? [right, ""] : [""]) {
		const line = (left: string) => (extras ? join2(width, left, extras) : truncateToWidth(left, width, "…"));
		for (let count = pinned; count >= 0; count--) {
			const shown = buttons(count);
			// A leading space; then a gap and a trailing space around the right part, or one free column.
			const room = width - 1 - visibleWidth(shown) - (statuses ? 2 : 0) - (extras ? visibleWidth(extras) + 3 : 1);
			const statusWidth = visibleWidth(statuses);
			if (statuses && room < Math.min(statusWidth, MIN_STATUS) && (count > 0 || extras)) continue;
			if (!statuses || room < 2) return line(` ${shown}`);
			const cut = statusWidth <= room ? statuses : truncateToWidth(statuses, room, "…");
			return line(` ${cut}  ${shown}`);
		}
	}
	return truncateToWidth(` ${buttons(0)}`, width, "…");
}

/** The fewest columns of statuses kept before pinned commands give way (the permission chip, about). */
const MIN_STATUS = 12;

/**
 * A status chip: a coloured dot and the status text. The permission mode gets the
 * colour of its risk
 * , drops its prefix and sits in a pill.
 */
export function chip(theme: Theme, key: string, text: string): string {
	const perm = key === "permissions" ? /^perm: (\w+)(.*)$/.exec(text) : null;
	if (perm) {
		const colors: Record<string, ThemeToken> = {
			safe: "success",
			ask: "accent",
			broad: "warning",
			unrestricted: "error",
		};
		const color = tok(theme, colors[perm[1]!] ?? "warning");
		// The light theme's mode colours are mid-tones: three steps darker keep the label above 4.5:1 (measured).
		const text = isLightTheme(theme) ? step(color, -3) : color;
		// fork: the mode's name in the interface language.
		const suffix = perm[2]
			.replace(" (read-only)", t(" (read-only)"))
			.replace("sandbox not working", t("sandbox not working"));
		return `${pill(t(perm[1]!), mix(tok(theme, "userMessageBg"), color, 0.22), text)}${theme.fg("dim", suffix)}`;
	}
	return `${theme.fg("dim", "•")} ${theme.fg("muted", text)}`;
}

/** Columns of the permission chip in the rendered statusline, if it is shown. */
export function findPermChip(
	lines: string[],
	status: string | undefined,
): { row: number; from: number; to: number } | undefined {
	const id = status ? /^perm: (\w+)/.exec(status)?.[1] : undefined;
	if (!id) return undefined;
	const mode = t(id);
	for (const [row, line] of lines.entries()) {
		const plain = stripVTControlCharacters(line);
		const at = plain.indexOf(`▐${mode}▌`);
		if (at < 0) continue;
		const from = visibleWidth(plain.slice(0, at));
		return { row, from, to: from + 2 + visibleWidth(mode) };
	}
	return undefined;
}

/** Columns of the word "sandbox" after the permission chip, if the status says it. */
export function findSandboxChip(
	lines: string[],
	chip: { row: number; from: number; to: number } | undefined,
	status: string | undefined,
): { row: number; from: number; to: number } | undefined {
	const word = status?.includes("sandbox not working")
		? t("sandbox not working")
		: status?.endsWith(" · sandbox")
			? "sandbox"
			: undefined;
	if (!chip || !word) return undefined;
	const plain = stripVTControlCharacters(lines[chip.row] ?? "");
	const at = plain.indexOf(word, chip.to);
	if (at < 0) return undefined;
	const from = visibleWidth(plain.slice(0, at));
	return { row: chip.row, from, to: from + visibleWidth(word) };
}

/** Columns of a text in the rendered statusline, if it is shown. */
export function findText(lines: string[], text: string): { row: number; from: number; to: number } | undefined {
	for (const [row, line] of lines.entries()) {
		const plain = stripVTControlCharacters(line);
		const at = plain.indexOf(text);
		if (at < 0) continue;
		const from = visibleWidth(plain.slice(0, at));
		return { row, from, to: from + visibleWidth(text) };
	}
	return undefined;
}

/**
 * Warning once usage is within 10 points of where auto-compaction starts, error past it. Without a mark
 * (auto-compaction off), the edge of the context window is the limit.
 */
export function gaugeLevel(pct: number, mark: number | undefined): "warning" | "error" | undefined {
	const limit = mark ?? 100;
	if (pct >= limit) return "error";
	if (pct >= limit - 10 || pct > 90) return "warning";
	return undefined;
}

/**
 * fork: context gauge in half blocks, a pixel row under the text line: filled in ink 2, then in
 * the warning and error colours near the auto-compaction threshold. The threshold is a one-pixel tick above
 * the row (▀ over a background of the cell's own colour).
 */
export function gauge(theme: Theme, pct: number, mark?: number): string {
	const filled = Math.max(0, Math.min(GAUGE, Math.round((pct / 100) * GAUGE)));
	const level = gaugeLevel(pct, mark);
	const fill = tok(theme, level ?? "thinkingText");
	const track = tok(theme, "borderMuted");
	const at = mark === undefined ? -1 : Math.max(0, Math.min(GAUGE - 1, Math.round((mark / 100) * GAUGE) - 1));
	let out = "";
	for (let i = 0; i < GAUGE; i++) {
		const cell = i < filled ? fill : track;
		out += i === at ? `${bgRGB(cell)}${fgRGB(tok(theme, "muted"))}▀${BG_OFF}` : `${fgRGB(cell)}▄`;
	}
	return out + FG_OFF;
}

function quotaPart(theme: Theme, label: string, pct: number, severity: number): string {
	const color = severity === 2 ? "error" : severity === 1 ? "warning" : "muted";
	const cells = 5;
	const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
	const bar =
		theme.fg(severity ? color : "accent", "▰".repeat(filled)) + theme.fg("borderMuted", "▱".repeat(cells - filled));
	return `${theme.fg("dim", label)} ${bar} ${theme.fg(color, `${pct}%`)}`;
}

function join2(width: number, left: string, right: string): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + rw + 3 <= width) return `${left}${" ".repeat(width - lw - rw - 1)}${right} `;
	if (!left) return truncateToWidth(right, width, "…");
	return truncateToWidth(`${left}  ${right}`, width, "…");
}

/**
 * Location on the left, stats on the right. Stats win: the location sheds
 * session name, then branch, then the cwd is shortened from the left.
 */
function fitLine(
	width: number,
	loc: string[],
	rights: string[],
	cwdPlain: string,
	cwdStyle: (s: string) => string,
): { line: string; index: number } {
	for (const [index, right] of rights.entries()) {
		for (let keep = loc.length; keep >= 1; keep--) {
			const left = ` ${loc.slice(0, keep).join("  ")}`;
			if (visibleWidth(left) + visibleWidth(right) + 3 <= width) return { line: join2(width, left, right), index };
		}
		const room = width - visibleWidth(right) - 3 - 3;
		if (room >= 16) {
			const short = `…${cwdPlain.slice(cwdPlain.length - room + 1)}`;
			return { line: join2(width, ` ${cwdStyle(short)}`, right), index };
		}
	}
	return { line: join2(width, "", rights[rights.length - 1]), index: rights.length - 1 };
}

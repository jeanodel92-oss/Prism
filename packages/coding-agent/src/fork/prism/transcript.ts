// Transcript styling, applied at render time on pi's own components so their
// structure (and tui-perf's streaming patches) stay untouched:
//   • user messages   → a pixel tile
//   • assistant text  → ─ gutter mark; thinking → labelled ▏ rail
//   • tool calls      → family icon in a pale tint, ● state mark, duration on the
//                       header line, output on a ▏ rail
//   • markdown        → code panels with a language label, tinted headings, neutral rules,
//                       tables in hairlines
//   • selector borders→ neutral rules
// the site's art direction. Inks and hairlines; colour stays where it
// signals something (states, tool families, errors), in pale tints.
// Nothing here animates on a timer: rows scrolled above the viewport would
// force full-screen redraws in pi's main-screen renderer. The live "Thinking…"
// label shimmers only when a streamed update redraws it anyway.
// fork: drawn through the typed render hooks of fork/render-hooks.ts and the markdown
// token hook of pi-tui, instead of the reference pack's prototype patches.

import {
	type MarkdownTheme,
	type MarkdownTokenHook,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Tokens } from "marked";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { indicator, pulseLabel } from "../animation-frames.ts";
import type { AnimationStyle } from "../animations.ts";
import { t } from "../i18n/index.ts";
import { own } from "../own.ts";
import type { AssistantBlock, RenderHooks } from "../render-hooks.ts";
import { shellOutcome } from "../shell-outcome.ts";
import { RULE } from "./dialogs.ts";
import { mix, onBg, paint, type RGB, shimmer, surface2, tint, tok } from "./lib/palette.ts";
import type { PrismState } from "./lib/state.ts";
import { tileEdge } from "./lib/tile.ts";
import { plainAction } from "./plain-action.ts";

/** OSC 133 prompt marks at the start of a line: kept in front of whatever replaces the line. */
const OSC_PREFIX = /^(?:\x1b\][^\x07]*\x07)*/;

const TOOL_ICONS: Record<string, string> = {
	read: "",
	bash: "",
	edit: "",
	write: "",
	grep: "",
	find: "",
	ls: "",
};
const DEFAULT_TOOL_ICON = "";
const SHELL_TOOLS = new Set(["bash", "powershell"]);

const LANG_ICONS: Record<string, string> = {
	ts: "",
	tsx: "",
	typescript: "",
	js: "",
	jsx: "",
	javascript: "",
	py: "",
	python: "",
	rs: "",
	rust: "",
	go: "",
	sh: "",
	bash: "",
	zsh: "",
	shell: "",
	console: "",
	json: "",
	md: "",
	markdown: "",
	html: "",
	css: "",
	c: "",
	cpp: "",
	java: "",
	lua: "",
	diff: "",
};
const DEFAULT_LANG_ICON = "";

const isBlank = (line: string) => line.replace(/\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07/g, "").trim() === "";
const strip = (line: string) => line.replace(/\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g, "");

function toolIcon(name: string): string {
	// fork: own entries only, never what every object inherits.
	const known = own(TOOL_ICONS, name);
	if (known) return known;
	if (/web|fetch|search|browse|http|url/i.test(name)) return "";
	if (/mcp|__/.test(name)) return "";
	return DEFAULT_TOOL_ICON;
}

/**
 * fork: one colour per tool family (read, modify, shell, search, web), as pale tints: the maintainer
 * kept the family colours, sober and readable.
 */
function toolFamilyColor(theme: Theme, name: string): RGB {
	if (name === "read" || name === "ls") return tint(theme, 250);
	if (name === "edit" || name === "write") return tint(theme, 305);
	if (name === "bash" || name === "powershell") return tint(theme, 165);
	if (name === "grep" || name === "find") return tint(theme, 210);
	if (/web|fetch|search|browse|http|url/i.test(name)) return tint(theme, 355);
	return tok(theme, "muted");
}

/**
 * fork: the tool's state as one ● at several intensities (the maintainer's font has no ○ or ◐): the strong
 * line before any output, breathing between ink 3 and ink while it streams (fixed when animations are off),
 * the success tint once done, the error tint and the word "failed" after an error.
 */
export function stateMark(
	theme: Theme,
	view: { isPartial: boolean; isError: boolean },
	started: boolean,
	animate: boolean,
	style: AnimationStyle = "default",
	now = Date.now(),
): string {
	if (view.isError && !view.isPartial) return `${paint(tok(theme, "error"), "●")}`;
	if (!view.isPartial) return paint(tok(theme, "success"), "●");
	if (!started) return paint(tok(theme, "borderAccent"), "●");
	if (animate && style !== "default" && style !== "off") return theme.fg("accent", indicator(style, now));
	const breath = animate ? (1 - Math.cos((now / 1600) * 2 * Math.PI)) / 2 : 1;
	return paint(mix(tok(theme, "muted"), tok(theme, "text"), breath), "●");
}

/** The shell renderers' "Took 1.2s" / "Elapsed 3.0s" line, moved to the header line. */
const DURATION = /^(Took|Elapsed) (\d[\dhms. ]*)$/;

// The reference pack (fork/reference/pi-prism), when it is loaded too, keeps its prototype
// patches in this registry. Its user-message patch wraps the upstream render, which would call
// this hook and draw the bar twice. Its other patches replace the render outright.
const REFERENCE_PATCHES = Symbol.for("pi-prism.patches");
function referencePatched(id: string): boolean {
	const registry = (globalThis as Record<symbol, unknown>)[REFERENCE_PATCHES];
	return registry instanceof Map && registry.has(id);
}

export function transcriptHooks(
	state: PrismState,
): Pick<RenderHooks, "userMessage" | "assistantMessage" | "toolExecution" | "dynamicBorder"> {
	return {
		// ── user messages ──────────────────────────────────────────────────
		userMessage: (width, renderDefault) => {
			const theme = state.theme;
			if (!theme || width < 8 || referencePatched("user-message")) return undefined;
			// a full-width tile; its blank padding rows become the tile's half-row edges.
			const lines = renderDefault(width);
			const fill = tok(theme, "userMessageBg");
			const edge = (line: string | undefined, side: "top" | "bottom") =>
				line !== undefined && isBlank(line)
					? `${OSC_PREFIX.exec(line)![0]}${tileEdge(width, fill, side)}`
					: undefined;
			const top = edge(lines[0], "top");
			const bottom = lines.length > 1 ? edge(lines[lines.length - 1], "bottom") : undefined;
			if (!top || !bottom) return lines;
			return [top, ...lines.slice(1, -1), bottom];
		},

		// ── assistant messages ─────────────────────────────────────────────
		assistantMessage: (width, blocks, isStreaming) => {
			const theme = state.theme;
			if (!theme || width < 12) return undefined;
			const inner = width - 2;
			const lastContent = blocks.reduce((acc, b, i) => (b.kind === "spacer" ? acc : i), -1);
			const lines: string[] = [];
			const layout: Array<{ component: AssistantBlock["component"]; height: number }> = [];
			blocks.forEach(({ component, kind }, index) => {
				const rendered = component.render(inner);
				let decorated: string[];
				if (kind === "spacer") decorated = rendered;
				else if (kind === "thinking" || kind === "thinking-hidden") {
					const live = isStreaming && index === lastContent;
					decorated = thinking(theme, kind === "thinking-hidden", rendered, live, state);
				} else if (kind === "notice") decorated = rendered.map((l) => `  ${l}`);
				else decorated = markText(theme, rendered);
				layout.push({ component, height: decorated.length });
				lines.push(...decorated);
			});
			return { lines, layout };
		},

		// ── tool calls ─────────────────────────────────────────────────────
		toolExecution: (view, width) => {
			const theme = state.theme;
			if (!theme || width < 16) return undefined;
			// Dot, icon and two spaces take four columns.
			const inner = width - 4;
			let head: string[] = [];
			let body: string[] = [];
			try {
				if (view.shell === "self") {
					let lines = view.renderSelf(inner);
					// Self-framed renderers pad by one column; our gutter replaces it.
					if (lines.every((l) => isBlank(l) || strip(l).startsWith(" ")))
						lines = lines.map((l) => l.replace(/^((?:\x1b\[[0-9;:]*m)*) /, "$1"));
					const first = lines.findIndex((l) => !isBlank(l));
					if (first >= 0) {
						head = [lines[first]];
						body = lines.slice(first + 1);
					}
				} else if (view.shell === "renderer") {
					const lines = view.renderParts(inner);
					const first = lines.findIndex((l) => !isBlank(l));
					if (first >= 0) {
						head = [lines[first]];
						body = lines.slice(first + 1);
					}
				} else {
					const lines = view.renderText(width - 3).map((l) => l.replace(/^ /, ""));
					const content = lines.filter((_l, i) => i > 0 && i < lines.length - 1);
					head = content.slice(0, 1);
					body = content.slice(1);
				}
			} catch {
				return undefined;
			}
			while (body.length && isBlank(body[0])) body.shift();
			while (body.length && isBlank(body[body.length - 1])) body.pop();
			if (head.length === 0 && body.length === 0 && view.imageCount === 0) return [];

			let duration: string | undefined;
			const durationMatch = body.length ? DURATION.exec(strip(body[body.length - 1]).trim()) : null;
			if (durationMatch && head.length) {
				duration = durationMatch[2].trim();
				body.pop();
				while (body.length && isBlank(body[body.length - 1])) body.pop();
			}

			// fork: the simple interface says how a failed command ended on the header line.
			let failure = "failed";
			if (view.isError && !view.isPartial && SHELL_TOOLS.has(view.toolName) && state.interfaceMode() === "simple") {
				const outcome = shellOutcome(body, strip);
				if (outcome) {
					failure = outcome.label;
					body = outcome.body;
					while (body.length && isBlank(body[body.length - 1])) body.pop();
				}
			}

			const icon = paint(toolFamilyColor(theme, view.toolName), toolIcon(view.toolName));
			const dot = stateMark(theme, view, body.length > 0, state.animates("tools"), state.animationStyle("tools"));
			// fork: the simple interface shows one line per action, in plain words; ctrl+o or a click
			// shows the call and its output, successes and failures alike.
			const folded = state.interfaceMode() === "simple" && !view.expanded;
			if (folded) {
				const plain = plainAction(view.toolName, view.args);
				head = plain ? [paint(tok(theme, "text"), plain)] : head.slice(0, 1);
				body = [];
			}
			const out: string[] = [""];
			head.forEach((line, i) => {
				if (i > 0) {
					out.push(`  ${line}`);
					return;
				}
				let first = `${dot} ${icon} ${line}`;
				const failed = view.isError && !view.isPartial ? ` ${theme.fg("error", t(failure))}` : "";
				if (failed || duration) {
					// Renderers pad their lines to the full width; drop that padding first.
					first = first.replace(/(?:\s|\x1b\[[0-9;:]*m)+$/, (m) => m.replace(/\s+/g, ""));
					// fork: on a narrow line the call's text gives way, not its state or duration.
					const room = width - 1 - visibleWidth(failed) - (duration ? visibleWidth(duration) + 1 : 0);
					if (visibleWidth(first) > room) first = truncateToWidth(first, Math.max(1, room), "…");
					first += failed;
				} else if (visibleWidth(first) > width) {
					// the simple interface's one-line action, a long path or pattern,
					// is not wrapped by any renderer; it gives way here instead of overflowing the terminal.
					first = truncateToWidth(first, width, "…");
				}
				if (duration) {
					const tail = theme.fg("dim", duration);
					const room = width - visibleWidth(first) - visibleWidth(duration) - 1;
					first = room >= 1 ? `${first}${" ".repeat(room)}${tail}` : `${first} ${tail}`;
				}
				out.push(first);
			});
			// the output hangs on a hairline rail under the icon, like the site's quotes and lists; no panel.
			const rail = paint(tok(theme, "borderMuted"), "▏");
			for (const line of body) out.push(`  ${rail} ${line}`);
			if (!folded) out.push(...view.renderImages(width));
			return out;
		},

		// ── selector / dialog borders ──────────────────────────────────────
		dynamicBorder: (width) => {
			const theme = state.theme;
			if (!theme) return undefined;
			if (state.framing > 0) return [RULE]; // the dialog frame draws it
			return [paint(tok(theme, "borderMuted"), "─".repeat(Math.max(1, width)))]; // a neutral hairline
		},
	};
}

// ── markdown blocks ────────────────────────────────────────────────────
export function markdownTokenHook(state: PrismState): MarkdownTokenHook {
	return (token, width, nextTokenType, context) => {
		const theme = state.theme;
		if (!theme || width < 12) return undefined;
		if (token.type === "code") return codeBlock(context.theme, theme, token as Tokens.Code, width, nextTokenType);
		if (token.type === "hr") {
			const lines = [paint(tok(theme, "mdHr"), "─".repeat(Math.min(width, 80)))]; // a neutral hairline
			if (nextTokenType && nextTokenType !== "space") lines.push("");
			return lines;
		}
		if (token.type === "table") return hairlineTable(theme, context.renderDefault());
		if (token.type === "heading" && !context.defaultTextStyle?.italic) {
			const lines = context.renderDefault();
			if (lines.length) {
				// # and ## in bold, the deeper levels in ink 2. # and ## in the
				// theme's pale heading tint, as in /export.
				const depth = (token as Tokens.Heading).depth;
				lines[0] =
					depth <= 2
						? paint(tok(theme, "mdHeading"), strip(lines[0]), { bold: true })
						: paint(tok(theme, "thinkingText"), strip(lines[0]));
			}
			return lines;
		}
		return undefined;
	};
}

/**
 * fork: a table in hairlines, like the site's and /export's: the header in ink 3, a hairline under it
 * and between rows, no frame and no vertical lines. Works on pi-tui's boxed rendering, whose cells are padded
 * and joined by " │ ", so the columns keep their widths; a table too narrow for a box stays raw markdown.
 */
function hairlineTable(theme: Theme, lines: string[]): string[] {
	if (!lines[0]?.startsWith("┌")) return lines;
	const out: string[] = [];
	let header = true;
	for (const line of lines) {
		if (line.startsWith("┌") || line.startsWith("└")) continue;
		if (line.startsWith("├")) {
			header = false;
			out.push(paint(tok(theme, "borderMuted"), "─".repeat(Math.max(1, visibleWidth(line) - 4))));
		} else if (line.startsWith("│ ")) {
			const cells = line.slice(2, -2).replaceAll(" │ ", "   ");
			out.push(header ? paint(tok(theme, "muted"), strip(cells)) : cells);
		} else out.push(line);
	}
	return out;
}

/** Assistant text: the site's short dash in ink 3 on the first visible line, a two-column indent elsewhere. */
function markText(theme: Theme, lines: string[]): string[] {
	let marked = false;
	return lines.map((line) => {
		if (!marked && !isBlank(line)) {
			marked = true;
			return `${paint(tok(theme, "muted"), "─")} ${line.replace(/^ /, "")}`;
		}
		return `  ${line}`;
	});
}

/** Thinking: a small label, then the text on a rail. Hidden thinking stays one line. */
export function thinking(
	theme: Theme,
	hidden: boolean,
	lines: string[],
	live: boolean,
	state: PrismState,
	now = Date.now(),
): string[] {
	const animate = state.animates("thinking");
	const label3 = tok(theme, "muted");
	// fork: a shine sweeps the live label; one pass every 3.2 s; upright, in ink 3.
	const shine = (label: string) => {
		const style = state.animationStyle("thinking");
		if (style === "dots") return theme.fg("muted", `${label} ${indicator(style, now)}`);
		if (style === "pulse") return pulseLabel(theme, label, now);
		return shimmer(label, label3, tok(theme, "text"), ((now % 3200) / 3200) * (label.length + 8) - 4);
	};
	if (hidden) {
		const label = lines.find((l) => !isBlank(l)) ?? "";
		// fork: in the interface language.
		const text = t(strip(label).trim());
		return [live && animate ? shine(text) : paint(label3, text)];
	}
	// the rail in the strong line, the text in ink 2 (thinkingText).
	const rail = paint(tok(theme, "borderAccent"), "▏");
	const label = t(live ? "Thinking…" : "Thought");
	const out = [live && animate ? shine(label) : paint(label3, label)];
	for (const line of lines) out.push(`${rail} ${line.replace(/^ /, "")}`);
	return out;
}

/** Code fence → panel in the second surface with a language label. Lines are pre-wrapped to `width`. */
function codeBlock(
	md: MarkdownTheme,
	theme: Theme,
	token: Tokens.Code,
	width: number,
	nextTokenType?: string,
): string[] {
	const bg = surface2(theme);
	const lang = String(token.lang || "").trim();
	const key = lang.toLowerCase();
	const icon = own(LANG_ICONS, key) ?? DEFAULT_LANG_ICON;
	const label = paint(tok(theme, "muted"), `${icon} ${lang || "code"}`);
	const highlighted: string[] = md.highlightCode
		? md.highlightCode(token.text, token.lang)
		: String(token.text)
				.split("\n")
				.map((l: string) => md.codeBlock(l));
	const lines: string[] = [];
	lines.push(onBg(` ${label}`, bg, width));
	const room = Math.max(4, width - 4);
	for (const hl of highlighted) {
		const wrapped = visibleWidth(hl) > room ? wrapTextWithAnsi(hl, room) : [hl];
		for (const w of wrapped) lines.push(onBg(`  ${w}`, bg, width));
	}
	lines.push(onBg("", bg, width));
	if (nextTokenType && nextTokenType !== "space") lines.push("");
	return lines;
}

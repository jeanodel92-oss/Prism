// Composer: a pixel tile (half-row edges, corners cut by a quadrant) with a thin bar, an
// embedded working line (a glint running along a hairline + shimmer + elapsed) and a
// model/thinking row.

import {
	type EditorTheme,
	sanitizeTerminalLabel,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { EditorFactory } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { CustomEditor, keyText } from "../../modes/interactive/components/index.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { indicator } from "../animation-frames.ts";
import type { AnimationStyle } from "../animations.ts";
import { APP_DISPLAY_NAME } from "../brand.ts";
import { fill, t } from "../i18n/index.ts";
import { type EditorState, editorState } from "./editor-state.ts";
import {
	bgRGB,
	FG_OFF,
	fgRGB,
	isLightTheme,
	mix,
	onBg,
	paint,
	type RGB,
	shimmer,
	spectrumRamp,
	tok,
} from "./lib/palette.ts";
import type { PrismState } from "./lib/state.ts";
import { tileEdge } from "./lib/tile.ts";
import { goalOn as goalIsOn, planOn } from "./modes.ts";

const BAR = "▌";
const GUTTER = 3; // bar + two columns of breathing room
const RIGHT = 2;
/** the working indicator, a glint running along a hairline at 8 frames a second. */
const GLINT_MS = 125;
const GLINT_CELLS = 12;

/**
 * The indicator at `frame`: a 12-cell hairline; a 3-cell glint (ink 3, white,
 * ink 3) runs along it from left to right, with a dark red fringe behind it and a dark blue one ahead, the
 * light running along the site's ridge. `frame` undefined: the still state, the glint in the middle and no
 * fringes. `colors` are the line, ink 3, ink and the theme's light flag.
 */
export function glint(frame: number | undefined, line: RGB, ink3: RGB, ink: RGB, light: boolean): string {
	const [red, , , , blue] = spectrumRamp(light, 1);
	const pos = frame === undefined ? GLINT_CELLS / 2 - 0.5 : (frame % (GLINT_CELLS + 6)) - 3;
	let out = "";
	for (let i = 0; i < GLINT_CELLS; i++) {
		const d = Math.round(i - pos);
		if (d === 0) out += `${fgRGB(ink)}━`;
		else if (Math.abs(d) === 1) out += `${fgRGB(ink3)}━`;
		else if (frame !== undefined && d === -2) out += `${fgRGB(red!)}─`;
		else if (frame !== undefined && d === 2) out += `${fgRGB(blue!)}─`;
		else out += `${fgRGB(line)}─`;
	}
	return out + FG_OFF;
}
/**
 * The working line's glint and message at `now`; the glint; shine at half speed; both still when
 * `animate` is false. fork: also the preview in /settings.
 */
export function workingLine(
	theme: Theme,
	message: string,
	now: number,
	animate: boolean,
	style: AnimationStyle = "default",
): [string, string] {
	if (animate && style !== "default" && style !== "off") {
		return [theme.fg("accent", indicator(style, now).padEnd(GLINT_CELLS)), theme.fg("thinkingText", message)];
	}
	const spinner = glint(
		animate ? Math.floor(now / GLINT_MS) : undefined,
		tok(theme, "borderMuted"),
		tok(theme, "muted"),
		tok(theme, "text"),
		isLightTheme(theme),
	);
	const span = message.length + 14;
	const pos = ((now / 110) % span) - 7;
	const text = animate
		? shimmer(message, tok(theme, "thinkingText"), tok(theme, "text"), pos, 5)
		: theme.fg("thinkingText", message);
	return [spinner, text];
}

export function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function createEditorFactory(state: PrismState): EditorFactory {
	return (tui, editorTheme, keybindings) => new PrismEditor(tui, editorTheme, keybindings, state);
}

/** fork: a clickable span of the info row, in columns of that row. */
interface Hit {
	from: number;
	to: number;
	run: () => void;
}

class PrismEditor extends CustomEditor {
	private readonly prism: PrismState;
	private linesBelow = 0;
	private hits: Hit[] = [];

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, prism: PrismState) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
		this.prism = prism;
		prism.requestRender = () => tui.requestRender(); // drives the menu frame's opening animation
		// fork: the composer's own submit path runs built-in commands too; the draft comes back after.
		prism.submitCommand = (line) => {
			const draft = this.getText();
			void Promise.resolve(this.onSubmit?.(line)).finally(() => {
				if (draft && this.getText() === "") this.setText(draft);
			});
		};
	}

	// The frame is drawn in render(); the base editor only reports scroll state.
	override renderTopBorder(): string {
		return "";
	}

	override renderBottomBorder(_width: number, hiddenLineCount: number): string {
		this.linesBelow = hiddenLineCount;
		return "";
	}

	override render(width: number): string[] {
		const theme = this.prism.theme;
		if (!theme || width < GUTTER + RIGHT + 6) return super.render(width);
		const inner = width - GUTTER - RIGHT;
		const raw = super.render(inner);
		const n = editorState(this).renderedVisibleLineCount;
		const body = raw.slice(1, 1 + n);
		const autocomplete = raw.slice(2 + n);

		const panel = tok(theme, "userMessageBg");
		const indicator = editorState(this).workingStatusIndicator;
		const working = indicator?.kind === "working";
		const now = Date.now();

		if (this.getText() === "" && body.length === 1 && !working) {
			const head = body[0].replace(/ +$/, "");
			const room = inner - visibleWidth(head) - 1;
			if (room > 4)
				body[0] = `${head} ${theme.fg("dim", truncateToWidth(fill("Ask {0} anything…", APP_DISPLAY_NAME), room, "…"))}`;
		}

		const rows = [...body, "", this.infoRow(inner)];
		const bar = () => {
			if (working) {
				// the accent, breathing slowly (3 s), instead of the spectrum running down
				// the bar; still when animations are off.
				const accent = tok(theme, "accent");
				const breath =
					this.prism.animates("working") && this.prism.animationStyle("working") === "default"
						? (1 - Math.cos((now / 3000) * 2 * Math.PI)) / 2
						: 0;
				return `${fgRGB(mix(accent, panel, breath * 0.45))}${BAR}${FG_OFF}`;
			}
			return this.borderColor(BAR);
		};
		// the tile's top edge stands in for the old blank padding row; the bottom edge is a row of its own.
		const out = [this.statusRow(width, indicator, now), tileEdge(width, panel, "top")];
		rows.forEach((row) => {
			out.push(`${bgRGB(panel)}${bar()}${onBg(`  ${row}`, panel, width - 1)}`);
		});
		out.push(tileEdge(width, panel, "bottom"));
		const pad = " ".repeat(GUTTER);
		for (const line of autocomplete) out.push(pad + line);
		return out;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Rows: status, top edge, text lines, gap, badges, bottom edge, autocomplete. The
		// base editor expects: top border, text lines, bottom border, autocomplete.
		const n = editorState(this).renderedVisibleLineCount;
		if (event.y > n + 4) event = { ...event, y: event.y - 1 };
		else if (event.y === n + 4) {
			// The bottom edge holds no text: like the other decoration rows, but no badge to click.
			if (event.type !== "wheel" && event.type !== "move")
				return event.type === "click" ? { handled: true, focus: true } : { handled: true };
			event = { ...event, y: n + 3 };
		}
		// fork: the status, padding, gap and badge rows hold no text. A click there
		// started a screen text selection, and a double-click selected the blank row: a
		// white bar over the composer. They only take focus now.
		const decoration = event.y === 0 || event.y === 1 || event.y === n + 2 || event.y === n + 3;
		// fork: the thinking badge and the Plan and Goal switches of the info row act on click.
		if (event.y === n + 3 && event.type === "click" && event.button === "left") {
			const x = event.x - GUTTER;
			const hit = this.hits.find((entry) => x >= entry.from && x < entry.to);
			if (hit) {
				hit.run();
				return { handled: true };
			}
		}
		if (decoration && event.type !== "wheel" && event.type !== "move") {
			return event.type === "click" ? { handled: true, focus: true } : { handled: true };
		}
		let y = event.y - 1;
		if (y > n) y = y >= n + 3 ? y - 2 : n + 1;
		return super.handleMouse({
			...event,
			x: event.x - GUTTER,
			y: Math.max(0, y),
			width: Math.max(1, event.width - GUTTER - RIGHT),
		});
	}

	private statusRow(width: number, indicator: EditorState["workingStatusIndicator"], now: number): string {
		const theme = this.prism.theme!;
		if (!indicator) return "";
		if (indicator.kind !== "working") {
			return `  ${indicator.renderInBorder(Math.max(1, width - 4))}`;
		}
		const [spinner, text] = workingLine(
			theme,
			String(indicator.message ?? t("Working")),
			now,
			this.prism.animates("working"),
			this.prism.animationStyle("working"),
		);
		const since = this.prism.workingSince;
		const elapsed = since ? theme.fg("dim", ` · ${formatElapsed(now - since)}`) : "";
		const hint = `${theme.fg("dim", keyText("app.interrupt"))} ${theme.fg("muted", t("interrupt"))}`;
		const left = `  ${spinner} ${text}${elapsed}`;
		const gap = width - visibleWidth(left) - visibleWidth(hint) - 2;
		if (gap < 2) return truncateToWidth(left, width, "");
		return `${left}${" ".repeat(gap)}${hint}  `;
	}

	private infoRow(inner: number): string {
		const theme = this.prism.theme!;
		const hits: Hit[] = [];
		this.hits = hits;
		let left: string;
		if (this.getText().trimStart().startsWith("!")) {
			const shell = tok(theme, "bashMode");
			left = `${paint(shell, "$", { bold: true })} ${paint(shell, "shell")}`;
		} else {
			let model: NonNullable<PrismState["ctx"]>["model"];
			try {
				model = this.prism.ctx?.model;
			} catch {}
			// The session's placeholder when no model is configured is not a model to show.
			if (model?.provider === "unknown" && model.id === "unknown") model = undefined;
			// fork: a server's model list may hold anything; only the display is cleaned.
			const name = model ? sanitizeTerminalLabel(model.id) : t("no model");
			left = paint(tok(theme, "text"), name);
			// fork: a click on the model does what its key does (next model).
			const cycle = this.actionHandlers.get("app.model.cycleForward");
			if (cycle) hits.push({ from: 0, to: visibleWidth(name), run: cycle });
			if (model?.provider) left += theme.fg("dim", `  ${sanitizeTerminalLabel(model.provider)}`);
			if (model?.reasoning) {
				// the level written in ink 3, without a mark or a colour; it stays clickable.
				const level = t(this.prism.thinkingLevel || "off");
				const from = visibleWidth(left) + 3;
				left += `${theme.fg("dim", " · ")}${theme.fg("dim", level)}`;
				const cycle = this.prism.cycleThinking;
				if (cycle) hits.push({ from, to: from + visibleWidth(level), run: cycle });
			}
		}
		const scroll: string[] = [];
		const above = editorState(this).scrollOffset;
		if (above > 0) scroll.push(`↑ ${above}`);
		if (this.linesBelow > 0) scroll.push(fill("↓ {0} more", String(this.linesBelow)));
		const scrollText = scroll.length ? theme.fg("dim", scroll.join("  ")) : "";
		// fork: Plan and Goal switches on the right, with their keys when there is room.
		const switches = this.modeSwitches();
		for (const variant of [switches.withKeys, switches.bare, []]) {
			const parts = [scrollText, ...variant.map((entry) => entry.text)].filter(Boolean);
			const right = parts.join("  ");
			const gap = inner - visibleWidth(left) - visibleWidth(right);
			if (gap < 2) continue;
			let x = inner - visibleWidth(right) + (scrollText ? visibleWidth(scrollText) + 2 : 0);
			for (const entry of variant) {
				hits.push({ from: x, to: x + entry.width, run: entry.run });
				x += visibleWidth(entry.text) + 2;
			}
			return left + " ".repeat(gap) + right;
		}
		this.hits = hits.filter((hit) => hit.to <= inner - 1);
		return truncateToWidth(left, inner, "…");
	}

	/**
	 * The Plan and Goal switches: a ● in ink and the label in ink when the mode is on, the ● in the strong line
	 * and the label in ink 3 otherwise (◈ ◇ ◉ ◎ are missing from common terminal fonts). `width` is the
	 * clickable part (the label, not the key hint).
	 */
	private modeSwitches(): Record<"withKeys" | "bare", Array<{ text: string; width: number; run: () => void }>> {
		const theme = this.prism.theme!;
		const statuses = this.prism.statuses();
		const planIsOn = planOn(statuses.get("plan-mode"));
		const goalOn = goalIsOn(statuses.get("goal"));
		const label = (on: boolean, text: string) =>
			on ? theme.fg("accent", `● ${text}`) : `${theme.fg("borderAccent", "●")} ${theme.fg("dim", text)}`;
		const { modes, togglePlan, openCommand } = this.prism;
		const entries: Array<{ label: string; key?: string; run: () => void }> = [];
		if (modes.plan && togglePlan) {
			entries.push({ label: label(planIsOn, t("plan")), key: this.prism.planShortcut?.(), run: togglePlan });
		}
		if (modes.goal && openCommand) {
			entries.push({
				label: label(goalOn, t("goal")),
				key: keyText("app.goal.menu"),
				run: () => openCommand("goal"),
			});
		}
		// fork: the file browser's button.
		if (modes.files && openCommand) {
			entries.push({
				label: theme.fg("muted", `\uf07b ${t("files")}`),
				key: keyText("app.files.browse"),
				run: () => openCommand("files"),
			});
		}
		const make = (withKey: boolean) =>
			entries.map((entry) => ({
				text: withKey && entry.key ? `${entry.label} ${theme.fg("dim", entry.key)}` : entry.label,
				width: visibleWidth(entry.label),
				run: entry.run,
			}));
		return { withKeys: make(true), bare: make(false) };
	}
}

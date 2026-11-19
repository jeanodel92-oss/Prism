// Menus opened by slash commands (/model, /settings, /resume, /tree, …) and by
// extensions (ctx.ui.select / input / editor) take the editor's slot. While one
// is shown, its slot is drawn as a tile:
//   • the title row and the key-hint row are the
//     tile's first and last rows, inset by half a cell so its corners read as cut
//   • the selector's inner rules become thin rules on the tile
//   • the selected row ("→ …") is a sub-tile with an accent bar
//   • the accents fade in when the menu opens
// Content is rendered by pi at the inner width; only the chrome is ours.
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { reveal } from "../animation-frames.ts";
import type { AnimationStyle } from "../animations.ts";
import { t } from "../i18n/index.ts";
import type { DialogFrame, RenderHooks } from "../render-hooks.ts";
import { BG_OFF, bgRGB, FG_OFF, fgRGB, mix, onBand, onBg, paint, tok } from "./lib/palette.ts";
import type { PrismState } from "./lib/state.ts";

export const RULE = "\x1b_prism:rule\x07";
export const OPEN_MS = 320;

interface Kind {
	icon: string;
	label?: string;
	/** Use the menu's own first line as the title instead of `label`. */
	promote?: boolean;
}

const KINDS: Array<[RegExp, Kind]> = [
	[/^SettingsSelector/, { icon: "\uf013", label: "Settings" }],
	[/^ScopedModelsSelector/, { icon: "\uf2db", label: "Models", promote: true }],
	[/^ModelSelector/, { icon: "\uf2db", label: "Model" }],
	[/^ThinkingSelector/, { icon: "\uf0eb", label: "Thinking", promote: true }],
	[/^ThemeSelector/, { icon: "\uf1fc", label: "Theme" }],
	[/^SessionSelector/, { icon: "\uf1da", label: "Resume session" }],
	[/^TreeSelector/, { icon: "\uf1bb", label: "Session tree", promote: true }],
	[/^UserMessageSelector/, { icon: "\ue725", label: "Fork", promote: true }],
	[/^(OAuthSelector|LoginDialog|RadiusLogin)/, { icon: "\uf084", label: "Login", promote: true }],
	[/^ShowImagesSelector/, { icon: "\uf03e", label: "Images" }],
	[/^ExtensionSelector/, { icon: "\uf0ca", label: "Select", promote: true }],
	[/^ExtensionInput/, { icon: "\uf044", label: "Input", promote: true }],
	[/^ExtensionEditor/, { icon: "\uf044", label: "Edit", promote: true }],
	[/Selector(Component)?\d*$/, { icon: "\uf0ca", label: "Menu", promote: true }],
];

const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07/g, "");
const isBlank = (line: string) => plain(line).trim() === "";
const isRule = (line: string) => line === RULE;
/** A rule a menu draws itself (pi-tui-kit's), not through the dynamic border hook. */
const isHairline = (line: string) => /^─+$/.test(plain(line).trim());
const HINT = /(esc|escape|cancel|enter|navigate|échap|entrée|annuler|parcourir)/i;
/**
 * fork: a kit's key hints ("↑/↓ navigate • enter select • esc close") in the active language,
 * segment by segment: its keys ("esc", "ctrl+c") and its action ("select").
 */
function hintText(text: string): string {
	const whole = t(text);
	if (whole !== text) return whole;
	return text
		.split(/( [•·] )/)
		.map((part, i) => {
			if (i % 2 === 1 || t(part) !== part) return t(part);
			const [, keys, action] = /^(\S+) (.+)$/.exec(part) ?? [];
			if (!keys || !action) return part;
			return `${keys.replace(/[^/+]+/g, (key) => t(key))} ${t(action)}`;
		})
		.join("");
}
/** fork: the screens of pi-tui-kit menus (Goal, Plan) carry this mark. */
const isKitScreen = (component: Component) => (component as { __piTuiKitScreen?: unknown }).__piTuiKitScreen === true;
/** Trim spaces at both ends, looking through leading/trailing SGR codes. */
const trimAnsi = (line: string) =>
	line
		.replace(/^(?:\x1b\[[0-9;:]*m|\s)+/, (m) => m.replace(/\s+/g, ""))
		.replace(/(?:\x1b\[[0-9;:]*m|\s)+$/, (m) => m.replace(/\s+/g, ""));

function kindOf(component: Component): Kind | undefined {
	const name: string = component.constructor?.name ?? "";
	for (const [re, kind] of KINDS) if (re.test(name)) return kind;
	return undefined;
}

/**
 * Frame for the menu shown in the editor's slot (fork/editor-slot.ts).
 * fork: replaces the reference pack's method swap on the editor's host container.
 */
export function dialogFrameHook(state: PrismState): NonNullable<RenderHooks["dialogFrame"]> {
	const born = new WeakMap<object, number>();
	let ticker: ReturnType<typeof setInterval> | undefined;
	return (child: Component, width: number): DialogFrame | undefined => {
		const window = isKitScreen(child);
		const kind = window ? undefined : kindOf(child);
		const theme = state.theme;
		if ((!kind && !window) || !theme || width < 24) return undefined;
		if (!born.has(child)) {
			born.set(child, Date.now());
			// fork: no timer while the "menus" animation is off, so it costs nothing.
			if (state.animates("menus")) {
				if (ticker) clearInterval(ticker);
				ticker = setInterval(() => state.requestRender(), 16);
				setTimeout(() => {
					if (ticker) clearInterval(ticker);
					ticker = undefined;
					state.requestRender();
				}, OPEN_MS + 40);
			}
		}
		const innerWidth = width - 4;
		state.framing++;
		let lines: string[];
		try {
			lines = child.render(innerWidth);
		} finally {
			state.framing--;
		}
		const age = state.animates("menus") ? Date.now() - born.get(child)! : OPEN_MS;
		const style = state.animationStyle("menus");
		const out = kind
			? {
					...frame(theme, kind, lines, width, style === "default" ? age : OPEN_MS),
					innerWidth,
					innerHeight: lines.length,
					offsetX: 2,
				}
			: windowFrame(theme, lines, width, style === "default" ? age : OPEN_MS, (process.stdout.rows ?? 24) - 3);
		if (style === "wipe" || style === "slide") {
			out.lines = reveal(out.lines, age / OPEN_MS, style);
			out.rows = out.rows.slice(0, out.lines.length);
		}
		return out;
	};
}

/** fork: a small menu at `age` ms after it opened, the preview in /settings. */
export function menuPreview(
	theme: Theme,
	lines: string[],
	width: number,
	age: number,
	style: AnimationStyle = "default",
): string[] {
	const out = frame(theme, { icon: "\uf0ca", label: "Menu" }, lines, width, style === "default" ? age : OPEN_MS).lines;
	return style === "wipe" || style === "slide" ? reveal(out, age / OPEN_MS, style) : out;
}

function frame(theme: Theme, kind: Kind, src: string[], width: number, age: number) {
	// Index lines so mouse rows can be mapped back to the selector's own rows.
	const items = src.map((line, i) => ({ line, i }));
	const edge = (it: { line: string }) => isBlank(it.line) || isRule(it.line);
	while (items.length && edge(items[0])) items.shift();
	while (items.length && edge(items[items.length - 1])) items.pop();

	const room = width - 10;
	let title: string | undefined;
	if (kind.promote && items.length > 1 && !isRule(items[0].line)) {
		const head = trimAnsi(items[0].line);
		if (visibleWidth(head) <= room) {
			title = head;
			items.shift();
			while (items.length && edge(items[0])) items.shift();
		}
	}
	if (!title) title = t(kind.label ?? "Menu");

	let hints: string | undefined;
	const last = items[items.length - 1];
	const before = items[items.length - 2];
	// Wrapped hints (the line above is hints too) stay inside the frame.
	if (last && HINT.test(plain(last.line)) && !(before && HINT.test(plain(before.line)))) {
		// fork: a menu's key hints in the interface language when the catalog has them (fork/i18n).
		const english = trimAnsi(last.line);
		const translated = t(plain(english));
		const text = translated === plain(english) ? english : theme.fg("dim", translated);
		if (visibleWidth(text) <= room) {
			hints = text;
			items.pop();
			while (items.length && isBlank(items[items.length - 1].line)) items.pop();
		}
	}

	const inner = width - 4;
	const panel = tok(theme, "userMessageBg");
	const band = tok(theme, "selectedBg");
	// the frame is a tile (one tone, R3). The title and hint rows are its first and last rows, inset by
	// half a cell (▐ ▌) so the corners read as cut; no row is added. The opening fades the accents in from the
	// surface instead of fading a spectrum frame in from black.
	const fade = age < OPEN_MS ? Math.min(1, age / (OPEN_MS * 0.6)) : 1;
	const accent = mix(panel, tok(theme, "accent"), fade);
	const rule = mix(panel, tok(theme, "borderMuted"), fade);
	const cap = (body: string) =>
		`${fgRGB(panel)}▐${FG_OFF}${onBg(` ${truncateToWidth(body, width - 4, "…")}`, panel, width - 2)}${fgRGB(panel)}▌${FG_OFF}`;

	const lines: string[] = [];
	const rows: number[] = [];
	// the title in ink, its icon in ink 3, no pill.
	const head = `${paint(mix(panel, tok(theme, "muted"), fade), kind.icon)} ${paint(accent, plain(title), { bold: true })}`;
	lines.push(cap(head));
	rows.push(-1);

	for (const { line, i } of items) {
		if (isRule(line)) {
			lines.push(onBg(` ${paint(rule, "─".repeat(width - 2))} `, panel, width));
		} else {
			const text = plain(line);
			const marker = /^\s{0,2}([→›]) /.exec(text)?.[1];
			const selected = marker !== undefined;
			const input = /^>(\s|$)/.test(text);
			let body = truncateToWidth(line, inner, "…");
			if (selected) body = onBand(theme, body);
			if (marker) body = body.replace(marker, paint(accent, "❯", { bold: true }));
			else if (input) body = body.replace(">", paint(accent, "❯", { bold: true }));
			// The chosen row is a sub-tile: a band one column in from each side, with the accent bar.
			const bg = selected ? band : panel;
			const lead = selected ? `${fgRGB(accent)}▌${FG_OFF}` : " ";
			lines.push(
				`${bgRGB(panel)} ${bgRGB(bg)}${lead}${onBg(body, bg, inner)}${bgRGB(bg)} ${bgRGB(panel)} ${BG_OFF}`,
			);
		}
		rows.push(i);
	}

	lines.push(cap(hints ?? ""));
	rows.push(-1);
	return { lines, rows };
}

/**
 * fork: the menus of the bundled Goal and Plan plug-ins (pi-tui-kit screens) are drawn as
 * a window, like /settings and /perm: a box with the screen's title and a ✕, its lines, then its key hints, instead
 * of menus at the bottom of the screen. The kit's own rules, title and hint rows become
 * the window's chrome; the content is the kit's, rendered at the inner width.
 */
function windowFrame(theme: Theme, src: string[], width: number, age: number, height: number): DialogFrame {
	const items = src.map((line, i) => ({ line, i }));
	const edge = (it: { line: string }) => isBlank(it.line) || isRule(it.line) || isHairline(it.line);
	while (items.length && edge(items[0])) items.shift();
	while (items.length && edge(items[items.length - 1])) items.pop();
	const title = items.length > 1 ? plain(items.shift()!.line).trim() : t("Menu");
	while (items.length && edge(items[0])) items.shift();
	// The key hints are the kit's last row, in dim; on a narrow window they wrap, and the rows above that hold
	// a "•" or "·" separator are theirs too (muted text lines can share the dim color). They are rewrapped at
	// the window's width.
	let hints = "";
	const dim = theme.getFgAnsi("dim");
	let from = items.length - 1;
	if (from >= 0 && !items[from]!.line.startsWith(dim)) from = items.length;
	while (
		from > 0 &&
		from < items.length &&
		items[from - 1]!.line.startsWith(dim) &&
		/ [•·] /.test(plain(items[from - 1]!.line))
	)
		from--;
	const tail = items.slice(from).map((it) => plain(it.line).trim());
	if (tail.length > 0 && HINT.test(tail.join(" "))) {
		hints = hintText(tail.join(" "));
		items.splice(from);
		while (items.length && edge(items[items.length - 1])) items.pop();
	}
	// The kit fits its own frame to the terminal (its height minus 3 rows); the window's chrome takes more. On a
	// short terminal, blank lines go first, from the bottom up, then the rules under the title and above the hints.
	const hintRows = hints ? wrapTextWithAnsi(hints, width - 4) : [];
	let rules = hints ? 2 : 1;
	const over = () => items.length + 3 + rules + hintRows.length - height;
	for (let at = items.length - 1; at >= 0 && over() > 0; at--) if (isBlank(items[at]!.line)) items.splice(at, 1);
	while (rules > 0 && over() > 0) rules--;

	const inner = width - 4;
	const panel = tok(theme, "userMessageBg");
	const band = tok(theme, "selectedBg");
	const fade = age < OPEN_MS ? Math.min(1, age / (OPEN_MS * 0.6)) : 1;
	const accent = mix(panel, tok(theme, "accent"), fade);
	const border = (text: string) => paint(tok(theme, "borderAccent"), text);
	const rule = border(`├${"─".repeat(width - 2)}┤`);
	const side = (body: string) => `${border("│")}${onBg(body, panel, width - 2)}${border("│")}`;
	const lines: string[] = [];
	const rows: number[] = [];
	const chrome = (line: string) => {
		lines.push(line);
		rows.push(-1);
	};
	chrome(border(`┌${"─".repeat(width - 2)}┐`));
	const head = ` ${paint(accent, truncateToWidth(title, width - 7, "…"), { bold: true })}`;
	chrome(side(`${head}${" ".repeat(Math.max(0, width - 5 - visibleWidth(head)))}${theme.fg("muted", " ✕ ")}`));
	if (rules === (hints ? 2 : 1)) chrome(rule);
	for (const { line, i } of items) {
		if (isRule(line) || isHairline(line)) {
			lines.push(rule);
		} else {
			const marker = /^\s{0,2}([→›]) /.exec(plain(line))?.[1];
			let body = truncateToWidth(line, inner, "…");
			if (marker) body = onBand(theme, body).replace(marker, paint(accent, "❯", { bold: true }));
			// The chosen row is a band with the accent bar, as in the tiled menus.
			const bg = marker ? band : panel;
			const lead = marker ? `${fgRGB(accent)}▌${FG_OFF}` : " ";
			lines.push(`${border("│")}${bgRGB(bg)}${lead}${onBg(body, bg, inner)}${bgRGB(bg)} ${BG_OFF}${border("│")}`);
		}
		rows.push(i);
	}
	if (hints) {
		if (rules > 0) chrome(rule);
		for (const row of hintRows) chrome(side(theme.fg("dim", ` ${row}`)));
	}
	chrome(border(`└${"─".repeat(width - 2)}┘`));
	return {
		lines: lines.map((line) => onBg(line, panel, width)),
		rows,
		innerWidth: inner,
		innerHeight: src.length,
		offsetX: 2,
		close: { row: 1, from: width - 4, to: width - 1 },
	};
}

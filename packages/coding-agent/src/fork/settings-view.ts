/**
 * fork: `/settings` as a window over the screen, like btop
 * . It draws the domains settings-domains.ts builds, at one fixed size whatever the domain:
 *   • the title row: the title, the search field (`/`), the Simple │ Advanced switch and a close button;
 *   • from WIDE_WIDTH columns, the numbered domains on the left and the domain's settings on the right;
 *     below, one column: the domains, then the domain's settings with « ‹ » to come back;
 *   • under the settings, a fixed help zone: the focused setting's description, then what each choice does;
 *   • on/off settings switch with Enter or a click; a setting with choices opens a small list of them,
 *     each with what it does; a setting with its own menu opens it in place of the settings;
 *   • the key hints in the last row; a click outside the window closes it (fork/outside-press.ts).
 */
import {
	type Component,
	getKeybindings,
	type SettingItem,
	type SettingsListTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getSettingsListTheme, theme } from "../modes/interactive/theme/theme.ts";
import { fill, t } from "./i18n/index.ts";
import {
	BG_OFF,
	bgRGB,
	FG_OFF,
	fgRGB,
	isLightTheme,
	mix,
	onBg,
	paint,
	type RGB,
	step,
	tok,
} from "./prism/lib/palette.ts";
import { OPTION_DESCRIPTIONS } from "./settings-descriptions.ts";
import type { SettingsDomain, SettingsModel } from "./settings-domains.ts";
import type { ActiveRows } from "./settings-list-editor.ts";

/** Below this width, one column instead of two. */
export const WIDE_WIDTH = 80;
/** The window's widest size, so long lines stay readable on large terminals. */
export const MAX_WIDTH = 120;
/** Rows the frame takes: top border, title row, two rules, the key-hint row and the bottom border. */
const CHROME = 6;
const MAX_HELP = 7;
const MIN_HELP = 3;

const panel = (): RGB => tok(theme, "userMessageBg");
const line = (): RGB => tok(theme, "borderAccent");
/** Accent text on a tinted fill: three steps darker on light themes to keep 4.5:1. */
const pillText = (color: RGB): RGB => (isLightTheme(theme) ? step(color, -3) : color);
const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");
/** Lowercase, without accents, for the search. */
const fold = (s: string) => plain(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Fits `text` to exactly `width` columns. */
function fitWidth(text: string, width: number): string {
	const cut = truncateToWidth(text, Math.max(0, width), "…");
	return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
}

/** on/off as the site's state dot: ● in ink and "on", or ○ in the strong line and "off" in ink 3. */
export function drawSwitch(on: boolean): string {
	return on
		? `${paint(tok(theme, "accent"), "●")} ${theme.fg("text", t("on"))}`
		: `${paint(tok(theme, "borderAccent"), "○")} ${theme.fg("muted", t("off"))}`;
}

/** The pi list theme with translated hints, for the menus a setting opens (settings-domains.ts). */
export function settingsControlsTheme(): SettingsListTheme {
	const base = getSettingsListTheme();
	return { ...base, hint: (text) => base.hint(t(text)) };
}

const BOOLEAN = new Set(["on", "off", "true", "false"]);
type Kind = "toggle" | "choice" | "action" | "submenu" | "info";

function kindOf(item: SettingItem): Kind {
	if (item.submenu) return "submenu";
	const values = item.values ?? [];
	if (values.length === 2 && values.every((v) => BOOLEAN.has(v))) return "toggle";
	if (values.length === 1) return "action";
	return values.length > 1 ? "choice" : "info";
}

const isOn = (value: string) => value === "on" || value === "true";

/** What each choice of a setting does, or undefined when the setting's own description covers it. */
const optionHelp = (id: string, value: string): string | undefined => {
	const text = OPTION_DESCRIPTIONS[id]?.[value];
	return text === undefined ? undefined : t(text);
};

/** `▐ Simple │ Advanced ▌`, the active side in the accent. */
function segmented(advanced: boolean): string {
	const fill = mix(panel(), tok(theme, "accent"), 0.22);
	const on = pillText(tok(theme, "accent"));
	// Halfway between muted and text: muted alone is under 4.5:1 on the tinted fill (measured).
	const off = mix(tok(theme, "muted"), tok(theme, "text"), 0.5);
	const side = (label: string, active: boolean) => (active ? paint(on, label, { bold: true }) : paint(off, label));
	const inner = ` ${side(t("Simple"), !advanced)} ${paint(off, "│")} ${side(t("Advanced"), advanced)} `;
	return `${fgRGB(fill)}▐${bgRGB(fill)}${inner}${BG_OFF}${fgRGB(fill)}▌${FG_OFF}`;
}
/** `▐`, a space, the simple label, a space, `│`, a space, the advanced label, a space, `▌`. */
const segmentedWidth = () => visibleWidth(t("Simple")) + visibleWidth(t("Advanced")) + 7;

/** A row of the settings column: a setting, and in search results the domain it belongs to. */
interface Row {
	item: SettingItem;
	domain: SettingsDomain;
}

type Focus = "domains" | "rows" | "search";

/** Where the last render put things, for the mouse. */
interface Geometry {
	width: number;
	wide: boolean;
	left: number;
	body: number;
	rowsTop: number;
	rowsArea: number;
	scroll: number;
	/** the first domain drawn in the domain column. */
	domainScroll: number;
	field: [number, number];
	toggle: number;
	close: number;
	/** fork: `owners` gives the choice drawn on each line inside the frame, as choices wrap. */
	popup?: { top: number; left: number; width: number; owners: number[] };
	submenuTop: number;
	/** fork: the width the submenu is drawn at, which its clicks must carry. */
	submenuWidth: number;
}

export interface SettingsViewOptions {
	onClose: () => void;
	/** The terminal's height, read at each render: the window takes at most all of it but two rows. */
	rows: () => number;
	/** The domain to show first. */
	domain?: string;
	/** fork: the setting to focus in that domain, and whether to open it (its page or its menu). */
	item?: string;
	openItem?: boolean;
}

export class SettingsView implements Component {
	readonly model: SettingsModel;
	private readonly options: SettingsViewOptions;
	private domainIndex = 0;
	private rowIndex = 0;
	private focus: Focus = "domains";
	/** Below WIDE_WIDTH, the domain list or one domain's settings. */
	private page: "list" | "domain" = "list";
	private query = "";
	/** `scroll`: the first line of choices drawn when they do not all fit. */
	private popup: { item: SettingItem; index: number; scroll?: number } | undefined;
	private submenu: { item: SettingItem; component: Component } | undefined;
	private scroll = 0;
	private domainScroll = 0;
	private geometry: Geometry | undefined;

	constructor(model: SettingsModel, options: SettingsViewOptions) {
		this.model = model;
		this.options = options;
		const start = model.domains().findIndex((d) => d.id === options.domain);
		if (start !== -1) {
			this.domainIndex = start;
			this.page = "domain";
		}
		if (start !== -1 && options.item) {
			this.selectItem(options.item);
			const row = this.rows()[this.rowIndex];
			if (options.openItem && row?.item.id === options.item) this.activate(row);
		}
	}

	/** Sets a value changed outside the view (a refused terminal mode change). */
	updateValue(id: string, value: string): void {
		for (const domain of this.model.domains()) {
			const item = domain.items().find((i) => i.id === id);
			if (item) item.currentValue = value;
		}
	}

	/** Shows the domain holding setting `id`, with that setting focused. */
	selectItem(id: string): void {
		this.query = "";
		this.domains.forEach((domain, d) => {
			const row = domain.items().findIndex((i) => i.id === id);
			if (row === -1) return;
			this.domainIndex = d;
			this.rowIndex = row;
			this.focus = "rows";
			this.page = "domain";
		});
	}

	invalidate(): void {
		this.submenu?.component.invalidate?.();
	}

	private get domains(): SettingsDomain[] {
		return this.model.domains();
	}

	private get domain(): SettingsDomain | undefined {
		const domains = this.domains;
		this.domainIndex = Math.max(0, Math.min(this.domainIndex, domains.length - 1));
		return domains[this.domainIndex];
	}

	/** The settings column: the domain's settings, or the search results across every domain. */
	private rows(): Row[] {
		if (this.query.trim() !== "") {
			const words = fold(this.query).split(/\s+/).filter(Boolean);
			const rows: Row[] = [];
			for (const domain of this.domains) {
				for (const item of [...domain.items(), ...domain.searchItems()]) {
					const text = fold(`${item.label} ${item.description ?? ""} ${t(domain.label)}`);
					if (words.every((word) => text.includes(word))) rows.push({ item, domain });
				}
			}
			return rows;
		}
		const domain = this.domain;
		return domain ? domain.items().map((item) => ({ item, domain })) : [];
	}

	private get searching(): boolean {
		return this.query.trim() !== "";
	}

	/** The interface switch is the interface domain's own setting. */
	private interfaceItem(): SettingItem | undefined {
		for (const domain of this.domains) {
			const item = domain.items().find((i) => i.id === "interface-mode");
			if (item) return item;
		}
		return undefined;
	}

	// ── rendering ────────────────────────────────────────────────────────────────────────────

	render(width: number): string[] {
		const wide = width >= WIDE_WIDTH;
		const inner = width - 2;
		const most = Math.max(1, ...this.domains.map((d) => d.items().length));
		const leftWidth = wide ? Math.min(30, Math.max(18, ...this.domains.map((d) => visibleWidth(t(d.label)) + 7))) : 0;
		// Header rows of the settings column: the domain's title, its description and a blank line (wide only).
		const header = wide ? 3 : 0;
		const wanted = header + most + 1 + MAX_HELP;
		// fork: the keys wrap on a narrow terminal, "Esc close" was cut off at 40 columns.
		const hints = wrapTextWithAnsi(this.hints(wide), inner - 2);
		const body = Math.max(
			8,
			Math.min(this.options.rows() - 1 - CHROME - hints.length, Math.max(wanted, this.domains.length + 2)),
		);
		// On a short terminal the help zone keeps its height before the settings beyond four, which then scroll.
		const help = Math.max(MIN_HELP, Math.min(MAX_HELP, body - header - 1 - Math.min(most, 4)));
		const rowsArea = Math.max(1, body - header - 1 - help);
		const rows = this.rows();
		this.rowIndex = Math.max(0, Math.min(this.rowIndex, rows.length - 1));
		if (this.rowIndex < this.scroll) this.scroll = this.rowIndex;
		if (this.rowIndex >= this.scroll + rowsArea) this.scroll = this.rowIndex - rowsArea + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - rowsArea)));

		const geometry: Geometry = {
			width,
			wide,
			left: leftWidth,
			body,
			rowsTop: 3 + header,
			rowsArea,
			scroll: this.scroll,
			domainScroll: 0,
			field: [0, 0],
			toggle: -1,
			close: -1,
			submenuTop: 3 + header,
			submenuWidth: 0,
		};
		const border = (text: string) => paint(line(), text);
		const out: string[] = [];
		out.push(border(`┌${"─".repeat(inner)}┐`));
		out.push(`${border("│")}${this.titleRow(inner, wide, geometry)}${border("│")}`);
		out.push(
			border(wide ? `├${"─".repeat(leftWidth)}┬${"─".repeat(inner - leftWidth - 1)}┤` : `├${"─".repeat(inner)}┤`),
		);

		const rightWidth = wide ? inner - leftWidth - 1 : inner;
		const right = this.settingsColumn(rightWidth, body, header, rowsArea, help, rows, geometry, wide);
		if (wide) {
			const left = this.domainColumn(leftWidth, body, geometry);
			for (let i = 0; i < body; i++) out.push(`${border("│")}${left[i]}${border("│")}${right[i]}${border("│")}`);
		} else {
			const column = this.page === "list" && !this.searching ? this.domainColumn(inner, body, geometry) : right;
			for (let i = 0; i < body; i++) out.push(`${border("│")}${column[i]}${border("│")}`);
		}
		out.push(
			border(wide ? `├${"─".repeat(leftWidth)}┴${"─".repeat(inner - leftWidth - 1)}┤` : `├${"─".repeat(inner)}┤`),
		);
		for (const hint of hints) out.push(`${border("│")}${fitWidth(theme.fg("dim", ` ${hint}`), inner)}${border("│")}`);
		out.push(border(`└${"─".repeat(inner)}┘`));
		this.geometry = geometry;
		return out.map((l) => onBg(l, panel(), width));
	}

	private titleRow(inner: number, wide: boolean, geometry: Geometry): string {
		const back = !wide && this.page === "domain" && !this.searching;
		const title = back
			? `${theme.fg("muted", "‹ ")}${theme.bold(theme.fg("text", t(this.domain?.label ?? "Settings")))}`
			: theme.bold(theme.fg("text", t("Settings")));
		const close = theme.fg("muted", " ✕ ");
		const hasSwitch = this.interfaceItem() !== undefined && inner >= 44;
		const switchText = hasSwitch ? segmented(this.model.isAdvanced()) : "";
		const used = 1 + visibleWidth(title) + 2 + (hasSwitch ? segmentedWidth() + 1 : 0) + 3;
		const fieldWidth = Math.max(0, inner - used);
		let field = "";
		if (fieldWidth >= 8) {
			const active = this.focus === "search";
			const text = this.query || active ? `/ ${this.query}${active ? "▏" : ""}` : `/ ${t("Search a setting…")}`;
			const color = this.query || active ? tok(theme, "text") : tok(theme, "muted");
			field = onBg(
				paint(color, truncateToWidth(` ${text}`, fieldWidth - 1, "…")),
				tok(theme, "selectedBg"),
				fieldWidth - 1,
			);
			field += " ";
		}
		const start = 1 + 1 + visibleWidth(title) + 2;
		geometry.field = [start, start + fieldWidth - 1];
		geometry.toggle = hasSwitch ? start + fieldWidth : -1;
		geometry.close = 1 + inner - 3;
		const spacer = " ".repeat(Math.max(0, fieldWidth - visibleWidth(field)));
		return fitWidth(` ${title}  ${field}${spacer}${switchText}${hasSwitch ? " " : ""}${close}`, inner);
	}

	private domainColumn(width: number, body: number, geometry: Geometry): string[] {
		const lines: string[] = [];
		const domains = this.domains;
		const band = tok(theme, "selectedBg");
		// on a short terminal the domains scroll with the selection, above their count.
		const room = Math.max(1, body - 1);
		if (this.domainIndex < this.domainScroll) this.domainScroll = this.domainIndex;
		if (this.domainIndex >= this.domainScroll + room) this.domainScroll = this.domainIndex - room + 1;
		this.domainScroll = Math.max(0, Math.min(this.domainScroll, Math.max(0, domains.length - room)));
		geometry.domainScroll = this.domainScroll;
		domains.forEach((domain, i) => {
			if (i < this.domainScroll || i >= this.domainScroll + room) return;
			const number = theme.fg("muted", String(i + 1).padStart(2, "0"));
			const label = t(domain.label);
			if (i !== this.domainIndex || this.searching) {
				lines.push(fitWidth(` ${number} ${theme.fg("thinkingText", label)}`, width));
				return;
			}
			const active = this.focus === "domains";
			const bar = active ? paint(tok(theme, "accent"), "▌") : " ";
			const text = active ? theme.bold(theme.fg("text", label)) : theme.fg("text", label);
			lines.push(`${bar}${onBg(fitWidth(`${number} ${text}`, width - 1), band, width - 1)}`);
		});
		while (lines.length < body - 1) lines.push(" ".repeat(width));
		const counts = this.model.counts();
		const count = this.model.isAdvanced()
			? fill("{0} settings", String(counts.total))
			: fill("{0} of {1} settings", String(counts.shown), String(counts.total));
		lines.push(fitWidth(theme.fg("muted", ` ${count}`), width));
		return lines.slice(0, body);
	}

	private settingsColumn(
		width: number,
		body: number,
		header: number,
		rowsArea: number,
		help: number,
		rows: Row[],
		geometry: Geometry,
		wide: boolean,
	): string[] {
		const lines: string[] = [];
		if (header > 0) {
			const title = this.searching ? fill("Search: {0}", this.query.trim()) : t(this.domain?.label ?? "");
			const description = this.searching
				? fill("{0} settings found", String(rows.length))
				: t(this.domain?.description ?? "");
			lines.push(fitWidth(` ${theme.bold(theme.fg("text", title))}`, width));
			lines.push(fitWidth(` ${theme.fg("thinkingText", description)}`, width));
			lines.push(" ".repeat(width));
		}
		if (this.submenu) {
			const room = body - header;
			geometry.submenuWidth = width - 2;
			const drawn = dropHint(this.submenu.component.render(width - 2)).map((l) => fitWidth(` ${l}`, width));
			// a list says which rows must stay in view (its field and message when
			// adding); other menus are followed by their « → » line.
			const selected = drawn.findIndex((l) => /^\s*→ /.test(plain(l)));
			const active = (this.submenu.component as Partial<ActiveRows>).activeRows?.() ?? {
				from: selected,
				to: selected,
			};
			const to = Math.min(active.to, drawn.length - 1);
			const from = Math.max(0, Math.min(to - room + 1, drawn.length - room));
			for (const l of drawn.slice(Math.max(0, from), Math.max(0, from) + room)) lines.push(l);
			geometry.submenuTop = 3 + header - Math.max(0, from);
			while (lines.length < body) lines.push(" ".repeat(width));
			return lines;
		}
		// fork: no fixed 32 columns, "Les commandes voient mes conten…" was cut at 140 columns.
		const labelWidth = Math.min(
			Math.floor(width / 2),
			Math.max(8, ...rows.map((r) => visibleWidth(r.item.label))) + 1,
		);
		const visible = rows.slice(this.scroll, this.scroll + rowsArea);
		visible.forEach((row, i) => {
			lines.push(this.settingRow(row, this.scroll + i === this.rowIndex, width, labelWidth));
		});
		if (rows.length === 0) {
			lines.push(
				fitWidth(
					theme.fg("muted", ` ${t(this.searching ? "No setting matches." : "Nothing to set here.")}`),
					width,
				),
			);
		}
		// fork: the help text wraps whole; it takes the blank rows under the settings when it
		// needs them, and only a short terminal still cuts it, with « … » on its last line.
		const text = this.helpText(width, rows);
		const used = Math.max(1, visible.length);
		const helpHeight = Math.max(help, Math.min(text.length, help + Math.max(0, rowsArea - used)));
		while (lines.length < header + rowsArea + help - helpHeight) lines.push(" ".repeat(width));
		lines.push(paint(tok(theme, "borderMuted"), "─".repeat(width)));
		const shown = text.slice(0, helpHeight);
		if (text.length > helpHeight) shown[helpHeight - 1] = fitWidth(theme.fg("muted", " …"), width);
		while (shown.length < helpHeight) shown.push(" ".repeat(width));
		for (const l of shown) lines.push(l);

		if (this.popup) {
			const popupWidth = Math.min(width - 2, 72);
			const at = header + this.rowIndex - this.scroll;
			const { lines: box, owners } = this.fitPopup(this.popupLines(popupWidth), body);
			const height = box.length;
			let top = at + 1;
			if (top + height > body) top = Math.max(0, at - height);
			const left = wide ? 2 : 1;
			box.forEach((l, i) => {
				if (top + i < lines.length) lines[top + i] = fitWidth(`${" ".repeat(left)}${l}`, width);
			});
			geometry.popup = { top: 3 + top, left: (wide ? geometry.left + 2 : 1) + left, width: popupWidth, owners };
		}
		return lines.slice(0, body);
	}

	private settingRow(row: Row, selected: boolean, width: number, labelWidth: number): string {
		const { item } = row;
		const focused = selected && this.focus !== "domains";
		const kind = kindOf(item);
		const value =
			kind === "toggle"
				? drawSwitch(isOn(item.currentValue))
				: kind === "choice"
					? `${theme.fg("text", t(item.currentValue))} ${theme.fg("muted", "▾")}`
					: kind === "action" || kind === "submenu"
						? `${theme.fg("text", t(kind === "action" ? item.values![0]! : item.currentValue))} ${theme.fg("muted", "›")}`
						: theme.fg("text", t(item.currentValue));
		// fork: a module that is on but does nothing here says so next to its switch.
		const state = this.model.stateTag?.(item.id);
		const fullTag = this.searching
			? theme.fg("muted", t(row.domain.label))
			: this.model.isAdvancedSetting(item.id)
				? theme.fg("muted", t("advanced"))
				: state
					? theme.fg("warning", state)
					: "";
		// fork: a row too narrow for its label, value and tag cuts the label first, down to 8
		// columns (the help zone shows it whole), then the tag, so the value stays readable.
		const minLabel = Math.min(labelWidth, 8);
		const tagRoom = width - 1 - (minLabel + visibleWidth(value) + 3) - 2;
		const tag =
			visibleWidth(fullTag) <= tagRoom ? fullTag : tagRoom >= 6 ? truncateToWidth(fullTag, tagRoom, "…") : "";
		const fits = width - 1 - (tag ? visibleWidth(tag) + 1 : 0) - visibleWidth(value) - 3;
		const label = fitWidth(
			focused ? theme.bold(theme.fg("text", item.label)) : theme.fg("text", item.label),
			Math.max(minLabel, Math.min(labelWidth, fits)),
		);
		const start = ` ${label} ${value}`;
		const room = width - 1 - visibleWidth(tag) - 1;
		// A cut value keeps a space before the tag ("ask ▾ Permissions & sandbox", not "ask ▾Permissions").
		const content = tag ? `${fitWidth(start, room - 1)} ${tag} ` : `${fitWidth(start, room)} `;
		if (!focused) return ` ${fitWidth(content, width - 1)}`;
		return `${paint(tok(theme, "accent"), "▌")}${onBg(fitWidth(content, width - 1), tok(theme, "selectedBg"), width - 1)}`;
	}

	/** The help zone's text, wrapped to `width`: the focused setting, its description, then what each choice does. */
	private helpText(width: number, rows: Row[]): string[] {
		const text: string[] = [];
		const add = (s: string, indent = "") => {
			wrapTextWithAnsi(s, width - 2 - indent.length).forEach((l, i) => {
				text.push(fitWidth(` ${i === 0 ? "" : indent}${l}`, width));
			});
		};
		const row = this.focus === "domains" && !this.searching ? undefined : rows[this.rowIndex];
		if (!row) {
			if (this.domain && !this.searching) add(theme.fg("thinkingText", t(this.domain.description)));
		} else {
			add(theme.bold(theme.fg("text", row.item.label)));
			if (row.item.description) add(theme.fg("thinkingText", row.item.description));
			if (kindOf(row.item) === "choice" && !this.popup) {
				for (const value of row.item.values ?? []) {
					const what = optionHelp(row.item.id, value);
					if (what) add(`${theme.fg("text", t(value))}${theme.fg("thinkingText", ` : ${what}`)}`, "  ");
				}
			}
		}
		return text;
	}

	/**
	 * choices taller than the column keep their frame and scroll inside it, so the
	 * selected one stays whole in view; `owners` follows the lines drawn, for the mouse.
	 */
	private fitPopup(popup: { lines: string[]; owners: number[] }, body: number): { lines: string[]; owners: number[] } {
		if (popup.lines.length <= body || !this.popup) return popup;
		const room = Math.max(1, body - 2);
		const inner = popup.lines.slice(1, -1);
		const first = popup.owners.indexOf(this.popup.index);
		const last = popup.owners.lastIndexOf(this.popup.index);
		let scroll = this.popup.scroll ?? 0;
		if (last >= scroll + room) scroll = last - room + 1;
		if (first < scroll) scroll = first;
		scroll = Math.max(0, Math.min(scroll, inner.length - room));
		this.popup.scroll = scroll;
		return {
			lines: [popup.lines[0]!, ...inner.slice(scroll, scroll + room), popup.lines.at(-1)!],
			owners: popup.owners.slice(scroll, scroll + room),
		};
	}

	/** The choices' frame, and for each line inside it the choice drawn there. */
	private popupLines(width: number): { lines: string[]; owners: number[] } {
		const popup = this.popup!;
		const values = popup.item.values ?? [];
		const border = (s: string) => paint(line(), s);
		const inner = width - 2;
		// fork: names and what they do wrap instead of being cut; the description keeps at
		// least 16 columns, and a name wider than its column wraps within it.
		const nameWidth = Math.max(6, Math.min(Math.max(...values.map((v) => visibleWidth(t(v)))) + 2, inner - 19));
		const whatWidth = inner - 4 - nameWidth;
		const band = tok(theme, "selectedBg");
		const title = truncateToWidth(popup.item.label, inner - 4, "…");
		const out = [
			`${border("┌─ ")}${theme.fg("muted", title)}${border(` ${"─".repeat(Math.max(0, inner - 3 - visibleWidth(title)))}┐`)}`,
		];
		const owners: number[] = [];
		values.forEach((value, i) => {
			const mark = value === popup.item.currentValue ? "●" : " ";
			const names = wrapTextWithAnsi(t(value), nameWidth - 2);
			const what = wrapTextWithAnsi(optionHelp(popup.item.id, value) ?? "", whatWidth);
			for (let k = 0; k < Math.max(names.length, what.length); k++) {
				const name = fitWidth(theme.fg("text", names[k] ?? ""), nameWidth);
				const row = ` ${theme.fg("text", k === 0 ? mark : " ")} ${name}${theme.fg("thinkingText", what[k] ?? "")}`;
				const body = i === popup.index ? onBg(fitWidth(row, inner), band, inner) : fitWidth(row, inner);
				out.push(`${border("│")}${body}${border("│")}`);
				owners.push(i);
			}
		});
		out.push(border(`└${"─".repeat(inner)}┘`));
		return { lines: out.map((l) => onBg(l, tok(theme, "userMessageBg"), width)), owners };
	}

	private hints(wide: boolean): string {
		if (this.popup) return t("↑↓ choose · Enter pick · Esc back");
		if (this.submenu) return t("↑↓ move · Enter change · Esc back");
		if (this.focus === "search") return t("Type to search · ↓ results · Esc clear");
		if (!wide && this.page === "list" && !this.searching) return t("↑↓ move · Enter open · / search · Esc close");
		if (!wide) return t("↑↓ move · Enter change · ← back · Esc close");
		if (this.focus === "domains") return t("↑↓ move · → or Enter open · / search · Esc or click outside: close");
		return t("↑↓ move · Enter or click: change · ← domains · / search · Esc: close");
	}

	// ── actions ──────────────────────────────────────────────────────────────────────────────

	private change(item: SettingItem, value: string): void {
		const domainId = this.domain?.id;
		item.currentValue = value;
		this.model.onChange(item.id, value);
		if (item.id !== "interface-mode") return;
		// The interface mode adds or removes advanced settings and domains: find the domain again.
		const at = this.domains.findIndex((d) => d.id === domainId);
		this.domainIndex = at === -1 ? 0 : at;
		if (at === -1) this.focus = "domains";
	}

	private activate(row: Row | undefined): void {
		if (!row) return;
		const { item } = row;
		switch (kindOf(item)) {
			case "toggle": {
				const other = item.values!.find((v) => v !== item.currentValue) ?? item.currentValue;
				this.change(item, other);
				break;
			}
			case "choice":
				this.popup = { item, index: Math.max(0, item.values!.indexOf(item.currentValue)) };
				break;
			case "action":
				this.change(item, item.values![0]!);
				break;
			case "submenu":
				this.submenu = {
					item,
					component: item.submenu!(item.currentValue, (selected) => {
						if (selected !== undefined) {
							item.currentValue = selected;
							this.model.onChange(item.id, selected);
						}
						this.submenu = undefined;
					}),
				};
				break;
		}
	}

	private pick(index: number): void {
		const popup = this.popup;
		if (!popup) return;
		const value = popup.item.values?.[index];
		this.popup = undefined;
		if (value !== undefined && value !== popup.item.currentValue) this.change(popup.item, value);
	}

	private selectDomain(index: number): void {
		if (index !== this.domainIndex) {
			this.rowIndex = 0;
			this.scroll = 0;
		}
		this.domainIndex = index;
	}

	private openRows(): void {
		if (this.rows().length === 0) return;
		this.focus = "rows";
		this.page = "domain";
	}

	private startSearch(text = ""): void {
		this.focus = "search";
		this.query += text;
		this.rowIndex = 0;
		this.scroll = 0;
	}

	private clearSearch(): void {
		this.query = "";
		this.focus = "domains";
		this.rowIndex = 0;
		this.scroll = 0;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.submenu) {
			this.submenu.component.handleInput?.(data);
			return;
		}
		if (this.popup) {
			const count = this.popup.item.values?.length ?? 0;
			if (kb.matches(data, "tui.select.up")) this.popup.index = (this.popup.index - 1 + count) % count;
			else if (kb.matches(data, "tui.select.down")) this.popup.index = (this.popup.index + 1) % count;
			else if (kb.matches(data, "tui.select.confirm") || data === " ") this.pick(this.popup.index);
			else if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.editor.cursorLeft"))
				this.popup = undefined;
			return;
		}
		const printable = data.length === 1 && data >= " " && data !== "\x7f";
		if (this.focus === "search") {
			if (kb.matches(data, "tui.select.cancel")) this.clearSearch();
			else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
				this.query = this.query.slice(0, -1);
				this.rowIndex = 0;
			} else if (kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.confirm")) {
				if (this.searching && this.rows().length > 0) this.focus = "rows";
				else if (!this.searching) this.focus = "domains";
			} else if (printable) this.startSearch(data);
			return;
		}
		if (data === "/") {
			this.startSearch();
			return;
		}
		const rows = this.rows();
		const wide = this.geometry?.wide ?? true;
		if (this.focus === "domains" && !this.searching) {
			const count = this.domains.length;
			if (kb.matches(data, "tui.select.up")) this.selectDomain((this.domainIndex - 1 + count) % count);
			else if (kb.matches(data, "tui.select.down")) this.selectDomain((this.domainIndex + 1) % count);
			else if (
				kb.matches(data, "tui.select.confirm") ||
				kb.matches(data, "tui.editor.cursorRight") ||
				kb.matches(data, "tui.input.tab")
			)
				this.openRows();
			else if (kb.matches(data, "tui.select.cancel")) this.options.onClose();
			else if (printable && data !== " ") this.startSearch(data);
			return;
		}
		// The settings column, or the search results.
		const count = rows.length;
		if (kb.matches(data, "tui.select.up") && count > 0) {
			if (this.searching && this.rowIndex === 0) this.focus = "search";
			else this.rowIndex = (this.rowIndex - 1 + count) % count;
		} else if (kb.matches(data, "tui.select.down") && count > 0) this.rowIndex = (this.rowIndex + 1) % count;
		else if (kb.matches(data, "tui.select.confirm") || data === " ") this.activate(rows[this.rowIndex]);
		else if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.input.tab")) {
			if (this.searching) this.focus = "search";
			else {
				this.focus = "domains";
				if (!wide) this.page = "list";
			}
		} else if (kb.matches(data, "tui.select.cancel")) {
			if (this.searching) this.clearSearch();
			else this.options.onClose();
		} else if (printable) this.startSearch(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const g = this.geometry;
		if (!g) return undefined;
		const { x, y } = event;
		if (this.submenu) {
			const inside = y >= 3 && y < 3 + g.body && (!g.wide || x > g.left + 1);
			if (inside) {
				const offsetX = g.wide ? g.left + 3 : 2;
				const result = this.submenu.component.handleMouse?.({
					...event,
					x: x - offsetX,
					y: y - g.submenuTop,
					width: g.submenuWidth,
				});
				return result ? { ...result, focus: true } : { handled: true, focus: true };
			}
			if (event.type === "click" && event.button === "left") this.submenu = undefined;
			else return { handled: true };
		}
		if (event.type === "wheel" && event.wheelDelta) {
			const step = event.wheelDelta < 0 ? -1 : 1;
			if (this.popup) {
				const count = this.popup.item.values?.length ?? 1;
				this.popup.index = Math.max(0, Math.min(count - 1, this.popup.index + step));
			} else if (g.wide && x <= g.left && !this.searching) {
				this.selectDomain(Math.max(0, Math.min(this.domains.length - 1, this.domainIndex + step)));
			} else if (!g.wide && this.page === "list" && !this.searching) {
				this.selectDomain(Math.max(0, Math.min(this.domains.length - 1, this.domainIndex + step)));
			} else {
				this.rowIndex = Math.max(0, Math.min(this.rows().length - 1, this.rowIndex + step));
			}
			return { handled: true, render: true };
		}
		if (event.button !== "left") return { handled: true };
		if (event.type !== "click") return { handled: true, focus: true };

		if (this.popup && g.popup) {
			const p = g.popup;
			const index = p.owners[y - p.top - 1];
			if (x >= p.left && x < p.left + p.width && index !== undefined) this.pick(index);
			else this.popup = undefined;
			return { handled: true, focus: true, render: true };
		}
		if (y === 1) {
			if (x >= g.close && x < g.close + 3) {
				this.options.onClose();
				return { handled: true };
			}
			if (g.toggle !== -1 && x >= g.toggle && x < g.toggle + segmentedWidth()) {
				const item = this.interfaceItem();
				const divider = g.toggle + visibleWidth(t("Simple")) + 3;
				const side = x < divider ? "simple" : x > divider ? "advanced" : undefined;
				if (item && side && side !== item.currentValue) this.change(item, side);
				return { handled: true, focus: true, render: true };
			}
			if (x >= g.field[0] && x < g.field[1]) this.startSearch();
			else if (!g.wide && this.page === "domain" && x < 4) {
				this.page = "list";
				this.focus = "domains";
			}
			return { handled: true, focus: true, render: true };
		}
		const bodyRow = y - 3;
		if (bodyRow < 0 || bodyRow >= g.body) return { handled: true, focus: true };
		const inDomains = g.wide ? x <= g.left : this.page === "list" && !this.searching;
		if (inDomains) {
			const index = g.domainScroll + bodyRow;
			if (bodyRow < g.body - 1 && index < this.domains.length) {
				this.selectDomain(index);
				if (this.searching) this.query = "";
				this.focus = "domains";
				if (!g.wide) this.openRows();
			}
			return { handled: true, focus: true, render: true };
		}
		const index = this.scroll + (y - g.rowsTop);
		const rows = this.rows();
		if (y >= g.rowsTop && y < g.rowsTop + g.rowsArea && index < rows.length) {
			this.rowIndex = index;
			this.focus = "rows";
			this.activate(rows[index]);
		}
		return { handled: true, focus: true, render: true };
	}
}

/** Drops a menu's trailing key hint (the window draws its own) and the blank lines above it. */
function dropHint(lines: string[]): string[] {
	const out = [...lines];
	// In English or French (fork/i18n/fr.ts).
	if (out.length && /Esc to |Échap pour /.test(out[out.length - 1]!)) out.pop();
	while (out.length && plain(out[out.length - 1]!).trim() === "") out.pop();
	return out;
}

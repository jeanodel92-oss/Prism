/**
 * fork: `/settings` > Appearance > Customize theme.
 * It edits a copy of the active theme: nine core roles, with the full palette behind Advanced. The field shows the change
 * across the whole interface as it is typed, and Enter saves the copy as JSON in the agent's `themes/` folder,
 * then makes it the theme in use. A theme already in that folder is edited in place.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	backgroundAnsi,
	type Color,
	type Component,
	colorToHex,
	getKeybindings,
	Input,
	parseColor,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getCustomThemesDir } from "../config.ts";
import {
	getAvailableThemesWithPaths,
	getThemeByName,
	loadThemeFromPath,
	parseAutoThemeSetting,
	SYSTEM_THEME_NAME,
	type Theme,
	theme,
} from "../modes/interactive/theme/theme.ts";
import { fill, t } from "./i18n/index.ts";
import {
	type CoreColors,
	coreColors,
	deriveTheme,
	THEME_ROLES,
	type ThemeRole,
	themeTextContrast,
} from "./theme-roles.ts";

type ThemeValue = string | number;

/** A theme file as the editor changes it. */
export interface EditableTheme {
	$schema?: string;
	name: string;
	appearance?: "dark" | "light";
	vars?: Record<string, ThemeValue>;
	colors: Record<string, ThemeValue>;
	export?: Record<string, ThemeValue>;
}

/** The copy being edited: its name, where it is saved, and whether that file exists yet. */
export interface ThemeCopy {
	/** The theme it was copied from. */
	source: string;
	name: string;
	path: string;
	json: EditableTheme;
	saved: boolean;
}

/** What the editor asks of the interactive mode. */
export interface ThemeEditorHost {
	/** The theme setting in effect, such as `prism-light/prism`. */
	setting(): string;
	/** Shows `theme` across the interface without saving anything. */
	preview(theme: Theme): void;
	/** Saves a theme setting and applies it. */
	apply(setting: string): void;
	/** Drops a preview: shows the theme of the setting in effect again, read from its file. */
	restore(): void;
}

const readJson = (path: string): EditableTheme => JSON.parse(readFileSync(path, "utf8")) as EditableTheme;

/**
 * The copy of theme `active` to edit. A theme of the custom folder is edited in place; any other is copied under
 * the first free `<name>-custom` name, and the system theme, which has no file, as its current colours.
 */
export function themeCopy(active: string, customDir = getCustomThemesDir()): ThemeCopy {
	const themes = getAvailableThemesWithPaths();
	const info = themes.find((entry) => entry.name === active);
	if (info?.path && resolve(dirname(info.path)) === resolve(customDir) && existsSync(info.path)) {
		return { source: active, name: active, path: info.path, json: readJson(info.path), saved: true };
	}
	let json: EditableTheme;
	if (info?.path && existsSync(info.path)) json = readJson(info.path);
	else {
		const current = getThemeByName(active) ?? getThemeByName(SYSTEM_THEME_NAME)!;
		json = {
			name: active,
			appearance: current.appearance,
			colors: Object.fromEntries(Object.entries(current.colors).map(([token, color]) => [token, colorToHex(color)])),
		};
	}
	const name = freeCopyName(active, customDir);
	return { source: active, name, path: join(customDir, `${name}.json`), json: { ...json, name }, saved: false };
}

/** A name for a copy of `active` that no theme and no file in `customDir` has. */
function freeCopyName(active: string, customDir: string): string {
	const taken = new Set(getAvailableThemesWithPaths().map((entry) => entry.name));
	let name = `${active}-custom`;
	for (let n = 2; taken.has(name) || existsSync(join(customDir, `${name}.json`)); n++) name = `${active}-custom-${n}`;
	return name;
}

/** The theme `json` describes; throws, saying why, when a value is not a colour or names no palette entry. */
export function themeFromJson(json: EditableTheme): Theme {
	const dir = mkdtempSync(join(tmpdir(), "prism-theme-"));
	try {
		const file = join(dir, `${json.name}.json`);
		writeFileSync(file, JSON.stringify(json));
		return loadThemeFromPath(file);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The theme setting once `name` replaces `active`: an automatic setting (`light/dark`) keeps following the terminal,
 * with the copy in place of the side that was active.
 */
export function settingWith(setting: string, active: string, name: string): string {
	const auto = parseAutoThemeSetting(setting);
	if (!auto) return name;
	const swap = (side: string) => (side === active ? name : side);
	return `${swap(auto.lightTheme)}/${swap(auto.darkTheme)}`;
}

/** What a typed value stands for: a palette name, a 256-colour index, or the text as given. */
function parseValue(text: string, vars: Record<string, ThemeValue> | undefined): ThemeValue {
	const trimmed = text.trim();
	if (/^\d{1,3}$/.test(trimmed) && Number(trimmed) <= 255) return Number(trimmed);
	if (vars && trimmed in vars) return trimmed;
	return trimmed;
}

/** The colour a value ends up as, following palette names; undefined for the terminal's own colour. */
function resolveColor(value: ThemeValue, vars: Record<string, ThemeValue> = {}, depth = 0): Color | undefined {
	if (value === "" || depth > 8) return undefined;
	if (typeof value === "string" && value in vars) return resolveColor(vars[value]!, vars, depth + 1);
	try {
		return parseColor(value);
	} catch {
		return undefined;
	}
}

/** What a colour token is used for, shown under the list. */
function tokenHelp(token: string): string {
	const known: Record<string, string> = {
		accent: "Highlights: the selected item, the cursor, titles.",
		text: "The main text.",
		thinkingText: "Secondary text, and the model's thinking.",
		muted: "Labels and hints.",
		dim: "The faintest text.",
		border: "Lines and borders.",
		borderAccent: "Strong lines.",
		borderMuted: "Faint lines.",
		success: "Success: a tool that worked, added lines.",
		error: "Errors and removed lines.",
		warning: "Warnings.",
		selectedBg: "The background of the selected row.",
		userMessageBg: "The background of your messages and the input.",
	};
	if (known[token]) return known[token];
	if (token.startsWith("md")) return "Markdown in replies.";
	if (token.startsWith("syntax")) return "Code highlighting.";
	if (token.startsWith("tool")) return "Tool calls and their output.";
	if (token.startsWith("thinking")) return "The thinking level's colour.";
	return "A colour of the interface.";
}

/** Rows shown at once in the list. */
const VISIBLE = 10;

export interface ThemeEditorOptions {
	host: ThemeEditorHost;
	/** The name of the theme in use, copied when nothing of it is saved yet. */
	active: string;
	requestRender(): void;
	done(): void;
	customDir?: string;
}

interface Row {
	kind: "vars" | "colors" | "core" | "advanced";
	key: string;
	label?: string;
}

export class ThemeEditor implements Component {
	private readonly options: ThemeEditorOptions;
	private readonly copy: ThemeCopy;
	private base: Theme;
	private baseJson: EditableTheme;
	private cores: CoreColors;
	private advanced = false;
	private index = 0;
	private input?: Input;
	private message?: { text: string; kind: "warning" | "error" | "success" };

	constructor(options: ThemeEditorOptions) {
		this.options = options;
		this.copy = themeCopy(options.active, options.customDir);
		this.base = themeFromJson(this.copy.json);
		this.baseJson = this.copy.json;
		this.cores = coreColors(this.base);
	}

	get name(): string {
		return this.copy.name;
	}

	private rows(): Row[] {
		if (!this.advanced)
			return [
				...THEME_ROLES.map(({ key, label }) => ({ kind: "core" as const, key, label })),
				{ kind: "advanced", key: "Advanced", label: "Advanced" },
			];
		const json = this.copy.json;
		return [
			...Object.keys(json.vars ?? {}).map((key) => ({ kind: "vars" as const, key })),
			...Object.keys(json.colors).map((key) => ({ kind: "colors" as const, key })),
		];
	}

	private valueOf(row: Row): ThemeValue {
		if (row.kind === "core") return this.cores[row.key as ThemeRole];
		return (row.kind === "vars" ? this.copy.json.vars?.[row.key] : this.copy.json.colors[row.key]) ?? "";
	}

	invalidate(): void {}

	render(width: number): string[] {
		const out: string[] = [];
		const add = (line: string) => out.push(truncateToWidth(line, width, ""));
		const wrap = (text: string) => {
			for (const line of wrapTextWithAnsi(text, Math.max(1, width))) add(line);
		};
		add(theme.bold(theme.fg("accent", t("Customize theme"))));
		wrap(
			theme.fg(
				"muted",
				this.copy.saved
					? fill("Editing {0}, saved in themes/{1}.json.", this.copy.name, this.copy.name)
					: fill("A copy of {0}, saved as themes/{1}.json at the first change.", this.copy.source, this.copy.name),
			),
		);
		add("");
		const rows = this.rows();
		const start = Math.max(0, Math.min(this.index - Math.floor(VISIBLE / 2), rows.length - VISIBLE));
		const vars = this.copy.json.vars;
		const keyWidth = Math.min(22, Math.max(...rows.map((row) => row.key.length)) + 2);
		for (let i = start; i < Math.min(rows.length, start + VISIBLE); i++) {
			const row = rows[i]!;
			const selected = i === this.index;
			if (row.kind === "advanced") {
				add(`${selected ? theme.fg("accent", "→ ") : "  "}${theme.fg("muted", t("Advanced"))} ›`);
				continue;
			}
			if (i === start || rows[i - 1]!.kind !== row.kind) {
				add(theme.fg("muted", t(row.kind === "vars" ? "Palette" : "Colours")));
			}
			const value = this.valueOf(row);
			const color = resolveColor(value, vars);
			const swatch = color ? `${backgroundAnsi(color, theme.getColorMode())}  \x1b[49m` : "  ";
			const shown =
				value === ""
					? t("terminal's own")
					: typeof value === "string" && vars && value in vars
						? `→ ${value}`
						: String(value);
			const key = truncateToWidth(t(row.label ?? row.key), keyWidth - 1, "…");
			const label = selected ? theme.bold(theme.fg("text", key)) : theme.fg("text", key);
			add(
				`${selected ? theme.fg("accent", "→ ") : "  "}${label}${" ".repeat(Math.max(1, keyWidth - visibleWidth(key)))}${swatch} ${theme.fg("muted", shown)}`,
			);
		}
		if (rows.length > VISIBLE) add(theme.fg("dim", `  ${this.index + 1}/${rows.length}`));
		add("");
		const row = rows[this.index];
		if (this.input && row) {
			wrap(
				theme.fg(
					"text",
					fill(
						"New value for {0}: a colour such as #3a7bd5, a palette name, or empty for the terminal's own.",
						t(row.label ?? row.key),
					),
				),
			);
			for (const line of this.input.render(width)) add(line);
		}
		if (this.message) wrap(theme.fg(this.message.kind, this.message.text));
		else if (row && !this.input) {
			wrap(
				theme.fg(
					"thinkingText",
					row.kind === "core"
						? t(
								"Changing a core colour carries to the colours that follow it, keeping the original lightness steps. Advanced edits individual tokens.",
							)
						: row.kind === "advanced"
							? t("Edit every palette entry and token individually. Escape returns to core colours.")
							: row.kind === "vars"
								? t("A palette entry: every colour that names it changes with it.")
								: t(tokenHelp(row.key)),
				),
			);
		}
		add("");
		add(theme.fg("muted", t("Preview")));
		for (const line of this.preview(width - 2)) add(`  ${line}`);
		return out;
	}

	/** A few lines in the main colours; the whole interface shows the theme being edited too. */
	private preview(width: number): string[] {
		const pad = (text: string) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
		return [
			`${theme.fg("text", t("Text"))}  ${theme.fg("thinkingText", t("Secondary"))}  ${theme.fg("muted", t("Muted"))}  ${theme.fg("accent", t("Accent"))}`,
			`${theme.fg("success", `✓ ${t("done")}`)}  ${theme.fg("error", `✗ ${t("failed")}`)}  ${theme.fg("warning", `! ${t("warning")}`)}`,
			theme.bg("userMessageBg", pad(theme.fg("userMessageText", ` ${t("Your message")}`))),
			theme.bg("selectedBg", pad(theme.fg("text", ` → ${t("Selected row")}`))),
			`${theme.fg("mdHeading", `# ${t("Heading")}`)}  ${theme.fg("mdCode", "`code`")}  ${theme.fg("mdLink", t("link"))}`,
		];
	}

	handleInput(data: string): void {
		if (this.input) {
			const input = this.input;
			input.handleInput(data);
			// Still typing: the value shows across the interface once it is a colour.
			if (this.input === input && !getKeybindings().matches(data, "tui.select.confirm"))
				this.previewTyped(input.getValue());
			return;
		}
		const kb = getKeybindings();
		const count = this.rows().length;
		if (kb.matches(data, "tui.select.up")) this.move((this.index - 1 + count) % count);
		else if (kb.matches(data, "tui.select.down")) this.move((this.index + 1) % count);
		else if (kb.matches(data, "tui.select.pageUp")) this.move(Math.max(0, this.index - VISIBLE));
		else if (kb.matches(data, "tui.select.pageDown")) this.move(Math.min(count - 1, this.index + VISIBLE));
		else if (kb.matches(data, "tui.select.confirm")) this.edit();
		else if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.editor.cursorLeft")) this.close();
	}

	private move(index: number): void {
		this.index = index;
		this.message = undefined;
	}

	private edit(): void {
		const row = this.rows()[this.index];
		if (!row) return;
		if (row.kind === "advanced") {
			this.advanced = true;
			this.index = 0;
			return;
		}
		const input = new Input();
		input.focused = true;
		// Typed in rather than set, so the cursor ends after it.
		input.handleInput(String(this.valueOf(row)));
		// Esc goes back to the saved colours.
		input.onEscape = () => {
			this.input = undefined;
			this.message = undefined;
			this.options.host.preview(themeFromJson(this.copy.json));
			this.options.requestRender();
		};
		input.onSubmit = (text) => this.save(row, parseValue(text, this.copy.json.vars));
		this.input = input;
		this.message = undefined;
	}

	private previewTyped(text: string): void {
		const row = this.rows()[this.index];
		if (!row) return;
		try {
			const next = themeFromJson(this.withValue(row, parseValue(text, this.copy.json.vars)));
			// low contrast warns, it no longer refuses.
			const contrast = row.kind === "core" ? themeTextContrast(next) : undefined;
			this.options.host.preview(next);
			this.message =
				contrast && contrast.ratio < 4.5
					? {
							text: fill(
								"Low contrast: {0}:1 for {1} on {2} (minimum 4.5:1).",
								contrast.ratio.toFixed(2),
								contrast.token,
								contrast.background,
							),
							kind: "warning",
						}
					: undefined;
		} catch {
			this.message = { text: t("Not a colour yet."), kind: "warning" };
		}
		this.options.requestRender();
	}

	private withValue(row: Row, value: ThemeValue): EditableTheme {
		const json = this.copy.json;
		if (row.kind === "core") {
			const color = resolveColor(value, json.vars);
			if (!color) throw new Error(t("Core colours need a concrete colour."));
			const key = row.key as ThemeRole;
			const hex = colorToHex(color);
			return hex === this.cores[key] ? json : deriveTheme(this.baseJson, this.base, { ...this.cores, [key]: hex });
		}
		return row.kind === "vars"
			? { ...json, vars: { ...json.vars, [row.key]: value } }
			: { ...json, colors: { ...json.colors, [row.key]: value } };
	}

	private save(row: Row, value: ThemeValue): void {
		let next: EditableTheme;
		let nextTheme: Theme;
		let contrast: ReturnType<typeof themeTextContrast>;
		try {
			next = this.withValue(row, value);
			nextTheme = themeFromJson(next);
			contrast = themeTextContrast(nextTheme);
		} catch (error) {
			this.message = { text: error instanceof Error ? error.message : String(error), kind: "warning" };
			this.options.requestRender();
			return;
		}
		try {
			mkdirSync(dirname(this.copy.path), { recursive: true });
			// fork: the first save creates the copy only if its name is still free; another
			// session that took it meanwhile keeps its file, and this copy takes the next free name.
			for (;;) {
				try {
					writeFileSync(this.copy.path, `${JSON.stringify(next, null, "\t")}\n`, {
						flag: this.copy.saved ? "w" : "wx",
					});
					break;
				} catch (error) {
					if (this.copy.saved || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const customDir = dirname(this.copy.path);
					this.copy.name = freeCopyName(this.copy.source, customDir);
					this.copy.path = join(customDir, `${this.copy.name}.json`);
					next = { ...next, name: this.copy.name };
					nextTheme = themeFromJson(next);
				}
			}
		} catch (error) {
			this.message = { text: error instanceof Error ? error.message : String(error), kind: "error" };
			this.options.requestRender();
			return;
		}
		const first = !this.copy.saved;
		this.copy.json = next;
		if (row.kind !== "core") {
			this.base = nextTheme;
			this.baseJson = next;
		}
		this.cores = coreColors(nextTheme);
		this.copy.saved = true;
		this.input = undefined;
		const host = this.options.host;
		if (first) host.apply(settingWith(host.setting(), this.copy.source, this.copy.name));
		else host.restore();
		this.message =
			contrast.ratio < 4.5
				? {
						text: fill(
							"Saved with low contrast: {0}:1 for {1} on {2} (minimum 4.5:1).",
							contrast.ratio.toFixed(2),
							contrast.token,
							contrast.background,
						),
						kind: "warning",
					}
				: { text: fill("Saved in themes/{0}.json.", this.copy.name), kind: "success" };
		this.options.requestRender();
	}

	private close(): void {
		if (this.advanced) {
			this.advanced = false;
			this.index = THEME_ROLES.length;
			this.message = undefined;
			return;
		}
		// Drops a preview left by a field closed some other way, and shows the saved theme.
		this.options.host.restore();
		this.options.done();
	}
}

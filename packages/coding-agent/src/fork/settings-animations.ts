/**
 * fork: `/settings` > Appearance > Animations:
 * the global switch, styles per category and global presets, then a live preview of the focused animation
 * drawn by the same code as the real one. Each change is saved at once and shows within a second.
 */
import {
	type Component,
	getKeybindings,
	type SettingItem,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../modes/interactive/theme/theme.ts";
import { indicator } from "./animation-frames.ts";
import {
	ANIMATION_PRESETS,
	ANIMATION_STYLES,
	ANIMATIONS,
	type AnimationId,
	type AnimationStyle,
	type AnimationStyles,
	animationOn,
	animationPreset,
	animationStyle,
	readAnimationStyles,
	STYLE_LABELS,
} from "./animations.ts";
import { fill, t } from "./i18n/index.ts";
import { menuPreview, OPEN_MS } from "./prism/dialogs.ts";
import { workingLine } from "./prism/editor.ts";
import { INTRO_MS, logoFor, logoFrame } from "./prism/header.ts";
import { createState } from "./prism/lib/state.ts";
import { FRAMES } from "./prism/title.ts";
import { stateMark, thinking } from "./prism/transcript.ts";
import { SETTING_DESCRIPTIONS } from "./settings-descriptions.ts";

/** What the menu reads and saves. */
export interface AnimationsMenuOptions {
	enabled: boolean;
	off: readonly string[];
	styles?: AnimationStyles;
	onStylesChange?: (styles: AnimationStyles) => void;
	onEnabledChange: (enabled: boolean) => void;
	onOffChange: (ids: string[]) => void;
	requestRender: () => void;
	/** Closes the menu with the global switch's value. */
	done: (value: "on" | "off") => void;
}

/** How often the preview is drawn again. */
const FRAME_MS = 40;
/** The preview stops when the menu has not been drawn for this long (closed some other way). */
const IDLE_MS = 1000;

/** The focused animation at `now`, moving when `on`, still otherwise: a few lines at most. */
export function animationPreview(
	id: AnimationId,
	on: boolean,
	now: number,
	width: number,
	style: AnimationStyle = "default",
): string[] {
	return previewFrame(id, on && style !== "off", now, width, style).map((line) => truncateToWidth(line, width, ""));
}

function previewFrame(id: AnimationId, on: boolean, now: number, width: number, style: AnimationStyle): string[] {
	switch (id) {
		case "intro":
			// The intro of the logo this width shows, then the finished logo for a while before it starts again.
			return logoFrame(theme, logoFor(width), on ? now % (INTRO_MS * 3) : INTRO_MS, style);
		case "working": {
			const [spinner, text] = workingLine(theme, t("Working"), now, on, style);
			return [`${spinner} ${text}`];
		}
		case "thinking":
			return thinking(
				theme,
				true,
				[t("Thinking…")],
				true,
				{ ...createState(), animates: () => on, animationStyle: () => style },
				now,
			);
		case "tools":
			return [
				`${stateMark(theme, { isPartial: true, isError: false }, true, on, style, now)} ${theme.fg("text", "bash")}`,
			];
		case "menus":
			return menuPreview(
				theme,
				[`→ ${t("Example")}`, `  ${t("Another choice")}`],
				Math.min(width, 30),
				on ? now % (OPEN_MS * 4) : OPEN_MS,
				style,
			);
		case "title": {
			const spinner = on
				? `${style === "dots" ? indicator(style, now) : FRAMES[Math.floor(now / 160) % FRAMES.length]} `
				: "";
			return [theme.fg("text", `${spinner}Prism - ${t("project")}`)];
		}
	}
}

export class AnimationsMenu implements Component {
	private readonly options: AnimationsMenuOptions;
	private enabled: boolean;
	private readonly off: Set<string>;
	private styles: AnimationStyles;
	/** 0 is the global switch, then ANIMATIONS in order. */
	private index = 0;
	private timer?: ReturnType<typeof setInterval>;
	private drawnAt = 0;

	constructor(options: AnimationsMenuOptions) {
		this.options = options;
		this.enabled = options.enabled;
		this.off = new Set(options.off);
		this.styles = readAnimationStyles(options.styles);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	render(width: number): string[] {
		this.drawnAt = Date.now();
		this.timer ??= setInterval(() => {
			if (Date.now() - this.drawnAt > IDLE_MS) this.dispose();
			else this.options.requestRender();
		}, FRAME_MS);
		const out: string[] = [];
		const add = (line: string) => out.push(truncateToWidth(line, width, ""));
		const wrap = (text: string) => {
			for (const line of wrapTextWithAnsi(text, Math.max(1, width))) add(line);
		};
		add(theme.bold(theme.fg("accent", t("Animations"))));
		wrap(theme.fg("muted", t("Choose a style per category, or apply a preset to all.")));
		add("");
		const rows = [
			{ label: t("All animations"), value: t(this.enabled ? "on" : "off"), on: this.enabled },
			...ANIMATIONS.map(({ id, label }) => {
				const style = this.off.has(id) ? "off" : animationStyle(this.styles, id);
				return {
					label: t(label),
					value: t(style === "off" ? "off" : !this.enabled ? "off (all)" : STYLE_LABELS[style]),
					on: this.enabled && style !== "off",
				};
			}),
			{ label: t("Animation preset"), value: t(this.preset() ?? "Custom"), on: this.enabled },
		];
		const labelWidth = Math.min(24, Math.max(...rows.map((row) => visibleWidth(row.label))) + 2);
		rows.forEach((row, i) => {
			const selected = i === this.index;
			const label = selected ? theme.bold(theme.fg("text", row.label)) : theme.fg("text", row.label);
			const cell = truncateToWidth(label, labelWidth - 1, "…");
			add(
				`${selected ? theme.fg("accent", "→ ") : "  "}${cell}${" ".repeat(Math.max(1, labelWidth - visibleWidth(cell)))}${theme.fg(row.on ? "accent" : "muted", row.value)}`,
			);
			if (i === 0) add("");
		});
		add("");
		const focused = ANIMATIONS[this.index - 1];
		const id = focused?.id ?? "working";
		const on = animationOn(
			{ animations: this.enabled, animationsOff: [...this.off], animationStyles: this.styles },
			id,
		);
		add(theme.fg("muted", t(focused ? "Preview" : "Preview: the working line")));
		for (const line of animationPreview(id, on, Date.now(), width - 2, animationStyle(this.styles, id)))
			add(`  ${line}`);
		add("");
		wrap(
			theme.fg(
				"thinkingText",
				focused
					? t(focused.description)
					: t("Turns every animation on or off. Off, nothing moves and each animation shows its last frame."),
			),
		);
		if (focused?.id === "intro") wrap(theme.fg("dim", t("Takes effect at the next start.")));
		if (focused) wrap(theme.fg("dim", t("Enter: next style.")));
		if (focused)
			wrap(
				theme.fg(
					"muted",
					fill("Styles: {0}.", ANIMATION_STYLES[focused.id].map((style) => t(STYLE_LABELS[style])).join(", ")),
				),
			);
		if (this.index === ANIMATIONS.length + 1)
			wrap(
				theme.fg("thinkingText", t("Enter applies the next preset to every category: Default, Calm, Lively, off.")),
			);
		return out;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const count = ANIMATIONS.length + 2;
		if (kb.matches(data, "tui.select.up")) this.index = (this.index - 1 + count) % count;
		else if (kb.matches(data, "tui.select.down")) this.index = (this.index + 1) % count;
		else if (kb.matches(data, "tui.select.confirm") || data === " ") this.toggle();
		else if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.editor.cursorLeft")) {
			this.dispose();
			this.options.done(this.enabled ? "on" : "off");
		}
	}

	private toggle(): void {
		if (this.index === 0) {
			this.enabled = !this.enabled;
			this.options.onEnabledChange(this.enabled);
			return;
		}
		if (this.index === ANIMATIONS.length + 1) {
			const current = this.preset() ?? "off";
			const next = ANIMATION_PRESETS[(ANIMATION_PRESETS.indexOf(current) + 1) % ANIMATION_PRESETS.length]!;
			this.styles = animationPreset(next);
			this.enabled = next !== "off";
			this.off.clear();
			this.options.onEnabledChange(this.enabled);
			this.options.onOffChange([]);
			this.options.onStylesChange?.({ ...this.styles });
			return;
		}
		// Each switch keeps its own state under the global one.
		const { id } = ANIMATIONS[this.index - 1]!;
		const choices: readonly AnimationStyle[] = ANIMATION_STYLES[id];
		const current = this.off.has(id) ? "off" : animationStyle(this.styles, id);
		const next = choices[(choices.indexOf(current) + 1) % choices.length]!;
		this.styles[id] = next;
		if (next === "off") this.off.add(id);
		else this.off.delete(id);
		this.options.onOffChange(ANIMATIONS.flatMap((entry) => (this.off.has(entry.id) ? [entry.id] : [])));
		this.options.onStylesChange?.({ ...this.styles });
	}

	private preset(): (typeof ANIMATION_PRESETS)[number] | undefined {
		if (!this.enabled) return "off";
		return ANIMATION_PRESETS.find((preset) => {
			const styles = animationPreset(preset);
			return ANIMATIONS.every(({ id }) => !this.off.has(id) && animationStyle(this.styles, id) === styles[id]);
		});
	}
}

/** The Animations row of Appearance: its value is the global switch, Enter opens the menu. */
export function animationsSetting(options: Omit<AnimationsMenuOptions, "done">): SettingItem {
	// The menu changes what is off; the row reads it again when drawn.
	let off = options.off;
	let enabled = options.enabled;
	let styles = options.styles;
	const item: SettingItem = {
		id: "animations",
		label: "Animations",
		description: "",
		currentValue: enabled ? "on" : "off",
		submenu: (_value, done) =>
			new AnimationsMenu({
				...options,
				enabled,
				off,
				styles,
				onStylesChange: (value) => {
					styles = value;
					options.onStylesChange?.(value);
				},
				onEnabledChange: (value) => {
					enabled = value;
					options.onEnabledChange(value);
				},
				onOffChange: (ids) => {
					off = ids;
					options.onOffChange(ids);
				},
				done,
			}),
	};
	// fork: both parts are translated when read, as for the compaction threshold.
	Object.defineProperty(item, "description", {
		get: () => {
			const turnedOff = ANIMATIONS.filter(({ id }) => off.includes(id)).map(({ label }) => t(label));
			const base = t(SETTING_DESCRIPTIONS.animations!);
			return enabled && turnedOff.length > 0 ? `${base} ${t(`Turned off: ${turnedOff.join(", ")}.`)}` : base;
		},
		enumerable: true,
	});
	return item;
}

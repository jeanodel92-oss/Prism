// fork: a theme only colours text and a few panels; the page background is the
// terminal's own. A light theme in a dark terminal (or the reverse) therefore kept the
// terminal's background, and every colour made for the other background went dark or faint
//. When the active theme's appearance does
// not match the terminal, Prism sets the terminal's default background and foreground to the
// theme's for the session (OSC 11 and OSC 10), and restores them (OSC 111 and OSC 110) as soon
// as the theme matches the terminal again, and on exit. option A.
import { colorToHex, colorToRgb, parseColor, type RgbColor, type TerminalColors } from "@earendil-works/pi-tui";
import { detectTerminalTheme } from "../modes/interactive/theme/theme.ts";

export interface BackdropTheme {
	appearance: "light" | "dark";
	/** The theme's text colour, as a colour string. */
	text: string;
	/** The theme's page background (`export.pageBg`), when it declares one. */
	pageBg?: string;
}

const FALLBACK = {
	light: { background: "#ffffff", foreground: "#000000" },
	dark: { background: "#000000", foreground: "#e5e5e7" },
};

const RESTORE = "\x1b]110\x07\x1b]111\x07";

function luminance({ r, g, b }: RgbColor): number {
	const channel = (value: number) => {
		const v = value / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: RgbColor, b: RgbColor): number {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}

function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	return !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b;
}

const osc = (code: number, { r, g, b }: RgbColor) => {
	const hex = (value: number) => value.toString(16).padStart(2, "0");
	return `\x1b]${code};rgb:${hex(r)}/${hex(g)}/${hex(b)}\x07`;
};

/** Background and foreground to give the terminal for `theme`. */
export function backdropColors(theme: BackdropTheme): { background: RgbColor; foreground: RgbColor } {
	const fallback = FALLBACK[theme.appearance];
	const toRgb = (value: string | undefined, otherwise: string) => {
		try {
			return colorToRgb(parseColor(value ?? otherwise));
		} catch {
			return colorToRgb(parseColor(otherwise));
		}
	};
	const background = toRgb(theme.pageBg, fallback.background);
	let foreground = toRgb(theme.text, fallback.foreground);
	// A theme whose text follows the terminal's default has no usable colour of its own here.
	if (contrast(foreground, background) < 3) foreground = toRgb(fallback.foreground, fallback.foreground);
	return { background, foreground };
}

export class TerminalBackdrop {
	private readonly write: (data: string) => void;
	private active?: { background: RgbColor; foreground: RgbColor };
	/** The terminal's own colours, as reported before Prism changed them. */
	private original?: TerminalColors;
	private exitHook?: () => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	/**
	 * A report taken while the backdrop is on describes Prism's colours: answer with the
	 * terminal's own, so light/dark detection keeps seeing the real terminal.
	 */
	unmask(reported: TerminalColors): TerminalColors {
		if (!this.active || !this.original || !sameRgb(reported.background, this.active.background)) return reported;
		return { ...reported, background: this.original.background, foreground: this.original.foreground };
	}

	/** Sets or restores the terminal colours for `theme`, given the terminal's own colours. */
	sync(theme: BackdropTheme, terminal: TerminalColors | undefined): void {
		// Unknown background: nothing to compare with, leave the terminal alone.
		const terminalAppearance = terminal?.background ? detectTerminalTheme(terminal) : undefined;
		if (!terminalAppearance || terminalAppearance === theme.appearance) {
			this.restore();
			return;
		}
		const colors = backdropColors(theme);
		if (this.active && sameRgb(colors.background, this.active.background)) {
			if (sameRgb(colors.foreground, this.active.foreground)) return;
		}
		this.original ??= terminal;
		this.active = colors;
		this.write(osc(11, colors.background) + osc(10, colors.foreground));
		if (!this.exitHook) {
			this.exitHook = () => this.restore();
			process.once("exit", this.exitHook);
		}
	}

	/** Gives the terminal its own colours back. */
	restore(): void {
		if (!this.active) return;
		this.active = undefined;
		this.original = undefined;
		this.write(RESTORE);
		if (this.exitHook) {
			process.removeListener("exit", this.exitHook);
			this.exitHook = undefined;
		}
	}
}

/** The theme fields the backdrop needs, as hex strings. */
export function backdropTheme(appearance: "light" | "dark", text: Parameters<typeof colorToHex>[0], pageBg?: string) {
	return { appearance, text: colorToHex(text), pageBg } satisfies BackdropTheme;
}

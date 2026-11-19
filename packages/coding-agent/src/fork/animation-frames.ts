/** Fork appearance styles: pure frames, driven only by existing renderers and timers. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import type { AnimationStyle } from "./animations.ts";
import { mix, paint, tok } from "./prism/lib/palette.ts";

/** Discrete indicators advance at most every 160 ms, including when streaming redraws faster. */
export function indicator(style: AnimationStyle, now: number): string {
	const frame = Math.floor(now / 160);
	if (style === "dots") return [".  ", ".. ", "..."][frame % 3]!;
	if (style === "spinner") return ["|", "/", "-", "\\"][frame % 4]!;
	return ["▁", "▃", "▆", "█", "▆", "▃"][frame % 6]!;
}

export function pulseLabel(theme: Theme, label: string, now: number): string {
	const phase = (1 - Math.cos(((Math.floor(now / 160) * 160) / 1600) * 2 * Math.PI)) / 2;
	return paint(mix(tok(theme, "muted"), tok(theme, "text"), phase), label);
}

/** Reveal rows or slide their contents within their existing width; p=1 is byte-identical. */
export function reveal(lines: readonly string[], p: number, style: AnimationStyle): string[] {
	if (p >= 1) return [...lines];
	const progress = Math.max(0, p);
	if (style === "wipe") return lines.slice(0, Math.max(1, Math.ceil(lines.length * progress)));
	return lines.map((line) => {
		const width = visibleWidth(line);
		const shift = Math.ceil((1 - progress) * Math.min(8, width));
		return " ".repeat(shift) + truncateToWidth(line, Math.max(0, width - shift), "");
	});
}

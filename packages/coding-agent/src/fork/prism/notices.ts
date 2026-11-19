// fork: warnings and errors of the transcript as callouts (a coloured bar on every
// wrapped line, over a faint tint of the same colour), and the startup listing of loaded
// resources as one summary line ("1 skill · 2 extensions · ctrl+o for details").
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/index.ts";
import { t } from "../i18n/index.ts";
import type { RenderHooks } from "../render-hooks.ts";
import { onBg, paint, tok } from "./lib/palette.ts";
import type { PrismState } from "./lib/state.ts";

const NOUNS: Record<string, [string, string]> = {
	Context: ["context file", "context files"],
	Skills: ["skill", "skills"],
	Prompts: ["prompt", "prompts"],
	Extensions: ["extension", "extensions"],
};

export function noticeHooks(state: PrismState): Pick<RenderHooks, "notice" | "loadedSummary"> {
	return {
		notice: (kind, message, width) => {
			const theme = state.theme;
			if (!theme || width < 16) return undefined;
			// the bar and the label in the role's tint, the text in ink 2, on the surface.
			const color = tok(theme, kind);
			const bg = tok(theme, "userMessageBg");
			const label = t(kind === "warning" ? "Warning" : "Error");
			const room = width - 4;
			const text = `${paint(color, label, { bold: true })} ${theme.fg("thinkingText", t(message).split("\n").map(t).join("\n"))}`;
			return wrapTextWithAnsi(text, room).map((line) => ` ${onBg(`${paint(color, "▌")} ${line}`, bg, width - 2)}`);
		},
		loadedSummary: (sections, width) => {
			const theme = state.theme;
			if (!theme) return undefined;
			const parts = sections
				.filter(({ count }) => count > 0)
				.map(({ name, count }) => {
					const [one, many] = NOUNS[name] ?? [name.toLowerCase(), name.toLowerCase()];
					return `${theme.fg("text", String(count))} ${theme.fg("muted", t(count === 1 ? one : many))}`;
				});
			if (parts.length === 0) return undefined;
			const dot = theme.fg("dim", " · ");
			const text = `${parts.join(dot)}${dot}${theme.fg("dim", `${keyText("app.tools.expand")} ${t("for details")}`)}`;
			return wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => ` ${line}`);
		},
	};
}

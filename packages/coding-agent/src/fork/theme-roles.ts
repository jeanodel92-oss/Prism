/** Nine editable roles. Tokens follow their role, keeping the base theme's OKLab lightness offsets. */
import { type Color, colorToHex, colorToOklch, colorToRgb, oklchColor, parseColor } from "@earendil-works/pi-tui";
import { wcagContrast } from "../modes/interactive/theme/system-theme.ts";
import type { Theme, ThemeToken } from "../modes/interactive/theme/theme.ts";
import type { EditableTheme } from "./theme-editor.ts";

export const THEME_ROLES = [
	{ key: "userMessageBg", label: "Surface" },
	{ key: "selectedBg", label: "Selection" },
	{ key: "text", label: "Text" },
	{ key: "muted", label: "Muted text" },
	{ key: "accent", label: "Accent" },
	{ key: "border", label: "Border" },
	{ key: "success", label: "Success" },
	{ key: "warning", label: "Warning" },
	{ key: "error", label: "Error" },
] as const;

export type ThemeRole = (typeof THEME_ROLES)[number]["key"];
export type CoreColors = Record<ThemeRole, string>;

const FAMILIES: Record<ThemeRole, readonly ThemeToken[]> = {
	userMessageBg: [
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
		"scrollbarTrack",
	],
	selectedBg: ["selectedBg", "searchMatchBg"],
	text: [
		"text",
		"thinkingText",
		"userMessageText",
		"customMessageText",
		"toolTitle",
		"toolOutput",
		"mdCodeBlock",
		"mdQuote",
		"syntaxVariable",
		"syntaxOperator",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
		"thinkingMax",
		"searchMatchText",
	],
	muted: [
		"muted",
		"dim",
		"customMessageLabel",
		"mdLinkUrl",
		"mdListBullet",
		"toolDiffContext",
		"syntaxComment",
		"syntaxPunctuation",
		"thinkingMinimal",
		"thinkingLow",
	],
	accent: [
		"accent",
		"mdHeading",
		"mdBold",
		"mdLink",
		"mdCode",
		"syntaxKeyword",
		"syntaxFunction",
		"syntaxNumber",
		"syntaxType",
		"bashMode",
	],
	border: [
		"border",
		"borderAccent",
		"borderMuted",
		"scrollbarThumb",
		"mdCodeBlockBorder",
		"mdQuoteBorder",
		"mdHr",
		"thinkingOff",
	],
	success: ["success", "toolDiffAdded", "syntaxString"],
	warning: ["warning"],
	error: ["error", "toolDiffRemoved"],
};

export function coreColors(base: Theme): CoreColors {
	return Object.fromEntries(THEME_ROLES.map(({ key }) => [key, colorToHex(base.colors[key])])) as CoreColors;
}

/** Below this OKLCH chroma a colour counts as a grey, part of a ramp rather than a hue of its own. */
const NEUTRAL_CHROMA = 0.02;
const MAX_CHROMA = 0.37;

/**
 * `color`, a token of a role whose colour goes from `from` to `to`, keeps its lightness step. A grey takes the role's
 * colour. A colour with its own hue (syntax colours, the green and the red of a tool's result) stays apart from the
 * others: it turns with the role, or keeps its hue when the role has none to turn from.
 */
function shifted(color: Color, from: Color, to: Color): string {
	const own = colorToOklch(color);
	const anchor = colorToOklch(from);
	const target = colorToOklch(to);
	const lightness = Math.max(0, Math.min(1, target.l + own.l - anchor.l));
	if (own.c < NEUTRAL_CHROMA) return colorToHex(oklchColor(lightness, target.c, target.h));
	if (anchor.c < NEUTRAL_CHROMA || target.c < NEUTRAL_CHROMA) return colorToHex(oklchColor(lightness, own.c, own.h));
	const chroma = Math.min(own.c * (target.c / anchor.c), MAX_CHROMA);
	return colorToHex(oklchColor(lightness, chroma, own.h + target.h - anchor.h));
}

export function deriveTheme(json: EditableTheme, base: Theme, cores: CoreColors): EditableTheme {
	const colors: Record<string, string> = {};
	const moved = (role: ThemeRole) => cores[role] !== colorToHex(base.colors[role]);
	for (const { key } of THEME_ROLES) {
		const chosen = parseColor(cores[key]);
		for (const token of FAMILIES[key]) {
			if (!base.colors[token]) continue;
			colors[token] = !moved(key)
				? colorToHex(base.colors[token])
				: token === key
					? colorToHex(chosen)
					: shifted(base.colors[token], base.colors[key], chosen);
		}
	}
	const exported: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(json.export ?? {})) {
		const role = key === "infoBg" ? "selectedBg" : "userMessageBg";
		let original = value;
		const visited = new Set<string>();
		while (typeof original === "string" && json.vars && original in json.vars && !visited.has(original)) {
			visited.add(original);
			original = json.vars[original]!;
		}
		exported[key] =
			original === "" || !moved(role)
				? value
				: shifted(parseColor(original), base.colors[role], parseColor(cores[role]));
	}
	// Explicit tokens keep the regular theme loader and hand-written theme format unchanged.
	return { ...json, colors: { ...json.colors, ...colors }, ...(json.export ? { export: exported } : {}) };
}

/** Lowest WCAG ratio of body/secondary text on the backgrounds where it is displayed. */
export function themeTextContrast(theme: Theme): { ratio: number; token: string; background: string } {
	const text = THEME_ROLES.filter(({ key }) => key !== "border" && key !== "userMessageBg" && key !== "selectedBg")
		.flatMap(({ key }) => FAMILIES[key])
		.filter((token) => token !== "searchMatchText" && theme.colors[token] !== undefined);
	const surfaces: ThemeToken[] = [
		"userMessageBg",
		"customMessageBg",
		"selectedBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	];
	const pairs: [ThemeToken, ThemeToken][] = text.flatMap((token) =>
		surfaces.map((background): [ThemeToken, ThemeToken] => [token, background]),
	);
	pairs.push(["searchMatchText", "searchMatchBg"]);
	return pairs.reduce(
		(worst, [token, background]) => {
			const ratio = wcagContrast(colorToRgb(theme.colors[token]), colorToRgb(theme.colors[background]));
			return ratio < worst.ratio ? { ratio, token, background } : worst;
		},
		{ ratio: 21, token: "text", background: "userMessageBg" },
	);
}

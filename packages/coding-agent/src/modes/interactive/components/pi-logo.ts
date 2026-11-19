import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { APP_DISPLAY_NAME } from "../../../fork/brand.ts";
import { artPixel, LOGO_MINI } from "../../../fork/prism/art.ts";
import { isLightTheme, type RGB } from "../../../fork/prism/lib/palette.ts";
import { renderHalfBlocks } from "../../../fork/prism/logo.ts";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

/**
 * fork: the Prism logo's mini size, 8 cells wide and 2 lines tall (`LOGO_MINI`), with the light
 * variant on light themes; the colors follow the terminal's color mode.
 */
export function piLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const ansi = ([r, g, b]: RGB, background: boolean) =>
		(background ? backgroundAnsi : foregroundAnsi)(rgbColor(r, g, b), mode);
	const [top, bottom] = renderHalfBlocks(
		LOGO_MINI,
		(x, y) => artPixel(LOGO_MINI, x, y, isLightTheme(theme)),
		(c) => ansi(c, false),
		(c) => ansi(c, true),
	);
	return [top, bottom];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsPiLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the logo with the logo's coral and yellow. */
export function piWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(CORAL, mode)}${APP_DISPLAY_NAME[0]}${RESET}${foregroundAnsi(YELLOW, mode)}${APP_DISPLAY_NAME.slice(1)}${RESET}`;
}

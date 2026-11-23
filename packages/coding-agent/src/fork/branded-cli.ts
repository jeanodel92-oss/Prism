/**
 * fork: `prism --help` kept pi's identity (slogan, `PI_*`
 * variables, the pi.dev share viewer, a Windows-only tool, 50 provider key lines before the tools).
 * A branded build rewrites upstream's help text here, so args.ts keeps a one-line hook.
 */

import { APP_DISPLAY_NAME } from "./brand.ts";

/** Where a branded build's `/share` links point (also `DEFAULT_SHARE_VIEWER_URL` in config.ts). */
export const BRANDED_SHARE_VIEWER_URL = "https://prism.odelserver.space/session/";

/** One description of the product, the site's. */
export const PRODUCT_TAGLINE = "a free and open source coding agent for Linux";

/** Variables a branded build also reads under its own prefix (`PRISM_OFFLINE` for `PI_OFFLINE`). */
const ALIASED_ENV_SUFFIXES = ["OFFLINE", "PACKAGE_DIR", "SHARE_VIEWER_URL"] as const;

/**
 * Copy `<APP>_OFFLINE`, `<APP>_PACKAGE_DIR` and `<APP>_SHARE_VIEWER_URL` to the `PI_*` names the code
 * reads, unless the `PI_*` one is set. Runs once at CLI startup, before anything reads them.
 */
export function applyBrandedEnvAliases(appName: string, env: NodeJS.ProcessEnv = process.env): void {
	const prefix = appName.toUpperCase();
	if (prefix === "PI") return;
	for (const suffix of ALIASED_ENV_SUFFIXES) {
		const branded = env[`${prefix}_${suffix}`];
		if (branded !== undefined && env[`PI_${suffix}`] === undefined) env[`PI_${suffix}`] = branded;
	}
}

/** Rewrite upstream's `--help` text for a branded build. Exported for tests. */
export function brandHelpText(text: string, appName: string): string {
	const prefix = appName.toUpperCase();
	const lines = text.split("\n");
	const out: string[] = [];
	let inProviderKeys = false;
	for (const line of lines) {
		if (out.length === 0 && line.includes(" - AI coding assistant with read, bash, edit, write tools")) {
			out.push(line.replace(/ - AI coding assistant with read, bash, edit, write tools/, ` - ${PRODUCT_TAGLINE}`));
			continue;
		}
		if (/^\s+powershell\s+- /.test(line)) continue;
		if (line.includes("Environment Variables:")) {
			out.push(line);
			out.push(
				"  Provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, …): see /docs providers,",
				`  or sign in with /login inside ${APP_DISPLAY_NAME}.`,
			);
			inProviderKeys = true;
			continue;
		}
		if (inProviderKeys) {
			if (!line.includes("_CODING_AGENT_DIR")) continue;
			inProviderKeys = false;
		}
		if (/^\s+PI_TELEMETRY\s/.test(line)) continue;
		const renamed = line
			.replace(/\bPI_(OFFLINE|PACKAGE_DIR|SHARE_VIEWER_URL)\b( *)/g, (_match, name: string, pad: string) => {
				const next = `${prefix}_${name}`;
				// Keep the description column aligned: the branded name is longer by (prefix - 2) chars.
				const extra = next.length - `PI_${name}`.length;
				return next + (pad.length > extra ? pad.slice(extra) : pad.length > 0 ? " " : "");
			})
			.replace("https://pi.dev/session/", BRANDED_SHARE_VIEWER_URL);
		out.push(renamed);
	}
	return out.join("\n");
}

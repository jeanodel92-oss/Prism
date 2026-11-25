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

/**
 * Prism's own examples, in place of upstream's, which named providers and models
 * (the shipped harness names none) and pi's commands. `{0}` is the command name.
 */
const BRANDED_EXAMPLES = [
	"  # Start in this folder (the window: {0} --gui)",
	"  {0}",
	"",
	"  # Start with a first message, and files",
	'  {0} "Explain this project"',
	'  {0} @notes.md @screenshot.png "What is wrong here?"',
	"",
	"  # Answer once and exit, for scripts",
	'  {0} -p "List the TODO comments in src/"',
	"",
	"  # Continue the last session, or pick one",
	"  {0} --continue",
	"  {0} --resume",
	"",
	"  # Pick the model (provider/model, then a thinking level)",
	'  {0} --model <provider>/<model>:high "Solve this problem"',
	"",
	"  # Ask before every change, for this run",
	"  {0} --perm-mode ask",
	"",
	"  # Sign in to a provider from the shell, for example over SSH",
	"  {0} auth login <provider>",
	"",
	"  # Update, or go back to the previous version",
	"  {0} update",
	"  {0} update --rollback",
	"",
];

/** Rewrite upstream's `--help` text for a branded build. Exported for tests. */
export function brandHelpText(text: string, appName: string): string {
	const prefix = appName.toUpperCase();
	const lines = text.split("\n");
	const out: string[] = [];
	let inProviderKeys = false;
	let inExamples = false;
	for (const line of lines) {
		// Upstream's sentence names a plan-mode extension that is not Prism's; the flags' own heading says enough.
		if (line.startsWith("Extensions can register additional flags")) continue;
		if (line.includes("Extension CLI Flags:")) {
			out.push(
				line.replace("Extension CLI Flags:", "Options of Prism's modules and of the extensions you installed:"),
			);
			continue;
		}
		if (line.includes("Examples:")) {
			out.push(line);
			for (const example of BRANDED_EXAMPLES) out.push(example.replaceAll("{0}", appName));
			inExamples = true;
			continue;
		}
		if (inExamples) {
			if (!line.includes("Environment Variables:")) continue;
			inExamples = false;
		}
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

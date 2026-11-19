// Fork-only safe mode: one flag that starts without any discovered
// resource, so a broken extension, skill, prompt template, theme or context file
// cannot prevent startup. Explicitly passed paths (-e, --skill, ...) still load.
import type { Args } from "../cli/args.ts";
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";
import { SYSTEM_THEME_NAME } from "../modes/interactive/theme/system-theme.ts";

export const SAFE_MODE_NOTICE =
	"Safe mode: extensions, skills, prompt templates, themes and context files are not loaded. Restart without --safe to load them.";

/** Expand --safe into the vanilla minimal-startup flags. */
export function applySafeMode(args: Args): void {
	args.safe = true;
	args.noExtensions = true;
	args.noSkills = true;
	args.noPromptTemplates = true;
	args.noThemes = true;
	// The theme named in settings.json may be a broken custom theme; --use-theme still wins.
	args.useTheme ??= SYSTEM_THEME_NAME;
	args.noContextFiles = true;
	args.verbose = true;
}

/** Startup notice shown on screen (interactive) or on stderr (print, json, rpc). */
export function getSafeModeDiagnostics(args: Args): AgentSessionRuntimeDiagnostic[] {
	return args.safe ? [{ type: "warning", message: SAFE_MODE_NOTICE }] : [];
}

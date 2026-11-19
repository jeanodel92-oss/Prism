// fork: /login, local first. The owner asked for the compatible server (local models)
// at the top, and for Radius, upstream's own service, to leave the /login menus
// . The Radius provider itself stays available to whoever configures it.
import { RADIUS_PROVIDER_ID } from "../core/radius.ts";
import { CLAUDE_CODE_PROVIDER_ID } from "./claude-code/id.ts";

/** Whether /login offers a provider. */
export function isOfferedAtLogin(providerId: string): boolean {
	return providerId !== RADIUS_PROVIDER_ID;
}

/**
 * a provider whose sign-in is an account the user logs in to elsewhere, though Prism stores no token:
 * Claude Code (`claude -p`) uses the Claude subscription the user logged in to in Claude Code itself. /login lists
 * it with the account sign-ins, not with the API keys.
 */
export function signsInWithAccount(providerId: string): boolean {
	return providerId === CLAUDE_CODE_PROVIDER_ID;
}

/** The /login method menu, compatible server first; missing entries are skipped. */
export function loginMethodOptions(labels: { server?: string; subscription?: string; apiKey?: string }): string[] {
	return [labels.server, labels.subscription, labels.apiKey].filter((label): label is string => label !== undefined);
}

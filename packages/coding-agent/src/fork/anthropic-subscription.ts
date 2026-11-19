/**
 * signing in to Anthropic with a Claude subscription is warned against
 * before it starts, in the terminal and in the window. Anthropic's terms
 *  do not let third-party apps offer the Claude.ai sign-in or route requests through a Free, Pro,
 * Max or Ultra plan, and Anthropic may enforce this without notice. The sign-in stays available.
 */
import type { AuthSelectorProvider } from "../modes/interactive/components/oauth-selector.ts";
import { CLAUDE_CODE_TERMS_NOTICE } from "./claude-code/provider.ts";
import { t } from "./i18n/index.ts";

export const ANTHROPIC_SUBSCRIPTION_TITLE = "Claude subscription";

export const ANTHROPIC_SUBSCRIPTION_RISK =
	"Anthropic does not allow third-party apps such as Prism to sign in with a Claude Free, Pro, Max or Ultra subscription. Your Claude account may be suspended or banned, without notice. The allowed way is an API key from the Claude Console.";

export const ANTHROPIC_SUBSCRIPTION_GO = "Sign in anyway";

/**
 * /login's two warnings about a Claude account stand out, in bold: red for
 * the Claude subscription sign-in, yellow for Claude Code (claude -p). `text` is the warning, translated or not.
 */
export function loginWarningTone(text: string): "error" | "warning" | undefined {
	if (text === ANTHROPIC_SUBSCRIPTION_RISK || text === t(ANTHROPIC_SUBSCRIPTION_RISK)) return "error";
	if (text === CLAUDE_CODE_TERMS_NOTICE || text === t(CLAUDE_CODE_TERMS_NOTICE)) return "warning";
	return undefined;
}

/** Whether this login option is the Anthropic sign-in with a Claude subscription. */
export function isAnthropicSubscription(option: Pick<AuthSelectorProvider, "id" | "authType">): boolean {
	return option.id === "anthropic" && option.authType === "oauth";
}

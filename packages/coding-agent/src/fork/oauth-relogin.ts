/**
 * fork: a provider that refuses the stored refresh token (OAuth
 * `invalid_grant`, or 401/403) is fixed only by signing in again, so the error says so, with the command.
 */
import { fill } from "./i18n/index.ts";

/** The message `refreshStoredOAuthCredential` throws, with the provider's answer appended. */
const REFUSED = /OAuth refresh failed for ([^\s:]+)[\s\S]*?(?:invalid_grant|\((?:401|403)\))/;

/** The note for these errors' messages, naming each provider whose sign-in was refused; "" when none was. */
export function reloginNote(messages: Iterable<string>): string {
	const providers = new Set<string>();
	for (const message of messages) {
		const provider = REFUSED.exec(message)?.[1];
		if (provider) providers.add(provider);
	}
	if (providers.size === 0) return "";
	return fill("Sign-in to {0} is no longer accepted. Sign in again with /login.", [...providers].join(", "));
}

/** `text`, followed by the note for `errors` when one applies. */
export function withReloginNote(text: string, errors: Iterable<Error>): string {
	const note = reloginNote([...errors].map((error) => error.message));
	return note ? `${text} ${note}` : text;
}

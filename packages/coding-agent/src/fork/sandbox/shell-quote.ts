// In this folder because relay.ts, which the sandbox runs, sees only this folder of Prism's code (path-within.ts).
/**
 * fork: `text` as one POSIX shell word, received as it is by the program: bare
 * when it holds only characters no shell treats specially, otherwise in single quotes. The one quoting of Prism's own
 * command lines; Git's remote quoting (`git-ssh.ts`) also escapes `!` for a csh on the other side, and stays its own.
 */
export function shellQuote(text: string): string {
	return /^[A-Za-z0-9_@%+:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

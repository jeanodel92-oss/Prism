// a path pasted or added into a `!` command stays one word, as the terminal writes it.
// The same rule as packages/coding-agent/src/fork/sandbox/shell-quote.ts, which the page cannot import; both are tested
// on the same words (tests/shell-quote.test.mjs).

/** `text` as one POSIX shell word: bare when no shell treats any of its characters specially, else single-quoted. */
export function shellQuote(text) {
	return /^[A-Za-z0-9_@%+:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

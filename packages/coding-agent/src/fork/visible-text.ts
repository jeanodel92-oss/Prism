// fork.12 security audit: untrusted text shown to the user (a command, a path or a prompt in a
// permission question, an excerpt of a tool result) must not act on the terminal nor hide or reorder what follows.

/** Controls, format characters (bidi overrides and isolates, zero-width), line and paragraph separators. */
const HIDDEN = /[\p{C}\p{Zl}\p{Zp}]/u;

export interface VisibleTextOptions {
	/** At most this many characters of the text, then `…`. Unbounded by default. */
	limit?: number;
	/** Keeps line feeds and tabs: for a multi-line command or prompt, never for a path or a one-line target. */
	lines?: boolean;
}

/**
 * fork: a text of several lines, as a question shows it under its title.
 * Each line is indented by `indent`; when there are several, each also starts with a gutter, so that no line of the
 * text can pass for a line of the question around it (a reason, a choice). One line looks as before.
 */
export function textBlock(text: string, indent = "  "): string {
	const lines = text.split("\n");
	return lines.length === 1 ? `${indent}${text}` : lines.map((line) => `${indent}│ ${line}`).join("\n");
}

/**
 * Shows each terminal control and invisible character as a visible `<U+XXXX>` token, so the user reads that the
 * text carries one instead of the terminal acting on it: `ESC[8m` becomes `<U+001B>[8m`, U+202E `<U+202E>`, a line
 * break in a path `<U+000A>`.
 */
export function visibleText(text: string, options: VisibleTextOptions = {}): string {
	const limit = options.limit ?? Number.POSITIVE_INFINITY;
	let shown = "";
	for (const char of text.slice(0, limit)) {
		const visible =
			HIDDEN.test(char) && !(options.lines && (char === "\n" || char === "\t"))
				? `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`
				: char;
		if (shown.length + visible.length > limit) return `${shown}…`;
		shown += visible;
	}
	return shown + (text.length > limit ? "…" : "");
}

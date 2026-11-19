/**
 * fork: in the simple interface, a failed shell command says how it ended in words on its
 * header line ("failed (code 1)"), instead of leaving the shell tool's status line ("Command exited with
 * code 1") at the end of its output. Only that one line moves; the output itself is shown unchanged, and
 * the advanced interface shows everything as the tool wrote it.
 */

const STATUS: Array<{ regex: RegExp; label: (match: RegExpExecArray) => string }> = [
	{ regex: /^Command exited with code (-?\d+)$/, label: (m) => `failed (code ${m[1]})` },
	{ regex: /^Command timed out after (\d+) seconds$/, label: (m) => `stopped after ${m[1]} s (time limit)` },
	{ regex: /^Command aborted$/, label: () => "stopped" },
];

/** How many trailing lines may follow the status line: the truncation notice, wrapped, and blank lines. */
const SEARCH_DEPTH = 8;

export interface ShellOutcome {
	/** English label for the header line; the caller translates it. */
	label: string;
	/** The output lines without the status line (and the blank line the tool put before it). */
	body: string[];
}

/**
 * The status line of a finished shell result, searched near the end of the plain-text output lines.
 * `plain` maps a rendered line to its text without escape sequences. Undefined when there is none,
 * e.g. when a narrow width wrapped it.
 */
export function shellOutcome(body: readonly string[], plain: (line: string) => string): ShellOutcome | undefined {
	for (let i = body.length - 1; i >= Math.max(0, body.length - SEARCH_DEPTH); i--) {
		const text = plain(body[i]).trim();
		for (const { regex, label } of STATUS) {
			const match = regex.exec(text);
			if (!match) continue;
			const start = i > 0 && plain(body[i - 1]).trim() === "" ? i - 1 : i;
			return { label: label(match), body: [...body.slice(0, start), ...body.slice(i + 1)] };
		}
	}
	return undefined;
}

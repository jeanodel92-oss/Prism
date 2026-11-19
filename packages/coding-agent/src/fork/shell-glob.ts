/**
 * fork: the files a shell pattern names, read on the disk as bash
 * reads them with its default options, so the permission gate checks `cat .[e]nv` as `cat .env`.
 *
 * Bash defaults: no `dotglob` (a name starting with `.` needs a pattern starting with `.`), `.` and `..` never match,
 * no `globstar` (`**` is `*`), a pattern without a match stays as written.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const GLOB_CHARS = /[*?[]/;

/** A regular expression for one path component of a pattern; an unclosed `[` is a literal, as in bash. */
function componentRegExp(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else if (c === "[") {
			const bracket = bracketExpression(pattern, i);
			if (!bracket) {
				re += "\\[";
				continue;
			}
			re += bracket.re;
			i = bracket.end;
		} else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "s");
}

/**
 * fork: the characters of the POSIX classes bash reads in a bracket (`[[:alpha:]]`), wider
 * than the C locale (every non-ASCII character for the letter classes) so a pattern never matches fewer names than
 * bash would. An unknown class matches any character.
 */
const POSIX_CLASSES: Record<string, string> = {
	alpha: "A-Za-z\\u0080-\\uffff",
	alnum: "0-9A-Za-z\\u0080-\\uffff",
	word: "0-9A-Za-z_\\u0080-\\uffff",
	upper: "A-Z\\u0080-\\uffff",
	lower: "a-z\\u0080-\\uffff",
	digit: "0-9",
	xdigit: "0-9A-Fa-f",
	space: "\\s",
	blank: " \\t",
	punct: "!-\\/:-@\\[-`{-~\\u0080-\\uffff",
	print: " -~\\u0080-\\uffff",
	graph: "!-~\\u0080-\\uffff",
	cntrl: "\\x00-\\x1f\\x7f",
};

/** The regular expression for the bracket expression at `at`, and the index of its `]`; undefined when unclosed. */
function bracketExpression(pattern: string, at: number): { re: string; end: number } | undefined {
	let j = at + 1;
	const negated = pattern[j] === "!" || pattern[j] === "^";
	if (negated) j++;
	let body = "";
	for (let first = true; j < pattern.length; first = false) {
		const c = pattern[j]!;
		if (c === "]" && !first) {
			const set = `[${negated ? "^" : ""}${body}]`;
			// A range bash cannot read (`[z-a]`, `[:-3]`) matches no name.
			return { re: validClass(set) ? set : "(?!)", end: j };
		}
		const kind = pattern[j + 1];
		const close = c === "[" && kind !== undefined && ":.=".includes(kind) ? pattern.indexOf(`${kind}]`, j + 2) : -1;
		if (close >= 0) {
			const name = pattern.slice(j + 2, close);
			body +=
				kind === ":"
					? (POSIX_CLASSES[name] ?? "\\s\\S")
					: name.length === 1
						? name.replace(/[\\\]^[-]/g, "\\$&")
						: "\\s\\S";
			j = close + 2;
			continue;
		}
		body += c.replace(/[\\\]^[]/g, "\\$&");
		j++;
	}
	return undefined;
}

function validClass(set: string): boolean {
	try {
		new RegExp(set);
		return true;
	} catch {
		return false;
	}
}

/**
 * The paths `pattern` matches below `base` (absolute when the pattern is), sorted; an empty list when nothing matches;
 * undefined once more than `limit` directory entries have been read, so a pattern over a large tree is not walked.
 */
export function expandGlob(pattern: string, base: string, limit = 2000): string[] | undefined {
	const absolute = pattern.startsWith("/");
	const parts = pattern.split("/").filter((part) => part !== "");
	let current = [absolute ? "/" : base];
	let read = 0;
	for (const part of parts) {
		const next: string[] = [];
		if (!GLOB_CHARS.test(part)) {
			for (const dir of current) next.push(join(dir, part));
		} else {
			const re = componentRegExp(part);
			for (const dir of current) {
				let names: string[];
				try {
					names = readdirSync(dir);
				} catch {
					continue;
				}
				read += names.length;
				if (read > limit) return undefined;
				for (const name of names) {
					if (name.startsWith(".") && !part.startsWith(".")) continue;
					if (re.test(name)) next.push(join(dir, name));
				}
			}
		}
		current = next;
		if (current.length === 0) return [];
	}
	// A literal last component must exist for the pattern to match.
	return current.filter((path) => exists(path)).sort();
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

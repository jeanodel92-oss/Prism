/**
 * fork: makes ssh usable in the sandbox. OpenSSH refuses a file included from
 * its configuration unless root or the user owns it, and only the user's uid is mapped in the sandbox, so root's
 * files show up as nobody's and every ssh command fails ("Bad owner or permissions"). Each included file root
 * owns is shown through a copy the user owns, with the same content; nothing else changes.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const SYSTEM_CONFIG = "/etc/ssh/ssh_config";
// OpenSSH's own limit on nested includes.
const MAX_DEPTH = 16;

/**
 * A glob component as a test: `*`, `?` and classes, as glob(3) reads them. An unclosed `[` is literal; a class
 * JavaScript refuses (`[z-a]`) matches only its own text.
 */
function componentPattern(component: string): (name: string) => boolean {
	let source = "";
	for (let index = 0; index < component.length; index++) {
		const char = component[index]!;
		const negated = char === "[" && component[index + 1] === "!";
		// A `]` right after `[` or `[!` belongs to the class; `^` is literal, as ssh reads it.
		const close = char === "[" ? component.indexOf("]", index + (negated ? 3 : 2)) : -1;
		if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (close > 0) {
			const body = component.slice(index + (negated ? 2 : 1), close).replace(/[\\^[]/g, "\\$&");
			source += `[${negated ? "^" : ""}${body}]`;
			index = close;
		} else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	try {
		const pattern = new RegExp(`^${source}$`);
		return (name) => pattern.test(name);
	} catch {
		return (name) => name === component;
	}
}

/**
 * The words of an `Include` line as OpenSSH splits them: single or double quotes, `\` before a space, a quote or
 * `\`, and a `#` that starts a word begins a comment. ssh refuses a line with an unclosed quote: no words.
 */
export function words(text: string): string[] {
	const found: string[] = [];
	let word: string | undefined;
	let quote: string | undefined;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		const next = text[index + 1];
		if (quote) {
			if (char === "\\" && (next === quote || next === "\\")) word += text[++index];
			else if (char === quote) quote = undefined;
			else word += char;
		} else if (/\s/.test(char)) {
			if (word !== undefined) found.push(word);
			word = undefined;
		} else if (word === undefined && char === "#") break;
		else {
			word ??= "";
			if (char === "\\" && next !== undefined && /[\s\\'"]/.test(next)) word += text[++index];
			else if (char === "'" || char === '"') quote = char;
			else word += char;
		}
	}
	if (quote) return [];
	if (word !== undefined) found.push(word);
	return found;
}

/** The files a pattern names, in glob(3)'s sorted order. */
export function expand(pattern: string): string[] {
	let paths = ["/"];
	for (const component of pattern.split("/").filter(Boolean)) {
		if (!/[*?[]/.test(component)) {
			paths = paths.map((path) => join(path, component));
			continue;
		}
		const matches = componentPattern(component);
		paths = paths.flatMap((path) => {
			try {
				return readdirSync(path)
					.filter((name) => matches(name) && (component.startsWith(".") || !name.startsWith(".")))
					.sort()
					.map((name) => join(path, name));
			} catch {
				return [];
			}
		});
	}
	return paths;
}

/**
 * The files the system configuration includes, directly or not, by their real paths. `~` and `%` tokens are
 * not expanded: they name the user's own files, which the sandbox hides anyway.
 */
export function includedSshFiles(config = SYSTEM_CONFIG): string[] {
	const found: string[] = [];
	const visit = (file: string, depth: number) => {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return;
		}
		for (const line of text.split("\n")) {
			const match = /^\s*include(?:\s*=\s*|\s+)(.+)$/i.exec(line);
			if (!match) continue;
			for (const path of words(match[1]!)) {
				for (const included of expand(isAbsolute(path) ? path : join(dirname(config), path))) {
					let real: string;
					try {
						real = realpathSync(included);
					} catch {
						continue;
					}
					if (found.includes(real)) continue;
					found.push(real);
					if (depth < MAX_DEPTH) visit(real, depth + 1);
				}
			}
		}
	};
	visit(config, 1);
	return found;
}

/**
 * Pairs [copy, original] to bind in the sandbox: a copy, written to `dir`, of each included file root owns
 * that ssh would accept outside the sandbox (a regular file nobody else can write).
 */
export function sshConfigCopies(dir: string, files = includedSshFiles()): Array<[string, string]> {
	const copies: Array<[string, string]> = [];
	for (const file of files) {
		try {
			const stat = lstatSync(file);
			if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) continue;
			// Encoded, not "/" to "_": /etc/a_b and /etc/a/b must not share a copy.
			const copy = join(dir, `ssh-${encodeURIComponent(file)}`);
			const content = readFileSync(file);
			let current: Buffer | undefined;
			try {
				if (statSync(copy).uid === process.getuid?.()) current = readFileSync(copy);
			} catch {}
			if (!current?.equals(content)) {
				// Renamed into place: another session's command may be reading the copy.
				const next = `${copy}.${process.pid}`;
				writeFileSync(next, content, { mode: 0o644 });
				renameSync(next, copy);
			}
			copies.push([copy, file]);
		} catch {}
	}
	return copies;
}

/**
 * fork: the words of a shell command line as bash reads them.
 *
 * The classifier cut a line with regular expressions and spaces, so `cat "secret alias"` became two words that do not
 * exist and `grep "a|b" f` two commands. This lexer makes one pass over the text and keeps what bash keeps: quote
 * removal, backslashes, operators outside quotes, redirections, and for each word whether bash will still expand it
 * (a pattern, a variable, a substitution).
 *
 * It is not a shell parser. What it does not understand makes its segment opaque, and an opaque segment must never be
 * judged safe: an unclosed quote, an unterminated here-document, `$'…'` and `$"…"`, braces (group or expansion),
 * arithmetic `((…))` and `case` clauses. A here-document's body is read up to its delimiter and kept on its
 * redirection, as data: its lines are not commands. A substitution, command or process, stays in its word, whose body
 * `commandSubstitutions` gives for classifying.
 */

/** One word after quote removal; `text` keeps `$NAME`, `${…}`, `$(…)` and pattern characters as written. */
export interface ShellWord {
	/** The word as the program receives it when it holds no expansion. */
	text: string;
	/** The characters of the line it came from. */
	raw: string;
	/** Part of it was quoted or escaped. */
	quoted: boolean;
	/** An unquoted `*`, `?` or `[`: bash expands it against the disk. */
	glob: boolean;
	/** A `$NAME`, `${NAME}` or a leading `~`, whose value bash puts in. */
	variable: boolean;
	/** A command substitution or a `${…}` with an operator: text bash computes. */
	expansion: boolean;
}

export interface ShellRedirect {
	/** `>`, `>>`, `<`, `&>`, `>&`, `<<<`... with the file descriptor written before it, if any (`2>`). */
	op: string;
	/** The file, descriptor or here-document delimiter after the operator. */
	target?: ShellWord;
	/** A here-document (`<<` or `<<-`): its body, and whether bash expands it (an unquoted delimiter). */
	hereDoc?: { body: string; expands: boolean; start: number; end: number };
}

export interface ShellSegment {
	words: ShellWord[];
	redirects: ShellRedirect[];
	/** The operator after this segment: `&&`, `||`, `;`, `|`, `|&`, `&`, `(`, `)` or a newline; none for the last. */
	operator?: string;
	/** Why the lexer could not read this segment the way bash does; never safe when set. */
	opaque?: string;
	/** Where the segment's text is in the line (its operator and here-document bodies excluded). */
	start: number;
	end: number;
}

const OPERATORS = ["&&", "||", "|&", ";", "|", "&", "\n", "(", ")"];
const REDIRECT_RE = /^(?:<<<|<<-?|&>>|&>|>>|>&|<&|>\||<>|>|<)/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL_RE = /^[0-9?#$!@*-]/;

/** The index after the `)` that closes a `(` at `from - 1`, skipping quotes and nested parentheses; -1 when unclosed. */
function closingParen(text: string, from: number): number {
	let depth = 1;
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") i++;
		else if (c === "'") {
			const end = text.indexOf("'", i + 1);
			if (end < 0) return -1;
			i = end;
		} else if (c === '"') {
			const end = closingDoubleQuote(text, i + 1);
			if (end < 0) return -1;
			i = end;
		} else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i + 1;
	}
	return -1;
}

function closingDoubleQuote(text: string, from: number): number {
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === '"') return i;
	}
	return -1;
}

export function closingBrace(text: string, from: number): number {
	let depth = 1;
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === "{") depth++;
		else if (text[i] === "}" && --depth === 0) return i + 1;
	}
	return -1;
}

interface Dollar {
	/** The index after the expansion. */
	end: number;
	kind: "variable" | "expansion";
	opaque?: string;
}

/** The expansion that starts with the `$` at `at`, or undefined for a lone `$` (a literal dollar). */
function dollarAt(text: string, at: number): Dollar | undefined {
	const next = text[at + 1];
	if (next === "(") {
		const end = closingParen(text, at + 2);
		if (end < 0) return { end: text.length, kind: "expansion", opaque: "an unclosed $(" };
		return { end, kind: "expansion" };
	}
	if (next === "{") {
		const end = closingBrace(text, at + 2);
		if (end < 0) return { end: text.length, kind: "expansion", opaque: "an unclosed ${" };
		const inner = text.slice(at + 2, end - 1);
		return {
			end,
			kind: NAME_RE.exec(inner)?.[0] === inner || /^[0-9?#$!@*-]$/.test(inner) ? "variable" : "expansion",
		};
	}
	if (next === "[") {
		const end = text.indexOf("]", at + 2);
		return { end: end < 0 ? text.length : end + 1, kind: "expansion" };
	}
	const name = NAME_RE.exec(text.slice(at + 1))?.[0] ?? (SPECIAL_RE.test(next ?? "") ? next! : undefined);
	return name ? { end: at + 1 + name.length, kind: "variable" } : undefined;
}

/**
 * fork: a variable as `text` keeps it, `${NAME}` for a plain `$NAME`, so the letters
 * written after it stay apart: `"$S"v` is `${S}v`, not the variable `Sv`.
 */
function variableText(text: string, at: number, end: number): string {
	const name = NAME_RE.exec(text.slice(at + 1, end))?.[0];
	return name !== undefined && name.length === end - at - 1 ? `\${${name}}` : text.slice(at, end);
}

/** A `${NAME op ARG}` written in a word, outside quotes or in double quotes. */
export interface ParameterExpansion {
	name: string;
	/** `:-`, `-`, `:=`, `=`, `:+`, `+`, `:?`, `?`, or another operator (`:`, `#`, `%`, `/`, `^`, `,`, `@`). */
	op: string;
	arg: string;
}

/**
 * The `${NAME op ARG}` of a word's raw text that run in the current shell: those in single quotes are text, and those
 * in a command substitution or backquotes run in a subshell.
 */
export function parameterExpansions(raw: string): ParameterExpansion[] {
	const found: ParameterExpansion[] = [];
	let inDouble = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (c === "\\") i++;
		else if (c === "'" && !inDouble) {
			const end = raw.indexOf("'", i + 1);
			i = end < 0 ? raw.length : end;
		} else if (c === '"') inDouble = !inDouble;
		else if (c === "`") {
			const end = raw.indexOf("`", i + 1);
			i = end < 0 ? raw.length : end;
		} else if (c === "$" && raw[i + 1] === "(") {
			const end = closingParen(raw, i + 2);
			i = end < 0 ? raw.length : end - 1;
		} else if (c === "$" && raw[i + 1] === "{") {
			const end = closingBrace(raw, i + 2);
			if (end < 0) break;
			const inner = raw.slice(i + 2, end - 1);
			const name = NAME_RE.exec(inner)?.[0];
			if (name) {
				const op = /^(?::?[-=+?]|[:#%/^,@][#%/^,]?)/.exec(inner.slice(name.length))?.[0];
				if (op) found.push({ name, op, arg: inner.slice(name.length + op.length) });
			}
			i = end - 1;
		}
	}
	return found;
}

/**
 * The bodies of the command and process substitutions in `text` (`$(…)`, backquotes, `<(…)`, `>(…)`), outermost
 * first. Single quotes protect their content, except in a here-document's body (`hereDoc`), where bash expands them.
 */
export function commandSubstitutions(text: string, hereDoc = false): Array<{ body: string; process: boolean }> {
	const bodies: Array<{ body: string; process: boolean }> = [];
	let double = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === "\\") i++;
		else if (c === '"' && !hereDoc) double = !double;
		else if (c === "'" && !hereDoc && !double) {
			const end = text.indexOf("'", i + 1);
			if (end < 0) break;
			i = end;
		} else if (text[i + 1] === "(" && (c === "$" || c === "<" || c === ">")) {
			const end = closingParen(text, i + 2);
			bodies.push({ body: text.slice(i + 2, end < 0 ? text.length : end - 1), process: c !== "$" });
			if (end < 0) break;
			i = end - 1;
		} else if (c === "`") {
			const end = text.indexOf("`", i + 1);
			bodies.push({ body: text.slice(i + 1, end < 0 ? text.length : end), process: false });
			if (end < 0) break;
			i = end;
		}
	}
	return bodies;
}

/** The segments of `command`, in order. Pure: reads no environment and no disk. */
export function shellSegments(command: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let segment: ShellSegment = { words: [], redirects: [], start: 0, end: 0 };
	let word: ShellWord | undefined;
	let pendingRedirect: ShellRedirect | undefined;
	// Here-documents whose body starts at the next newline, with the segment that reads them.
	const hereDocs: Array<{ redirect: ShellRedirect; owner: ShellSegment; strip: boolean }> = [];
	const opaque = (why: string) => {
		segment.opaque ??= why;
	};
	const start = (): ShellWord => {
		word ??= { text: "", raw: "", quoted: false, glob: false, variable: false, expansion: false };
		return word;
	};
	const endWord = () => {
		if (!word) return;
		if (pendingRedirect) {
			pendingRedirect.target = word;
			pendingRedirect = undefined;
		} else {
			if (segment.words.length === 0 && (word.raw === "{" || word.raw === "}")) opaque("a { … } group");
			if (segment.words.length === 0 && word.raw === "case") opaque("a case clause");
			segment.words.push(word);
		}
		word = undefined;
	};
	const endSegment = (at: number, operator?: string) => {
		endWord();
		if (pendingRedirect) opaque("a redirection without a target");
		pendingRedirect = undefined;
		segment.operator = operator;
		segment.end = at;
		segments.push(segment);
		segment = { words: [], redirects: [], start: at + (operator?.length ?? 0), end: 0 };
	};
	/** Reads the bodies of the pending here-documents from `from` (a line start); returns the index after them. */
	const readHereDocs = (from: number): number => {
		let at = from;
		for (const { redirect, owner, strip } of hereDocs.splice(0)) {
			const delimiter = redirect.target?.text;
			const start = at;
			let end = -1;
			while (at <= command.length) {
				const eol = command.indexOf("\n", at);
				const stop = eol < 0 ? command.length : eol;
				const line = command.slice(at, stop);
				const next = eol < 0 ? command.length + 1 : eol + 1;
				if (delimiter !== undefined && (strip ? line.replace(/^\t+/, "") : line) === delimiter) {
					end = at;
					at = next;
					break;
				}
				at = next;
			}
			if (delimiter === undefined || end < 0) owner.opaque ??= "an unterminated here-document";
			const stop = end < 0 ? command.length : end;
			redirect.hereDoc = {
				body: command.slice(start, stop),
				expands: redirect.target?.quoted !== true,
				start,
				end: stop,
			};
		}
		return Math.min(at, command.length);
	};

	let i = 0;
	while (i < command.length) {
		const c = command[i]!;
		// Line continuation: removed, the word goes on.
		if (c === "\\" && command[i + 1] === "\n") {
			i += 2;
			continue;
		}
		if (c === " " || c === "\t") {
			endWord();
			i++;
			continue;
		}
		if (c === "#" && !word) {
			const end = command.indexOf("\n", i);
			i = end < 0 ? command.length : end;
			continue;
		}
		// `<` and `>` end a word wherever they are (`a>b` writes b); digits right before them name a descriptor (`2>`).
		const redirect = (c === "<" || c === ">" || (c === "&" && command[i + 1] === ">")) && command[i + 1] !== "(";
		if (redirect) {
			let fd = "";
			if (word && !word.quoted && /^\d+$/.test(word.raw)) {
				fd = word.raw;
				word = undefined;
			} else endWord();
			const op = REDIRECT_RE.exec(command.slice(i))![0];
			if (pendingRedirect) opaque("a redirection without a target");
			pendingRedirect = { op: fd + op };
			if (op === "<<" || op === "<<-")
				hereDocs.push({ redirect: pendingRedirect, owner: segment, strip: op === "<<-" });
			segment.redirects.push(pendingRedirect);
			i += op.length;
			continue;
		}
		if (!word) {
			if (command.startsWith("((", i)) opaque("an arithmetic evaluation");
			if (command.startsWith(";;", i)) opaque("a case clause");
		}
		if ((c === "<" || c === ">") && command[i + 1] === "(") {
			const end = closingParen(command, i + 2);
			const w = start();
			const stop = end < 0 ? command.length : end;
			w.raw += command.slice(i, stop);
			w.text += command.slice(i, stop);
			w.expansion = true;
			i = stop;
			continue;
		}
		const operator = OPERATORS.find((op) => command.startsWith(op, i));
		if (operator) {
			endSegment(i, operator);
			i += operator.length;
			if (operator === "\n" && hereDocs.length > 0) {
				i = readHereDocs(i);
				segment.start = i;
			}
			continue;
		}
		const w = start();
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end < 0) {
				opaque("an unclosed quote");
				w.raw += command.slice(i);
				w.text += command.slice(i + 1);
				w.quoted = true;
				i = command.length;
				continue;
			}
			w.raw += command.slice(i, end + 1);
			w.text += command.slice(i + 1, end);
			w.quoted = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			const end = closingDoubleQuote(command, i + 1);
			if (end < 0) opaque("an unclosed quote");
			const stop = end < 0 ? command.length : end;
			w.quoted = true;
			w.raw += command.slice(i, end < 0 ? stop : stop + 1);
			for (let k = i + 1; k < stop; k++) {
				const d = command[k]!;
				if (d === "\\" && k + 1 < stop && '$`"\\\n'.includes(command[k + 1]!)) {
					if (command[k + 1] !== "\n") w.text += command[k + 1];
					k++;
				} else if (d === "$") {
					const dollar = dollarAt(command, k);
					if (!dollar) {
						w.text += d;
						continue;
					}
					if (dollar.opaque) opaque(dollar.opaque);
					w[dollar.kind] = true;
					w.text += variableText(command, k, Math.min(dollar.end, stop));
					k = Math.min(dollar.end, stop) - 1;
				} else if (d === "`") {
					const close = command.indexOf("`", k + 1);
					w.expansion = true;
					if (close < 0 || close > stop) opaque("an unclosed backquote");
					w.text += command.slice(k, close < 0 || close > stop ? stop : close + 1);
					k = close < 0 || close > stop ? stop : close;
				} else w.text += d;
			}
			i = end < 0 ? command.length : end + 1;
			continue;
		}
		if (c === "\\") {
			w.quoted = true;
			w.raw += command.slice(i, i + 2);
			w.text += command[i + 1] ?? "";
			i += 2;
			continue;
		}
		if (c === "$") {
			if (command[i + 1] === "'" || command[i + 1] === '"') {
				opaque(`a ${command[i + 1] === "'" ? "$'…'" : '$"…"'} string`);
				w.raw += c;
				w.text += c;
				i++;
				continue;
			}
			const dollar = dollarAt(command, i);
			if (dollar) {
				if (dollar.opaque) opaque(dollar.opaque);
				if (command.startsWith("$((", i)) w.expansion = true;
				else w[dollar.kind] = true;
				w.raw += command.slice(i, dollar.end);
				w.text += variableText(command, i, dollar.end);
				i = dollar.end;
				continue;
			}
		}
		if (c === "`") {
			const close = command.indexOf("`", i + 1);
			if (close < 0) opaque("an unclosed backquote");
			const stop = close < 0 ? command.length : close + 1;
			w.expansion = true;
			w.raw += command.slice(i, stop);
			w.text += command.slice(i, stop);
			i = stop;
			continue;
		}
		if (c === "~" && w.raw === "") w.variable = true;
		if (c === "*" || c === "?" || c === "[") w.glob = true;
		// Brace expansion (`{a,b}`, `{1..3}`); `{}` alone, as find -exec gives it, stays a literal.
		if (c === "{") {
			const end = closingBrace(command, i + 1);
			const inner = end < 0 ? "" : command.slice(i + 1, end - 1);
			if (/,|\.\./.test(inner) && !/[\s'"]/.test(inner)) opaque("a brace expansion");
		}
		w.raw += c;
		w.text += c;
		i++;
	}
	endSegment(command.length);
	// A here-document whose line never ends has no body.
	for (const { owner } of hereDocs) owner.opaque ??= "an unterminated here-document";
	// A trailing operator (`ls;`) leaves an empty last segment: drop it, as bash has nothing to run there.
	return segments.filter(
		(s, k) =>
			k === 0 || s.words.length > 0 || s.redirects.length > 0 || s.opaque !== undefined || k < segments.length - 1,
	);
}

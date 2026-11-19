/**
 * fork: code pasted in a user message without fences is shown as one code block, whole.
 *
 * Markdown only knows indented code after a blank line, so in a pasted C function the body lines were text, the
 * indented block after a blank line was code, and `<stdio.h>` could vanish as HTML. The rule: outside fences, a run
 * of lines that reads as code (at least two code lines) is fenced as it is, blank lines and indentation included;
 * a run continues while its braces are open, through indented lines, and across blank lines that lead to more code.
 * Prose, lists and quotes around it stay Markdown. Only the display changes: the model receives the text as typed.
 */

const PREPROCESSOR = /^#\s*(include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|error)\b/;
const LIST_OR_QUOTE = /^([-*+]|\d+[.)])\s|^>/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// A statement or block edge: ends with `;` (not French ` ;`), `{` or `}`, a comment may follow; or starts with `}`.
const STATEMENT = /((?<!\s);|\{)\s*(\/\/.*|\/\*.*\*\/)?$|\}\s*[;,]?\s*(\/\/.*)?$|^\}/;
const BLOCK_HEADER = /^(def|class|if|elif|else|for|while|try|except|finally|with|async def)\b.*:$/;
const COMMENT = /^(\/\/|\/\*|\*\/)/;
// A bare call, `print(total)` or `obj.run(x)`: no prose sentence starts that way.
const CALL = /^[\w.$]+\(.*\)$/;
const HEADER_ABOVE = /^\s*([\w:*&<>,[\] ]+\([^()]*\)(\s*const)?|else|do|try)\s*$/;

function isCodeLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed || LIST_OR_QUOTE.test(trimmed)) return false;
	return (
		PREPROCESSOR.test(trimmed) ||
		STATEMENT.test(trimmed) ||
		BLOCK_HEADER.test(trimmed) ||
		COMMENT.test(trimmed) ||
		CALL.test(trimmed)
	);
}

/** Brace balance of a line, strings, characters and line comments aside. */
function braceDelta(line: string): number {
	let delta = 0;
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = "";
		} else if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === "/" && line[i + 1] === "/") break;
		else if (char === "{") delta++;
		else if (char === "}") delta--;
	}
	return delta;
}

const isIndented = (line: string) => /^[ \t]+\S/.test(line);

/** The end (exclusive) of the code run starting at `start`, and how many code lines it holds. */
function codeRun(lines: readonly string[], start: number): { end: number; codeLines: number } {
	let depth = 0;
	let end = start;
	let codeLines = 0;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE.test(line)) break;
		if (!line.trim()) {
			// A blank line belongs to the run when code follows it.
			let next = i + 1;
			while (next < lines.length && !lines[next]!.trim()) next++;
			const following = lines[next];
			if (following === undefined || FENCE.test(following)) break;
			if (depth > 0 ? !isIndented(following) && !isCodeLine(following) : !isCodeLine(following)) break;
			i = next - 1;
			continue;
		}
		if (depth <= 0 && i > start && !isCodeLine(line) && !isIndented(line)) break;
		if (isCodeLine(line)) codeLines++;
		depth = Math.max(0, depth + braceDelta(line));
		end = i + 1;
	}
	return { end, codeLines };
}

export function fencePastedCode(text: string): string {
	if (!/[;{}]|^#\s*\w|:$/m.test(text)) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let fence = "";
	for (let i = 0; i < lines.length; ) {
		const line = lines[i]!;
		const opener = FENCE.exec(line)?.[1];
		if (fence) {
			if (opener && opener[0] === fence[0] && opener.length >= fence.length && !line.trim().slice(opener.length)) {
				fence = "";
			}
			out.push(line);
			i++;
			continue;
		}
		if (opener) {
			fence = opener;
			out.push(line);
			i++;
			continue;
		}
		if (isCodeLine(line)) {
			const { end, codeLines } = codeRun(lines, i);
			if (codeLines >= 2) {
				// A signature or `else` right above an opening brace on its own line (Allman style) belongs to the code.
				let from = i;
				while (
					from > 0 &&
					out.length > 0 &&
					out.at(-1) === lines[from - 1] &&
					HEADER_ABOVE.test(lines[from - 1]!)
				) {
					out.pop();
					from--;
				}
				// fork: loops, never the block's lines as call arguments.
				let longest = 2;
				for (let at = from; at < end; at++) {
					for (const run of lines[at]!.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
				}
				const marks = "`".repeat(longest + 1);
				out.push(marks);
				for (let at = from; at < end; at++) out.push(lines[at]!);
				out.push(marks);
				i = end;
				continue;
			}
		}
		out.push(line);
		i++;
	}
	return out.join("\n");
}

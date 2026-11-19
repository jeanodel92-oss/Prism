/**
 * fork: whether a shell command may run code that its words do not show.
 *
 * Three things trust a command by its words: an allow rule (`bash(npm run*)`), a command excluded from the sandbox
 * (`sandbox.excludedCommands`) and a variable given to some commands (`passEnv`). Each refused `$(` and backticks,
 * but bash has other ways to run text: `npm run test <(node evil.js)` runs a process substitution, and
 * `${x:=\$\(node evil.js\)} ${x@P}` builds a command substitution from escaped characters and expands it as a prompt.
 * Arithmetic does the same through a variable: once `x` holds `y[$(id)]`, `$((x))`, `[[ x -eq 0 ]]`, `let x`,
 * `declare -i n=x` and `a[x]=1` all run `id`.
 *
 * So a command is trusted by its words only when none of these appear anywhere in it, quoted or not (a quoted one
 * still reaches a variable): what this refuses gets a question instead, which is the safe side.
 */

/** Built-ins that evaluate text as a command or as arithmetic, or fill a variable from outside the command. */
const EVALUATING_BUILTINS = new Set([
	"let",
	"declare",
	"typeset",
	"local",
	"readonly",
	"read",
	"mapfile",
	"readarray",
	"eval",
	"source",
	".",
	"builtin",
	"command",
	"exec",
	"trap",
	"printf",
	"enable",
]);

/**
 * Why `command` may run code its words do not show, or undefined. Plain `$NAME`, `$1` and `$?` stay trusted: their value is
 * split and globbed, never run.
 */
export function unseenCodeReason(command: string): string | undefined {
	if (/[\n\r]/.test(command)) return "it spans several lines";
	if (command.includes("`")) return "it has a command substitution (`…`)";
	if (command.includes("\\")) return "it has an escaped character, which can hide a substitution";
	// `$(`, `${`, `$[`, `$'`, `$"`, or a lone `$`: anything but a plain variable name, a positional parameter or a
	// special one (`$?`, `$#`, `$$`, `$!`, `$@`, `$*`, `$-`), whose values are never run.
	if (/\$(?![A-Za-z_0-9?#$!@*-])/.test(command)) return "it has a substitution or an expansion other than $NAME";
	if (/[<>]\(/.test(command)) return "it has a process substitution (<(…) or >(…))";
	if (command.includes("((")) return "it has an arithmetic evaluation";
	if (command.includes("[[")) return "it has a [[ … ]] test, which evaluates arithmetic";
	if (/\]\+?=/.test(command)) return "it assigns an array element, whose index is evaluated";
	for (const segment of command.split(/&&|\|\||[;&|(){}]/)) {
		const words = segment.trim().split(/\s+/);
		// Past the assignments before the command (`A=1 B=2 cmd`).
		const at = words.findIndex((word) => !/^[A-Za-z_][A-Za-z_0-9]*=/.test(word));
		const first = at >= 0 ? words[at]!.replace(/^['"]|['"]$/g, "") : undefined;
		if (first === undefined || !EVALUATING_BUILTINS.has(first)) continue;
		// Harmless forms: `printf` that only prints, without `-v`
		// (which assigns a variable), and `command -v` / `-V`, a lookup.
		const rest = words.slice(at + 1);
		if (first === "printf" && !rest.includes("-v")) continue;
		if (first === "command" && /^-[vV]$/.test(rest[0] ?? "")) continue;
		return `it runs ${first}, which can evaluate text as code`;
	}
	return undefined;
}

/**
 * fork: for the classifier, which judges what a command does rather than whether a
 * rule covers it: the constructs that turn text into code, without the ordinary ones (`printf`, `$'\n'`, a `\` in a
 * pattern) that `unseenCodeReason` also refuses. Why the command may run built text, or undefined.
 */
export function evaluatedText(command: string): string | undefined {
	if (/\\[$`(]/.test(command)) return "an escaped substitution character";
	if (/\$\{[^}]*[@!]/.test(command)) return "an expansion that evaluates its value (@P, or an indirect !)";
	if (/\$'[^']*\\[0-7xuUc]/.test(command)) return "a character given by its code";
	// fork: bash evaluates an array index and a substring's offset and length as
	// arithmetic, and arithmetic evaluates a variable's text: once `x='a[$(id)]'`, `${y[x]}` runs `id`. Only a
	// number, `@` or `*` is plain; `$[…]` is arithmetic too.
	if (command.includes("$[")) return "an arithmetic expansion ($[…])";
	if (/\$\{#?[A-Za-z_][A-Za-z_0-9]*\[(?!(?:[0-9]+|[@*])\])/.test(command))
		return "an array index, which is evaluated as arithmetic";
	if (/\$\{#?[A-Za-z_][A-Za-z_0-9]*(?:\[[^\]]*\])?:(?![-=?+])(?!\s*-?[0-9]+(?::\s*-?[0-9]+)?\})/.test(command))
		return "a substring offset or length, which is evaluated as arithmetic";
	return undefined;
}

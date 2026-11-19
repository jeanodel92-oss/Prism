/**
 * fork: the simple interface's one line per action, in plain words, instead of every
 * command and tool output in full: the simple interface is for people trying a coding agent for the first time. Built-in tools get a sentence; other tools keep
 * their own header line (undefined here). The command, the parameters and the output stay one ctrl+o
 * or one click away.
 */
import { fill, t } from "../i18n/index.ts";
import { commandSubstitutions, shellSegments } from "../shell-words.ts";
import { visibleText } from "../visible-text.ts";

/**
 * fork: the model's arguments, for display,
 * with each terminal control, line break, bidi and zero-width character shown as the permission question shows it.
 */
function text(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() !== "" ? visibleText(value.trim()) : undefined;
}

/** Words that start a segment without being its program (`if`, `do`, `!`…). */
const LEADING_KEYWORDS = new Set(["!", "if", "then", "else", "elif", "do", "while", "until", "time"]);
/** Words that make a segment run no program of its own (`done`, `for f in a`…). */
const NO_PROGRAM = new Set(["fi", "done", "esac", "for", "select", "case", "in", "{", "}"]);

/**
 * fork: the programs a shell command runs, in order and once each, after
 * `VAR=value` assignments and without their folder, also inside `$(…)`: "npm, git" for `CI=1 npm test && git status`.
 * The action line named only the first, so `echo; rm -rf src` read as "echo".
 */
export function commandPrograms(command: string): string[] {
	const programs: string[] = [];
	const visit = (line: string, depth: number) => {
		for (const segment of shellSegments(line)) {
			let k = 0;
			while (k < segment.words.length && LEADING_KEYWORDS.has(segment.words[k]!.raw)) k++;
			while (k < segment.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment.words[k]!.raw)) k++;
			const word = segment.words[k];
			if (word && !NO_PROGRAM.has(word.raw)) {
				const program = visibleText(word.text.replace(/^.*\//, ""));
				if (program && !programs.includes(program)) programs.push(program);
			}
			if (depth < 4) {
				for (const part of segment.words)
					for (const sub of commandSubstitutions(part.raw)) visit(sub.body, depth + 1);
			}
		}
	};
	visit(command, 0);
	return programs;
}

export function plainAction(toolName: string, args: unknown): string | undefined {
	const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const path = text(input, "path");
	switch (toolName) {
		case "read":
			return path ? fill("Read file {0}", path) : t("Read a file");
		case "edit":
			return path ? fill("Edit file {0}", path) : t("Edit a file");
		case "write":
			return path ? fill("Write file {0}", path) : t("Write a file");
		case "bash": {
			const command = input.command;
			const programs = typeof command === "string" ? commandPrograms(command) : [];
			return programs.length > 0 ? fill("Run a command ({0})", programs.join(", ")) : t("Run a command");
		}
		case "grep": {
			const pattern = text(input, "pattern");
			if (!pattern) return t("Search the files");
			return fill("Search for “{0}” in {1}", pattern, path ?? ".");
		}
		case "find": {
			const pattern = text(input, "pattern");
			return pattern ? fill("Find files {0} in {1}", pattern, path ?? ".") : t("Find files");
		}
		case "ls":
			return fill("List folder {0}", path ?? ".");
		default:
			return undefined;
	}
}

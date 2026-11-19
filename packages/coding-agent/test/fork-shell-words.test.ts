// fork: the shell lexer reads the words bash reads.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shellSegments } from "../src/fork/shell-words.ts";

/** Hand-written words only: bash runs them, so never a real command line from a session. */
const WORDS = [
	`cat "secret alias"`,
	`cat 'secret alias'`,
	`cat secret\\ alias`,
	`cat -- -alias`,
	`p"r"intf -v 'a[x]' %s 1`,
	`printf '-v' x %s`,
	`grep "a|b" f`,
	`echo "x > y" 'a;b' c\\&d`,
	`echo "a\\"b" 'c\\d' "e\\$f" "g\\h"`,
	`cat .[e]nv *.md "*.ts" '?'`,
	`echo a""b ''c "" ''`,
	`find . -name '*.ts' -exec grep -l x {} \\;`,
	`echo "multi
line"`,
	`echo one\\
two`,
	`echo $ "$" a$`,
	`echo -n "tab	in"`,
	`git commit -m "fix: a 'quoted' word"`,
	`echo a#b "#c" # comment`,
];

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-shell-words-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The words bash passes to a program, globbing off so a pattern stays as written. */
function bashWords(command: string): string[] {
	const out = execFileSync("bash", ["--norc", "--noprofile", "-c", `set -f; printf '%s\\0' ${command}`], {
		cwd: dir,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	return out.split("\0").slice(0, -1);
}

describe("fork: shell lexer", () => {
	it.each(WORDS)("reads %j as bash does", (command) => {
		const [segment, ...rest] = shellSegments(command);
		expect(rest).toEqual([]);
		expect(segment!.opaque).toBeUndefined();
		expect(segment!.words.map((word) => word.text)).toEqual(bashWords(command));
	});

	it("cuts at operators outside quotes only", () => {
		const segments = shellSegments(`cd sub && cat "a && b" | wc -l; echo x\nls &`);
		expect(segments.map((s) => s.words.map((w) => w.text))).toEqual([
			["cd", "sub"],
			["cat", "a && b"],
			["wc", "-l"],
			["echo", "x"],
			["ls"],
		]);
		expect(segments.map((s) => s.operator)).toEqual(["&&", "|", ";", "\n", "&"]);
	});

	it("separates redirections and their targets", () => {
		const [segment] = shellSegments(`sort a>out 2>&1 <in &>>log "x"`);
		expect(segment!.words.map((w) => w.text)).toEqual(["sort", "a", "x"]);
		expect(segment!.redirects.map((r) => [r.op, r.target?.text])).toEqual([
			[">", "out"],
			["2>&", "1"],
			["<", "in"],
			["&>>", "log"],
		]);
	});

	it("marks what bash still expands", () => {
		const [segment] = shellSegments(`cat .[e]nv "$PWD/.env" ~/x '$HOME' "*" $(id) \${x:-y}`);
		const flags = segment!.words.map((w) => [w.text, w.glob, w.variable, w.expansion]);
		expect(flags).toEqual([
			["cat", false, false, false],
			[".[e]nv", true, false, false],
			// A plain variable is written braced, so the letters after it stay apart.
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a template
			["${PWD}/.env", false, true, false],
			["~/x", false, true, false],
			["$HOME", false, false, false],
			["*", false, false, false],
			["$(id)", false, false, true],
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
			["${x:-y}", false, false, true],
		]);
	});

	it("keeps a variable apart from the letters after it", () => {
		const [segment] = shellSegments(`cat "$S"v $T.x "\${U}"w`);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell variables, not templates
		expect(segment!.words.map((w) => w.text)).toEqual(["cat", "${S}v", "${T}.x", "${U}w"]);
	});

	it.each([
		[`cat 'open`, "an unclosed quote"],
		[`cat <<EOF\nls`, "an unterminated here-document"],
		[`cat <<EOF`, "an unterminated here-document"],
		[`echo $'\\x41'`, "a $'…' string"],
		[`{ ls; }`, "a { … } group"],
		[`echo {a,b}`, "a brace expansion"],
		[`((x = y))`, "an arithmetic evaluation"],
	])("makes %j opaque (%s)", (command, why) => {
		expect(shellSegments(command)[0]!.opaque).toBe(why);
	});

	it("reads a here-document's body as data, up to its delimiter", () => {
		const command = `cat <<'EOF' > out.txt | wc -l\nrm -rf x\n\tEOF\nEOF\nls -la`;
		const segments = shellSegments(command);
		expect(segments.map((s) => s.words.map((w) => w.text))).toEqual([["cat"], ["wc", "-l"], ["ls", "-la"]]);
		expect(segments.every((s) => s.opaque === undefined)).toBe(true);
		const [hereDoc, out] = segments[0]!.redirects;
		expect(hereDoc!.hereDoc).toMatchObject({ body: "rm -rf x\n\tEOF\n", expands: false });
		expect(out!.target!.text).toBe("out.txt");
		expect(command.slice(segments[2]!.start, segments[2]!.end)).toBe("ls -la");
	});

	it("strips leading tabs before the delimiter of <<- and marks an unquoted one as expanded", () => {
		const [segment] = shellSegments(`cat <<-END\n\tline $HOME\n\tEND`);
		expect(segment!.redirects[0]!.hereDoc).toMatchObject({ body: "\tline $HOME\n", expands: true });
		expect(segment!.opaque).toBeUndefined();
	});

	it("gives each segment its place in the line", () => {
		const command = `cd sub && grep "a|b" f | head -2`;
		expect(shellSegments(command).map((s) => command.slice(s.start, s.end).trim())).toEqual([
			"cd sub",
			`grep "a|b" f`,
			"head -2",
		]);
	});
});

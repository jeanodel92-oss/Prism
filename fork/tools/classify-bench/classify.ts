// Classification bench for shell commands. Test tooling only.
//
// Runs the permission gate's decision for `bash` on a corpus of commands, with no session, model or sandbox, and
// counts what it asks. Usage (from the repository root):
//
//   node --import ./packages/coding-agent/src/experimental/source-resolver.ts fork/tools/classify-bench/classify.ts \
//     run <corpus.tsv | corpus.jsonl> <out dir> [--modes ask,broad] [--shard i/n]
//   node --import … classify.ts summarize <out.md> <results.jsonl>...
//   node --import … classify.ts compare <before.jsonl> <after.jsonl> [<out.md>]
//
// A `.tsv` corpus is the common one: `expected<TAB>command`, judged in a fixture project. A `.jsonl` corpus comes from
// extract.py: `{command, count, cwd}`, judged in its session's folder when it still exists, else in a throwaway one.
// The agent dir is always a throwaway empty one, so the maintainer's own rules never count: the shipped settings are measured.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV_AGENT_DIR } from "../../../packages/coding-agent/src/config.ts";
import { decidePermission, type Mode } from "../../../packages/coding-agent/src/fork/permissions.ts";
import { realPath } from "../../../packages/coding-agent/src/fork/real-path.ts";
import { type ShellSegment, shellSegments } from "../../../packages/coding-agent/src/fork/shell-words.ts";

export type Tier = "allow" | "ask" | "danger";

export interface CorpusEntry {
	command: string;
	count: number;
	/** The session's folder, when the corpus gives one. */
	cwd?: string;
	/** The verdict expected in ask mode (common corpus only). */
	expected?: Tier;
	/** Today's verdict, when the shell lexer of session 3b is expected to change it (common corpus only). */
	today?: Tier;
}

export interface Result {
	command: string;
	count: number;
	mode: Mode;
	effect: string;
	tier: Tier;
	reason: string;
	/** Where the command was judged: its session's folder, the fixture project or a throwaway folder. */
	where: "session" | "fixture" | "throwaway";
	expected?: Tier;
	today?: Tier;
}

const TIERS = new Set<string>(["allow", "ask", "danger"]);

/** The common corpus: `expected[/today]<TAB>command` lines; `#` comments and blank lines skipped. */
export function readCommonCorpus(path: string): CorpusEntry[] {
	const entries: CorpusEntry[] = [];
	for (const [n, line] of readFileSync(path, "utf8").split("\n").entries()) {
		if (!line.trim() || line.startsWith("#")) continue;
		const tab = line.indexOf("\t");
		const [expected, today, extra] = line.slice(0, Math.max(tab, 0)).split("/");
		if (tab < 0 || !TIERS.has(expected!) || (today !== undefined && !TIERS.has(today)) || extra !== undefined) {
			throw new Error(`${path}:${n + 1}: expected "allow|ask|danger[/allow|ask|danger]<TAB>command"`);
		}
		entries.push({ command: line.slice(tab + 1), count: 1, expected: expected as Tier, today: today as Tier | undefined });
	}
	return entries;
}

export interface Fixture {
	home: string;
	project: string;
	agentDir: string;
	cleanup(): void;
}

/**
 * A neutral project for the common corpus: sources, docs, a `.env` and a link to it, a Git folder, and a home with an
 * SSH key. HOME and the agent dir point into it until cleanup.
 */
export function makeFixture(): Fixture {
	const root = realPath(mkdtempSync(join(tmpdir(), "prism-classify-bench-")));
	const home = join(root, "home");
	const project = join(home, "project");
	const agentDir = join(home, ".prism", "agent");
	for (const dir of [agentDir, join(home, ".ssh"), join(project, ".git"), join(project, "src"), join(project, "docs")]) {
		mkdirSync(dir, { recursive: true });
	}
	const files: Record<string, string> = {
		"home/.ssh/id_ed25519": "key",
		"home/project/.env": "TOKEN=x\n",
		"home/project/.git/config": "[core]\n",
		"home/project/package.json": '{"name":"demo","scripts":{"test":"vitest"}}\n',
		"home/project/README.md": "# demo\n",
		"home/project/notes.txt": "b\na\n",
		"home/project/data.json": '{"a":1}\n',
		"home/project/config.yml": "a: 1\n",
		"home/project/src/index.ts": "export const a = 1;\n",
		"home/project/src/app.ts": "export const b = 2;\n",
		"home/project/docs/guide.md": "# guide\n",
		"home/project/Makefile": "all:\n\ttrue\n",
	};
	for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
	symlinkSync(".env", join(project, "settings-link"));
	const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };
	process.env.HOME = home;
	process.env[ENV_AGENT_DIR] = agentDir;
	return {
		home,
		project,
		agentDir,
		cleanup() {
			if (saved.home === undefined) delete process.env.HOME;
			else process.env.HOME = saved.home;
			if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = saved.agentDir;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The gate's verdict for one command. */
export function classify(command: string, cwd: string, mode: Mode): Pick<Result, "effect" | "tier" | "reason"> {
	const { effect, tier, reason } = decidePermission("bash", { command }, cwd, { mode });
	return { effect, tier: tier as Tier, reason };
}

// ---------------------------------------------------------------------------
// Command forms: the head of each command and its options, operands masked. A form goes in reports, never the
// command itself, which may hold paths and tokens.
// ---------------------------------------------------------------------------

const SUBCOMMAND_PROGRAMS = new Set([
	"git",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"cargo",
	"go",
	"docker",
	"podman",
	"kubectl",
	"gh",
	"systemctl",
	"journalctl",
	"pip",
	"uv",
	"dnf",
	"apt",
	"flatpak",
	"hyprctl",
	"tmux",
]);
const STANDARD_BIN = /^\/(usr\/)?(local\/)?s?bin\//;

function segmentForm(segment: ShellSegment): string {
	const out: string[] = [];
	let program: string | undefined;
	let subcommand = false;
	for (const word of segment.words) {
		const text = word.text;
		if (program === undefined) {
			const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(text);
			if (assignment) {
				out.push(`${assignment[1]}=_`);
				continue;
			}
			program = text.includes("/") ? (STANDARD_BIN.test(text) ? basename(text) : "<path>") : text;
			if (word.variable || word.expansion) program = "<expansion>";
			out.push(program);
			subcommand = SUBCOMMAND_PROGRAMS.has(program);
			continue;
		}
		if (/^--?[A-Za-z]/.test(text)) {
			const eq = text.indexOf("=");
			const option = eq < 0 ? text : `${text.slice(0, eq)}=_`;
			out.push(/^-[^-]/.test(option) && option.length > 8 ? `${option.slice(0, 2)}_` : option.slice(0, 40));
			continue;
		}
		if (subcommand && /^[a-z][a-z0-9-]{0,24}$/.test(text)) {
			out.push(text);
			subcommand = false;
			continue;
		}
		subcommand = false;
		if (out[out.length - 1] !== "_") out.push("_");
	}
	for (const redirect of segment.redirects) out.push(`${redirect.op}_`);
	const form = out.join(" ") || "(empty)";
	return segment.opaque ? `${form} (opaque)` : form;
}

/** The form of a command line: each segment's form with its operator, four segments at most. */
export function commandForm(command: string): string {
	const segments = shellSegments(command).filter((s) => s.words.length > 0 || s.redirects.length > 0);
	const parts = segments.slice(0, 4).map((s, k) => {
		const operator = k < segments.length - 1 && s.operator ? ` ${s.operator === "\n" ? ";" : s.operator}` : "";
		return `${segmentForm(s)}${operator}`;
	});
	return segments.length > 4 ? `${parts.join(" ")} …` : parts.join(" ");
}

// ---------------------------------------------------------------------------
// Census of the causes the correction (session 3b) will address, among the commands allowed today.
// ---------------------------------------------------------------------------

const WRAPPER_NAMES = new Set(["nohup", "time", "setsid", "exec", "command", "nice", "ionice", "stdbuf", "env", "timeout", "xargs"]);

/** The programs a segment runs, through assignments and wrappers (their options skipped roughly). */
function programsOf(segment: ShellSegment): Array<{ name: string; args: string[] }> {
	const words = segment.words.map((w) => w.text);
	const found: Array<{ name: string; args: string[] }> = [];
	let i = 0;
	while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
	while (i < words.length) {
		const name = basename(words[i]!);
		found.push({ name, args: words.slice(i + 1) });
		if (!WRAPPER_NAMES.has(name)) break;
		i++;
		while (i < words.length && words[i]!.startsWith("-")) i++;
		if (name === "timeout") i++;
	}
	return found;
}

export const CAUSES = [
	"glob word",
	"variable word ($NAME or ~)",
	"quoted word with a space",
	"cd, then a relative operand",
	"xargs",
	"printf -v",
	"yq",
	"time",
	"time writing a file (-o, --output)",
	"env -C / --chdir",
	"opaque for the lexer",
] as const;

export function causesOf(command: string): Set<(typeof CAUSES)[number]> {
	const causes = new Set<(typeof CAUSES)[number]>();
	const segments = shellSegments(command);
	let changedDir = false;
	for (const segment of segments) {
		if (segment.opaque) causes.add("opaque for the lexer");
		const words = segment.words.slice(1);
		if (segment.words.some((w) => w.glob)) causes.add("glob word");
		if (segment.words.some((w) => w.variable)) causes.add("variable word ($NAME or ~)");
		if (segment.words.some((w) => w.quoted && /\s/.test(w.text))) causes.add("quoted word with a space");
		const programs = programsOf(segment);
		const last = programs[programs.length - 1];
		if (
			changedDir &&
			last &&
			last.name !== "cd" &&
			words.some((w) => !w.text.startsWith("-") && !w.text.startsWith("/") && !w.variable && w.text !== "")
		) {
			causes.add("cd, then a relative operand");
		}
		for (const { name, args } of programs) {
			if (name === "cd" || name === "pushd") changedDir = true;
			if (name === "xargs") causes.add("xargs");
			if (name === "printf" && args.includes("-v")) causes.add("printf -v");
			if (name === "yq") causes.add("yq");
			if (name === "time") {
				causes.add("time");
				if (args.some((a) => a === "-o" || a.startsWith("--o") || /^-[a-z]*o/.test(a))) {
					causes.add("time writing a file (-o, --output)");
				}
			}
			if (name === "env" && args.some((a) => a === "-C" || a.startsWith("--ch") || /^-C./.test(a))) {
				causes.add("env -C / --chdir");
			}
		}
	}
	return causes;
}

// ---------------------------------------------------------------------------
// Runs and reports
// ---------------------------------------------------------------------------

function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as T);
}

const percent = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)} %` : "-");

function table(header: string[], rows: Array<Array<string | number>>): string {
	return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join(
		"\n",
	);
}

/** A gate reason without its preamble, and without the paths it names (a real command's paths stay out of reports). */
const shortReason = (reason: string) =>
	reason
		.replace(/^This action (may be dangerous|needs your permission): /, "")
		.replace(/\(([^()]*\/[^()]*)\)/g, "(…)")
		.replace(/^(\S*\/\S*)( \(program run by path\))$/, "<path>$2");

const cell = (text: string) => `\`${text.replaceAll("|", "\\|").replaceAll("`", "'")}\``;

export function summarize(results: Result[], title: string): string {
	const lines = [`# ${title}`, ""];
	const modes = [...new Set(results.map((r) => r.mode))];
	lines.push("## Verdicts", "");
	const rows: Array<Array<string | number>> = [];
	for (const mode of modes) {
		const of = results.filter((r) => r.mode === mode);
		const total = of.length;
		const weight = of.reduce((n, r) => n + r.count, 0);
		for (const tier of ["allow", "ask", "danger"] as const) {
			const hit = of.filter((r) => r.tier === tier);
			const w = hit.reduce((n, r) => n + r.count, 0);
			const prompted = hit.filter((r) => r.effect !== "allow").length;
			rows.push([mode, tier, hit.length, percent(hit.length, total), w, percent(w, weight), prompted]);
		}
	}
	lines.push(table(["mode", "tier", "distinct", "%", "occurrences", "%", "of which asked"], rows), "");

	const ask = results.filter((r) => r.mode === modes[0]);
	const byForm = new Map<string, { count: number; distinct: number; reasons: Map<string, number> }>();
	for (const r of ask) {
		if (r.effect === "allow") continue;
		const form = commandForm(r.command);
		const entry = byForm.get(form) ?? { count: 0, distinct: 0, reasons: new Map() };
		entry.count += r.count;
		entry.distinct++;
		const reason = shortReason(r.reason);
		entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + r.count);
		byForm.set(form, entry);
	}
	const top = [...byForm.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 50);
	lines.push(`## The 50 command forms asked most in ${modes[0]} mode`, "");
	lines.push(
		table(
			["form", "occurrences", "distinct", "main reason"],
			top.map(([form, e]) => {
				const reason = [...e.reasons.entries()].sort((a, b) => b[1] - a[1])[0]![0];
				return [cell(form), e.count, e.distinct, cell(reason)];
			}),
		),
		"",
	);

	lines.push(`## Census among the commands allowed in ${modes[0]} mode`, "");
	const allowed = ask.filter((r) => r.tier === "allow");
	const census = new Map<string, { distinct: number; count: number }>();
	for (const r of allowed) {
		for (const cause of causesOf(r.command)) {
			const entry = census.get(cause) ?? { distinct: 0, count: 0 };
			entry.distinct++;
			entry.count += r.count;
			census.set(cause, entry);
		}
	}
	const allowedWeight = allowed.reduce((n, r) => n + r.count, 0);
	lines.push(
		table(
			["cause", "distinct", "occurrences", "% of allowed occurrences"],
			CAUSES.map((cause) => {
				const e = census.get(cause) ?? { distinct: 0, count: 0 };
				return [cause, e.distinct, e.count, percent(e.count, allowedWeight)];
			}),
		),
		"",
	);

	if (ask.some((r) => r.expected)) {
		const unexpected = ask.filter((r) => r.expected && (r.today ?? r.expected) !== r.tier);
		const known = ask.filter((r) => r.today && r.today === r.tier);
		lines.push("## Expected verdicts (common corpus)", "");
		lines.push(
			unexpected.length === 0
				? "Every verdict is the one the corpus states."
				: table(
						["command", "expected", "today (stated)", "got", "reason"],
						unexpected.map((r) => [cell(r.command), r.expected!, r.today ?? "", r.tier, cell(r.reason)]),
					),
			"",
			`Known differences left to the shell lexer (session 3b): ${known.length}.`,
			"",
		);
	}
	return lines.join("\n");
}

/** Commands whose verdict changes between two runs, weighted, grouped by direction and reason. */
export function compare(before: Result[], after: Result[]): string {
	const key = (r: Result) => `${r.mode}\0${r.command}`;
	const old = new Map(before.map((r) => [key(r), r]));
	const groups = new Map<string, { count: number; distinct: number; forms: Map<string, number> }>();
	for (const r of after) {
		const was = old.get(key(r));
		if (!was || was.tier === r.tier) continue;
		const reason = shortReason((RANK[r.tier] > RANK[was.tier] ? r : was).reason);
		const group = `${r.mode}: ${was.tier} → ${r.tier} (${reason})`;
		const entry = groups.get(group) ?? { count: 0, distinct: 0, forms: new Map() };
		entry.count += r.count;
		entry.distinct++;
		const form = commandForm(r.command);
		entry.forms.set(form, (entry.forms.get(form) ?? 0) + r.count);
		groups.set(group, entry);
	}
	const rows = [...groups.entries()]
		.sort((a, b) => b[1].count - a[1].count)
		.map(([group, e]) => {
			const forms = [...e.forms.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([form, n]) => `${cell(form)} ×${n}`)
				.join(", ");
			return [group, e.distinct, e.count, forms];
		});
	return ["# Verdict changes", "", rows.length ? table(["change", "distinct", "occurrences", "top forms"], rows) : "No change.", ""].join(
		"\n",
	);
}

const RANK: Record<Tier, number> = { allow: 0, ask: 1, danger: 2 };

export function runCorpus(entries: CorpusEntry[], modes: Mode[], fixture: Fixture | undefined): Result[] {
	const throwaway = realPath(mkdtempSync(join(tmpdir(), "prism-classify-cwd-")));
	const results: Result[] = [];
	try {
		for (const entry of entries) {
			const where: Result["where"] = fixture ? "fixture" : entry.cwd ? "session" : "throwaway";
			const cwd = fixture ? fixture.project : (entry.cwd ?? throwaway);
			for (const mode of modes) {
				let verdict: Pick<Result, "effect" | "tier" | "reason">;
				try {
					verdict = classify(entry.command, cwd, mode);
				} catch (error) {
					verdict = { effect: "error", tier: "danger", reason: `classifier threw: ${(error as Error).message}` };
				}
				results.push({
					command: entry.command,
					count: entry.count,
					mode,
					...verdict,
					where,
					expected: entry.expected,
					today: entry.today,
				});
			}
		}
	} finally {
		rmSync(throwaway, { recursive: true, force: true });
	}
	return results;
}

function main(argv: string[]): void {
	const [action, ...rest] = argv;
	if (action === "run") {
		const [corpus, outDir] = rest;
		if (!corpus || !outDir) throw new Error("usage: classify.ts run <corpus.tsv|corpus.jsonl> <out dir> [--modes ask,broad]");
		const modesAt = rest.indexOf("--modes");
		const modes = (modesAt >= 0 ? rest[modesAt + 1]! : "ask,broad").split(",") as Mode[];
		// `--shard i/n`: every n-th entry from the i-th (1-based), written as a part; `summarize` merges the parts.
		const shardAt = rest.indexOf("--shard");
		const [shard, shards] = shardAt >= 0 ? rest[shardAt + 1]!.split("/").map(Number) : [1, 1];
		if (!(shard! >= 1 && shard! <= shards!)) throw new Error("--shard takes i/n, with 1 <= i <= n");
		mkdirSync(outDir, { recursive: true });
		const common = corpus.endsWith(".tsv");
		const realHome = process.env.HOME;
		const fixture = makeFixture();
		// A real command is judged with the real home (its `~` and credential folders), the agent dir still empty.
		if (!common) process.env.HOME = realHome;
		let results: Result[];
		try {
			const entries = (common ? readCommonCorpus(corpus) : readJsonl<CorpusEntry>(corpus)).filter(
				(_entry, k) => k % shards! === shard! - 1,
			);
			results = runCorpus(entries, modes, common ? fixture : undefined);
		} finally {
			fixture.cleanup();
		}
		const name = basename(corpus).replace(/\.(tsv|jsonl)$/, "");
		const lines = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
		if (shards! > 1) {
			writeFileSync(join(outDir, `${name}.results.part${shard}of${shards}.jsonl`), lines);
			console.log(`${results.length} verdicts (part ${shard} of ${shards})`);
			return;
		}
		writeFileSync(join(outDir, `${name}.results.jsonl`), lines);
		writeFileSync(join(outDir, `${name}.summary.md`), summarize(results, `Classification of ${name}`));
		console.log(`${results.length} verdicts → ${join(outDir, `${name}.summary.md`)}`);
		return;
	}
	if (action === "summarize") {
		const [out, ...parts] = rest;
		if (!out || parts.length === 0) throw new Error("usage: classify.ts summarize <out.md> <results.jsonl>...");
		const results = parts.flatMap((part) => readJsonl<Result>(part));
		writeFileSync(out, summarize(results, `Classification of ${basename(out).replace(/\.summary\.md$/, "")}`));
		console.log(`${results.length} verdicts → ${out}`);
		return;
	}
	if (action === "compare") {
		const [before, after, out] = rest;
		if (!before || !after) throw new Error("usage: classify.ts compare <before.jsonl> <after.jsonl> [<out.md>]");
		const report = compare(readJsonl<Result>(before), readJsonl<Result>(after));
		if (out) {
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, report);
		} else console.log(report);
		return;
	}
	throw new Error("usage: classify.ts run|compare …");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));

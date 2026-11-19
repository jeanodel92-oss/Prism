// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell expansions written as the model sends them
// fork: shell commands the permission gate let run without a question,
// though they ran what a question is meant to cover. The commands are the audit's
//; each must now ask, and the ordinary forms still pass.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { decidePermission, type Mode } from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";
import { findBlockedCommandSegment } from "../vendor/forks/pi-plan-mode/dist/chunks/chunk-L2CXUWCH.ts";

let root: string;
let project: string;
/** A repository received as an archive: its own .git/config names programs. */
let received: string;
/** An ordinary repository, Husky's hooks folder and a textconv-free configuration. */
let ordinary: string;
const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };

beforeAll(() => {
	root = realPath(mkdtempSync(join(tmpdir(), "prism-audit-gate-")));
	const home = join(root, "home");
	project = join(home, "project");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(join(project, ".git"), { recursive: true });
	writeFileSync(join(project, "README.md"), "hello\n");
	const git = (dir: string, ...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], {
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
		});
	received = join(root, "received");
	ordinary = join(root, "ordinary");
	for (const dir of [received, ordinary]) git(root, "init", "-q", dir);
	appendFileSync(join(received, ".git", "config"), "[core]\n\tfsmonitor = touch pwned\n");
	git(ordinary, "config", "core.hooksPath", ".husky/_");
	git(ordinary, "config", "core.fsmonitor", "true");
	git(ordinary, "config", "alias.st", "status");
	process.env.HOME = home;
	process.env[ENV_AGENT_DIR] = join(home, ".pi", "agent");
});

afterAll(() => {
	process.env.HOME = saved.home;
	if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved.agentDir;
	rmSync(root, { recursive: true, force: true });
});

const bash = (command: string, mode: Mode = "ask") => decidePermission("bash", { command }, project, { mode });

describe("fork: security audit of fork.12, the bash gate", () => {
	describe("AS-004: an awk program taken for one that only prints", () => {
		it.each([
			`awk 'BEGIN{ print /"/; print "touch PWN" | "/bin/sh"; y = /"/ }'`,
			`awk 'BEGIN{ print /"/; print "x" > "PWN"; y = /"/ }'`,
			`awk 'BEGIN{x=1} /"/ {} END{ print "x" > "PWN"; y = /"/ }' README.md`,
			`awk 'BEGIN{ if (1) /"/; print "x" > "PWN"; y = /"/ }'`,
			`awk 'BEGIN{ return /"/; print "x" > "PWN"; y = /"/ }'`,
			`awk 'BEGIN{ x++ /"/; print "x" > "PWN"; y = /"/ }'`,
		])("asks for %s", (command) => {
			expect(bash(command)).toMatchObject({ effect: "prompt" });
		});

		it.each([
			"awk '{print $1}' README.md",
			"awk '{print ($1+$2)/2}' README.md",
			"awk '{print $1/2, x / y}' README.md",
			"awk '/re/ {print} END {print NR}' README.md",
			"awk '{ if ($1 ~ /x/) print $2 }' README.md",
			"awk '{ a[$1] / 2 }' README.md",
			`awk -F, 'NR>1 {s+=$2} END {print s / NR, "a/b"}' README.md`,
		])("still allows the read-only %s", (command) => {
			expect(bash(command).effect).toBe("allow");
		});
	});

	describe("AS-005: an array index or a substring offset evaluated as arithmetic", () => {
		it.each([
			"x='a[$(touch PWN)]'; echo ${y[x]}",
			"x='a[$(touch PWN)]'; true ${y[x]}",
			"x='a[$(touch PWN)]'; echo $[x]",
			"echo ${y['a[$(touch PWN)]']}",
			"x='a[$(touch PWN)]'; echo ${y:x}",
			"x='a[$(touch PWN)]'; echo ${y:0:x}",
			"x='a[$(touch PWN)]'; echo ${#y[x]}",
		])("asks for %s", (command) => {
			expect(bash(command)).toMatchObject({ effect: "prompt" });
		});

		// `${y[@]}` already asked before (an `@` in an expansion); `${y:=x}` with another `${y` too (set and read).
		it.each(["echo ${y[0]} ${#y[12]}", "echo ${y:1} ${y:0:2} ${y: -1} ${y:-default} ${y:+set}", "echo ${z:=x}"])(
			"still allows %s",
			(command) => {
				expect(bash(command).effect).toBe("allow");
			},
		);
	});

	describe("AS-006: an exported variable changed before a command", () => {
		it.each([
			"PATH=$PWD/bin:$PATH; ls",
			"PATH=bin:$PATH && ls",
			"HOME=$PWD/h; git status",
			"HOME=$PWD/h; man ls",
			"export XDG_CONFIG_HOME=$PWD/h; git status",
			"LESSOPEN='|touch PWN; cat %s'; export LESSOPEN; less README.md",
		])("asks for %s", (command) => {
			expect(bash(command)).toMatchObject({ effect: "prompt" });
		});

		it.each(["S=README.md; cat $S", "cd . && ls", "(PATH=x); ls"])("still allows %s", (command) => {
			expect(bash(command).effect).toBe("allow");
		});
	});

	describe("AS-007: man with an option that runs a program or reads another file", () => {
		it.each([
			"man -C manrc ls",
			"man --config-file=manrc ls",
			"man --conf manrc ls",
			"man -l page.1",
			"man --local-file page.1",
			"man -M ./pages ls",
			"man -Pcat ls",
			"man -aC manrc ls",
		])("asks for %s", (command) => {
			expect(bash(command)).toMatchObject({ effect: "prompt" });
		});

		it.each(["man ls", "man 5 passwd", "man -k printf", "man -s 3 printf", "man -a -w ls", "man --sections=1,8 ls"])(
			"still allows %s",
			(command) => {
				expect(bash(command).effect).toBe("allow");
			},
		);
	});

	describe("AS-008: Git running a program its repository's configuration names", () => {
		const git = (command: string, cwd: string) => decidePermission("bash", { command }, cwd, { mode: "ask" });

		it.each(["git status", "git diff", "git log -p -1", "git show"])(
			"asks for %s in such a repository",
			(command) => {
				expect(git(command, received)).toMatchObject({ effect: "prompt" });
			},
		);

		it("asks when the configuration comes from a file it includes", () => {
			const included = join(root, "included");
			execFileSync("git", ["init", "-q", included]);
			writeFileSync(join(included, "conf"), '[diff "x"]\n\ttextconv = ./run.sh\n');
			appendFileSync(join(included, ".git", "config"), "[include]\n\tpath = ../conf\n");
			expect(git("git diff", included)).toMatchObject({ effect: "prompt" });
		});

		it("still allows Git where the configuration names no program (Husky's hooks, an alias, the built-in fsmonitor)", () => {
			expect(git("git status", ordinary).effect).toBe("allow");
			expect(git("git log --oneline", ordinary).effect).toBe("allow");
		});
	});

	describe("AS-019: Plan mode's read-only commands", () => {
		const blocked = (command: string) => findBlockedCommandSegment(command, {}, "/work", "linux") !== undefined;

		it.each([
			`python3 -c 'open("f","w").write("x")' --version`,
			`node -e 'require("fs").writeFileSync("f","x")' -- --version`,
			"python3 helper.py --version",
			"rg --hostname-bin ./helper.sh --hyperlink-format 'file://{host}{path}' hello .",
			"rg --hostname-bin=./helper.sh hello .",
			"npm test --script-shell=./helper.sh",
			"npm run test --node-options=--require=./x.js",
			"pytest --basetemp=docs",
			"pytest --junitxml=out.xml",
			"pytest -p evil_plugin",
			"go test -exec ./helper.sh ./...",
			"go test -o bin ./...",
			"cargo test --config build.rustc-wrapper='./helper.sh'",
			"cargo test -- --logfile out.txt",
			"vitest run --outputFile=out.json --reporter=json",
			"jest --outputFile=out.json",
		])("blocks %s", (command) => {
			expect(blocked(command)).toBe(true);
		});

		it.each([
			"python3 --version",
			"node --version",
			"npm test",
			"npm run test -- --watch=false",
			"npm test --silent",
			"cargo test -p core --release -- --nocapture --test-threads=1 parse",
			"go test ./... -run TestParse -v -count=1",
			"pytest -k parse -x -q tests/test_parse.py",
			"vitest run src/a.test.ts -t parse",
			"jest --ci src/a.test.ts",
			"rg -n hello .",
		])("still allows %s", (command) => {
			expect(blocked(command)).toBe(false);
		});
	});
});

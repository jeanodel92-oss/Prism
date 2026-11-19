// fork: permission gate decisions found wrong by the code review of 2026-10-20
//.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { decidePermission, type Mode } from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";

describe("fork: permission gate classifier", () => {
	let root: string;
	let home: string;
	let agentDir: string;
	let project: string;
	const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };

	beforeEach(() => {
		root = realPath(mkdtempSync(join(tmpdir(), "prism-perm-classifier-")));
		home = join(root, "home");
		agentDir = join(home, ".pi", "agent");
		project = join(home, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(home, ".ssh"));
		mkdirSync(join(project, ".git"), { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), "{}");
		writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
		writeFileSync(join(project, "notes.txt"), "b\na\n");
		process.env.HOME = home;
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		process.env.HOME = saved.home;
		if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved.agentDir;
		rmSync(root, { recursive: true, force: true });
	});

	const decide = (
		tool: string,
		input: Record<string, unknown>,
		mode: Mode,
		rules: { allow?: string[]; deny?: string[] } = {},
	) => decidePermission(tool, input, project, { mode, ...rules });
	const bash = (command: string, mode: Mode, rules: { allow?: string[]; deny?: string[] } = {}) =>
		decide("bash", { command }, mode, rules);

	describe("C1: paths are resolved like the tools resolve them", () => {
		it.each<[string, Record<string, unknown>, Mode]>([
			["read", { path: "~/.pi/agent/auth.json" }, "ask"],
			["read", { path: "@~/.pi/agent/auth.json" }, "ask"],
			["write", { path: "~/.bashrc", content: "x" }, "ask"],
			["write", { path: "~/.bashrc", content: "x" }, "broad"],
		])("%s %j in %s mode asks as dangerous", (tool, input, mode) => {
			expect(decide(tool, input, mode)).toMatchObject({ effect: "prompt", tier: "danger" });
		});

		// fork: path expansion still resolves configuration, now refused without a question.
		it("refuses an edit to the expanded configuration path", () => {
			expect(decide("edit", { path: "~/.pi/agent/settings.json", edits: [] }, "broad")).toMatchObject({
				effect: "block",
				reason: expect.stringContaining("configure_prism"),
			});
		});

		it("still lets a write inside the project ask as an ordinary write", () => {
			expect(decide("write", { path: "@notes.txt", content: "x" }, "ask")).toMatchObject({
				effect: "prompt",
				tier: "ask",
				reason: expect.stringContaining("write inside project"),
			});
		});
	});

	// `git branch` without -d/-D and all of `git reflog` were read-only.
	describe("git branch and reflog forms that change refs", () => {
		const changing = [
			"git branch -f topic HEAD~1",
			"git branch --force topic HEAD~1",
			"git branch -m old new",
			"git branch -M new",
			"git branch -c old copy",
			"git branch --copy old copy",
			"git branch new-branch",
			"git branch -u origin/main",
			"git branch --set-upstream-to=origin/main",
			"git branch --unset-upstream",
			"git branch -df topic",
			"git reflog expire --expire=now --all",
			"git reflog delete HEAD@{1}",
			"git reflog drop main",
		];
		it.each(changing)("asks for %j in ask mode", (command) => {
			expect(bash(command, "ask").effect).toBe("prompt");
		});
		it.each(changing)("blocks %j in safe mode", (command) => {
			expect(bash(command, "safe").effect).not.toBe("allow");
		});
		it.each([
			"git branch",
			"git branch -a",
			"git branch -vv",
			"git branch -r",
			"git branch --list 'feat*'",
			"git branch -l 'feat*'",
			"git branch --contains HEAD",
			"git branch --merged main",
			"git branch --sort -committerdate",
			"git branch --format '%(refname:short)'",
			"git branch --show-current",
			"git reflog",
			"git reflog show main",
			"git reflog -n 5",
			"git reflog exists main",
		])("still allows %j", (command) => {
			expect(bash(command, "ask").effect).toBe("allow");
		});
	});

	describe("H1: known-safe commands that write or run through an option", () => {
		const risky = [
			"sort -o notes.txt notes.txt",
			"sort --output=notes.txt notes.txt",
			"uniq notes.txt out.txt",
			"tree -o out.txt",
			"find . -fprint out.txt",
			"git diff --output=out.txt",
			"git ls-remote --upload-pack='touch pwned' .",
			"rg --pre ./script.sh x",
			"man -P 'touch pwned' ls",
			"yq -i '.a = 1' f.yaml",
			"GIT_EXTERNAL_DIFF=rm git diff",
			"printenv",
			"env",
		];
		it.each(risky)("asks for %j in ask mode", (command) => {
			expect(bash(command, "ask").effect).toBe("prompt");
		});
		it.each(risky)("blocks %j in safe mode", (command) => {
			expect(bash(command, "safe").effect).not.toBe("allow");
		});

		it.each([
			"cat ~/.pi/agent/auth.json",
			"cat $HOME/.pi/agent/auth.json",
			"head -c 100 ~/.ssh/id_ed25519",
			"cat ~/.pi/agent/*",
			"rg token ~/.pi",
			"grep -r token ~",
		])("treats %j as dangerous (credentials)", (command) => {
			expect(bash(command, "ask")).toMatchObject({ effect: "prompt", tier: "danger" });
		});

		it.each([
			"ls -la",
			"git status",
			"git log --oneline -5",
			"sort notes.txt",
			"uniq notes.txt",
			"sort notes.txt | uniq -c",
			"rg foo .",
			"cat notes.txt",
			"cd sub && ls",
			"grep -n foo notes.txt 2>/dev/null",
			"jq .key data.json",
			"command -v node",
		])("still runs %j without asking", (command) => {
			expect(bash(command, "ask").effect).toBe("allow");
		});
	});

	describe("H2: dangerous commands behind wrappers, paths, quoting or shell syntax", () => {
		it.each([
			"timeout 60 sudo id",
			"timeout -s KILL 5 sudo id",
			"env FOO=1 rm -rf ../important",
			"/usr/bin/sudo id",
			"\\rm -rf ../important",
			"'sudo' id",
			"echo x | xargs rm -rf",
			"nice -n 5 rm -rf ../important",
			"stdbuf -oL sudo id",
			"echo x > $HOME/.bashrc",
			"echo x >| /home/x/.bashrc",
			"echo x &> ~/.bashrc",
			"true & sudo id",
			"(sudo id)",
			"if true; then sudo id; fi",
			"bash -c 'sudo id'",
			"eval 'sudo id'",
			"find . -exec sudo id \\;",
			"watch -n 1 sudo id",
			"git -c core.fsmonitor='touch pwned' status",
			"git config core.pager 'touch pwned'",
			"echo x > .git/config",
		])("asks for %j in broad mode, as dangerous", (command) => {
			expect(bash(command, "broad")).toMatchObject({ effect: "prompt", tier: "danger" });
		});
		// fork: removing HOME also removes Prism's configuration, so it cannot be approved.
		it.each(["env FOO=1 rm -rf ~", "\\rm -rf ~", "nice -n 5 rm -rf ~"])(
			"refuses %j because it removes a configuration parent",
			(command) => {
				expect(bash(command, "broad")).toMatchObject({
					effect: "block",
					reason: expect.stringContaining("configure_prism"),
				});
			},
		);

		it("lets ordinary commands through in broad mode", () => {
			expect(bash("npm run test > out.log 2>&1", "broad").effect).toBe("allow");
			expect(bash("git commit -m 'drop sudo from the docs'", "broad").effect).toBe("allow");
		});
	});

	describe("H3: an allow rule covers only the commands it matches", () => {
		const allow = ["bash(npm run*)"];
		it.each(["npm run test", "cd sub && npm run test", "npm run build > out.log", "npm run a && npm run b"])(
			"allows %j",
			(command) => {
				expect(bash(command, "ask", { allow }).effect).toBe("allow");
			},
		);
		it.each([
			"npm run x; node evil.js",
			"npm run test && python3 -c 1",
			"npm run test $(node evil.js)",
			"npm run x & node evil.js",
		])("still asks for %j", (command) => {
			expect(bash(command, "ask", { allow }).effect).toBe("prompt");
		});
	});

	describe("M1: a deny rule catches the command wherever it sits", () => {
		const deny = ["bash(curl*)"];
		it.each([" curl x", "true && curl x", "FOO=1 curl x", "/usr/bin/curl x", "timeout 5 curl x", "echo $(curl x)"])(
			"blocks %j, even in unrestricted mode",
			(command) => {
				expect(bash(command, "unrestricted", { deny }).effect).toBe("block");
			},
		);
	});

	describe("M2: grep over a directory holding credentials", () => {
		it.each(["~/.pi/agent", "~/.pi", "~", "~/.ssh"])("asks as dangerous for grep on %j", (path) => {
			expect(decide("grep", { pattern: ".", path }, "ask")).toMatchObject({ effect: "prompt", tier: "danger" });
		});
		it("allows grep on the project", () => {
			expect(decide("grep", { pattern: ".", path: "." }, "ask").effect).toBe("allow");
		});
	});

	it("L1: follows a link below a deep path out of the project", () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(project, "link"));
		const deep = ["link", ...Array.from({ length: 45 }, (_, i) => `d${i}`), "f.txt"].join("/");
		expect(realPath(join(project, deep)).startsWith(outside)).toBe(true);
		expect(decide("write", { path: deep, content: "x" }, "broad")).toMatchObject({
			effect: "prompt",
			tier: "danger",
		});
	});

	it("L2: .git/config is a protected path", () => {
		expect(decide("write", { path: ".git/config", content: "x" }, "broad")).toMatchObject({
			effect: "prompt",
			tier: "danger",
		});
	});

	// commands that wrote a file, read a protected one or changed a ref, judged read-only.
	describe("shell forms the classifier misread", () => {
		const misread = [
			// sed: a `/` inside a bracket expression ended the regular expression early.
			"sed 's/[/]/x/;s/a/b/w out.txt' notes.txt",
			"sed '/[/]/w out.txt' notes.txt",
			// awk: a continued line, a comma at a line end, and ARGV/ARGC choosing the files read.
			'awk \'BEGIN{print "x" \\\n > "/etc/out"}\'',
			'awk \'BEGIN{print "x",\n"y" > "out.txt"}\'',
			"awk 'BEGIN{ARGV[1]=\"x\";ARGC=2}1'",
			"awk -v ARGC=0 1 notes.txt",
			"awk 1 ARGC=0 notes.txt",
			// Variables in protected names.
			`cat \${X:-.env}`,
			`cat \${X-.env}`,
			'S=.en; cat "$S"v',
			`S=.env; cat \${S:0}`,
			"S='notes.txt .env'; cat $S",
			`S=; echo \${S:=$HOME/.ssh/} >/dev/null; cat \${S}id_ed25519`,
			`echo \${S:=$HOME/.ssh/} >/dev/null; cat \${S}id_ed25519`,
			`cat \${S:=x} \${S}y`,
			`cat < \${X:-.env}`,
			// A POSIX class in a pattern.
			"cat .en[[:alpha:]]",
			// Options in variables.
			"S=-delete; find . $S",
			'S="-o out.txt"; sort $S notes.txt',
			"sort $X notes.txt",
			// git takes abbreviated long options.
			"git branch --unset-u",
			"git branch --edit-desc",
			"git branch --del topic",
			"git branch --set-u=origin/main",
		];
		beforeEach(() => {
			writeFileSync(join(project, ".env"), "SECRET=1");
		});
		it.each(misread)("does not allow %j in ask mode", (command) => {
			expect(bash(command, "ask").effect).not.toBe("allow");
		});
		it.each(misread)("does not allow %j in safe mode", (command) => {
			expect(bash(command, "safe").effect).not.toBe("allow");
		});
		it.each([
			"sed 's/[a-z]/x/' notes.txt",
			"sed -n '/[[:digit:]]/p' notes.txt",
			"awk '{print $1}' notes.txt",
			"awk -v n=2 'NR==n' notes.txt",
			"cat notes.txt",
			"S=notes.txt; cat $S",
			'S=notes; cat "$S".txt',
			`cat \${X:-notes.txt}`,
			"cat notes.[[:alpha:]]xt",
			"find . -name x",
			"S=-name; find . $S x",
			"sort notes.txt",
			"S=notes.txt; sort $S",
			"printf '%s\\n' \"$X\"",
			"git branch --list",
			"git branch --li 'feat*'",
			"git branch --cont HEAD",
		])("still allows %j", (command) => {
			expect(bash(command, "ask").effect).toBe("allow");
		});
	});
});
